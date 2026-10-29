import { D, ZERO, sum } from '@vortex/money';
import type { Tx } from '../../db/tx.js';

/** Balancete de verificação: saldo anterior, débitos, créditos e saldo final por conta (com totais sintéticos). */
export async function trialBalance(tx: Tx, companyId: string, from: string, to: string) {
  const rows = await tx.query<{ id: string; code: string; name: string; nature: string; balance_side: 'D' | 'C'; is_analytic: boolean; opening: string; debit: string; credit: string }>(
    `SELECT a.id, a.code, a.name, a.nature, a.balance_side, a.is_analytic,
            coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < $2), 0) AS opening,
            coalesce(sum(l.debit) FILTER (WHERE e.entry_date BETWEEN $2 AND $3), 0) AS debit,
            coalesce(sum(l.credit) FILTER (WHERE e.entry_date BETWEEN $2 AND $3), 0) AS credit
       FROM accounting.chart_of_accounts a
       LEFT JOIN accounting.journal_lines l ON l.account_id = a.id
       LEFT JOIN accounting.journal_entries e ON e.id = l.entry_id AND e.company_id = $1 AND e.entry_date <= $3
      GROUP BY a.id ORDER BY a.code`, [companyId, from, to]);
  // Soma as analíticas nas sintéticas (pelo prefixo do código)
  const out = rows.map((r) => {
    const children = r.is_analytic ? [r] : rows.filter((c) => c.is_analytic && (c.code === r.code || c.code.startsWith(`${r.code}.`)));
    const opening = sum(children.map((c) => c.opening));
    const debit = sum(children.map((c) => c.debit));
    const credit = sum(children.map((c) => c.credit));
    const closing = opening.plus(debit).minus(credit);
    return { code: r.code, name: r.name, nature: r.nature, analytic: r.is_analytic, opening: opening.toFixed(2), debit: debit.toFixed(2), credit: credit.toFixed(2),
      closing: closing.toFixed(2), closingSide: closing.isZero() ? '' : closing.isPositive() ? 'D' : 'C' };
  }).filter((r) => !D(r.opening).isZero() || !D(r.debit).isZero() || !D(r.credit).isZero());
  const analytic = out.filter((r) => r.analytic);
  return {
    rows: out,
    totals: { debit: sum(analytic.map((r) => r.debit)).toFixed(2), credit: sum(analytic.map((r) => r.credit)).toFixed(2), closing: sum(analytic.map((r) => r.closing)).toFixed(2) },
  };
}

/** Razão de uma conta com saldo acumulado. */
export async function ledger(tx: Tx, companyId: string, accountId: string, from: string, to: string) {
  const opening = await tx.one<{ v: string | null }>(
    `SELECT sum(l.debit - l.credit) AS v FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id = l.entry_id WHERE e.company_id = $1 AND l.account_id = $2 AND e.entry_date < $3`,
    [companyId, accountId, from]);
  const rows = await tx.query<{ entry_date: string; number: string; history: string; debit: string; credit: string; event_type: string; origin_type: string | null; origin_id: string | null }>(
    `SELECT e.entry_date, e.number, l.history, l.debit, l.credit, e.event_type, e.origin_type, e.origin_id FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id = l.entry_id
      WHERE e.company_id = $1 AND l.account_id = $2 AND e.entry_date BETWEEN $3 AND $4 ORDER BY e.entry_date, e.number`, [companyId, accountId, from, to]);
  let bal = D(opening.v ?? '0');
  return { opening: bal.toFixed(2), rows: rows.map((r) => ({ ...r, balance: (bal = bal.plus(r.debit).minus(r.credit)).toFixed(2) })), closing: bal.toFixed(2) };
}

/** Balanço patrimonial e DRE contábil a partir do balancete. */
export async function statements(tx: Tx, companyId: string, from: string, to: string) {
  const tb = await trialBalance(tx, companyId, '1900-01-01', to);
  const period = await trialBalance(tx, companyId, from, to);
  const top = (code: string, src = tb) => src.rows.find((r) => r.code === code);
  const mov = (code: string) => {
    const r = top(code, period);
    return r ? D(r.credit).minus(r.debit) : ZERO;
  };
  const revenue = mov('3');
  const expenses = mov('4').negated();
  const result = revenue.minus(expenses);
  const asset = D(top('1')?.closing ?? '0');
  const liability = D(top('2')?.closing ?? '0').negated();
  const accumulatedResult = D(top('3')?.closing ?? '0').plus(top('4')?.closing ?? '0').negated();
  return {
    balanceSheet: {
      asset: asset.toFixed(2),
      liabilityAndEquity: liability.toFixed(2),
      resultNotYetClosed: accumulatedResult.toFixed(2),
      // Ativo = Passivo + PL + resultado ainda não transferido
      balanced: asset.equals(liability.plus(accumulatedResult)),
      groups: tb.rows.filter((r) => r.code.split('.').length <= 2 && ['1', '2'].includes(r.code[0]!)),
    },
    incomeStatement: {
      grossRevenue: mov('3.1').plus(mov('3.2')).toFixed(2),
      deductions: mov('3.3').negated().toFixed(2),
      financialRevenue: mov('3.4').toFixed(2),
      cogs: mov('4.1').negated().toFixed(2),
      salesExpenses: mov('4.2').negated().toFixed(2),
      adminExpenses: mov('4.3').negated().toFixed(2),
      financialExpenses: mov('4.4').negated().toFixed(2),
      result: result.toFixed(2),
    },
  };
}

/**
 * Conciliação de contas: o saldo contábil de clientes, fornecedores, estoque e impostos
 * a recolher precisa bater com o módulo de origem.
 */
export async function accountReconciliation(tx: Tx, companyId: string, date: string) {
  const tb = await trialBalance(tx, companyId, '1900-01-01', date);
  const acc = (code: string) => D(tb.rows.find((r) => r.code === code)?.closing ?? '0');
  const titles = await tx.one<{ rec: string | null; pay: string | null; card: string | null }>(
    `SELECT sum(balance) FILTER (WHERE kind = 'receivable' AND gross_amount IS NULL AND origin_type <> 'advance') AS rec,
            sum(balance) FILTER (WHERE kind = 'payable' AND origin_type IN ('purchase_invoice','purchase_freight','manual','tax','payroll') AND ledger_account_id IS NULL)
              - coalesce(sum(balance) FILTER (WHERE kind = 'receivable' AND origin_type = 'purchase_return'), 0) AS pay,
            sum(balance) FILTER (WHERE kind = 'receivable' AND gross_amount IS NOT NULL) AS card
       FROM finance.titles WHERE company_id = $1 AND status IN ('open','partially_paid') AND issue_date <= $2`, [companyId, date]);
  const stock = await tx.one<{ v: string | null }>(
    `SELECT sum(sign * total_cost) + coalesce((SELECT sum(difference) FROM inventory.cost_adjustments a JOIN inventory.stock_movements m ON m.id = a.movement_id WHERE m.company_id = $1), 0) * -1 AS v
       FROM inventory.stock_movements WHERE company_id = $1 AND occurred_at::date <= $2`, [companyId, date]);
  const line = (name: string, ledgerValue: ReturnType<typeof D>, moduleValue: ReturnType<typeof D>) => ({
    account: name, ledger: ledgerValue.toFixed(2), module: moduleValue.toFixed(2), difference: ledgerValue.minus(moduleValue).toFixed(2), ok: ledgerValue.equals(moduleValue),
  });
  return [
    line('Clientes (1.1.2.01) × títulos a receber', acc('1.1.2.01'), D(titles.rec ?? '0')),
    line('Cartões a receber (1.1.2.02) × títulos de adquirente', acc('1.1.2.02'), D(titles.card ?? '0')),
    line('Fornecedores (2.1.1) × títulos a pagar', acc('2.1.1').negated(), D(titles.pay ?? '0')),
    line('Estoque (1.1.3.01) × kardex valorizado', acc('1.1.3.01'), D(stock.v ?? '0')),
  ];
}
