import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import type { Audit } from '../audit/audit.js';
import { PdvError, forbidden, needsAuthorization } from '../domain/errors.js';
import { randomToken, sha256, verifySecret } from '../security/crypto.js';
import { can, type Operator } from '../security/permissions.js';
import type { PdvSettings } from '@vortex/contracts';

/**
 * Login rápido (seção 6) com usuário e PIN, que funciona offline com os operadores
 * sincronizados do ERP; sessão com expiração por inatividade e duração máxima (seção 40);
 * bloqueio após tentativas erradas; autorização de supervisor pelo PIN dele.
 */
const MAX_FAILURES = 5;
const LOCK_MINUTES = 5;

export interface Session {
  token: string;
  operator: Operator;
  expiresAt: string;
}

export interface Authorization {
  login: string;
  pin: string;
}

interface OperatorRow {
  id: string;
  name: string;
  login: string;
  pin_hash: string;
  permissions: string;
  roles: string;
  discount_limit_percent: string;
}

const toOperator = (r: OperatorRow): Operator => ({
  id: r.id, name: r.name, login: r.login, permissions: JSON.parse(r.permissions), roles: JSON.parse(r.roles), discountLimitPercent: r.discount_limit_percent,
});

export class AuthService {
  constructor(private readonly db: LocalDb, private readonly clock: Clock, private readonly audit: Audit, private readonly settings: () => PdvSettings) {}

  private async check(login: string, pin: string): Promise<Operator> {
    const now = this.clock.now();
    const attempts = this.db.get<{ failures: number; locked_until: string | null }>(`SELECT failures, locked_until FROM login_attempts WHERE login = ?`, [login]);
    if (attempts?.locked_until && new Date(attempts.locked_until) > now) {
      throw new PdvError('LOCKED', `Usuário bloqueado por tentativas erradas; tente após ${new Date(attempts.locked_until).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, 423);
    }
    const row = this.db.get<OperatorRow>(`SELECT * FROM operators WHERE login = ?`, [login]);
    // Verifica mesmo sem usuário (tempo constante) para não revelar logins existentes
    const ok = await verifySecret(pin, row?.pin_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!row || !ok) {
      const failures = (attempts?.failures ?? 0) + 1;
      const lock = failures >= MAX_FAILURES ? new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString() : null;
      this.db.run(`INSERT INTO login_attempts (login, failures, locked_until) VALUES (?,?,?) ON CONFLICT (login) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
        [login, lock ? 0 : failures, lock]);
      this.audit.record({ userId: row?.id ?? null, action: 'LOGIN_FALHOU', entity: 'operator', entityId: row?.id ?? null, metadata: { login, locked: Boolean(lock) } });
      throw new PdvError('INVALID_CREDENTIALS', 'Usuário ou PIN inválido', 401);
    }
    this.db.run(`DELETE FROM login_attempts WHERE login = ?`, [login]);
    return toOperator(row);
  }

  async login(login: string, pin: string): Promise<Session> {
    if (!this.db.get(`SELECT 1 FROM operators LIMIT 1`)) throw new PdvError('NOT_PAIRED', 'Terminal sem operadores: sincronize com o ERP', 503);
    const op = await this.check(login, pin);
    if (!can(op, 'pdv.venda.operar')) throw forbidden('Usuário sem permissão para operar o PDV', 'pdv.venda.operar');
    const token = randomToken();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.settings().session.maxHours * 3_600_000).toISOString();
    this.db.run(`INSERT INTO auth_sessions (token_hash, operator_id, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?)`,
      [sha256(token), op.id, now.toISOString(), now.toISOString(), expiresAt]);
    this.audit.record({ userId: op.id, action: 'LOGIN', entity: 'operator', entityId: op.id, metadata: { login } });
    return { token, operator: op, expiresAt };
  }

  /** Valida o token: expira por inatividade (parâmetro do ERP) e pela duração máxima. */
  resolve(token: string): Operator {
    const now = this.clock.now();
    const s = this.db.get<{ operator_id: string; last_seen_at: string; expires_at: string; ended_at: string | null }>(`SELECT * FROM auth_sessions WHERE token_hash = ?`, [sha256(token)]);
    if (!s || s.ended_at) throw new PdvError('UNAUTHENTICATED', 'Sessão encerrada: faça login', 401);
    const idleMs = this.settings().session.idleMinutes * 60_000;
    if (new Date(s.expires_at) < now || now.getTime() - new Date(s.last_seen_at).getTime() > idleMs) {
      this.db.run(`UPDATE auth_sessions SET ended_at = ? WHERE token_hash = ?`, [now.toISOString(), sha256(token)]);
      throw new PdvError('SESSION_EXPIRED', 'Sessão expirada: informe o PIN novamente', 401);
    }
    const row = this.db.get<OperatorRow>(`SELECT * FROM operators WHERE id = ?`, [s.operator_id]);
    if (!row) throw new PdvError('UNAUTHENTICATED', 'Operador removido no ERP', 401);
    this.db.run(`UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?`, [now.toISOString(), sha256(token)]);
    return toOperator(row);
  }

  logout(token: string, operator: Operator): void {
    this.db.run(`UPDATE auth_sessions SET ended_at = ? WHERE token_hash = ? AND ended_at IS NULL`, [this.clock.now().toISOString(), sha256(token)]);
    this.audit.record({ userId: operator.id, action: 'LOGOUT', entity: 'operator', entityId: operator.id });
  }

  /**
   * Exige a permissão: do próprio operador ou de quem autoriza com login e PIN (supervisor).
   * Devolve quem autorizou (null quando o próprio operador tem a permissão).
   */
  async require(operator: Operator, permission: string, auth: Authorization | null | undefined, what: string, details: Record<string, unknown> = {}): Promise<Operator | null> {
    if (can(operator, permission) && !auth) return null;
    if (!auth) throw needsAuthorization(permission, `${what}: requer autorização do supervisor`, details);
    const approver = await this.check(auth.login, auth.pin);
    if (!can(approver, permission)) throw forbidden(`${approver.name} não tem permissão para autorizar: ${what}`, permission);
    this.audit.record({ userId: approver.id, action: 'AUTORIZACAO', entity: 'operator', entityId: operator.id, metadata: { permission, what, operator: operator.login, ...details } });
    return approver;
  }

  /** Verifica um supervisor (ex.: limite de desconto acima do do operador). */
  async approver(auth: Authorization): Promise<Operator> {
    return this.check(auth.login, auth.pin);
  }

  operatorById(id: string): Operator | null {
    const r = this.db.get<OperatorRow>(`SELECT * FROM operators WHERE id = ?`, [id]);
    return r ? toOperator(r) : null;
  }
}
