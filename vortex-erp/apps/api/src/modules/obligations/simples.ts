import { D, ZERO, roundMoney, type Decimal } from '@vortex/money';
import { simplesEffectiveRate, type SimplesAnnex } from '@vortex/fiscal-engine';
import type { Tx } from '../../db/tx.js';
import { validation } from '../../errors.js';

/** CFOP que compõe a receita bruta: vendas, revendas, industrialização, serviços e exportações (sem remessas). */
export function isRevenueCfop(cfop: string): boolean {
  const c = Number(cfop.slice(1));
  return (c >= 101 && c <= 125) || (c >= 401 && c <= 405) || (c >= 651 && c <= 656) || c === 933;
}
/** Devoluções de vendas (entrada) que reduzem a receita bruta. */
const isSaleReturnCfop = (cfop: string) => ['201', '202', '410', '411', '660', '661', '662'].includes(cfop.slice(1));

const monthRange = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return { from: `${period}-01`, to: new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10) };
};
const shift = (period: string, months: number) => {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 + months, 1));
  return d.toISOString().slice(0, 7);
};

interface Line {
  cfop: string;
  direction: string;
  model: string;
  value: Decimal;
  productKind: string | null;
  ownProduction: boolean;
  csosn: string | null;
  pisCst: string | null;
  issRetained: boolean;
}

async function revenueLines(tx: Tx, establishmentId: string, from: string, to: string): Promise<Line[]> {
  const rows = await tx.query<Record<string, any>>(
    `SELECT i.cfop, d.direction, d.model, i.total - i.discount AS value, p.kind AS product_kind, coalesce(p.own_production, false) AS own_production,
            (SELECT cst FROM fiscal.document_item_taxes t WHERE t.document_item_id = i.id AND t.tax = 'ICMS' LIMIT 1) AS csosn,
            (SELECT cst FROM fiscal.document_item_taxes t WHERE t.document_item_id = i.id AND t.tax = 'PIS' LIMIT 1) AS pis_cst,
            EXISTS (SELECT 1 FROM fiscal.document_item_taxes t WHERE t.document_item_id = i.id AND t.tax = 'RET_ISS' AND t.value > 0) AS iss_retained
       FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id LEFT JOIN catalog.products p ON p.id = i.product_id
      WHERE d.establishment_id = $1 AND d.status = 'autorizada' AND d.model IN ('55','65','99') AND d.tax_date BETWEEN $2 AND $3`, [establishmentId, from, to]);
  return rows.map((r) => ({ cfop: r.cfop, direction: r.direction, model: r.model, value: D(r.value), productKind: r.product_kind, ownProduction: r.own_production, csosn: r.csosn,
    pisCst: r.pis_cst, issRetained: r.iss_retained }));
}

function grossRevenue(lines: Line[]): Decimal {
  let total = ZERO;
  for (const l of lines) {
    if (l.direction === 'S' && (l.model === '99' || isRevenueCfop(l.cfop))) total = total.plus(l.value);
    if (l.direction === 'E' && isSaleReturnCfop(l.cfop)) total = total.minus(l.value);
  }
  return total;
}

/**
 * Apoio ao PGDAS-D (seção 15): receita do mês segregada como o PGDAS-D pede (anexo, ICMS-ST,
 * PIS/Cofins monofásico, exportação, ISS retido), RBT12, Fator R e alíquota efetiva estimada.
 * O cálculo oficial do DAS continua no PGDAS-D; o relatório é a base para preenchê-lo.
 */
export async function pgdasSupport(tx: Tx, companyId: string, period: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw validation({ period: 'Período no formato AAAA-MM' });
  const { from, to } = monthRange(period);
  const r12 = { from: monthRange(shift(period, -12)).from, to: monthRange(shift(period, -1)).to };
  const ests = await tx.query<Record<string, any>>(
    `SELECT e.id, e.code, e.cnpj, e.legal_name, r.regime, r.simples_annex FROM core.establishments e
       JOIN core.establishment_tax_regimes r ON r.establishment_id = e.id AND r.valid_from <= $2 AND (r.valid_to IS NULL OR r.valid_to >= $2)
      WHERE e.company_id = $1 ORDER BY e.code`, [companyId, to]);
  if (!ests.some((e) => e.regime === 'simples_nacional' || e.regime === 'simples_excesso_sublimite')) {
    throw validation({ companyId: 'Empresa sem estabelecimento no Simples Nacional neste período' });
  }
  // RBT12 e folha de 12 meses são da empresa (todos os estabelecimentos)
  let rbt12 = ZERO;
  for (const e of ests) rbt12 = rbt12.plus(grossRevenue(await revenueLines(tx, e.id, r12.from, r12.to)));
  const payroll = await tx.one<{ total: string | null }>(
    `SELECT sum(gross + inss_employer + fgts) AS total FROM hr.payroll_imports WHERE company_id = $1 AND competence BETWEEN $2 AND $3`, [companyId, r12.from, r12.to]);
  const payroll12 = D(payroll.total ?? 0);
  const factorR = rbt12.isZero() ? null : payroll12.dividedBy(rbt12);
  const warnings: string[] = [];
  if (rbt12.greaterThan(4_800_000)) warnings.push('RBT12 acima de R$ 4,8 milhões: limite do Simples Nacional excedido (exclusão)');
  else if (rbt12.greaterThan(3_600_000)) warnings.push('RBT12 acima do sublimite de R$ 3,6 milhões: ICMS e ISS passam a ser recolhidos fora do DAS');

  const establishments = [];
  let total = ZERO;
  let estimated = ZERO;
  for (const e of ests) {
    const lines = await revenueLines(tx, e.id, from, to);
    const groups = new Map<string, { annex: SimplesAnnex; activity: string; icmsSt: boolean; monophasic: boolean; export: boolean; issRetained: boolean; revenue: Decimal }>();
    for (const l of lines) {
      const sign = l.direction === 'S' && (l.model === '99' || isRevenueCfop(l.cfop)) ? 1 : l.direction === 'E' && isSaleReturnCfop(l.cfop) ? -1 : 0;
      if (!sign) continue;
      const service = l.model === '99' || l.productKind === 'service';
      let annex: SimplesAnnex = service ? (e.simples_annex as SimplesAnnex) ?? 'III' : l.ownProduction || l.productKind === 'finished' ? 'II' : 'I';
      // Fator R ≥ 28%: serviços do Anexo V são tributados pelo Anexo III
      if (annex === 'V' && factorR && factorR.greaterThanOrEqualTo('0.28')) annex = 'III';
      const g = {
        annex, activity: service ? 'Prestação de serviços' : annex === 'II' ? 'Venda de mercadorias industrializadas pelo contribuinte' : 'Revenda de mercadorias',
        icmsSt: !service && ['201', '202', '203', '500', '60', '10', '30', '70'].includes(l.csosn ?? ''), monophasic: l.pisCst === '04',
        export: l.cfop.startsWith('7'), issRetained: l.issRetained,
      };
      const k = JSON.stringify(g);
      const cur = groups.get(k) ?? { ...g, revenue: ZERO };
      cur.revenue = cur.revenue.plus(l.value.times(sign));
      groups.set(k, cur);
    }
    const rows = [...groups.values()].map((g) => {
      const eff = simplesEffectiveRate(rbt12.toFixed(2), g.annex);
      const das = roundMoney(g.revenue.times(eff.effectiveRate).dividedBy(100));
      estimated = estimated.plus(das);
      return { ...g, revenue: g.revenue.toFixed(2), bracket: eff.bracket, effectiveRate: eff.effectiveRate.toFixed(4), estimatedDas: das.toFixed(2) };
    }).sort((a, b) => a.annex.localeCompare(b.annex) || a.activity.localeCompare(b.activity));
    const revenue = rows.reduce((a, r) => a.plus(r.revenue), ZERO);
    total = total.plus(revenue);
    establishments.push({ establishmentId: e.id, code: e.code, cnpj: e.cnpj, regime: e.regime, revenue: revenue.toFixed(2), segments: rows });
  }
  if (estimated.greaterThan(0)) warnings.push('DAS estimado sem as reduções de ICMS-ST, monofásico e ISS retido: o valor oficial é calculado no PGDAS-D');
  return {
    period, rbt12: rbt12.toFixed(2), rbt12Period: r12, payroll12: payroll12.toFixed(2), factorR: factorR ? factorR.times(100).toFixed(2) : null,
    revenue: total.toFixed(2), estimatedDas: estimated.toFixed(2), establishments, warnings,
  };
}

/**
 * Apoio à DEFIS (declaração anual do Simples): receita por mês, empregados no início e no fim do
 * ano, folha, saldos de caixa/bancos e de estoque no início e no fim, compras e despesas pagas.
 */
export async function defisSupport(tx: Tx, companyId: string, year: number) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const ests = await tx.query<{ id: string; code: string; cnpj: string }>(`SELECT id, code, cnpj FROM core.establishments WHERE company_id = $1 ORDER BY code`, [companyId]);
  const months = [];
  let annual = ZERO;
  for (let m = 1; m <= 12; m++) {
    const period = `${year}-${String(m).padStart(2, '0')}`;
    const { from, to } = monthRange(period);
    let rev = ZERO;
    for (const e of ests) rev = rev.plus(grossRevenue(await revenueLines(tx, e.id, from, to)));
    annual = annual.plus(rev);
    months.push({ period, revenue: rev.toFixed(2) });
  }
  const employees = async (date: string) => (await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM hr.employees WHERE company_id = $1 AND admission_date <= $2 AND (termination_date IS NULL OR termination_date > $2)`, [companyId, date])).n;
  const cash = async (date: string) => D((await tx.one<{ v: string | null }>(
    `SELECT sum(a.initial_balance + coalesce((SELECT sum(CASE WHEN m.direction = 'C' THEN m.amount ELSE -m.amount END) FROM finance.account_movements m
                                               WHERE m.account_id = a.id AND m.movement_date <= $2), 0)) AS v
       FROM finance.accounts a WHERE a.company_id = $1 AND a.initial_balance_date <= $2`, [companyId, date])).v ?? 0).toFixed(2);
  const stock = async (date: string) => D((await tx.one<{ v: string | null }>(
    `SELECT sum(m.sign * m.total_cost) AS v FROM inventory.stock_movements m JOIN core.establishments e ON e.id = m.establishment_id
      WHERE e.company_id = $1 AND m.occurred_at < ($2::date + 1)`, [companyId, date])).v ?? 0).toFixed(2);
  const payroll = await tx.one<{ v: string | null }>(`SELECT sum(gross) AS v FROM hr.payroll_imports WHERE company_id = $1 AND competence BETWEEN $2 AND $3`, [companyId, start, end]);
  const purchases = await tx.one<{ v: string | null }>(
    `SELECT sum(total_invoice) AS v FROM fiscal.documents WHERE company_id = $1 AND direction = 'E' AND issuer_kind = 'third_party' AND status = 'autorizada' AND tax_date BETWEEN $2 AND $3`,
    [companyId, start, end]);
  const expenses = await tx.one<{ v: string | null }>(
    `SELECT sum(s.total) AS v FROM finance.settlements s JOIN finance.titles t ON t.id = s.title_id
      WHERE t.company_id = $1 AND t.kind = 'payable' AND s.kind = 'payment' AND NOT s.reversed AND s.settlement_date BETWEEN $2 AND $3`, [companyId, start, end]);
  return {
    year, revenue: annual.toFixed(2), months,
    employees: { start: await employees(start), end: await employees(end) }, payroll: D(payroll.v ?? 0).toFixed(2),
    cashAndBanks: { start: await cash(`${year - 1}-12-31`), end: await cash(end) }, inventory: { start: await stock(`${year - 1}-12-31`), end: await stock(end) },
    purchases: D(purchases.v ?? 0).toFixed(2), expensesPaid: D(expenses.v ?? 0).toFixed(2),
  };
}
