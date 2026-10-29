import { z } from 'zod';
import { loginSchema } from '@vortex/contracts';
import type { App } from '../../http/app.js';
import { resolveContext } from '../../http/app.js';
import { signToken, verifyToken } from '../../http/auth.js';
import { systemContext, withTenant } from '../../db/tx.js';
import { AppError } from '../../errors.js';
import { generateTotpSecret, verifyPassword, verifyTotp } from '../../core/crypto.js';
import { auditAction } from '../../core/audit.js';

/**
 * Stub local do VORTEX ID (login único). Em produção o token vem do VORTEX ID;
 * o ERP só valida a assinatura e lê as permissões do próprio banco.
 */
export function registerAuthRoutes(app: App) {
  const loginBody = loginSchema;

  app.post('/v1/auth/login', { schema: { summary: 'Login (VORTEX ID local)', tags: ['Acesso'] }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = loginBody.parse(req.body);
    const { pool, config, vault } = app.deps;
    const client = await pool.connect();
    let tenantId: string | null;
    try {
      tenantId = (await client.query(`SELECT core.resolve_tenant_by_slug($1) AS id`, [body.tenant])).rows[0]?.id ?? null;
    } finally {
      client.release();
    }
    const invalid = new AppError('INVALID_CREDENTIALS', 'E-mail, senha ou empresa inválidos', 401);
    if (!tenantId) throw invalid;
    const ctx = { ...systemContext(tenantId), ip: req.ip, device: String(req.headers['user-agent'] ?? '').slice(0, 200), requestId: String(req.id) };
    return withTenant(pool, ctx, async (tx) => {
      const user = await tx.maybeOne<{ id: string; name: string; password_hash: string; status: string; mfa_enabled: boolean; mfa_secret_id: string | null }>(
        `SELECT id, name, password_hash, status, mfa_enabled, mfa_secret_id FROM core.users WHERE email = $1`, [body.email]);
      if (!user || user.status !== 'active' || !(await verifyPassword(body.password, user.password_hash))) throw invalid;
      let mfa = false;
      if (user.mfa_enabled && user.mfa_secret_id) {
        if (!body.totp) throw new AppError('MFA_CODE_REQUIRED', 'Informe o código do aplicativo autenticador', 401);
        const secret = await vault.getString(tx, user.mfa_secret_id);
        if (!verifyTotp(secret, body.totp)) throw new AppError('MFA_INVALID', 'Código de verificação inválido', 401);
        mfa = true;
      }
      const needsMfa = await tx.maybeOne(
        `SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.requires_mfa`, [user.id]);
      await tx.exec(`UPDATE core.users SET last_login_at = now() WHERE id = $1`, [user.id]);
      await auditAction(tx, { action: 'auth.login', table: 'core.users', recordId: user.id, data: { mfa } });
      const token = await signToken(config.jwtSecret, config.jwtTtlSeconds, { sub: user.id, tid: tenantId!, mfa });
      return { token, user: { id: user.id, name: user.name }, tenantId, mfaSetupRequired: Boolean(needsMfa) && !user.mfa_enabled };
    });
  });

  // Configuração de MFA: usa só o token (o perfil pode exigir MFA antes de liberar o resto).
  app.post('/v1/auth/mfa/setup', { schema: { summary: 'Gera segredo TOTP para configurar MFA', tags: ['Acesso'] } }, async (req) => {
    const claims = await verifyToken(app.deps.config.jwtSecret, String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const ctx = { ...systemContext(claims.tid), userId: claims.sub, requestId: String(req.id) };
    return withTenant(app.deps.pool, ctx, async (tx) => {
      const user = await tx.one<{ email: string; mfa_enabled: boolean }>(`SELECT email, mfa_enabled FROM core.users WHERE id = $1`, [claims.sub], 'Usuário');
      if (user.mfa_enabled) throw new AppError('MFA_ALREADY_ENABLED', 'MFA já está ativo para este usuário', 409);
      const secret = generateTotpSecret();
      const id = await app.deps.vault.put(tx, 'mfa_totp', `mfa-pending-${claims.sub}`, secret);
      await tx.exec(`UPDATE core.users SET mfa_secret_id = $2 WHERE id = $1`, [claims.sub, id]);
      return { secret, otpauthUrl: `otpauth://totp/VORTEX:${encodeURIComponent(user.email)}?secret=${secret}&issuer=VORTEX` };
    });
  });

  app.post('/v1/auth/mfa/activate', { schema: { summary: 'Ativa MFA confirmando um código', tags: ['Acesso'] } }, async (req) => {
    const claims = await verifyToken(app.deps.config.jwtSecret, String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const ctx = { ...systemContext(claims.tid), userId: claims.sub, requestId: String(req.id) };
    return withTenant(app.deps.pool, ctx, async (tx) => {
      const user = await tx.one<{ mfa_secret_id: string | null }>(`SELECT mfa_secret_id FROM core.users WHERE id = $1`, [claims.sub], 'Usuário');
      if (!user.mfa_secret_id) throw new AppError('MFA_NOT_SETUP', 'Gere o segredo antes de ativar', 409);
      const secret = await app.deps.vault.getString(tx, user.mfa_secret_id);
      if (!verifyTotp(secret, code)) throw new AppError('MFA_INVALID', 'Código de verificação inválido', 401);
      await tx.exec(`UPDATE core.users SET mfa_enabled = true WHERE id = $1`, [claims.sub]);
      await auditAction(tx, { action: 'auth.mfa_ativado', table: 'core.users', recordId: claims.sub });
      const token = await signToken(app.deps.config.jwtSecret, app.deps.config.jwtTtlSeconds, { sub: claims.sub, tid: claims.tid, mfa: true });
      return { token };
    });
  });

  app.get('/v1/me', { schema: { summary: 'Usuário atual, papéis, permissões e escopo', tags: ['Acesso'] } }, async (req) => {
    const ctx = await resolveContext(app, req);
    return withTenant(app.deps.pool, ctx, async (tx) => {
      const user = ctx.userId ? await tx.maybeOne(`SELECT id, name, email, mfa_enabled, own_portfolio_only FROM core.users WHERE id = $1`, [ctx.userId]) : null;
      const tenant = await tx.one(`SELECT id, name, slug, plan, settings FROM core.tenants WHERE id = $1`, [ctx.tenantId]);
      const companies = await tx.query(`SELECT id, legal_name, trade_name, cnpj_root FROM core.companies ORDER BY legal_name`);
      return {
        user, tenant, companies, companyId: ctx.companyId, roles: ctx.roles, permissions: [...ctx.permissions].sort(),
        establishmentIds: ctx.establishmentIds, warehouseIds: ctx.warehouseIds,
      };
    }, { readOnly: true });
  });
}
