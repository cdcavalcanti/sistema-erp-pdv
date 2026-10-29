/**
 * Biblioteca única de dinheiro e arredondamento do ERP VORTEX (RN-GER-06).
 *
 * - Nenhum valor monetário usa ponto flutuante: tudo é Decimal (decimal.js).
 * - O banco guarda NUMERIC com escala fixa; o driver devolve string e a
 *   conversão passa sempre por aqui.
 * - O arredondamento é explícito, centralizado e definido por campo
 *   (ver FIELD_SCALES). Regra da casa: ROUND_HALF_UP (arredondamento
 *   comercial, ABNT NBR 5891 para o dígito 5 seguido de zeros).
 */
import { Decimal as DecimalJs } from 'decimal.js';

export const Decimal = DecimalJs.clone({ precision: 50, rounding: DecimalJs.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;
export type DecimalInput = Decimal | string | number | bigint;

/** Escala (casas decimais) de cada tipo de campo, conforme seção 22 do guia. */
export const FIELD_SCALES = {
  /** NUMERIC(18,2): valores, totais, impostos */
  money: 2,
  /** NUMERIC(18,4): quantidades (qCom da NF-e aceita até 4 casas) */
  quantity: 4,
  /** NUMERIC(20,10): preço unitário e custo (vUnCom aceita até 10 casas) */
  unitPrice: 10,
  cost: 10,
  /** Alíquotas e percentuais: 4 casas (ex.: 18.0000, 0.9000) */
  rate: 4,
  /** Fatores de conversão de unidade e MVA */
  factor: 6,
} as const;
export type FieldKind = keyof typeof FIELD_SCALES;

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const HUNDRED = new Decimal(100);

export function D(value: DecimalInput | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return ZERO;
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`Valor numérico inválido: ${value}`);
    // Converte pelo texto para não herdar erro binário (0.1 + 0.2).
    return new Decimal(value.toString());
  }
  if (typeof value === 'bigint') return new Decimal(value.toString());
  const v = value.trim().replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(v)) throw new RangeError(`Valor decimal inválido: "${value}"`);
  return new Decimal(v);
}

/** Arredonda para a escala do tipo de campo. Único ponto de arredondamento do sistema. */
export function round(value: DecimalInput, kind: FieldKind | number): Decimal {
  const scale = typeof kind === 'number' ? kind : FIELD_SCALES[kind];
  return D(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
}

export const roundMoney = (v: DecimalInput) => round(v, 'money');
export const roundQty = (v: DecimalInput) => round(v, 'quantity');
export const roundUnit = (v: DecimalInput) => round(v, 'unitPrice');
export const roundRate = (v: DecimalInput) => round(v, 'rate');

/** Texto com escala fixa, pronto para NUMERIC do Postgres ou XML da NF-e. */
export function toFixed(value: DecimalInput, kind: FieldKind | number): string {
  const scale = typeof kind === 'number' ? kind : FIELD_SCALES[kind];
  return round(value, scale).toFixed(scale);
}
export const money = (v: DecimalInput) => toFixed(v, 'money');

/** base × alíquota% (sem arredondar). */
export function pct(base: DecimalInput, ratePercent: DecimalInput): Decimal {
  return D(base).times(D(ratePercent)).dividedBy(HUNDRED);
}

/** base × alíquota%, arredondado como valor monetário. */
export function pctMoney(base: DecimalInput, ratePercent: DecimalInput): Decimal {
  return roundMoney(pct(base, ratePercent));
}

export function sum(values: Iterable<DecimalInput>): Decimal {
  let acc = ZERO;
  for (const v of values) acc = acc.plus(D(v));
  return acc;
}

export function max(a: DecimalInput, b: DecimalInput): Decimal {
  return Decimal.max(D(a), D(b));
}
export function min(a: DecimalInput, b: DecimalInput): Decimal {
  return Decimal.min(D(a), D(b));
}

export function isZero(v: DecimalInput): boolean {
  return D(v).isZero();
}

/**
 * Rateio proporcional (RN-FIS-03).
 * Distribui `total` entre itens na proporção de `weights`, arredondando cada
 * parcela na escala pedida. A diferença de arredondamento vai para o item de
 * maior peso (empate: o primeiro). A soma das parcelas é sempre igual ao total.
 */
export function allocate(total: DecimalInput, weights: DecimalInput[], kind: FieldKind | number = 'money'): Decimal[] {
  const scale = typeof kind === 'number' ? kind : FIELD_SCALES[kind];
  const t = round(total, scale);
  if (weights.length === 0) {
    if (!t.isZero()) throw new RangeError('Rateio de valor diferente de zero sem itens');
    return [];
  }
  const w = weights.map(D);
  if (w.some((x) => x.isNegative())) throw new RangeError('Rateio com peso negativo');
  const totalWeight = sum(w);
  let parts: Decimal[];
  if (totalWeight.isZero()) {
    // Sem base proporcional: divide igualmente.
    parts = w.map(() => round(t.dividedBy(w.length), scale));
  } else {
    parts = w.map((x) => round(t.times(x).dividedBy(totalWeight), scale));
  }
  const diff = t.minus(sum(parts));
  if (!diff.isZero()) {
    let idx = 0;
    for (let i = 1; i < w.length; i++) if (w[i]!.greaterThan(w[idx]!)) idx = i;
    parts[idx] = parts[idx]!.plus(diff);
  }
  return parts;
}

/** Divide um total em N parcelas (ex.: condição 30/60/90); diferença na primeira parcela. */
export function splitInstallments(total: DecimalInput, percentages: DecimalInput[]): Decimal[] {
  const t = roundMoney(total);
  const parts = percentages.map((p) => roundMoney(pct(t, p)));
  const diff = t.minus(sum(parts));
  if (parts.length > 0 && !diff.isZero()) parts[0] = parts[0]!.plus(diff);
  return parts;
}

/** Formata em BRL para exibição (nunca para cálculo). */
export function formatBRL(value: DecimalInput): string {
  const v = roundMoney(value);
  const neg = v.isNegative();
  const [int, frac] = v.abs().toFixed(2).split('.');
  const withDots = int!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}R$ ${withDots},${frac}`;
}

/**
 * Markup divisor (seção 06): preço = custo ÷ (1 − Σ percentuais).
 * Ex.: custo 60, impostos 8, comissão 3, cartão 2, despesas 12, margem 15 → 100,00.
 */
export function markupDivisorPrice(
  cost: DecimalInput,
  percents: { taxes?: DecimalInput; commission?: DecimalInput; cardFee?: DecimalInput; fixedExpenses?: DecimalInput; margin?: DecimalInput },
): Decimal {
  const totalPct = sum([percents.taxes ?? 0, percents.commission ?? 0, percents.cardFee ?? 0, percents.fixedExpenses ?? 0, percents.margin ?? 0]);
  const divisor = ONE.minus(totalPct.dividedBy(HUNDRED));
  if (divisor.lessThanOrEqualTo(0)) throw new RangeError('Soma de percentuais do markup deve ser menor que 100%');
  return roundMoney(D(cost).dividedBy(divisor));
}
