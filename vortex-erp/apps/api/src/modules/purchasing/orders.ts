import { D, ZERO, HUNDRED, max, roundMoney, sum } from '@vortex/money';
import { formatCNPJ } from '@vortex/validators';
import type { Tx } from '../../db/tx.js';
import { conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { checkLimit } from '../../core/access.js';
import { cancelPendingApprovals, onApprovalDecided, pendingApprovals, requestApproval } from '../../core/approvals.js';
import { randomToken } from '../../core/crypto.js';
import { renderPdf, type PdfLine } from '../../core/pdf.js';

// ------------------------------------------------------------------ requisição (V1)

export interface RequestInput {
  establishmentId: string;
  costCenterId?: string | null;
  justification: string;
  neededBy?: string | null;
  items: { productId?: string | null; description?: string | null; quantity: string; unit?: string }[];
}

/** Qualquer área pede um item ou serviço, com centro de custo e justificativa. */
export async function createRequest(tx: Tx, input: RequestInput) {
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'purchase_request') AS n`, [est.company_id])).n;
  const r = await tx.one<{ id: string }>(
    `INSERT INTO purchasing.requests (tenant_id, company_id, establishment_id, number, cost_center_id, justification, needed_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tx.tenantId, est.company_id, input.establishmentId, number, input.costCenterId ?? null, input.justification, input.neededBy ?? null, tx.userId]);
  for (const it of input.items) {
    const p = it.productId ? await tx.one<{ description: string; stock_unit: string }>(`SELECT description, stock_unit FROM catalog.products WHERE id = $1`, [it.productId], 'Produto') : null;
    if (!p && !it.description) throw validation({ items: 'Informe o produto ou a descrição do item/serviço' });
    await tx.exec(`INSERT INTO purchasing.request_items (tenant_id, request_id, product_id, description, quantity, unit) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tx.tenantId, r.id, it.productId ?? null, it.description ?? p!.description, it.quantity, it.unit ?? p?.stock_unit ?? 'UN']);
  }
  return getRequest(tx, r.id);
}

export async function getRequest(tx: Tx, id: string) {
  const r = await tx.one(`SELECT * FROM purchasing.requests WHERE id = $1`, [id], 'Requisição');
  return { ...r, items: await tx.query(`SELECT * FROM purchasing.request_items WHERE request_id = $1 ORDER BY description`, [id]) };
}

// ------------------------------------------------------------------ cotação (V1)

export interface RfqInput {
  establishmentId: string;
  requestId?: string | null;
  deadline?: string | null;
  items?: { productId: string; quantity: string; unit?: string }[];
  supplierIds: string[];
}

/** Cotação enviada a vários fornecedores; cada um recebe um link próprio (ou WhatsApp). */
export async function createRfq(tx: Tx, input: RfqInput) {
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  let items = input.items ?? [];
  if (input.requestId) {
    const req = await getRequest(tx, input.requestId);
    if (req.status !== 'open') throw conflict('INVALID_STATUS', 'Requisição já cotada, pedida ou cancelada');
    if (!items.length) {
      items = req.items.filter((i: any) => i.product_id).map((i: any) => ({ productId: i.product_id, quantity: i.quantity, unit: i.unit }));
    }
    await tx.exec(`UPDATE purchasing.requests SET status = 'quoting' WHERE id = $1`, [input.requestId]);
  }
  if (!items.length) throw validation({ items: 'Cotação sem itens' });
  if (!input.supplierIds.length) throw validation({ supplierIds: 'Informe ao menos um fornecedor' });
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'rfq') AS n`, [est.company_id])).n;
  const rfq = await tx.one<{ id: string }>(
    `INSERT INTO purchasing.rfqs (tenant_id, company_id, establishment_id, number, request_id, deadline, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tx.tenantId, est.company_id, input.establishmentId, number, input.requestId ?? null, input.deadline ?? null, tx.userId]);
  for (const it of items) {
    const p = await tx.one<{ stock_unit: string }>(`SELECT stock_unit FROM catalog.products WHERE id = $1`, [it.productId], 'Produto');
    await tx.exec(`INSERT INTO purchasing.rfq_items (tenant_id, rfq_id, product_id, quantity, unit) VALUES ($1,$2,$3,$4,$5)`, [tx.tenantId, rfq.id, it.productId, it.quantity, it.unit ?? p.stock_unit]);
  }
  for (const s of input.supplierIds) {
    await tx.one(`SELECT 1 FROM registry.party_roles WHERE party_id = $1 AND role = 'supplier'`, [s], 'Fornecedor');
    await tx.exec(`INSERT INTO purchasing.rfq_suppliers (tenant_id, rfq_id, supplier_id, token) VALUES ($1,$2,$3,$4)`, [tx.tenantId, rfq.id, s, randomToken(18)]);
  }
  return getRfq(tx, rfq.id);
}

export async function getRfq(tx: Tx, id: string) {
  const rfq = await tx.one(`SELECT * FROM purchasing.rfqs WHERE id = $1`, [id], 'Cotação');
  const items = await tx.query(`SELECT ri.*, p.sku, p.description FROM purchasing.rfq_items ri JOIN catalog.products p ON p.id = ri.product_id WHERE rfq_id = $1 ORDER BY p.sku`, [id]);
  const suppliers = await tx.query(
    `SELECT s.id, s.supplier_id, p.legal_name, s.freight, s.freight_mode, s.payment_terms, s.responded_at, s.token,
            '/public/rfq/' || s.token || '?tenant=' || s.tenant_id AS link
       FROM purchasing.rfq_suppliers s JOIN registry.parties p ON p.id = s.supplier_id WHERE s.rfq_id = $1 ORDER BY p.legal_name`, [id]);
  return { ...rfq, items, suppliers };
}

export interface RfqResponseInput {
  items: { rfqItemId: string; unitPrice: string; leadTimeDays?: number | null }[];
  freight?: string | null;
  freightMode?: number | null;
  paymentTerms?: string | null;
}

/** Resposta do fornecedor pelo link (sem login): preço por item, prazo, frete e condição. */
export async function respondRfq(tx: Tx, token: string, input: RfqResponseInput) {
  const s = await tx.maybeOne<{ id: string; rfq_id: string }>(`SELECT id, rfq_id FROM purchasing.rfq_suppliers WHERE token = $1`, [token]);
  if (!s) throw notFound('Cotação');
  const rfq = await tx.one<{ status: string; deadline: Date | null }>(`SELECT status, deadline FROM purchasing.rfqs WHERE id = $1`, [s.rfq_id]);
  if (rfq.status !== 'open') throw conflict('RFQ_CLOSED', 'Cotação encerrada');
  if (rfq.deadline && new Date(rfq.deadline).getTime() < Date.now()) throw conflict('RFQ_EXPIRED', 'Prazo da cotação encerrado');
  for (const it of input.items) {
    await tx.one(`SELECT 1 FROM purchasing.rfq_items WHERE id = $1 AND rfq_id = $2`, [it.rfqItemId, s.rfq_id], 'Item da cotação');
    await tx.exec(
      `INSERT INTO purchasing.rfq_responses (tenant_id, rfq_supplier_id, rfq_item_id, unit_price, lead_time_days) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (rfq_supplier_id, rfq_item_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, lead_time_days = EXCLUDED.lead_time_days`,
      [tx.tenantId, s.id, it.rfqItemId, it.unitPrice, it.leadTimeDays ?? null]);
  }
  await tx.exec(`UPDATE purchasing.rfq_suppliers SET freight = $2, freight_mode = $3, payment_terms = $4, responded_at = now() WHERE id = $1`,
    [s.id, input.freight ?? null, input.freightMode ?? null, input.paymentTerms ?? null]);
  return { ok: true };
}

/** Mapa comparativo por preço, prazo, frete e condição; melhor por item e melhor global. */
export async function rfqMap(tx: Tx, rfqId: string) {
  const rfq = await getRfq(tx, rfqId);
  const responses = await tx.query<{ rfq_supplier_id: string; rfq_item_id: string; unit_price: string; lead_time_days: number | null }>(
    `SELECT r.* FROM purchasing.rfq_responses r JOIN purchasing.rfq_suppliers s ON s.id = r.rfq_supplier_id WHERE s.rfq_id = $1`, [rfqId]);
  const items = rfq.items.map((it: any) => {
    const offers = rfq.suppliers.map((s: any) => {
      const r = responses.find((x) => x.rfq_supplier_id === s.id && x.rfq_item_id === it.id);
      return r ? { supplierId: s.supplier_id, supplierName: s.legal_name, unitPrice: r.unit_price, leadTimeDays: r.lead_time_days, total: roundMoney(D(r.unit_price).times(it.quantity)).toFixed(2) } : null;
    }).filter(Boolean) as { supplierId: string; supplierName: string; unitPrice: string; leadTimeDays: number | null; total: string }[];
    const best = offers.reduce<(typeof offers)[number] | null>((b, o) => (!b || D(o.unitPrice).lessThan(b.unitPrice) || (D(o.unitPrice).equals(b.unitPrice) && (o.leadTimeDays ?? 999) < (b.leadTimeDays ?? 999)) ? o : b), null);
    return { rfqItemId: it.id, productId: it.product_id, sku: it.sku, description: it.description, quantity: it.quantity, unit: it.unit, offers, bestSupplierId: best?.supplierId ?? null };
  });
  const suppliers = rfq.suppliers.map((s: any) => {
    const mine = items.map((i: any) => i.offers.find((o: any) => o.supplierId === s.supplier_id)).filter(Boolean);
    const complete = mine.length === items.length;
    const products = sum(mine.map((o: any) => o.total));
    return { supplierId: s.supplier_id, supplierName: s.legal_name, responded: !!s.responded_at, complete, products: products.toFixed(2), freight: s.freight ?? '0.00',
      total: products.plus(s.freight ?? 0).toFixed(2), paymentTerms: s.payment_terms, maxLeadTimeDays: Math.max(0, ...mine.map((o: any) => o.leadTimeDays ?? 0)) };
  });
  const bestGlobal = suppliers.filter((s: any) => s.complete).sort((a: any, b: any) => D(a.total).comparedTo(b.total))[0] ?? null;
  return { rfq: { id: rfq.id, number: rfq.number, status: rfq.status }, items, suppliers, bestGlobalSupplierId: bestGlobal?.supplierId ?? null };
}

/** Escolha por item (cada item com o fornecedor indicado ou o melhor preço) ou global: gera os pedidos em rascunho. */
export async function awardRfq(tx: Tx, rfqId: string, input: { mode: 'item' | 'global'; supplierId?: string | null; selections?: { rfqItemId: string; supplierId: string }[];
  warehouseId?: string | null; paymentTermId?: string | null; costCenterId?: string | null }) {
  const map = await rfqMap(tx, rfqId);
  if (map.rfq.status !== 'open') throw conflict('RFQ_CLOSED', 'Cotação encerrada');
  const rfq = await tx.one<{ establishment_id: string; request_id: string | null }>(`SELECT establishment_id, request_id FROM purchasing.rfqs WHERE id = $1`, [rfqId]);
  const chosen = new Map<string, { item: (typeof map.items)[number]; unitPrice: string }[]>();
  for (const it of map.items) {
    const supplierId = input.mode === 'global' ? (input.supplierId ?? map.bestGlobalSupplierId)
      : (input.selections?.find((s) => s.rfqItemId === it.rfqItemId)?.supplierId ?? it.bestSupplierId);
    if (!supplierId) throw validation({ rfqItemId: `Item ${it.sku} sem proposta para escolher` });
    const offer = it.offers.find((o: { supplierId: string; unitPrice: string }) => o.supplierId === supplierId);
    if (!offer) throw validation({ supplierId: `Fornecedor sem proposta para o item ${it.sku}` });
    chosen.set(supplierId, [...(chosen.get(supplierId) ?? []), { item: it, unitPrice: offer.unitPrice }]);
    await tx.exec(`UPDATE purchasing.rfq_responses r SET selected = true FROM purchasing.rfq_suppliers s
                    WHERE s.id = r.rfq_supplier_id AND s.rfq_id = $1 AND s.supplier_id = $2 AND r.rfq_item_id = $3`, [rfqId, supplierId, it.rfqItemId]);
  }
  const orders = [];
  for (const [supplierId, lines] of chosen) {
    const sup = map.suppliers.find((s: any) => s.supplierId === supplierId)!;
    orders.push(await createPurchaseOrder(tx, {
      establishmentId: rfq.establishment_id, warehouseId: input.warehouseId, supplierId, rfqId, paymentTermId: input.paymentTermId, costCenterId: input.costCenterId,
      freight: chosen.size === 1 || input.mode === 'global' ? sup.freight : '0', notes: sup.paymentTerms ? `Condição proposta pelo fornecedor: ${sup.paymentTerms}` : null,
      items: lines.map((l) => ({ productId: l.item.productId, quantity: l.item.quantity, unitPrice: l.unitPrice })),
    }));
  }
  await tx.exec(`UPDATE purchasing.rfqs SET status = 'closed' WHERE id = $1`, [rfqId]);
  if (rfq.request_id) await tx.exec(`UPDATE purchasing.requests SET status = 'ordered' WHERE id = $1`, [rfq.request_id]);
  return orders;
}

// ------------------------------------------------------------------ pedido de compra (MVP)

export interface PurchaseOrderInput {
  establishmentId: string;
  warehouseId?: string | null;
  supplierId: string;
  rfqId?: string | null;
  freightMode?: number;
  freight?: string | null;
  paymentTermId?: string | null;
  expectedDate?: string | null;
  costCenterId?: string | null;
  categoryId?: string | null;
  notes?: string | null;
  items: { productId: string; quantity: string; unitPrice: string; ipiRate?: string | null; requestItemId?: string | null }[];
  idempotencyKey?: string | null;
}

export async function createPurchaseOrder(tx: Tx, input: PurchaseOrderInput) {
  if (input.idempotencyKey) {
    const ex = await tx.maybeOne<{ id: string }>(`SELECT id FROM purchasing.orders WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (ex) return getPurchaseOrder(tx, ex.id);
  }
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  await tx.one(`SELECT 1 FROM registry.party_roles WHERE party_id = $1 AND role = 'supplier'`, [input.supplierId], 'Fornecedor');
  const supplier = await tx.one<{ status: string }>(`SELECT status FROM registry.parties WHERE id = $1`, [input.supplierId]);
  if (supplier.status !== 'active') throw ruleViolation('RN-CAD', 'Fornecedor bloqueado ou inativo não recebe pedido');
  const warehouseId = input.warehouseId
    ?? (await tx.one<{ id: string }>(`SELECT id FROM core.warehouses WHERE establishment_id = $1 AND kind = 'own' AND active ORDER BY (code = 'PRINCIPAL') DESC, code LIMIT 1`,
      [input.establishmentId], 'Depósito')).id;
  const category = input.categoryId ?? (await tx.maybeOne<{ category_id: string | null }>(`SELECT category_id FROM fiscal.operation_types WHERE code = 'COMPRA'`))?.category_id ?? null;
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'purchase_order') AS n`, [est.company_id])).n;
  const o = await tx.one<{ id: string }>(
    `INSERT INTO purchasing.orders (tenant_id, company_id, establishment_id, warehouse_id, number, supplier_id, rfq_id, freight_mode, freight, payment_term_id, expected_date,
       cost_center_id, category_id, notes, idempotency_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [tx.tenantId, est.company_id, input.establishmentId, warehouseId, number, input.supplierId, input.rfqId ?? null, input.freightMode ?? 0, input.freight ?? '0',
      input.paymentTermId ?? null, input.expectedDate ?? null, input.costCenterId ?? null, category, input.notes ?? null, input.idempotencyKey ?? null, tx.userId]);
  await writeItems(tx, o.id, input.items);
  return getPurchaseOrder(tx, o.id);
}

async function writeItems(tx: Tx, orderId: string, items: PurchaseOrderInput['items']) {
  if (!items.length) throw validation({ items: 'Pedido sem itens' });
  await tx.exec(`DELETE FROM purchasing.order_items WHERE order_id = $1`, [orderId]);
  let products = ZERO;
  let ipi = ZERO;
  for (const [i, it] of items.entries()) {
    const p = await tx.one<{ ipi_rate: string | null; kind: string }>(
      `SELECT n.ipi_rate, p.kind FROM catalog.products p LEFT JOIN fiscal.ncm n ON n.code = p.ncm AND n.valid_from <= current_date AND (n.valid_to IS NULL OR n.valid_to >= current_date) WHERE p.id = $1`, [it.productId], 'Produto');
    const total = roundMoney(D(it.quantity).times(it.unitPrice));
    // Imposto previsto: IPI pela alíquota informada ou da TIPI do NCM
    const rate = it.ipiRate ?? p.ipi_rate ?? '0';
    products = products.plus(total);
    ipi = ipi.plus(roundMoney(total.times(rate).dividedBy(HUNDRED)));
    await tx.exec(
      `INSERT INTO purchasing.order_items (tenant_id, order_id, item_number, product_id, quantity, unit_price, ipi_rate, total, request_item_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tx.tenantId, orderId, i + 1, it.productId, it.quantity, it.unitPrice, rate, total.toFixed(2), it.requestItemId ?? null]);
  }
  await tx.exec(`UPDATE purchasing.orders SET total_products = $2, total_estimated_taxes = $3, total = $2::numeric + $3::numeric + freight WHERE id = $1`,
    [orderId, products.toFixed(2), ipi.toFixed(2)]);
}

export async function updatePurchaseOrder(tx: Tx, orderId: string, input: Partial<PurchaseOrderInput> & { version: number }) {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM purchasing.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido de compra');
  if (o.version !== input.version) throw conflict('VERSION_CONFLICT', 'Pedido alterado por outra pessoa');
  if (!['draft', 'pending_approval'].includes(o.status)) throw ruleViolation('RN-COM', 'Pedido aprovado não se altera: cancele o saldo e emita outro');
  await tx.exec(
    `UPDATE purchasing.orders SET freight_mode = coalesce($2, freight_mode), freight = coalesce($3, freight), payment_term_id = coalesce($4, payment_term_id),
            expected_date = coalesce($5, expected_date), cost_center_id = coalesce($6, cost_center_id), notes = coalesce($7, notes), status = 'draft' WHERE id = $1`,
    [orderId, input.freightMode ?? null, input.freight ?? null, input.paymentTermId ?? null, input.expectedDate ?? null, input.costCenterId ?? null, input.notes ?? null]);
  if (input.items) await writeItems(tx, orderId, input.items);
  else await tx.exec(`UPDATE purchasing.orders SET total = total_products + total_estimated_taxes + freight WHERE id = $1`, [orderId]);
  // Alteração invalida aprovações pendentes: o pedido volta a ser enviado
  await cancelPendingApprovals(tx, 'purchase_order', orderId);
  return getPurchaseOrder(tx, orderId);
}

/**
 * Aprovação por alçada de valor e centro de custo (seção 11). Dentro da alçada do
 * usuário, o pedido é aprovado na hora; acima dela, vai para aprovação. Uma política
 * "compras.pedido.cc.<CÓDIGO>" define aprovadores e número de aprovações por centro de custo.
 */
export async function submitPurchaseOrder(tx: Tx, orderId: string) {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM purchasing.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido de compra');
  if (o.status !== 'draft') throw conflict('INVALID_STATUS', 'Pedido já enviado para aprovação');
  const cc = o.cost_center_id ? await tx.maybeOne<{ code: string }>(`SELECT code FROM finance.cost_centers WHERE id = $1`, [o.cost_center_id]) : null;
  const ccAction = cc ? `compras.pedido.cc.${cc.code}` : null;
  const ccPolicy = ccAction ? await tx.maybeOne(`SELECT 1 FROM core.approval_policies WHERE action = $1 AND min_value <= $2::numeric LIMIT 1`, [ccAction, o.total]) : null;
  const limit = await checkLimit(tx, 'compras.pedido', { value: o.total });
  if (limit.allowed && !ccPolicy) {
    await approve(tx, orderId);
    return { status: 'approved', approvals: [] };
  }
  const req = await requestApproval(tx, {
    entityType: 'purchase_order', entityId: orderId, action: ccPolicy ? ccAction! : 'compras.pedido', reasonCode: 'alcada', value: o.total,
    reason: `Pedido de compra ${o.number} de ${D(o.total).toFixed(2)}${limit.maxValue ? ` acima da alçada (${limit.maxValue.toFixed(2)})` : ''}${cc ? ` · centro de custo ${cc.code}` : ''}`,
    approverPermission: 'compras.pedido.aprovar',
  });
  await tx.exec(`UPDATE purchasing.orders SET status = 'pending_approval' WHERE id = $1`, [orderId]);
  return { status: 'pending_approval', approvals: [req] };
}

async function approve(tx: Tx, orderId: string) {
  const o = await tx.one<{ number: string; total: string; supplier_id: string }>(`UPDATE purchasing.orders SET status = 'approved' WHERE id = $1 RETURNING number, total, supplier_id`, [orderId]);
  await emit(tx, 'compra.pedido_aprovado', { type: 'purchase_order', id: orderId }, { id: orderId, numero: o.number, valor: o.total, fornecedor: o.supplier_id });
}

onApprovalDecided('purchase_order', async (tx, req) => {
  const o = await tx.one<{ status: string }>(`SELECT status FROM purchasing.orders WHERE id = $1 FOR UPDATE`, [req.entity_id]);
  if (o.status !== 'pending_approval') return;
  if (req.status === 'rejected') {
    await cancelPendingApprovals(tx, 'purchase_order', req.entity_id);
    await tx.exec(`UPDATE purchasing.orders SET status = 'draft', notes = coalesce(notes || ' | ', '') || $2 WHERE id = $1`, [req.entity_id, `Reprovado: ${req.reason}`]);
    return;
  }
  if ((await pendingApprovals(tx, 'purchase_order', req.entity_id)).length === 0) await approve(tx, req.entity_id);
});

/** Cancela o pedido (ou o saldo não recebido, se já houve recebimento parcial). */
export async function cancelPurchaseOrder(tx: Tx, orderId: string, reason: string) {
  const o = await tx.one<Record<string, any>>(`SELECT * FROM purchasing.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido de compra');
  if (['received', 'cancelled'].includes(o.status)) throw conflict('INVALID_STATUS', 'Pedido já encerrado');
  const open = await tx.maybeOne(`SELECT 1 FROM purchasing.receipts WHERE order_id = $1 AND status NOT IN ('completed','cancelled')`, [orderId]);
  if (open) throw conflict('RECEIPT_IN_PROGRESS', 'Há recebimento em andamento para este pedido');
  await tx.exec(`UPDATE purchasing.order_items SET quantity_cancelled = quantity - quantity_received WHERE order_id = $1`, [orderId]);
  await cancelPendingApprovals(tx, 'purchase_order', orderId);
  const status = o.status === 'partially_received' ? 'received' : 'cancelled';
  await tx.exec(`UPDATE purchasing.orders SET status = $2, notes = coalesce(notes || ' | ', '') || $3 WHERE id = $1`, [orderId, status, `Cancelado: ${reason}`]);
  return getPurchaseOrder(tx, orderId);
}

export async function refreshPurchaseOrderStatus(tx: Tx, orderId: string) {
  const r = await tx.one<{ pending: string; received: string }>(
    `SELECT sum(greatest(quantity - quantity_received - quantity_cancelled, 0)) AS pending, sum(quantity_received) AS received FROM purchasing.order_items WHERE order_id = $1`, [orderId]);
  const status = D(r.pending ?? '0').lessThanOrEqualTo(0) ? 'received' : D(r.received ?? '0').greaterThan(0) ? 'partially_received' : null;
  if (status) await tx.exec(`UPDATE purchasing.orders SET status = $2 WHERE id = $1 AND status IN ('approved','partially_received')`, [orderId, status]);
}

export async function getPurchaseOrder(tx: Tx, id: string) {
  const o = await tx.maybeOne(`SELECT o.*, p.legal_name AS supplier_name FROM purchasing.orders o JOIN registry.parties p ON p.id = o.supplier_id WHERE o.id = $1`, [id]);
  if (!o) throw notFound('Pedido de compra');
  const items = await tx.query(
    `SELECT i.*, p.sku, p.description, p.stock_unit, i.quantity - i.quantity_received - i.quantity_cancelled AS quantity_pending
       FROM purchasing.order_items i JOIN catalog.products p ON p.id = i.product_id WHERE order_id = $1 ORDER BY item_number`, [id]);
  const approvals = await tx.query(`SELECT * FROM core.approval_requests WHERE entity_type = 'purchase_order' AND entity_id = $1 ORDER BY created_at`, [id]);
  return { ...o, items, approvals };
}

/** Pedido em PDF para enviar ao fornecedor. */
export async function purchaseOrderPdf(tx: Tx, id: string): Promise<Buffer> {
  const o = await getPurchaseOrder(tx, id);
  if (!['approved', 'partially_received', 'received'].includes(o.status)) throw ruleViolation('RN-COM', 'Somente pedido aprovado é enviado ao fornecedor');
  const est = await tx.one(`SELECT * FROM core.establishments WHERE id = $1`, [o.establishment_id]);
  const sup = await tx.one(`SELECT legal_name, tax_id FROM registry.parties WHERE id = $1`, [o.supplier_id]);
  const term = o.payment_term_id ? await tx.maybeOne<{ name: string }>(`SELECT name FROM registry.payment_terms WHERE id = $1`, [o.payment_term_id]) : null;
  const money = (v: string) => D(v).toFixed(2).replace('.', ',');
  const lines: PdfLine[] = [
    { text: `PEDIDO DE COMPRA Nº ${o.number}`, size: 16, bold: true },
    { text: `${est.legal_name} · CNPJ ${formatCNPJ(est.cnpj)} · IE ${est.ie ?? ''}` },
    { text: `${est.street}, ${est.number} · ${est.district} · ${est.city_name}/${est.uf} · CEP ${est.zip}` },
    { text: ' ' },
    { text: `Fornecedor: ${sup.legal_name}${sup.tax_id ? ` · ${sup.tax_id.length === 14 ? formatCNPJ(sup.tax_id) : sup.tax_id}` : ''}`, bold: true },
    { text: `Emissão: ${new Date(o.created_at).toLocaleDateString('pt-BR')}   Previsão de entrega: ${o.expected_date ? new Date(`${o.expected_date}T12:00:00Z`).toLocaleDateString('pt-BR') : 'a combinar'}` },
    { text: `Frete: ${o.freight_mode === 1 ? 'FOB (por conta do destinatário)' : 'CIF (por conta do remetente)'}   Condição de pagamento: ${term?.name ?? 'a combinar'}` },
    { text: ' ' },
    { text: 'Item  Código           Descrição                                   Qtd        Un   Preço unit.      Total', bold: true, size: 9 },
    ...o.items.map((i: any) => ({ size: 9, text: `${String(i.item_number).padEnd(5)} ${String(i.sku).padEnd(16).slice(0, 16)} ${String(i.description).padEnd(42).slice(0, 42)} ${D(i.quantity).toString().padStart(8)} ${String(i.stock_unit).padEnd(4)} ${money(i.unit_price).padStart(12)} ${money(i.total).padStart(12)}` })),
    { text: ' ' },
    { text: `Produtos: R$ ${money(o.total_products)}   IPI previsto: R$ ${money(o.total_estimated_taxes)}   Frete: R$ ${money(o.freight)}` },
    { text: `TOTAL DO PEDIDO: R$ ${money(o.total)}`, bold: true, size: 12 },
    { text: ' ' },
    { text: `Informe na NF-e o número deste pedido (xPed = ${o.number}). Divergência de preço ou quantidade bloqueia o recebimento.`, size: 8 },
    ...(o.notes ? [{ text: `Observações: ${o.notes}`, size: 8 }] : []),
  ];
  return renderPdf(lines, `Pedido de compra ${o.number}`);
}

// ------------------------------------------------------------------ sugestão de compra (V1)

/**
 * Itens abaixo do ponto de pedido considerando saldo disponível, pedidos de compra em
 * aberto, consumo médio (90 dias) e prazo do fornecedor.
 */
export async function purchaseSuggestion(tx: Tx, warehouseId: string, days = 90) {
  const rows = await tx.query<{ product_id: string; sku: string; description: string; min_qty: string; max_qty: string | null; reorder_point: string; available: string | null;
    on_order: string | null; consumed: string | null; supplier_id: string | null; supplier_name: string | null; lead_time_days: number | null; min_lot: string | null; last_price: string | null }>(
    `SELECT sp.product_id, p.sku, p.description, sp.min_qty, sp.max_qty, sp.reorder_point,
            (SELECT sum(quantity - reserved - blocked) FROM inventory.stock_balances b WHERE b.warehouse_id = sp.warehouse_id AND b.product_id = sp.product_id) AS available,
            (SELECT sum(i.quantity - i.quantity_received - i.quantity_cancelled) FROM purchasing.order_items i JOIN purchasing.orders o ON o.id = i.order_id
              WHERE o.warehouse_id = sp.warehouse_id AND i.product_id = sp.product_id AND o.status IN ('draft','pending_approval','approved','partially_received')) AS on_order,
            (SELECT sum(quantity) FROM inventory.stock_movements m WHERE m.warehouse_id = sp.warehouse_id AND m.product_id = sp.product_id
              AND m.movement_type IN ('sale_out','production_consume','internal_use') AND m.occurred_at >= now() - make_interval(days => $2)) AS consumed,
            ps.supplier_id, sup.legal_name AS supplier_name, ps.lead_time_days, ps.min_lot, ps.last_price
       FROM catalog.stock_params sp JOIN catalog.products p ON p.id = sp.product_id
       LEFT JOIN LATERAL (SELECT * FROM catalog.product_suppliers x WHERE x.product_id = sp.product_id ORDER BY x.last_purchase_at DESC NULLS LAST LIMIT 1) ps ON true
       LEFT JOIN registry.parties sup ON sup.id = ps.supplier_id
      WHERE sp.warehouse_id = $1 AND p.status = 'active'`, [warehouseId, days]);
  const out = [];
  for (const r of rows) {
    const available = D(r.available ?? '0');
    const onOrder = D(r.on_order ?? '0');
    const daily = D(r.consumed ?? '0').dividedBy(days);
    const lead = r.lead_time_days ?? 7;
    const duringLead = daily.times(lead);
    const projected = available.plus(onOrder).minus(duringLead);
    if (projected.greaterThan(r.reorder_point)) continue;
    const target = max(max(D(r.max_qty ?? D(r.reorder_point).times(2)), D(r.reorder_point).plus(duringLead)), D(r.min_qty));
    let qty = target.minus(available.plus(onOrder));
    if (qty.lessThanOrEqualTo(0)) continue;
    if (r.min_lot && D(r.min_lot).greaterThan(0)) qty = qty.dividedBy(r.min_lot).ceil().times(r.min_lot);
    out.push({
      productId: r.product_id, sku: r.sku, description: r.description, available: available.toFixed(4), onOrder: onOrder.toFixed(4), dailyConsumption: daily.toFixed(4),
      leadTimeDays: lead, reorderPoint: r.reorder_point, suggestedQuantity: qty.ceil().toFixed(4), supplierId: r.supplier_id, supplierName: r.supplier_name, lastPrice: r.last_price,
      estimatedTotal: r.last_price ? roundMoney(qty.ceil().times(r.last_price)).toFixed(2) : null,
    });
  }
  return out;
}
