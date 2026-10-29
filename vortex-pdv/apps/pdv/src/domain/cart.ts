import { D, HUNDRED, ZERO, allocate, roundMoney, sum, type Decimal } from '@vortex/money';
import { invalid } from './errors.js';

/**
 * Cálculo do carrinho (seções 8, 11 e 13): bruto por item, desconto do item, desconto da
 * venda rateado pelos itens (maior resto, a soma fecha) e total. Puro e determinístico.
 */
export interface DiscountSpec {
  kind: 'percent' | 'value';
  value: string;
}

export interface CartLine {
  id: string;
  quantity: string;
  unitPrice: string;
  manualDiscount: DiscountSpec | null;
  status: 'active' | 'cancelled';
}

export interface LineTotals {
  id: string;
  gross: string;
  itemDiscount: string;
  saleDiscountShare: string;
  discount: string;
  total: string;
}

export interface CartTotals {
  lines: LineTotals[];
  subtotal: string;
  itemDiscounts: string;
  saleDiscount: string;
  discountTotal: string;
  total: string;
  itemCount: number;
}

export function discountAmount(spec: DiscountSpec | null, base: Decimal): Decimal {
  if (!spec || base.lessThanOrEqualTo(0)) return ZERO;
  const v = D(spec.value);
  if (v.isNegative()) throw invalid('Desconto não pode ser negativo');
  if (spec.kind === 'percent') {
    if (v.greaterThan(100)) throw invalid('Desconto acima de 100%');
    return roundMoney(base.times(v).dividedBy(HUNDRED));
  }
  if (v.greaterThan(base)) throw invalid(`Desconto (R$ ${v.toFixed(2)}) maior que o valor (R$ ${base.toFixed(2)})`);
  return roundMoney(v);
}

/** Percentual efetivo de um desconto sobre a base (para comparar com a alçada do operador). */
export function effectivePercent(amount: Decimal, base: Decimal): Decimal {
  return base.isZero() ? ZERO : amount.dividedBy(base).times(HUNDRED);
}

export function lineGross(quantity: string, unitPrice: string): Decimal {
  return roundMoney(D(quantity).times(unitPrice));
}

export function computeTotals(lines: CartLine[], saleDiscount: DiscountSpec | null): CartTotals {
  const active = lines.filter((l) => l.status === 'active');
  const prelim = active.map((l) => {
    const gross = lineGross(l.quantity, l.unitPrice);
    const itemDiscount = discountAmount(l.manualDiscount, gross);
    return { id: l.id, gross, itemDiscount, net: gross.minus(itemDiscount) };
  });
  const base = sum(prelim.map((p) => p.net));
  const saleDisc = discountAmount(saleDiscount, base);
  const shares = prelim.length ? allocate(saleDisc, prelim.map((p) => p.net)) : [];
  const out: LineTotals[] = prelim.map((p, i) => {
    const share = shares[i] ?? ZERO;
    const discount = p.itemDiscount.plus(share);
    return { id: p.id, gross: p.gross.toFixed(2), itemDiscount: p.itemDiscount.toFixed(2), saleDiscountShare: share.toFixed(2), discount: discount.toFixed(2), total: p.gross.minus(discount).toFixed(2) };
  });
  const subtotal = sum(prelim.map((p) => p.gross));
  const itemDiscounts = sum(prelim.map((p) => p.itemDiscount));
  return {
    lines: out, subtotal: subtotal.toFixed(2), itemDiscounts: itemDiscounts.toFixed(2), saleDiscount: saleDisc.toFixed(2),
    discountTotal: itemDiscounts.plus(saleDisc).toFixed(2), total: subtotal.minus(itemDiscounts).minus(saleDisc).toFixed(2), itemCount: active.length,
  };
}

/** Base do desconto da venda (líquido dos descontos de item). */
export function saleDiscountBase(lines: CartLine[]): Decimal {
  return sum(lines.filter((l) => l.status === 'active').map((l) => {
    const g = lineGross(l.quantity, l.unitPrice);
    return g.minus(discountAmount(l.manualDiscount, g));
  }));
}

