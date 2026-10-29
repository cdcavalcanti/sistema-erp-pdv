import { D, ZERO, HUNDRED, allocate, roundMoney, sum, max } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { checkLimit } from '../../core/access.js';
import { cancelPendingApprovals, onApprovalDecided, pendingApprovals, requestApproval } from '../../core/approvals.js';
import { requireReason } from '../../core/audit.js';
import { checkMargin, quotePrice } from '../catalog/pricing.js';
import { explodeKit, releaseReservations, reserve } from '../inventory/stock.js';
import { calculateOperation } from '../fiscal/engine-adapter.js';

export interface OrderItemInput {
  productId: string;
  quantity: string;
  unit?: string;
  unitPrice?: string;
  discountPercent?: string;
  lotId?: string | null;
  notes?: string | null;
}

export interface OrderInput {
  establishmentId: string;
  warehouseId?: string | null;
  partyId: string;
  salespersonId?: string | null;
  channel?: 'counter' | 'ecommerce' | 'marketplace' | 'crm' | 'whatsapp' | 'api' | 'pdv' | 'wholesale';
  externalId?: string | null;
  operationTypeCode?: string;
  paymentTermId?: string | null;
  paymentMethodId?: string | null;
  freightMode?: number;
  carrierId?: string | null;
  freight?: string;
  insurance?: string;
  otherExpenses?: string;
  discount?: string;
  items: OrderItemInput[];
  deliveryAddress?: Record<string, unknown> | null;
  expectedDelivery?: string | null;
  customerOrderRef?: string | null;
  notes?: string | null;
  quoteId?: string | null;
  idempotencyKey?: string | null;
}

interface PricedItem {
  productId: string;
  unit: string;
  unitFactor: string;
  quantity: string;
  listPrice: string;
  unitPrice: string;
  discountPercent: string;
  itemDiscount: string;
  headerShare: string;
  total: string;
  promotionIds: string[];
  lotId: string | null;
  notes: string | null;
}

/** Precifica os itens (RN-PRE-01/02), aplica descontos e rateia o desconto geral (RN-VEN-03). */
export async function priceItems(tx: Tx, input: Pick<OrderInput, 'establishmentId' | 'partyId' | 'channel' | 'discount' | 'items'>): Promise<PricedItem[]> {
  const priced: Omit<PricedItem, 'headerShare'>[] = [];
  for (const it of input.items) {
    const p = await tx.one<{ sale_unit: string; stock_unit: string; status: string; is_variant_parent: boolean }>(
      `SELECT sale_unit, stock_unit, status, is_variant_parent FROM catalog.products WHERE id = $1`, [it.productId], 'Produto');
    if (p.status !== 'active') throw validation({ items: 'Produto inativo' });
    if (p.is_variant_parent) throw validation({ items: 'Venda a variação (cor/tamanho), não o produto pai' });
    const unit = it.unit ?? p.sale_unit;
    let factor = '1';
    if (unit !== p.stock_unit) {
      const conv = await tx.maybeOne<{ factor: string }>(`SELECT factor FROM catalog.unit_conversions WHERE product_id = $1 AND unit = $2 AND purpose IN ('sale','both')`, [it.productId, unit]);
      if (!conv) throw validation({ items: `Unidade ${unit} sem conversão cadastrada` });
      factor = conv.factor;
    }
    const q = await quotePrice(tx, { productId: it.productId, customerId: input.partyId, channel: input.channel ?? 'counter', establishmentId: input.establishmentId, qty: D(it.quantity).times(factor).toString() });
    const list = D(q.basePrice).times(factor);
    const unitPrice = it.unitPrice !== undefined ? D(it.unitPrice) : D(q.unitPrice).times(factor);
    if (unitPrice.lessThanOrEqualTo(0) && list.lessThanOrEqualTo(0)) throw validation({ items: `Produto sem preço na tabela vigente: informe o preço` });
    const gross = roundMoney(D(it.quantity).times(unitPrice));
    const pct = D(it.discountPercent ?? '0');
    if (pct.isNegative() || pct.greaterThan(100)) throw validation({ discountPercent: 'Desconto entre 0 e 100%' });
    const itemDiscount = roundMoney(gross.times(pct).dividedBy(HUNDRED));
    priced.push({
      productId: it.productId, unit, unitFactor: factor, quantity: it.quantity, listPrice: list.toFixed(10), unitPrice: unitPrice.toFixed(10), discountPercent: pct.toFixed(4),
      itemDiscount: itemDiscount.toFixed(2), total: gross.minus(itemDiscount).toFixed(2), promotionIds: it.unitPrice === undefined ? q.promotions.map((x) => x.id) : [],
      lotId: it.lotId ?? null, notes: it.notes ?? null,
    });
  }
  const shares = allocate(input.discount ?? '0', priced.map((p) => p.total));
  return priced.map((p, i) => {
    if (shares[i]!.greaterThan(p.total)) throw validation({ discount: 'Desconto geral maior que o valor dos itens' });
    return { ...p, headerShare: shares[i]!.toFixed(2), total: D(p.total).minus(shares[i]!).toFixed(2) };
  });
}

/** Desconto efetivo do item sobre o preço de tabela (item + rateio do geral). */
function effectiveDiscountPercent(p: PricedItem): string {
  const list = D(p.quantity).times(p.listPrice);
  if (list.lessThanOrEqualTo(0)) return '0';
  return max(ZERO, list.minus(p.total).dividedBy(list).times(HUNDRED)).toFixed(4);
}

async function defaultWarehouse(tx: Tx, establishmentId: string) {
  const w = await tx.maybeOne<{ id: string }>(`SELECT id FROM core.warehouses WHERE establishment_id = $1 AND is_default AND active ORDER BY code LIMIT 1`, [establishmentId]);
  if (!w) throw validation({ warehouseId: 'Estabelecimento sem depósito padrão' });
  return w.id;
}

export async function createOrder(tx: Tx, input: OrderInput, opts: { submit?: boolean } = {}) {
  if (input.idempotencyKey) {
    const ex = await tx.maybeOne(`SELECT id FROM sales.orders WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (ex) return getOrder(tx, ex.id);
  }
  if (!input.items.length) throw validation({ items: 'Pedido sem itens' });
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  const party = await tx.one<{ status: string; salesperson_id: string | null; payment_term_id: string | null; payment_method_id: string | null; price_list_id: string | null; carrier_id: string | null }>(
    `SELECT status, salesperson_id, payment_term_id, payment_method_id, price_list_id, carrier_id FROM registry.parties WHERE id = $1`, [input.partyId], 'Cliente');
  if (party.status === 'inactive') throw validation({ partyId: 'Cliente inativo' });
  if (tx.ctx.ownPortfolioOnly && tx.ctx.partyId && party.salesperson_id !== tx.ctx.partyId) throw new AppError('FORBIDDEN', 'Cliente fora da sua carteira', 403);
  const warehouseId = input.warehouseId ?? (await defaultWarehouse(tx, input.establishmentId));
  const items = await priceItems(tx, input);
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'sales_order') AS n`, [est.company_id])).n;
  const totals = await previewTotals(tx, input, items);
  const order = await tx.one(
    `INSERT INTO sales.orders (tenant_id, company_id, establishment_id, warehouse_id, number, quote_id, party_id, salesperson_id, channel, external_id, operation_type_code, price_list_id,
       payment_term_id, payment_method_id, freight_mode, carrier_id, freight, insurance, other_expenses, discount, total_products, total_discount, total_estimated_taxes, total,
       delivery_address, expected_delivery, customer_order_ref, notes, idempotency_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) RETURNING *`,
    [tx.tenantId, est.company_id, input.establishmentId, warehouseId, number, input.quoteId ?? null, input.partyId, input.salespersonId ?? party.salesperson_id ?? tx.ctx.partyId,
      input.channel ?? 'counter', input.externalId ?? null, input.operationTypeCode ?? 'VENDA', party.price_list_id, input.paymentTermId ?? party.payment_term_id,
      input.paymentMethodId ?? party.payment_method_id, input.freightMode ?? 9, input.carrierId ?? party.carrier_id, input.freight ?? '0', input.insurance ?? '0',
      input.otherExpenses ?? '0', input.discount ?? '0', totals.products, totals.discount, totals.taxes, totals.total, input.deliveryAddress ? JSON.stringify(input.deliveryAddress) : null,
      input.expectedDelivery ?? null, input.customerOrderRef ?? null, input.notes ?? null, input.idempotencyKey ?? null, tx.userId]);
  await insertItems(tx, order.id, items);
  await emit(tx, 'pedido.criado', { type: 'sales_order', id: order.id }, { id: order.id, numero: order.number, cliente: input.partyId, total: order.total, canal: order.channel });
  if (opts.submit !== false) await submitOrder(tx, order.id);
  return getOrder(tx, order.id);
}

async function insertItems(tx: Tx, orderId: string, items: PricedItem[]) {
  for (const [i, it] of items.entries()) {
    await tx.exec(
      `INSERT INTO sales.order_items (tenant_id, order_id, item_number, product_id, unit, unit_factor, quantity, list_price, unit_price, discount_percent, item_discount,
         header_discount_share, total, promotion_ids, lot_id, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [tx.tenantId, orderId, i + 1, it.productId, it.unit, it.unitFactor, it.quantity, it.listPrice, it.unitPrice, it.discountPercent, it.itemDiscount, it.headerShare,
        it.total, it.promotionIds, it.lotId, it.notes]);
  }
}

/** Total real com impostos calculados pelo motor fiscal (ST e IPI somam ao total). */
async function previewTotals(tx: Tx, input: Pick<OrderInput, 'establishmentId' | 'partyId' | 'operationTypeCode' | 'freight' | 'insurance' | 'otherExpenses'>, items: PricedItem[]) {
  const { result } = await calculateOperation(tx, {
    establishmentId: input.establishmentId, operationTypeCode: input.operationTypeCode ?? 'VENDA', date: new Date().toISOString().slice(0, 10), partyId: input.partyId,
    header: { freight: input.freight ?? '0', insurance: input.insurance ?? '0', otherExpenses: input.otherExpenses ?? '0' },
    items: items.map((it, i) => ({ id: String(i), productId: it.productId, quantity: it.quantity, unitPrice: it.unitPrice, discount: D(it.itemDiscount).plus(it.headerShare).toFixed(2) })),
  });
  const t = result.totals;
  return {
    products: t.product, discount: t.discount,
    taxes: sum([t.icms, t.st, t.fcp, t.ipi, t.pis, t.cofins, t.iss, t.difal, t.fcpDest]).toFixed(2),
    total: t.invoice, fiscal: result,
  };
}

// ------------------------------------------------------------------ bloqueios e aprovação

export interface OrderBlock {
  code: 'cliente_bloqueado' | 'limite_credito' | 'titulo_vencido' | 'situacao_cadastral' | 'margem_minima' | 'abaixo_custo' | 'desconto_alcada' | 'estoque_insuficiente';
  message: string;
  permission: string;
  value?: string;
}

/**
 * Bloqueios automáticos (seção 10): crédito (limite, títulos vencidos, cliente bloqueado),
 * margem mínima, desconto acima da alçada e estoque insuficiente.
 */
export async function evaluateBlocks(tx: Tx, orderId: string): Promise<OrderBlock[]> {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1`, [orderId]);
  const items = await tx.query<Record<string, any>>(`SELECT * FROM sales.order_items WHERE order_id = $1 ORDER BY item_number`, [orderId]);
  const party = await tx.one<Record<string, any>>(`SELECT * FROM registry.parties WHERE id = $1`, [o.party_id]);
  const blocks: OrderBlock[] = [];
  const term = o.payment_term_id ? await tx.maybeOne<{ is_cash: boolean }>(`SELECT is_cash FROM registry.payment_terms WHERE id = $1`, [o.payment_term_id]) : null;
  const credit = !(term?.is_cash ?? false);
  if (party.status === 'blocked') blocks.push({ code: 'cliente_bloqueado', message: `Cliente bloqueado: ${party.block_reason ?? ''}`.trim(), permission: 'vendas.pedido.aprovar' });
  if (credit) {
    // RN-CAD-04: situação cadastral inapta/baixada bloqueia venda a prazo
    if (['inapta', 'baixada'].includes(party.registration_status)) blocks.push({ code: 'situacao_cadastral', message: `CNPJ com situação ${party.registration_status} na Receita: venda a prazo bloqueada`, permission: 'vendas.pedido.aprovar' });
    // RN-VEN-02: limite disponível = limite − (títulos em aberto + pedidos aprovados não faturados)
    const exposure = await tx.one<{ titles: string; orders: string }>(
      `SELECT (SELECT coalesce(sum(balance), 0) FROM finance.titles WHERE party_id = $1 AND kind = 'receivable' AND status IN ('open','partially_paid')) AS titles,
              (SELECT coalesce(sum(i.total * (i.quantity - i.quantity_invoiced - i.quantity_cancelled) / i.quantity), 0)
                 FROM sales.orders so JOIN sales.order_items i ON i.order_id = so.id
                WHERE so.party_id = $1 AND so.id <> $2 AND so.status IN ('approved','separating','partially_invoiced')) AS orders`,
      [o.party_id, orderId]);
    const available = D(party.credit_limit).minus(exposure.titles).minus(exposure.orders);
    if (available.lessThan(o.total)) {
      blocks.push({ code: 'limite_credito', message: `Limite de crédito insuficiente: disponível R$ ${available.toFixed(2)}, pedido R$ ${D(o.total).toFixed(2)}`, permission: 'vendas.pedido.aprovar', value: o.total });
    }
    const settings = (await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [o.company_id])).settings;
    const days = Number(settings?.finance?.overdueBlockDays ?? 5);
    const overdue = await tx.maybeOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM finance.titles WHERE party_id = $1 AND kind = 'receivable' AND status IN ('open','partially_paid') AND due_date < current_date - $2::int`, [o.party_id, days]);
    if (overdue && overdue.n > 0) blocks.push({ code: 'titulo_vencido', message: `Cliente com ${overdue.n} título(s) vencido(s) há mais de ${days} dias`, permission: 'vendas.pedido.aprovar' });
  }
  let maxDiscount = ZERO;
  for (const it of items) {
    const eff = D(effectiveDiscountPercent({ ...it, quantity: it.quantity, listPrice: it.list_price, total: it.total } as never));
    if (eff.greaterThan(maxDiscount)) maxDiscount = eff;
    // RN-PRE-03: venda abaixo do custo ou da margem mínima
    const netUnit = D(it.total).dividedBy(D(it.quantity).times(it.unit_factor));
    const m = await checkMargin(tx, o.establishment_id, it.product_id, netUnit.toFixed(10));
    if (m.belowCost) blocks.push({ code: 'abaixo_custo', message: `Item ${it.item_number} abaixo do custo (custo ${m.cost}, preço ${netUnit.toFixed(2)})`, permission: 'produtos.preco.aprovar' });
    else if (m.belowMinMargin) blocks.push({ code: 'margem_minima', message: `Item ${it.item_number} com margem ${m.marginPercent}% abaixo da mínima ${m.minMarginPercent}%`, permission: 'produtos.preco.aprovar' });
  }
  // Alçada de desconto do vendedor (ex.: vendedor 5%, gerente 15%)
  if (maxDiscount.greaterThan(0)) {
    const lim = await checkLimit(tx, 'vendas.desconto', { percent: maxDiscount });
    if (!lim.allowed) blocks.push({ code: 'desconto_alcada', message: `Desconto de ${maxDiscount.toFixed(2)}% acima da sua alçada (${lim.maxPercent?.toFixed(2) ?? '0'}%)`, permission: 'vendas.pedido.aprovar', value: maxDiscount.toFixed(4) });
  }
  // Estoque insuficiente
  for (const it of items) {
    for (const c of await explodeKit(tx, it.product_id, D(it.quantity).times(it.unit_factor).toFixed(4))) {
      const p = await tx.one<{ controls_stock: boolean; allow_negative_stock: boolean; sku: string }>(`SELECT controls_stock, allow_negative_stock, sku FROM catalog.products WHERE id = $1`, [c.productId]);
      if (!p.controls_stock || p.allow_negative_stock) continue;
      const av = await tx.one<{ a: string | null }>(`SELECT sum(quantity - reserved - blocked) AS a FROM inventory.stock_balances WHERE warehouse_id = $1 AND product_id = $2`, [o.warehouse_id, c.productId]);
      if (D(av.a ?? '0').lessThan(c.quantity)) {
        blocks.push({ code: 'estoque_insuficiente', message: `Estoque insuficiente de ${p.sku}: disponível ${D(av.a ?? '0').toFixed(4)}, pedido ${c.quantity}`, permission: 'vendas.pedido.aprovar' });
        await tx.exec(`INSERT INTO sales.lost_sales (tenant_id, establishment_id, product_id, quantity, order_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tx.tenantId, o.establishment_id, c.productId, D(c.quantity).minus(av.a ?? '0').toFixed(4), orderId, tx.userId]);
      }
    }
  }
  return blocks;
}

/** Envia o pedido: bloqueios viram solicitações de aprovação; sem bloqueio, aprova e reserva. */
export async function submitOrder(tx: Tx, orderId: string) {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido');
  if (o.status !== 'open') throw conflict('INVALID_STATUS', 'Pedido já enviado');
  const blocks = await evaluateBlocks(tx, orderId);
  if (blocks.length) {
    for (const b of blocks) {
      await requestApproval(tx, { entityType: 'sales_order', entityId: orderId, action: 'vendas.pedido', reasonCode: b.code, reason: b.message, value: b.code === 'limite_credito' ? b.value : null, approverPermission: b.permission });
    }
    await tx.exec(`UPDATE sales.orders SET status = 'pending_approval' WHERE id = $1`, [orderId]);
    return { status: 'pending_approval', blocks };
  }
  await approveAndReserve(tx, orderId);
  return { status: 'approved', blocks: [] };
}

async function approveAndReserve(tx: Tx, orderId: string) {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1`, [orderId]);
  const settings = (await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [o.company_id])).settings;
  const hours = Number(settings?.sales?.reservationHours ?? 72);
  const until = new Date(Date.now() + hours * 3_600_000);
  const items = await tx.query<Record<string, any>>(`SELECT * FROM sales.order_items WHERE order_id = $1`, [orderId]);
  for (const it of items) {
    const remaining = D(it.quantity).minus(it.quantity_invoiced).minus(it.quantity_cancelled);
    if (remaining.lessThanOrEqualTo(0)) continue;
    for (const c of await explodeKit(tx, it.product_id, remaining.times(it.unit_factor).toFixed(4))) {
      // Reserva: disponível = físico − reservado (expira se o pedido ficar parado além do prazo)
      await reserve(tx, { warehouseId: o.warehouse_id, productId: c.productId, lotId: c.productId === it.product_id ? it.lot_id : null, quantity: c.quantity,
        sourceType: 'sales_order', sourceId: orderId, sourceItemId: it.id, expiresAt: until });
    }
  }
  await tx.exec(`UPDATE sales.orders SET status = 'approved', reserved_until = $2, approved_at = coalesce(approved_at, now()) WHERE id = $1`, [orderId, until]);
  await emit(tx, 'pedido.aprovado', { type: 'sales_order', id: orderId }, { id: orderId, numero: o.number });
}

onApprovalDecided('sales_order', async (tx, req) => {
  const o = await tx.one<{ status: string }>(`SELECT status FROM sales.orders WHERE id = $1 FOR UPDATE`, [req.entity_id]);
  if (o.status !== 'pending_approval') return;
  if (req.status === 'rejected') {
    await cancelPendingApprovals(tx, 'sales_order', req.entity_id);
    await tx.exec(`UPDATE sales.orders SET status = 'open', notes = coalesce(notes || ' | ', '') || $2 WHERE id = $1`, [req.entity_id, `Reprovado: ${req.reason}`]);
    return;
  }
  if ((await pendingApprovals(tx, 'sales_order', req.entity_id)).length === 0) await approveAndReserve(tx, req.entity_id);
});

/** Edição só antes de faturar (RN-VEN-04). Reenvia para aprovação. */
export async function updateOrderItems(tx: Tx, orderId: string, input: Pick<OrderInput, 'items' | 'discount' | 'freight'> & { version: number }) {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido');
  if (o.version !== input.version) throw conflict('VERSION_CONFLICT', 'Pedido alterado por outra pessoa');
  if (!['open', 'pending_approval', 'approved'].includes(o.status)) throw ruleViolation('RN-VEN-04', 'Pedido faturado (ou em separação) não pode ser alterado');
  await releaseReservations(tx, { sourceType: 'sales_order', sourceId: orderId });
  await cancelPendingApprovals(tx, 'sales_order', orderId);
  const items = await priceItems(tx, { establishmentId: o.establishment_id, partyId: o.party_id, channel: o.channel, discount: input.discount ?? o.discount, items: input.items });
  await tx.exec(`DELETE FROM sales.order_items WHERE order_id = $1`, [orderId]);
  await insertItems(tx, orderId, items);
  const totals = await previewTotals(tx, { establishmentId: o.establishment_id, partyId: o.party_id, operationTypeCode: o.operation_type_code, freight: input.freight ?? o.freight, insurance: o.insurance, otherExpenses: o.other_expenses }, items);
  await tx.exec(`UPDATE sales.orders SET status = 'open', discount = $2, freight = $3, total_products = $4, total_discount = $5, total_estimated_taxes = $6, total = $7 WHERE id = $1`,
    [orderId, input.discount ?? o.discount, input.freight ?? o.freight, totals.products, totals.discount, totals.taxes, totals.total]);
  await submitOrder(tx, orderId);
  return getOrder(tx, orderId);
}

/** RN-VEN-04: cancela o saldo não faturado; pedido faturado exige cancelar ou devolver a nota. */
export async function cancelOrder(tx: Tx, orderId: string, reason: string) {
  await requireReason(tx, reason, 'vendas.pedido.cancelar');
  const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido');
  if (o.status === 'cancelled') throw conflict('INVALID_STATUS', 'Pedido já cancelado');
  const items = await tx.query<Record<string, any>>(`SELECT * FROM sales.order_items WHERE order_id = $1 FOR UPDATE`, [orderId]);
  const invoiced = items.some((i) => D(i.quantity_invoiced).greaterThan(0));
  const pending = items.some((i) => D(i.quantity).minus(i.quantity_invoiced).minus(i.quantity_cancelled).greaterThan(0));
  if (!pending) throw ruleViolation('RN-VEN-04', 'Pedido totalmente faturado: cancele ou devolva a nota fiscal');
  await tx.exec(`UPDATE sales.order_items SET quantity_cancelled = quantity - quantity_invoiced WHERE order_id = $1`, [orderId]);
  await releaseReservations(tx, { sourceType: 'sales_order', sourceId: orderId });
  await cancelPendingApprovals(tx, 'sales_order', orderId);
  await tx.exec(`UPDATE sales.orders SET status = $2, cancel_reason = $3, cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() END WHERE id = $1`,
    [orderId, invoiced ? 'invoiced' : 'cancelled', reason]);
  await emit(tx, 'pedido.cancelado', { type: 'sales_order', id: orderId }, { id: orderId, numero: o.number, motivo: reason, parcial: invoiced });
  return getOrder(tx, orderId);
}

// ---------------------------------------------------------------- etapas do pedido (pedido → entregue)
export const ORDER_STAGES = ['open', 'pending_approval', 'approved', 'to_pick', 'picking', 'checked', 'invoiced', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

/** Última expedição do pedido + etapa calculada (sales.order_stage). Use com o alias `o` para o pedido. */
export const STAGE_JOIN = `LEFT JOIN LATERAL (
    SELECT sh.id AS shipment_id, sh.status AS shipment_status, sh.tracking_code, sh.shipped_at, sh.delivered_at,
           (sh.picking_started_at IS NOT NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements(sh.picking) l WHERE (l->>'checked')::numeric > 0)) AS picking_started
      FROM sales.shipments sh WHERE sh.order_id = o.id ORDER BY sh.created_at DESC LIMIT 1) sh ON true`;
export const STAGE_EXPR = `sales.order_stage(o.status, sh.shipment_status, coalesce(sh.picking_started, false))`;

async function lastShipment(tx: Tx, orderId: string) {
  return tx.maybeOne<Record<string, any>>(`SELECT * FROM sales.shipments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [orderId]);
}

/** Separador começou a separar (Enviado para separação → Em separação). */
export async function startPicking(tx: Tx, orderId: string) {
  const sh = await lastShipment(tx, orderId);
  if (!sh || sh.status !== 'picking') throw conflict('INVALID_STATUS', 'Envie o pedido para separação antes');
  await tx.exec(`UPDATE sales.shipments SET picking_started_at = coalesce(picking_started_at, now()) WHERE id = $1`, [sh.id]);
  return getOrder(tx, orderId);
}

/** Conferência concluída sem leitor (separador confirma que tudo foi separado na quantidade pedida). */
export async function checkAll(tx: Tx, orderId: string, input: { volumes?: number | null; grossWeight?: string | null }) {
  const sh = await lastShipment(tx, orderId);
  if (!sh || !['picking', 'checked'].includes(sh.status)) throw conflict('INVALID_STATUS', 'Pedido não está em separação');
  const picking = (sh.picking as any[]).filter((p) => !p.unexpected).map((p) => ({ ...p, checked: p.quantity }));
  await tx.exec(
    `UPDATE sales.shipments SET picking = $2, divergences = '[]', status = 'checked', picking_started_at = coalesce(picking_started_at, now()), checked_at = now(),
            volumes = coalesce($3, volumes), gross_weight = coalesce($4, gross_weight) WHERE id = $1`,
    [sh.id, JSON.stringify(picking), input.volumes ?? null, input.grossWeight ?? null]);
  return getOrder(tx, orderId);
}

/**
 * Despacho: a mercadoria só sai com a NF-e (o pedido precisa estar faturado). Usa a expedição
 * do pedido ou cria uma já conferida (pedido faturado sem passar pela separação).
 */
export async function shipOrder(tx: Tx, orderId: string, input: { carrierId?: string | null; trackingCode?: string | null; volumes?: number | null }) {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido');
  if (!['invoiced', 'partially_invoiced'].includes(o.status)) {
    throw conflict('INVOICE_REQUIRED', 'Fature o pedido antes de despachar: a mercadoria só pode circular acompanhada da NF-e');
  }
  const doc = await tx.maybeOne<{ id: string }>(
    `SELECT d.id FROM sales.order_invoices oi JOIN fiscal.documents d ON d.id = oi.document_id WHERE oi.order_id = $1 AND NOT oi.undone AND d.status IN ('autorizada', 'contingencia')
      ORDER BY d.created_at DESC LIMIT 1`, [orderId]);
  if (!doc) throw conflict('INVOICE_NOT_AUTHORIZED', 'A NF-e do pedido ainda não foi autorizada: aguarde a autorização para despachar');
  let sh = await lastShipment(tx, orderId);
  if (sh && ['shipped', 'delivered'].includes(sh.status)) throw conflict('INVALID_STATUS', 'Pedido já despachado');
  if (!sh) {
    sh = await tx.one(`INSERT INTO sales.shipments (tenant_id, order_id, status, picking, checked_at, created_by) VALUES ($1,$2,'checked','[]',now(),$3) RETURNING *`,
      [tx.tenantId, orderId, tx.userId]);
  }
  await tx.exec(
    `UPDATE sales.shipments SET status = 'shipped', shipped_at = now(), carrier_id = $2, tracking_code = $3, volumes = coalesce($4, volumes), document_id = $5 WHERE id = $1`,
    [sh!.id, input.carrierId ?? null, input.trackingCode ?? null, input.volumes ?? null, doc.id]);
  await emit(tx, 'pedido.despachado', { type: 'sales_order', id: orderId }, { id: orderId, numero: o.number, rastreio: input.trackingCode ?? null });
  return getOrder(tx, orderId);
}

export async function deliverOrder(tx: Tx, orderId: string, input: { receiverName: string }) {
  const o = await tx.one<Record<string, any>>(`SELECT number FROM sales.orders WHERE id = $1`, [orderId], 'Pedido');
  const sh = await lastShipment(tx, orderId);
  if (!sh || sh.status !== 'shipped') throw conflict('INVALID_STATUS', 'Pedido ainda não foi despachado');
  await tx.exec(`UPDATE sales.shipments SET status = 'delivered', delivered_at = now(), delivery_receiver = $2 WHERE id = $1`, [sh.id, input.receiverName]);
  await emit(tx, 'pedido.entregue', { type: 'sales_order', id: orderId }, { id: orderId, numero: o.number, recebedor: input.receiverName });
  return getOrder(tx, orderId);
}

/** Quantidade e valor de pedidos por etapa (quadro do histórico). */
export async function orderStageCounts(tx: Tx, f: { from: string | null; to: string | null }) {
  return tx.query<{ stage: OrderStage; orders: number; total: string }>(
    `SELECT ${STAGE_EXPR} AS stage, count(*)::int AS orders, coalesce(sum(o.total), 0) AS total
       FROM sales.orders o ${STAGE_JOIN}
      WHERE ($1::uuid IS NULL OR o.company_id = $1) AND ($2::date IS NULL OR o.created_at >= $2) AND ($3::date IS NULL OR o.created_at < $3::date + 1)
        AND ($4::uuid IS NULL OR o.salesperson_id = $4)
      GROUP BY 1`, [tx.ctx.companyId ?? null, f.from, f.to, tx.ctx.ownPortfolioOnly ? tx.ctx.partyId ?? null : null]);
}

export async function getOrder(tx: Tx, id: string) {
  const o = await tx.maybeOne(`SELECT o.*, p.legal_name AS party_name FROM sales.orders o JOIN registry.parties p ON p.id = o.party_id WHERE o.id = $1`, [id]);
  if (!o) throw notFound('Pedido');
  if (tx.ctx.ownPortfolioOnly && tx.ctx.partyId && o.salesperson_id !== tx.ctx.partyId) throw new AppError('FORBIDDEN', 'Pedido fora da sua carteira', 403);
  const items = await tx.query(
    `SELECT i.*, p.sku, p.description, (i.quantity - i.quantity_invoiced - i.quantity_cancelled) AS quantity_to_invoice
       FROM sales.order_items i JOIN catalog.products p ON p.id = i.product_id WHERE i.order_id = $1 ORDER BY i.item_number`, [id]);
  const approvals = await tx.query(`SELECT id, reason_code, reason, status, required_approvals FROM core.approval_requests WHERE entity_type = 'sales_order' AND entity_id = $1 ORDER BY created_at`, [id]);
  const invoices = await tx.query<Record<string, any>>(
    `SELECT d.id, d.number, d.series, d.status, d.access_key, d.total_invoice, d.issued_at, d.authorized_at, oi.kind, oi.undone
       FROM sales.order_invoices oi JOIN fiscal.documents d ON d.id = oi.document_id WHERE oi.order_id = $1 ORDER BY d.created_at`, [id]);
  const shipments = await tx.query<Record<string, any>>(
    `SELECT s.id, s.status, s.picking, s.divergences, s.volumes, s.gross_weight, s.tracking_code, s.created_at, s.picking_started_at, s.checked_at, s.shipped_at, s.delivered_at,
            s.delivery_receiver, c.legal_name AS carrier_name
       FROM sales.shipments s LEFT JOIN registry.parties c ON c.id = s.carrier_id WHERE s.order_id = $1 ORDER BY s.created_at`, [id]);
  const last = shipments.at(-1);
  const started = Boolean(last && (last.picking_started_at || (last.picking as any[]).some((l) => D(l.checked ?? 0).greaterThan(0))));
  const stage = (await tx.one<{ stage: OrderStage }>(`SELECT sales.order_stage($1, $2, $3) AS stage`, [o.status, last?.status ?? null, started])).stage;
  const firstInvoice = invoices.find((d) => !d.undone);
  // Linha do tempo: cada etapa com a data em que aconteceu (null = ainda não)
  const timeline: { stage: OrderStage; at: string | Date | null }[] = [
    { stage: 'open', at: o.created_at },
    { stage: 'approved', at: o.approved_at },
    { stage: 'to_pick', at: last?.created_at ?? null },
    { stage: 'picking', at: last?.picking_started_at ?? null },
    { stage: 'checked', at: last?.checked_at ?? null },
    { stage: 'invoiced', at: firstInvoice ? firstInvoice.authorized_at ?? firstInvoice.issued_at : null },
    { stage: 'shipped', at: last?.shipped_at ?? null },
    { stage: 'delivered', at: last?.delivered_at ?? null },
  ];
  if (o.status === 'cancelled') timeline.push({ stage: 'cancelled', at: o.cancelled_at });
  return { ...o, items, approvals, invoices, shipments, stage, timeline };
}
