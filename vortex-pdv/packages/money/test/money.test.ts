import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D, allocate, formatBRL, markupDivisorPrice, money, pctMoney, round, splitInstallments, sum, toFixed } from '../src/index.js';

describe('RN-GER-06 dinheiro nunca em ponto flutuante', () => {
  it('0,1 + 0,2 = 0,3 exato', () => {
    expect(D(0.1).plus(D(0.2)).toString()).toBe('0.3');
  });
  it('arredondamento comercial (half-up) centralizado por campo', () => {
    expect(money('2.345')).toBe('2.35');
    expect(money('2.344')).toBe('2.34');
    expect(money('-2.345')).toBe('-2.35');
    expect(toFixed('1.23456', 'quantity')).toBe('1.2346');
    expect(toFixed('3.123456789012', 'unitPrice')).toBe('3.1234567890');
    expect(round('18', 'rate').toFixed(4)).toBe('18.0000');
  });
  it('aceita vírgula decimal e rejeita lixo', () => {
    expect(D('10,50').toString()).toBe('10.5');
    expect(() => D('abc')).toThrow();
    expect(() => D(Number.NaN)).toThrow();
  });
  it('percentual monetário', () => {
    expect(pctMoney('100.00', '18').toFixed(2)).toBe('18.00');
    expect(pctMoney('33.33', '7').toFixed(2)).toBe('2.33');
  });
  it('formata BRL', () => {
    expect(formatBRL('1234567.891')).toBe('R$ 1.234.567,89');
    expect(formatBRL('-5')).toBe('-R$ 5,00');
  });
});

describe('RN-FIS-03 rateio proporcional', () => {
  it('diferença de centavos vai para o item de maior valor', () => {
    const parts = allocate('10.00', ['1', '1', '1']);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['3.34', '3.33', '3.33']);
    const parts2 = allocate('0.10', ['10', '50', '40']);
    expect(parts2.map((p) => p.toFixed(2))).toEqual(['0.01', '0.05', '0.04']);
    const parts3 = allocate('1.00', ['30', '30', '40']);
    expect(sum(parts3).toFixed(2)).toBe('1.00');
    expect(parts3[2]!.toFixed(2)).toBe('0.40');
  });
  it('propriedade: soma do rateio sempre fecha com o total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 40 }),
        (cents, weights) => {
          const total = D(cents).dividedBy(100);
          const parts = allocate(total, weights);
          return sum(parts).equals(total) && parts.every((p) => p.decimalPlaces() <= 2);
        },
      ),
    );
  });
});

describe('parcelamento', () => {
  it('30/60/90 de 100,00 fecha o total', () => {
    const p = splitInstallments('100.00', ['33.3333', '33.3333', '33.3334']);
    expect(sum(p).toFixed(2)).toBe('100.00');
  });
});

describe('Markup divisor (seção 06)', () => {
  it('exemplo do guia: custo 60 → preço 100,00', () => {
    expect(markupDivisorPrice('60', { taxes: 8, commission: 3, cardFee: 2, fixedExpenses: 12, margin: 15 }).toFixed(2)).toBe('100.00');
  });
  it('rejeita percentuais ≥ 100%', () => {
    expect(() => markupDivisorPrice('60', { margin: 100 })).toThrow();
  });
});
