import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { idParams } from '../../http/schemas.js';
import { randomToken } from '../../core/crypto.js';
import { EVENT_TYPES } from '../../core/outbox.js';

export function registerIntegrationRoutes(app: App) {
  route(app, { method: 'GET', url: '/v1/events/catalog', summary: 'Catálogo de eventos publicados pelo ERP', tags: ['Integrações'], permission: null }, async () => EVENT_TYPES);

  route(app, {
    method: 'GET', url: '/v1/events', summary: 'Eventos recentes (outbox)', tags: ['Integrações'], permission: 'admin.integracao.gerenciar',
    query: z.object({ type: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
  }, async ({ tx, query }) =>
    tx.query(`SELECT * FROM integration.outbox_events WHERE ($1::text IS NULL OR event_type = $1) ORDER BY occurred_at DESC LIMIT $2`, [query.type ?? null, query.limit]));

  route(app, { method: 'GET', url: '/v1/webhooks', summary: 'Assinaturas de webhook', tags: ['Integrações'], permission: 'admin.integracao.gerenciar' }, async ({ tx }) =>
    tx.query(`SELECT id, url, events, active, created_at FROM integration.webhooks ORDER BY created_at DESC`));

  route(app, {
    method: 'POST', url: '/v1/webhooks', summary: 'Assina eventos (entrega assinada com HMAC-SHA256)', tags: ['Integrações'], permission: 'admin.integracao.gerenciar', status: 201,
    body: z.object({ url: z.string().url(), events: z.array(z.enum([...EVENT_TYPES, '*'] as [string, ...string[]])).min(1) }),
  }, async ({ tx, body }) => {
    const secret = `whsec_${randomToken(24)}`;
    const row = await tx.one(`INSERT INTO integration.webhooks (tenant_id, url, events, secret, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, url, events, active`,
      [tx.tenantId, body.url, body.events, secret, tx.userId]);
    return { ...row, secret };
  });

  route(app, { method: 'DELETE', url: '/v1/webhooks/:id', summary: 'Desativa webhook', tags: ['Integrações'], permission: 'admin.integracao.gerenciar', params: idParams },
    async ({ tx, params }) => tx.one(`UPDATE integration.webhooks SET active = false WHERE id = $1 RETURNING id, active`, [params.id], 'Webhook'));

  route(app, {
    method: 'GET', url: '/v1/webhooks/:id/deliveries', summary: 'Entregas de um webhook', tags: ['Integrações'], permission: 'admin.integracao.gerenciar', params: idParams,
  }, async ({ tx, params }) => tx.query(`SELECT * FROM integration.webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 200`, [params.id]));

  route(app, {
    method: 'GET', url: '/v1/jobs', summary: 'Jobs do tenant (filas)', tags: ['Integrações'], permission: 'admin.integracao.gerenciar',
    query: z.object({ status: z.enum(['queued', 'running', 'done', 'failed', 'dead']).optional(), name: z.string().optional() }),
  }, async ({ tx, query }) =>
    tx.query(`SELECT id, name, status, attempts, run_at, last_error, result, created_at, finished_at FROM integration.jobs
               WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR name = $2) ORDER BY created_at DESC LIMIT 200`, [query.status ?? null, query.name ?? null]));
}
