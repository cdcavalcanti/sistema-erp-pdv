import { D, roundMoney } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError, forbidden, ruleViolation, validation } from '../../errors.js';
import { checkLimit, has } from '../../core/access.js';
import { requestApproval, onApprovalDecided } from '../../core/approvals.js';
import { postMovement, type MovementType } from './stock.js';
import { currentCost } from '../catalog/pricing.js';
import { postEvent } from '../accounting/posting.js';

// ------------------------------------------------------------------ baixas manuais (RN-EST-06)

export interface ManualMovementInput {
  warehouseId: string;
  productId: string;
  lotId?: string | null;
  type: 'loss' | 'damage' | 'internal_use' | 'opening';
  quantity: string;
  unitCost?: string | null;
  reasonCode: string;
  reason: string;
  occurredAt?: string;
}

/**
 * Toda baixa por perda, avaria ou consumo interno exige motivo e, acima do valor
 * da alçada do usuário, aprovação. Alimenta o indicador de perdas.
 */
export async function createManualMovement(tx: Tx, input: ManualMovementInput) {
  if (!input.reason || input.reason.trim().length < 5) throw validation({ reason: 'Motivo obrigatório' });
  const wh = await tx.one<{ company_id: string; establishment_id: string }>(`SELECT company_id, establishment_id FROM core.warehouses WHERE id = $1`, [input.warehouseId], 'Depósito');
  const cost = input.type === 'opening' ? D(input.unitCost ?? '0') : await currentCost(tx, wh.establishment_id, input.productId);
  const value = roundMoney(D(input.quantity).times(cost));
  const row = await tx.one<{ id: string }>(
    `INSERT INTO inventory.manual_movements (tenant_id, company_id, establishment_id, warehouse_id, product_id, lot_id, movement_type, quantity, unit_cost, estimated_value,
       reason_code, reason, occurred_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,coalesce($13::timestamptz, now()),$14) RETURNING id`,
    [tx.tenantId, wh.company_id, wh.establishment_id, input.warehouseId, input.productId, input.lotId ?? null, input.type, input.quantity,
      input.type === 'opening' ? input.unitCost : null, value.toFixed(2), input.reasonCode, input.reason, input.occurredAt ?? null, tx.userId]);
  const limit = input.type === 'opening' ? { allowed: has(tx.ctx, 'estoque.movimento.aprovar') } : await checkLimit(tx, 'estoque.perda', { value: value.toFixed(2) });
  if (!limit.allowed) {
    const ap = await requestApproval(tx, {
      entityType: 'inventory_manual_movement', entityId: row.id, action: 'estoque.perda', reasonCode: 'acima_da_alcada',
      reason: `Baixa de ${input.type} no valor de R$ ${value.toFixed(2)}: ${input.reason}`, value: value.toFixed(2), approverPermission: 'estoque.movimento.aprovar',
    });
    return { id: row.id, status: 'pending_approval', estimatedValue: value.toFixed(2), approvalRequestId: ap.id };
  }
  const mv = await postManual(tx, row.id);
  return { id: row.id, status: 'posted', estimatedValue: value.toFixed(2), movementId: mv?.id ?? null };
}

async function postManual(tx: Tx, id: string) {
  const r = await tx.one<Record<string, any>>(`SELECT * FROM inventory.manual_movements WHERE id = $1 FOR UPDATE`, [id]);
  const mv = await postMovement(tx, {
    warehouseId: r.warehouse_id, productId: r.product_id, lotId: r.lot_id, type: r.movement_type as MovementType, quantity: r.quantity,
    unitCost: r.unit_cost, occurredAt: r.occurred_at, sourceType: 'manual', sourceId: r.id, reason: `${r.reason_code}: ${r.reason}`, idempotencyKey: `manual:${r.id}`,
  });
  await tx.exec(`UPDATE inventory.manual_movements SET status = 'posted', movement_id = $2 WHERE id = $1`, [id, mv?.id ?? null]);
  if (mv) {
    await postEvent(tx, {
      type: r.movement_type === 'opening' ? 'estoque_inicial' : 'baixa_estoque', companyId: r.company_id, establishmentId: r.establishment_id, date: new Date(r.occurred_at).toISOString().slice(0, 10),
      description: `${r.reason_code}: ${r.reason}`.slice(0, 200), number: r.id.slice(0, 8), originType: 'stock_movement', originId: mv.id, amounts: { value: mv.total_cost },
    });
  }
  return mv;
}

onApprovalDecided('inventory_manual_movement', async (tx, req) => {
  if (req.status === 'approved') await postManual(tx, req.entity_id);
  else await tx.exec(`UPDATE inventory.manual_movements SET status = 'rejected' WHERE id = $1`, [req.entity_id]);
});

// ------------------------------------------------------------------ transferência entre depósitos

export async function transferBetweenWarehouses(tx: Tx, t: { fromWarehouseId: string; toWarehouseId: string; productId: string; lotId?: string | null; quantity: string; reason?: string; idempotencyKey?: string }) {
  const [from, to] = [
    await tx.one<{ establishment_id: string }>(`SELECT establishment_id FROM core.warehouses WHERE id = $1`, [t.fromWarehouseId], 'Depósito de origem'),
    await tx.one<{ establishment_id: string }>(`SELECT establishment_id FROM core.warehouses WHERE id = $1`, [t.toWarehouseId], 'Depósito de destino'),
  ];
  if (from.establishment_id !== to.establishment_id) {
    throw ruleViolation('RN-EST-01', 'Transferência entre estabelecimentos exige NF-e de transferência (use o tipo de operação TRANSF)');
  }
  if (t.fromWarehouseId === t.toWarehouseId) throw validation({ toWarehouseId: 'Depósitos de origem e destino iguais' });
  const key = t.idempotencyKey ?? null;
  const out = await postMovement(tx, { warehouseId: t.fromWarehouseId, productId: t.productId, lotId: t.lotId, type: 'transfer_out', quantity: t.quantity,
    sourceType: 'transfer', reason: t.reason ?? null, idempotencyKey: key ? `${key}:out` : null });
  const inn = await postMovement(tx, { warehouseId: t.toWarehouseId, productId: t.productId, lotId: t.lotId, type: 'transfer_in', quantity: t.quantity,
    unitCost: out?.unit_cost ?? null, sourceType: 'transfer', sourceId: out?.id ?? null, reason: t.reason ?? null, idempotencyKey: key ? `${key}:in` : null });
  return { out, in: inn };
}

// ------------------------------------------------------------------ inventário (contagem) — seção 12

export interface OpenInventoryInput {
  warehouseId: string;
  kind: 'general' | 'sample' | 'cyclic';
  freezeMode: 'block' | 'register';
  categoryIds?: string[];
  productIds?: string[];
  /** Cíclico: curva A contada com mais frequência */
  abcClass?: 'A' | 'B' | 'C';
  divergenceLimitPercent?: string;
}

/** 1. Abertura e 2. congelamento: "foto" do saldo no momento da abertura. */
export async function openInventory(tx: Tx, input: OpenInventoryInput) {
  const wh = await tx.one<{ company_id: string; establishment_id: string }>(`SELECT company_id, establishment_id FROM core.warehouses WHERE id = $1`, [input.warehouseId], 'Depósito');
  const open = await tx.maybeOne(`SELECT id FROM inventory.inventories WHERE warehouse_id = $1 AND status IN ('counting','review')`, [input.warehouseId]);
  if (open) throw new AppError('INVENTORY_OPEN', 'Já existe inventário em andamento neste depósito', 409, { inventoryId: open.id });
  const num = await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'inventory') AS n`, [wh.company_id]);
  const inv = await tx.one(
    `INSERT INTO inventory.inventories (tenant_id, company_id, establishment_id, warehouse_id, number, kind, freeze_mode, scope, divergence_limit_percent, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tx.tenantId, wh.company_id, wh.establishment_id, input.warehouseId, num.n, input.kind, input.freezeMode,
      JSON.stringify({ categoryIds: input.categoryIds ?? [], productIds: input.productIds ?? [], abcClass: input.abcClass ?? null }), input.divergenceLimitPercent ?? '2', tx.userId]);
  let abcIds: string[] | null = null;
  if (input.abcClass) abcIds = (await abcCurve(tx, wh.establishment_id, 90)).filter((r) => r.class === input.abcClass).map((r) => r.productId);
  const items = await tx.query(
    `INSERT INTO inventory.inventory_items (tenant_id, inventory_id, product_id, lot_id, snapshot_qty, snapshot_cost)
     SELECT $1, $2, p.id, b.lot_id, coalesce(b.quantity, 0), coalesce(pc.avg_cost, p.last_purchase_cost)
       FROM catalog.products p
       LEFT JOIN inventory.stock_balances b ON b.product_id = p.id AND b.warehouse_id = $3
       LEFT JOIN inventory.product_costs pc ON pc.product_id = p.id AND pc.establishment_id = $4
      WHERE p.controls_stock AND NOT p.is_variant_parent AND p.status = 'active' AND NOT (p.kind = 'kit' AND p.kit_explodes_stock)
        AND (cardinality($5::uuid[]) = 0 OR p.category_id = ANY($5))
        AND (cardinality($6::uuid[]) = 0 OR p.id = ANY($6))
        AND ($7::uuid[] IS NULL OR p.id = ANY($7))
        AND ($8::text <> 'sample' OR random() < 0.2 OR b.quantity <> 0)
     RETURNING id`,
    [tx.tenantId, inv.id, input.warehouseId, wh.establishment_id, input.categoryIds ?? [], input.productIds ?? [], abcIds, input.kind]);
  return { ...inv, items: items.length };
}

/** 3. Contagem por coletor/celular; segunda contagem obrigatória acima do limite de divergência. */
export async function countItem(tx: Tx, inventoryId: string, c: { productId: string; lotId?: string | null; quantity: string; countNumber?: 1 | 2 }) {
  const inv = await tx.one<{ status: string; divergence_limit_percent: string }>(`SELECT status, divergence_limit_percent FROM inventory.inventories WHERE id = $1 FOR UPDATE`, [inventoryId], 'Inventário');
  if (inv.status !== 'counting') throw new AppError('INVENTORY_NOT_COUNTING', 'Inventário não está em contagem', 409);
  let item = await tx.maybeOne<Record<string, any>>(`SELECT * FROM inventory.inventory_items WHERE inventory_id = $1 AND product_id = $2 AND lot_id IS NOT DISTINCT FROM $3 FOR UPDATE`,
    [inventoryId, c.productId, c.lotId ?? null]);
  if (!item) {
    // Item encontrado na contagem que não estava no saldo (ex.: lote novo)
    item = await tx.one(`INSERT INTO inventory.inventory_items (tenant_id, inventory_id, product_id, lot_id, snapshot_qty) VALUES ($1,$2,$3,$4,0) RETURNING *`,
      [tx.tenantId, inventoryId, c.productId, c.lotId ?? null]);
  }
  const n = c.countNumber ?? (item.count1 === null ? 1 : 2);
  if (n === 2) {
    if (item.count1 === null) throw validation({ countNumber: 'Faça a primeira contagem antes' });
    if (item.count1_by && item.count1_by === tx.userId && !tx.ctx.permissions.has('*')) throw forbidden('A segunda contagem deve ser feita por outra pessoa');
    await tx.exec(`UPDATE inventory.inventory_items SET count2 = $2, count2_by = $3, final_qty = $2, needs_recount = false WHERE id = $1`, [item.id, c.quantity, tx.userId]);
    return { itemId: item.id, countNumber: 2, needsRecount: false };
  }
  const snap = D(item.snapshot_qty);
  const diff = D(c.quantity).minus(snap).abs();
  const pct = snap.isZero() ? (diff.isZero() ? D(0) : D(100)) : diff.dividedBy(snap.abs()).times(100);
  const needsRecount = pct.greaterThan(inv.divergence_limit_percent);
  await tx.exec(`UPDATE inventory.inventory_items SET count1 = $2, count1_by = $3, final_qty = CASE WHEN $4 THEN NULL ELSE $2::numeric END, needs_recount = $4 WHERE id = $1`,
    [item.id, c.quantity, tx.userId, needsRecount]);
  return { itemId: item.id, countNumber: 1, needsRecount, divergencePercent: pct.toFixed(2) };
}

/** Encerra a contagem e calcula diferenças (considerando movimentos ocorridos durante a contagem). */
export async function reviewInventory(tx: Tx, inventoryId: string) {
  const inv = await tx.one<Record<string, any>>(`SELECT * FROM inventory.inventories WHERE id = $1 FOR UPDATE`, [inventoryId], 'Inventário');
  if (inv.status !== 'counting') throw new AppError('INVENTORY_NOT_COUNTING', 'Inventário não está em contagem', 409);
  const pending = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM inventory.inventory_items WHERE inventory_id = $1 AND (needs_recount OR count1 IS NULL)`, [inventoryId]);
  if (pending.n > 0) throw new AppError('INVENTORY_PENDING_COUNTS', `${pending.n} item(ns) sem contagem ou aguardando segunda contagem`, 409, { pending: pending.n });
  const items = await tx.query(`SELECT * FROM inventory.inventory_items WHERE inventory_id = $1`, [inventoryId]);
  for (const it of items) {
    // Modo "registrar": esperado = foto + movimentos desde a abertura
    const moved = inv.freeze_mode === 'register'
      ? await tx.one<{ q: string | null }>(`SELECT sum(sign * quantity) AS q FROM inventory.stock_movements WHERE warehouse_id = $1 AND product_id = $2 AND lot_id IS NOT DISTINCT FROM $3 AND created_at > $4`,
        [inv.warehouse_id, it.product_id, it.lot_id, inv.opened_at])
      : { q: '0' };
    const expected = D(it.snapshot_qty).plus(moved.q ?? '0');
    const diff = D(it.final_qty).minus(expected);
    await tx.exec(`UPDATE inventory.inventory_items SET diff_qty = $2, diff_value = $3 WHERE id = $1`,
      [it.id, diff.toFixed(4), roundMoney(diff.times(it.snapshot_cost)).toFixed(2)]);
  }
  await tx.exec(`UPDATE inventory.inventories SET status = 'review' WHERE id = $1`, [inventoryId]);
  return inventoryReport(tx, inventoryId);
}

/** 4. Aprovação das diferenças e 5. fechamento: gera os movimentos de ajuste. */
export async function approveInventory(tx: Tx, inventoryId: string) {
  const inv = await tx.one<Record<string, any>>(`SELECT * FROM inventory.inventories WHERE id = $1 FOR UPDATE`, [inventoryId], 'Inventário');
  if (inv.status !== 'review') throw new AppError('INVENTORY_NOT_IN_REVIEW', 'Inventário precisa estar em conferência', 409);
  if (inv.created_by && inv.created_by === tx.userId && !tx.ctx.permissions.has('*')) throw forbidden('Quem abriu o inventário não aprova as próprias diferenças');
  const items = await tx.query(`SELECT * FROM inventory.inventory_items WHERE inventory_id = $1 AND diff_qty <> 0`, [inventoryId]);
  for (const it of items) {
    const diff = D(it.diff_qty);
    await postMovement(tx, {
      warehouseId: inv.warehouse_id, productId: it.product_id, lotId: it.lot_id, type: diff.greaterThan(0) ? 'inventory_adjust_in' : 'inventory_adjust_out',
      quantity: diff.abs().toFixed(4), unitCost: it.snapshot_cost, sourceType: 'inventory', sourceId: inventoryId, sourceItemId: it.id,
      reason: `Ajuste do inventário nº ${inv.number}`, idempotencyKey: `inventory:${it.id}`, inventoryAdjustment: true,
    });
  }
  await tx.exec(`UPDATE inventory.inventories SET status = 'closed', approved_at = now(), approved_by = $2, closed_at = now() WHERE id = $1`, [inventoryId, tx.userId]);
  const val = await tx.one<{ gain: string | null; loss: string | null }>(
    `SELECT sum(total_cost) FILTER (WHERE sign = 1) AS gain, sum(total_cost) FILTER (WHERE sign = -1) AS loss FROM inventory.stock_movements WHERE source_type = 'inventory' AND source_id = $1`, [inventoryId]);
  await postEvent(tx, { type: 'ajuste_inventario', companyId: inv.company_id, establishmentId: inv.establishment_id, date: new Date().toISOString().slice(0, 10),
    description: `Inventário nº ${inv.number}`, number: String(inv.number), originType: 'inventory', originId: inventoryId, amounts: { gain: val.gain, loss: val.loss } });
  return inventoryReport(tx, inventoryId);
}

export async function inventoryReport(tx: Tx, inventoryId: string) {
  const inv = await tx.one(`SELECT * FROM inventory.inventories WHERE id = $1`, [inventoryId], 'Inventário');
  const items = await tx.query(
    `SELECT it.*, p.sku, p.description, p.stock_unit, l.lot_number FROM inventory.inventory_items it JOIN catalog.products p ON p.id = it.product_id
       LEFT JOIN inventory.lots l ON l.id = it.lot_id WHERE it.inventory_id = $1 ORDER BY p.sku`, [inventoryId]);
  const counted = items.filter((i) => i.final_qty !== null);
  const accurate = counted.filter((i) => i.diff_qty !== null && D(i.diff_qty).isZero()).length;
  return {
    inventory: inv, items,
    summary: {
      items: items.length,
      totalDiffValue: items.reduce((a, i) => a.plus(i.diff_value ?? '0'), D(0)).toFixed(2),
      accuracyPercent: counted.length ? D(accurate).dividedBy(counted.length).times(100).toFixed(2) : null,
      inventoryValue: items.reduce((a, i) => a.plus(D(i.final_qty ?? i.snapshot_qty).times(i.snapshot_cost)), D(0)).toFixed(2),
    },
  };
}

/** Curva ABC por valor de saída (CMV) nos últimos N dias. */
export async function abcCurve(tx: Tx, establishmentId: string, days: number): Promise<{ productId: string; value: string; class: 'A' | 'B' | 'C'; cumulativePercent: string }[]> {
  const rows = await tx.query<{ product_id: string; value: string }>(
    `SELECT product_id, sum(total_cost) AS value FROM inventory.stock_movements
      WHERE establishment_id = $1 AND movement_type = 'sale_out' AND occurred_at >= now() - ($2 || ' days')::interval
      GROUP BY product_id ORDER BY value DESC`, [establishmentId, String(days)]);
  const total = rows.reduce((a, r) => a.plus(r.value), D(0));
  let acc = D(0);
  return rows.map((r) => {
    acc = acc.plus(r.value);
    const pct = total.isZero() ? D(0) : acc.dividedBy(total).times(100);
    return { productId: r.product_id, value: r.value, class: pct.lessThanOrEqualTo(80) ? 'A' : pct.lessThanOrEqualTo(95) ? 'B' : 'C', cumulativePercent: pct.toFixed(2) };
  });
}
