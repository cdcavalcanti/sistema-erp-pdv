import type { FiscalOperationInput, ItemInput, TaxRule } from '../src/types.js';
import { REFERENCE_ICMS_INTERNAL_RATES, referenceIbsCbs, transitionFor } from '../src/index.js';

export const CCLASSTRIB = {
  '000001': { code: '000001', cst: '000', reductionIbs: '0', reductionCbs: '0', exempt: false, deferral: false, presumedCredit: false },
  '200003': { code: '200003', cst: '200', reductionIbs: '100', reductionCbs: '100', exempt: false, deferral: false, presumedCredit: false },
  '200034': { code: '200034', cst: '200', reductionIbs: '60', reductionCbs: '60', exempt: false, deferral: false, presumedCredit: false },
  '410001': { code: '410001', cst: '410', reductionIbs: '100', reductionCbs: '100', exempt: true, deferral: false, presumedCredit: false },
};

export const VENDA = { code: 'VENDA', direction: 'S' as const, purpose: 'sale' as const, cfopInternal: '5102', cfopInterstate: '6102', cfopForeign: '7102' };

export function item(over: Partial<ItemInput> = {}): ItemInput {
  return { id: 'i1', kind: 'goods', ncm: '61091000', origin: 0, quantity: '1', unitPrice: '100.00', ...over };
}

type Over = Omit<Partial<FiscalOperationInput>, 'issuer' | 'recipient' | 'tables'> & {
  issuer?: Partial<FiscalOperationInput['issuer']>;
  recipient?: Partial<FiscalOperationInput['recipient']>;
  tables?: Partial<FiscalOperationInput['tables']>;
};

export function op(over: Over = {}): FiscalOperationInput {
  const date = over.date ?? '2026-10-01';
  return {
    date,
    issuer: { uf: 'PE', cityIbge: '2611606', regime: 'simples_nacional', ...over.issuer },
    recipient: { uf: 'PE', cityIbge: '2611606', ieIndicator: 9, finalConsumer: true, ...over.recipient },
    operation: over.operation ?? VENDA,
    header: over.header,
    items: over.items ?? [item()],
    rules: over.rules ?? [],
    tables: {
      icmsInternalRates: REFERENCE_ICMS_INTERNAL_RATES,
      transition: transitionFor(date),
      ibsCbsRates: referenceIbsCbs(date),
      cclasstrib: CCLASSTRIB,
      monophasicNcms: ['2202', '3305'],
      ...over.tables,
    },
  };
}

let n = 0;
export function rule(keys: TaxRule['keys'], result: TaxRule['result'], extra: Partial<TaxRule> = {}): TaxRule {
  n++;
  return { id: `r${n}`, name: extra.name ?? `regra ${n}`, validFrom: '2020-01-01', validTo: null, keys, result, ...extra };
}
