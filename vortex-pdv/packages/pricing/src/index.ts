/**
 * Regras de preço puras compartilhadas entre o ERP e o PDV (promoções e margem).
 * Sem I/O: quem chama resolve as promoções vigentes e o preço base.
 */
import { D, ONE, HUNDRED, ZERO, roundUnit, type Decimal } from '@vortex/money';
import { z } from 'zod';

/** Regras de promoção validadas por esquema (seção 22: regra em JSON validado). */
export const promotionRuleSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('percent_off'), percent: z.string().regex(/^\d+(\.\d+)?$/) }),
    z.object({ type: z.literal('fixed_price'), price: z.string().regex(/^\d+(\.\d+)?$/) }),
    z.object({ type: z.literal('buy_x_pay_y'), buy: z.number().int().min(2), pay: z.number().int().min(1) }),
    z.object({ type: z.literal('progressive'), tiers: z.array(z.object({ minQty: z.string().regex(/^\d+(\.\d+)?$/), percent: z.string().regex(/^\d+(\.\d+)?$/) })).min(1) }),
  ])
  .refine((r) => r.type !== 'buy_x_pay_y' || r.pay < r.buy, 'Leve X pague Y exige Y menor que X');
export type PromotionRule = z.infer<typeof promotionRuleSchema>;

export interface PromotionCandidate {
  id: string;
  name: string;
  rule: PromotionRule;
  cumulative: boolean;
  remaining: Decimal | null;
}

/** Preço unitário efetivo de uma regra para a quantidade dada (sem arredondar a 2 casas). */
export function applyRule(base: Decimal, qty: Decimal, rule: PromotionRule): Decimal {
  switch (rule.type) {
    case 'percent_off':
      return base.times(ONE.minus(D(rule.percent).dividedBy(HUNDRED)));
    case 'fixed_price':
      return Decimal_min(base, D(rule.price));
    case 'buy_x_pay_y': {
      if (qty.lessThan(rule.buy)) return base;
      const groups = qty.dividedToIntegerBy(rule.buy);
      const rest = qty.minus(groups.times(rule.buy));
      const total = groups.times(rule.pay).plus(rest).times(base);
      return total.dividedBy(qty);
    }
    case 'progressive': {
      const tier = [...rule.tiers].filter((t) => qty.greaterThanOrEqualTo(D(t.minQty))).sort((a, b) => D(b.minQty).comparedTo(D(a.minQty)))[0];
      return tier ? base.times(ONE.minus(D(tier.percent).dividedBy(HUNDRED))) : base;
    }
    default:
      return base;
  }
}

function Decimal_min(a: Decimal, b: Decimal): Decimal {
  return a.lessThan(b) ? a : b;
}

export interface PromotionResult {
  unitPrice: Decimal;
  applied: { id: string; name: string }[];
}

/**
 * RN-PRE-02: promoções não se acumulam, salvo configuração explícita; vale a mais
 * vantajosa para o cliente. Promoções marcadas como cumulativas são aplicadas em
 * sequência e o resultado concorre com a melhor promoção isolada.
 */
export function bestPromotion(base: Decimal, qty: Decimal, promos: PromotionCandidate[]): PromotionResult {
  const eligible = promos.filter((p) => p.remaining === null || p.remaining.greaterThanOrEqualTo(qty));
  let best: PromotionResult = { unitPrice: base, applied: [] };
  for (const p of eligible) {
    const price = applyRule(base, qty, p.rule);
    if (price.lessThan(best.unitPrice)) best = { unitPrice: price, applied: [{ id: p.id, name: p.name }] };
  }
  const cumulative = eligible.filter((p) => p.cumulative);
  if (cumulative.length > 1) {
    let stacked = base;
    for (const p of cumulative) stacked = applyRule(stacked, qty, p.rule);
    if (stacked.lessThan(best.unitPrice)) best = { unitPrice: stacked, applied: cumulative.map((p) => ({ id: p.id, name: p.name })) };
  }
  return { unitPrice: roundUnit(best.unitPrice.isNegative() ? ZERO : best.unitPrice), applied: best.applied };
}

/** Margem sobre o preço: (preço − custo) ÷ preço × 100. */
export function marginPercent(price: Decimal, cost: Decimal): Decimal {
  if (price.isZero()) return cost.isZero() ? ZERO : D(-100);
  return price.minus(cost).dividedBy(price).times(HUNDRED);
}
