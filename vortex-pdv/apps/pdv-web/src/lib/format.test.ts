import { describe, expect, it } from 'vitest';
import { brl, parseMoney, qty } from './format';

describe('formatação da frente de caixa', () => {
  it('valores em reais, quantidades e entrada do operador', () => {
    expect(brl('1234.5')).toBe('1.234,50');
    expect(brl(null)).toBe('0,00');
    expect(qty('2')).toBe('2');
    expect(qty('0.355')).toBe('0,355');
    expect(parseMoney('1.234,56')).toBe('1234.56');
    expect(parseMoney('10,5')).toBe('10.5');
    expect(parseMoney('')).toBe('0');
  });
});
