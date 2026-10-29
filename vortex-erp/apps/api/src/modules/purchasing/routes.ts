import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate } from '../../http/schemas.js';
import { supplierOverview, supplierProducts } from './suppliers.js';
import { AppError } from '../../errors.js';
import { systemContext, withTenant } from '../../db/tx.js';
import { safeEqual } from '../../core/crypto.js';
import { assertEstablishmentScope, has } from '../../core/access.js';
import { manifest } from '../fiscal-docs/inbound.js';
import { transmitDocument } from '../fiscal-docs/documents.js';
import {
  awardRfq, cancelPurchaseOrder, createPurchaseOrder, createRequest, createRfq, getPurchaseOrder, getRequest, getRfq, purchaseOrderPdf, purchaseSuggestion, respondRfq,
  rfqMap, submitPurchaseOrder, updatePurchaseOrder,
} from './orders.js';
import {
  cancelReceipt, checkReceipt, completeReceipt, countReceipt, createPurchaseReturn, getReceipt, importReceipt, linkOrder, mapReceiptItem, registerFreight, taxCreditBook,
} from './receiving.js';

const poItem = z.object({ productId: z.string().uuid(), quantity: decimal({ positive: true }), unitPrice: decimal({ min: 0 }), ipiRate: decimal({ min: 0 }).nullish(),
  requestItemId: z.string().uuid().nullish() });
const poBody = z.object({
  establishmentId: z.string().uuid(), warehouseId: z.string().uuid().nullish(), supplierId: z.string().uuid(), freightMode: z.number().int().min(0).max(9).optional(),
  freight: decimal({ min: 0 }).nullish(), paymentTermId: z.string().uuid().nullish(), expectedDate: isoDate.nullish(), costCenterId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(), notes: z.string().nullish(), items: z.array(poItem).min(1), submit: z.boolean().default(true),
});

async function supplierEmail(tx: any, supplierId: string): Promise<string | null> {
  const p = await tx.one(`SELECT xml_email FROM registry.parties WHERE id = $1`, [supplierId]);
  if (p.xml_email) return p.xml_email;
  return (await tx.maybeOne(`SELECT email FROM registry.party_contacts WHERE party_id = $1 AND email IS NOT NULL ORDER BY created_at LIMIT 1`, [supplierId]))?.email ?? null;
}

export function registerPurchasingRoutes(app: App) {
  // ---------------------------------------------------------------- requisições
  route(app, {
    method: 'POST', url: '/v1/purchasing/requests', summary: 'Requisição de compra (item ou serviço, centro de custo e justificativa)', tags: ['Compras'],
    permission: 'compras.requisicao.criar', status: 201,
    body: z.object({ establishmentId: z.string().uuid(), costCenterId: z.string().uuid().nullish(), justification: z.string().min(5), neededBy: isoDate.nullish(),
      items: z.array(z.object({ productId: z.string().uuid().nullish(), description: z.string().nullish(), quantity: decimal({ positive: true }), unit: z.string().optional() })).min(1) }),
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return createRequest(tx, body);
  });

  route(app, {
    method: 'GET', url: '/v1/purchasing/requests', summary: 'Requisições de compra', tags: ['Compras'], permission: 'compras.pedido.ler', query: z.object({ status: z.string().optional() }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT r.*, c.code AS cost_center_code FROM purchasing.requests r LEFT JOIN finance.cost_centers c ON c.id = r.cost_center_id
      WHERE ($1::uuid IS NULL OR r.company_id = $1) AND ($2::text IS NULL OR r.status = $2) ORDER BY r.created_at DESC LIMIT 500`, [ctx.companyId, query.status ?? null]));

  route(app, { method: 'GET', url: '/v1/purchasing/requests/:id', summary: 'Requisição', tags: ['Compras'], permission: 'compras.pedido.ler', params: idParams },
    async ({ tx, params }) => getRequest(tx, params.id));

  // ---------------------------------------------------------------- cotações
  route(app, {
    method: 'POST', url: '/v1/purchasing/rfqs', summary: 'Cotação a vários fornecedores (link por fornecedor; envio por e-mail ou WhatsApp)', tags: ['Compras'],
    permission: 'compras.cotacao.criar', status: 201,
    body: z.object({ establishmentId: z.string().uuid(), requestId: z.string().uuid().nullish(), deadline: z.string().datetime({ offset: true }).nullish(),
      items: z.array(z.object({ productId: z.string().uuid(), quantity: decimal({ positive: true }), unit: z.string().optional() })).optional(),
      supplierIds: z.array(z.string().uuid()).min(1), notify: z.boolean().default(true) }),
  }, async ({ tx, ctx, body, deps }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    const rfq = await createRfq(tx, body);
    if (body.notify) {
      for (const s of rfq.suppliers) {
        const email = await supplierEmail(tx, s.supplier_id);
        const wa = await tx.maybeOne<{ whatsapp: string }>(`SELECT whatsapp FROM registry.party_contacts WHERE party_id = $1 AND whatsapp IS NOT NULL LIMIT 1`, [s.supplier_id]);
        const text = `Cotação ${rfq.number}: informe seus preços, prazo e frete pelo link`;
        if (email) await deps.services.mailer.send({ to: email, subject: text, html: `<p>${text}: <a href="${s.link}">${s.link}</a></p>` });
        if (wa) await deps.services.messenger.sendWhatsApp(wa.whatsapp, text, s.link);
      }
    }
    return rfq;
  });

  route(app, { method: 'GET', url: '/v1/purchasing/rfqs/:id', summary: 'Cotação', tags: ['Compras'], permission: 'compras.pedido.ler', params: idParams },
    async ({ tx, params }) => getRfq(tx, params.id));

  route(app, { method: 'GET', url: '/v1/purchasing/rfqs/:id/map', summary: 'Mapa comparativo: preço, prazo, frete e condição; melhor por item e global', tags: ['Compras'],
    permission: 'compras.pedido.ler', params: idParams }, async ({ tx, params }) => rfqMap(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/purchasing/rfqs/:id/award', summary: 'Escolha por item ou global: gera os pedidos de compra', tags: ['Compras'], permission: 'compras.pedido.criar', params: idParams,
    body: z.object({ mode: z.enum(['item', 'global']), supplierId: z.string().uuid().nullish(), selections: z.array(z.object({ rfqItemId: z.string().uuid(), supplierId: z.string().uuid() })).optional(),
      warehouseId: z.string().uuid().nullish(), paymentTermId: z.string().uuid().nullish(), costCenterId: z.string().uuid().nullish() }),
  }, async ({ tx, params, body }) => ({ orders: await awardRfq(tx, params.id, body) }));

  // Resposta do fornecedor pelo link (sem login)
  app.get('/public/rfq/:token', { schema: { hide: true } }, async (req) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const { tenant } = z.object({ tenant: z.string().uuid() }).parse(req.query);
    return withTenant(app.deps.pool, systemContext(tenant), async (tx) => {
      const s = await tx.maybeOne(`SELECT s.rfq_id, s.token, p.legal_name FROM purchasing.rfq_suppliers s JOIN registry.parties p ON p.id = s.supplier_id WHERE s.token = $1`, [token]);
      if (!s || !safeEqual(s.token, token)) throw new AppError('NOT_FOUND', 'Cotação não encontrada', 404);
      const rfq = await tx.one(`SELECT r.number, r.deadline, r.status, e.trade_name AS buyer FROM purchasing.rfqs r JOIN core.establishments e ON e.id = r.establishment_id WHERE r.id = $1`, [s.rfq_id]);
      const items = await tx.query(`SELECT ri.id, p.description, p.gtin, ri.quantity, ri.unit FROM purchasing.rfq_items ri JOIN catalog.products p ON p.id = ri.product_id WHERE ri.rfq_id = $1`, [s.rfq_id]);
      return { ...rfq, supplier: s.legal_name, items };
    }, { readOnly: true });
  });

  app.post('/public/rfq/:token', { schema: { hide: true } }, async (req) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const { tenant } = z.object({ tenant: z.string().uuid() }).parse(req.query);
    const body = z.object({
      items: z.array(z.object({ rfqItemId: z.string().uuid(), unitPrice: decimal({ min: 0 }), leadTimeDays: z.number().int().min(0).nullish() })).min(1),
      freight: decimal({ min: 0 }).nullish(), freightMode: z.number().int().min(0).max(9).nullish(), paymentTerms: z.string().max(200).nullish(),
    }).parse(req.body);
    return withTenant(app.deps.pool, { ...systemContext(tenant), device: 'portal-fornecedor', ip: req.ip }, (tx) => respondRfq(tx, token, body));
  });

  // ---------------------------------------------------------------- pedidos de compra
  route(app, {
    method: 'POST', url: '/v1/purchasing/orders', summary: 'Pedido de compra (aprovado na hora dentro da alçada; acima dela vai para aprovação)', tags: ['Compras'],
    permission: 'compras.pedido.criar', status: 201, body: poBody,
  }, async ({ tx, ctx, body, req }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    const o = await createPurchaseOrder(tx, { ...body, idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null });
    if (body.submit && o.status === 'draft') await submitPurchaseOrder(tx, o.id);
    return getPurchaseOrder(tx, o.id);
  });

  route(app, {
    method: 'GET', url: '/v1/purchasing/orders', summary: 'Pedidos de compra', tags: ['Compras'], permission: 'compras.pedido.ler',
    query: z.object({ status: z.string().optional(), supplierId: z.string().uuid().optional() }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT o.*, p.legal_name AS supplier_name FROM purchasing.orders o JOIN registry.parties p ON p.id = o.supplier_id
      WHERE ($1::uuid IS NULL OR o.company_id = $1) AND ($2::text IS NULL OR o.status = $2) AND ($3::uuid IS NULL OR o.supplier_id = $3) ORDER BY o.created_at DESC LIMIT 500`,
    [ctx.companyId, query.status ?? null, query.supplierId ?? null]));

  route(app, { method: 'GET', url: '/v1/purchasing/orders/:id', summary: 'Pedido de compra', tags: ['Compras'], permission: 'compras.pedido.ler', params: idParams },
    async ({ tx, params }) => getPurchaseOrder(tx, params.id));

  route(app, {
    method: 'PATCH', url: '/v1/purchasing/orders/:id', summary: 'Altera pedido ainda não aprovado (volta a rascunho)', tags: ['Compras'], permission: 'compras.pedido.criar', params: idParams,
    body: poBody.omit({ establishmentId: true, supplierId: true, submit: true, warehouseId: true, categoryId: true }).partial().extend({ version: z.number().int() }),
  }, async ({ tx, params, body }) => updatePurchaseOrder(tx, params.id, body));

  route(app, { method: 'POST', url: '/v1/purchasing/orders/:id/submit', summary: 'Envia para aprovação por alçada e centro de custo', tags: ['Compras'], permission: 'compras.pedido.criar', params: idParams },
    async ({ tx, params }) => submitPurchaseOrder(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/purchasing/orders/:id/cancel', summary: 'Cancela o pedido ou o saldo não recebido', tags: ['Compras'], permission: 'compras.pedido.criar', params: idParams,
    body: z.object({ reason: z.string().min(5) }),
  }, async ({ tx, params, body }) => cancelPurchaseOrder(tx, params.id, body.reason));

  route(app, { method: 'GET', url: '/v1/purchasing/orders/:id/pdf', summary: 'Pedido em PDF para o fornecedor', tags: ['Compras'], permission: 'compras.pedido.ler', params: idParams },
    async ({ tx, params, reply }) => {
      const pdf = await purchaseOrderPdf(tx, params.id);
      reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="pedido-compra-${params.id}.pdf"`);
      return pdf;
    });

  route(app, {
    method: 'POST', url: '/v1/purchasing/orders/:id/send', summary: 'Envia o pedido aprovado ao fornecedor (PDF por e-mail)', tags: ['Compras'], permission: 'compras.pedido.criar', params: idParams,
  }, async ({ tx, params, deps }) => {
    const o = await getPurchaseOrder(tx, params.id);
    const pdf = await purchaseOrderPdf(tx, params.id);
    const email = await supplierEmail(tx, o.supplier_id);
    if (!email) throw new AppError('VALIDATION', 'Fornecedor sem e-mail cadastrado', 422, { fields: { supplierId: 'Cadastre o e-mail do fornecedor' } });
    await deps.services.mailer.send({ to: email, subject: `Pedido de compra ${o.number}`, html: `<p>Segue o pedido de compra ${o.number}. Informe o número do pedido na NF-e.</p>`,
      attachments: [{ filename: `pedido-compra-${o.number}.pdf`, content: pdf, contentType: 'application/pdf' }] });
    await tx.exec(`UPDATE purchasing.orders SET sent_at = now() WHERE id = $1`, [params.id]);
    return { sentTo: email };
  });

  route(app, {
    method: 'GET', url: '/v1/purchasing/suppliers', summary: 'Fornecedores de reposição: compras em 12 meses, última compra, produtos fornecidos, pedidos em aberto e saldo a pagar',
    tags: ['Compras'], permission: 'compras.pedido.ler', query: z.object({ q: z.string().max(80).optional() }),
  }, async ({ tx, ctx, query }) => supplierOverview(tx, ctx.companyId, query.q || null));

  route(app, {
    method: 'GET', url: '/v1/purchasing/suppliers/:id/products', summary: 'Produtos que o fornecedor nos vende, com o último preço', tags: ['Compras'], permission: 'compras.pedido.ler',
    params: idParams,
  }, async ({ tx, params }) => supplierProducts(tx, params.id));

  route(app, {
    method: 'GET', url: '/v1/purchasing/suggestions', summary: 'Sugestão de compra: abaixo do ponto de pedido com saldo, pedidos em aberto, consumo médio e prazo do fornecedor',
    tags: ['Compras'], permission: 'compras.pedido.ler', query: z.object({ warehouseId: z.string().uuid(), days: z.coerce.number().int().min(7).max(365).default(90) }),
  }, async ({ tx, query }) => purchaseSuggestion(tx, query.warehouseId, query.days));

  // ---------------------------------------------------------------- recebimento
  const receiptImport = z.object({ establishmentId: z.string().uuid(), warehouseId: z.string().uuid().nullish(), orderId: z.string().uuid().nullish(), blindCount: z.boolean().optional(),
    operationTypeCode: z.string().nullish() });

  route(app, {
    method: 'POST', url: '/v1/purchasing/receipts', summary: 'Pré-recebimento a partir do XML da NF-e do fornecedor (vínculo ao pedido e de-para)', tags: ['Compras'],
    permission: 'compras.recebimento.criar', status: 201, body: receiptImport.extend({ xml: z.string().min(50) }),
  }, async ({ tx, ctx, body, deps }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return importReceipt(tx, deps.services, body);
  });

  route(app, {
    method: 'POST', url: '/v1/purchasing/receipts/from-inbound/:id', summary: 'Pré-recebimento a partir de uma nota baixada pela distribuição DF-e', tags: ['Compras'],
    permission: 'compras.recebimento.criar', status: 201, params: idParams, body: receiptImport.omit({ establishmentId: true }).default({}),
  }, async ({ tx, ctx, params, body, deps }) => {
    const inb = await tx.one<{ establishment_id: string; xml_key: string | null; content: string }>(`SELECT establishment_id, xml_key, content FROM fiscal.inbound_documents WHERE id = $1`, [params.id], 'Nota de entrada');
    if (!inb.xml_key || inb.content !== 'full') throw new AppError('XML_NOT_AVAILABLE', 'XML completo ainda não disponível: registre a ciência da operação para baixá-lo', 409);
    assertEstablishmentScope(ctx, inb.establishment_id);
    const xml = (await deps.services.storage.get(inb.xml_key)).toString('utf8');
    return importReceipt(tx, deps.services, { ...body, establishmentId: inb.establishment_id, xml });
  });

  route(app, {
    method: 'GET', url: '/v1/purchasing/receipts', summary: 'Recebimentos', tags: ['Compras'], permission: 'compras.recebimento.criar',
    query: z.object({ status: z.string().optional(), withoutOrder: z.coerce.boolean().optional() }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT r.id, r.number, r.series, r.access_key, r.issue_date, r.status, r.without_order, r.blind_count, r.order_id, r.created_at, r.completed_at,
            CASE WHEN r.blind_count AND r.status NOT IN ('completed','cancelled') AND NOT $4 THEN NULL ELSE r.total_invoice END AS total_invoice, p.legal_name AS supplier_name
       FROM purchasing.receipts r JOIN registry.parties p ON p.id = r.supplier_id
      WHERE ($1::uuid IS NULL OR r.company_id = $1) AND ($2::text IS NULL OR r.status = $2) AND ($3::boolean IS NULL OR r.without_order = $3) ORDER BY r.created_at DESC LIMIT 500`,
    [ctx.companyId, query.status ?? null, query.withoutOrder ?? null, has(ctx, 'compras.recebimento.aprovar')]));

  route(app, { method: 'GET', url: '/v1/purchasing/receipts/:id', summary: 'Recebimento (conferência cega oculta as quantidades da nota a quem confere)', tags: ['Compras'],
    permission: 'compras.recebimento.criar', params: idParams },
  async ({ tx, ctx, params }) => getReceipt(tx, params.id, { blind: !has(ctx, 'compras.recebimento.aprovar') }));

  route(app, {
    method: 'PUT', url: '/v1/purchasing/receipts/:id/items/:itemId/product', summary: 'De-para manual ou confirmação da sugestão (produto e fator da unidade)', tags: ['Compras'],
    permission: 'compras.recebimento.criar', params: z.object({ id: z.string().uuid(), itemId: z.string().uuid() }),
    body: z.object({ productId: z.string().uuid(), factor: decimal({ positive: true }).nullish() }),
  }, async ({ tx, params, body }) => mapReceiptItem(tx, params.id, params.itemId, body));

  route(app, {
    method: 'POST', url: '/v1/purchasing/receipts/:id/order', summary: 'Vincula a nota a um pedido de compra', tags: ['Compras'], permission: 'compras.recebimento.criar', params: idParams,
    body: z.object({ orderId: z.string().uuid() }),
  }, async ({ tx, params, body }) => linkOrder(tx, params.id, body.orderId));

  route(app, {
    method: 'POST', url: '/v1/purchasing/receipts/:id/count', summary: 'Conferência física (quantidade em unidade de estoque, lote e validade)', tags: ['Compras'],
    permission: 'compras.recebimento.criar', params: idParams,
    body: z.object({ items: z.array(z.object({ itemId: z.string().uuid(), quantity: decimal({ min: 0 }), lotNumber: z.string().nullish(), expiresAt: isoDate.nullish() })).min(1) }),
  }, async ({ tx, params, body }) => countReceipt(tx, params.id, body.items));

  route(app, { method: 'POST', url: '/v1/purchasing/receipts/:id/check', summary: 'Conferência de três vias: pedido × nota × físico; divergências vão para o comprador', tags: ['Compras'],
    permission: 'compras.recebimento.criar', params: idParams }, async ({ tx, params }) => checkReceipt(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/purchasing/receipts/:id/complete', summary: 'Conclui: estoque, custo de entrada, créditos, títulos a pagar e contábil numa transação', tags: ['Compras'],
    permission: 'compras.recebimento.criar', params: idParams,
    afterCommit: async (result, a) => {
      // Manifestação "confirmação da operação" (melhor esforço: a SEFAZ pode estar fora)
      try {
        const inb = await withTenant(a.deps.pool, a.ctx, (tx) => tx.maybeOne<{ id: string; manifestation: string }>(
          `SELECT id, manifestation FROM fiscal.inbound_documents WHERE receipt_id = $1`, [result.id]), { readOnly: true });
        if (inb && ['none', 'ciencia'].includes(inb.manifestation)) await manifest(a.deps.pool, a.ctx, a.deps.services, inb.id, 'confirmada');
        return { ...result, manifestation: 'confirmada' };
      } catch (e) {
        return { ...result, manifestation: 'pendente', manifestationError: (e as Error).message };
      }
    },
  }, async ({ tx, params }) => completeReceipt(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/purchasing/receipts/:id/cancel', summary: 'Cancela o pré-recebimento (nada foi lançado)', tags: ['Compras'], permission: 'compras.recebimento.criar', params: idParams,
    body: z.object({ reason: z.string().min(5) }),
  }, async ({ tx, params, body }) => cancelReceipt(tx, params.id, body.reason));

  route(app, {
    method: 'POST', url: '/v1/purchasing/freight-documents', summary: 'CT-e de frete de compra rateado entre notas e itens (por valor ou peso)', tags: ['Compras'],
    permission: 'compras.recebimento.criar', status: 201,
    body: z.object({ carrierId: z.string().uuid(), accessKey: z.string().length(44).nullish(), number: z.string().min(1), issueDate: isoDate, total: decimal({ positive: true }),
      icmsCredit: decimal({ min: 0 }).nullish(), method: z.enum(['value', 'weight']).default('value'), receiptIds: z.array(z.string().uuid()).min(1), dueDate: isoDate.nullish(),
      cfop: z.string().length(4).nullish() }),
  }, async ({ tx, body }) => registerFreight(tx, body));

  // ---------------------------------------------------------------- devolução a fornecedor
  route(app, {
    method: 'POST', url: '/v1/purchasing/returns', summary: 'Devolução a fornecedor: NF-e de devolução, baixa de estoque, estorno de créditos e abatimento/crédito', tags: ['Compras'],
    permission: 'compras.devolucao.criar', status: 201,
    body: z.object({ receiptId: z.string().uuid(), items: z.array(z.object({ receiptItemId: z.string().uuid(), quantity: decimal({ positive: true }) })).min(1), reason: z.string().min(5),
      financialTreatment: z.enum(['abatement', 'supplier_credit']).default('abatement') }),
    afterCommit: async (result, a) => {
      if (!result?.document_id) return result;
      const transmission = await transmitDocument(a.deps.pool, a.ctx, a.deps.services, result.document_id);
      return { ...result, transmission };
    },
  }, async ({ tx, body, req }) => createPurchaseReturn(tx, { ...body, idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null }));

  route(app, { method: 'GET', url: '/v1/purchasing/returns', summary: 'Devoluções a fornecedor', tags: ['Compras'], permission: 'compras.pedido.ler' },
    async ({ tx, ctx }) => tx.query(`SELECT r.*, p.legal_name AS supplier_name FROM purchasing.returns r JOIN registry.parties p ON p.id = r.supplier_id
                                       WHERE ($1::uuid IS NULL OR r.company_id = $1) ORDER BY r.created_at DESC LIMIT 500`, [ctx.companyId]));

  // ---------------------------------------------------------------- relatórios
  route(app, {
    method: 'GET', url: '/v1/purchasing/reports/off-process', summary: 'Compras fora do processo: notas aceitas sem pedido de compra (RN-COM-06)', tags: ['Compras'],
    permission: 'compras.pedido.ler', query: z.object({ from: isoDate, to: isoDate }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT r.id, r.number, r.issue_date, r.total_invoice, r.completed_at, p.legal_name AS supplier_name, u.name AS accepted_by
       FROM purchasing.receipts r JOIN registry.parties p ON p.id = r.supplier_id LEFT JOIN core.users u ON u.id = r.completed_by
      WHERE ($1::uuid IS NULL OR r.company_id = $1) AND r.status = 'completed' AND r.order_id IS NULL AND r.completed_at::date BETWEEN $2 AND $3 ORDER BY r.completed_at`,
    [ctx.companyId, query.from, query.to]));

  route(app, {
    method: 'GET', url: '/v1/fiscal/tax-credits', summary: 'Livro de créditos por tributo: apropriados, condicionados ao pagamento, estornados e disponíveis (RN-REF-04)',
    tags: ['Fiscal'], permission: 'fiscal.entrada.ler', query: z.object({ establishmentId: z.string().uuid().optional(), from: isoDate, to: isoDate }),
  }, async ({ tx, query }) => taxCreditBook(tx, query.establishmentId ?? null, query.from, query.to));
}
