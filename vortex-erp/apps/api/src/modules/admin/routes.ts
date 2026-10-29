import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate, page, decodeCursor } from '../../http/schemas.js';
import { hashPassword, randomToken, sha256 } from '../../core/crypto.js';
import { decide } from '../../core/approvals.js';
import { has } from '../../core/access.js';
import { forbidden } from '../../errors.js';
import { PERMISSIONS } from '../../core/permissions.js';

export function registerAdminRoutes(app: App) {
  route(app, { method: 'GET', url: '/v1/permissions', summary: 'Catálogo de permissões', tags: ['Acesso'], permission: null }, async () =>
    Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description })));

  route(app, { method: 'GET', url: '/v1/users', summary: 'Lista usuários', tags: ['Acesso'], permission: 'admin.usuario.gerenciar' }, async ({ tx }) =>
    tx.query(`SELECT u.id, u.email, u.name, u.status, u.mfa_enabled, u.own_portfolio_only, u.last_login_at,
                     coalesce(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
                FROM core.users u LEFT JOIN core.user_roles ur ON ur.user_id = u.id LEFT JOIN core.roles r ON r.id = ur.role_id
               GROUP BY u.id ORDER BY u.name`));

  const userBody = z.object({
    email: z.string().email(), name: z.string().min(2), password: z.string().min(10), roles: z.array(z.string()).min(1),
    establishmentIds: z.array(z.string().uuid()).default([]), warehouseIds: z.array(z.string().uuid()).default([]),
    ownPortfolioOnly: z.boolean().default(false), partyId: z.string().uuid().nullish(),
  });
  route(app, { method: 'POST', url: '/v1/users', summary: 'Cria usuário com papéis e escopo', tags: ['Acesso'], permission: 'admin.usuario.gerenciar', status: 201, body: userBody },
    async ({ tx, body }) => {
      const u = await tx.one<{ id: string }>(
        `INSERT INTO core.users (tenant_id, email, name, password_hash, own_portfolio_only, party_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [tx.tenantId, body.email, body.name, await hashPassword(body.password), body.ownPortfolioOnly, body.partyId ?? null, tx.userId]);
      await setUserAccess(tx, u.id, body.roles, body.establishmentIds, body.warehouseIds);
      return { id: u.id };
    });

  route(app, {
    method: 'PUT', url: '/v1/users/:id/access', summary: 'Define papéis e escopo do usuário', tags: ['Acesso'], permission: 'admin.usuario.gerenciar', params: idParams,
    body: z.object({ roles: z.array(z.string()).min(1), establishmentIds: z.array(z.string().uuid()).default([]), warehouseIds: z.array(z.string().uuid()).default([]), ownPortfolioOnly: z.boolean().optional(), status: z.enum(['active', 'blocked', 'inactive']).optional() }),
  }, async ({ tx, params, body }) => {
    await tx.one(`SELECT id FROM core.users WHERE id = $1`, [params.id], 'Usuário');
    await tx.exec(`DELETE FROM core.user_roles WHERE user_id = $1`, [params.id]);
    await tx.exec(`DELETE FROM core.user_establishments WHERE user_id = $1`, [params.id]);
    await tx.exec(`DELETE FROM core.user_warehouses WHERE user_id = $1`, [params.id]);
    await setUserAccess(tx, params.id, body.roles, body.establishmentIds, body.warehouseIds);
    if (body.ownPortfolioOnly !== undefined || body.status) {
      await tx.exec(`UPDATE core.users SET own_portfolio_only = coalesce($2, own_portfolio_only), status = coalesce($3, status) WHERE id = $1`,
        [params.id, body.ownPortfolioOnly ?? null, body.status ?? null]);
    }
    return { ok: true };
  });

  route(app, { method: 'GET', url: '/v1/roles', summary: 'Papéis e permissões', tags: ['Acesso'], permission: 'admin.usuario.gerenciar' }, async ({ tx }) =>
    tx.query(`SELECT r.*, coalesce(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
                FROM core.roles r LEFT JOIN core.role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.name`));

  route(app, {
    method: 'POST', url: '/v1/roles', summary: 'Cria papel (RBAC)', tags: ['Acesso'], permission: 'admin.usuario.gerenciar', status: 201,
    body: z.object({ code: z.string().regex(/^[a-z_]{3,40}$/), name: z.string().min(2), requiresMfa: z.boolean().default(false), permissions: z.array(z.string()).default([]) }),
  }, async ({ tx, body }) => {
    const r = await tx.one<{ id: string }>(`INSERT INTO core.roles (tenant_id, code, name, requires_mfa, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tx.tenantId, body.code, body.name, body.requiresMfa, tx.userId]);
    if (body.permissions.length) {
      await tx.exec(`INSERT INTO core.role_permissions (tenant_id, role_id, permission) SELECT $1, $2, unnest($3::text[])`, [tx.tenantId, r.id, body.permissions]);
    }
    return r;
  });

  route(app, {
    method: 'PUT', url: '/v1/roles/:id/permissions', summary: 'Substitui as permissões do papel', tags: ['Acesso'], permission: 'admin.usuario.gerenciar', params: idParams,
    body: z.object({ permissions: z.array(z.string()) }),
  }, async ({ tx, params, body }) => {
    await tx.exec(`DELETE FROM core.role_permissions WHERE role_id = $1`, [params.id]);
    await tx.exec(`INSERT INTO core.role_permissions (tenant_id, role_id, permission) SELECT $1, $2, unnest($3::text[])`, [tx.tenantId, params.id, body.permissions]);
    return { ok: true };
  });

  route(app, { method: 'GET', url: '/v1/approval-limits', summary: 'Alçadas por papel', tags: ['Acesso'], permission: 'admin.usuario.gerenciar' }, async ({ tx }) =>
    tx.query(`SELECT l.*, r.code AS role_code FROM core.approval_limits l JOIN core.roles r ON r.id = l.role_id ORDER BY l.action, r.code`));

  route(app, {
    method: 'PUT', url: '/v1/approval-limits', summary: 'Define alçada de um papel para uma ação', tags: ['Acesso'], permission: 'admin.usuario.gerenciar',
    body: z.object({ roleId: z.string().uuid(), action: z.string().min(3), maxPercent: decimal({ min: 0 }).nullish(), maxValue: decimal({ min: 0 }).nullish() }),
  }, async ({ tx, body }) =>
    tx.one(`INSERT INTO core.approval_limits (tenant_id, role_id, action, max_percent, max_value, created_by) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (role_id, action) DO UPDATE SET max_percent = EXCLUDED.max_percent, max_value = EXCLUDED.max_value RETURNING *`,
      [tx.tenantId, body.roleId, body.action, body.maxPercent ?? null, body.maxValue ?? null, tx.userId]));

  route(app, {
    method: 'PUT', url: '/v1/approval-policies', summary: 'Política de aprovações múltiplas por valor', tags: ['Acesso'], permission: 'admin.usuario.gerenciar',
    body: z.object({ action: z.string(), minValue: decimal({ min: 0 }), requiredApprovals: z.number().int().min(1).max(5), approverPermission: z.string() }),
  }, async ({ tx, body }) =>
    tx.one(`INSERT INTO core.approval_policies (tenant_id, action, min_value, required_approvals, approver_permission, created_by) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (tenant_id, action, min_value) DO UPDATE SET required_approvals = EXCLUDED.required_approvals, approver_permission = EXCLUDED.approver_permission RETURNING *`,
      [tx.tenantId, body.action, body.minValue, body.requiredApprovals, body.approverPermission, tx.userId]));

  // ---------------------------------------------------------------- aprovações
  route(app, {
    method: 'GET', url: '/v1/approvals', summary: 'Solicitações de aprovação que o usuário pode decidir', tags: ['Aprovações'], permission: null,
    query: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).default('pending') }),
  }, async ({ tx, ctx, query }) => {
    const rows = await tx.query(`SELECT a.*, (SELECT count(*)::int FROM core.approval_votes v WHERE v.request_id = a.id AND v.decision = 'approve') AS approvals
                                   FROM core.approval_requests a WHERE a.status = $1 ORDER BY a.created_at DESC LIMIT 500`, [query.status]);
    return rows.filter((r) => has(ctx, r.approver_permission));
  });

  route(app, {
    method: 'POST', url: '/v1/approvals/:id/decision', summary: 'Aprova ou reprova uma solicitação', tags: ['Aprovações'], permission: null, params: idParams,
    body: z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().optional() }),
  }, async ({ tx, params, body }) => decide(tx, params.id, body.decision, body.comment));

  // ---------------------------------------------------------------- chaves de API
  route(app, { method: 'GET', url: '/v1/api-keys', summary: 'Chaves de API', tags: ['Integrações'], permission: 'admin.integracao.gerenciar' }, async ({ tx }) =>
    tx.query(`SELECT id, name, prefix, scopes, company_id, rate_limit_per_minute, last_used_at, revoked_at, created_at FROM core.api_keys ORDER BY created_at DESC`));

  route(app, {
    method: 'POST', url: '/v1/api-keys', summary: 'Cria chave de API com escopo (o segredo é mostrado uma única vez)', tags: ['Integrações'], permission: 'admin.integracao.gerenciar', status: 201,
    body: z.object({ name: z.string().min(2), scopes: z.array(z.string()).min(1), companyId: z.string().uuid().nullish() }),
  }, async ({ tx, ctx, body }) => {
    // Uma chave nunca recebe permissão que o criador não tem.
    for (const s of body.scopes) if (!has(ctx, s)) throw forbidden(`Você não pode delegar a permissão ${s}`);
    const prefix = randomToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).padEnd(10, '0');
    const secret = randomToken(32);
    const row = await tx.one(`INSERT INTO core.api_keys (tenant_id, name, prefix, key_hash, scopes, company_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, prefix, scopes`,
      [tx.tenantId, body.name, prefix, sha256(secret), body.scopes, body.companyId ?? null, tx.userId]);
    return { ...row, key: `vx_${prefix}_${secret}` };
  });

  route(app, { method: 'DELETE', url: '/v1/api-keys/:id', summary: 'Revoga chave de API', tags: ['Integrações'], permission: 'admin.integracao.gerenciar', params: idParams },
    async ({ tx, params }) => tx.one(`UPDATE core.api_keys SET revoked_at = now() WHERE id = $1 RETURNING id, revoked_at`, [params.id], 'Chave'));

  // ---------------------------------------------------------------- auditoria
  route(app, {
    method: 'GET', url: '/v1/audit', summary: 'Log de auditoria (somente leitura)', tags: ['Auditoria'], permission: 'admin.auditoria.ler',
    query: z.object({ table: z.string().optional(), recordId: z.string().uuid().optional(), userId: z.string().uuid().optional(), sensitive: z.coerce.boolean().optional(),
      from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().optional() }),
  }, async ({ tx, query }) => {
    const c = decodeCursor(query.cursor);
    const rows = await tx.query(
      `SELECT a.*, u.name AS user_name FROM core.audit_log a LEFT JOIN core.users u ON u.id = a.user_id
        WHERE ($1::text IS NULL OR a.table_name = $1) AND ($2::uuid IS NULL OR a.record_id = $2) AND ($3::uuid IS NULL OR a.user_id = $3)
          AND ($4::boolean IS NULL OR a.sensitive = $4) AND ($5::date IS NULL OR a.created_at >= $5) AND ($6::date IS NULL OR a.created_at < $6::date + 1)
          AND ($7::timestamptz IS NULL OR (a.created_at, a.id) < ($7, $8::uuid))
        ORDER BY a.created_at DESC, a.id DESC LIMIT $9`,
      [query.table ?? null, query.recordId ?? null, query.userId ?? null, query.sensitive ?? null, query.from ?? null, query.to ?? null, c?.at ?? null, c?.id ?? null, query.limit + 1]);
    return page(rows, query.limit);
  });
}

async function setUserAccess(tx: import('../../db/tx.js').Tx, userId: string, roles: string[], establishmentIds: string[], warehouseIds: string[]) {
  const found = await tx.query<{ id: string; code: string }>(`SELECT id, code FROM core.roles WHERE code = ANY($1)`, [roles]);
  if (found.length !== roles.length) {
    const missing = roles.filter((r) => !found.some((f) => f.code === r));
    throw forbidden(`Papel inexistente: ${missing.join(', ')}`);
  }
  await tx.exec(`INSERT INTO core.user_roles (tenant_id, user_id, role_id) SELECT $1, $2, unnest($3::uuid[])`, [tx.tenantId, userId, found.map((f) => f.id)]);
  if (establishmentIds.length) await tx.exec(`INSERT INTO core.user_establishments (tenant_id, user_id, establishment_id) SELECT $1, $2, unnest($3::uuid[])`, [tx.tenantId, userId, establishmentIds]);
  if (warehouseIds.length) await tx.exec(`INSERT INTO core.user_warehouses (tenant_id, user_id, warehouse_id) SELECT $1, $2, unnest($3::uuid[])`, [tx.tenantId, userId, warehouseIds]);
}
