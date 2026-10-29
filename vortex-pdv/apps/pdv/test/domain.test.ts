import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D, sum } from '@vortex/money';
import { computeTotals, effectivePercent, type CartLine } from '../src/domain/cart.js';
import { isFullyPaid, planPayment, remainingAmount } from '../src/domain/payments.js';
import { conference, expectedTotals, totalDifference } from '../src/domain/cash.js';
import { parseScan, splitQuantity } from '../src/domain/barcode.js';
import { saleNumber, storeDay } from '../src/domain/ids.js';
import { stockDecision, stockStatus } from '../src/domain/stock.js';
import { maskTaxId, normalize } from '../src/domain/text.js';

const line = (id: string, quantity: string, unitPrice: string, extra: Partial<CartLine> = {}): CartLine => ({ id, quantity, unitPrice, manualDiscount: null, status: 'active', ...extra });

describe('Carrinho (seções 8, 11 e 13)', () => {
  it('produto único, vários produtos, quantidade decimal (pesável)', () => {
    expect(computeTotals([line('a', '1', '9.90')], null).total).toBe('9.90');
    const t = computeTotals([line('a', '3', '9.90'), line('b', '0.355', '42.90')], null);
    expect(t.lines.map((l) => l.gross)).toEqual(['29.70', '15.23']);
    expect(t).toMatchObject({ subtotal: '44.93', total: '44.93', itemCount: 2 });
  });

  it('desconto por item e na venda, percentual e valor; item cancelado sai do total', () => {
    const t = computeTotals([
      line('a', '2', '50.00', { manualDiscount: { kind: 'percent', value: '10' } }),
      line('b', '1', '30.00', { manualDiscount: { kind: 'value', value: '5' } }),
      line('c', '1', '99.00', { status: 'cancelled' }),
    ], { kind: 'value', value: '10.00' });
    expect(t).toMatchObject({ subtotal: '130.00', itemDiscounts: '15.00', saleDiscount: '10.00', discountTotal: '25.00', total: '105.00', itemCount: 2 });
    // Rateio proporcional aos líquidos (90 e 25)
    expect(t.lines.map((l) => l.saleDiscountShare)).toEqual(['7.83', '2.17']);
    expect(() => computeTotals([line('a', '1', '10')], { kind: 'value', value: '11' })).toThrow(/maior que o valor/);
    expect(effectivePercent(D('15'), D('100')).toFixed(0)).toBe('15');
  });

  it('propriedade: o rateio do desconto da venda sempre fecha e nenhum item fica negativo', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ q: fc.integer({ min: 1, max: 5000 }), p: fc.integer({ min: 1, max: 100_000 }) }), { minLength: 1, maxLength: 20 }),
      fc.integer({ min: 0, max: 100 }),
      (items, pct) => {
        const t = computeTotals(items.map((x, i) => line(String(i), (x.q / 1000).toFixed(3), (x.p / 100).toFixed(2))), { kind: 'percent', value: String(pct) });
        return sum(t.lines.map((l) => D(l.saleDiscountShare))).equals(D(t.saleDiscount))
          && sum(t.lines.map((l) => D(l.total))).equals(D(t.total)) && t.lines.every((l) => !D(l.total).isNegative());
      }), { numRuns: 300 });
  });
});

describe('Pagamentos (seções 15 a 19)', () => {
  it('dinheiro calcula troco; demais formas não passam do restante; múltiplos fecham o total', () => {
    expect(planPayment('47.30', [], 'cash', '50')).toEqual({ amount: '47.30', tendered: '50.00', change: '2.70' });
    expect(() => planPayment('47.30', [], 'pix', '50')).toThrow(/troco só em dinheiro/);
    const pays = [{ amount: '20.00', status: 'approved' as const }, { amount: '10.00', status: 'declined' as const }];
    expect(remainingAmount('47.30', pays).toFixed(2)).toBe('27.30');
    expect(isFullyPaid('47.30', pays)).toBe(false);
    expect(isFullyPaid('47.30', [...pays, { amount: '27.30', status: 'approved' as const }])).toBe(true);
    expect(() => planPayment('20', [{ amount: '20', status: 'approved' }], 'cash', '5')).toThrow(/já está paga/);
  });

  it('parcelado só no crédito, com máximo de parcelas e parcela mínima do ERP', () => {
    expect(() => planPayment('100', [], 'debit', '100', { installments: 2 })).toThrow(/só no crédito/);
    expect(() => planPayment('100', [], 'credit', '100', { installments: 13, maxInstallments: 12 })).toThrow(/Máximo de 12/);
    expect(() => planPayment('30', [], 'credit', '30', { installments: 4, minInstallmentValue: '10.00' })).toThrow(/Parcela mínima/);
    expect(planPayment('100', [], 'credit', '100', { installments: 3 }).amount).toBe('100.00');
  });
});

describe('Caixa e conferência (seções 27 e 28)', () => {
  it('esperado por forma; diferença positiva, negativa e sem diferença; nada é apagado', () => {
    const e = expectedTotals({
      opening: '100.00', supplies: ['50.00'], withdrawals: ['120.00'],
      payments: [{ method: 'cash', amount: '80.00' }, { method: 'pix', amount: '40.00' }, { method: 'debit', amount: '25.00' }, { method: 'pos_credit', amount: '60.00' }],
      refunds: [{ group: 'cash', amount: '10.00' }],
    });
    expect(e).toMatchObject({ cash: '100.00', pix: '40.00', debit: '25.00', credit: '60.00', total: '225.00' });
    const c = conference(e, { cash: '95.00', pix: '40.00', debit: '26.00', credit: '60.00' });
    expect(c.map((x) => [x.group, x.difference, x.kind])).toEqual([['cash', '-5.00', 'negative'], ['pix', '0.00', 'none'], ['debit', '1.00', 'positive'], ['credit', '0.00', 'none']]);
    expect(totalDifference(c).toFixed(2)).toBe('-4.00');
  });
});

describe('Código de barras, pesáveis, numeração e estoque', () => {
  const scale = { prefixes: ['2'], pluDigits: 5 as const, valueKind: 'price' as const };
  const label = (body12: string) => { let s = 0; body12.split('').reverse().forEach((d, i) => (s += Number(d) * (i % 2 === 0 ? 3 : 1))); return body12 + ((10 - (s % 10)) % 10); };
  it('etiqueta de balança com preço ou peso; GTIN comum segue como código', () => {
    expect(parseScan(label('200123012345'), scale)).toMatchObject({ kind: 'scale', plu: '123', price: D('123.45') });
    expect(parseScan(label('200123001250'), { ...scale, valueKind: 'weight' })).toMatchObject({ kind: 'scale', plu: '123', weight: D('1.25') });
    expect(parseScan('7891234567895', scale)).toEqual({ kind: 'code', code: '7891234567895' });
    expect(splitQuantity('3*7891234567895')).toEqual({ quantity: '3', code: '7891234567895' });
    expect(splitQuantity('0,350 x PAO')).toEqual({ quantity: '0.350', code: 'PAO' });
  });

  it('número da venda e dia da loja', () => {
    expect(saleNumber('03', '20261027', 124)).toBe('PDV-03-20261027-000124');
    expect(storeDay(new Date('2026-10-28T02:30:00Z'))).toBe('20261027');
  });

  it('situação e decisão de estoque configuráveis pelo ERP', () => {
    const st = (available: string | null, productStatus = 'active') => stockStatus({ productStatus, controlsStock: true, available, reorderPoint: null, lowThreshold: '5' });
    expect([st('10'), st('3'), st('0'), st('10', 'inactive')]).toEqual(['available', 'low', 'out', 'blocked']);
    const base = { available: '1', requested: '2', allowNegative: false, description: 'Café' };
    expect(stockDecision('low', 'block', base)).toMatchObject({ action: 'block' });
    expect(stockDecision('low', 'warn', base)).toMatchObject({ action: 'warn' });
    expect(stockDecision('low', 'allow', base)).toMatchObject({ action: 'warn', message: 'Café: estoque baixo' });
    expect(stockDecision('available', 'block', { ...base, available: '10' })).toEqual({ action: 'allow' });
    expect(stockDecision('blocked', 'allow', base)).toMatchObject({ action: 'block' });
  });

  it('texto de busca e documento mascarado', () => {
    expect(normalize('  Pão  de Açúcar ')).toBe('pao de acucar');
    expect(maskTaxId('529.982.247-25')).toBe('***.982.247-**');
  });
});
