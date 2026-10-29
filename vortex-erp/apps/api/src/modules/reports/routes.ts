import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { idParams, isoDate } from '../../http/schemas.js';
import { AppError, notFound } from '../../errors.js';
import { ownerCharts, ownerDashboard } from './dashboard.js';
import { catalog, createSchedule, enqueueRun, exportReport, runReport } from './service.js';

const codeParams = z.object({ code: z.string().regex(/^[a-z_]+\.[a-z_]+$/) });
const formats = z.enum(['json', 'csv', 'xlsx', 'pdf']);

export function registerReportRoutes(app: App) {
  route(app, { method: 'GET', url: '/v1/reports', summary: 'Catálogo de relatórios que o usuário pode ver (seção 19)', tags: ['Relatórios'], permission: null },
    async ({ ctx }) => catalog(ctx));

  route(app, {
    method: 'POST', url: '/v1/reports/:code/run', summary: 'Executa um relatório leve e devolve JSON, CSV, Excel ou PDF (RN-REL-01)', tags: ['Relatórios'], permission: null, params: codeParams,
    body: z.object({ params: z.record(z.string(), z.unknown()).default({}), format: formats.default('json') }),
  }, async ({ tx, ctx, params, body, reply }) => {
    const result = await runReport(tx, ctx, params.code, body.params);
    if (body.format === 'json') return result;
    const file = exportReport(result, body.format);
    reply.header('content-type', file.contentType).header('content-disposition', `attachment; filename="${file.filename}"`);
    return file.content;
  });

  route(app, {
    method: 'POST', url: '/v1/reports/:code/runs', summary: 'Execução em fila: avisa por e-mail quando o arquivo fica pronto (RN-REL-02)', tags: ['Relatórios'], permission: null,
    params: codeParams, status: 202, body: z.object({ params: z.record(z.string(), z.unknown()).default({}), format: formats.default('xlsx') }),
  }, async ({ tx, ctx, params, body }) => enqueueRun(tx, ctx, params.code, body.params, body.format));

  route(app, { method: 'GET', url: '/v1/reports/runs', summary: 'Minhas execuções em fila', tags: ['Relatórios'], permission: null }, async ({ tx, ctx }) =>
    tx.query(`SELECT id, report_code, params, format, status, row_count, error, created_at, finished_at FROM reports.runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [ctx.userId]));

  route(app, { method: 'GET', url: '/v1/reports/runs/:id', summary: 'Situação de uma execução', tags: ['Relatórios'], permission: null, params: idParams }, async ({ tx, ctx, params }) => {
    const r = await tx.maybeOne(`SELECT * FROM reports.runs WHERE id = $1 AND user_id = $2`, [params.id, ctx.userId]);
    if (!r) throw notFound('Execução de relatório');
    return r;
  });

  route(app, { method: 'GET', url: '/v1/reports/runs/:id/download', summary: 'Baixa o arquivo gerado', tags: ['Relatórios'], permission: null, params: idParams },
    async ({ tx, ctx, params, reply, deps }) => {
      const r = await tx.maybeOne<{ file_key: string | null; status: string; report_code: string; format: string }>(
        `SELECT file_key, status, report_code, format FROM reports.runs WHERE id = $1 AND user_id = $2`, [params.id, ctx.userId]);
      if (!r) throw notFound('Execução de relatório');
      if (r.status !== 'done' || !r.file_key) throw new AppError('REPORT_NOT_READY', 'O relatório ainda não ficou pronto', 409, { status: r.status });
      const types: Record<string, string> = { json: 'application/json', csv: 'text/csv; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf' };
      reply.header('content-type', types[r.format]!).header('content-disposition', `attachment; filename="${r.report_code}.${r.format}"`);
      return deps.services.storage.get(r.file_key);
    });

  // ---------------------------------------------------------------- filtros salvos
  route(app, { method: 'GET', url: '/v1/reports/:code/filters', summary: 'Filtros salvos (meus e compartilhados)', tags: ['Relatórios'], permission: null, params: codeParams },
    async ({ tx, ctx, params }) => tx.query(
      `SELECT * FROM reports.saved_filters WHERE report_code = $1 AND (user_id = $2 OR shared) ORDER BY name`, [params.code, ctx.userId]));

  route(app, {
    method: 'POST', url: '/v1/reports/:code/filters', summary: 'Salva um filtro', tags: ['Relatórios'], permission: null, params: codeParams, status: 201,
    body: z.object({ name: z.string().min(2).max(80), params: z.record(z.string(), z.unknown()), shared: z.boolean().default(false) }),
  }, async ({ tx, ctx, params, body }) => tx.one(
    `INSERT INTO reports.saved_filters (tenant_id, user_id, report_code, name, params, shared) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, user_id, report_code, name) DO UPDATE SET params = EXCLUDED.params, shared = EXCLUDED.shared RETURNING *`,
    [tx.tenantId, ctx.userId, params.code, body.name, JSON.stringify(body.params), body.shared]));

  route(app, { method: 'DELETE', url: '/v1/reports/filters/:id', summary: 'Remove um filtro salvo', tags: ['Relatórios'], permission: null, params: idParams },
    async ({ tx, ctx, params }) => {
      const r = await tx.maybeOne(`DELETE FROM reports.saved_filters WHERE id = $1 AND user_id = $2 RETURNING id`, [params.id, ctx.userId]);
      if (!r) throw notFound('Filtro');
      return { deleted: true };
    });

  // ---------------------------------------------------------------- agendamentos
  route(app, { method: 'GET', url: '/v1/reports/schedules', summary: 'Meus agendamentos', tags: ['Relatórios'], permission: null }, async ({ tx, ctx }) =>
    tx.query(`SELECT * FROM reports.schedules WHERE user_id = $1 ORDER BY name`, [ctx.userId]));

  route(app, {
    method: 'POST', url: '/v1/reports/schedules', summary: 'Agenda envio por e-mail ou WhatsApp (roda com as suas permissões)', tags: ['Relatórios'], permission: null, status: 201,
    body: z.object({
      reportCode: z.string(), name: z.string().min(2).max(80), params: z.record(z.string(), z.unknown()).default({}),
      relativePeriod: z.enum(['yesterday', 'last_7_days', 'current_month', 'previous_month']).nullish(), format: z.enum(['csv', 'xlsx', 'pdf']).default('xlsx'),
      frequency: z.enum(['daily', 'weekly', 'monthly']), hour: z.number().int().min(0).max(23).default(7), weekday: z.number().int().min(0).max(6).nullish(),
      monthDay: z.number().int().min(1).max(28).nullish(), channel: z.enum(['email', 'whatsapp']).default('email'), recipients: z.array(z.string().min(5)).min(1).max(20),
    }),
  }, async ({ tx, ctx, body }) => createSchedule(tx, ctx, body));

  route(app, { method: 'DELETE', url: '/v1/reports/schedules/:id', summary: 'Desativa um agendamento', tags: ['Relatórios'], permission: null, params: idParams },
    async ({ tx, ctx, params }) => {
      const r = await tx.maybeOne(`UPDATE reports.schedules SET active = false WHERE id = $1 AND user_id = $2 RETURNING id`, [params.id, ctx.userId]);
      if (!r) throw notFound('Agendamento');
      return { deactivated: true };
    });

  // ---------------------------------------------------------------- painel do dono
  route(app, {
    method: 'GET', url: '/v1/dashboard/owner', summary: 'Painel do dono: faturamento, margem, caixa, inadimplência, estoque parado, metas e alertas', tags: ['Relatórios'],
    permission: 'relatorios.painel.ler', query: z.object({ date: isoDate.optional() }),
  }, async ({ tx, ctx, query }) => ownerDashboard(tx, ctx, query.date));

  route(app, {
    method: 'GET', url: '/v1/dashboard/owner/charts', summary: 'Gráficos do painel: faturamento diário (pedidos × PDV), canais, top produtos e clientes, vencimentos, caixa projetado, pedidos por etapa e estoque crítico',
    tags: ['Relatórios'], permission: 'relatorios.painel.ler', query: z.object({ date: isoDate.optional(), days: z.coerce.number().int().min(7).max(365).default(30) }),
  }, async ({ tx, ctx, query }) => ownerCharts(tx, ctx, { date: query.date, days: query.days }));
}
