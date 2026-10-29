import { D, ZERO, roundMoney, roundUnit, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError, ruleViolation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { ibsCbsRatesFor } from '../fiscal/engine-adapter.js';
import { bestPromotion, marginPercent, promotionRuleSchema, type PromotionCandidate } from './pricing-core.js';

export interface PriceQuery {
  productId: string;
  customerId?: string | null;
  channel?: string | null;
  establishmentId?: string | null;
  qty?: string;
  at?: Date;
}

export interface PriceQuote {
  productId: string;
  priceListId: string | null;
  priceListCode: string | null;
  level: 'customer' | 'segment' | 'channel' | 'default' | 'none';
  basePrice: string;
  unitPrice: string;
  promotions: { id: string; name: string }[];
  includesIbsCbs: boolean;
}

/**
 * RN-PRE-01: prioridade de busca — preço do cliente → tabela do segmento →
 * tabela do canal → tabela padrão. Variação sem preço próprio herda o do pai.
 */
export async function quotePrice(tx: Tx, q: PriceQuery): Promise<PriceQuote> {
  const at = q.at ?? new Date();
  const date = at.toISOString().slice(0, 10);
  const qty = D(q.qty ?? '1');
  const product = await tx.one<{ id: string; parent_id: string | null; category_id: string | null }>(
    `SELECT id, parent_id, category_id FROM catalog.products WHERE id = $1`, [q.productId], 'Produto');
  const party = q.customerId
    ? await tx.maybeOne<{ price_list_id: string | null; segment: string | null }>(`SELECT price_list_id, segment FROM registry.parties WHERE id = $1`, [q.customerId])
    : null;
  const lists = await tx.query<{ id: string; code: string; customer_id: string | null; segment: string | null; channels: string[]; is_default: boolean; includes_ibs_cbs: boolean }>(
    `SELECT id, code, customer_id, segment, channels, is_default, includes_ibs_cbs FROM catalog.price_lists
      WHERE active AND valid_from <= $1::date AND (valid_to IS NULL OR valid_to >= $1::date)
        AND (cardinality(establishment_ids) = 0 OR $2::uuid = ANY(establishment_ids))`,
    [date, q.establishmentId ?? null]);
  const levels: [PriceQuote['level'], typeof lists][] = [
    ['customer', lists.filter((l) => (q.customerId && l.customer_id === q.customerId) || (party?.price_list_id && l.id === party.price_list_id))],
    ['segment', lists.filter((l) => party?.segment && l.segment === party.segment && !l.customer_id)],
    ['channel', lists.filter((l) => q.channel && l.channels.includes(q.channel) && !l.customer_id && !l.segment)],
    ['default', lists.filter((l) => l.is_default)],
  ];
  const productIds = [product.id, ...(product.parent_id ? [product.parent_id] : [])];
  for (const [level, cands] of levels) {
    if (!cands.length) continue;
    const item = await tx.maybeOne<{ price: string; price_list_id: string }>(
      `SELECT price, price_list_id FROM catalog.price_list_items
        WHERE price_list_id = ANY($1) AND product_id = ANY($2) AND min_qty <= $3
        ORDER BY (product_id = $4) DESC, min_qty DESC, price ASC LIMIT 1`,
      [cands.map((c) => c.id), productIds, qty.toString(), product.id]);
    if (!item) continue;
    const list = cands.find((c) => c.id === item.price_list_id)!;
    const base = D(item.price);
    const promos = await activePromotions(tx, { productIds, categoryId: product.category_id, channel: q.channel ?? null, establishmentId: q.establishmentId ?? null, at });
    const best = bestPromotion(base, qty, promos);
    return {
      productId: product.id, priceListId: list.id, priceListCode: list.code, level, basePrice: roundUnit(base).toString(),
      unitPrice: best.unitPrice.toString(), promotions: best.applied, includesIbsCbs: list.includes_ibs_cbs,
    };
  }
  return { productId: product.id, priceListId: null, priceListCode: null, level: 'none', basePrice: '0', unitPrice: '0', promotions: [], includesIbsCbs: false };
}

async function activePromotions(tx: Tx, f: { productIds: string[]; categoryId: string | null; channel: string | null; establishmentId: string | null; at: Date }): Promise<PromotionCandidate[]> {
  const rows = await tx.query<{ id: string; name: string; rule: unknown; cumulative: boolean; max_quantity: string | null; used_quantity: string }>(
    `SELECT id, name, rule, cumulative, max_quantity, used_quantity FROM catalog.promotions
      WHERE active AND starts_at <= $1 AND ends_at > $1
        AND ((cardinality(product_ids) = 0 AND cardinality(category_ids) = 0) OR product_ids && $2::uuid[] OR ($3::uuid IS NOT NULL AND $3::uuid = ANY(category_ids)))
        AND (cardinality(channels) = 0 OR $4::text = ANY(channels))
        AND (cardinality(establishment_ids) = 0 OR $5::uuid = ANY(establishment_ids))`,
    [f.at, f.productIds, f.categoryId, f.channel, f.establishmentId]);
  return rows.map((r) => ({
    id: r.id, name: r.name, rule: promotionRuleSchema.parse(r.rule), cumulative: r.cumulative,
    remaining: r.max_quantity === null ? null : D(r.max_quantity).minus(r.used_quantity),
  }));
}

/** Consome o limite de quantidade das promoções usadas (no faturamento). */
export async function consumePromotions(tx: Tx, promotionIds: string[], qty: string): Promise<void> {
  for (const id of promotionIds) {
    const ok = await tx.maybeOne(
      `UPDATE catalog.promotions SET used_quantity = used_quantity + $2 WHERE id = $1 AND (max_quantity IS NULL OR used_quantity + $2 <= max_quantity) RETURNING id`, [id, qty]);
    if (!ok) throw ruleViolation('RN-PRE-02', 'Limite de quantidade da promoção esgotado');
  }
}

/** Custo atual do produto no estabelecimento (custo médio; na falta, último custo de compra). */
export async function currentCost(tx: Tx, establishmentId: string | null, productId: string): Promise<Decimal> {
  if (establishmentId) {
    const c = await tx.maybeOne<{ avg_cost: string }>(`SELECT avg_cost FROM inventory.product_costs WHERE establishment_id = $1 AND product_id = $2`, [establishmentId, productId]);
    if (c && D(c.avg_cost).greaterThan(0)) return D(c.avg_cost);
  }
  const p = await tx.one<{ last_purchase_cost: string; standard_cost: string }>(`SELECT last_purchase_cost, standard_cost FROM catalog.products WHERE id = $1`, [productId]);
  return D(p.last_purchase_cost).greaterThan(0) ? D(p.last_purchase_cost) : D(p.standard_cost);
}

export interface MarginCheck {
  productId: string;
  unitPrice: string;
  cost: string;
  marginPercent: string;
  minMarginPercent: string | null;
  belowCost: boolean;
  belowMinMargin: boolean;
}

/** RN-PRE-03: venda abaixo do custo ou da margem mínima exige aprovação por alçada. */
export async function checkMargin(tx: Tx, establishmentId: string | null, productId: string, unitPrice: string): Promise<MarginCheck> {
  const cost = await currentCost(tx, establishmentId, productId);
  const p = await tx.one<{ min_margin_percent: string | null; cat_margin: string | null }>(
    `SELECT p.min_margin_percent, c.min_margin_percent AS cat_margin FROM catalog.products p LEFT JOIN catalog.categories c ON c.id = p.category_id WHERE p.id = $1`, [productId]);
  const minMargin = p.min_margin_percent ?? p.cat_margin;
  const price = D(unitPrice);
  const margin = marginPercent(price, cost);
  return {
    productId, unitPrice, cost: roundUnit(cost).toString(), marginPercent: margin.toDecimalPlaces(2).toString(), minMarginPercent: minMargin,
    belowCost: cost.greaterThan(0) && price.lessThan(cost),
    belowMinMargin: minMargin !== null && cost.greaterThan(0) && margin.lessThan(D(minMargin)),
  };
}

/** RN-PRE-04: altera o preço agora (gera histórico) ou agenda para data futura. */
export async function setPrice(tx: Tx, input: { priceListId: string; productId: string; price: string; minQty?: string; effectiveAt?: string | null; reason?: string | null }) {
  const minQty = input.minQty ?? '0';
  if (D(input.price).isNegative()) throw new AppError('VALIDATION', 'Preço não pode ser negativo', 422);
  if (input.effectiveAt && new Date(input.effectiveAt).getTime() > Date.now()) {
    const row = await tx.one(
      `INSERT INTO catalog.scheduled_price_changes (tenant_id, price_list_id, product_id, min_qty, new_price, effective_at, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tx.tenantId, input.priceListId, input.productId, minQty, input.price, input.effectiveAt, input.reason ?? null, tx.userId]);
    return { scheduled: true, change: row };
  }
  return { scheduled: false, item: await applyPrice(tx, input.priceListId, input.productId, minQty, input.price, input.reason ?? null, null) };
}

export async function applyPrice(tx: Tx, priceListId: string, productId: string, minQty: string, price: string, reason: string | null, scheduledId: string | null) {
  const cur = await tx.maybeOne<{ price: string }>(
    `SELECT price FROM catalog.price_list_items WHERE price_list_id = $1 AND product_id = $2 AND min_qty = $3 FOR UPDATE`, [priceListId, productId, minQty]);
  if (cur && D(cur.price).equals(D(price))) return cur;
  const item = await tx.one(
    `INSERT INTO catalog.price_list_items (tenant_id, price_list_id, product_id, price, min_qty, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (price_list_id, product_id, min_qty) DO UPDATE SET price = EXCLUDED.price RETURNING *`,
    [tx.tenantId, priceListId, productId, price, minQty, tx.userId]);
  await tx.exec(
    `INSERT INTO catalog.price_history (tenant_id, price_list_id, product_id, min_qty, old_price, new_price, reason, changed_by, scheduled_change_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [tx.tenantId, priceListId, productId, minQty, cur?.price ?? null, price, reason, tx.userId, scheduledId]);
  await emit(tx, 'preco.alterado', { type: 'product', id: productId }, { productId, priceListId, oldPrice: cur?.price ?? null, newPrice: price });
  return item;
}

/** Job: aplica alterações de preço agendadas que venceram. */
export async function applyDuePriceChanges(tx: Tx): Promise<number> {
  const due = await tx.query<{ id: string; price_list_id: string; product_id: string; min_qty: string; new_price: string; reason: string | null }>(
    `SELECT id, price_list_id, product_id, min_qty, new_price, reason FROM catalog.scheduled_price_changes
      WHERE status = 'pending' AND effective_at <= now() ORDER BY effective_at FOR UPDATE SKIP LOCKED`);
  for (const c of due) {
    await applyPrice(tx, c.price_list_id, c.product_id, c.min_qty, c.new_price, c.reason ?? 'Alteração agendada', c.id);
    await tx.exec(`UPDATE catalog.scheduled_price_changes SET status = 'applied', applied_at = now() WHERE id = $1`, [c.id]);
  }
  return due.length;
}

export function lineTotal(unitPrice: string, qty: string): string {
  return roundMoney(D(unitPrice).times(qty)).toFixed(2);
}

export { ZERO };

/**
 * RN-REF-05: IBS e CBS são calculados por fora; o preço é exibido com e sem os novos tributos. A
 * tabela de preço diz se o preço cadastrado já os inclui (cheio) ou não (líquido). Em 2026 os
 * valores são informativos (alíquotas de teste), mas o cálculo já é o definitivo.
 */
export async function priceWithAndWithoutNewTaxes(tx: Tx, quote: PriceQuote, establishmentId: string | null, date = new Date().toISOString().slice(0, 10)) {
  const est = establishmentId
    ? await tx.maybeOne<{ uf: string; city_ibge: string }>(`SELECT uf, city_ibge FROM core.establishments WHERE id = $1`, [establishmentId])
    : await tx.maybeOne<{ uf: string; city_ibge: string }>(`SELECT uf, city_ibge FROM core.establishments ORDER BY created_at LIMIT 1`);
  const rates = await ibsCbsRatesFor(tx, date, est?.uf ?? null, est?.city_ibge ?? null);
  const rate = rates ? D(rates.cbs).plus(rates.ibsUf).plus(rates.ibsMun) : D(0);
  const price = D(quote.unitPrice);
  const without = quote.includesIbsCbs ? price.dividedBy(D(1).plus(rate.dividedBy(100))) : price;
  const withTaxes = quote.includesIbsCbs ? price : without.times(D(1).plus(rate.dividedBy(100)));
  return { ratePercent: rate.toFixed(4), withoutIbsCbs: roundMoney(without).toFixed(2), withIbsCbs: roundMoney(withTaxes).toFixed(2), listIncludesIbsCbs: quote.includesIbsCbs };
}
