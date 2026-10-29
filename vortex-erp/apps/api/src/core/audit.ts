import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';

/** Registra uma ação de negócio (não ligada a uma linha específica) no log de auditoria. */
export async function auditAction(
  tx: Tx,
  a: { action: string; table: string; recordId?: string | null; reason?: string | null; sensitive?: boolean; data?: unknown },
): Promise<void> {
  await tx.exec(
    `INSERT INTO core.audit_log (tenant_id, company_id, user_id, ip, device, request_id, table_name, record_id, operation, action, reason, sensitive, new_data)
     VALUES ($1, $2, $3, nullif($4,'')::inet, $5, $6, $7, $8, 'ACTION', $9, $10, $11, $12)`,
    [tx.tenantId, tx.ctx.companyId, tx.ctx.userId, tx.ctx.ip ?? '', tx.ctx.device, tx.ctx.requestId, a.table, a.recordId ?? null,
      a.action, a.reason ?? null, a.sensitive ?? false, a.data === undefined ? null : JSON.stringify(a.data)],
  );
}

/**
 * RN-ACE-03: ações sensíveis (cancelar nota, estornar baixa, reabrir período,
 * alterar custo) exigem motivo em texto e ficam destacadas na auditoria.
 */
export async function requireReason(tx: Tx, reason: string | undefined | null, action: string): Promise<string> {
  const r = (reason ?? '').trim();
  if (r.length < 15) {
    throw new AppError('REASON_REQUIRED', 'Informe o motivo (mínimo 15 caracteres) para esta ação sensível', 422, { rule: 'RN-ACE-03', action });
  }
  await tx.setReason(`${action}: ${r}`, true);
  return r;
}
