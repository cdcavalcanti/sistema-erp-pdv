import type { FiscalOperationInput, ItemInput, RuleGroup, RuleKeys, TaxRule } from './types.js';

export class FiscalConfigError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'FiscalConfigError';
  }
}

/** Contexto de busca de um item: os valores contra os quais as chaves da regra são comparadas. */
export interface MatchContext {
  date: string;
  operationCode: string;
  direction: 'S' | 'E';
  ufOrigin: string;
  ufDest: string;
  ncm: string | null;
  cest: string | null;
  taxGroup: string | null;
  productId: string | null;
  recipientIeIndicator: 1 | 2 | 9;
  recipientFinalConsumer: boolean;
  recipientRegime: string | null;
  issuerRegime: string;
  origin: number;
  itemKind: 'goods' | 'service';
}

export function matchContext(op: FiscalOperationInput, item: ItemInput): MatchContext {
  return {
    date: op.date,
    operationCode: op.operation.code,
    direction: op.operation.direction,
    ufOrigin: op.issuer.uf,
    ufDest: op.recipient.uf,
    ncm: item.ncm ?? null,
    cest: item.cest ?? null,
    taxGroup: item.taxGroup ?? null,
    productId: item.productId ?? null,
    recipientIeIndicator: op.recipient.ieIndicator,
    recipientFinalConsumer: op.recipient.finalConsumer,
    recipientRegime: op.recipient.regime ?? null,
    issuerRegime: op.issuer.regime,
    origin: item.origin,
    itemKind: item.kind,
  };
}

const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';

/** A regra vale para a data do fato gerador? (RN-GER-03) */
export function isValidOn(rule: TaxRule, date: string): boolean {
  return rule.validFrom <= date && (!rule.validTo || rule.validTo >= date);
}

export function matches(keys: RuleKeys, c: MatchContext): boolean {
  if (isSet(keys.operationCode) && keys.operationCode !== c.operationCode) return false;
  if (isSet(keys.direction) && keys.direction !== c.direction) return false;
  if (isSet(keys.ufOrigin) && keys.ufOrigin !== c.ufOrigin) return false;
  if (isSet(keys.ufDest) && keys.ufDest !== c.ufDest) return false;
  if (isSet(keys.ncmPrefix) && !(c.ncm && c.ncm.startsWith(keys.ncmPrefix!))) return false;
  if (isSet(keys.cest) && keys.cest !== c.cest) return false;
  if (isSet(keys.taxGroup) && keys.taxGroup !== c.taxGroup) return false;
  if (isSet(keys.productId) && keys.productId !== c.productId) return false;
  if (isSet(keys.recipientIeIndicator) && keys.recipientIeIndicator !== c.recipientIeIndicator) return false;
  if (isSet(keys.recipientFinalConsumer) && keys.recipientFinalConsumer !== c.recipientFinalConsumer) return false;
  if (isSet(keys.recipientRegime) && keys.recipientRegime !== c.recipientRegime) return false;
  if (isSet(keys.issuerRegime) && keys.issuerRegime !== c.issuerRegime) return false;
  if (isSet(keys.origin) && keys.origin !== c.origin) return false;
  if (isSet(keys.itemKind) && keys.itemKind !== c.itemKind) return false;
  return true;
}

/**
 * Especificidade (RN-FIS-01): cada chave preenchida vale 100 pontos; o produto
 * vale 1000 (exceção pontual); o NCM soma pontos pelo tamanho do prefixo, para
 * que NCM completo vença capítulo. Quanto maior, mais específica.
 */
export function specificity(keys: RuleKeys): number {
  let s = 0;
  const simple: (keyof RuleKeys)[] = ['operationCode', 'direction', 'ufOrigin', 'ufDest', 'cest', 'taxGroup', 'recipientIeIndicator',
    'recipientFinalConsumer', 'recipientRegime', 'issuerRegime', 'origin', 'itemKind'];
  for (const k of simple) if (isSet(keys[k])) s += 100;
  if (isSet(keys.productId)) s += 1000;
  if (isSet(keys.ncmPrefix)) s += 100 + keys.ncmPrefix!.length * 10;
  return s;
}

export interface Selected<G extends RuleGroup> {
  rule: TaxRule;
  value: NonNullable<TaxRule['result'][G]>;
}

/**
 * Escolhe, para um grupo de tributo, a regra vigente mais específica que casa com o item.
 * Empate entre regras igualmente específicas é erro de configuração.
 */
export function selectRule<G extends RuleGroup>(rules: TaxRule[], ctx: MatchContext, group: G): Selected<G> | null {
  let best: TaxRule | null = null;
  let bestScore = -1;
  let tie: TaxRule | null = null;
  for (const r of rules) {
    if (r.result[group] === undefined || !isValidOn(r, ctx.date) || !matches(r.keys, ctx)) continue;
    const s = specificity(r.keys);
    if (s > bestScore) {
      best = r;
      bestScore = s;
      tie = null;
    } else if (s === bestScore) {
      tie = r;
    }
  }
  if (best && tie) {
    throw new FiscalConfigError(`RN-FIS-01: regras "${best.name}" e "${tie.name}" são igualmente específicas para ${group}`, {
      rule: 'RN-FIS-01', group, rules: [best.id, tie.id],
    });
  }
  return best ? { rule: best, value: best.result[group] as NonNullable<TaxRule['result'][G]> } : null;
}

function sameKeys(a: RuleKeys, b: RuleKeys): boolean {
  const keys: (keyof RuleKeys)[] = ['operationCode', 'direction', 'ufOrigin', 'ufDest', 'ncmPrefix', 'cest', 'taxGroup', 'productId',
    'recipientIeIndicator', 'recipientFinalConsumer', 'recipientRegime', 'issuerRegime', 'origin', 'itemKind'];
  return keys.every((k) => (isSet(a[k]) ? a[k] === b[k] : !isSet(b[k])));
}

function overlaps(a: TaxRule, b: TaxRule): boolean {
  const aEnd = a.validTo ?? '9999-12-31';
  const bEnd = b.validTo ?? '9999-12-31';
  return a.validFrom <= bEnd && b.validFrom <= aEnd;
}

/**
 * Validação ao salvar uma regra (RN-FIS-01): bloqueia se outra regra com exatamente
 * as mesmas chaves e vigência sobreposta define o mesmo grupo de tributo.
 * Regras com chaves diferentes mas mesma pontuação também são recusadas quando
 * podem casar com o mesmo item (chaves não conflitantes).
 */
export function findConflicts(candidate: TaxRule, existing: TaxRule[]): { ruleId: string; ruleName: string; groups: RuleGroup[] }[] {
  const out: { ruleId: string; ruleName: string; groups: RuleGroup[] }[] = [];
  const groups = Object.keys(candidate.result) as RuleGroup[];
  for (const r of existing) {
    if (r.id === candidate.id || !overlaps(candidate, r)) continue;
    const common = groups.filter((g) => r.result[g] !== undefined);
    if (!common.length) continue;
    if (sameKeys(candidate.keys, r.keys) || (specificity(candidate.keys) === specificity(r.keys) && compatible(candidate.keys, r.keys))) {
      out.push({ ruleId: r.id, ruleName: r.name, groups: common });
    }
  }
  return out;
}

/** Duas chaves podem casar com o mesmo item? (nenhuma chave preenchida em ambas com valores diferentes) */
function compatible(a: RuleKeys, b: RuleKeys): boolean {
  const keys: (keyof RuleKeys)[] = ['operationCode', 'direction', 'ufOrigin', 'ufDest', 'cest', 'taxGroup', 'productId',
    'recipientIeIndicator', 'recipientFinalConsumer', 'recipientRegime', 'issuerRegime', 'origin', 'itemKind'];
  for (const k of keys) if (isSet(a[k]) && isSet(b[k]) && a[k] !== b[k]) return false;
  if (isSet(a.ncmPrefix) && isSet(b.ncmPrefix) && !(a.ncmPrefix!.startsWith(b.ncmPrefix!) || b.ncmPrefix!.startsWith(a.ncmPrefix!))) return false;
  return true;
}
