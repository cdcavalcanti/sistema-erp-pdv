import type { Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { has } from './access.js';
import { auditAction } from './audit.js';

export interface ApprovalRequestInput {
  entityType: string;
  entityId: string;
  action: string;
  reasonCode: string;
  reason: string;
  value?: string | null;
  approverPermission: string;
  requiredApprovals?: number;
}

export interface ApprovalRow {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  reason_code: string;
  reason: string;
  value: string | null;
  required_approvals: number;
  approver_permission: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requested_by: string | null;
}

type DecisionHandler = (tx: Tx, req: ApprovalRow) => Promise<void>;
const handlers = new Map<string, DecisionHandler>();

/** Cada módulo registra o que acontece quando uma aprovação do seu tipo é decidida. */
export function onApprovalDecided(entityType: string, handler: DecisionHandler): void {
  handlers.set(entityType, handler);
}

/**
 * Cria (ou reaproveita) uma solicitação de aprovação. Políticas por valor
 * (core.approval_policies) podem exigir mais de uma aprovação.
 */
export async function requestApproval(tx: Tx, input: ApprovalRequestInput): Promise<ApprovalRow> {
  const existing = await tx.maybeOne<ApprovalRow>(
    `SELECT * FROM core.approval_requests WHERE entity_type = $1 AND entity_id = $2 AND action = $3 AND reason_code = $4 AND status = 'pending'`,
    [input.entityType, input.entityId, input.action, input.reasonCode],
  );
  if (existing) return existing;
  let required = input.requiredApprovals ?? 1;
  let approverPermission = input.approverPermission;
  if (input.value != null) {
    const policy = await tx.maybeOne<{ required_approvals: number; approver_permission: string }>(
      `SELECT required_approvals, approver_permission FROM core.approval_policies
        WHERE action = $1 AND min_value <= $2::numeric ORDER BY min_value DESC LIMIT 1`,
      [input.action, input.value],
    );
    if (policy) {
      required = Math.max(required, policy.required_approvals);
      approverPermission = policy.approver_permission;
    }
  }
  return tx.one<ApprovalRow>(
    `INSERT INTO core.approval_requests (tenant_id, company_id, entity_type, entity_id, action, reason_code, reason, value, required_approvals, approver_permission, requested_by, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
    [tx.tenantId, tx.ctx.companyId, input.entityType, input.entityId, input.action, input.reasonCode, input.reason, input.value ?? null, required, approverPermission, tx.userId],
  );
}

export async function pendingApprovals(tx: Tx, entityType: string, entityId: string): Promise<ApprovalRow[]> {
  return tx.query<ApprovalRow>(
    `SELECT * FROM core.approval_requests WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending' ORDER BY created_at`,
    [entityType, entityId],
  );
}

export async function cancelPendingApprovals(tx: Tx, entityType: string, entityId: string): Promise<void> {
  await tx.exec(
    `UPDATE core.approval_requests SET status = 'cancelled', decided_at = now() WHERE entity_type = $1 AND entity_id = $2 AND status = 'pending'`,
    [entityType, entityId],
  );
}

/**
 * Registra um voto. Quem pediu não aprova o próprio pedido (segregação de funções).
 * Atingido o número de aprovações exigido, dispara o handler do módulo.
 */
export async function decide(tx: Tx, requestId: string, decision: 'approve' | 'reject', comment?: string): Promise<ApprovalRow> {
  const req = await tx.maybeOne<ApprovalRow>(`SELECT * FROM core.approval_requests WHERE id = $1 FOR UPDATE`, [requestId]);
  if (!req) throw notFound('Solicitação de aprovação');
  if (req.status !== 'pending') throw new AppError('APPROVAL_CLOSED', 'Esta solicitação já foi decidida', 409);
  if (!has(tx.ctx, req.approver_permission)) throw forbidden(`Permissão necessária para aprovar: ${req.approver_permission}`);
  if (req.requested_by && req.requested_by === tx.userId && !tx.ctx.permissions.has('*')) {
    throw new AppError('BUSINESS_RULE', 'Quem solicitou não pode aprovar a própria solicitação', 403, { rule: 'RN-ACE-01' });
  }
  if (decision === 'reject' && !(comment && comment.trim().length >= 5)) {
    throw new AppError('REASON_REQUIRED', 'Informe o motivo da reprovação', 422);
  }
  await tx.exec(
    `INSERT INTO core.approval_votes (tenant_id, request_id, user_id, decision, comment) VALUES ($1,$2,$3,$4,$5)`,
    [tx.tenantId, requestId, tx.userId, decision, comment ?? null],
  ).catch((e) => {
    if ((e as { code?: string }).code === '23505') throw new AppError('ALREADY_VOTED', 'Você já votou nesta solicitação', 409);
    throw e;
  });
  let status: ApprovalRow['status'] = 'pending';
  if (decision === 'reject') status = 'rejected';
  else {
    const { n } = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM core.approval_votes WHERE request_id = $1 AND decision = 'approve'`, [requestId]);
    if (n >= req.required_approvals) status = 'approved';
  }
  if (status !== 'pending') {
    const updated = await tx.one<ApprovalRow>(
      `UPDATE core.approval_requests SET status = $2, decided_at = now() WHERE id = $1 RETURNING *`, [requestId, status]);
    await auditAction(tx, { action: `aprovacao.${status}`, table: 'core.approval_requests', recordId: requestId, reason: comment ?? null, data: { entity: req.entity_type, action: req.action } });
    const h = handlers.get(req.entity_type);
    if (h) await h(tx, updated);
    return updated;
  }
  return { ...req, status };
}
