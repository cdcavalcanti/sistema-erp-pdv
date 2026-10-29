import { calculate, type FiscalResult } from '@vortex/fiscal-engine';
import { D } from '@vortex/money';
import { PdvError } from '../domain/errors.js';

/**
 * Tributos da NFC-e calculados no terminal com o mesmo motor fiscal do ERP
 * (@vortex/fiscal-engine) e o contexto resolvido que o ERP envia na carga (regras, alíquotas
 * vigentes, emitente). Funciona offline; o ERP recalcula ao receber e recusa divergência.
 */
export interface FiscalContext {
  date: string;
  regime: string;
  template: Record<string, any>;
  products: { productId: string; kind: 'goods' | 'service'; ncm: string | null; cest: string | null; origin: number; taxGroup: string | null; cclasstrib: string | null;
    serviceCode: string | null; ownProduction: boolean; taxableFactor: string }[];
}

export interface TaxLine {
  productId: string;
  quantity: string;
  unitPrice: string;
  discount: string;
}

export function computeTaxes(ctx: FiscalContext | null, lines: TaxLine[], date: string): FiscalResult {
  if (!ctx) throw new PdvError('FISCAL_CONFIG', 'Terminal sem contexto fiscal: sincronize com o ERP antes de emitir NFC-e', 422);
  const items = lines.map((l, i) => {
    const attrs = ctx.products.find((p) => p.productId === l.productId);
    if (!attrs) throw new PdvError('FISCAL_CONFIG', `Produto sem dados fiscais no terminal (${l.productId}): sincronize com o ERP`, 422);
    const { taxableFactor, ...rest } = attrs;
    return { ...rest, id: String(i + 1), quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxableQuantity: D(l.quantity).times(taxableFactor ?? '1').toString() };
  });
  try {
    // A data da operação é a da venda; o contexto traz as alíquotas da data em que foi carregado
    return calculate({ ...ctx.template, date, items } as never);
  } catch (e) {
    throw new PdvError('FISCAL_CONFIG', `Configuração fiscal incompleta: ${(e as Error).message}`, 422);
  }
}

/** Valor aproximado dos tributos (Lei 12.741/2012) por item e total. */
export function approximateTaxes(r: FiscalResult): { items: string[]; total: string } {
  const items = r.items.map((i) => {
    const t = i.taxes;
    return D(t.icms.value).plus(t.fcp?.value ?? 0).plus(t.pis.value).plus(t.cofins.value).plus(t.ipi?.value ?? 0).plus(t.iss?.value ?? 0)
      .plus(t.st?.value ?? 0).plus(t.ibsCbs && !t.ibsCbs.informative ? D(t.ibsCbs.ibsValue).plus(t.ibsCbs.cbs.value) : 0).toFixed(2);
  });
  return { items, total: items.reduce((a, x) => a.plus(x), D(0)).toFixed(2) };
}
