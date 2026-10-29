import { describe, expect, it } from 'vitest';
import { brl, date, doc, num, pct, qty } from './format';

describe('formatação pt-BR sem ponto flutuante', () => {
  it('moeda, números e percentuais', () => {
    expect(brl('1234567.891')).toBe('R$ 1.234.567,89');
    expect(brl('-0.5')).toBe('−R$ 0,50');
    expect(brl('0.1')).toBe('R$ 0,10');
    expect(brl(null)).toBe('');
    expect(num('1234.5', 2)).toBe('1.234,50');
    expect(qty('24.0000')).toBe('24');
    expect(qty('1.2500')).toBe('1,25');
    expect(pct('4.5')).toBe('4,50%');
  });
  it('datas e documentos', () => {
    expect(date('2026-10-05')).toBe('05/10/2026');
    // Data-hora em UTC é mostrada no fuso de Brasília (02:00Z ainda é dia 4 em São Paulo)
    expect(date('2026-10-05T02:00:00Z')).toBe('04/10/2026');
    expect(doc('52998224725')).toBe('529.982.247-25');
    expect(doc('11222333000181')).toBe('11.222.333/0001-81');
  });
});
