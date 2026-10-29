import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  accessKeyCheckDigit, buildAccessKey, cnpjCheckDigits, detectTaxId, isValidAccessKey, isValidCNPJ, isValidCPF,
  isValidGTIN, isValidGTINOrSemGTIN, isValidIE, parseAccessKey,
} from '../src/index.js';

describe('RN-CAD-01 CPF e CNPJ (numérico e alfanumérico)', () => {
  it('CPF válido e inválido', () => {
    expect(isValidCPF('529.982.247-25')).toBe(true);
    expect(isValidCPF('529.982.247-24')).toBe(false);
    expect(isValidCPF('111.111.111-11')).toBe(false);
  });
  it('CNPJ numérico antigo continua válido', () => {
    expect(isValidCNPJ('11.222.333/0001-81')).toBe(true);
    expect(isValidCNPJ('11.222.333/0001-80')).toBe(false);
    expect(isValidCNPJ('00.000.000/0000-00')).toBe(false);
  });
  it('CNPJ alfanumérico (exemplo oficial da Receita 12.ABC.345/01DE-35)', () => {
    expect(cnpjCheckDigits('12ABC34501DE')).toBe('35');
    expect(isValidCNPJ('12.ABC.345/01DE-35')).toBe(true);
    expect(isValidCNPJ('12abc34501de35')).toBe(true);
    expect(isValidCNPJ('12.ABC.345/01DE-36')).toBe(false);
  });
  it('DVs do CNPJ alfanumérico são sempre numéricos', () => {
    expect(isValidCNPJ('12ABC34501DEA5')).toBe(false);
  });
  it('propriedade: qualquer base alfanumérica gera CNPJ válido com seus DVs', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9A-Z]{12}$/), (base) => {
        const dv = cnpjCheckDigits(base);
        return /^\d\d$/.test(dv) && (isValidCNPJ(base + dv) || /^(\d)\1{11}$/.test(base));
      }),
    );
  });
  it('detecta o tipo do documento', () => {
    expect(detectTaxId('529.982.247-25')).toEqual({ kind: 'CPF', value: '52998224725', valid: true });
    expect(detectTaxId('12.ABC.345/01DE-35')?.kind).toBe('CNPJ');
  });
});

describe('RN-CAD-03 Inscrição estadual por UF', () => {
  it('exemplos conhecidos', () => {
    expect(isValidIE('110.042.490.114', 'SP')).toBe(true);
    expect(isValidIE('110.042.490.115', 'SP')).toBe(false);
    expect(isValidIE('062.307.904/0081', 'MG')).toBe(true);
    expect(isValidIE('062.307.904/0082', 'MG')).toBe(false);
    expect(isValidIE('0321418-40', 'PE')).toBe(true);
    expect(isValidIE('0321418-41', 'PE')).toBe(false);
    expect(isValidIE('18.1.001.0000004-9', 'PE')).toBe(true);
  });
  it('ISENTO é aceito como literal', () => {
    expect(isValidIE('ISENTO', 'BA')).toBe(true);
    expect(isValidIE('isento', 'SP')).toBe(true);
  });
  it('rejeita formato errado', () => {
    expect(isValidIE('123', 'RJ')).toBe(false);
    expect(isValidIE('', 'RJ')).toBe(false);
  });
});

describe('GTIN', () => {
  it('EAN-13 e EAN-8', () => {
    expect(isValidGTIN('7891000315507')).toBe(true);
    expect(isValidGTIN('7891000315508')).toBe(false);
    expect(isValidGTIN('96385074')).toBe(true);
    expect(isValidGTINOrSemGTIN('SEM GTIN')).toBe(true);
  });
});

describe('Chave de acesso', () => {
  it('monta, valida e decompõe', () => {
    const key = buildAccessKey({ cUF: '26', aamm: '2610', cnpj: '11222333000181', modelo: '55', serie: 1, numero: 123, tpEmis: '1', cNF: '12345678' });
    expect(key).toHaveLength(44);
    expect(isValidAccessKey(key)).toBe(true);
    const p = parseAccessKey(key);
    expect(p.numero).toBe(123);
    expect(p.modelo).toBe('55');
    const wrong = key.slice(0, 43) + ((Number(key[43]) + 1) % 10);
    expect(isValidAccessKey(wrong)).toBe(false);
  });
  it('aceita CNPJ alfanumérico do emitente', () => {
    const key = buildAccessKey({ cUF: '35', aamm: '2610', cnpj: '12ABC34501DE35', modelo: '55', serie: 1, numero: 1, tpEmis: '1', cNF: '00000001' });
    expect(isValidAccessKey(key)).toBe(true);
    expect(accessKeyCheckDigit(key.slice(0, 43))).toBe(Number(key[43]));
  });
});
