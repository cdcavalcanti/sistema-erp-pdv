import { ZodError } from 'zod';
import { jsonSchema } from '../../http/schemas.js';
import { D } from '@vortex/money';
import type { Pool } from '../../db/pool.js';
import { withTenant, type RequestContext, type Tx } from '../../db/tx.js';
import { AppError, conflict, forbidden, notFound, validation } from '../../errors.js';
import { has } from '../../core/access.js';
import { enqueue } from '../../core/jobs.js';
import { renderPdf, type PdfLine } from '../../core/pdf.js';
import { buildXlsx } from '../../core/xlsx.js';
import { buildUserContext } from '../../http/auth.js';
import type { Services } from '../../services.js';
import { REPORT_BY_CODE, REPORTS, columnsOf, type Column, type ReportDef, type Row } from './definitions.js';

export type ExportFormat = 'json' | 'csv' | 'xlsx' | 'pdf';

export interface ReportResult {
  code: string;
  title: string;
  params: Record<string, unknown>;
  columns: Column[];
  rows: Row[];
  generatedAt: string;
}

export function catalog(ctx: RequestContext) {
  return REPORTS.filter((r) => has(ctx, r.permission)).map((r) => ({
    code: r.code, area: r.area, title: r.title, description: r.description, heavy: !!r.heavy, columns: typeof r.columns === 'function' ? null : r.columns,
    // Esquema dos parâmetros: o web app monta o formulário de filtros a partir dele
    params: jsonSchema(r.params),
  }));
}

function definition(ctx: RequestContext, code: string): ReportDef {
  const def = REPORT_BY_CODE.get(code);
  if (!def) throw notFound('Relatório');
  // RN-REL-01: o relatório respeita as permissões do usuário
  if (!has(ctx, def.permission)) throw forbidden(`Permissão necessária: ${def.permission}`, { permission: def.permission });
  return def;
}

export function parseParams(def: ReportDef, raw: unknown): Record<string, unknown> {
  try {
    return def.params.parse(raw ?? {});
  } catch (e) {
    if (e instanceof ZodError) throw validation(Object.fromEntries(e.issues.map((i) => [`params.${i.path.join('.')}`, i.message])));
    throw e;
  }
}

export async function runReport(tx: Tx, ctx: RequestContext, code: string, raw: unknown, opts: { allowHeavy?: boolean } = {}): Promise<ReportResult> {
  const def = definition(ctx, code);
  if (def.heavy && !opts.allowHeavy) throw conflict('REPORT_QUEUE_ONLY', 'Relatório pesado: solicite a execução em fila (RN-REL-02)');
  const params = parseParams(def, raw);
  const rows = await def.run(tx, params, ctx);
  return { code, title: def.title, params, columns: columnsOf(def, params), rows, generatedAt: new Date().toISOString() };
}

// ------------------------------------------------------------------ exportação (PDF, Excel, CSV)

function display(v: unknown, type?: Column['type']): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10).split('-').reverse().join('/');
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, 10).split('-').reverse().join('/');
  if ((type === 'money' || type === 'percent' || type === 'number') && /^-?\d+(\.\d+)?$/.test(String(v))) {
    const n = D(String(v));
    const fixed = type === 'number' ? n.toString() : n.toFixed(2);
    const [i, f] = fixed.split('.');
    return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${f ? `,${f}` : ''}${type === 'percent' ? '%' : ''}`;
  }
  return String(v);
}

function cellValue(v: unknown, type?: Column['type']): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if ((type === 'money' || type === 'percent' || type === 'number') && /^-?\d+(\.\d+)?$/.test(String(v))) return String(v);
  return String(v);
}

export function exportReport(r: ReportResult, format: Exclude<ExportFormat, 'json'>): { content: Buffer; contentType: string; filename: string } {
  const stamp = r.generatedAt.slice(0, 10);
  const base = `${r.code.replace(/\./g, '-')}-${stamp}`;
  if (format === 'csv') {
    // Padrão brasileiro: separador ";" e vírgula decimal; BOM para o Excel reconhecer UTF-8
    const q = (s: string) => (/[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const num = (v: unknown, t?: Column['type']) => {
      const c = cellValue(v, t);
      return c === null ? '' : t && t !== 'text' && t !== 'date' && /^-?\d+(\.\d+)?$/.test(String(c)) ? String(c).replace('.', ',') : display(v, t);
    };
    const lines = [r.columns.map((c) => q(c.label)).join(';'), ...r.rows.map((row) => r.columns.map((c) => q(num(row[c.key], c.type))).join(';'))];
    return { content: Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8'), contentType: 'text/csv; charset=utf-8', filename: `${base}.csv` };
  }
  if (format === 'xlsx') {
    const content = buildXlsx(r.title, r.columns.map((c) => c.label), r.rows.map((row) => r.columns.map((c) => cellValue(row[c.key], c.type))));
    return { content, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${base}.xlsx` };
  }
  // PDF em texto com colunas de largura fixa
  const widths = r.columns.map((c) => Math.min(28, Math.max(c.label.length, ...r.rows.slice(0, 200).map((row) => display(row[c.key], c.type).length))));
  const fmt = (vals: string[]) => vals.map((v, i) => {
    const w = widths[i]!;
    const t = v.length > w ? `${v.slice(0, w - 1)}…` : v;
    return ['money', 'number', 'percent'].includes(r.columns[i]!.type ?? '') ? t.padStart(w) : t.padEnd(w);
  }).join('  ');
  const size = Math.max(5, Math.min(9, Math.floor(1000 / Math.max(1, widths.reduce((a, b) => a + b + 2, 0)))));
  const filters = Object.entries(r.params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
  const lines: PdfLine[] = [
    { text: r.title, size: 14, bold: true },
    { text: `Gerado em ${new Date(r.generatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${filters ? ` · ${filters}` : ''}`, size: 8 },
    { text: ' ', size: 6 },
    { text: fmt(r.columns.map((c) => c.label)), size, bold: true },
    ...r.rows.map((row) => ({ text: fmt(r.columns.map((c) => display(row[c.key], c.type))), size })),
    { text: ' ', size: 6 },
    { text: `${r.rows.length} linha(s)`, size: 8 },
  ];
  return { content: renderPdf(lines, r.title), contentType: 'application/pdf', filename: `${base}.pdf` };
}

// ------------------------------------------------------------------ execução em fila (RN-REL-02)

export async function enqueueRun(tx: Tx, ctx: RequestContext, code: string, raw: unknown, format: ExportFormat, scheduleId: string | null = null) {
  const def = definition(ctx, code);
  const params = parseParams(def, raw);
  if (!ctx.userId) throw forbidden('Execução em fila exige um usuário (o arquivo é entregue a ele)');
  const run = await tx.one<{ id: string }>(
    `INSERT INTO reports.runs (tenant_id, company_id, user_id, report_code, params, format, schedule_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tx.tenantId, ctx.companyId, ctx.userId, code, JSON.stringify(params), format, scheduleId]);
  await enqueue(tx, 'relatorios.executar', { runId: run.id }, { queue: 'reports', dedupeKey: `run:${run.id}` });
  return run;
}

/** Executa um relatório da fila com o contexto (permissões e escopo) de quem pediu. */
export async function executeRun(pool: Pool, tx: Tx, services: Services, runId: string) {
  const run = await tx.one<Record<string, any>>(`SELECT * FROM reports.runs WHERE id = $1 FOR UPDATE`, [runId]);
  if (run.status === 'done') return { skipped: true };
  await tx.exec(`UPDATE reports.runs SET status = 'running', started_at = now() WHERE id = $1`, [runId]);
  try {
    const userCtx = await buildUserContext(pool, { sub: run.user_id, tid: tx.tenantId, mfa: true }, { companyId: run.company_id, ip: null, device: 'fila-relatorios', requestId: `report-${runId}` });
    const result = await withTenant(pool, userCtx, (utx) => runReport(utx, userCtx, run.report_code, run.params, { allowHeavy: true }), { readOnly: true });
    const file = run.format === 'json'
      ? { content: Buffer.from(JSON.stringify(result)), contentType: 'application/json', filename: `${run.report_code}.json` }
      : exportReport(result, run.format);
    const ext = file.filename.split('.').pop();
    const stored = await services.storage.putImmutable(`relatorios/${tx.tenantId}/${runId}.${ext}`, file.content, file.contentType);
    await tx.exec(`UPDATE reports.runs SET status = 'done', row_count = $2, file_key = $3, finished_at = now(), error = NULL WHERE id = $1`, [runId, result.rows.length, stored.key]);
    // Aviso: agendamento → destinatários do agendamento; execução avulsa → o próprio usuário
    if (run.schedule_id) {
      const s = await tx.one<Record<string, any>>(`SELECT * FROM reports.schedules WHERE id = $1`, [run.schedule_id]);
      for (const to of s.recipients as string[]) {
        if (s.channel === 'whatsapp') await services.messenger.sendWhatsApp(to, `Relatório "${s.name}" pronto (${result.rows.length} linhas)`, `/v1/reports/runs/${runId}/download`);
        else await services.mailer.send({ to, subject: `Relatório: ${s.name}`, html: `<p>Segue o relatório <b>${result.title}</b> (${result.rows.length} linhas).</p>`,
          attachments: [{ filename: file.filename, content: file.content, contentType: file.contentType }] });
      }
    } else {
      const u = await tx.one<{ email: string }>(`SELECT email FROM core.users WHERE id = $1`, [run.user_id]);
      await services.mailer.send({ to: u.email, subject: `Relatório pronto: ${result.title}`,
        html: `<p>O relatório <b>${result.title}</b> ficou pronto (${result.rows.length} linhas). Baixe em /v1/reports/runs/${runId}/download.</p>` });
    }
    return { rows: result.rows.length, fileKey: stored.key };
  } catch (e) {
    await tx.exec(`UPDATE reports.runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [runId, (e as Error).message.slice(0, 1000)]);
    if (e instanceof AppError) return { failed: e.message };
    throw e;
  }
}

// ------------------------------------------------------------------ agendamento (RN-REL-01)

export interface ScheduleInput {
  reportCode: string;
  name: string;
  params: Record<string, unknown>;
  relativePeriod?: 'yesterday' | 'last_7_days' | 'current_month' | 'previous_month' | null;
  format: 'csv' | 'xlsx' | 'pdf';
  frequency: 'daily' | 'weekly' | 'monthly';
  hour: number;
  weekday?: number | null;
  monthDay?: number | null;
  channel: 'email' | 'whatsapp';
  recipients: string[];
}

/** Horário de Brasília (UTC−3, sem horário de verão desde 2019). */
export function nextRunAt(s: { frequency: string; hour: number; weekday?: number | null; month_day?: number | null }, after = new Date()): Date {
  const local = new Date(after.getTime() - 3 * 3_600_000);
  const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, s.hour + 3, 0, 0));
  let c = at(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  if (s.frequency === 'daily') {
    if (c <= after) c = new Date(c.getTime() + 86_400_000);
  } else if (s.frequency === 'weekly') {
    const wd = s.weekday ?? 1;
    const delta = (wd - local.getUTCDay() + 7) % 7;
    c = new Date(c.getTime() + delta * 86_400_000);
    if (c <= after) c = new Date(c.getTime() + 7 * 86_400_000);
  } else {
    const md = s.month_day ?? 1;
    c = at(local.getUTCFullYear(), local.getUTCMonth(), md);
    if (c <= after) c = at(local.getUTCFullYear(), local.getUTCMonth() + 1, md);
  }
  return c;
}

/** Datas relativas resolvidas no momento da execução (ex.: "mês anterior"). */
export function resolveRelative(period: string | null, now = new Date()): { from: string; to: string } | null {
  if (!period) return null;
  const local = new Date(now.getTime() - 3 * 3_600_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const day = (n: number) => new Date(local.getTime() - n * 86_400_000);
  if (period === 'yesterday') return { from: iso(day(1)), to: iso(day(1)) };
  if (period === 'last_7_days') return { from: iso(day(7)), to: iso(day(1)) };
  const first = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
  if (period === 'current_month') return { from: iso(first), to: iso(local) };
  const prevLast = new Date(first.getTime() - 86_400_000);
  return { from: iso(new Date(Date.UTC(prevLast.getUTCFullYear(), prevLast.getUTCMonth(), 1))), to: iso(prevLast) };
}

export async function createSchedule(tx: Tx, ctx: RequestContext, input: ScheduleInput) {
  const def = definition(ctx, input.reportCode);
  // Valida já com as datas relativas aplicadas
  parseParams(def, { ...input.params, ...(resolveRelative(input.relativePeriod ?? null) ?? {}) });
  if (input.channel === 'email' && input.recipients.some((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))) throw validation({ recipients: 'E-mail inválido' });
  const next = nextRunAt({ frequency: input.frequency, hour: input.hour, weekday: input.weekday, month_day: input.monthDay });
  return tx.one(
    `INSERT INTO reports.schedules (tenant_id, company_id, user_id, report_code, name, params, relative_period, format, frequency, hour, weekday, month_day, channel, recipients, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [tx.tenantId, ctx.companyId, ctx.userId, input.reportCode, input.name, JSON.stringify(input.params), input.relativePeriod ?? null, input.format, input.frequency, input.hour,
      input.weekday ?? null, input.monthDay ?? null, input.channel, input.recipients, next]);
}

/** Dispara os agendamentos vencidos: cria a execução em fila com as permissões do dono do agendamento. */
export async function fireDueSchedules(pool: Pool, workerPool: Pool, now = new Date()): Promise<number> {
  const due = await workerPool.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM reports.schedules WHERE active AND next_run_at <= $1 ORDER BY next_run_at LIMIT 200`, [now]);
  let n = 0;
  for (const { id, tenant_id } of due.rows) {
    const s = (await workerPool.query<Record<string, any>>(`SELECT * FROM reports.schedules WHERE id = $1`, [id])).rows[0]!;
    try {
      const userCtx = await buildUserContext(pool, { sub: s.user_id, tid: tenant_id, mfa: true }, { companyId: s.company_id, ip: null, device: 'agendamento', requestId: `schedule-${id}` });
      await withTenant(pool, userCtx, (tx) => enqueueRun(tx, userCtx, s.report_code, { ...s.params, ...(resolveRelative(s.relative_period, now) ?? {}) }, s.format, id));
      n++;
    } catch {
      // Usuário inativo ou sem permissão: o agendamento é suspenso para não falhar todo dia
      await workerPool.query(`UPDATE reports.schedules SET active = false WHERE id = $1`, [id]);
      continue;
    }
    await workerPool.query(`UPDATE reports.schedules SET last_run_at = $2, next_run_at = $3 WHERE id = $1`, [id, now, nextRunAt(s as never, now)]);
  }
  return n;
}
