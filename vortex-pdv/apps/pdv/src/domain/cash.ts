import { D, ZERO, sum, type Decimal } from '@vortex/money';
import type { PaymentMethod } from './payments.js';

/**
 * Conferência de caixa (seções 27 e 28): esperado por forma de pagamento, informado pelo
 * operador e diferença (positiva, negativa ou sem diferença). Diferenças nunca são apagadas.
 */
export type CashGroup = 'cash' | 'pix' | 'debit' | 'credit';
export const GROUP_OF: Record<PaymentMethod, CashGroup> = { cash: 'cash', pix: 'pix', debit: 'debit', credit: 'credit', pos_debit: 'debit', pos_credit: 'credit' };
export const GROUPS: CashGroup[] = ['cash', 'pix', 'debit', 'credit'];

export interface SessionFlows {
  opening: string;
  supplies: string[];
  withdrawals: string[];
  /** Pagamentos aprovados de vendas concluídas (dinheiro já líquido de troco) */
  payments: { method: PaymentMethod; amount: string }[];
  /** Devoluções/estornos pagos ao cliente por forma */
  refunds: { group: CashGroup; amount: string }[];
}

export interface ExpectedTotals {
  cash: string;
  pix: string;
  debit: string;
  credit: string;
  total: string;
  breakdown: { opening: string; supplies: string; withdrawals: string; cashSales: string; cashRefunds: string };
}

const s = (xs: string[]) => sum(xs.map((x) => D(x)));

export function expectedTotals(f: SessionFlows): ExpectedTotals {
  const by = (g: CashGroup) => sum(f.payments.filter((p) => GROUP_OF[p.method] === g).map((p) => D(p.amount)))
    .minus(sum(f.refunds.filter((r) => r.group === g).map((r) => D(r.amount))));
  const cashSales = sum(f.payments.filter((p) => p.method === 'cash').map((p) => D(p.amount)));
  const cashRefunds = sum(f.refunds.filter((r) => r.group === 'cash').map((r) => D(r.amount)));
  const cash = D(f.opening).plus(s(f.supplies)).minus(s(f.withdrawals)).plus(cashSales).minus(cashRefunds);
  const out = { cash, pix: by('pix'), debit: by('debit'), credit: by('credit') };
  return {
    cash: out.cash.toFixed(2), pix: out.pix.toFixed(2), debit: out.debit.toFixed(2), credit: out.credit.toFixed(2),
    total: out.cash.plus(out.pix).plus(out.debit).plus(out.credit).toFixed(2),
    breakdown: { opening: D(f.opening).toFixed(2), supplies: s(f.supplies).toFixed(2), withdrawals: s(f.withdrawals).toFixed(2), cashSales: cashSales.toFixed(2), cashRefunds: cashRefunds.toFixed(2) },
  };
}

export type DifferenceKind = 'positive' | 'negative' | 'none';

export interface Conference {
  group: CashGroup;
  expected: string;
  informed: string;
  difference: string;
  kind: DifferenceKind;
}

export function conference(expected: ExpectedTotals, informed: Partial<Record<CashGroup, string>>): Conference[] {
  return GROUPS.map((g) => {
    const exp = D(expected[g]);
    const inf = D(informed[g] ?? expected[g]);
    const diff = inf.minus(exp);
    return { group: g, expected: exp.toFixed(2), informed: inf.toFixed(2), difference: diff.toFixed(2), kind: diff.isZero() ? 'none' : diff.isNegative() ? 'negative' : 'positive' };
  });
}

export function totalDifference(c: Conference[]): Decimal {
  return c.reduce<Decimal>((acc, x) => acc.plus(x.difference), ZERO);
}
