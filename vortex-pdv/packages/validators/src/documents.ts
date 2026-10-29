/** Remove máscara mantendo letras (CNPJ alfanumérico) e dígitos, em maiúsculas. */
export function cleanDoc(value: string): string {
  return (value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
export function onlyDigits(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}

function mod11Digit(sum: number): number {
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

export function isValidCPF(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const n = cpf.split('').map(Number);
  let s = 0;
  for (let i = 0; i < 9; i++) s += n[i]! * (10 - i);
  if (mod11Digit(s) !== n[9]) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += n[i]! * (11 - i);
  return mod11Digit(s) === n[10];
}

/**
 * Valor de um caractere de CNPJ para cálculo do DV (IN RFB 2.229/2024):
 * código ASCII − 48. Dígitos 0–9 valem 0–9; 'A' vale 17 ... 'Z' vale 42.
 */
function cnpjCharValue(c: string): number {
  return c.charCodeAt(0) - 48;
}

const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** Calcula os 2 DVs numéricos de uma base de CNPJ de 12 posições (numérica ou alfanumérica). */
export function cnpjCheckDigits(base12: string): string {
  const b = cleanDoc(base12);
  if (!/^[0-9A-Z]{12}$/.test(b)) throw new RangeError('Base de CNPJ deve ter 12 posições alfanuméricas');
  let s = 0;
  for (let i = 0; i < 12; i++) s += cnpjCharValue(b[i]!) * CNPJ_W1[i]!;
  const d1 = mod11Digit(s);
  const b13 = b + String(d1);
  s = 0;
  for (let i = 0; i < 13; i++) s += cnpjCharValue(b13[i]!) * CNPJ_W2[i]!;
  const d2 = mod11Digit(s);
  return `${d1}${d2}`;
}

/**
 * RN-CAD-01: valida CNPJ numérico (antigo) e alfanumérico (a partir de 31/07/2026).
 * As 12 primeiras posições aceitam letras A–Z e dígitos; os 2 DVs são sempre numéricos.
 * O CNPJ é sempre tratado como texto de 14 posições, nunca como número.
 */
export function isValidCNPJ(value: string): boolean {
  const c = cleanDoc(value);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c)) return false;
  if (/^(\d)\1{13}$/.test(c)) return false;
  return cnpjCheckDigits(c.slice(0, 12)) === c.slice(12);
}

export function isAlphanumericCNPJ(value: string): boolean {
  return /[A-Z]/.test(cleanDoc(value));
}

export function formatCNPJ(value: string): string {
  const c = cleanDoc(value);
  if (c.length !== 14) return value;
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

export function formatCPF(value: string): string {
  const c = onlyDigits(value);
  if (c.length !== 11) return value;
  return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
}

export type TaxIdKind = 'CPF' | 'CNPJ';
export function detectTaxId(value: string): { kind: TaxIdKind; value: string; valid: boolean } | null {
  const c = cleanDoc(value);
  if (c.length === 11 && /^\d+$/.test(c)) return { kind: 'CPF', value: c, valid: isValidCPF(c) };
  if (c.length === 14) return { kind: 'CNPJ', value: c, valid: isValidCNPJ(c) };
  return null;
}

/** GTIN-8/12/13/14 (módulo 10, pesos 3 e 1 a partir da direita). */
export function isValidGTIN(value: string): boolean {
  const g = (value ?? '').trim();
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(g)) return false;
  const digits = g.split('').map(Number);
  const check = digits.pop()!;
  let s = 0;
  digits.reverse().forEach((d, i) => (s += d * (i % 2 === 0 ? 3 : 1)));
  return (10 - (s % 10)) % 10 === check;
}

/** Na NF-e, produto sem código de barras usa o literal "SEM GTIN". */
export function isValidGTINOrSemGTIN(value: string): boolean {
  return value === 'SEM GTIN' || isValidGTIN(value);
}

export const isValidNCMFormat = (v: string) => /^\d{8}$/.test(v ?? '');
export const isValidCESTFormat = (v: string) => /^\d{7}$/.test(v ?? '');
export const isValidCEPFormat = (v: string) => /^\d{8}$/.test(onlyDigits(v ?? ''));
export const isValidCFOPFormat = (v: string) => /^[1-7]\d{3}$/.test(v ?? '');
export const isValidIBGEMunicipio = (v: string) => /^\d{7}$/.test(v ?? '');

/**
 * Chave de acesso de 44 posições (NF-e/NFC-e/CT-e): cUF(2) AAMM(4) CNPJ(14) mod(2)
 * série(3) nNF(9) tpEmis(1) cNF(8) cDV(1). DV por módulo 11, pesos 2..9 da direita.
 * Aceita CNPJ alfanumérico no campo do emitente (valor ASCII − 48).
 */
export function accessKeyCheckDigit(key43: string): number {
  const k = cleanDoc(key43);
  if (!/^[0-9A-Z]{43}$/.test(k)) throw new RangeError('Chave base deve ter 43 posições');
  let s = 0;
  let w = 2;
  for (let i = 42; i >= 0; i--) {
    s += (k.charCodeAt(i) - 48) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const r = s % 11;
  return r < 2 ? 0 : 11 - r;
}

export function isValidAccessKey(value: string): boolean {
  const k = cleanDoc(value);
  if (!/^[0-9A-Z]{43}\d$/.test(k)) return false;
  return accessKeyCheckDigit(k.slice(0, 43)) === Number(k[43]);
}

export interface AccessKeyParts {
  cUF: string;
  aamm: string;
  cnpj: string;
  modelo: string;
  serie: number;
  numero: number;
  tpEmis: string;
  cNF: string;
}

export function buildAccessKey(p: AccessKeyParts): string {
  const base =
    p.cUF.padStart(2, '0') +
    p.aamm +
    cleanDoc(p.cnpj).padStart(14, '0') +
    p.modelo.padStart(2, '0') +
    String(p.serie).padStart(3, '0') +
    String(p.numero).padStart(9, '0') +
    p.tpEmis +
    p.cNF.padStart(8, '0');
  return base + accessKeyCheckDigit(base);
}

export function parseAccessKey(key: string): AccessKeyParts & { dv: number } {
  const k = cleanDoc(key);
  return {
    cUF: k.slice(0, 2),
    aamm: k.slice(2, 6),
    cnpj: k.slice(6, 20),
    modelo: k.slice(20, 22),
    serie: Number(k.slice(22, 25)),
    numero: Number(k.slice(25, 34)),
    tpEmis: k.slice(34, 35),
    cNF: k.slice(35, 43),
    dv: Number(k.slice(43, 44)),
  };
}
