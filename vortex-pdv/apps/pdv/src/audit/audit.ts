import type { LocalDb } from '../db/sqlite.js';
import { uuid } from '../domain/ids.js';
import type { Clock } from '../clock.js';

/** Ações auditadas (seção 39) e eventos operacionais complementares. */
export type AuditAction =
  | 'LOGIN' | 'LOGOUT' | 'LOGIN_FALHOU' | 'ABERTURA_CAIXA' | 'VENDA' | 'CANCELAMENTO_ITEM' | 'CANCELAMENTO_VENDA' | 'DESCONTO' | 'AUTORIZACAO'
  | 'SANGRIA' | 'SUPRIMENTO' | 'FECHAMENTO_CAIXA' | 'REABERTURA_CAIXA' | 'DEVOLUCAO' | 'REIMPRESSAO' | 'SYNC' | 'ERRO_FISCAL' | 'ERRO_PAGAMENTO';

export interface AuditEvent {
  userId: string | null;
  action: AuditAction;
  entity?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditRow {
  id: string;
  user_id: string | null;
  terminal_id: string;
  action: AuditAction;
  entity: string | null;
  entity_id: string | null;
  metadata: Record<string, any>;
  timestamp: string;
}

/**
 * Trilha de auditoria local: imutável (gatilhos no banco), com user_id, terminal_id, action,
 * entity, entity_id, metadata e timestamp. Enviada ao ERP em lotes pela sincronização.
 */
export class Audit {
  constructor(private readonly db: LocalDb, private readonly terminalId: () => string, private readonly clock: Clock) {}

  record(e: AuditEvent): string {
    const id = uuid();
    this.db.run(
      `INSERT INTO events (id, user_id, terminal_id, action, entity, entity_id, metadata, timestamp) VALUES (?,?,?,?,?,?,?,?)`,
      [id, e.userId, this.terminalId(), e.action, e.entity ?? null, e.entityId ?? null, JSON.stringify(e.metadata ?? {}), this.clock.now().toISOString()]);
    return id;
  }

  list(filter: { action?: string; entityId?: string; limit?: number } = {}): AuditRow[] {
    return this.db.all<Omit<AuditRow, 'metadata'> & { metadata: string }>(
      `SELECT * FROM events WHERE (? IS NULL OR action = ?) AND (? IS NULL OR entity_id = ?) ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      [filter.action ?? null, filter.action ?? null, filter.entityId ?? null, filter.entityId ?? null, filter.limit ?? 200])
      .map((r) => ({ ...r, metadata: JSON.parse(String(r.metadata)) }));
  }
}
