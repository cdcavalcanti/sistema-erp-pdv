import { D, ZERO, sum } from '@vortex/money';
import type { Tx } from '../../db/tx.js';

/** Saldo de uma conta numa data: saldo inicial + movimentos (o saldo só muda por lançamento). */
export async function accountBalances(tx: Tx, companyId: string | null, date?: string) {
  return tx.query(
    `SELECT a.id, a.code, a.name, a.kind, a.initial_balance,
            a.initial_balance + coalesce((SELECT sum(CASE WHEN m.direction = 'C' THEN m.amount ELSE -m.amount END) FROM finance.account_movements m
                                           WHERE m.account_id = a.id AND m.movement_date >= a.initial_balance_date AND ($2::date IS NULL OR m.movement_date <= $2)), 0) AS balance
       FROM finance.accounts a WHERE a.active AND ($1::uuid IS NULL OR a.company_id = $1) ORDER BY a.code`,
    [companyId, date ?? null]);
}

/**
 * Fluxo de caixa realizado (movimentos de conta) e projetado (títulos a vencer +
 * pedidos aprovados + contratos recorrentes + previsões manuais), por dia/semana/mês.
 */
export async function cashFlow(tx: Tx, companyId: string | null, from: string, to: string, granularity: 'day' | 'week' | 'month', accountId?: string | null) {
  const realized = await tx.query<{ period: string; inflow: string; outflow: string }>(
    `SELECT to_char(date_trunc($4, movement_date), 'YYYY-MM-DD') AS period,
            sum(amount) FILTER (WHERE direction = 'C') AS inflow, sum(amount) FILTER (WHERE direction = 'D') AS outflow
       FROM finance.account_movements WHERE ($1::uuid IS NULL OR company_id = $1) AND movement_date BETWEEN $2 AND $3 AND ($5::uuid IS NULL OR account_id = $5)
      GROUP BY 1 ORDER BY 1`, [companyId, from, to, granularity, accountId ?? null]);
  const projected = await tx.query<{ period: string; source: string; inflow: string; outflow: string }>(
    `SELECT period, source, sum(inflow) AS inflow, sum(outflow) AS outflow FROM (
        SELECT to_char(date_trunc($4, greatest(due_date, current_date)), 'YYYY-MM-DD') AS period, 'titulos' AS source,
               CASE WHEN kind = 'receivable' THEN balance - tax_withheld_amount ELSE 0 END AS inflow, CASE WHEN kind = 'payable' THEN balance ELSE 0 END AS outflow
          FROM finance.titles WHERE ($1::uuid IS NULL OR company_id = $1) AND status IN ('open','partially_paid') AND due_date <= $3
        UNION ALL
        SELECT to_char(date_trunc($4, coalesce(o.expected_delivery, current_date + 30)), 'YYYY-MM-DD'), 'pedidos',
               sum(i.total * (i.quantity - i.quantity_invoiced - i.quantity_cancelled) / i.quantity), 0
          FROM sales.orders o JOIN sales.order_items i ON i.order_id = o.id
         WHERE ($1::uuid IS NULL OR o.company_id = $1) AND o.status IN ('approved','separating','partially_invoiced') GROUP BY o.id
        UNION ALL
        SELECT to_char(date_trunc($4, forecast_date), 'YYYY-MM-DD'), 'previsoes', CASE WHEN direction = 'C' THEN amount ELSE 0 END, CASE WHEN direction = 'D' THEN amount ELSE 0 END
          FROM finance.cash_forecasts WHERE ($1::uuid IS NULL OR company_id = $1) AND forecast_date BETWEEN $2 AND $3
      ) x WHERE period::date BETWEEN date_trunc($4, $2::date) AND $3 GROUP BY period, source ORDER BY period, source`,
    [companyId, from, to, granularity]);
  // Contratos recorrentes: cada faturamento futuro do período (itens fixos), pela data de vencimento
  const contracts = await tx.query<{ period: string; inflow: string }>(
    `SELECT to_char(date_trunc($4, (d + c.due_days * interval '1 day')), 'YYYY-MM-DD') AS period, sum(v.value) AS inflow
       FROM contracts.contracts c
       JOIN LATERAL (SELECT sum(i.quantity * i.unit_price) AS value FROM contracts.contract_items i WHERE i.contract_id = c.id AND i.active AND i.billing_type = 'fixed') v ON v.value > 0
       CROSS JOIN LATERAL generate_series(c.next_billing_date::timestamp, $3::date::timestamp,
         (CASE c.periodicity WHEN 'monthly' THEN '1 month' WHEN 'quarterly' THEN '3 months' WHEN 'semiannual' THEN '6 months' ELSE '12 months' END)::interval) d
      WHERE ($1::uuid IS NULL OR c.company_id = $1) AND c.status = 'active' AND (c.end_date IS NULL OR c.auto_renew OR d::date <= c.end_date)
        AND (d + c.due_days * interval '1 day')::date BETWEEN $2 AND $3
      GROUP BY 1`,
    [companyId, from, to, granularity]);
  const balances = await accountBalances(tx, companyId, from);
  const opening = sum(balances.filter((b) => !accountId || b.id === accountId).map((b) => b.balance));
  const periods = new Map<string, { period: string; realizedIn: string; realizedOut: string; projectedIn: string; projectedOut: string }>();
  const get = (p: string) => periods.get(p) ?? periods.set(p, { period: p, realizedIn: '0', realizedOut: '0', projectedIn: '0', projectedOut: '0' }).get(p)!;
  for (const r of realized) {
    const x = get(r.period);
    x.realizedIn = D(r.inflow ?? '0').toFixed(2);
    x.realizedOut = D(r.outflow ?? '0').toFixed(2);
  }
  for (const r of [...projected, ...contracts.map((c) => ({ ...c, source: 'contratos', outflow: '0' }))]) {
    const x = get(r.period);
    x.projectedIn = D(x.projectedIn).plus(r.inflow ?? '0').toFixed(2);
    x.projectedOut = D(x.projectedOut).plus(r.outflow ?? '0').toFixed(2);
  }
  let running = opening;
  const rows = [...periods.values()].sort((a, b) => a.period.localeCompare(b.period)).map((r) => {
    running = running.plus(r.realizedIn).minus(r.realizedOut).plus(r.projectedIn).minus(r.projectedOut);
    return { ...r, balance: running.toFixed(2) };
  });
  return { openingBalance: opening.toFixed(2), rows, accounts: balances };
}

/**
 * DRE gerencial por competência ou por caixa, por filial, centro de custo e projeto,
 * com orçado × realizado.
 */
export async function managementDre(tx: Tx, f: { companyId: string | null; from: string; to: string; basis: 'competence' | 'cash'; establishmentId?: string | null; costCenterId?: string | null; projectId?: string | null }) {
  const lines: Record<string, Decimal2> = {};
  const add = (k: string, v: { toString(): string } | null | undefined) => (lines[k] = (lines[k] ?? ZERO).plus(D(String(v ?? '0'))));
  type Decimal2 = ReturnType<typeof D>;
  if (f.basis === 'competence') {
    const docs = await tx.one<Record<string, string | null>>(
      `SELECT sum(total_invoice - total_st - total_ipi) FILTER (WHERE direction = 'S' AND purpose <> 4 AND operation_code IN (SELECT code FROM fiscal.operation_types WHERE purpose IN ('sale','future_delivery','third_party_order','service'))) AS gross,
              sum(total_invoice - total_st - total_ipi) FILTER (WHERE purpose = 4 AND direction = 'E') AS returns,
              sum((totals->>'icms')::numeric + (totals->>'fcp')::numeric + (totals->>'difal')::numeric + (totals->>'fcpDest')::numeric + total_pis + total_cofins + (totals->>'iss')::numeric)
                FILTER (WHERE direction = 'S' AND purpose <> 4) AS taxes,
              sum((totals->>'icms')::numeric + (totals->>'fcp')::numeric + total_pis + total_cofins) FILTER (WHERE purpose = 4 AND direction = 'E') AS taxes_returned
         FROM fiscal.documents WHERE status = 'autorizada' AND issuer_kind = 'own' AND ($1::uuid IS NULL OR company_id = $1) AND tax_date BETWEEN $2 AND $3
          AND ($4::uuid IS NULL OR establishment_id = $4)`,
      [f.companyId, f.from, f.to, f.establishmentId ?? null]);
    add('receita_bruta', docs.gross);
    add('devolucoes', docs.returns);
    add('impostos_sobre_vendas', D(docs.taxes ?? '0').minus(docs.taxes_returned ?? '0'));
    const cmv = await tx.one<{ out: string | null; back: string | null; adj: string | null }>(
      `SELECT sum(m.total_cost) FILTER (WHERE m.movement_type = 'sale_out') AS out, sum(m.total_cost) FILTER (WHERE m.movement_type = 'sale_return_in') AS back,
              (SELECT sum(a.difference) FROM inventory.cost_adjustments a WHERE a.movement_occurred_at::date BETWEEN $2 AND $3) AS adj
         FROM inventory.stock_movements m WHERE ($1::uuid IS NULL OR m.company_id = $1) AND m.occurred_at::date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR m.establishment_id = $4)`,
      [f.companyId, f.from, f.to, f.establishmentId ?? null]);
    add('cmv', D(cmv.out ?? '0').minus(cmv.back ?? '0').plus(cmv.adj ?? '0'));
    const losses = await tx.one<{ v: string | null }>(
      `SELECT sum(estimated_value) AS v FROM inventory.manual_movements WHERE status = 'posted' AND movement_type IN ('loss','damage','internal_use')
          AND ($1::uuid IS NULL OR company_id = $1) AND occurred_at::date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR establishment_id = $4)`,
      [f.companyId, f.from, f.to, f.establishmentId ?? null]);
    add('despesas_vendas', losses.v);
    const comm = await tx.one<{ v: string | null }>(`SELECT sum(amount) AS v FROM sales.commissions WHERE status IN ('released','paid') AND ($1::uuid IS NULL OR company_id = $1) AND created_at::date BETWEEN $2 AND $3`, [f.companyId, f.from, f.to]);
    add('despesas_vendas', comm.v);
    const card = await tx.one<{ v: string | null }>(`SELECT sum(fee_amount) AS v FROM finance.titles WHERE fee_amount IS NOT NULL AND status <> 'cancelled' AND ($1::uuid IS NULL OR company_id = $1) AND competence_date BETWEEN $2 AND $3`, [f.companyId, f.from, f.to]);
    add('despesas_vendas', card.v);
    const exp = await tx.query<{ dre_group: string; v: string }>(
      `SELECT c.dre_group, sum(t.amount) AS v FROM finance.titles t JOIN finance.categories c ON c.id = t.category_id
        WHERE t.status <> 'cancelled' AND t.origin_type IN ('manual','payroll','tax','contract','expense_reimbursement') AND c.kind IN ('expense','revenue','financial_revenue','financial_expense','tax_on_profit')
          AND ($1::uuid IS NULL OR t.company_id = $1) AND t.competence_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR t.establishment_id = $4)
          AND ($5::uuid IS NULL OR t.cost_center_id = $5) AND ($6::uuid IS NULL OR t.project_id = $6)
        GROUP BY c.dre_group`, [f.companyId, f.from, f.to, f.establishmentId ?? null, f.costCenterId ?? null, f.projectId ?? null]);
    for (const e of exp) add(e.dre_group === 'receita_bruta' ? 'outras_receitas' : e.dre_group, e.v);
  } else {
    const rows = await tx.query<{ dre_group: string; kind: string; v: string }>(
      `SELECT coalesce(c.dre_group, CASE WHEN t.kind = 'receivable' THEN 'receita_bruta' ELSE 'despesas_administrativas' END) AS dre_group, t.kind, sum(s.principal) AS v
         FROM finance.settlements s JOIN finance.titles t ON t.id = s.title_id LEFT JOIN finance.categories c ON c.id = t.category_id
        WHERE s.kind = 'payment' AND NOT s.reversed AND ($1::uuid IS NULL OR s.company_id = $1) AND s.settlement_date BETWEEN $2 AND $3 AND t.origin_type <> 'advance'
          AND ($4::uuid IS NULL OR t.establishment_id = $4) AND ($5::uuid IS NULL OR t.cost_center_id = $5)
        GROUP BY 1, 2`, [f.companyId, f.from, f.to, f.establishmentId ?? null, f.costCenterId ?? null]);
    for (const r of rows) add(r.dre_group === 'compras' ? 'cmv' : r.dre_group, r.v);
  }
  const fin = await tx.one<{ recv: string | null; paid: string | null; disc_given: string | null; disc_got: string | null }>(
    `SELECT sum(s.interest + s.fine) FILTER (WHERE t.kind = 'receivable') AS recv, sum(s.interest + s.fine) FILTER (WHERE t.kind = 'payable') AS paid,
            sum(s.discount) FILTER (WHERE t.kind = 'receivable') AS disc_given, sum(s.discount) FILTER (WHERE t.kind = 'payable') AS disc_got
       FROM finance.settlements s JOIN finance.titles t ON t.id = s.title_id
      WHERE s.kind = 'payment' AND NOT s.reversed AND ($1::uuid IS NULL OR s.company_id = $1) AND s.settlement_date BETWEEN $2 AND $3`, [f.companyId, f.from, f.to]);
  add('resultado_financeiro', D(fin.recv ?? '0').plus(fin.disc_got ?? '0').minus(fin.paid ?? '0').minus(fin.disc_given ?? '0'));
  const v = (k: string) => lines[k] ?? ZERO;
  const receitaLiquida = v('receita_bruta').plus(v('outras_receitas')).minus(v('devolucoes')).minus(v('impostos_sobre_vendas')).minus(v('deducoes'));
  const lucroBruto = receitaLiquida.minus(v('cmv'));
  const operacional = lucroBruto.minus(v('despesas_vendas')).minus(v('despesas_administrativas'));
  const resultado = operacional.plus(v('resultado_financeiro')).minus(v('tax_on_profit'));
  const budget = await tx.one<{ v: string | null }>(
    `SELECT sum(amount) AS v FROM finance.budgets WHERE ($1::uuid IS NULL OR company_id = $1) AND make_date(year, month, 1) BETWEEN date_trunc('month', $2::date) AND $3`, [f.companyId, f.from, f.to]);
  const fmt = (d: Decimal2) => d.toFixed(2);
  return {
    basis: f.basis, from: f.from, to: f.to,
    lines: [
      { key: 'receita_bruta', label: 'Receita bruta', value: fmt(v('receita_bruta').plus(v('outras_receitas'))) },
      { key: 'devolucoes', label: '(−) Devoluções', value: fmt(v('devolucoes')) },
      { key: 'impostos', label: '(−) Impostos sobre vendas', value: fmt(v('impostos_sobre_vendas').plus(v('deducoes'))) },
      { key: 'receita_liquida', label: '= Receita líquida', value: fmt(receitaLiquida) },
      { key: 'cmv', label: '(−) CMV', value: fmt(v('cmv')) },
      { key: 'lucro_bruto', label: '= Lucro bruto', value: fmt(lucroBruto), marginPercent: receitaLiquida.isZero() ? null : lucroBruto.dividedBy(receitaLiquida).times(100).toFixed(2) },
      { key: 'despesas_vendas', label: '(−) Despesas com vendas', value: fmt(v('despesas_vendas')) },
      { key: 'despesas_administrativas', label: '(−) Despesas administrativas', value: fmt(v('despesas_administrativas')) },
      { key: 'resultado_operacional', label: '= Resultado operacional', value: fmt(operacional) },
      { key: 'resultado_financeiro', label: '(+/−) Resultado financeiro', value: fmt(v('resultado_financeiro')) },
      { key: 'resultado', label: '= Resultado do período', value: fmt(resultado) },
    ],
    budgetExpenses: budget.v ?? '0',
  };
}

/** Aging de inadimplência: a vencer, 1–30, 31–60, 61–90, 90+. */
export async function aging(tx: Tx, companyId: string | null, kind: 'receivable' | 'payable') {
  return tx.one(
    `SELECT sum(balance) FILTER (WHERE due_date >= current_date) AS a_vencer,
            sum(balance) FILTER (WHERE current_date - due_date BETWEEN 1 AND 30) AS d1_30,
            sum(balance) FILTER (WHERE current_date - due_date BETWEEN 31 AND 60) AS d31_60,
            sum(balance) FILTER (WHERE current_date - due_date BETWEEN 61 AND 90) AS d61_90,
            sum(balance) FILTER (WHERE current_date - due_date > 90) AS d90_mais,
            sum(balance) AS total
       FROM finance.titles WHERE kind = $2 AND status IN ('open','partially_paid') AND ($1::uuid IS NULL OR company_id = $1)`, [companyId, kind]);
}
