import { D, ZERO, HUNDRED, allocate, roundMoney, sum, min } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { pendingApprovals } from '../../core/approvals.js';
import { allocateFefo, explodeKit, postMovement, reverseMovement } from '../inventory/stock.js';
import { consumePromotions } from '../catalog/pricing.js';
import { createOutgoingDocument, createReturnDocument, prepareForTransmission, registerDocumentHooks, type DocRow } from '../fiscal-docs/documents.js';
import { abateTitle, cancelTitlesOfOrigin, createTitles, installmentsFromTerm, provisionSplitPayment, settleTitle } from '../finance/titles.js';
import { postEvent, reverseEntries } from '../accounting/posting.js';
import { subscribe } from '../../worker/registry.js';

export interface InvoiceInput {
  /** Faturamento parcial: quantidades por item do pedido; omitido = todo o saldo (RN-VEN-01) */
  items?: { orderItemId: string; quantity: string }[];
  date?: string;
  volumes?: { quantity: number; kind: string; grossWeight?: string; netWeight?: string }[];
  additionalInfo?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Faturamento (seção 10): gera a NF-e (total ou parcial), baixa o estoque, gera os
 * títulos a receber e o lançamento contábil — tudo numa única transação. A
 * transmissão à SEFAZ acontece depois do commit (FiscalGateway).
 */
export async function invoiceOrder(tx: Tx, orderId: string, input: InvoiceInput = {}): Promise<{ document: DocRow; titles: string[] }> {
  if (input.idempotencyKey) {
    const ex = await tx.maybeOne<DocRow>(`SELECT * FROM fiscal.documents WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (ex) return { document: ex, titles: (await tx.query(`SELECT id FROM finance.titles WHERE origin_id = $1`, [ex.id])).map((t) => t.id) };
  }
  const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido');
  if (!['approved', 'separating', 'partially_invoiced'].includes(o.status)) throw conflict('INVALID_STATUS', `Pedido em situação "${o.status}" não pode ser faturado`);
  if ((await pendingApprovals(tx, 'sales_order', orderId)).length) throw ruleViolation('RN-VEN-02', 'Pedido com bloqueios pendentes de aprovação');
  const items = await tx.query<Record<string, any>>(`SELECT * FROM sales.order_items WHERE order_id = $1 ORDER BY item_number FOR UPDATE`, [orderId]);
  const date = input.date ?? new Date().toISOString().slice(0, 10);

  // Quantidades a faturar
  const selected: { item: Record<string, any>; qty: string }[] = [];
  for (const it of items) {
    const remaining = D(it.quantity).minus(it.quantity_invoiced).minus(it.quantity_cancelled);
    const req = input.items ? input.items.find((x) => x.orderItemId === it.id) : null;
    const qty = input.items ? (req ? D(req.quantity) : ZERO) : remaining;
    if (qty.isZero()) continue;
    if (qty.greaterThan(remaining)) throw ruleViolation('RN-VEN-01', `Item ${it.item_number}: quantidade a faturar (${qty.toFixed(4)}) maior que o saldo (${remaining.toFixed(4)})`);
    selected.push({ item: it, qty: qty.toFixed(4) });
  }
  if (!selected.length) throw validation({ items: 'Nada a faturar' });

  // Proporção do pedido faturada (para frete/seguro/outras do cabeçalho)
  const orderGross = sum(items.map((i) => i.total));
  const thisGross = sum(selected.map((s) => D(s.item.total).times(s.qty).dividedBy(s.item.quantity)));
  const fraction = orderGross.isZero() ? D(1) : thisGross.dividedBy(orderGross);
  const pm = o.payment_method_id ? await tx.maybeOne<Record<string, any>>(`SELECT * FROM registry.payment_methods WHERE id = $1`, [o.payment_method_id]) : null;
  const term = o.payment_term_id ? await tx.maybeOne<{ is_cash: boolean }>(`SELECT is_cash FROM registry.payment_terms WHERE id = $1`, [o.payment_term_id]) : null;
  const opType = await tx.one<Record<string, any>>(`SELECT * FROM fiscal.operation_types WHERE code = $1`, [o.operation_type_code]);

  const doc = await createOutgoingDocument(tx, {
    establishmentId: o.establishment_id, operationTypeCode: o.operation_type_code, model: '55', partyId: o.party_id, date, presence: o.channel === 'counter' ? 1 : o.channel === 'ecommerce' || o.channel === 'marketplace' ? 2 : 9,
    header: { freight: roundMoney(D(o.freight).times(fraction)).toFixed(2), insurance: roundMoney(D(o.insurance).times(fraction)).toFixed(2), otherExpenses: roundMoney(D(o.other_expenses).times(fraction)).toFixed(2) },
    items: selected.map(({ item, qty }) => {
      const ratio = D(qty).dividedBy(item.quantity);
      return {
        id: item.id, productId: item.product_id, quantity: qty, unit: item.unit, unitPrice: item.unit_price,
        discount: roundMoney(D(item.item_discount).plus(item.header_discount_share).times(ratio)).toFixed(2), warehouseId: o.warehouse_id, sourceItemId: item.id,
      };
    }),
    freightMode: o.freight_mode, carrierId: o.carrier_id, volumes: input.volumes, additionalInfo: [input.additionalInfo, o.customer_order_ref ? `Pedido do cliente: ${o.customer_order_ref}` : null, `Pedido VORTEX nº ${o.number}`].filter(Boolean).join(' | '),
    sourceType: 'sales_order', sourceId: orderId, idempotencyKey: input.idempotencyKey ?? null,
    payments: [],
  });

  // Títulos a receber: parcelas pela condição de pagamento (RN-FIN-08: cartão gera título contra a adquirente)
  const titles: string[] = [];
  let receivableTotal = ZERO;
  if (opType.generates_financial) {
    const total = D(doc.total_invoice);
    receivableTotal = total;
    if (pm && ['credit_card', 'debit_card'].includes(pm.kind) && pm.acquirer_party_id) {
      const fee = roundMoney(total.times(pm.fee_percent).dividedBy(HUNDRED));
      const due = new Date(`${date}T12:00:00Z`);
      due.setUTCDate(due.getUTCDate() + Number(pm.settlement_days));
      const t = await createTitles(tx, {
        kind: 'receivable', partyId: pm.acquirer_party_id, establishmentId: o.establishment_id, originType: 'sales_invoice', originId: doc.id, fiscalDocumentId: doc.id,
        documentNumber: `NF${doc.series}-${doc.id.slice(0, 8)}`, issueDate: date, installments: [{ dueDate: due.toISOString().slice(0, 10), amount: total.minus(fee).toFixed(2) }],
        categoryId: opType.category_id, paymentMethodId: pm.id, accountId: pm.financial_account_id, card: { grossAmount: total.toFixed(2), feeAmount: fee.toFixed(2) },
      });
      titles.push(...t.map((x) => x.id));
    } else {
      const inst = await installmentsFromTerm(tx, o.payment_term_id, total.toFixed(2), date);
      const t = await createTitles(tx, {
        kind: 'receivable', partyId: o.party_id, establishmentId: o.establishment_id, originType: 'sales_invoice', originId: doc.id, fiscalDocumentId: doc.id,
        documentNumber: `NF${doc.series}-${doc.id.slice(0, 8)}`, issueDate: date, installments: inst, categoryId: opType.category_id,
        paymentMethodId: pm?.id ?? null, accountId: pm?.financial_account_id ?? null,
      });
      titles.push(...t.map((x) => x.id));
      // À vista em dinheiro/Pix no balcão: já entra baixado no caixa
      if (term?.is_cash && pm && ['cash', 'pix'].includes(pm.kind) && pm.financial_account_id) {
        for (const ti of t) await settleTitle(tx, ti.id, { date, accountId: pm.financial_account_id, amount: ti.amount, method: pm.kind, reference: `NF ${doc.id.slice(0, 8)}` });
      }
    }
    const inst = await tx.query<{ installment: number; due_date: string; amount: string }>(`SELECT installment, due_date, amount FROM finance.titles WHERE origin_id = $1 ORDER BY installment`, [doc.id]);
    const tPag = pm?.nfe_tpag ?? (term?.is_cash ? '01' : '15');
    await tx.exec(`UPDATE fiscal.documents SET payments = $2, installments = $3 WHERE id = $1`, [doc.id,
      JSON.stringify([{ tPag, value: doc.total_invoice, indPag: term?.is_cash ? 0 : 1 }]),
      JSON.stringify(term?.is_cash ? [] : inst.map((i) => ({ number: String(i.installment).padStart(3, '0'), dueDate: i.due_date, amount: i.amount })))]);
  } else {
    await tx.exec(`UPDATE fiscal.documents SET payments = '[{"tPag":"90","value":"0.00"}]' WHERE id = $1`, [doc.id]);
  }

  await provisionSplitPayment(tx, doc.company_id, titles, D(doc.total_ibs ?? 0).plus(doc.total_cbs ?? 0).toFixed(2));

  // Baixa de estoque (kits baixam componentes; lote por FEFO quando o produto controla lote)
  const cmv = opType.moves_stock ? await issueStock(tx, o, orderId, doc, selected, date) : ZERO;

  // Lançamento contábil automático (RN-CTB-02)
  const t = doc.totals as Record<string, string>;
  await postEvent(tx, {
    type: 'venda_faturada', companyId: doc.company_id, establishmentId: doc.establishment_id, date, description: `Venda pedido ${o.number}`, number: `${doc.series}/${doc.id.slice(0, 8)}`,
    originType: 'fiscal_document', originId: doc.id, operationTypeCode: o.operation_type_code, partyId: o.party_id,
    amounts: { invoice_total: doc.total_invoice, receivable_total: receivableTotal, st: t.st, fcp_st: t.fcpSt, ipi: t.ipi, icms: t.icms, fcp: t.fcp, difal: t.difal, fcp_dest: t.fcpDest,
      pis: t.pis, cofins: t.cofins, iss: t.iss, cmv },
  });
  // Cartão: reclassifica de clientes para recebíveis de cartão, com a taxa em despesa
  const cardTitle = titles.length ? await tx.maybeOne<{ gross_amount: string | null; fee_amount: string | null; amount: string }>(`SELECT gross_amount, fee_amount, amount FROM finance.titles WHERE id = $1`, [titles[0]]) : null;
  if (cardTitle?.gross_amount) {
    await postEvent(tx, { type: 'cartao_venda', companyId: doc.company_id, date, description: 'Venda no cartão', number: doc.id.slice(0, 8), originType: 'fiscal_document', originId: doc.id,
      amounts: { gross: cardTitle.gross_amount, fee: cardTitle.fee_amount, net: cardTitle.amount } });
  }

  // Comissões (RN-VEN-06), promoções consumidas e saldo do pedido
  await createCommissions(tx, o, doc, selected, titles);
  for (const s of selected) {
    if (s.item.promotion_ids?.length) await consumePromotions(tx, s.item.promotion_ids, D(s.qty).times(s.item.unit_factor).toFixed(4));
    await tx.exec(`UPDATE sales.order_items SET quantity_invoiced = quantity_invoiced + $2 WHERE id = $1`, [s.item.id, s.qty]);
  }
  await tx.exec(`INSERT INTO sales.order_invoices (tenant_id, order_id, document_id) VALUES ($1,$2,$3)`, [tx.tenantId, orderId, doc.id]);
  await refreshOrderStatus(tx, orderId);
  const prepared = await prepareForTransmission(tx, doc.id);
  await emit(tx, 'pedido.faturado', { type: 'sales_order', id: orderId }, { id: orderId, numero: o.number, documento: doc.id, total: doc.total_invoice });
  return { document: prepared, titles };
}

/** Baixa o estoque dos itens de uma nota de saída do pedido (consome a reserva; FEFO por lote) e devolve o CMV. */
async function issueStock(tx: Tx, o: Record<string, any>, orderId: string, doc: DocRow, selected: { item: Record<string, any>; qty: string }[], date: string) {
  let cmv = ZERO;
  const docItems = await tx.query<Record<string, any>>(`SELECT * FROM fiscal.document_items WHERE document_id = $1 ORDER BY item_number`, [doc.id]);
  for (const di of docItems) {
    const oi = selected.find((s) => s.item.id === di.source_item_id)!.item;
    const stockQty = D(di.quantity).times(oi.unit_factor).toFixed(4);
    let itemCost = ZERO;
    for (const comp of await explodeKit(tx, di.product_id, stockQty)) {
      const prod = await tx.one<{ controls_lot: boolean; controls_stock: boolean }>(`SELECT controls_lot, controls_stock FROM catalog.products WHERE id = $1`, [comp.productId]);
      if (!prod.controls_stock) continue;
      const res = await tx.maybeOne<{ id: string }>(`SELECT id FROM inventory.reservations WHERE source_type = 'sales_order' AND source_id = $1 AND source_item_id = $2 AND product_id = $3 AND status = 'active' LIMIT 1`,
        [orderId, oi.id, comp.productId]);
      const lots = prod.controls_lot ? (oi.lot_id && comp.productId === oi.product_id ? [{ lotId: oi.lot_id, quantity: comp.quantity }] : await allocateFefo(tx, o.warehouse_id, comp.productId, comp.quantity)) : [{ lotId: null, quantity: comp.quantity }];
      for (const l of lots) {
        const mv = await postMovement(tx, {
          warehouseId: o.warehouse_id, productId: comp.productId, lotId: l.lotId, type: 'sale_out', quantity: l.quantity, occurredAt: new Date(`${date}T${new Date().toISOString().slice(11)}`),
          sourceType: 'fiscal_document', sourceId: doc.id, sourceItemId: di.id, consumeReservationId: res?.id ?? null, idempotencyKey: `invoice:${doc.id}:${di.id}:${comp.productId}:${l.lotId ?? '-'}`,
        });
        if (mv) itemCost = itemCost.plus(mv.total_cost);
      }
    }
    cmv = cmv.plus(itemCost);
    await tx.exec(`UPDATE fiscal.document_items SET stock_quantity = $2, unit_cost = $3 WHERE id = $1`, [di.id, stockQty, D(stockQty).isZero() ? '0' : itemCost.dividedBy(stockQty).toFixed(10)]);
  }
  return cmv;
}

/**
 * RN-VEN-05: venda para entrega futura. O pedido é faturado com a nota de simples faturamento
 * (5922/6922: título a receber, sem ICMS e sem baixa de estoque) e cada entrega sai com a nota de
 * remessa (5117/6117) vinculada à primeira: ICMS destacado, estoque baixado e CMV, sem novo título.
 */
export async function shipFutureDelivery(tx: Tx, orderId: string, input: { items?: { orderItemId: string; quantity: string }[]; date?: string; idempotencyKey?: string | null } = {}) {
  if (input.idempotencyKey) {
    const ex = await tx.maybeOne<DocRow>(`SELECT * FROM fiscal.documents WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (ex) return { document: ex };
  }
  const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1 FOR UPDATE`, [orderId], 'Pedido');
  const opType = await tx.one<{ purpose: string }>(`SELECT purpose FROM fiscal.operation_types WHERE code = $1`, [o.operation_type_code]);
  if (opType.purpose !== 'future_delivery') throw ruleViolation('RN-VEN-05', 'A remessa de entrega futura só vale para pedido de venda para entrega futura');
  const billing = await tx.maybeOne<DocRow & { access_key: string }>(
    `SELECT d.* FROM sales.order_invoices oi JOIN fiscal.documents d ON d.id = oi.document_id WHERE oi.order_id = $1 AND d.status = 'autorizada' ORDER BY d.created_at LIMIT 1`, [orderId]);
  if (!billing) throw ruleViolation('RN-VEN-05', 'A remessa exige a nota de simples faturamento autorizada');
  const shipOp = await tx.one<{ code: string }>(`SELECT code FROM fiscal.operation_types WHERE purpose = 'future_delivery_shipment' AND active ORDER BY code LIMIT 1`, [], 'Tipo de operação de remessa');
  const items = await tx.query<Record<string, any>>(`SELECT * FROM sales.order_items WHERE order_id = $1 ORDER BY item_number FOR UPDATE`, [orderId]);
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const selected: { item: Record<string, any>; qty: string }[] = [];
  for (const it of items) {
    const remaining = D(it.quantity_invoiced).minus(it.quantity_shipped);
    const req = input.items ? input.items.find((x) => x.orderItemId === it.id) : null;
    const qty = input.items ? (req ? D(req.quantity) : ZERO) : remaining;
    if (qty.isZero()) continue;
    if (qty.greaterThan(remaining)) throw ruleViolation('RN-VEN-05', `Item ${it.item_number}: remessa (${qty.toFixed(4)}) maior que o faturado a entregar (${remaining.toFixed(4)})`);
    selected.push({ item: it, qty: qty.toFixed(4) });
  }
  if (!selected.length) throw conflict('NOTHING_TO_SHIP', 'Tudo o que foi faturado já foi entregue');
  const doc = await createOutgoingDocument(tx, {
    establishmentId: o.establishment_id, operationTypeCode: shipOp.code, model: '55', partyId: o.party_id, date, presence: 9,
    items: selected.map(({ item, qty }) => {
      const ratio = D(qty).dividedBy(item.quantity);
      return { id: item.id, productId: item.product_id, quantity: qty, unit: item.unit, unitPrice: item.unit_price,
        discount: roundMoney(D(item.item_discount).plus(item.header_discount_share).times(ratio)).toFixed(2), warehouseId: o.warehouse_id, sourceItemId: item.id };
    }),
    freightMode: o.freight_mode, carrierId: o.carrier_id,
    additionalInfo: `Remessa de mercadoria vendida para entrega futura: NF-e ${billing.series}/${billing.number}, chave ${billing.access_key} | Pedido VORTEX nº ${o.number}`,
    sourceType: 'sales_order', sourceId: orderId, idempotencyKey: input.idempotencyKey ?? null, payments: [],
  });
  await tx.exec(`INSERT INTO fiscal.document_references (tenant_id, document_id, referenced_document_id, referenced_access_key, kind) VALUES ($1,$2,$3,$4,'future_delivery')`,
    [tx.tenantId, doc.id, billing.id, billing.access_key]);
  await tx.exec(`UPDATE fiscal.documents SET payments = '[{"tPag":"90","value":"0.00"}]' WHERE id = $1`, [doc.id]);
  const cmv = await issueStock(tx, o, orderId, doc, selected, date);
  await postEvent(tx, { type: 'remessa_entrega_futura', companyId: doc.company_id, establishmentId: doc.establishment_id, date, description: `Remessa entrega futura pedido ${o.number}`,
    number: `${doc.series}/${doc.id.slice(0, 8)}`, originType: 'fiscal_document', originId: doc.id, partyId: o.party_id,
    amounts: { icms: (doc.totals as Record<string, string>).icms, cmv } });
  for (const s of selected) await tx.exec(`UPDATE sales.order_items SET quantity_shipped = quantity_shipped + $2 WHERE id = $1`, [s.item.id, s.qty]);
  await tx.exec(`INSERT INTO sales.order_invoices (tenant_id, order_id, document_id, kind) VALUES ($1,$2,$3,'shipment')`, [tx.tenantId, orderId, doc.id]);
  return { document: await prepareForTransmission(tx, doc.id) };
}

async function refreshOrderStatus(tx: Tx, orderId: string) {
  const r = await tx.one<{ total: string; invoiced: string; cancelled: string }>(
    `SELECT sum(quantity) AS total, sum(quantity_invoiced) AS invoiced, sum(quantity_cancelled) AS cancelled FROM sales.order_items WHERE order_id = $1`, [orderId]);
  const status = D(r.invoiced).isZero() ? (D(r.cancelled).equals(r.total) ? 'cancelled' : 'approved')
    : D(r.invoiced).plus(r.cancelled).equals(r.total) ? 'invoiced' : 'partially_invoiced';
  await tx.exec(`UPDATE sales.orders SET status = $2 WHERE id = $1`, [orderId, status]);
}

// ------------------------------------------------------------------ comissões (RN-VEN-06)

async function commissionPercent(tx: Tx, salespersonId: string, productId: string, priceListId: string | null, discountPercent: string): Promise<string> {
  const p = await tx.one<{ category_id: string | null; commission_percent: string | null }>(`SELECT category_id, commission_percent FROM catalog.products WHERE id = $1`, [productId]);
  const rule = await tx.maybeOne<{ percent: string }>(
    `SELECT percent FROM sales.commission_rules
      WHERE (salesperson_id IS NULL OR salesperson_id = $1) AND (product_id IS NULL OR product_id = $2) AND (category_id IS NULL OR category_id = $3)
        AND (price_list_id IS NULL OR price_list_id = $4) AND (max_discount_percent IS NULL OR $5::numeric <= max_discount_percent)
      ORDER BY (product_id IS NOT NULL)::int * 8 + (category_id IS NOT NULL)::int * 4 + (salesperson_id IS NOT NULL)::int * 2 + (price_list_id IS NOT NULL)::int DESC,
               max_discount_percent ASC NULLS LAST LIMIT 1`,
    [salespersonId, productId, p.category_id, priceListId, discountPercent]);
  return rule?.percent ?? p.commission_percent ?? '0';
}

async function createCommissions(tx: Tx, o: Record<string, any>, doc: DocRow, selected: { item: Record<string, any>; qty: string }[], titleIds: string[]) {
  if (!o.salesperson_id) return;
  const settings = (await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [o.company_id])).settings;
  const basis = settings?.sales?.commissionBasis === 'receipt' ? 'receipt' : 'invoice';
  let base = ZERO;
  let amount = ZERO;
  for (const s of selected) {
    const ratio = D(s.qty).dividedBy(s.item.quantity);
    const lineBase = roundMoney(D(s.item.total).times(ratio));
    const list = D(s.item.quantity).times(s.item.list_price);
    const disc = list.isZero() ? '0' : list.minus(s.item.total).dividedBy(list).times(HUNDRED).toFixed(4);
    const pct = await commissionPercent(tx, o.salesperson_id, s.item.product_id, o.price_list_id, disc);
    base = base.plus(lineBase);
    amount = amount.plus(lineBase.times(pct).dividedBy(HUNDRED));
  }
  amount = roundMoney(amount);
  if (amount.isZero()) return;
  const pct = base.isZero() ? '0' : amount.dividedBy(base).times(HUNDRED).toFixed(4);
  if (basis === 'invoice') {
    await tx.exec(`INSERT INTO sales.commissions (tenant_id, company_id, salesperson_id, order_id, document_id, basis, base_amount, percent, amount, status, released_at)
                   VALUES ($1,$2,$3,$4,$5,'invoice',$6,$7,$8,'released',now())`, [tx.tenantId, o.company_id, o.salesperson_id, o.id, doc.id, base.toFixed(2), pct, amount.toFixed(2)]);
  } else {
    // Sobre recebimento: uma comissão por título, liberada quando o título é pago
    const titles = await tx.query<{ id: string; amount: string }>(`SELECT id, amount FROM finance.titles WHERE id = ANY($1)`, [titleIds]);
    const parts = allocate(amount, titles.map((t) => t.amount));
    for (const [i, t] of titles.entries()) {
      await tx.exec(`INSERT INTO sales.commissions (tenant_id, company_id, salesperson_id, order_id, document_id, title_id, basis, base_amount, percent, amount)
                     VALUES ($1,$2,$3,$4,$5,$6,'receipt',$7,$8,$9)`, [tx.tenantId, o.company_id, o.salesperson_id, o.id, doc.id, t.id, t.amount, pct, parts[i]!.toFixed(2)]);
    }
  }
}

async function reverseCommissions(tx: Tx, documentId: string, ratio = D(1)) {
  const rows = await tx.query<Record<string, any>>(`SELECT * FROM sales.commissions WHERE document_id = $1 AND status <> 'reversed' AND reversal_of IS NULL`, [documentId]);
  for (const c of rows) {
    const value = roundMoney(D(c.amount).times(ratio));
    if (value.isZero()) continue;
    if (c.status === 'pending' && ratio.equals(1)) {
      await tx.exec(`UPDATE sales.commissions SET status = 'reversed' WHERE id = $1`, [c.id]);
    } else {
      await tx.exec(`INSERT INTO sales.commissions (tenant_id, company_id, salesperson_id, order_id, document_id, basis, base_amount, percent, amount, status, released_at, reversal_of)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'released',now(),$10)`,
        [tx.tenantId, c.company_id, c.salesperson_id, c.order_id, documentId, c.basis, roundMoney(D(c.base_amount).times(ratio)).negated().toFixed(2), c.percent, value.negated().toFixed(2), c.id]);
    }
  }
}

// Comissão sobre recebimento: libera quando o título é pago
subscribe('titulo.pago', async (tx, ev) => {
  await tx.exec(`UPDATE sales.commissions SET status = 'released', released_at = now() WHERE title_id = $1 AND status = 'pending'`, [ev.payload.id]);
});

// ------------------------------------------------------------------ desfazer efeitos da nota (cancelamento, denegação, inutilização)

registerDocumentHooks('sales_order', {
  undone: async (tx, doc, reason) => {
    const today = new Date().toISOString().slice(0, 10);
    const moves = await tx.query<{ id: string }>(`SELECT id FROM inventory.stock_movements WHERE source_type = 'fiscal_document' AND source_id = $1 AND reversal_of IS NULL`, [doc.id]);
    for (const m of moves) await reverseMovement(tx, m.id, `NF ${reason === 'cancelled' ? 'cancelada' : reason === 'denied' ? 'denegada' : 'inutilizada'}`, { idempotencyKey: `undo:${m.id}` });
    await cancelTitlesOfOrigin(tx, 'sales_invoice', doc.id, `Nota ${reason}`);
    await reverseEntries(tx, 'fiscal_document', doc.id, today, `Nota ${reason}`);
    await reverseCommissions(tx, doc.id);
    // Os itens voltam ao pedido (saldo a faturar)
    const items = await tx.query<{ source_item_id: string; quantity: string }>(`SELECT source_item_id, quantity FROM fiscal.document_items WHERE document_id = $1 AND source_item_id IS NOT NULL`, [doc.id]);
    for (const it of items) await tx.exec(`UPDATE sales.order_items SET quantity_invoiced = quantity_invoiced - $2 WHERE id = $1`, [it.source_item_id, it.quantity]);
    if (doc.source_id) {
      await tx.exec(`UPDATE sales.order_invoices SET undone = true WHERE order_id = $1 AND document_id = $2`, [doc.source_id, doc.id]);
      await refreshOrderStatus(tx, doc.source_id);
    }
  },
});

// ------------------------------------------------------------------ devoluções e trocas (seção 10)

export interface SaleReturnInput {
  originalDocumentId: string;
  items: { originalItemId: string; quantity: string }[];
  reason: string;
  destination: 'normal' | 'damaged' | 'discard';
  financialTreatment: 'abatement' | 'store_credit' | 'card_refund' | 'cash_refund' | 'pix_refund';
  refundAccountId?: string | null;
  /** own: nota de entrada emitida pela empresa (PF sem IE); customer: NF-e de devolução do cliente contribuinte */
  issuer?: 'own' | 'customer';
  customerDocumentKey?: string | null;
  idempotencyKey?: string | null;
  /** Pessoa do reembolso quando a venda não identificou o cliente (consumidor final da NFC-e) */
  partyId?: string | null;
}

export async function createSaleReturn(tx: Tx, input: SaleReturnInput) {
  const orig = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [input.originalDocumentId], 'Nota de venda');
  if (orig.direction !== 'S' || orig.status !== 'autorizada') throw ruleViolation('RN-NFE-09', 'Devolução parte de uma nota de venda autorizada');
  const issuer = input.issuer ?? (orig.recipient_ie_indicator === 1 ? 'customer' : 'own');
  if (issuer === 'customer' && !input.customerDocumentKey) throw validation({ customerDocumentKey: 'Informe a chave da NF-e de devolução emitida pelo cliente' });
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'sales_return') AS n`, [orig.company_id])).n;
  const ret = await tx.one<{ id: string }>(
    `INSERT INTO sales.returns (tenant_id, company_id, number, order_id, original_document_id, issuer, customer_document_key, reason, destination, financial_treatment, refund_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [tx.tenantId, orig.company_id, number, orig.source_type === 'sales_order' ? orig.source_id : null, orig.id, issuer, input.customerDocumentKey ?? null, input.reason,
      input.destination, input.financialTreatment, input.refundAccountId ?? null, tx.userId]);
  // Destino do item: depósito normal, de avariados (criado se não existir) ou descarte
  let warehouseId: string | null = null;
  if (input.destination === 'damaged') {
    warehouseId = (await tx.maybeOne<{ id: string }>(`SELECT id FROM core.warehouses WHERE establishment_id = $1 AND kind = 'damaged' AND active LIMIT 1`, [orig.establishment_id]))?.id
      ?? (await tx.one<{ id: string }>(`INSERT INTO core.warehouses (tenant_id, company_id, establishment_id, code, name, kind, created_by) VALUES ($1,$2,$3,'AVARIA','Avariados','damaged',$4) RETURNING id`,
        [tx.tenantId, orig.company_id, orig.establishment_id, tx.userId])).id;
  }
  const retDoc = await createReturnDocument(tx, {
    originalDocumentId: orig.id, items: input.items.map((i) => ({ ...i, warehouseId })), reason: input.reason, sourceType: 'sales_return', sourceId: ret.id,
    idempotencyKey: input.idempotencyKey ? `ret:${input.idempotencyKey}` : null,
  });
  if (!retDoc.party_id && input.partyId) {
    // Venda a consumidor não identificado (NFC-e): a nota de entrada identifica quem devolveu
    const party = await tx.one<{ tax_id: string | null; legal_name: string; ie_indicator: number }>(`SELECT tax_id, legal_name, ie_indicator FROM registry.parties WHERE id = $1`, [input.partyId], 'Pessoa');
    const addr = await tx.maybeOne<Record<string, any>>(`SELECT * FROM registry.party_addresses WHERE party_id = $1 ORDER BY (kind = 'fiscal') DESC, is_default DESC LIMIT 1`, [input.partyId]);
    await tx.exec(
      `UPDATE fiscal.documents SET party_id = $2, recipient_tax_id = $3, recipient_name = $4, recipient_ie_indicator = $5, recipient_uf = coalesce($6, recipient_uf),
              recipient_address = coalesce($7, recipient_address) WHERE id = $1`,
      [retDoc.id, input.partyId, party.tax_id, party.legal_name, party.ie_indicator, addr?.uf ?? null,
        addr ? JSON.stringify({ street: addr.street, number: addr.number, complement: addr.complement, district: addr.district, cityIbge: addr.city_ibge, cityName: addr.city_name, uf: addr.uf, zip: addr.zip, countryCode: addr.country_code }) : null]);
  }
  await tx.exec(`UPDATE sales.returns SET return_document_id = $2, total = $3 WHERE id = $1`, [ret.id, retDoc.id, retDoc.total_invoice]);
  await applyReturnEffects(tx, ret.id);
  if (issuer === 'own') {
    await prepareForTransmission(tx, retDoc.id);
  } else {
    // Nota do cliente: registra a referência; nada a transmitir
    await tx.exec(`UPDATE fiscal.documents SET issuer_kind = 'third_party', access_key = $2, status = 'autorizada', authorized_at = now() WHERE id = $1`, [retDoc.id, input.customerDocumentKey]);
  }
  return { returnId: ret.id, documentId: retDoc.id, total: retDoc.total_invoice, issuer };
}

async function applyReturnEffects(tx: Tx, returnId: string) {
  const r = await tx.one<Record<string, any>>(`SELECT * FROM sales.returns WHERE id = $1`, [returnId]);
  const doc = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [r.return_document_id]);
  const items = await tx.query<Record<string, any>>(
    `SELECT ri.*, oi.warehouse_id AS orig_wh, oi.unit_cost AS orig_cost, oi.quantity AS orig_qty, oi.stock_quantity AS orig_stock_qty, oi.source_item_id AS orig_source_item
       FROM fiscal.document_items ri JOIN fiscal.document_items oi ON oi.id = ri.original_item_id WHERE ri.document_id = $1`, [doc.id]);
  let cmv = ZERO;
  for (const it of items) {
    const stockQty = it.orig_stock_qty ? D(it.orig_stock_qty).times(it.quantity).dividedBy(it.orig_qty).toFixed(4) : it.quantity;
    const cost = D(it.orig_cost ?? '0');
    if (r.destination !== 'discard') {
      for (const comp of await explodeKit(tx, it.product_id, stockQty)) {
        const mv = await postMovement(tx, {
          warehouseId: it.warehouse_id ?? it.orig_wh, productId: comp.productId, lotId: comp.productId === it.product_id ? it.lot_id : null, type: 'sale_return_in', quantity: comp.quantity,
          unitCost: comp.productId === it.product_id ? cost.toFixed(10) : null, sourceType: 'fiscal_document', sourceId: doc.id, sourceItemId: it.id, idempotencyKey: `return:${it.id}:${comp.productId}`,
        });
        if (mv) cmv = cmv.plus(mv.total_cost);
      }
    }
    if (it.orig_source_item) await tx.exec(`UPDATE sales.order_items SET quantity_returned = quantity_returned + $2 WHERE id = $1`, [it.orig_source_item, it.quantity]);
  }
  // Tratamento financeiro
  let remaining = D(doc.total_invoice);
  const today = new Date().toISOString().slice(0, 10);
  if (r.financial_treatment === 'abatement') {
    const open = await tx.query<{ id: string; balance: string }>(`SELECT id, balance FROM finance.titles WHERE fiscal_document_id = $1 AND status IN ('open','partially_paid') ORDER BY due_date DESC`, [r.original_document_id]);
    for (const t of open) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const a = min(remaining, D(t.balance));
      await abateTitle(tx, t.id, a.toFixed(2), `Devolução ${r.number}`, { type: 'sales_return', id: returnId });
      remaining = remaining.minus(a);
    }
  }
  if (remaining.greaterThan(0)) {
    if (r.financial_treatment === 'cash_refund' || r.financial_treatment === 'pix_refund') {
      if (!r.refund_account_id) throw validation({ refundAccountId: 'Informe a conta de onde sai o reembolso' });
      const [t] = await createTitles(tx, { kind: 'payable', partyId: doc.party_id!, originType: 'sale_return', originId: returnId, documentNumber: `DEV-${r.number}`, issueDate: today,
        installments: [{ dueDate: today, amount: remaining.toFixed(2) }] });
      await tx.exec(`UPDATE finance.titles SET approved_at = now(), approved_by = $2 WHERE id = $1`, [t!.id, tx.userId]);
      await settleTitle(tx, t!.id, { date: today, accountId: r.refund_account_id, amount: remaining.toFixed(2), method: r.financial_treatment === 'pix_refund' ? 'pix' : 'cash' });
    } else {
      // Crédito para o cliente (crédito em loja ou estorno no cartão aguardando a adquirente)
      await createTitles(tx, { kind: 'payable', partyId: doc.party_id!, originType: r.financial_treatment === 'card_refund' ? 'sale_return' : 'advance', originId: returnId,
        documentNumber: `CRED-DEV-${r.number}`, issueDate: today, installments: [{ dueDate: today, amount: remaining.toFixed(2) }], notes: `Devolução ${r.number}: ${r.financial_treatment}` });
    }
  }
  const t = doc.totals as Record<string, string>;
  await postEvent(tx, {
    type: 'devolucao_venda', companyId: doc.company_id, establishmentId: doc.establishment_id, date: today, description: `Devolução de venda ${r.number}`, number: String(r.number),
    originType: 'fiscal_document', originId: doc.id, partyId: doc.party_id,
    amounts: { invoice_total: doc.total_invoice, st: t.st, fcp_st: t.fcpSt, ipi: t.ipi, icms: t.icms, fcp: t.fcp, difal: t.difal, fcp_dest: t.fcpDest, pis: t.pis, cofins: t.cofins, cmv },
  });
  // Devolução estorna comissão proporcionalmente
  const orig = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [r.original_document_id]);
  await reverseCommissions(tx, orig.id, D(doc.total_invoice).dividedBy(orig.total_invoice));
  await tx.exec(`UPDATE sales.returns SET status = 'completed' WHERE id = $1`, [returnId]);
}

registerDocumentHooks('sales_return', {
  undone: async (tx, doc) => {
    const moves = await tx.query<{ id: string }>(`SELECT id FROM inventory.stock_movements WHERE source_type = 'fiscal_document' AND source_id = $1 AND reversal_of IS NULL`, [doc.id]);
    for (const m of moves) await reverseMovement(tx, m.id, 'Devolução desfeita', { idempotencyKey: `undo:${m.id}` });
    await reverseEntries(tx, 'fiscal_document', doc.id, new Date().toISOString().slice(0, 10), 'Devolução desfeita');
    if (doc.source_id) await tx.exec(`UPDATE sales.returns SET status = 'cancelled' WHERE id = $1`, [doc.source_id]);
  },
});

export { AppError };
