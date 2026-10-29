import { D, ZERO, max, roundMoney } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { createDraft } from './runtime.js';

const WEEK = 7 * 86_400_000;
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 1];

/**
 * Projeção semanal: média móvel ponderada das últimas 8 semanas (as recentes pesam mais),
 * ajustada pela sazonalidade do mesmo período do ano anterior. `weeks[0]` é a última semana
 * completa; a série precisa de 60+ semanas para usar a sazonalidade.
 */
export function weeklyForecast(weeks: number[], horizonWeeks: number): { base: number; seasonality: number } {
  const recent = WEIGHTS.map((w, i) => ({ w, v: weeks[i] ?? 0 }));
  const base = recent.reduce((a, x) => a + x.w * x.v, 0) / WEIGHTS.reduce((a, w) => a + w, 0);
  let seasonality = 1;
  if (weeks.length >= 60) {
    // Ano passado: as semanas equivalentes ao horizonte × as 8 semanas anteriores a elas
    const ahead = weeks.slice(Math.max(0, 52 - horizonWeeks), 52);
    const before = weeks.slice(52, 60);
    const a = ahead.reduce((s, v) => s + v, 0) / Math.max(1, ahead.length);
    const b = before.reduce((s, v) => s + v, 0) / before.length;
    if (a > 0 && b > 0) seasonality = Math.min(3, Math.max(0.5, a / b));
  }
  return { base, seasonality };
}

/**
 * Previsão de demanda (seção 20, V2): projeta as vendas de cada produto do depósito considerando
 * sazonalidade e promoções e gera a sugestão de compra como rascunho (RN-IA-01).
 */
export async function forecastDemand(tx: Tx, input: { warehouseId: string; horizonDays?: number; promotions?: { productId: string; upliftPercent: string }[] | null }, now = new Date()) {
  const horizon = input.horizonDays ?? 30;
  const horizonWeeks = Math.max(1, Math.round(horizon / 7));
  const wh = await tx.one<{ id: string; establishment_id: string }>(`SELECT id, establishment_id FROM core.warehouses WHERE id = $1`, [input.warehouseId], 'Depósito');
  // Semanas completas (segunda a domingo) antes da semana atual
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((now.getUTCDay() + 6) % 7) * 86_400_000);
  const since = new Date(weekStart.getTime() - 64 * WEEK);
  const sales = await tx.query<{ product_id: string; wk: number; qty: string }>(
    `SELECT product_id, floor(extract(epoch FROM ($2::timestamptz - occurred_at)) / 604800)::int AS wk,
            sum(CASE WHEN movement_type = 'sale_out' THEN quantity ELSE -quantity END) AS qty
       FROM inventory.stock_movements WHERE warehouse_id = $1 AND movement_type IN ('sale_out', 'sale_return_in') AND occurred_at >= $3 AND occurred_at < $2
      GROUP BY 1, 2`, [wh.id, weekStart, since]);
  const series = new Map<string, number[]>();
  const firstSale = new Map<string, number>();
  for (const s of sales) {
    const arr = series.get(s.product_id) ?? Array.from({ length: 64 }, () => 0);
    if (s.wk >= 0 && s.wk < 64) arr[s.wk] = Math.max(0, Number(s.qty));
    series.set(s.product_id, arr);
    firstSale.set(s.product_id, Math.max(firstSale.get(s.product_id) ?? 0, s.wk));
  }
  // Promoções do cadastro no horizonte (+30% por padrão, proporcional aos dias) e as informadas
  const horizonEnd = new Date(now.getTime() + horizon * 86_400_000);
  const promos = await tx.query<{ product_ids: string[]; starts_at: Date; ends_at: Date }>(
    `SELECT product_ids, starts_at, ends_at FROM catalog.promotions WHERE active AND starts_at < $2 AND ends_at > $1 AND cardinality(product_ids) > 0`, [now, horizonEnd]);
  const uplift = new Map<string, number>();
  for (const p of promos) {
    const overlap = (Math.min(p.ends_at.getTime(), horizonEnd.getTime()) - Math.max(p.starts_at.getTime(), now.getTime())) / (horizon * 86_400_000);
    for (const id of p.product_ids) uplift.set(id, (uplift.get(id) ?? 0) + 0.3 * Math.max(0, overlap));
  }
  for (const p of input.promotions ?? []) uplift.set(p.productId, Number(p.upliftPercent) / 100);

  const products = await tx.query<{ id: string; sku: string; description: string; available: string | null; on_order: string | null; supplier_id: string | null; supplier_name: string | null;
    lead_time_days: number | null; min_lot: string | null; last_price: string | null }>(
    `SELECT p.id, p.sku, p.description,
            (SELECT sum(quantity - reserved - blocked) FROM inventory.stock_balances b WHERE b.warehouse_id = $1 AND b.product_id = p.id) AS available,
            (SELECT sum(i.quantity - i.quantity_received - i.quantity_cancelled) FROM purchasing.order_items i JOIN purchasing.orders o ON o.id = i.order_id
              WHERE o.warehouse_id = $1 AND i.product_id = p.id AND o.status IN ('draft','pending_approval','approved','partially_received')) AS on_order,
            ps.supplier_id, sup.legal_name AS supplier_name, ps.lead_time_days, ps.min_lot, ps.last_price
       FROM catalog.products p
       LEFT JOIN LATERAL (SELECT * FROM catalog.product_suppliers x WHERE x.product_id = p.id ORDER BY x.last_purchase_at DESC NULLS LAST LIMIT 1) ps ON true
       LEFT JOIN registry.parties sup ON sup.id = ps.supplier_id
      WHERE p.id = ANY($2) AND p.status = 'active' AND p.controls_stock`, [wh.id, [...series.keys()]]);
  const items = [];
  for (const p of products) {
    const weeks = series.get(p.id)!;
    // Série curta: só considera as semanas desde a primeira venda
    const history = weeks.slice(0, (firstSale.get(p.id) ?? 0) + 1);
    const f = weeklyForecast(history.length >= 8 ? history : [...history, ...Array.from({ length: 8 - history.length }, () => history.reduce((a, v) => a + v, 0) / history.length)], horizonWeeks);
    const up = uplift.get(p.id) ?? 0;
    const lead = p.lead_time_days ?? 7;
    const weekly = f.base * f.seasonality * (1 + up);
    const demand = D(weekly).times(horizon + lead).dividedBy(7);
    const safety = D(weekly);
    const available = D(p.available ?? 0);
    const onOrder = D(p.on_order ?? 0);
    let qty = demand.plus(safety).minus(available.plus(onOrder));
    if (qty.lessThanOrEqualTo(0)) continue;
    if (p.min_lot && D(p.min_lot).greaterThan(0)) qty = max(qty.dividedBy(p.min_lot).ceil().times(p.min_lot), D(p.min_lot));
    qty = qty.ceil();
    items.push({
      productId: p.id, sku: p.sku, description: p.description, weeklyBase: D(f.base).toFixed(4), seasonality: D(f.seasonality).toFixed(4), promotionUplift: D(up).times(100).toFixed(2),
      forecast: D(weekly).times(horizon).dividedBy(7).toFixed(4), leadTimeDays: lead, available: available.toFixed(4), onOrder: onOrder.toFixed(4), suggestedQuantity: qty.toFixed(4),
      supplierId: p.supplier_id, supplierName: p.supplier_name, lastPrice: p.last_price, estimatedTotal: p.last_price ? roundMoney(qty.times(p.last_price)).toFixed(2) : null,
    });
  }
  items.sort((a, b) => (a.supplierName ?? '').localeCompare(b.supplierName ?? '') || a.sku.localeCompare(b.sku));
  const total = items.reduce((a, i) => a.plus(i.estimatedTotal ?? 0), ZERO);
  if (!items.length) return { draft: null, items };
  const draft = await createDraft(tx, {
    kind: 'purchase_suggestion', source: 'rules', confidence: null,
    title: `Sugestão de compra (${horizon} dias): ${items.length} item(ns) · R$ ${total.toFixed(2).replace('.', ',')}`,
    payload: { warehouseId: wh.id, establishmentId: wh.establishment_id, horizonDays: horizon, generatedAt: now.toISOString(), items },
  });
  return { draft, items };
}
