import { D, HUNDRED, ZERO, roundMoney, round, sum, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { currentCost } from '../catalog/pricing.js';
import { getOrCreateLot, postMovement, releaseReservations, reserve, reverseMovement } from '../inventory/stock.js';
import { postEvent } from '../accounting/posting.js';

const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ ficha técnica

/** Custo do insumo: médio do estabelecimento ou, sem ele, médio ponderado da empresa. */
async function costOf(tx: Tx, establishmentId: string | null, productId: string): Promise<Decimal> {
  if (establishmentId) return currentCost(tx, establishmentId, productId);
  const r = await tx.maybeOne<{ v: string | null }>(`SELECT sum(quantity * avg_cost) / nullif(sum(quantity), 0) AS v FROM inventory.product_costs WHERE product_id = $1 AND quantity > 0`, [productId]);
  return r?.v && D(r.v).greaterThan(0) ? D(r.v) : currentCost(tx, null, productId);
}

export interface BomInput {
  productId: string;
  validFrom: string;
  yieldQuantity?: string;
  simpleMode?: boolean;
  laborCostPerUnit?: string;
  overheadPercent?: string;
  notes?: string | null;
  items: { componentId: string; quantity: string; lossPercent?: string; notes?: string | null }[];
}

/** Nova versão da ficha técnica; a anterior passa a valer até a véspera. */
export async function createBom(tx: Tx, input: BomInput) {
  const p = await tx.one<{ kind: string; is_variant_parent: boolean }>(`SELECT kind, is_variant_parent FROM catalog.products WHERE id = $1`, [input.productId], 'Produto');
  if (p.is_variant_parent) throw validation({ productId: 'Ficha técnica é da variação (SKU), não do produto pai' });
  if (input.items.some((i) => i.componentId === input.productId)) throw validation({ items: 'O produto não pode ser insumo dele mesmo' });
  if (new Set(input.items.map((i) => i.componentId)).size !== input.items.length) throw validation({ items: 'Insumo repetido na ficha' });
  const last = await tx.maybeOne<{ id: string; version: number; valid_from: string }>(
    `SELECT id, version, valid_from::text FROM production.boms WHERE product_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE`, [input.productId]);
  if (last && input.validFrom <= last.valid_from) throw validation({ validFrom: `A nova versão precisa começar depois de ${last.valid_from}` });
  if (last) {
    await tx.exec(`UPDATE production.boms SET valid_to = ($2::date - 1) WHERE product_id = $1 AND (valid_to IS NULL OR valid_to >= $2)`, [input.productId, input.validFrom]);
  }
  const bom = await tx.one<{ id: string }>(
    `INSERT INTO production.boms (tenant_id, product_id, version, valid_from, yield_quantity, simple_mode, labor_cost_per_unit, overhead_percent, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [tx.tenantId, input.productId, (last?.version ?? 0) + 1, input.validFrom, input.yieldQuantity ?? '1', input.simpleMode ?? false, input.laborCostPerUnit ?? '0',
      input.overheadPercent ?? '0', input.notes ?? null, tx.userId]);
  for (const it of input.items) {
    await tx.one(`SELECT 1 FROM catalog.products WHERE id = $1`, [it.componentId], 'Insumo');
    await tx.exec(`INSERT INTO production.bom_items (tenant_id, bom_id, component_id, quantity, loss_percent, notes) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tx.tenantId, bom.id, it.componentId, it.quantity, it.lossPercent ?? '0', it.notes ?? null]);
  }
  await tx.exec(`UPDATE catalog.products SET own_production = true WHERE id = $1`, [input.productId]);
  return getBom(tx, bom.id);
}

export async function activeBom(tx: Tx, productId: string, date = today()) {
  const b = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM production.boms WHERE product_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2) ORDER BY valid_from DESC, version DESC LIMIT 1`, [productId, date]);
  if (!b) throw ruleViolation('RN-PRD', 'Produto sem ficha técnica vigente na data');
  return b.id;
}

/** Ficha com custo padrão: insumos pelo custo médio + mão de obra + custos indiretos rateados. */
export async function getBom(tx: Tx, id: string, establishmentId: string | null = null) {
  const b = await tx.maybeOne<Record<string, any>>(`SELECT b.*, p.sku, p.description FROM production.boms b JOIN catalog.products p ON p.id = b.product_id WHERE b.id = $1`, [id]);
  if (!b) throw notFound('Ficha técnica');
  const items = await tx.query<Record<string, any>>(
    `SELECT i.*, p.sku, p.description, p.stock_unit FROM production.bom_items i JOIN catalog.products p ON p.id = i.component_id WHERE i.bom_id = $1 ORDER BY p.sku`, [id]);
  let materials = ZERO;
  const lines = [];
  for (const i of items) {
    const perUnit = D(i.quantity).dividedBy(b.yield_quantity).times(D(1).plus(D(i.loss_percent).dividedBy(HUNDRED)));
    const cost = await costOf(tx, establishmentId, i.component_id);
    const value = perUnit.times(cost);
    materials = materials.plus(value);
    lines.push({ ...i, grossPerUnit: round(perUnit, 'quantity').toString(), unitCost: round(cost, 'cost').toString(), costPerUnit: roundMoney(value).toFixed(2) });
  }
  const overhead = materials.times(b.overhead_percent).dividedBy(HUNDRED);
  const standard = materials.plus(b.labor_cost_per_unit).plus(overhead);
  return { ...b, items: lines, standardCost: { materials: round(materials, 'cost').toString(), labor: D(b.labor_cost_per_unit).toString(), overhead: round(overhead, 'cost').toString(),
    unit: round(standard, 'cost').toString() } };
}

/** Necessidade bruta de insumos para produzir uma quantidade (com perda). */
async function requirements(tx: Tx, bomId: string, quantity: string) {
  const b = await tx.one<{ yield_quantity: string }>(`SELECT yield_quantity FROM production.boms WHERE id = $1`, [bomId]);
  const items = await tx.query<{ component_id: string; quantity: string; loss_percent: string }>(`SELECT component_id, quantity, loss_percent FROM production.bom_items WHERE bom_id = $1`, [bomId]);
  return items.map((i) => ({ componentId: i.component_id,
    quantity: round(D(i.quantity).times(quantity).dividedBy(b.yield_quantity).times(D(1).plus(D(i.loss_percent).dividedBy(HUNDRED))), 'quantity') }));
}

// ------------------------------------------------------------------ ordem de produção

export async function createProductionOrder(tx: Tx, input: { productId: string; quantity: string; warehouseId: string; plannedDate?: string | null; lotNumber?: string | null }) {
  const wh = await tx.one<{ company_id: string; establishment_id: string }>(`SELECT company_id, establishment_id FROM core.warehouses WHERE id = $1`, [input.warehouseId], 'Depósito');
  const bomId = await activeBom(tx, input.productId, input.plannedDate ?? today());
  const bom = await getBom(tx, bomId, wh.establishment_id);
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'production_order') AS n`, [wh.company_id])).n;
  const o = await tx.one<{ id: string }>(
    `INSERT INTO production.orders (tenant_id, company_id, establishment_id, warehouse_id, number, product_id, bom_id, quantity_planned, planned_date, lot_number, standard_unit_cost, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [tx.tenantId, wh.company_id, wh.establishment_id, input.warehouseId, number, input.productId, bomId, input.quantity, input.plannedDate ?? null, input.lotNumber ?? null,
      bom.standardCost.unit, tx.userId]);
  for (const r of await requirements(tx, bomId, input.quantity)) {
    const line = bom.items.find((i: any) => i.component_id === r.componentId);
    await tx.exec(`INSERT INTO production.order_materials (tenant_id, order_id, component_id, planned_quantity, standard_unit_cost) VALUES ($1,$2,$3,$4,$5)`,
      [tx.tenantId, o.id, r.componentId, r.quantity.toFixed(4), line?.unitCost ?? null]);
  }
  return getProductionOrder(tx, o.id);
}

export async function getProductionOrder(tx: Tx, id: string) {
  const o = await tx.maybeOne<Record<string, any>>(`SELECT o.*, p.sku, p.description FROM production.orders o JOIN catalog.products p ON p.id = o.product_id WHERE o.id = $1`, [id]);
  if (!o) throw notFound('Ordem de produção');
  const materials = await tx.query(`SELECT m.*, p.sku, p.description, p.stock_unit FROM production.order_materials m JOIN catalog.products p ON p.id = m.component_id
                                     WHERE m.order_id = $1 ORDER BY p.sku`, [id]);
  const variance = o.real_unit_cost && o.standard_unit_cost ? D(o.real_unit_cost).minus(o.standard_unit_cost) : null;
  return { ...o, materials, variance: variance ? { unit: round(variance, 'cost').toString(), percent: D(o.standard_unit_cost).isZero() ? null : variance.dividedBy(o.standard_unit_cost).times(100).toFixed(2) } : null };
}

async function lockOrder(tx: Tx, id: string, allowed: string[]) {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM production.orders WHERE id = $1 FOR UPDATE`, [id], 'Ordem de produção');
  if (!allowed.includes(o.status)) throw conflict('INVALID_STATUS', `Ordem em situação "${o.status}"`);
  return o;
}

/** Libera a ordem reservando os insumos (disponível = físico − reservado). */
export async function releaseProductionOrder(tx: Tx, id: string) {
  const o = await lockOrder(tx, id, ['planned']);
  const mats = await tx.query<{ id: string; component_id: string; planned_quantity: string }>(`SELECT id, component_id, planned_quantity FROM production.order_materials WHERE order_id = $1`, [id]);
  for (const m of mats) {
    await reserve(tx, { warehouseId: o.warehouse_id, productId: m.component_id, quantity: m.planned_quantity, sourceType: 'production_order', sourceId: id, sourceItemId: m.id });
  }
  await tx.exec(`UPDATE production.orders SET status = 'released' WHERE id = $1`, [id]);
  return getProductionOrder(tx, id);
}

/** Apontamento do consumo real de insumos (pode ser maior ou menor que o previsto). */
export async function consumeMaterials(tx: Tx, id: string, lines: { componentId: string; quantity: string; lotId?: string | null }[]) {
  const o = await lockOrder(tx, id, ['released', 'in_progress']);
  for (const l of lines) {
    let m = await tx.maybeOne<{ id: string }>(`SELECT id FROM production.order_materials WHERE order_id = $1 AND component_id = $2`, [id, l.componentId]);
    // Insumo fora da ficha (substituição) entra como material não previsto
    m ??= await tx.one<{ id: string }>(`INSERT INTO production.order_materials (tenant_id, order_id, component_id, planned_quantity) VALUES ($1,$2,$3,0) RETURNING id`, [tx.tenantId, id, l.componentId]);
    const res = await tx.maybeOne<{ id: string }>(`SELECT id FROM inventory.reservations WHERE source_type = 'production_order' AND source_id = $1 AND source_item_id = $2 AND status = 'active'`, [id, m.id]);
    const mv = await postMovement(tx, { warehouseId: o.warehouse_id, productId: l.componentId, lotId: l.lotId ?? null, type: 'production_consume', quantity: l.quantity,
      sourceType: 'production_order', sourceId: id, sourceItemId: m.id, consumeReservationId: res?.id ?? null });
    await tx.exec(`UPDATE production.order_materials SET consumed_quantity = consumed_quantity + $2, consumed_cost = consumed_cost + $3 WHERE id = $1`,
      [m.id, l.quantity, mv?.total_cost ?? '0']);
  }
  await tx.exec(`UPDATE production.orders SET status = 'in_progress', started_at = coalesce(started_at, now()) WHERE id = $1`, [id]);
  return getProductionOrder(tx, id);
}

/**
 * Encerramento: apontamento do produzido de fato e das perdas; o que não foi apontado é
 * consumido pelo previsto (baixa por explosão, se pedido); entra o acabado no lote com o
 * custo real (insumos + mão de obra + indiretos) e a comparação com o padrão.
 */
export async function closeProductionOrder(tx: Tx, id: string, input: { producedQuantity: string; lostQuantity?: string; backflush?: boolean; lotNumber?: string | null;
  expiresAt?: string | null }) {
  const o = await lockOrder(tx, id, ['released', 'in_progress']);
  if (D(input.producedQuantity).lessThanOrEqualTo(0)) throw validation({ producedQuantity: 'Informe a quantidade produzida' });
  if (input.backflush !== false) {
    const pending = await tx.query<{ component_id: string; planned_quantity: string; consumed_quantity: string }>(
      `SELECT component_id, planned_quantity, consumed_quantity FROM production.order_materials WHERE order_id = $1 AND planned_quantity > consumed_quantity`, [id]);
    // Baixa pelo previsto proporcional ao que foi produzido + perdido
    const ratio = D(input.producedQuantity).plus(input.lostQuantity ?? 0).dividedBy(o.quantity_planned);
    const lines = pending.map((p) => ({ componentId: p.component_id, quantity: round(D(p.planned_quantity).times(ratio).minus(p.consumed_quantity), 'quantity') }))
      .filter((l) => l.quantity.greaterThan(0)).map((l) => ({ componentId: l.componentId, quantity: l.quantity.toFixed(4) }));
    if (lines.length) await consumeMaterials(tx, id, lines);
  }
  await releaseReservations(tx, { sourceType: 'production_order', sourceId: id });
  const mats = await tx.query<{ consumed_cost: string }>(`SELECT consumed_cost FROM production.order_materials WHERE order_id = $1`, [id]);
  const bom = await tx.one<{ labor_cost_per_unit: string; overhead_percent: string }>(`SELECT labor_cost_per_unit, overhead_percent FROM production.boms WHERE id = $1`, [o.bom_id]);
  const materials = sum(mats.map((m) => m.consumed_cost));
  const labor = roundMoney(D(bom.labor_cost_per_unit).times(input.producedQuantity));
  const overhead = roundMoney(materials.times(bom.overhead_percent).dividedBy(HUNDRED));
  const total = materials.plus(labor).plus(overhead);
  const unit = round(total.dividedBy(input.producedQuantity), 'cost');
  const p = await tx.one<{ controls_lot: boolean }>(`SELECT controls_lot FROM catalog.products WHERE id = $1`, [o.product_id]);
  const lotNumber = input.lotNumber ?? o.lot_number ?? (p.controls_lot ? `OP${o.number}` : null);
  const lotId = lotNumber && p.controls_lot ? await getOrCreateLot(tx, o.product_id, lotNumber, { expiresAt: input.expiresAt ?? null }) : null;
  const mv = await postMovement(tx, { warehouseId: o.warehouse_id, productId: o.product_id, lotId, type: 'production_output', quantity: input.producedQuantity, unitCost: unit.toFixed(10),
    sourceType: 'production_order', sourceId: id, idempotencyKey: `op-output:${id}` });
  // A diferença entre o custo do movimento (arredondado) e o total vai junto da mão de obra/indiretos
  const absorbed = D(mv?.total_cost ?? total).minus(materials);
  if (!absorbed.isZero()) {
    await postEvent(tx, { type: 'producao_encerrada', companyId: o.company_id, establishmentId: o.establishment_id, date: today(), description: `OP ${o.number}`, number: String(o.number),
      originType: 'production_order', originId: id, amounts: { absorbed } });
  }
  await tx.exec(
    `UPDATE production.orders SET status = 'closed', quantity_produced = $2, quantity_lost = $3, lot_number = $4, lot_id = $5, real_unit_cost = $6, materials_cost = $7, labor_cost = $8,
            overhead_cost = $9, closed_at = now() WHERE id = $1`,
    [id, input.producedQuantity, input.lostQuantity ?? '0', lotNumber, lotId, unit.toFixed(10), materials.toFixed(2), labor.toFixed(2), overhead.toFixed(2)]);
  return getProductionOrder(tx, id);
}

export async function cancelProductionOrder(tx: Tx, id: string, reason: string) {
  await lockOrder(tx, id, ['planned', 'released', 'in_progress']);
  const moves = await tx.query<{ id: string }>(`SELECT id FROM inventory.stock_movements WHERE source_type = 'production_order' AND source_id = $1 AND reversal_of IS NULL`, [id]);
  for (const m of moves) await reverseMovement(tx, m.id, `OP cancelada: ${reason}`, { idempotencyKey: `op-cancel:${m.id}` });
  await releaseReservations(tx, { sourceType: 'production_order', sourceId: id });
  await tx.exec(`UPDATE production.orders SET status = 'cancelled' WHERE id = $1`, [id]);
  return getProductionOrder(tx, id);
}

// ------------------------------------------------------------------ CMV teórico × real

/**
 * Quanto deveria ter sido consumido (vendas × ficha técnica + ordens encerradas pelo
 * padrão) contra o que saiu de fato do estoque (consumos, perdas e ajustes de inventário).
 */
export async function theoreticalVsReal(tx: Tx, f: { establishmentId: string; from: string; to: string }) {
  const theo = new Map<string, Decimal>();
  const add = (k: string, q: Decimal) => theo.set(k, (theo.get(k) ?? ZERO).plus(q));
  // Vendas de produtos com ficha (qualquer modo), pela versão vigente na data do documento
  const sold = await tx.query<{ product_id: string; qty: string; day: string }>(
    `SELECT i.product_id, sum(coalesce(i.stock_quantity, i.quantity)) AS qty, d.tax_date::text AS day
       FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id
      WHERE d.establishment_id = $1 AND d.direction = 'S' AND d.status = 'autorizada' AND d.purpose = 1 AND d.tax_date BETWEEN $2 AND $3
        AND EXISTS (SELECT 1 FROM production.boms b WHERE b.product_id = i.product_id AND b.simple_mode)
      GROUP BY i.product_id, d.tax_date`, [f.establishmentId, f.from, f.to]);
  for (const s of sold) {
    const bom = await tx.maybeOne<{ id: string }>(`SELECT id FROM production.boms WHERE product_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2) ORDER BY valid_from DESC LIMIT 1`,
      [s.product_id, s.day]);
    if (bom) for (const r of await requirements(tx, bom.id, s.qty)) add(r.componentId, r.quantity);
  }
  const orders = await tx.query<{ bom_id: string; produced: string }>(
    `SELECT bom_id, sum(quantity_produced) AS produced FROM production.orders WHERE establishment_id = $1 AND status = 'closed' AND closed_at::date BETWEEN $2 AND $3 GROUP BY bom_id`,
    [f.establishmentId, f.from, f.to]);
  for (const o of orders) for (const r of await requirements(tx, o.bom_id, o.produced)) add(r.componentId, r.quantity);
  const components = [...new Set([...theo.keys(), ...(await tx.query<{ product_id: string }>(
    `SELECT DISTINCT component_id AS product_id FROM production.bom_items`)).map((x) => x.product_id)])];
  const real = await tx.query<{ product_id: string; consumed: string | null; losses: string | null; adjust: string | null }>(
    `SELECT product_id,
            sum(quantity) FILTER (WHERE movement_type IN ('sale_out','production_consume') AND source_type IN ('fiscal_document','production_order','pdv')) AS consumed,
            sum(quantity) FILTER (WHERE movement_type IN ('loss','damage')) AS losses,
            sum(CASE WHEN movement_type = 'inventory_adjust_out' THEN quantity WHEN movement_type = 'inventory_adjust_in' THEN -quantity ELSE 0 END) AS adjust
       FROM inventory.stock_movements m WHERE establishment_id = $1 AND product_id = ANY($2) AND occurred_at::date BETWEEN $3 AND $4 AND reversal_of IS NULL
        AND NOT EXISTS (SELECT 1 FROM inventory.stock_movements r WHERE r.reversal_of = m.id)
      GROUP BY product_id`, [f.establishmentId, components, f.from, f.to]);
  const out = [];
  let totalTheo = ZERO;
  let totalReal = ZERO;
  for (const id of components) {
    const r = real.find((x) => x.product_id === id);
    const t = theo.get(id) ?? ZERO;
    const realQty = D(r?.consumed ?? 0).plus(r?.losses ?? 0).plus(r?.adjust ?? 0);
    if (t.isZero() && realQty.isZero()) continue;
    const cost = await currentCost(tx, f.establishmentId, id);
    const p = await tx.one<{ sku: string; description: string; stock_unit: string }>(`SELECT sku, description, stock_unit FROM catalog.products WHERE id = $1`, [id]);
    const diff = realQty.minus(t);
    totalTheo = totalTheo.plus(t.times(cost));
    totalReal = totalReal.plus(realQty.times(cost));
    out.push({ productId: id, sku: p.sku, description: p.description, unit: p.stock_unit, theoretical: t.toFixed(4), real: realQty.toFixed(4), losses: D(r?.losses ?? 0).toFixed(4),
      inventoryAdjust: D(r?.adjust ?? 0).toFixed(4), difference: diff.toFixed(4), differenceValue: roundMoney(diff.times(cost)).toFixed(2),
      differencePercent: t.isZero() ? null : diff.dividedBy(t).times(100).toFixed(2) });
  }
  return { rows: out.sort((a, b) => D(b.differenceValue).abs().comparedTo(D(a.differenceValue).abs())),
    totals: { theoretical: roundMoney(totalTheo).toFixed(2), real: roundMoney(totalReal).toFixed(2), difference: roundMoney(totalReal.minus(totalTheo)).toFixed(2) } };
}
