import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import { uuid } from '../domain/ids.js';

/**
 * SYNC_QUEUE (seção 31): id, type, entity, entity_id, payload, created_at, status, attempts,
 * last_error, synced_at. Estados PENDING → PROCESSING → SYNCED | FAILED. Uma operação por
 * (type, entity_id): reenfileirar a mesma venda não cria segunda entrada (seção 44).
 */
export type SyncType = 'customer' | 'cash_movement' | 'sale' | 'nfce_authorization' | 'sale_cancel' | 'return';
export type SyncStatus = 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED';

/** Ordem de envio: cliente → caixa → venda → autorização da contingência → cancelamento/devolução. */
const PRIORITY: Record<SyncType, number> = { customer: 10, cash_movement: 20, sale: 30, nfce_authorization: 40, sale_cancel: 50, return: 60 };

export interface QueueItem {
  id: string;
  type: SyncType;
  entity: string;
  entity_id: string;
  payload: string;
  created_at: string;
  status: SyncStatus;
  attempts: number;
  last_error: string | null;
  synced_at: string | null;
  next_attempt_at: string;
  archived_at?: string | null;
  archived_reason?: string | null;
}

export class SyncQueue {
  constructor(private readonly db: LocalDb, private readonly clock: Clock, private readonly maxBackoffMs = 600_000) {}

  enqueue(type: SyncType, entity: string, entityId: string, payload: unknown): string {
    const now = this.clock.now().toISOString();
    const existing = this.db.get<{ id: string; status: SyncStatus }>(`SELECT id, status FROM sync_queue WHERE type = ? AND entity_id = ?`, [type, entityId]);
    if (existing) {
      // Ainda não enviada: atualiza o conteúdo; já sincronizada: nunca reenvia
      if (existing.status === 'PENDING' || existing.status === 'FAILED') {
        this.db.run(`UPDATE sync_queue SET payload = ?, status = 'PENDING', next_attempt_at = ? WHERE id = ?`, [JSON.stringify(payload), now, existing.id]);
      }
      return existing.id;
    }
    const id = uuid();
    this.db.run(
      `INSERT INTO sync_queue (id, type, entity, entity_id, payload, created_at, status, attempts, next_attempt_at, priority) VALUES (?,?,?,?,?,?,'PENDING',0,?,?)`,
      [id, type, entity, entityId, JSON.stringify(payload), now, now, PRIORITY[type]]);
    return id;
  }

  /** Próximos itens prontos, na ordem de dependência; marca como PROCESSING. */
  claim(limit = 20): QueueItem[] {
    return this.db.tx(() => {
      const items = this.db.all<QueueItem>(
        `SELECT * FROM sync_queue WHERE status IN ('PENDING', 'FAILED') AND archived_at IS NULL AND next_attempt_at <= ? ORDER BY priority, created_at LIMIT ?`,
        [this.clock.now().toISOString(), limit]);
      for (const i of items) this.db.run(`UPDATE sync_queue SET status = 'PROCESSING' WHERE id = ?`, [i.id]);
      return items;
    });
  }

  markSynced(id: string): void {
    this.db.run(`UPDATE sync_queue SET status = 'SYNCED', synced_at = ?, last_error = NULL, attempts = attempts + 1 WHERE id = ?`, [this.clock.now().toISOString(), id]);
  }

  /**
   * Falha: ERP fora do ar volta a tentar com espera crescente (30 s, 1 min, 2 min... até o
   * teto); recusa por regra também, mas com espera longa e o motivo à vista no painel.
   */
  markFailed(id: string, error: string, retryable: boolean): void {
    const row = this.db.get<{ attempts: number }>(`SELECT attempts FROM sync_queue WHERE id = ?`, [id]);
    const attempts = (row?.attempts ?? 0) + 1;
    const wait = retryable ? Math.min(this.maxBackoffMs, 30_000 * 2 ** (attempts - 1)) : this.maxBackoffMs;
    this.db.run(`UPDATE sync_queue SET status = 'FAILED', attempts = ?, last_error = ?, retryable = ?, next_attempt_at = ? WHERE id = ?`,
      [attempts, error.slice(0, 500), retryable ? 1 : 0, new Date(this.clock.now().getTime() + wait).toISOString(), id]);
  }

  /** Itens largados em PROCESSING por queda de energia/fechamento voltam para a fila. */
  recoverProcessing(): number {
    return this.db.run(`UPDATE sync_queue SET status = 'PENDING' WHERE status = 'PROCESSING'`).changes;
  }

  /**
   * Reenviar já: o gerente pede nova tentativa (todos os itens com falha) ou a conexão com o
   * ERP voltou (só os que falharam por indisponibilidade).
   */
  retryNow(opts: { id?: string; onlyUnavailable?: boolean } = {}): number {
    return this.db.run(`UPDATE sync_queue SET next_attempt_at = ? WHERE status = 'FAILED' AND archived_at IS NULL AND (? IS NULL OR id = ?) AND (? = 0 OR retryable = 1)`,
      [this.clock.now().toISOString(), opts.id ?? null, opts.id ?? null, opts.onlyUnavailable ? 1 : 0]).changes;
  }

  counts(): Record<SyncStatus, number> & { pendingSales: number; archived: number } {
    const rows = this.db.all<{ status: SyncStatus; n: number }>(`SELECT status, count(*) AS n FROM sync_queue WHERE archived_at IS NULL GROUP BY status`);
    const c = { PENDING: 0, PROCESSING: 0, SYNCED: 0, FAILED: 0, pendingSales: 0, archived: 0 };
    for (const r of rows) c[r.status] = Number(r.n);
    c.pendingSales = Number(this.db.get<{ n: number }>(`SELECT count(*) AS n FROM sync_queue WHERE type = 'sale' AND status <> 'SYNCED' AND archived_at IS NULL`)!.n);
    c.archived = Number(this.db.get<{ n: number }>(`SELECT count(*) AS n FROM sync_queue WHERE archived_at IS NOT NULL`)!.n);
    return c;
  }

  /** Arquiva um envio recusado em definitivo (com motivo e quem decidiu); não volta a ser tentado. */
  archive(id: string, reason: string, by: string | null): QueueItem | undefined {
    const item = this.db.get<QueueItem>(`SELECT * FROM sync_queue WHERE id = ? AND status = 'FAILED' AND archived_at IS NULL`, [id]);
    if (!item) return undefined;
    this.db.run(`UPDATE sync_queue SET archived_at = ?, archived_by = ?, archived_reason = ?, last_error = ? WHERE id = ?`,
      [this.clock.now().toISOString(), by, reason, `Arquivado: ${reason}`.slice(0, 500), id]);
    return item;
  }

  /** Tudo que ainda não foi aceito pelo ERP (troca de loja/ERP): arquiva com o motivo. */
  archiveUnsent(reason: string): QueueItem[] {
    const items = this.db.all<QueueItem>(`SELECT * FROM sync_queue WHERE status <> 'SYNCED' AND archived_at IS NULL`);
    const now = this.clock.now().toISOString();
    for (const i of items) {
      this.db.run(`UPDATE sync_queue SET status = 'FAILED', retryable = 0, archived_at = ?, archived_reason = ?, last_error = ? WHERE id = ?`,
        [now, reason, `Arquivado: ${reason}`.slice(0, 500), i.id]);
    }
    return items;
  }

  list(filter: { status?: SyncStatus; limit?: number; archived?: boolean } = {}): QueueItem[] {
    return this.db.all<QueueItem>(`SELECT * FROM sync_queue WHERE (? IS NULL OR status = ?) AND (? = 1 OR archived_at IS NULL) ORDER BY created_at DESC LIMIT ?`,
      [filter.status ?? null, filter.status ?? null, filter.archived ? 1 : 0, filter.limit ?? 100]);
  }

  /** Item ainda não sincronizado para a entidade (ex.: venda que ainda não chegou ao ERP). */
  pendingFor(type: SyncType, entityId: string): QueueItem | undefined {
    return this.db.get<QueueItem>(`SELECT * FROM sync_queue WHERE type = ? AND entity_id = ? AND status <> 'SYNCED'`, [type, entityId]);
  }
}
