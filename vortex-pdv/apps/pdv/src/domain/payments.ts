import { D, ZERO, min, roundMoney, sum, type Decimal } from '@vortex/money';
import { invalid } from './errors.js';

/**
 * Regras de pagamento (seções 15 a 19). Só pagamento aprovado abate o total; dinheiro aceita
 * valor recebido maior (troco); as demais formas não podem passar do que falta pagar.
 */
export type PaymentMethod = 'cash' | 'pix' | 'debit' | 'credit' | 'pos_debit' | 'pos_credit';
export type PaymentStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'timeout' | 'refunded';

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Dinheiro', pix: 'Pix', debit: 'Débito (TEF)', credit: 'Crédito (TEF)', pos_debit: 'Débito (maquininha)', pos_credit: 'Crédito (maquininha)',
};

export interface PaymentLike {
  amount: string;
  status: PaymentStatus;
}

export function paidAmount(payments: PaymentLike[]): Decimal {
  return sum(payments.filter((p) => p.status === 'approved').map((p) => D(p.amount)));
}

export function remainingAmount(total: string, payments: PaymentLike[]): Decimal {
  const r = D(total).minus(paidAmount(payments));
  return r.isNegative() ? ZERO : r;
}

export interface PaymentPlan {
  amount: string;
  tendered: string | null;
  change: string;
}

/** Valida e calcula o pagamento: valor aplicado, valor recebido e troco. */
export function planPayment(total: string, payments: PaymentLike[], method: PaymentMethod, value: string, opts: { installments?: number; maxInstallments?: number; minInstallmentValue?: string } = {}): PaymentPlan {
  const remaining = remainingAmount(total, payments);
  if (remaining.isZero()) throw invalid('A venda já está paga');
  const v = roundMoney(D(value));
  if (v.lessThanOrEqualTo(0)) throw invalid('Informe um valor maior que zero');
  if (method === 'cash') {
    const applied = min(v, remaining);
    return { amount: applied.toFixed(2), tendered: v.toFixed(2), change: v.minus(applied).toFixed(2) };
  }
  if (v.greaterThan(remaining)) throw invalid(`Valor maior que o restante (R$ ${remaining.toFixed(2)}); troco só em dinheiro`);
  const n = opts.installments ?? 1;
  if (n > 1) {
    if (method !== 'credit' && method !== 'pos_credit') throw invalid('Parcelamento só no crédito');
    if (n > (opts.maxInstallments ?? 12)) throw invalid(`Máximo de ${opts.maxInstallments ?? 12} parcelas`);
    if (opts.minInstallmentValue && v.dividedBy(n).lessThan(opts.minInstallmentValue)) throw invalid(`Parcela mínima de R$ ${D(opts.minInstallmentValue).toFixed(2)}`);
  }
  return { amount: v.toFixed(2), tendered: null, change: '0.00' };
}

/** A venda só fecha quando o total aprovado é exatamente o total da venda (seção 19). */
export function isFullyPaid(total: string, payments: PaymentLike[]): boolean {
  return paidAmount(payments).equals(D(total));
}
