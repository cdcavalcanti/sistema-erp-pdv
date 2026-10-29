import { describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import { applyRule, bestPromotion, marginPercent, promotionRuleSchema } from '../src/index.js';

describe('Regras de preço compartilhadas (ERP e PDV)', () => {
  it('leve 3 pague 2 e progressiva', () => {
    expect(applyRule(D('10'), D('3'), { type: 'buy_x_pay_y', buy: 3, pay: 2 }).toFixed(4)).toBe('6.6667');
    expect(applyRule(D('10'), D('4'), { type: 'buy_x_pay_y', buy: 3, pay: 2 }).toFixed(2)).toBe('7.50');
    expect(applyRule(D('10'), D('6'), { type: 'progressive', tiers: [{ minQty: '5', percent: '5' }, { minQty: '10', percent: '10' }] }).toFixed(2)).toBe('9.50');
  });

  it('RN-PRE-02 vale a promoção mais vantajosa; cumulativas concorrem somadas; limite de quantidade', () => {
    const promos = [
      { id: 'a', name: '10%', rule: { type: 'percent_off' as const, percent: '10' }, cumulative: true, remaining: null },
      { id: 'b', name: '15%', rule: { type: 'percent_off' as const, percent: '15' }, cumulative: false, remaining: null },
      { id: 'c', name: '8%', rule: { type: 'percent_off' as const, percent: '8' }, cumulative: true, remaining: D('1') },
    ];
    expect(bestPromotion(D('100'), D('1'), promos)).toMatchObject({ applied: [{ id: 'a' }, { id: 'c' }] });
    expect(bestPromotion(D('100'), D('2'), promos).applied).toEqual([{ id: 'b', name: '15%' }]);
  });

  it('esquema da regra e margem', () => {
    expect(promotionRuleSchema.safeParse({ type: 'buy_x_pay_y', buy: 2, pay: 2 }).success).toBe(false);
    expect(marginPercent(D('10'), D('6')).toFixed(0)).toBe('40');
  });
});
