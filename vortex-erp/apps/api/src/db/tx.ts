import type { Pool, PoolClient } from './pool.js';
import type { QueryResultRow } from 'pg';
import { AppError, notFound } from '../errors.js';

export interface RequestContext {
  tenantId: string;
  userId: string | null;
  companyId: string | null;
  /** Estabelecimentos permitidos; null = todos do tenant */
  establishmentIds: string[] | null;
  warehouseIds: string[] | null;
  permissions: Set<string>;
  roles: string[];
  ownPortfolioOnly: boolean;
  partyId: string | null;
  ip: string | null;
  device: string | null;
  requestId: string;
  apiKeyId: string | null;
  mfaVerified: boolean;
}

export function systemContext(tenantId: string, companyId: string | null = null): RequestContext {
  return {
    tenantId,
    userId: null,
    companyId,
    establishmentIds: null,
    warehouseIds: null,
    permissions: new Set(['*']),
    roles: ['system'],
    ownPortfolioOnly: false,
    partyId: null,
    ip: null,
    device: 'system',
    requestId: `sys-${Date.now()}`,
    apiKeyId: null,
    mfaVerified: true,
  };
}

/**
 * Transação com contexto de tenant. Toda consulta de negócio passa por aqui:
 * o RLS do Postgres usa app.tenant_id para isolar os dados (RN-ORG-01).
 */
export class Tx {
  constructor(public readonly client: PoolClient, public readonly ctx: RequestContext) {}

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.client.query<T>(sql, params as any[]);
    return r.rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], what = 'Registro'): Promise<T> {
    const rows = await this.query<T>(sql, params);
    if (rows.length === 0) throw notFound(what);
    return rows[0]!;
  }

  async maybeOne<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const r = await this.client.query(sql, params as any[]);
    return r.rowCount ?? 0;
  }

  private spSeq = 0;
  /** Isola uma parte da transação: se falhar, só ela é desfeita (ex.: um contrato no faturamento em lote). */
  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const name = `sp_${++this.spSeq}`;
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const r = await fn();
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return r;
    } catch (e) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw e;
    }
  }

  /** RN-ACE-03: motivo da ação sensível vai para o log de auditoria. */
  async setReason(reason: string, sensitive = true): Promise<void> {
    await this.client.query(`SELECT set_config('app.reason', $1, true), set_config('app.sensitive', $2, true)`, [reason, String(sensitive)]);
  }

  async clearReason(): Promise<void> {
    await this.client.query(`SELECT set_config('app.reason', '', true), set_config('app.sensitive', 'false', true)`);
  }

  get companyId(): string {
    if (!this.ctx.companyId) throw new AppError('COMPANY_REQUIRED', 'Selecione a empresa (cabeçalho X-Company-Id)', 400);
    return this.ctx.companyId;
  }
  get tenantId(): string {
    return this.ctx.tenantId;
  }
  get userId(): string | null {
    return this.ctx.userId;
  }
}

const RETRYABLE = new Set(['40001', '40P01']);

export async function withTenant<T>(
  pool: Pool,
  ctx: RequestContext,
  fn: (tx: Tx) => Promise<T>,
  opts: { readOnly?: boolean; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.company_id', $3, true), set_config('app.ip', $4, true),
                set_config('app.device', $5, true), set_config('app.request_id', $6, true)`,
        [ctx.tenantId, ctx.userId ?? '', ctx.companyId ?? '', ctx.ip ?? '', ctx.device ?? '', ctx.requestId],
      );
      const result = await fn(new Tx(client, ctx));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
