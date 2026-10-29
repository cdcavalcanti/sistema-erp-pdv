import { SignJWT, jwtVerify } from 'jose';
import type { Pool } from '../db/pool.js';
import { withTenant, type RequestContext } from '../db/tx.js';
import { AppError } from '../errors.js';
import { safeEqual, sha256 } from '../core/crypto.js';

export interface TokenClaims {
  sub: string;
  tid: string;
  mfa: boolean;
}

export async function signToken(secret: string, ttlSeconds: number, claims: TokenClaims): Promise<string> {
  return new SignJWT({ tid: claims.tid, mfa: claims.mfa })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer('vortex-id')
    .setAudience('vortex-erp')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyToken(secret: string, token: string): Promise<TokenClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { issuer: 'vortex-id', audience: 'vortex-erp' });
    return { sub: String(payload.sub), tid: String(payload.tid), mfa: Boolean(payload.mfa) };
  } catch {
    throw new AppError('UNAUTHENTICATED', 'Sessão inválida ou expirada', 401);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Monta o contexto da requisição: permissões, escopo e empresa selecionada. */
export async function buildUserContext(
  pool: Pool,
  claims: TokenClaims,
  meta: { companyId: string | null; ip: string | null; device: string | null; requestId: string },
): Promise<RequestContext> {
  if (meta.companyId && !UUID_RE.test(meta.companyId)) throw new AppError('VALIDATION', 'X-Company-Id inválido', 400);
  const base: RequestContext = {
    tenantId: claims.tid, userId: claims.sub, companyId: null, establishmentIds: null, warehouseIds: null,
    permissions: new Set(), roles: [], ownPortfolioOnly: false, partyId: null, ip: meta.ip, device: meta.device,
    requestId: meta.requestId, apiKeyId: null, mfaVerified: claims.mfa,
  };
  return withTenant(pool, base, async (tx) => {
    const user = await tx.maybeOne<{ status: string; own_portfolio_only: boolean; party_id: string | null }>(
      `SELECT status, own_portfolio_only, party_id FROM core.users WHERE id = $1`, [claims.sub]);
    if (!user || user.status !== 'active') throw new AppError('UNAUTHENTICATED', 'Usuário inativo ou inexistente', 401);
    const roles = await tx.query<{ code: string; requires_mfa: boolean }>(
      `SELECT r.code, r.requires_mfa FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [claims.sub]);
    const perms = await tx.query<{ permission: string }>(
      `SELECT DISTINCT rp.permission FROM core.user_roles ur JOIN core.role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1`, [claims.sub]);
    // MFA obrigatório para papéis que exigem (administrador, financeiro)
    if (roles.some((r) => r.requires_mfa) && !claims.mfa) {
      throw new AppError('MFA_REQUIRED', 'Este perfil exige autenticação em dois fatores', 401);
    }
    const ests = await tx.query<{ establishment_id: string }>(`SELECT establishment_id FROM core.user_establishments WHERE user_id = $1`, [claims.sub]);
    const whs = await tx.query<{ warehouse_id: string }>(`SELECT warehouse_id FROM core.user_warehouses WHERE user_id = $1`, [claims.sub]);
    let companyId: string | null = null;
    if (meta.companyId) {
      const c = await tx.maybeOne(`SELECT id FROM core.companies WHERE id = $1`, [meta.companyId]);
      if (!c) throw new AppError('FORBIDDEN', 'Empresa não pertence ao seu acesso', 403);
      companyId = meta.companyId;
    }
    return {
      ...base,
      companyId,
      roles: roles.map((r) => r.code),
      permissions: new Set(perms.map((p) => p.permission)),
      establishmentIds: ests.length ? ests.map((e) => e.establishment_id) : null,
      warehouseIds: whs.length ? whs.map((w) => w.warehouse_id) : null,
      ownPortfolioOnly: user.own_portfolio_only,
      partyId: user.party_id,
    };
  }, { readOnly: true });
}

/** Chave de API: vx_<prefixo>_<segredo>. Só o hash do segredo é guardado. */
export async function buildApiKeyContext(
  pool: Pool,
  rawKey: string,
  meta: { companyId: string | null; ip: string | null; device: string | null; requestId: string },
): Promise<RequestContext> {
  const m = /^vx_([A-Za-z0-9]{8,32})_([A-Za-z0-9_-]{20,})$/.exec(rawKey);
  if (!m) throw new AppError('UNAUTHENTICATED', 'Chave de API inválida', 401);
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM core.resolve_api_key($1)`, [m[1]]);
    const key = r.rows[0];
    if (!key || key.revoked_at || !safeEqual(key.key_hash, sha256(m[2]!))) throw new AppError('UNAUTHENTICATED', 'Chave de API inválida', 401);
    const companyId = key.company_id ?? meta.companyId;
    return {
      tenantId: key.tenant_id, userId: null, companyId, establishmentIds: null, warehouseIds: null,
      permissions: new Set<string>(key.scopes), roles: ['api_key'], ownPortfolioOnly: false, partyId: null,
      ip: meta.ip, device: meta.device ?? 'api', requestId: meta.requestId, apiKeyId: key.id, mfaVerified: true,
    };
  } finally {
    client.release();
  }
}
