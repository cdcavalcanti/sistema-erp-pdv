import { z } from 'zod';
import { orderItemSchema, salesOrderSchema } from '@vortex/contracts';
import { D, sum } from '@vortex/money';
import { resolveContext, route, type App } from '../../http/app.js';
import { decimal, decodeCursor, idParams, isoDate, page } from '../../http/schemas.js';
import { AppError, conflict, notFound } from '../../errors.js';
import { systemContext, withTenant } from '../../db/tx.js';
import { randomToken, safeEqual } from '../../core/crypto.js';
import { assertEstablishmentScope, requirePerm } from '../../core/access.js';
import { calculateOperation } from '../fiscal/engine-adapter.js';
import { transmitDocument } from '../fiscal-docs/documents.js';
import { allocateFefo, explodeKit } from '../inventory/stock.js';
import { ORDER_STAGES, STAGE_EXPR, STAGE_JOIN, cancelOrder, checkAll, createOrder, deliverOrder, getOrder, orderStageCounts, priceItems, shipOrder, startPicking, submitOrder, updateOrderItems } from './orders.js';
import { createSaleReturn, invoiceOrder, shipFutureDelivery } from './invoicing.js';

// Mesmo esquema que o web app usa na tela de pedido
const orderItem = orderItemSchema;
const orderBody = salesOrderSchema;

async function transmitInvoice(result: any, a: { ctx: any; deps: any }) {
  if (!result?.document?.id) return result;
  const transmission = await transmitDocument(a.deps.pool, a.ctx, a.deps.services, result.document.id);
  return { ...result, transmission };
}

export function registerSalesRoutes(app: App) {
  // ---------------------------------------------------------------- orçamentos
  route(app, {
    method: 'POST', url: '/v1/sales/quotes', summary: 'Orçamento com preços vigentes e impostos calculados (total real); não reserva estoque', tags: ['Vendas'], permission: 'vendas.orcamento.criar', status: 201,
    body: orderBody.omit({ submit: true, warehouseId: true, externalId: true }).extend({ validDays: z.number().int().min(1).max(180).default(15) }),
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [body.establishmentId], 'Estabelecimento');
    const items = await priceItems(tx, body);
    const { result } = await calculateOperation(tx, {
      establishmentId: body.establishmentId, operationTypeCode: body.operationTypeCode, date: new Date().toISOString().slice(0, 10), partyId: body.partyId,
      header: { freight: body.freight ?? '0' }, items: items.map((it, i) => ({ id: String(i), productId: it.productId, quantity: it.quantity, unitPrice: it.unitPrice, discount: D(it.itemDiscount).plus(it.headerShare).toFixed(2) })),
    });
    const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'quote') AS n`, [est.company_id])).n;
    const valid = new Date(Date.now() + body.validDays * 86_400_000).toISOString().slice(0, 10);
    const t = result.totals;
    const q = await tx.one(
      `INSERT INTO sales.quotes (tenant_id, company_id, establishment_id, number, party_id, salesperson_id, channel, operation_type_code, payment_term_id, payment_method_id, freight_mode,
         freight, discount, valid_until, total_products, total_taxes, total, fiscal_preview, notes, public_token, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [tx.tenantId, est.company_id, body.establishmentId, number, body.partyId, body.salespersonId ?? ctx.partyId, body.channel, body.operationTypeCode, body.paymentTermId ?? null,
        body.paymentMethodId ?? null, body.freightMode ?? 9, body.freight ?? '0', body.discount ?? '0', valid, t.product,
        sum([t.icms, t.st, t.ipi, t.pis, t.cofins, t.fcp, t.difal]).toFixed(2), t.invoice, JSON.stringify({ totals: t, items: result.items.map((i) => ({ cfop: i.cfop, taxes: i.taxes })) }),
        body.notes ?? null, randomToken(18), tx.userId]);
    for (const [i, it] of items.entries()) {
      await tx.exec(`INSERT INTO sales.quote_items (tenant_id, quote_id, item_number, product_id, quantity, unit, list_price, unit_price, discount_percent, discount_value, total)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [tx.tenantId, q.id, i + 1, it.productId, it.quantity, it.unit, it.listPrice, it.unitPrice, it.discountPercent, D(it.itemDiscount).plus(it.headerShare).toFixed(2), it.total]);
    }
    return { ...q, acceptLink: `/public/quotes/${q.public_token}?tenant=${tx.tenantId}` };
  });

  route(app, {
    method: 'GET', url: '/v1/sales/quotes', summary: 'Orçamentos', tags: ['Vendas'], permission: 'vendas.orcamento.ler', query: z.object({ status: z.string().optional() }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT q.*, p.legal_name AS party_name FROM sales.quotes q JOIN registry.parties p ON p.id = q.party_id
      WHERE ($1::uuid IS NULL OR q.company_id = $1) AND ($2::text IS NULL OR q.status = $2) AND ($3::uuid IS NULL OR q.salesperson_id = $3) ORDER BY q.created_at DESC LIMIT 500`,
    [ctx.companyId, query.status ?? null, ctx.ownPortfolioOnly ? ctx.partyId : null]));

  route(app, { method: 'GET', url: '/v1/sales/quotes/:id', summary: 'Orçamento', tags: ['Vendas'], permission: 'vendas.orcamento.ler', params: idParams }, async ({ tx, params }) => {
    const q = await tx.one(`SELECT * FROM sales.quotes WHERE id = $1`, [params.id], 'Orçamento');
    return { ...q, items: await tx.query(`SELECT qi.*, p.sku, p.description FROM sales.quote_items qi JOIN catalog.products p ON p.id = qi.product_id WHERE quote_id = $1 ORDER BY item_number`, [params.id]) };
  });

  route(app, {
    method: 'POST', url: '/v1/sales/quotes/:id/convert', summary: 'Converte orçamento aceito em pedido (congela preço e condição)', tags: ['Vendas'], permission: 'vendas.pedido.criar', status: 201, params: idParams,
  }, async ({ tx, params }) => convertQuote(tx, params.id));

  // Aceite online pelo cliente (link do orçamento)
  app.get('/public/quotes/:token', { schema: { hide: true } }, async (req) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const { tenant } = z.object({ tenant: z.string().uuid() }).parse(req.query);
    return withTenant(app.deps.pool, systemContext(tenant), async (tx) => {
      const q = await tx.maybeOne(`SELECT q.id, q.number, q.valid_until, q.status, q.total, q.total_products, q.total_taxes, q.public_token, e.trade_name AS seller
                                     FROM sales.quotes q JOIN core.establishments e ON e.id = q.establishment_id WHERE q.public_token = $1`, [token]);
      if (!q || !safeEqual(q.public_token, token)) throw new AppError('NOT_FOUND', 'Orçamento não encontrado', 404);
      const items = await tx.query(`SELECT p.description, qi.quantity, qi.unit, qi.unit_price, qi.total FROM sales.quote_items qi JOIN catalog.products p ON p.id = qi.product_id WHERE qi.quote_id = $1 ORDER BY item_number`, [q.id]);
      delete q.public_token;
      return { ...q, items };
    }, { readOnly: true });
  });

  app.post('/public/quotes/:token/accept', { schema: { hide: true } }, async (req) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const { tenant } = z.object({ tenant: z.string().uuid() }).parse(req.query);
    const { name } = z.object({ name: z.string().min(3) }).parse(req.body);
    return withTenant(app.deps.pool, { ...systemContext(tenant), device: 'portal-cliente', ip: req.ip }, async (tx) => {
      const q = await tx.maybeOne<{ id: string; status: string; valid_until: string }>(`SELECT id, status, valid_until FROM sales.quotes WHERE public_token = $1 FOR UPDATE`, [token]);
      if (!q) throw new AppError('NOT_FOUND', 'Orçamento não encontrado', 404);
      if (q.valid_until < new Date().toISOString().slice(0, 10)) throw conflict('QUOTE_EXPIRED', 'Orçamento vencido');
      if (!['draft', 'sent'].includes(q.status)) throw conflict('QUOTE_CLOSED', 'Orçamento já respondido');
      await tx.exec(`UPDATE sales.quotes SET status = 'accepted', accepted_at = now(), accepted_by_name = $2 WHERE id = $1`, [q.id, name]);
      return { accepted: true };
    });
  });

  // ---------------------------------------------------------------- pedidos
  route(app, {
    method: 'POST', url: '/v1/sales/orders', summary: 'Cria pedido (preço congelado; bloqueios automáticos; reserva ao aprovar)', tags: ['Vendas'], permission: 'vendas.pedido.criar', status: 201, body: orderBody,
  }, async ({ tx, ctx, body, req }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return createOrder(tx, { ...body, idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null }, { submit: body.submit });
  });

  route(app, {
    method: 'GET', url: '/v1/sales/orders', summary: 'Pedidos de venda com a etapa (pedido, aprovado, separação, faturado, despachado, entregue, cancelado)', tags: ['Vendas'],
    permission: 'vendas.pedido.ler',
    query: z.object({ status: z.string().optional(), stage: z.enum(ORDER_STAGES).optional(), partyId: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional(),
      q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(50), cursor: z.string().optional() }),
  }, async ({ tx, ctx, query }) => {
    const c = decodeCursor(query.cursor);
    const rows = await tx.query(
      `SELECT o.id, o.number, o.status, ${STAGE_EXPR} AS stage, o.channel, o.total, o.created_at, o.party_id, p.legal_name AS party_name, o.salesperson_id,
              sh.tracking_code, sh.shipped_at, sh.delivered_at, (SELECT count(*) FROM sales.order_items i WHERE i.order_id = o.id)::int AS items_count
         FROM sales.orders o JOIN registry.parties p ON p.id = o.party_id ${STAGE_JOIN}
        WHERE ($1::uuid IS NULL OR o.company_id = $1) AND ($2::text IS NULL OR o.status = $2) AND ($3::uuid IS NULL OR o.party_id = $3)
          AND ($4::date IS NULL OR o.created_at >= $4) AND ($5::date IS NULL OR o.created_at < $5::date + 1) AND ($6::uuid IS NULL OR o.salesperson_id = $6)
          AND ($7::timestamptz IS NULL OR (o.created_at, o.id) < ($7, $8::uuid)) AND ($10::text IS NULL OR ${STAGE_EXPR} = $10)
          AND ($11::text IS NULL OR o.number::text = $11 OR p.legal_name ILIKE '%' || $11 || '%' OR p.trade_name ILIKE '%' || $11 || '%')
        ORDER BY o.created_at DESC, o.id DESC LIMIT $9`,
      [ctx.companyId, query.status ?? null, query.partyId ?? null, query.from ?? null, query.to ?? null, ctx.ownPortfolioOnly ? ctx.partyId : null, c?.at ?? null, c?.id ?? null,
        query.limit + 1, query.stage ?? null, query.q || null]);
    return page(rows, query.limit);
  });

  route(app, {
    method: 'GET', url: '/v1/sales/orders/stages', summary: 'Quantidade e valor de pedidos por etapa', tags: ['Vendas'], permission: 'vendas.pedido.ler',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  }, async ({ tx, query }) => orderStageCounts(tx, { from: query.from ?? null, to: query.to ?? null }));

  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/submit', summary: 'Envia o pedido para aprovação (aprova direto quando não há bloqueio de crédito, margem ou desconto)', tags: ['Vendas'],
    permission: 'vendas.pedido.criar', params: idParams,
  }, async ({ tx, params }) => {
    await submitOrder(tx, params.id);
    return getOrder(tx, params.id);
  });

  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/picking/start', summary: 'Separador iniciou a separação', tags: ['Expedição'], permission: 'vendas.pedido.editar', params: idParams,
  }, async ({ tx, params }) => startPicking(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/picking/check-all', summary: 'Conclui a conferência sem leitor: tudo separado na quantidade pedida', tags: ['Expedição'],
    permission: 'vendas.pedido.editar', params: idParams, body: z.object({ volumes: z.number().int().min(1).nullish(), grossWeight: decimal().nullish() }),
  }, async ({ tx, params, body }) => checkAll(tx, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/ship', summary: 'Despacha o pedido faturado (transportadora, rastreio, volumes)', tags: ['Expedição'], permission: 'vendas.pedido.editar',
    params: idParams, body: z.object({ carrierId: z.string().uuid().nullish(), trackingCode: z.string().max(60).nullish(), volumes: z.number().int().min(1).nullish() }),
  }, async ({ tx, params, body }) => shipOrder(tx, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/deliver', summary: 'Registra a entrega do pedido (quem recebeu)', tags: ['Expedição'], permission: 'vendas.pedido.editar',
    params: idParams, body: z.object({ receiverName: z.string().min(2).max(120) }),
  }, async ({ tx, params, body }) => deliverOrder(tx, params.id, body));

  route(app, { method: 'GET', url: '/v1/sales/orders/:id', summary: 'Pedido com itens, bloqueios e notas', tags: ['Vendas'], permission: 'vendas.pedido.ler', params: idParams },
    async ({ tx, params }) => getOrder(tx, params.id));

  route(app, {
    method: 'PUT', url: '/v1/sales/orders/:id/items', summary: 'Altera itens (só antes de faturar — RN-VEN-04)', tags: ['Vendas'], permission: 'vendas.pedido.editar', params: idParams,
    body: z.object({ version: z.number().int(), items: z.array(orderItem).min(1), discount: decimal({ min: 0 }).optional(), freight: decimal({ min: 0 }).optional() }),
  }, async ({ tx, params, body }) => updateOrderItems(tx, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/cancel', summary: 'Cancela o saldo não faturado (motivo obrigatório)', tags: ['Vendas'], permission: 'vendas.pedido.cancelar', params: idParams,
    body: z.object({ reason: z.string() }),
  }, async ({ tx, params, body }) => cancelOrder(tx, params.id, body.reason));

  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/future-delivery-shipment', summary: 'RN-VEN-05: nota de remessa da venda para entrega futura, vinculada ao simples faturamento', tags: ['Vendas'],
    permission: 'vendas.pedido.faturar', params: idParams, status: 201,
    body: z.object({ items: z.array(z.object({ orderItemId: z.string().uuid(), quantity: decimal({ positive: true }) })).optional(), date: isoDate.optional() }),
    afterCommit: transmitInvoice,
  }, async ({ tx, params, body, req }) => shipFutureDelivery(tx, params.id, { ...body, idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null }));

  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/invoice', summary: 'Fatura (total ou parcial): NF-e + estoque + títulos + contábil numa transação; transmite em seguida', tags: ['Vendas'],
    permission: 'vendas.pedido.faturar', params: idParams,
    body: z.object({ items: z.array(z.object({ orderItemId: z.string().uuid(), quantity: decimal({ positive: true }) })).optional(), date: isoDate.optional(),
      volumes: z.array(z.object({ quantity: z.number().int().min(1), kind: z.string(), grossWeight: decimal().optional(), netWeight: decimal().optional() })).optional(), additionalInfo: z.string().nullish() }),
    afterCommit: transmitInvoice,
  }, async ({ tx, params, body, req }) => {
    requirePerm(tx.ctx, 'fiscal.nota.emitir');
    return invoiceOrder(tx, params.id, { ...body, idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null });
  });

  // Faturamento em lote: cada pedido na sua transação
  app.post('/v1/sales/invoicing/batch', { schema: { summary: 'Faturamento em lote de vários pedidos', tags: ['Vendas'] } }, async (req) => {
    const ctx = await resolveContext(app, req);
    requirePerm(ctx, 'vendas.pedido.faturar');
    requirePerm(ctx, 'fiscal.nota.emitir');
    const { orderIds } = z.object({ orderIds: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
    const results = [];
    for (const id of orderIds) {
      try {
        const r = await withTenant(app.deps.pool, ctx, (tx) => invoiceOrder(tx, id, { idempotencyKey: `batch:${id}` }));
        const transmission = await transmitDocument(app.deps.pool, ctx, app.deps.services, r.document.id);
        results.push({ orderId: id, ok: true, documentId: r.document.id, transmission });
      } catch (e) {
        results.push({ orderId: id, ok: false, error: (e as Error).message, code: (e as AppError).code });
      }
    }
    return { results };
  });

  // ---------------------------------------------------------------- separação e expedição (V1)
  route(app, {
    method: 'POST', url: '/v1/sales/orders/:id/picking', summary: 'Gera lista de separação por depósito/lote (FEFO)', tags: ['Expedição'], permission: 'vendas.pedido.editar', status: 201, params: idParams,
  }, async ({ tx, params }) => {
    const o = await tx.one<Record<string, any>>(`SELECT * FROM sales.orders WHERE id = $1 FOR UPDATE`, [params.id], 'Pedido');
    if (!['approved', 'partially_invoiced'].includes(o.status)) throw conflict('INVALID_STATUS', 'Pedido precisa estar aprovado');
    const items = await tx.query<Record<string, any>>(`SELECT i.*, p.sku, p.description, p.gtin, p.controls_lot FROM sales.order_items i JOIN catalog.products p ON p.id = i.product_id WHERE order_id = $1`, [params.id]);
    const picking = [];
    for (const it of items) {
      const qty = D(it.quantity).minus(it.quantity_invoiced).minus(it.quantity_cancelled).times(it.unit_factor);
      if (qty.lessThanOrEqualTo(0)) continue;
      for (const comp of await explodeKit(tx, it.product_id, qty.toFixed(4))) {
        const prod = await tx.one<{ sku: string; description: string; gtin: string | null; controls_lot: boolean }>(`SELECT sku, description, gtin, controls_lot FROM catalog.products WHERE id = $1`, [comp.productId]);
        const lots = prod.controls_lot ? await allocateFefo(tx, o.warehouse_id, comp.productId, comp.quantity) : [{ lotId: null, lotNumber: null, quantity: comp.quantity }];
        for (const l of lots) picking.push({ orderItemId: it.id, productId: comp.productId, sku: prod.sku, description: prod.description, gtin: prod.gtin, lotId: l.lotId, lotNumber: l.lotNumber, quantity: l.quantity, checked: '0' });
      }
    }
    await tx.exec(`UPDATE sales.orders SET status = 'separating' WHERE id = $1 AND status = 'approved'`, [params.id]);
    return tx.one(`INSERT INTO sales.shipments (tenant_id, order_id, picking, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [tx.tenantId, params.id, JSON.stringify(picking), tx.userId]);
  });

  route(app, {
    method: 'POST', url: '/v1/sales/shipments/:id/check', summary: 'Conferência por código de barras; registra divergências', tags: ['Expedição'], permission: 'vendas.pedido.editar', params: idParams,
    body: z.object({ reads: z.array(z.object({ barcode: z.string(), quantity: decimal({ positive: true }).default('1') })).min(1), volumes: z.number().int().min(1).optional(), grossWeight: decimal().optional() }),
  }, async ({ tx, params, body }) => {
    const sh = await tx.one<Record<string, any>>(`SELECT * FROM sales.shipments WHERE id = $1 FOR UPDATE`, [params.id], 'Expedição');
    const picking = sh.picking as any[];
    for (const r of body.reads) {
      const line = picking.find((p) => (p.gtin === r.barcode || p.sku === r.barcode) && D(p.checked).lessThan(p.quantity));
      if (line) line.checked = D(line.checked).plus(r.quantity).toFixed(4);
      else picking.push({ unexpected: true, barcode: r.barcode, checked: r.quantity, quantity: '0' });
    }
    const divergences = picking.filter((p) => !D(p.checked).equals(p.quantity)).map((p) => ({ sku: p.sku ?? p.barcode, expected: p.quantity, checked: p.checked }));
    return tx.one(`UPDATE sales.shipments SET picking = $2, divergences = $3, status = CASE WHEN $4 THEN 'checked' ELSE status END, volumes = coalesce($5, volumes), gross_weight = coalesce($6, gross_weight) WHERE id = $1 RETURNING *`,
      [params.id, JSON.stringify(picking), JSON.stringify(divergences), divergences.length === 0, body.volumes ?? null, body.grossWeight ?? null]);
  });

  route(app, {
    method: 'POST', url: '/v1/sales/shipments/:id/ship', summary: 'Expede (transportadora, volumes, rastreio, romaneio)', tags: ['Expedição'], permission: 'vendas.pedido.editar', params: idParams,
    body: z.object({ carrierId: z.string().uuid().nullish(), trackingCode: z.string().nullish(), manifestNumber: z.string().nullish(), documentId: z.string().uuid().nullish() }),
  }, async ({ tx, params, body }) => tx.one(
    `UPDATE sales.shipments SET status = 'shipped', shipped_at = now(), carrier_id = $2, tracking_code = $3, manifest_number = $4, document_id = coalesce($5, document_id) WHERE id = $1 AND status IN ('picking','checked') RETURNING *`,
    [params.id, body.carrierId ?? null, body.trackingCode ?? null, body.manifestNumber ?? null, body.documentId ?? null], 'Expedição'));

  route(app, {
    method: 'POST', url: '/v1/sales/shipments/:id/deliver', summary: 'Comprovante de entrega (foto/assinatura no app)', tags: ['Expedição'], permission: 'vendas.pedido.editar', params: idParams,
    body: z.object({ receiverName: z.string().min(2), proofBase64: z.string().optional() }),
  }, async ({ tx, params, body, deps }) => {
    const key = body.proofBase64 ? (await deps.services.storage.putImmutable(`deliveries/${tx.tenantId}/${params.id}.jpg`, Buffer.from(body.proofBase64, 'base64'), 'image/jpeg')).key : null;
    return tx.one(`UPDATE sales.shipments SET status = 'delivered', delivered_at = now(), delivery_receiver = $2, delivery_proof_key = $3 WHERE id = $1 AND status = 'shipped' RETURNING *`,
      [params.id, body.receiverName, key], 'Expedição');
  });

  // ---------------------------------------------------------------- devoluções e trocas
  route(app, {
    method: 'POST', url: '/v1/sales/returns', summary: 'Devolução de venda (motivo, destino do item e tratamento financeiro); estorna comissão', tags: ['Vendas'], permission: 'vendas.devolucao.criar', status: 201,
    body: z.object({
      originalDocumentId: z.string().uuid(), items: z.array(z.object({ originalItemId: z.string().uuid(), quantity: decimal({ positive: true }) })).min(1), reason: z.string().min(5),
      destination: z.enum(['normal', 'damaged', 'discard']), financialTreatment: z.enum(['abatement', 'store_credit', 'card_refund', 'cash_refund', 'pix_refund']),
      refundAccountId: z.string().uuid().nullish(), issuer: z.enum(['own', 'customer']).optional(), customerDocumentKey: z.string().length(44).nullish(),
    }),
    afterCommit: async (r, a) => (r.issuer === 'own' ? { ...r, transmission: await transmitDocument(a.deps.pool, a.ctx, a.deps.services, r.documentId) } : r),
  }, async ({ tx, body, req }) => createSaleReturn(tx, { ...body, idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null }));

  route(app, {
    method: 'POST', url: '/v1/sales/exchanges', summary: 'Troca = devolução + nova venda vinculadas, com diferença cobrada ou creditada', tags: ['Vendas'], permission: 'vendas.devolucao.criar', status: 201,
    body: z.object({ returnId: z.string().uuid(), order: orderBody }),
  }, async ({ tx, body }) => {
    const ret = await tx.one<{ id: string; total: string; return_document_id: string }>(`SELECT id, total, return_document_id FROM sales.returns WHERE id = $1`, [body.returnId], 'Devolução');
    const order = await createOrder(tx, { ...body.order, notes: `${body.order.notes ?? ''} Troca da devolução ${ret.id.slice(0, 8)}`.trim() }, { submit: body.order.submit });
    await tx.exec(`UPDATE sales.returns SET exchange_order_id = $2 WHERE id = $1`, [ret.id, order.id]);
    const difference = D(order.total).minus(ret.total);
    return { order, returnTotal: ret.total, difference: difference.toFixed(2), settlement: difference.greaterThan(0) ? 'cobrar a diferença do cliente' : difference.isZero() ? 'sem diferença' : 'crédito para o cliente' };
  });

  // ---------------------------------------------------------------- comissões e metas
  route(app, {
    method: 'GET', url: '/v1/sales/commissions', summary: 'Comissões por vendedor e período', tags: ['Vendas'], permission: 'vendas.comissao.ler',
    query: z.object({ salespersonId: z.string().uuid().optional(), status: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() }),
  }, async ({ tx, ctx, query }) => {
    const sp = ctx.ownPortfolioOnly ? ctx.partyId : query.salespersonId ?? null;
    const rows = await tx.query(
      `SELECT c.*, p.legal_name AS salesperson_name FROM sales.commissions c JOIN registry.parties p ON p.id = c.salesperson_id
        WHERE ($1::uuid IS NULL OR c.salesperson_id = $1) AND ($2::text IS NULL OR c.status = $2) AND ($3::date IS NULL OR c.created_at >= $3) AND ($4::date IS NULL OR c.created_at < $4::date + 1)
        ORDER BY c.created_at DESC`, [sp, query.status ?? null, query.from ?? null, query.to ?? null]);
    return { items: rows, totalReleased: sum(rows.filter((r) => r.status === 'released').map((r) => r.amount)).toFixed(2) };
  });

  route(app, {
    method: 'POST', url: '/v1/sales/commission-rules', summary: 'Regra de comissão (vendedor, produto, categoria, tabela, faixa de desconto)', tags: ['Vendas'], permission: 'vendas.meta.editar', status: 201,
    body: z.object({ salespersonId: z.string().uuid().nullish(), productId: z.string().uuid().nullish(), categoryId: z.string().uuid().nullish(), priceListId: z.string().uuid().nullish(),
      maxDiscountPercent: decimal({ min: 0 }).nullish(), percent: decimal({ min: 0 }) }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO sales.commission_rules (tenant_id, salesperson_id, product_id, category_id, price_list_id, max_discount_percent, percent, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tx.tenantId, body.salespersonId ?? null, body.productId ?? null, body.categoryId ?? null, body.priceListId ?? null, body.maxDiscountPercent ?? null, body.percent, tx.userId]));

  route(app, {
    method: 'POST', url: '/v1/sales/targets', summary: 'Meta por vendedor, equipe, filial, produto e período (RN-VEN-07)', tags: ['Vendas'], permission: 'vendas.meta.editar', status: 201, company: true,
    body: z.object({ periodStart: isoDate, periodEnd: isoDate, salespersonId: z.string().uuid().nullish(), team: z.string().nullish(), establishmentId: z.string().uuid().nullish(),
      productId: z.string().uuid().nullish(), categoryId: z.string().uuid().nullish(), targetAmount: decimal({ min: 0 }).nullish(), targetQuantity: decimal({ min: 0 }).nullish() }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO sales.targets (tenant_id, company_id, period_start, period_end, salesperson_id, team, establishment_id, product_id, category_id, target_amount, target_quantity, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [tx.tenantId, tx.companyId, body.periodStart, body.periodEnd, body.salespersonId ?? null, body.team ?? null, body.establishmentId ?? null, body.productId ?? null, body.categoryId ?? null,
      body.targetAmount ?? null, body.targetQuantity ?? null, tx.userId]));

  route(app, {
    method: 'GET', url: '/v1/sales/targets/progress', summary: 'Realizado × meta (acompanhamento diário; alimenta o VORTEX Insights)', tags: ['Vendas'], permission: 'vendas.pedido.ler',
    query: z.object({ date: isoDate.optional() }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT t.*, sp.legal_name AS salesperson_name,
            coalesce((SELECT sum(di.item_total) FROM fiscal.documents d JOIN fiscal.document_items di ON di.document_id = d.id
                        JOIN catalog.products p ON p.id = di.product_id LEFT JOIN sales.orders o ON o.id = d.source_id AND d.source_type = 'sales_order'
                       WHERE d.status = 'autorizada' AND d.direction = 'S' AND d.tax_date BETWEEN t.period_start AND least(t.period_end, coalesce($2::date, current_date))
                         AND (t.salesperson_id IS NULL OR o.salesperson_id = t.salesperson_id) AND (t.establishment_id IS NULL OR d.establishment_id = t.establishment_id)
                         AND (t.product_id IS NULL OR di.product_id = t.product_id) AND (t.category_id IS NULL OR p.category_id = t.category_id)), 0) AS realized_amount
       FROM sales.targets t LEFT JOIN registry.parties sp ON sp.id = t.salesperson_id
      WHERE ($1::uuid IS NULL OR t.company_id = $1) AND coalesce($2::date, current_date) BETWEEN t.period_start AND t.period_end ORDER BY t.period_start`,
    [ctx.companyId, query.date ?? null]));
}

async function convertQuote(tx: import('../../db/tx.js').Tx, quoteId: string) {
  const q = await tx.one<Record<string, any>>(`SELECT * FROM sales.quotes WHERE id = $1 FOR UPDATE`, [quoteId], 'Orçamento');
  if (q.status === 'converted') throw conflict('QUOTE_CONVERTED', 'Orçamento já convertido em pedido');
  if (q.valid_until < new Date().toISOString().slice(0, 10)) throw conflict('QUOTE_EXPIRED', 'Orçamento vencido');
  const items = await tx.query(`SELECT * FROM sales.quote_items WHERE quote_id = $1 ORDER BY item_number`, [quoteId]);
  if (!items.length) throw notFound('Itens do orçamento');
  const order = await createOrder(tx, {
    establishmentId: q.establishment_id, partyId: q.party_id, salespersonId: q.salesperson_id, channel: q.channel, operationTypeCode: q.operation_type_code,
    paymentTermId: q.payment_term_id, paymentMethodId: q.payment_method_id, freightMode: q.freight_mode, freight: q.freight, discount: q.discount, quoteId,
    items: items.map((i) => ({ productId: i.product_id, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, discountPercent: i.discount_percent })),
  });
  await tx.exec(`UPDATE sales.quotes SET status = 'converted', order_id = $2 WHERE id = $1`, [quoteId, order.id]);
  return order;
}
