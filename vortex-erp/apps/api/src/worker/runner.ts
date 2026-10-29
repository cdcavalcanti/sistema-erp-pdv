import { hostname } from 'node:os';
import { systemContext, withTenant } from '../db/tx.js';
import { hmacSha256 } from '../core/crypto.js';
import { SCHEDULES, registerSystemJob, subscribers, systemJobs, tenantJobs, type JobRow, type WorkerDeps } from './registry.js';

const WORKER_ID = `${hostname()}-${process.pid}`;

/** Pega o próximo job pronto (FOR UPDATE SKIP LOCKED) e marca como em execução. */
async function claim(deps: WorkerDeps, queues: string[]): Promise<JobRow | null> {
  const r = await deps.workerPool.query(
    `UPDATE integration.jobs j SET status = 'running', locked_at = now(), locked_by = $1, attempts = j.attempts + 1
      WHERE j.id = (SELECT id FROM integration.jobs WHERE status IN ('queued','failed') AND run_at <= now() AND queue = ANY($2)
                     ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING j.id, j.tenant_id, j.name, j.payload, j.attempts, j.max_attempts`,
    [WORKER_ID, queues]);
  return r.rows[0] ?? null;
}

export async function executeJob(deps: WorkerDeps, job: JobRow): Promise<void> {
  try {
    let result: unknown;
    if (job.tenant_id) {
      const h = tenantJobs.get(job.name);
      if (!h) throw new Error(`Job sem handler: ${job.name}`);
      result = await withTenant(deps.appPool, { ...systemContext(job.tenant_id), requestId: `job-${job.id}` }, (tx) => h(tx, job.payload, deps, job));
    } else {
      const h = systemJobs.get(job.name);
      if (!h) throw new Error(`Job de sistema sem handler: ${job.name}`);
      result = await h(deps, job.payload, job);
    }
    await deps.workerPool.query(`UPDATE integration.jobs SET status = 'done', finished_at = now(), result = $2, locked_at = NULL, last_error = NULL WHERE id = $1`,
      [job.id, JSON.stringify(result ?? null)]);
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 2000) ?? String(err);
    const dead = job.attempts >= job.max_attempts;
    // Reenvio exponencial: 5 s, 10 s, 20 s ... até 1 h
    const delay = Math.min(3600, 5 * 2 ** (job.attempts - 1));
    await deps.workerPool.query(
      `UPDATE integration.jobs SET status = $2, last_error = $3, locked_at = NULL, run_at = now() + ($4 || ' seconds')::interval, finished_at = CASE WHEN $2 = 'dead' THEN now() END WHERE id = $1`,
      [job.id, dead ? 'dead' : 'failed', msg, String(delay)]);
  }
}

/** Processa jobs prontos até a fila esvaziar (usado nos testes e em cada ciclo do worker). */
export async function drain(deps: WorkerDeps, opts: { queues?: string[]; max?: number } = {}): Promise<number> {
  const queues = opts.queues ?? ['default', 'fiscal', 'reports', 'system'];
  let n = 0;
  for (;;) {
    if (opts.max !== undefined && n >= opts.max) break;
    const job = await claim(deps, queues);
    if (!job) break;
    await executeJob(deps, job);
    n++;
  }
  return n;
}

/** Enfileira os jobs agendados vencidos. */
export async function tickScheduler(deps: WorkerDeps): Promise<void> {
  for (const s of SCHEDULES) {
    await deps.workerPool.query(
      `INSERT INTO integration.job_schedules (name, interval_seconds) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET interval_seconds = EXCLUDED.interval_seconds`,
      [s.name, s.intervalSeconds]);
  }
  const due = await deps.workerPool.query<{ name: string; payload: unknown }>(
    `UPDATE integration.job_schedules SET next_run_at = now() + (interval_seconds || ' seconds')::interval
      WHERE enabled AND next_run_at <= now() RETURNING name, payload`);
  for (const d of due.rows) {
    await deps.workerPool.query(
      `INSERT INTO integration.jobs (tenant_id, queue, name, payload, dedupe_key) VALUES (NULL, 'system', $1, $2, 'schedule')
       ON CONFLICT DO NOTHING`, [d.name, JSON.stringify(d.payload ?? {})]);
  }
}

/** Fan-out: enfileira um job de tenant para cada tenant ativo. */
export async function fanOut(deps: WorkerDeps, name: string, payload: Record<string, unknown> = {}, dedupeKey?: string): Promise<number> {
  const r = await deps.workerPool.query(
    `INSERT INTO integration.jobs (tenant_id, name, payload, dedupe_key)
     SELECT id, $1, $2, $3 FROM core.tenants WHERE status = 'active' ON CONFLICT DO NOTHING`,
    [name, JSON.stringify(payload), dedupeKey ?? null]);
  return r.rowCount ?? 0;
}

// ------------------------------------------------------------------ jobs de sistema da fundação

/** Publica eventos do outbox: assinantes internos + entregas de webhook. */
registerSystemJob('outbox.dispatch', async (deps) => {
  let published = 0;
  for (;;) {
    const client = await deps.workerPool.connect();
    let batch: { id: string; tenant_id: string; event_type: string; payload: unknown; aggregate_id: string | null }[] = [];
    try {
      await client.query('BEGIN');
      batch = (await client.query(
        `SELECT id, tenant_id, event_type, payload, aggregate_id FROM integration.outbox_events
          WHERE published_at IS NULL ORDER BY occurred_at FOR UPDATE SKIP LOCKED LIMIT 100`)).rows;
      for (const ev of batch) {
        const subs = subscribers.get(ev.event_type) ?? [];
        try {
          for (const s of subs) {
            await withTenant(deps.appPool, { ...systemContext(ev.tenant_id), requestId: `evt-${ev.id}` }, (tx) => s(tx, ev as never, deps));
          }
          await client.query(
            `INSERT INTO integration.webhook_deliveries (tenant_id, webhook_id, event_id)
             SELECT tenant_id, id, $2 FROM integration.webhooks WHERE tenant_id = $1 AND active AND ($3 = ANY(events) OR '*' = ANY(events))
             ON CONFLICT DO NOTHING`, [ev.tenant_id, ev.id, ev.event_type]);
          await client.query(`UPDATE integration.outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1`, [ev.id]);
          published++;
        } catch (err) {
          await client.query(`UPDATE integration.outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [ev.id, (err as Error).message]);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    if (batch.length < 100) break;
  }
  return { published };
});

/** Entrega de webhooks assinados (HMAC-SHA256) com reenvio exponencial. */
registerSystemJob('webhooks.deliver', async (deps) => {
  const due = await deps.workerPool.query(
    `SELECT d.id, d.attempts, w.url, w.secret, e.id AS event_id, e.event_type, e.payload, e.occurred_at, e.tenant_id
       FROM integration.webhook_deliveries d JOIN integration.webhooks w ON w.id = d.webhook_id JOIN integration.outbox_events e ON e.id = d.event_id
      WHERE d.status IN ('pending','failed') AND d.next_attempt_at <= now() ORDER BY d.next_attempt_at LIMIT 200`);
  let delivered = 0;
  for (const d of due.rows) {
    const body = JSON.stringify({ id: d.event_id, type: d.event_type, occurredAt: d.occurred_at, tenantId: d.tenant_id, data: d.payload });
    const ts = Math.floor(Date.now() / 1000);
    const sig = hmacSha256(d.secret, `${ts}.${body}`);
    let status = 0;
    let error: string | null = null;
    try {
      const res = await fetch(d.url, {
        method: 'POST', body, signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', 'x-vortex-event': d.event_type, 'x-vortex-signature': `t=${ts},v1=${sig}`, 'x-vortex-delivery': d.id },
      });
      status = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).message;
    }
    if (!error) {
      await deps.workerPool.query(`UPDATE integration.webhook_deliveries SET status = 'delivered', delivered_at = now(), response_status = $2, attempts = attempts + 1 WHERE id = $1`, [d.id, status]);
      delivered++;
    } else {
      const attempts = d.attempts + 1;
      await deps.workerPool.query(
        `UPDATE integration.webhook_deliveries SET status = $2, attempts = $3, response_status = $4, last_error = $5,
                next_attempt_at = now() + ($6 || ' seconds')::interval WHERE id = $1`,
        [d.id, attempts >= 10 ? 'dead' : 'failed', attempts, status || null, error, String(Math.min(21_600, 30 * 2 ** (attempts - 1)))]);
    }
  }
  return { delivered, attempted: due.rowCount };
});

registerSystemJob('partitions.ensure', async (deps) => {
  // A função roda com os privilégios do worker; a criação de partição exige o dono,
  // então em produção este job roda com a conexão de migração. Aqui é melhor esforço.
  try {
    await deps.workerPool.query(`SELECT core.ensure_monthly_partitions('core.audit_log', 3)`);
  } catch {
    /* sem privilégio de DDL: tratado pelo job de manutenção do dono */
  }
  return { ok: true };
});

registerSystemJob('jobs.recover_stale', async (deps) => {
  const r = await deps.workerPool.query(
    `UPDATE integration.jobs SET status = 'failed', locked_at = NULL, last_error = 'Recuperado: worker interrompido'
      WHERE status = 'running' AND locked_at < now() - interval '15 minutes'`);
  return { recovered: r.rowCount };
});

registerSystemJob('cleanup.idempotency', async (deps) => {
  const r = await deps.workerPool.query(`DELETE FROM integration.idempotency_keys WHERE created_at < now() - interval '30 days'`);
  return { deleted: r.rowCount };
});
