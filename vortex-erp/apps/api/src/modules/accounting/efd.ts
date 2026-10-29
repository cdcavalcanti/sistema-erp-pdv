import { D, sum } from '@vortex/money';
import type { Tx } from '../../db/tx.js';

/**
 * EFD ICMS/IPI (seção 15) — MVP: blocos 0, C (documentos) e H (inventário), com
 * abertura/encerramento dos demais blocos e apuração básica do ICMS (E100/E110).
 * O arquivo deve ser validado no PVA oficial durante a homologação.
 */
export const f = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/\|/g, ' ').trim());
export const num = (v: unknown, dec = 2) => (v === null || v === undefined || v === '' ? '' : D(String(v)).toFixed(dec).replace('.', ','));
export const dt = (d: string | Date) => {
  const s = (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  return `${s.slice(8, 10)}${s.slice(5, 7)}${s.slice(0, 4)}`;
};

export const ITEM_TYPE: Record<string, string> = { goods: '00', raw_material: '01', packaging: '02', finished: '04', consumable: '07', fixed_asset: '08', service: '09', kit: '00' };

export interface EfdOptions {
  companyId: string;
  establishmentId: string;
  from: string;
  to: string;
  /** Data do inventário (bloco H) — normalmente 31/12, entregue em fevereiro */
  inventoryDate?: string | null;
  layoutVersion?: string;
}

export async function generateEfdIcmsIpi(tx: Tx, o: EfdOptions): Promise<{ content: string; warnings: string[]; counts: Record<string, number> }> {
  const warnings: string[] = [];
  const lines: string[] = [];
  const add = (...fields: unknown[]) => lines.push(`|${fields.map(f).join('|')}|`);
  const est = await tx.one<Record<string, any>>(`SELECT e.*, c.settings FROM core.establishments e JOIN core.companies c ON c.id = e.company_id WHERE e.id = $1`, [o.establishmentId]);
  const docs = await tx.query<Record<string, any>>(
    `SELECT d.*, p.code AS party_code FROM fiscal.documents d LEFT JOIN registry.parties p ON p.id = d.party_id
      WHERE d.establishment_id = $1 AND d.model IN ('55','65') AND d.tax_date BETWEEN $2 AND $3
        AND (d.status IN ('autorizada','cancelada','denegada','inutilizada')) ORDER BY d.direction, d.model, d.series, d.number`,
    [o.establishmentId, o.from, o.to]);
  const items = docs.length ? await tx.query<Record<string, any>>(`SELECT i.*, p.kind AS product_kind FROM fiscal.document_items i LEFT JOIN catalog.products p ON p.id = i.product_id WHERE i.document_id = ANY($1) ORDER BY i.item_number`, [docs.map((d) => d.id)]) : [];
  const taxes = items.length ? await tx.query<Record<string, any>>(`SELECT * FROM fiscal.document_item_taxes WHERE document_item_id = ANY($1)`, [items.map((i) => i.id)]) : [];
  const tax = (itemId: string, t: string) => taxes.find((x) => x.document_item_id === itemId && x.tax === t);

  // ---------------------------------------------------------------- bloco 0
  add('0000', o.layoutVersion ?? '020', '0', dt(o.from), dt(o.to), est.legal_name, est.cnpj, '', est.uf, est.ie, est.city_ibge, est.im, '', 'A', '1');
  add('0001', '0');
  add('0005', est.trade_name ?? est.legal_name, est.zip, est.street, est.number, est.complement, est.district, est.phone?.replace(/\D/g, ''), '', est.email);
  const acc = est.settings?.accountant;
  if (acc?.name && acc?.cpf && acc?.crc) add('0100', acc.name, acc.cpf, acc.crc, acc.cnpj ?? '', acc.zip ?? '', acc.street ?? '', acc.number ?? '', '', acc.district ?? '', acc.phone ?? '', '', acc.email ?? '', acc.cityIbge ?? '');
  else warnings.push('Registro 0100 (contabilista) não gerado: cadastre os dados do contador nas configurações da empresa');
  const partyIds = [...new Set(docs.filter((d) => d.party_id && d.status === 'autorizada').map((d) => d.party_id))];
  const parties = partyIds.length ? await tx.query<Record<string, any>>(
    `SELECT p.*, a.city_ibge, a.street, a.number, a.complement, a.district, a.country_code FROM registry.parties p
       LEFT JOIN LATERAL (SELECT * FROM registry.party_addresses x WHERE x.party_id = p.id ORDER BY (x.kind = 'fiscal') DESC LIMIT 1) a ON true WHERE p.id = ANY($1)`, [partyIds]) : [];
  for (const p of parties) {
    add('0150', p.code, p.legal_name, p.country_code ?? '1058', p.kind === 'PJ' ? p.tax_id : '', p.kind === 'PF' ? p.tax_id : '', p.ie && p.ie !== 'ISENTO' ? p.ie : '', p.city_ibge, p.suframa, p.street, p.number, p.complement, p.district);
  }
  const usedItems = [...new Map(items.filter((i) => i.product_id).map((i) => [i.product_id, i])).values()];
  const invItems = o.inventoryDate ? await tx.query<Record<string, any>>(
    `SELECT b.product_id, p.sku, p.description, p.stock_unit, p.kind, p.ncm, p.cest, p.gtin, sum(b.quantity) AS qty, max(pc.avg_cost) AS cost
       FROM inventory.stock_balances b JOIN catalog.products p ON p.id = b.product_id LEFT JOIN inventory.product_costs pc ON pc.product_id = b.product_id AND pc.establishment_id = b.establishment_id
      WHERE b.establishment_id = $1 GROUP BY b.product_id, p.id HAVING sum(b.quantity) > 0`, [o.establishmentId]) : [];
  const units = new Set<string>([...usedItems.map((i) => i.unit), ...invItems.map((i) => i.stock_unit)]);
  for (const u of units) add('0190', u, (await tx.maybeOne<{ description: string }>(`SELECT description FROM fiscal.units WHERE code = $1`, [u]))?.description ?? u);
  const itemRows = new Map<string, unknown[]>();
  for (const i of usedItems) itemRows.set(i.product_id, ['0200', i.sku, i.description, i.gtin, '', i.unit, ITEM_TYPE[i.product_kind] ?? '00', i.ncm, '', i.ncm?.slice(0, 2), i.service_code, '', i.cest]);
  for (const i of invItems) if (!itemRows.has(i.product_id)) itemRows.set(i.product_id, ['0200', i.sku, i.description, i.gtin, '', i.stock_unit, ITEM_TYPE[i.kind] ?? '00', i.ncm, '', i.ncm?.slice(0, 2), '', '', i.cest]);
  for (const r of itemRows.values()) add(...r);
  add('0990', lines.length + 1);

  // ---------------------------------------------------------------- bloco B (ISS DF) — sem movimento
  const bStart = lines.length;
  add('B001', '1');
  add('B990', lines.length - bStart + 1);

  // ---------------------------------------------------------------- bloco C
  const cStart = lines.length;
  add('C001', docs.length ? '0' : '1');
  const apur = { debits: D(0), credits: D(0) };
  for (const d of docs) {
    const indOper = d.direction === 'S' ? '1' : '0';
    const indEmit = d.issuer_kind === 'own' ? '0' : '1';
    const codSit = { autorizada: d.emission_type !== 1 ? '08' : '00', cancelada: '02', denegada: '04', inutilizada: '05' }[d.status as 'autorizada'] ?? '00';
    if (d.status !== 'autorizada') {
      add('C100', indOper, indEmit, '', d.model, codSit, d.series, d.number, d.access_key);
      continue;
    }
    const t = d.totals ?? {};
    const indPgto = (d.installments ?? []).length ? '1' : '0';
    add('C100', indOper, indEmit, d.party_code, d.model, codSit, d.series, d.number, d.access_key, dt(d.issued_at ?? d.tax_date), dt(d.exit_at ?? d.tax_date), num(d.total_invoice), indPgto,
      num(t.discount), num(0), num(t.product), d.freight_mode, num(t.freight), num(t.insurance), num(t.otherExpenses), num(t.icmsBase), num(t.icms), num(t.stBase), num(t.st), num(t.ipi),
      num(t.pis), num(t.cofins), num(0), num(0));
    const dItems = items.filter((i) => i.document_id === d.id);
    // C170 só para documentos de entrada e de emissão de terceiros
    if (indOper === '0' || indEmit === '1') {
      for (const i of dItems) {
        const ic = tax(i.id, 'ICMS');
        const st = tax(i.id, 'ICMS_ST');
        const ipi = tax(i.id, 'IPI');
        const pis = tax(i.id, 'PIS');
        const cof = tax(i.id, 'COFINS');
        add('C170', i.item_number, i.sku, i.description, num(i.quantity, 5), i.unit, num(i.total), num(i.discount), '0', `${i.origin}${ic?.cst ?? '90'}`, i.cfop, '', num(ic?.base), num(ic?.rate),
          num(ic?.value), num(st?.base), num(st?.rate), num(st?.value), '0', ipi?.cst ?? '', ipi?.details?.enqCode ?? '', num(ipi?.base), num(ipi?.rate), num(ipi?.value),
          pis?.cst ?? '99', num(pis?.base), num(pis?.rate, 4), '', '', num(pis?.value), cof?.cst ?? '99', num(cof?.base), num(cof?.rate, 4), '', '', num(cof?.value), '', num(0));
      }
    }
    // C190: analítico por CST, CFOP e alíquota
    const groups = new Map<string, { cst: string; cfop: string; rate: string; opr: ReturnType<typeof D>; bc: ReturnType<typeof D>; icms: ReturnType<typeof D>; bcst: ReturnType<typeof D>; st: ReturnType<typeof D>; ipi: ReturnType<typeof D> }>();
    for (const i of dItems) {
      const ic = tax(i.id, 'ICMS');
      const cst = `${i.origin}${ic?.cst ?? '90'}`;
      const rate = D(ic?.rate ?? '0').toFixed(2);
      const k = `${cst}|${i.cfop}|${rate}`;
      const g = groups.get(k) ?? { cst, cfop: i.cfop, rate, opr: D(0), bc: D(0), icms: D(0), bcst: D(0), st: D(0), ipi: D(0) };
      g.opr = g.opr.plus(i.item_total);
      g.bc = g.bc.plus(ic?.base ?? '0');
      g.icms = g.icms.plus(ic?.value ?? '0');
      g.bcst = g.bcst.plus(tax(i.id, 'ICMS_ST')?.base ?? '0');
      g.st = g.st.plus(tax(i.id, 'ICMS_ST')?.value ?? '0');
      g.ipi = g.ipi.plus(tax(i.id, 'IPI')?.value ?? '0');
      groups.set(k, g);
    }
    for (const g of groups.values()) {
      add('C190', g.cst, g.cfop, num(g.rate), num(g.opr), num(g.bc), num(g.icms), num(g.bcst), num(g.st), num(0), num(g.ipi), '');
      if (indOper === '1') apur.debits = apur.debits.plus(g.icms);
      else if (g.cst.length === 3) apur.credits = apur.credits.plus(g.icms);
    }
  }
  add('C990', lines.length - cStart + 1);

  // ---------------------------------------------------------------- blocos D (sem movimento) e E (apuração básica)
  const dStart = lines.length;
  add('D001', '1');
  add('D990', lines.length - dStart + 1);
  const eStart = lines.length;
  add('E001', '0');
  add('E100', dt(o.from), dt(o.to));
  const saldo = apur.debits.minus(apur.credits);
  const recolher = saldo.isPositive() ? saldo : D(0);
  const credor = saldo.isNegative() ? saldo.negated() : D(0);
  add('E110', num(apur.debits), num(0), num(0), num(0), num(apur.credits), num(0), num(0), num(0), num(0), num(saldo.isPositive() ? saldo : 0), num(0), num(recolher), num(credor), num(0));
  if (recolher.greaterThan(0)) warnings.push('E116 (obrigações a recolher) não gerado: informe o código de receita da UF no fechamento');
  add('E990', lines.length - eStart + 1);
  const gStart = lines.length;
  add('G001', '1');
  add('G990', lines.length - gStart + 1);

  // ---------------------------------------------------------------- bloco H (inventário)
  const hStart = lines.length;
  if (o.inventoryDate && invItems.length) {
    add('H001', '0');
    const total = sum(invItems.map((i) => D(i.qty).times(i.cost ?? '0').toDecimalPlaces(2)));
    add('H005', dt(o.inventoryDate), num(total), '01');
    for (const i of invItems) add('H010', i.sku, i.stock_unit, num(i.qty, 3), num(i.cost ?? '0', 6), num(D(i.qty).times(i.cost ?? '0')), '0', '', '', '', num(D(i.qty).times(i.cost ?? '0')));
  } else {
    add('H001', '1');
  }
  add('H990', lines.length - hStart + 1);

  // ---------------------------------------------------------------- blocos K e 1
  const kStart = lines.length;
  add('K001', '1');
  add('K990', lines.length - kStart + 1);
  const oneStart = lines.length;
  add('1001', '0');
  add('1010', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N', 'N');
  add('1990', lines.length - oneStart + 1);

  // ---------------------------------------------------------------- bloco 9
  const counts = closeSped(lines, add);
  return { content: `${lines.join('\r\n')}\r\n`, warnings, counts };
}

/** Bloco 9 (comum aos arquivos SPED): totalizadores por registro e encerramento. Devolve a contagem por registro. */
export function closeSped(lines: string[], add: (...fields: unknown[]) => void): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const l of lines) {
    const reg = l.split('|')[1]!;
    counts[reg] = (counts[reg] ?? 0) + 1;
  }
  const nineStart = lines.length;
  add('9001', '0');
  const regs = [...Object.keys(counts), '9001', '9900', '9990', '9999'];
  const nineCount = regs.length;
  for (const r of regs) add('9900', r, r === '9900' ? nineCount : r === '9001' || r === '9990' || r === '9999' ? 1 : counts[r]);
  add('9990', lines.length - nineStart + 2);
  add('9999', lines.length + 1);
  for (const r of ['9001', '9900', '9990', '9999']) counts[r] = r === '9900' ? nineCount : 1;
  return counts;
}
