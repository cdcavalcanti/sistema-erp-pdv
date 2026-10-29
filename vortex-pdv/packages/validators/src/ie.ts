/**
 * Validação de Inscrição Estadual por UF (RN-CAD-03), conforme rotinas de
 * conferência publicadas pelo SINTEGRA de cada estado.
 * "ISENTO" é aceito como literal quando o indicador de IE do destinatário é isento.
 */
import type { UF } from './uf.js';

const digits = (s: string) => s.split('').map(Number);

function weighted(nums: number[], weights: number[]): number {
  let s = 0;
  for (let i = 0; i < weights.length; i++) s += nums[i]! * weights[i]!;
  return s;
}
const range = (from: number, to: number) => {
  const r: number[] = [];
  if (from >= to) for (let i = from; i >= to; i--) r.push(i);
  else for (let i = from; i <= to; i++) r.push(i);
  return r;
};

/** Padrão mais comum: 11 − (soma mod 11); resto 0 ou 1 → 0. */
function dvStd(nums: number[], weights: number[]): number {
  const r = weighted(nums, weights) % 11;
  return r < 2 ? 0 : 11 - r;
}
/** Variante: d = 11 − resto; se d ≥ 10 → 0. */
function dvSub10(nums: number[], weights: number[]): number {
  const d = 11 - (weighted(nums, weights) % 11);
  return d >= 10 ? 0 : d;
}
/** Variante (AL, RN): (soma × 10) mod 11; 10 → 0. */
function dvTimes10(nums: number[], weights: number[]): number {
  const d = (weighted(nums, weights) * 10) % 11;
  return d === 10 ? 0 : d;
}

type Validator = (ie: string) => boolean;

const simple9 = (dv: (n: number[], w: number[]) => number, prefix?: RegExp): Validator => (ie) => {
  if (!/^\d{9}$/.test(ie)) return false;
  if (prefix && !prefix.test(ie)) return false;
  const n = digits(ie);
  return dv(n, range(9, 2)) === n[8];
};

const validators: Record<UF, Validator> = {
  AC: (ie) => {
    if (!/^01\d{11}$/.test(ie)) return false;
    const n = digits(ie);
    const d1 = dvStd(n, [4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = dvStd([...n.slice(0, 11), d1], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return d1 === n[11] && d2 === n[12];
  },
  AL: (ie) => {
    if (!/^24[03578]\d{6}$/.test(ie)) return false;
    const n = digits(ie);
    return dvTimes10(n, range(9, 2)) === n[8];
  },
  AP: (ie) => {
    if (!/^03\d{7}$/.test(ie)) return false;
    const n = digits(ie);
    const num = Number(ie.slice(0, 8));
    let p = 0;
    let dz = 0;
    if (num >= 3000001 && num <= 3017000) {
      p = 5;
      dz = 0;
    } else if (num >= 3017001 && num <= 3019022) {
      p = 9;
      dz = 1;
    }
    let d = 11 - ((p + weighted(n, range(9, 2))) % 11);
    if (d === 10) d = 0;
    else if (d === 11) d = dz;
    return d === n[8];
  },
  AM: (ie) => {
    if (!/^\d{9}$/.test(ie)) return false;
    const n = digits(ie);
    const s = weighted(n, range(9, 2));
    let d: number;
    if (s < 11) d = 11 - s;
    else {
      const r = s % 11;
      d = r <= 1 ? 0 : 11 - r;
    }
    return d === n[8];
  },
  BA: (ie) => {
    if (!/^\d{8,9}$/.test(ie)) return false;
    const n = digits(ie);
    const len = ie.length;
    const ref = len === 8 ? n[0]! : n[1]!;
    const mod10 = [0, 1, 2, 3, 4, 5, 8].includes(ref);
    const calc = (nums: number[], w: number[]) => {
      const s = weighted(nums, w);
      if (mod10) {
        const r = s % 10;
        return r === 0 ? 0 : 10 - r;
      }
      const r = s % 11;
      return r <= 1 ? 0 : 11 - r;
    };
    const base = n.slice(0, len - 2);
    // O segundo DV (último) é calculado primeiro, sobre a base.
    const d2 = calc(base, range(len - 1, 2));
    const d1 = calc([...base, d2], range(len, 2));
    return d1 === n[len - 2] && d2 === n[len - 1];
  },
  CE: simple9(dvSub10),
  DF: (ie) => {
    if (!/^07\d{11}$|^08\d{11}$/.test(ie)) return false;
    const n = digits(ie);
    const d1 = dvStd(n, [4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = dvStd([...n.slice(0, 11), d1], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return d1 === n[11] && d2 === n[12];
  },
  ES: simple9(dvStd),
  GO: (ie) => {
    if (!/^(10|11|15|2\d)\d{7}$/.test(ie)) return false;
    const n = digits(ie);
    const r = weighted(n, range(9, 2)) % 11;
    const num = Number(ie.slice(0, 8));
    let d: number;
    if (r === 0) d = 0;
    else if (r === 1) d = num >= 10103105 && num <= 10119997 ? 1 : 0;
    else d = 11 - r;
    return d === n[8];
  },
  MA: simple9(dvSub10, /^12/),
  MT: (ie) => {
    if (!/^\d{9,11}$/.test(ie)) return false;
    const p = ie.padStart(11, '0');
    const n = digits(p);
    return dvStd(n, [3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === n[10];
  },
  MS: (ie) => {
    if (!/^28\d{7}$|^50\d{7}$/.test(ie)) return false;
    const n = digits(ie);
    const r = weighted(n, range(9, 2)) % 11;
    let d = r === 0 ? 0 : 11 - r;
    if (d > 9) d = 0;
    return d === n[8];
  },
  MG: (ie) => {
    if (!/^\d{13}$/.test(ie)) return false;
    const n = digits(ie);
    // D1: insere "0" após o código do município (3 primeiros dígitos), pesos 1,2 alternados,
    // soma dos algarismos dos produtos; DV = próxima dezena − soma.
    const withZero = [...n.slice(0, 3), 0, ...n.slice(3, 11)];
    let s = 0;
    withZero.forEach((v, i) => {
      const prod = v * (i % 2 === 0 ? 1 : 2);
      s += Math.floor(prod / 10) + (prod % 10);
    });
    const d1 = (10 - (s % 10)) % 10;
    const d2 = dvStd([...n.slice(0, 11), d1], [3, 2, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    return d1 === n[11] && d2 === n[12];
  },
  PA: simple9(dvStd, /^15/),
  PB: simple9(dvSub10),
  PR: (ie) => {
    if (!/^\d{10}$/.test(ie)) return false;
    const n = digits(ie);
    const d1 = dvStd(n, [3, 2, 7, 6, 5, 4, 3, 2]);
    const d2 = dvStd([...n.slice(0, 8), d1], [4, 3, 2, 7, 6, 5, 4, 3, 2]);
    return d1 === n[8] && d2 === n[9];
  },
  PE: (ie) => {
    if (/^\d{9}$/.test(ie)) {
      // eFisco: 7 dígitos + 2 DVs
      const n = digits(ie);
      const d1 = dvStd(n, range(8, 2));
      const d2 = dvStd([...n.slice(0, 7), d1], range(9, 2));
      return d1 === n[7] && d2 === n[8];
    }
    if (/^\d{14}$/.test(ie)) {
      // CACEPE antigo
      const n = digits(ie);
      let d = 11 - (weighted(n, [5, 4, 3, 2, 1, 9, 8, 7, 6, 5, 4, 3, 2]) % 11);
      if (d > 9) d -= 10;
      return d === n[13];
    }
    return false;
  },
  PI: simple9(dvSub10),
  RJ: (ie) => {
    if (!/^\d{8}$/.test(ie)) return false;
    const n = digits(ie);
    return dvStd(n, [2, 7, 6, 5, 4, 3, 2]) === n[7];
  },
  RN: (ie) => {
    if (!/^20\d{7,8}$/.test(ie)) return false;
    const n = digits(ie);
    const len = ie.length;
    return dvTimes10(n, range(len, 2)) === n[len - 1];
  },
  RS: (ie) => {
    if (!/^\d{10}$/.test(ie)) return false;
    const n = digits(ie);
    return dvSub10(n, [2, 9, 8, 7, 6, 5, 4, 3, 2]) === n[9];
  },
  RO: (ie) => {
    if (/^\d{14}$/.test(ie)) {
      const n = digits(ie);
      let d = 11 - (weighted(n, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) % 11);
      if (d >= 10) d -= 10;
      return d === n[13];
    }
    return false;
  },
  RR: (ie) => {
    if (!/^24\d{7}$/.test(ie)) return false;
    const n = digits(ie);
    return weighted(n, range(1, 8)) % 9 === n[8];
  },
  SC: simple9(dvStd),
  SE: simple9(dvSub10),
  SP: (ie) => {
    if (/^P\d{12}$/.test(ie)) {
      // Produtor rural: P + 8 dígitos + DV + 3 dígitos
      const n = digits(ie.slice(1));
      const r = weighted(n, [1, 3, 4, 5, 6, 7, 8, 10]) % 11;
      return r % 10 === n[8];
    }
    if (!/^\d{12}$/.test(ie)) return false;
    const n = digits(ie);
    const d1 = (weighted(n, [1, 3, 4, 5, 6, 7, 8, 10]) % 11) % 10;
    const d2 = (weighted(n, [3, 2, 10, 9, 8, 7, 6, 5, 4, 3, 2]) % 11) % 10;
    return d1 === n[8] && d2 === n[11];
  },
  TO: (ie) => {
    let base = ie;
    if (/^\d{11}$/.test(ie)) {
      if (!['01', '02', '03', '99'].includes(ie.slice(2, 4))) return false;
      base = ie.slice(0, 2) + ie.slice(4);
    }
    if (!/^\d{9}$/.test(base)) return false;
    const n = digits(base);
    return dvStd(n, range(9, 2)) === n[8];
  },
};

export function normalizeIE(value: string): string {
  const v = (value ?? '').trim().toUpperCase();
  if (v === 'ISENTO') return v;
  return v.replace(/[^0-9P]/g, '');
}

export function isValidIE(value: string, uf: UF): boolean {
  const ie = normalizeIE(value);
  if (ie === 'ISENTO') return true;
  if (!ie) return false;
  const fn = validators[uf];
  return fn ? fn(ie) : false;
}
