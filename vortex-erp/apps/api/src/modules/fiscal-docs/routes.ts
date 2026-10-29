import { z } from 'zod';
import { resolveContext, route, type App } from '../../http/app.js';
import { decimal, decodeCursor, idParams, isoDate, page } from '../../http/schemas.js';
import { AppError, notFound } from '../../errors.js';
import { systemContext, withTenant } from '../../db/tx.js';
import { safeEqual } from '../../core/crypto.js';
import { assertEstablishmentScope, requirePerm } from '../../core/access.js';
import {
  CCE_ALLOWED_FIELDS, cancelDocument, correctionLetter, createOutgoingDocument, createReturnDocument, getDocument, inutilizeNumbers, prepareForTransmission, transmitDocument,
} from './documents.js';
import { renderDanfeHtml } from './danfe.js';
import { manifest, runDistribution } from './inbound.js';
import { enqueue } from '../../core/jobs.js';

/** Transmite depois do commit e devolve o documento com o resultado da SEFAZ. */
export async function transmitAfterCommit(result: { document?: { id: string }; id?: string } & Record<string, any>, a: { ctx: any; deps: any }) {
  const id = result.document?.id ?? result.id;
  if (!id) return result;
  const outcome = await transmitDocument(a.deps.pool, a.ctx, a.deps.services, id);
  return { ...result, transmission: outcome };
}

export function registerFiscalDocumentRoutes(app: App) {
  route(app, {
    method: 'GET', url: '/v1/fiscal/documents', summary: 'Documentos fiscais (NF-e, NFC-e, NFS-e) com filtros', tags: ['Documentos fiscais'], permission: 'fiscal.nota.ler',
    query: z.object({ status: z.string().optional(), model: z.string().optional(), direction: z.enum(['S', 'E']).optional(), partyId: z.string().uuid().optional(),
      from: isoDate.optional(), to: isoDate.optional(), q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(50), cursor: z.string().optional() }),
  }, async ({ tx, ctx, query }) => {
    const c = decodeCursor(query.cursor);
    const rows = await tx.query(
      `SELECT id, model, series, number, access_key, status, direction, issuer_kind, operation_code, recipient_name, recipient_tax_id, total_invoice, issued_at, authorized_at,
              sefaz_code, sefaz_message, rejection_explanation, source_type, source_id, emission_type, created_at
         FROM fiscal.documents
        WHERE ($1::uuid IS NULL OR company_id = $1) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR model = $3) AND ($4::text IS NULL OR direction = $4)
          AND ($5::uuid IS NULL OR party_id = $5) AND ($6::date IS NULL OR tax_date >= $6) AND ($7::date IS NULL OR tax_date <= $7)
          AND ($8::text IS NULL OR access_key = $8 OR number::text = $8 OR recipient_name ILIKE '%' || $8 || '%')
          AND ($9::timestamptz IS NULL OR (created_at, id) < ($9, $10::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $11`,
      [ctx.companyId, query.status ?? null, query.model ?? null, query.direction ?? null, query.partyId ?? null, query.from ?? null, query.to ?? null, query.q ?? null,
        c?.at ?? null, c?.id ?? null, query.limit + 1]);
    return page(rows, query.limit);
  });

  route(app, { method: 'GET', url: '/v1/fiscal/documents/:id', summary: 'Documento com itens, tributos por item, memória de cálculo e eventos', tags: ['Documentos fiscais'], permission: 'fiscal.nota.ler', params: idParams },
    async ({ tx, params }) => getDocument(tx, params.id));

  const docItem = z.object({ productId: z.string().uuid(), quantity: decimal({ positive: true }), unitPrice: decimal({ min: 0 }), unit: z.string().optional(), discount: decimal({ min: 0 }).optional(),
    warehouseId: z.string().uuid().nullish(), additionalInfo: z.string().nullish() });
  route(app, {
    method: 'POST', url: '/v1/fiscal/documents', summary: 'Emite NF-e avulsa (remessa, bonificação, transferência...) e transmite', tags: ['Documentos fiscais'], permission: 'fiscal.nota.emitir', status: 201,
    body: z.object({ establishmentId: z.string().uuid(), operationTypeCode: z.string(), partyId: z.string().uuid(), items: z.array(docItem).min(1), freightMode: z.number().int().min(0).max(9).optional(),
      carrierId: z.string().uuid().nullish(), additionalInfo: z.string().nullish(), header: z.object({ freight: decimal({ min: 0 }).optional(), discount: decimal({ min: 0 }).optional() }).optional() }),
    afterCommit: transmitAfterCommit,
  }, async ({ tx, ctx, body, req }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    const doc = await createOutgoingDocument(tx, {
      ...body, items: body.items.map((i, n) => ({ ...i, id: String(n) })), payments: [{ tPag: '90', value: '0.00' }], sourceType: 'manual',
      idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
    });
    return { document: await prepareForTransmission(tx, doc.id) };
  });

  route(app, {
    method: 'POST', url: '/v1/fiscal/documents/:id/transmit', summary: 'Valida, numera e transmite (também reenvio após correção de rejeição)', tags: ['Documentos fiscais'], permission: 'fiscal.nota.emitir',
    params: idParams, afterCommit: transmitAfterCommit,
  }, async ({ tx, params }) => ({ document: await prepareForTransmission(tx, params.id) }));

  // O cancelamento conversa com a SEFAZ fora da transação de leitura: rota dedicada
  app.post('/v1/fiscal/documents/:id/cancellation', { schema: { summary: 'Cancela documento autorizado (RN-NFE-05)', tags: ['Documentos fiscais'] } }, async (req) => {
    const ctx = await resolveContext(app, req);
    requirePerm(ctx, 'fiscal.nota.cancelar');
    const { id } = idParams.parse(req.params);
    const body = z.object({ reason: z.string(), goodsDidNotCirculate: z.boolean(), extemporaneous: z.boolean().optional() }).parse(req.body);
    return cancelDocument(app.deps.pool, ctx, app.deps.services, id, body);
  });

  app.post('/v1/fiscal/documents/:id/correction-letter', { schema: { summary: 'Carta de correção (RN-NFE-06)', tags: ['Documentos fiscais'] } }, async (req) => {
    const ctx = await resolveContext(app, req);
    requirePerm(ctx, 'fiscal.nota.corrigir');
    const { id } = idParams.parse(req.params);
    const body = z.object({ corrections: z.array(z.object({ field: z.string(), text: z.string().min(3) })).min(1) }).parse(req.body);
    return correctionLetter(app.deps.pool, ctx, app.deps.services, id, body.corrections);
  });

  route(app, { method: 'GET', url: '/v1/fiscal/correction-letter/fields', summary: 'Campos que a CC-e pode corrigir', tags: ['Documentos fiscais'], permission: null }, async () => CCE_ALLOWED_FIELDS);

  app.post('/v1/fiscal/inutilizations', { schema: { summary: 'Inutiliza faixa de numeração (RN-NFE-01)', tags: ['Documentos fiscais'] } }, async (req, reply) => {
    const ctx = await resolveContext(app, req);
    requirePerm(ctx, 'fiscal.nota.inutilizar');
    const body = z.object({ establishmentId: z.string().uuid(), model: z.enum(['55', '65']), series: z.number().int(), from: z.number().int().min(1), to: z.number().int().min(1), reason: z.string() }).parse(req.body);
    reply.status(201);
    return inutilizeNumbers(app.deps.pool, ctx, app.deps.services, body);
  });

  route(app, {
    method: 'GET', url: '/v1/fiscal/numbering-gaps', summary: 'Números reservados e não usados (inutilizar até o dia 10 do mês seguinte)', tags: ['Documentos fiscais'], permission: 'fiscal.nota.ler',
  }, async ({ tx, ctx }) => tx.query(
    `SELECT d.establishment_id, d.model, d.series, d.number, d.status, d.sefaz_code, d.created_at,
            (date_trunc('month', d.created_at) + interval '1 month' + interval '9 days')::date AS inutilize_until
       FROM fiscal.documents d WHERE ($1::uuid IS NULL OR d.company_id = $1) AND d.issuer_kind = 'own' AND d.number IS NOT NULL AND d.status IN ('rascunho','rejeitada')
      ORDER BY d.created_at`, [ctx.companyId]));

  route(app, {
    method: 'GET', url: '/v1/fiscal/contingency', summary: 'Painel de notas em contingência e em processamento (RN-NFE-07)', tags: ['Documentos fiscais'], permission: 'fiscal.nota.ler',
  }, async ({ tx, ctx }) => tx.query(
    `SELECT id, model, series, number, status, emission_type, contingency_reason, contingency_at, attempts, total_invoice FROM fiscal.documents
      WHERE ($1::uuid IS NULL OR company_id = $1) AND status IN ('contingencia','em_processamento','pendente_envio') ORDER BY created_at`, [ctx.companyId]));

  route(app, { method: 'GET', url: '/v1/fiscal/documents/:id/xml', summary: 'XML autorizado (guarda imutável — RN-NFE-08)', tags: ['Documentos fiscais'], permission: 'fiscal.nota.ler', params: idParams },
    async ({ tx, params, deps, reply }) => {
      const d = await tx.one<{ authorized_xml_key: string | null; xml_key: string | null; access_key: string }>(`SELECT authorized_xml_key, xml_key, access_key FROM fiscal.documents WHERE id = $1`, [params.id], 'Documento');
      const key = d.authorized_xml_key ?? d.xml_key;
      if (!key) throw notFound('XML do documento');
      reply.header('content-type', 'application/xml; charset=utf-8').header('content-disposition', `attachment; filename="${d.access_key}.xml"`);
      return (await deps.services.storage.get(key)).toString('utf8');
    });

  route(app, { method: 'GET', url: '/v1/fiscal/documents/:id/danfe', summary: 'DANFE (HTML)', tags: ['Documentos fiscais'], permission: 'fiscal.nota.ler', params: idParams },
    async ({ tx, params, reply }) => {
      const d = await getDocument(tx, params.id);
      reply.header('content-type', 'text/html; charset=utf-8');
      return renderDanfeHtml(d, d.items);
    });

  route(app, { method: 'POST', url: '/v1/fiscal/documents/:id/send', summary: 'Reenvia XML e DANFE ao destinatário (RN-NFE-10)', tags: ['Documentos fiscais'], permission: 'fiscal.nota.emitir', params: idParams },
    async ({ tx, params }) => {
      await tx.one(`SELECT 1 FROM fiscal.documents WHERE id = $1`, [params.id], 'Documento fiscal');
      return { jobId: await enqueue(tx, 'nota.enviar_destinatario', { documentId: params.id, force: true }) };
    });

  route(app, {
    method: 'POST', url: '/v1/fiscal/returns', summary: 'Devolução a partir do documento original, item a item (RN-NFE-09)', tags: ['Documentos fiscais'], permission: 'fiscal.nota.emitir', status: 201,
    body: z.object({ originalDocumentId: z.string().uuid(), items: z.array(z.object({ originalItemId: z.string().uuid(), quantity: decimal({ positive: true }) })).min(1), reason: z.string().min(5) }),
    afterCommit: transmitAfterCommit,
  }, async ({ tx, body, req }) => {
    const doc = await createReturnDocument(tx, { ...body, sourceType: 'manual', idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null });
    return { document: await prepareForTransmission(tx, doc.id) };
  });

  // ---------------------------------------------------------------- NF-e de entrada (DF-e)
  route(app, {
    method: 'GET', url: '/v1/fiscal/inbound', summary: 'Notas emitidas contra a empresa (distribuição de DF-e)', tags: ['NF-e de entrada'], permission: 'fiscal.entrada.ler',
    query: z.object({ manifestation: z.string().optional(), unexpected: z.coerce.boolean().optional() }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT * FROM fiscal.inbound_documents WHERE ($1::uuid IS NULL OR company_id = $1) AND ($2::text IS NULL OR manifestation = $2) AND ($3::boolean IS NULL OR unexpected = $3) ORDER BY issued_at DESC LIMIT 500`,
    [ctx.companyId, query.manifestation ?? null, query.unexpected ?? null]));

  route(app, {
    method: 'POST', url: '/v1/fiscal/inbound/sync', summary: 'Consulta a distribuição de DF-e agora (respeita o intervalo da SEFAZ)', tags: ['NF-e de entrada'], permission: 'fiscal.entrada.ler',
    body: z.object({ establishmentId: z.string().uuid() }),
  }, async ({ tx, body, deps }) => runDistribution(tx, deps.services, body.establishmentId));

  app.post('/v1/fiscal/inbound/:id/manifest', { schema: { summary: 'Manifestação do destinatário', tags: ['NF-e de entrada'] } }, async (req) => {
    const ctx = await resolveContext(app, req);
    requirePerm(ctx, 'fiscal.entrada.manifestar');
    const { id } = idParams.parse(req.params);
    const body = z.object({ kind: z.enum(['ciencia', 'confirmada', 'desconhecida', 'nao_realizada']), reason: z.string().optional() }).parse(req.body);
    return manifest(app.deps.pool, ctx, app.deps.services, id, body.kind, body.reason);
  });

  // ---------------------------------------------------------------- link permanente no portal do cliente (RN-NFE-10)
  app.get('/public/documents/:key', { schema: { hide: true } }, async (req, reply) => {
    const { key } = z.object({ key: z.string().length(44) }).parse(req.params);
    const { t, tenant, format } = z.object({ t: z.string(), tenant: z.string().uuid(), format: z.enum(['xml', 'danfe']).default('danfe') }).parse(req.query);
    const doc = await withTenant(app.deps.pool, systemContext(tenant), (tx) => tx.maybeOne(`SELECT * FROM fiscal.documents WHERE access_key = $1 AND issuer_kind = 'own'`, [key]), { readOnly: true });
    if (!doc || !doc.public_token || !safeEqual(doc.public_token, t)) throw new AppError('NOT_FOUND', 'Documento não encontrado', 404);
    if (format === 'xml') {
      if (!doc.authorized_xml_key) throw new AppError('NOT_FOUND', 'XML ainda não autorizado', 404);
      reply.header('content-type', 'application/xml; charset=utf-8');
      return (await app.deps.services.storage.get(doc.authorized_xml_key)).toString('utf8');
    }
    const items = await withTenant(app.deps.pool, systemContext(tenant), (tx) => tx.query(`SELECT * FROM fiscal.document_items WHERE document_id = $1 ORDER BY item_number`, [doc.id]), { readOnly: true });
    reply.header('content-type', 'text/html; charset=utf-8');
    return renderDanfeHtml(doc, items);
  });
}
