import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate } from '../../http/schemas.js';
import { assertEstablishmentScope } from '../../core/access.js';
import { createOutgoingDocument, prepareForTransmission, transmitDocument } from '../fiscal-docs/documents.js';
import { billContract, cancelContract, changePlan, contractIndicators, createContract, getContract, recordUsage, runRecurringBilling } from './service.js';
import { addPart, createServiceOrder, getServiceOrder, invoiceServiceOrder, removePart, signServiceOrder, updateServiceOrder } from './service-orders.js';

const item = z.object({ productId: z.string().uuid(), description: z.string().nullish(), billingType: z.enum(['fixed', 'usage']).default('fixed'), quantity: decimal({ positive: true }).default('1'),
  unitPrice: decimal({ min: 0 }), usageMetric: z.string().nullish(), includedQuantity: decimal({ min: 0 }).default('0') });

/** Transmite os documentos gerados depois do commit (o job também reenviaria). */
async function transmitAll(ids: string[], a: { ctx: any; deps: any }) {
  const out = [];
  for (const id of ids) out.push({ documentId: id, ...(await transmitDocument(a.deps.pool, a.ctx, a.deps.services, id)) });
  return out;
}

export function registerContractRoutes(app: App) {
  route(app, {
    method: 'POST', url: '/v1/contracts', summary: 'Contrato: itens, periodicidade, dia de faturamento, reajuste por índice, multa e renovação', tags: ['Contratos'],
    permission: 'contratos.contrato.editar', status: 201,
    body: z.object({
      establishmentId: z.string().uuid(), partyId: z.string().uuid(), periodicity: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']), billingDay: z.number().int().min(1).max(28),
      dueDays: z.number().int().min(0).max(90).optional(), startDate: isoDate, endDate: isoDate.nullish(), autoRenew: z.boolean().optional(), renewalMonths: z.number().int().min(1).max(60).optional(),
      adjustmentIndex: z.enum(['IPCA', 'IGPM', 'INPC', 'fixed']).nullish(), adjustmentPercent: decimal().nullish(), adjustmentDate: isoDate.nullish(),
      terminationFinePercent: decimal({ min: 0 }).optional(), proration: z.enum(['prorata', 'next_cycle']).optional(), documentModel: z.enum(['99', '55', 'none']).optional(),
      paymentMethodId: z.string().uuid().nullish(), chargeKind: z.enum(['boleto', 'pix_cob', 'pix_cobv']).nullish(), chargeAccountId: z.string().uuid().nullish(),
      categoryId: z.string().uuid().nullish(), costCenterId: z.string().uuid().nullish(), notes: z.string().nullish(), items: z.array(item).min(1),
    }),
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return createContract(tx, body);
  });

  route(app, {
    method: 'GET', url: '/v1/contracts', summary: 'Contratos', tags: ['Contratos'], permission: 'contratos.contrato.ler', query: z.object({ status: z.string().optional() }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT c.*, p.legal_name AS party_name FROM contracts.contracts c JOIN registry.parties p ON p.id = c.party_id
      WHERE ($1::uuid IS NULL OR c.company_id = $1) AND ($2::text IS NULL OR c.status = $2) ORDER BY c.number DESC LIMIT 500`, [ctx.companyId, query.status ?? null]));

  route(app, { method: 'GET', url: '/v1/contracts/indicators', summary: 'MRR, churn, receita por cliente, inadimplência por contrato e renovações em 60 dias', tags: ['Contratos'],
    permission: 'contratos.contrato.ler', query: z.object({ date: isoDate.optional() }) }, async ({ tx, ctx, query }) => contractIndicators(tx, ctx.companyId, query.date));

  route(app, { method: 'GET', url: '/v1/contracts/:id', summary: 'Contrato com itens, histórico de valores e faturamentos', tags: ['Contratos'], permission: 'contratos.contrato.ler', params: idParams },
    async ({ tx, params }) => getContract(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/contracts/:id/bill', summary: 'Fatura o período devido agora (o job diário faz isso automaticamente)', tags: ['Contratos'], permission: 'contratos.contrato.editar',
    params: idParams, body: z.object({ date: isoDate.optional() }).default({}),
    afterCommit: async (result, a) => (result?.documentIds?.length ? { ...result, transmissions: await transmitAll(result.documentIds, a) } : result),
  }, async ({ tx, params, body, deps }) => billContract(tx, deps.services, params.id, body.date));

  route(app, {
    method: 'POST', url: '/v1/contracts/:id/plan', summary: 'Troca de plano com pro rata (RN-CTR-02)', tags: ['Contratos'], permission: 'contratos.contrato.editar', params: idParams,
    body: z.object({ effectiveDate: isoDate, items: z.array(item).min(1) }),
  }, async ({ tx, params, body, deps }) => changePlan(tx, deps.services, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/contracts/:id/cancel', summary: 'Rescisão com multa contratual (motivo obrigatório)', tags: ['Contratos'], permission: 'contratos.contrato.editar', params: idParams,
    body: z.object({ reason: z.string(), date: isoDate.optional(), applyFine: z.boolean().optional() }),
  }, async ({ tx, params, body, deps }) => cancelContract(tx, deps.services, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/contracts/usage', summary: 'Consumo variável (API, planilha ou VORTEX Meter); idempotente pela referência', tags: ['Contratos'], permission: 'contratos.contrato.editar',
    status: 201, body: z.object({ records: z.array(z.object({ contractItemId: z.string().uuid(), occurredOn: isoDate, quantity: decimal(), reference: z.string().min(1).max(120),
      source: z.enum(['api', 'csv', 'meter', 'manual']).optional() })).min(1).max(5000) }),
  }, async ({ tx, body }) => {
    let created = 0;
    for (const r of body.records) if (!('duplicate' in (await recordUsage(tx, r)))) created++;
    return { created, duplicates: body.records.length - created };
  });

  route(app, {
    method: 'PUT', url: '/v1/contracts/index-rates', summary: 'Índices mensais de reajuste (IPCA, IGP-M, INPC)', tags: ['Contratos'], permission: 'contratos.contrato.editar',
    body: z.object({ rates: z.array(z.object({ index: z.enum(['IPCA', 'IGPM', 'INPC']), month: z.string().regex(/^\d{4}-\d{2}$/), percent: decimal() })).min(1) }),
  }, async ({ tx, body }) => {
    for (const r of body.rates) {
      await tx.exec(`INSERT INTO contracts.index_rates (tenant_id, index_code, month, percent) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, index_code, month) DO UPDATE SET percent = EXCLUDED.percent`,
        [tx.tenantId, r.index, `${r.month}-01`, r.percent]);
    }
    return { saved: body.rates.length };
  });

  route(app, {
    method: 'POST', url: '/v1/contracts/billing/run', summary: 'Roda o faturamento recorrente do dia', tags: ['Contratos'], permission: 'contratos.contrato.editar',
    body: z.object({ date: isoDate.optional() }).default({}),
  }, async ({ tx, body, deps }) => runRecurringBilling(tx, deps.services, body.date));

  // ---------------------------------------------------------------- ordens de serviço
  route(app, {
    method: 'POST', url: '/v1/service-orders', summary: 'Abre ordem de serviço', tags: ['Ordens de serviço'], permission: 'contratos.contrato.editar', status: 201,
    body: z.object({ establishmentId: z.string().uuid(), partyId: z.string().uuid(), contractId: z.string().uuid().nullish(), serviceProductId: z.string().uuid(),
      technicianId: z.string().uuid().nullish(), description: z.string().min(3), scheduledAt: z.string().datetime({ offset: true }).nullish(), hourlyRate: decimal({ min: 0 }).nullish(),
      warehouseId: z.string().uuid().nullish() }),
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return createServiceOrder(tx, body);
  });

  route(app, { method: 'GET', url: '/v1/service-orders', summary: 'Ordens de serviço (agenda)', tags: ['Ordens de serviço'], permission: 'contratos.contrato.ler',
    query: z.object({ status: z.string().optional(), technicianId: z.string().uuid().optional() }) },
  async ({ tx, ctx, query }) => tx.query(
    `SELECT so.*, p.legal_name AS party_name FROM contracts.service_orders so JOIN registry.parties p ON p.id = so.party_id
      WHERE ($1::uuid IS NULL OR so.company_id = $1) AND ($2::text IS NULL OR so.status = $2) AND ($3::uuid IS NULL OR so.technician_id = $3)
      ORDER BY coalesce(so.scheduled_at, so.created_at) LIMIT 500`, [ctx.companyId, query.status ?? null, query.technicianId ?? null]));

  route(app, { method: 'GET', url: '/v1/service-orders/:id', summary: 'Ordem de serviço', tags: ['Ordens de serviço'], permission: 'contratos.contrato.ler', params: idParams },
    async ({ tx, params }) => getServiceOrder(tx, params.id));

  route(app, {
    method: 'PATCH', url: '/v1/service-orders/:id', summary: 'Agenda, técnico, início/conclusão e horas', tags: ['Ordens de serviço'], permission: 'contratos.contrato.editar', params: idParams,
    body: z.object({ status: z.enum(['scheduled', 'in_progress', 'done']).optional(), scheduledAt: z.string().datetime({ offset: true }).nullish(), technicianId: z.string().uuid().nullish(),
      hours: decimal({ min: 0 }).optional(), hourlyRate: decimal({ min: 0 }).optional() }),
  }, async ({ tx, params, body }) => updateServiceOrder(tx, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/service-orders/:id/parts', summary: 'Peça aplicada (baixa o estoque)', tags: ['Ordens de serviço'], permission: 'contratos.contrato.editar', params: idParams, status: 201,
    body: z.object({ productId: z.string().uuid(), quantity: decimal({ positive: true }), unitPrice: decimal({ min: 0 }) }),
  }, async ({ tx, params, body }) => addPart(tx, params.id, body));

  route(app, { method: 'DELETE', url: '/v1/service-orders/:id/parts/:partId', summary: 'Remove peça (volta ao estoque)', tags: ['Ordens de serviço'], permission: 'contratos.contrato.editar',
    params: z.object({ id: z.string().uuid(), partId: z.string().uuid() }) }, async ({ tx, params }) => removePart(tx, params.id, params.partId));

  route(app, {
    method: 'POST', url: '/v1/service-orders/:id/signature', summary: 'Assinatura do cliente', tags: ['Ordens de serviço'], permission: 'contratos.contrato.editar', params: idParams,
    body: z.object({ signedBy: z.string().min(3), signaturePng: z.string().max(2_000_000).nullish() }),
  }, async ({ tx, params, body, deps }) => signServiceOrder(tx, deps.services, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/service-orders/:id/invoice', summary: 'Fatura a OS (NFS-e, título e contábil)', tags: ['Ordens de serviço'], permission: 'contratos.contrato.editar', params: idParams,
    body: z.object({ dueDate: isoDate.nullish() }).default({}),
    afterCommit: async (result, a) => ({ ...result, transmission: (await transmitAll([result.documentId], a))[0] }),
  }, async ({ tx, params, body }) => invoiceServiceOrder(tx, params.id, body));

  // ---------------------------------------------------------------- NFS-e avulsa
  route(app, {
    method: 'POST', url: '/v1/fiscal/nfse', summary: 'Emite NFS-e padrão nacional avulsa (DPS → Sefin Nacional)', tags: ['Documentos fiscais'], permission: 'fiscal.nota.emitir', status: 201,
    body: z.object({ establishmentId: z.string().uuid(), partyId: z.string().uuid(), items: z.array(z.object({ productId: z.string().uuid(), quantity: decimal({ positive: true }),
      unitPrice: decimal({ min: 0 }), discount: decimal({ min: 0 }).optional() })).min(1), additionalInfo: z.string().nullish() }),
    afterCommit: async (result, a) => ({ ...result, transmission: (await transmitAll([result.id], a))[0] }),
  }, async ({ tx, ctx, body, req }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    const doc = await createOutgoingDocument(tx, {
      establishmentId: body.establishmentId, operationTypeCode: 'SERVICO', model: '99', partyId: body.partyId, presence: 9,
      items: body.items.map((i, k) => ({ id: String(k + 1), ...i })), additionalInfo: body.additionalInfo ?? null, sourceType: 'manual',
      idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
    });
    return prepareForTransmission(tx, doc.id);
  });
}
