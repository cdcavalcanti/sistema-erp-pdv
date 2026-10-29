import { D, ZERO, max, roundMoney, round, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError, notFound, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { enqueue } from '../../core/jobs.js';

export type MovementType =
  | 'opening' | 'purchase_in' | 'sale_out' | 'sale_return_in' | 'purchase_return_out' | 'transfer_out' | 'transfer_in'
  | 'production_consume' | 'production_output' | 'inventory_adjust_in' | 'inventory_adjust_out' | 'loss' | 'damage' | 'internal_use'
  | 'shipment_out' | 'shipment_return_in' | 'third_party_in' | 'third_party_return_out' | 'reversal_in' | 'reversal_out';

/** Sinal de cada tipo de movimento (tabela da seção 12). */
export const MOVEMENT_SIGN: Record<MovementType, 1 | -1> = {
  opening: 1, purchase_in: 1, sale_out: -1, sale_return_in: 1, purchase_return_out: -1, transfer_out: -1, transfer_in: 1,
  production_consume: -1, production_output: 1, inventory_adjust_in: 1, inventory_adjust_out: -1, loss: -1, damage: -1, internal_use: -1,
  shipment_out: -1, shipment_return_in: 1, third_party_in: 1, third_party_return_out: -1, reversal_in: 1, reversal_out: -1,
};

/** Entradas que formam custo médio (custo informado pelo documento de origem). */
const COST_FORMING = new Set<MovementType>(['opening', 'purchase_in', 'production_output']);

export interface MovementInput {
  establishmentId?: string;
  warehouseId: string;
  productId: string;
  lotId?: string | null;
  type: MovementType;
  quantity: string;
  /** Custo unitário: obrigatório nas entradas que formam custo; nas demais, usa o custo médio */
  unitCost?: string | null;
  occurredAt?: Date | string;
  sourceType: string;
  sourceId?: string | null;
  sourceItemId?: string | null;
  reason?: string | null;
  /** RN-GER-07: repetir com a mesma chave nunca duplica a baixa */
  idempotencyKey?: string | null;
  /** Reserva consumida por esta saída (pedido faturado) */
  consumeReservationId?: string | null;
  serials?: string[];
  reversalOf?: string | null;
  /** Ignora o bloqueio de inventário em andamento (o próprio ajuste do inventário) */
  inventoryAdjustment?: boolean;
  /**
   * Saída que já aconteceu e não pode ser recusada (venda do PDV com NFC-e autorizada): aceita
   * saldo negativo, que aparece para regularizar (entrada pendente, inventário) em vez de travar a venda.
   */
  acceptNegative?: boolean;
}

export interface MovementRow {
  id: string;
  occurred_at: string;
  product_id: string;
  quantity: string;
  unit_cost: string;
  total_cost: string;
  avg_cost_after: string;
  sign: number;
  movement_type: MovementType;
}

/**
 * Lança um movimento de estoque (RN-GER-01: o estoque só muda por movimento).
 * Saldo e custo são atualizados na MESMA transação, com bloqueio de linha
 * (SELECT ... FOR UPDATE) para que duas vendas simultâneas do último item nunca
 * gerem saldo negativo indevido (seção 22, decisão importante).
 */
export async function postMovement(tx: Tx, m: MovementInput): Promise<MovementRow | null> {
  const qty = D(m.quantity);
  if (qty.lessThanOrEqualTo(0)) throw validation({ quantity: 'Quantidade deve ser maior que zero' });
  if (m.idempotencyKey) {
    const existing = await tx.maybeOne<{ movement_id: string }>(`SELECT movement_id FROM inventory.movement_keys WHERE key = $1`, [m.idempotencyKey]);
    if (existing) return tx.one<MovementRow>(`SELECT * FROM inventory.stock_movements WHERE id = $1`, [existing.movement_id]);
  }
  const product = await tx.one<{ id: string; sku: string; kind: string; controls_stock: boolean; allow_negative_stock: boolean; controls_lot: boolean; controls_serial: boolean; kit_explodes_stock: boolean; parent_id: string | null; is_variant_parent: boolean }>(
    `SELECT id, sku, kind, controls_stock, allow_negative_stock, controls_lot, controls_serial, kit_explodes_stock, parent_id, is_variant_parent FROM catalog.products WHERE id = $1`, [m.productId], 'Produto');
  if (!product.controls_stock) return null;
  if (product.is_variant_parent) throw validation({ productId: 'Produto pai de grade não tem estoque; movimente a variação (SKU)' });
  if (product.kind === 'kit' && product.kit_explodes_stock) throw validation({ productId: 'Kit baixa os componentes: movimente cada componente' });
  const wh = await tx.one<{ id: string; company_id: string; establishment_id: string; allow_negative: boolean; active: boolean }>(
    `SELECT id, company_id, establishment_id, allow_negative, active FROM core.warehouses WHERE id = $1`, [m.warehouseId], 'Depósito');
  if (m.establishmentId && m.establishmentId !== wh.establishment_id) throw validation({ warehouseId: 'Depósito não pertence ao estabelecimento' });
  const sign = MOVEMENT_SIGN[m.type];
  const occurredAt = m.occurredAt ? new Date(m.occurredAt) : new Date();

  // Lote
  let lotId = m.lotId ?? null;
  if (product.controls_lot && !lotId) throw validation({ lotId: `Produto ${product.sku} controla lote: informe o lote` });
  if (lotId) {
    const lot = await tx.one<{ product_id: string; status: string; expires_at: string | null }>(`SELECT product_id, status, expires_at FROM inventory.lots WHERE id = $1`, [lotId], 'Lote');
    if (lot.product_id !== m.productId) throw validation({ lotId: 'Lote de outro produto' });
    // RN-EST-05: lote vencido é bloqueado para venda automaticamente
    if (sign < 0 && m.type === 'sale_out' && (lot.status !== 'available' || (lot.expires_at && lot.expires_at < occurredAt.toISOString().slice(0, 10)))) {
      throw ruleViolation('RN-EST-05', 'Lote vencido ou bloqueado não pode ser vendido');
    }
  } else if (!product.controls_lot) {
    lotId = null;
  }

  // Inventário em andamento com congelamento por bloqueio
  if (!m.inventoryAdjustment) {
    const frozen = await tx.maybeOne(
      `SELECT i.id FROM inventory.inventories i JOIN inventory.inventory_items it ON it.inventory_id = i.id
        WHERE i.warehouse_id = $1 AND it.product_id = $2 AND i.status IN ('counting','review') AND i.freeze_mode = 'block' LIMIT 1`, [m.warehouseId, m.productId]);
    if (frozen) throw new AppError('INVENTORY_FROZEN', 'Produto em contagem de inventário com movimentação bloqueada', 409, { inventoryId: frozen.id });
  }

  if (m.idempotencyKey) {
    const ins = await tx.maybeOne(`INSERT INTO inventory.movement_keys (tenant_id, key, movement_id) VALUES ($1,$2,gen_random_uuid()) ON CONFLICT DO NOTHING RETURNING key`, [tx.tenantId, m.idempotencyKey]);
    if (!ins) {
      const existing = await tx.one<{ movement_id: string }>(`SELECT movement_id FROM inventory.movement_keys WHERE key = $1`, [m.idempotencyKey]);
      return tx.one<MovementRow>(`SELECT * FROM inventory.stock_movements WHERE id = $1`, [existing.movement_id]);
    }
  }

  // Bloqueio de linha do saldo e do custo
  await tx.exec(
    `INSERT INTO inventory.stock_balances (tenant_id, company_id, establishment_id, warehouse_id, product_id, lot_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [tx.tenantId, wh.company_id, wh.establishment_id, wh.id, m.productId, lotId]);
  const bal = await tx.one<{ quantity: string; reserved: string; blocked: string }>(
    `SELECT quantity, reserved, blocked FROM inventory.stock_balances WHERE warehouse_id = $1 AND product_id = $2 AND lot_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
    [wh.id, m.productId, lotId]);
  await tx.exec(
    `INSERT INTO inventory.product_costs (tenant_id, company_id, establishment_id, product_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [tx.tenantId, wh.company_id, wh.establishment_id, m.productId]);
  const cost = await tx.one<{ quantity: string; avg_cost: string; negative_pending: boolean }>(
    `SELECT quantity, avg_cost, negative_pending FROM inventory.product_costs WHERE establishment_id = $1 AND product_id = $2 FOR UPDATE`, [wh.establishment_id, m.productId]);

  // Reserva consumida
  let releasedReserve = ZERO;
  if (m.consumeReservationId) {
    const res = await tx.maybeOne<{ quantity: string; status: string }>(`SELECT quantity, status FROM inventory.reservations WHERE id = $1 FOR UPDATE`, [m.consumeReservationId]);
    if (res && res.status === 'active') {
      releasedReserve = D(res.quantity).lessThan(qty) ? D(res.quantity) : qty;
      const remaining = D(res.quantity).minus(releasedReserve);
      await tx.exec(`UPDATE inventory.reservations SET quantity = CASE WHEN $2::numeric > 0 THEN $2::numeric ELSE quantity END, status = CASE WHEN $2::numeric > 0 THEN 'active' ELSE 'consumed' END WHERE id = $1`,
        [m.consumeReservationId, remaining.toFixed(4)]);
    }
  }

  const curQty = D(bal.quantity);
  const newQty = curQty.plus(qty.times(sign));
  const allowNegative = product.allow_negative_stock || wh.allow_negative || Boolean(m.acceptNegative);
  if (sign < 0) {
    // Disponível = físico − reservado − bloqueado (RN-EST-01); a própria reserva consumida volta a ficar disponível
    const available = curQty.minus(D(bal.reserved).minus(releasedReserve)).minus(bal.blocked);
    if (!allowNegative && available.lessThan(qty)) {
      // RN-EST-02: estoque negativo é bloqueado por padrão
      throw ruleViolation('RN-EST-02', `Saldo insuficiente de ${product.sku}: disponível ${available.toFixed(4)}, solicitado ${qty.toFixed(4)}`, {
        productId: m.productId, available: available.toFixed(4), requested: qty.toFixed(4),
      });
    }
  }

  // Custo médio ponderado móvel por estabelecimento (RN-EST-03)
  const costQty = D(cost.quantity);
  const avg = D(cost.avg_cost);
  let unitCost: Decimal;
  let newAvg = avg;
  let negativePending = cost.negative_pending;
  let recalcFrom: Date | null = null;
  if (sign > 0) {
    if (COST_FORMING.has(m.type)) {
      if (m.unitCost === undefined || m.unitCost === null) throw validation({ unitCost: 'Custo unitário obrigatório na entrada' });
      unitCost = D(m.unitCost);
    } else {
      unitCost = m.unitCost !== undefined && m.unitCost !== null ? D(m.unitCost) : avg;
    }
    if (costQty.lessThanOrEqualTo(0)) {
      // Saldo zerado ou negativo: o custo passa a ser o da entrada; se estava negativo, corrige as saídas (RN-EST-02)
      newAvg = unitCost;
      if (negativePending || costQty.lessThan(0)) {
        negativePending = false;
        const firstNeg = await tx.maybeOne<{ occurred_at: Date }>(
          `SELECT min(occurred_at) AS occurred_at FROM inventory.stock_movements WHERE establishment_id = $1 AND product_id = $2 AND sign = -1
             AND occurred_at >= coalesce((SELECT max(occurred_at) FROM inventory.stock_movements WHERE establishment_id = $1 AND product_id = $2 AND sign = 1), '-infinity')`,
          [wh.establishment_id, m.productId]);
        if (firstNeg?.occurred_at) recalcFrom = new Date(firstNeg.occurred_at);
      }
    } else {
      newAvg = costQty.times(avg).plus(qty.times(unitCost)).dividedBy(costQty.plus(qty));
    }
  } else if (m.type === 'purchase_return_out' && m.unitCost != null && costQty.greaterThan(qty)) {
    // Devolução a fornecedor sai pelo custo de entrada da nota devolvida (RN-COM-07): o médio do restante é recomposto
    unitCost = D(m.unitCost);
    newAvg = max(costQty.times(avg).minus(qty.times(unitCost)).dividedBy(costQty.minus(qty)), ZERO);
  } else {
    // Saídas não alteram o custo médio; saem pelo custo médio do momento
    unitCost = avg;
    if (costQty.minus(qty).lessThan(0)) negativePending = true;
  }
  newAvg = round(newAvg, 'cost');
  unitCost = round(unitCost, 'cost');
  const totalCost = roundMoney(qty.times(unitCost));
  const newCostQty = costQty.plus(qty.times(sign));

  const mv = await tx.one<MovementRow>(
    `INSERT INTO inventory.stock_movements (tenant_id, company_id, establishment_id, warehouse_id, product_id, lot_id, movement_type, sign, quantity, unit_cost, total_cost,
       avg_cost_after, occurred_at, source_type, source_id, source_item_id, reason, reversal_of, serials, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [tx.tenantId, wh.company_id, wh.establishment_id, wh.id, m.productId, lotId, m.type, sign, qty.toFixed(4), unitCost.toFixed(10), totalCost.toFixed(2),
      newAvg.toFixed(10), occurredAt, m.sourceType, m.sourceId ?? null, m.sourceItemId ?? null, m.reason ?? null, m.reversalOf ?? null, m.serials ?? null, tx.userId]);
  if (m.idempotencyKey) await tx.exec(`UPDATE inventory.movement_keys SET movement_id = $2 WHERE key = $1`, [m.idempotencyKey, mv.id]);
  // RN-GER-01: o saldo só muda pelo movimento; o gatilho do banco confere o delta declarado aqui
  await tx.exec(`SELECT set_config('vortex.stock_delta', $1, true)`, [`${wh.id}|${m.productId}|${lotId ?? ''}|${newQty.minus(bal.quantity).toFixed(4)}`]);
  await tx.exec(
    `UPDATE inventory.stock_balances SET quantity = $4, reserved = greatest(reserved - $5::numeric, 0), updated_at = now()
      WHERE warehouse_id = $1 AND product_id = $2 AND lot_id IS NOT DISTINCT FROM $3`,
    [wh.id, m.productId, lotId, newQty.toFixed(4), releasedReserve.toFixed(4)]);
  await tx.exec(
    `UPDATE inventory.product_costs SET quantity = $3, avg_cost = $4, negative_pending = $5, updated_at = now() WHERE establishment_id = $1 AND product_id = $2`,
    [wh.establishment_id, m.productId, newCostQty.toFixed(4), newAvg.toFixed(10), negativePending]);
  if (sign > 0 && COST_FORMING.has(m.type) && m.type === 'purchase_in') {
    await tx.exec(`UPDATE catalog.products SET last_purchase_cost = $2 WHERE id = $1`, [m.productId, unitCost.toFixed(10)]);
  }

  // Séries
  if (product.controls_serial) {
    const serials = m.serials ?? [];
    if (!qty.equals(serials.length)) throw validation({ serials: `Informe ${qty.toString()} número(s) de série` });
    for (const s of serials) {
      if (sign > 0) {
        await tx.exec(`INSERT INTO inventory.serials (tenant_id, product_id, serial, lot_id, warehouse_id, status) VALUES ($1,$2,$3,$4,$5,'in_stock')
                       ON CONFLICT (tenant_id, product_id, serial) DO UPDATE SET status = 'in_stock', warehouse_id = EXCLUDED.warehouse_id`, [tx.tenantId, m.productId, s, lotId, wh.id]);
      } else {
        const ok = await tx.maybeOne(`UPDATE inventory.serials SET status = $4 WHERE product_id = $1 AND serial = $2 AND warehouse_id = $3 AND status = 'in_stock' RETURNING id`,
          [m.productId, s, wh.id, m.type === 'sale_out' ? 'sold' : 'lost']);
        if (!ok) throw validation({ serials: `Número de série ${s} não está em estoque neste depósito` });
      }
    }
  }

  // RN-EST-04: movimento retroativo dispara recálculo do custo a partir daquela data
  if (!recalcFrom) {
    const later = await tx.maybeOne(
      `SELECT 1 FROM inventory.stock_movements WHERE establishment_id = $1 AND product_id = $2 AND occurred_at > $3 AND id <> $4 LIMIT 1`,
      [wh.establishment_id, m.productId, occurredAt, mv.id]);
    if (later && sign > 0) recalcFrom = occurredAt;
  }
  if (recalcFrom) await requestCostRecalc(tx, wh.establishment_id, m.productId, recalcFrom);

  // Situação de estoque do produto no depósito mudou (disponível, baixo, sem estoque): avisa o PDV
  {
    const after = await tx.one<{ available: string | null }>(
      `SELECT sum(quantity - reserved - blocked) AS available FROM inventory.stock_balances WHERE warehouse_id = $1 AND product_id = $2`, [wh.id, m.productId]);
    const params = await tx.maybeOne<{ reorder_point: string }>(`SELECT reorder_point FROM catalog.stock_params WHERE product_id = $1 AND warehouse_id = $2`, [m.productId, wh.id]);
    const level = (v: Decimal) => (v.lessThanOrEqualTo(0) ? 'out' : params && v.lessThanOrEqualTo(params.reorder_point) ? 'low' : 'available');
    const now = D(after.available ?? 0);
    const before = now.minus(qty.times(sign));
    if (level(now) !== level(before)) {
      await emit(tx, 'estoque.alterado', { type: 'product', id: m.productId }, { productId: m.productId, warehouseId: wh.id, available: now.toFixed(4), status: level(now) });
    }
  }
  // Evento de estoque abaixo do mínimo (alimenta sugestão de compra e alertas)
  if (sign < 0) {
    const p = await tx.maybeOne<{ reorder_point: string }>(`SELECT reorder_point FROM catalog.stock_params WHERE product_id = $1 AND warehouse_id = $2`, [m.productId, wh.id]);
    const after = await tx.one<{ available: string }>(
      `SELECT sum(quantity - reserved - blocked) AS available FROM inventory.stock_balances WHERE warehouse_id = $1 AND product_id = $2`, [wh.id, m.productId]);
    if (p && D(after.available).lessThanOrEqualTo(p.reorder_point) && D(after.available).plus(qty).greaterThan(p.reorder_point)) {
      await emit(tx, 'estoque.abaixo_minimo', { type: 'product', id: m.productId }, { productId: m.productId, warehouseId: wh.id, available: after.available, reorderPoint: p.reorder_point });
    }
  }
  return mv;
}

/** RN-GER-02: correção é sempre por movimento novo (estorno), nunca edição. */
export async function reverseMovement(tx: Tx, movementId: string, reason: string, opts: { idempotencyKey?: string; occurredAt?: Date } = {}) {
  const mv = await tx.maybeOne<Record<string, any>>(`SELECT * FROM inventory.stock_movements WHERE id = $1`, [movementId]);
  if (!mv) throw notFound('Movimento');
  const already = await tx.maybeOne(`SELECT id FROM inventory.stock_movements WHERE reversal_of = $1`, [movementId]);
  if (already) throw new AppError('ALREADY_REVERSED', 'Movimento já estornado', 409);
  return postMovement(tx, {
    warehouseId: mv.warehouse_id, productId: mv.product_id, lotId: mv.lot_id, type: mv.sign > 0 ? 'reversal_out' : 'reversal_in',
    quantity: mv.quantity, unitCost: mv.unit_cost, occurredAt: opts.occurredAt ?? new Date(), sourceType: 'reversal', sourceId: mv.source_id,
    sourceItemId: mv.source_item_id, reason, reversalOf: movementId, idempotencyKey: opts.idempotencyKey ?? `reversal:${movementId}`, serials: mv.serials ?? undefined,
    inventoryAdjustment: true,
  });
}

// ------------------------------------------------------------------ reservas

export async function reserve(tx: Tx, r: { warehouseId: string; productId: string; lotId?: string | null; quantity: string; sourceType: string; sourceId: string; sourceItemId?: string | null; expiresAt?: Date | null }) {
  const product = await tx.one<{ controls_stock: boolean; allow_negative_stock: boolean; sku: string; kind: string; kit_explodes_stock: boolean }>(
    `SELECT controls_stock, allow_negative_stock, sku, kind, kit_explodes_stock FROM catalog.products WHERE id = $1`, [r.productId], 'Produto');
  if (!product.controls_stock || (product.kind === 'kit' && product.kit_explodes_stock)) return null;
  const wh = await tx.one<{ company_id: string; establishment_id: string; allow_negative: boolean }>(`SELECT company_id, establishment_id, allow_negative FROM core.warehouses WHERE id = $1`, [r.warehouseId], 'Depósito');
  await tx.exec(
    `INSERT INTO inventory.stock_balances (tenant_id, company_id, establishment_id, warehouse_id, product_id, lot_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [tx.tenantId, wh.company_id, wh.establishment_id, r.warehouseId, r.productId, r.lotId ?? null]);
  const bal = await tx.one<{ quantity: string; reserved: string; blocked: string }>(
    `SELECT quantity, reserved, blocked FROM inventory.stock_balances WHERE warehouse_id = $1 AND product_id = $2 AND lot_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
    [r.warehouseId, r.productId, r.lotId ?? null]);
  const available = D(bal.quantity).minus(bal.reserved).minus(bal.blocked);
  if (!product.allow_negative_stock && !wh.allow_negative && available.lessThan(r.quantity)) {
    throw ruleViolation('RN-EST-01', `Estoque disponível insuficiente para reservar ${product.sku}: disponível ${available.toFixed(4)}`, { productId: r.productId, available: available.toFixed(4) });
  }
  await tx.exec(`UPDATE inventory.stock_balances SET reserved = reserved + $4 WHERE warehouse_id = $1 AND product_id = $2 AND lot_id IS NOT DISTINCT FROM $3`,
    [r.warehouseId, r.productId, r.lotId ?? null, r.quantity]);
  return tx.one(
    `INSERT INTO inventory.reservations (tenant_id, company_id, warehouse_id, product_id, lot_id, quantity, source_type, source_id, source_item_id, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [tx.tenantId, wh.company_id, r.warehouseId, r.productId, r.lotId ?? null, r.quantity, r.sourceType, r.sourceId, r.sourceItemId ?? null, r.expiresAt ?? null, tx.userId]);
}

export async function releaseReservations(tx: Tx, where: { sourceType: string; sourceId: string; sourceItemId?: string } | { reservationId: string }, status: 'released' | 'expired' = 'released') {
  const rows = 'reservationId' in where
    ? await tx.query(`SELECT * FROM inventory.reservations WHERE id = $1 AND status = 'active' FOR UPDATE`, [where.reservationId])
    : await tx.query(`SELECT * FROM inventory.reservations WHERE source_type = $1 AND source_id = $2 AND ($3::uuid IS NULL OR source_item_id = $3) AND status = 'active' FOR UPDATE`,
      [where.sourceType, where.sourceId, where.sourceItemId ?? null]);
  for (const r of rows) {
    await tx.exec(`UPDATE inventory.stock_balances SET reserved = greatest(reserved - $4::numeric, 0) WHERE warehouse_id = $1 AND product_id = $2 AND lot_id IS NOT DISTINCT FROM $3`,
      [r.warehouse_id, r.product_id, r.lot_id, r.quantity]);
    await tx.exec(`UPDATE inventory.reservations SET status = $2 WHERE id = $1`, [r.id, status]);
  }
  return rows.length;
}

// ------------------------------------------------------------------ FEFO (RN-EST-05)

/** Sugestão de lotes para separação: vence primeiro, sai primeiro; lote vencido nunca é sugerido. */
export async function allocateFefo(tx: Tx, warehouseId: string, productId: string, quantity: string, at = new Date()): Promise<{ lotId: string; lotNumber: string; expiresAt: string | null; quantity: string }[]> {
  const lots = await tx.query<{ lot_id: string; lot_number: string; expires_at: string | null; available: string }>(
    `SELECT b.lot_id, l.lot_number, l.expires_at, (b.quantity - b.reserved - b.blocked) AS available
       FROM inventory.stock_balances b JOIN inventory.lots l ON l.id = b.lot_id
      WHERE b.warehouse_id = $1 AND b.product_id = $2 AND l.status = 'available' AND (l.expires_at IS NULL OR l.expires_at >= $3::date)
        AND b.quantity - b.reserved - b.blocked > 0
      ORDER BY l.expires_at NULLS LAST, l.created_at`,
    [warehouseId, productId, at.toISOString().slice(0, 10)]);
  let remaining = D(quantity);
  const out = [];
  for (const l of lots) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const take = D(l.available).lessThan(remaining) ? D(l.available) : remaining;
    out.push({ lotId: l.lot_id, lotNumber: l.lot_number, expiresAt: l.expires_at, quantity: take.toFixed(4) });
    remaining = remaining.minus(take);
  }
  if (remaining.greaterThan(0)) throw ruleViolation('RN-EST-05', `Lotes válidos insuficientes: faltam ${remaining.toFixed(4)}`);
  return out;
}

export async function getOrCreateLot(tx: Tx, productId: string, lotNumber: string, data: { manufacturedAt?: string | null; expiresAt?: string | null; supplierId?: string | null } = {}) {
  const ex = await tx.maybeOne<{ id: string }>(`SELECT id FROM inventory.lots WHERE product_id = $1 AND lot_number = $2`, [productId, lotNumber]);
  if (ex) return ex.id;
  const r = await tx.one<{ id: string }>(
    `INSERT INTO inventory.lots (tenant_id, product_id, lot_number, manufactured_at, expires_at, supplier_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tx.tenantId, productId, lotNumber, data.manufacturedAt ?? null, data.expiresAt ?? null, data.supplierId ?? null, tx.userId]);
  return r.id;
}

// ------------------------------------------------------------------ recálculo de custo (RN-EST-04)

export async function requestCostRecalc(tx: Tx, establishmentId: string, productId: string, from: Date) {
  const company = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [establishmentId]);
  const r = await tx.one<{ id: string }>(
    `INSERT INTO inventory.cost_recalculations (tenant_id, company_id, establishment_id, product_id, from_date, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tx.tenantId, company.company_id, establishmentId, productId, from, tx.userId]);
  await enqueue(tx, 'estoque.recalcular_custo', { recalculationId: r.id }, { dedupeKey: `${establishmentId}:${productId}:${from.toISOString()}` });
  return r.id;
}

/**
 * Refaz a cadeia do custo médio a partir da data, em ordem cronológica. Os movimentos
 * são imutáveis: as saídas recebem ajustes de custo (inventory.cost_adjustments) e o
 * custo médio atual é corrigido. Período fechado bloqueia o recálculo.
 */
export async function runCostRecalc(tx: Tx, recalculationId: string) {
  const rc = await tx.one<{ establishment_id: string; product_id: string; from_date: Date; company_id: string; status: string }>(
    `SELECT establishment_id, product_id, from_date, company_id, status FROM inventory.cost_recalculations WHERE id = $1 FOR UPDATE`, [recalculationId]);
  if (rc.status !== 'queued') return { skipped: true };
  const closed = await tx.maybeOne<{ year: number; month: number }>(
    `SELECT year, month FROM accounting.periods WHERE company_id = $1 AND status = 'closed' AND make_date(year, month, 1) + interval '1 month' > $2 ORDER BY year, month LIMIT 1`,
    [rc.company_id, rc.from_date]);
  if (closed) {
    await tx.exec(`UPDATE inventory.cost_recalculations SET status = 'blocked', report = $2 WHERE id = $1`,
      [recalculationId, JSON.stringify({ reason: `Período ${closed.month}/${closed.year} fechado (RN-EST-04)` })]);
    return { blocked: true };
  }
  // Estado antes da data: quantidade e valor acumulados
  const before = await tx.one<{ qty: string | null; value: string | null; last_avg: string | null }>(
    `SELECT sum(sign * quantity) AS qty,
            (SELECT avg_cost_after FROM inventory.stock_movements WHERE establishment_id = $1 AND product_id = $2 AND occurred_at < $3 ORDER BY occurred_at DESC, created_at DESC LIMIT 1) AS last_avg,
            NULL AS value
       FROM inventory.stock_movements WHERE establishment_id = $1 AND product_id = $2 AND occurred_at < $3`,
    [rc.establishment_id, rc.product_id, rc.from_date]);
  let qty = D(before.qty ?? '0');
  let avg = D(before.last_avg ?? '0');
  const moves = await tx.query<{ id: string; occurred_at: Date; sign: number; quantity: string; unit_cost: string; movement_type: MovementType; adj: string | null }>(
    `SELECT m.id, m.occurred_at, m.sign, m.quantity, m.unit_cost, m.movement_type,
            (SELECT new_unit_cost FROM inventory.cost_adjustments a WHERE a.movement_id = m.id ORDER BY a.created_at DESC LIMIT 1) AS adj
       FROM inventory.stock_movements m WHERE m.establishment_id = $1 AND m.product_id = $2 AND m.occurred_at >= $3 ORDER BY m.occurred_at, m.created_at`,
    [rc.establishment_id, rc.product_id, rc.from_date]);
  const changes: { movementId: string; oldUnitCost: string; newUnitCost: string; difference: string }[] = [];
  for (const mv of moves) {
    const q = D(mv.quantity);
    const current = D(mv.adj ?? mv.unit_cost);
    if (mv.sign > 0) {
      const entryCost = COST_FORMING.has(mv.movement_type) ? D(mv.unit_cost) : current;
      avg = qty.lessThanOrEqualTo(0) ? entryCost : qty.times(avg).plus(q.times(entryCost)).dividedBy(qty.plus(q));
      qty = qty.plus(q);
    } else {
      const newCost = round(avg, 'cost');
      if (!newCost.equals(current)) {
        const diff = roundMoney(q.times(newCost)).minus(roundMoney(q.times(current)));
        await tx.exec(
          `INSERT INTO inventory.cost_adjustments (tenant_id, recalculation_id, movement_id, movement_occurred_at, product_id, old_unit_cost, new_unit_cost, difference)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tx.tenantId, recalculationId, mv.id, mv.occurred_at, rc.product_id, current.toFixed(10), newCost.toFixed(10), diff.toFixed(2)]);
        changes.push({ movementId: mv.id, oldUnitCost: current.toFixed(10), newUnitCost: newCost.toFixed(10), difference: diff.toFixed(2) });
      }
      qty = qty.minus(q);
    }
  }
  await tx.exec(`UPDATE inventory.product_costs SET avg_cost = $3, negative_pending = $4 WHERE establishment_id = $1 AND product_id = $2`,
    [rc.establishment_id, rc.product_id, round(avg, 'cost').toFixed(10), qty.lessThan(0)]);
  const report = { finalAvgCost: round(avg, 'cost').toFixed(10), movementsAnalyzed: moves.length, changes, totalDifference: changes.reduce((a, c) => a.plus(c.difference), ZERO).toFixed(2) };
  await tx.exec(`UPDATE inventory.cost_recalculations SET status = 'done', report = $2 WHERE id = $1`, [recalculationId, JSON.stringify(report)]);
  return report;
}

/** Kit que baixa componentes: devolve as linhas de movimento dos componentes. */
export async function explodeKit(tx: Tx, productId: string, quantity: string): Promise<{ productId: string; quantity: string }[]> {
  const p = await tx.one<{ kind: string; kit_explodes_stock: boolean }>(`SELECT kind, kit_explodes_stock FROM catalog.products WHERE id = $1`, [productId]);
  if (p.kind !== 'kit' || !p.kit_explodes_stock) {
    // Ficha técnica em modo simples (food service, seção 17): a venda do prato baixa os insumos
    const bom = await tx.maybeOne<{ id: string; yield_quantity: string }>(
      `SELECT id, yield_quantity FROM production.boms WHERE product_id = $1 AND simple_mode AND valid_from <= current_date AND (valid_to IS NULL OR valid_to >= current_date)
        ORDER BY valid_from DESC, version DESC LIMIT 1`, [productId]);
    if (!bom) return [{ productId, quantity }];
    const items = await tx.query<{ component_id: string; quantity: string; loss_percent: string }>(`SELECT component_id, quantity, loss_percent FROM production.bom_items WHERE bom_id = $1`, [bom.id]);
    return items.map((i) => ({ productId: i.component_id,
      quantity: D(i.quantity).times(quantity).dividedBy(bom.yield_quantity).times(D(1).plus(D(i.loss_percent).dividedBy(100))).toFixed(4) }));
  }
  const comps = await tx.query<{ component_id: string; quantity: string }>(`SELECT component_id, quantity FROM catalog.kit_items WHERE kit_id = $1`, [productId]);
  if (!comps.length) throw validation({ productId: 'Kit sem componentes cadastrados' });
  return comps.map((c) => ({ productId: c.component_id, quantity: D(c.quantity).times(quantity).toFixed(4) }));
}
