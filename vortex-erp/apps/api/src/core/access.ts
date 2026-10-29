import type { RequestContext, Tx } from '../db/tx.js';
import { forbidden } from '../errors.js';
import { D, type Decimal } from '@vortex/money';

export function has(ctx: RequestContext, perm: string): boolean {
  return ctx.permissions.has('*') || ctx.permissions.has(perm);
}

export function requirePerm(ctx: RequestContext, perm: string): void {
  if (!has(ctx, perm)) throw forbidden(`Permissão necessária: ${perm}`, { permission: perm });
}

/** Escopo: em quais estabelecimentos o usuário atua (seção 04). */
export function assertEstablishmentScope(ctx: RequestContext, establishmentId: string): void {
  if (ctx.establishmentIds && !ctx.establishmentIds.includes(establishmentId)) {
    throw forbidden('Estabelecimento fora do seu escopo de acesso', { establishmentId });
  }
}

export function assertWarehouseScope(ctx: RequestContext, warehouseId: string): void {
  if (ctx.warehouseIds && !ctx.warehouseIds.includes(warehouseId)) {
    throw forbidden('Depósito fora do seu escopo de acesso', { warehouseId });
  }
}

export interface LimitResult {
  allowed: boolean;
  maxPercent: Decimal | null;
  maxValue: Decimal | null;
}

/**
 * Alçadas: limite de valor/percentual por ação, o maior entre os papéis do usuário.
 * Sem alçada cadastrada para nenhum papel do usuário → não permitido (exige aprovação).
 */
export async function checkLimit(tx: Tx, action: string, amount: { percent?: Decimal | string; value?: Decimal | string }): Promise<LimitResult> {
  if (tx.ctx.permissions.has('*')) return { allowed: true, maxPercent: null, maxValue: null };
  if (!tx.ctx.userId) return { allowed: false, maxPercent: null, maxValue: null };
  const row = await tx.maybeOne<{ max_percent: string | null; max_value: string | null }>(
    `SELECT max(l.max_percent) AS max_percent, max(l.max_value) AS max_value
       FROM core.approval_limits l JOIN core.user_roles ur ON ur.role_id = l.role_id
      WHERE ur.user_id = $1 AND l.action = $2`,
    [tx.ctx.userId, action],
  );
  const maxPercent = row?.max_percent != null ? D(row.max_percent) : null;
  const maxValue = row?.max_value != null ? D(row.max_value) : null;
  let allowed = true;
  if (amount.percent !== undefined) allowed &&= maxPercent !== null && D(amount.percent).lessThanOrEqualTo(maxPercent);
  if (amount.value !== undefined) allowed &&= maxValue !== null && D(amount.value).lessThanOrEqualTo(maxValue);
  return { allowed, maxPercent, maxValue };
}
