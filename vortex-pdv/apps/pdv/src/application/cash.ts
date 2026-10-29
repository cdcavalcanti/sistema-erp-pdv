import { D } from '@vortex/money';
import type { PdvSettings } from '@vortex/contracts';
import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import type { Audit } from '../audit/audit.js';
import type { SyncQueue } from '../sync/queue.js';
import { PdvError, conflict, invalid } from '../domain/errors.js';
import { uuid } from '../domain/ids.js';
import { GROUP_OF, conference, expectedTotals, totalDifference, type CashGroup, type Conference, type ExpectedTotals } from '../domain/cash.js';
import type { PaymentMethod } from '../domain/payments.js';
import { P, type Operator } from '../security/permissions.js';
import type { AuthService, Authorization } from './auth.js';

export interface CashSessionRow {
  id: string;
  terminal_code: string;
  operator_id: string;
  opened_at: string;
  opening_amount: string;
  status: 'open' | 'closed';
  closed_at: string | null;
  closed_by: string | null;
  closing: string | null;
  reopen_count: number;
}

export interface CashSummary {
  session: CashSessionRow;
  expected: ExpectedTotals;
  salesCount: number;
  salesTotal: string;
  movements: { id: string; kind: string; amount: string; reason: string | null; operator_id: string; authorized_by: string | null; created_at: string }[];
}

interface CashDeps {
  db: LocalDb;
  clock: Clock;
  audit: Audit;
  queue: SyncQueue;
  auth: AuthService;
  settings: () => PdvSettings;
  terminalCode: string;
  establishmentId: () => string;
  /** Pulso da gaveta (pela impressora); falha da impressora não desfaz o movimento já gravado */
  openDrawer?: () => Promise<void>;
}

/**
 * Caixa (seções 7, 25 a 28): abertura com fundo de troco, suprimento, sangria (com supervisor
 * quando o ERP exige), fechamento com conferência por forma de pagamento e reabertura pelo
 * gerente. Toda movimentação é registrada, auditada e enviada ao ERP pela fila.
 */
export class CashService {
  constructor(private readonly d: CashDeps) {}

  current(): CashSessionRow | null {
    return this.d.db.get<CashSessionRow>(`SELECT * FROM cash_sessions WHERE terminal_code = ? AND status = 'open'`, [this.d.terminalCode]) ?? null;
  }

  requireOpen(): CashSessionRow {
    const s = this.current();
    if (!s) throw new PdvError('CASH_CLOSED', 'Caixa fechado: faça a abertura antes de vender', 409);
    return s;
  }

  private movement(sessionId: string, kind: string, amount: string, op: Operator, extra: { reason?: string | null; note?: string | null; authorizedBy?: string | null; details?: unknown } = {}) {
    const id = uuid();
    const at = this.d.clock.now().toISOString();
    this.d.db.run(`INSERT INTO cash_movements (id, session_id, kind, amount, reason, note, operator_id, authorized_by, details, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, sessionId, kind, amount, extra.reason ?? null, extra.note ?? null, op.id, extra.authorizedBy ?? null, extra.details ? JSON.stringify(extra.details) : null, at]);
    return { id, at };
  }

  private enqueue(movementId: string, payload: Record<string, unknown>) {
    this.d.queue.enqueue('cash_movement', 'cash_movement', movementId, {
      establishmentId: this.d.establishmentId(), pdvId: this.d.terminalCode, reference: movementId, ...payload,
    });
  }

  async open(op: Operator, amount: string, auth?: Authorization | null): Promise<CashSessionRow> {
    const approver = await this.d.auth.require(op, P.openCash, auth, 'Abrir caixa');
    if (D(amount).isNegative()) throw invalid('Valor inicial não pode ser negativo');
    return this.d.db.tx(() => {
      if (this.current()) throw conflict('CASH_ALREADY_OPEN', 'Já existe caixa aberto neste terminal');
      const id = uuid();
      const at = this.d.clock.now().toISOString();
      this.d.db.run(`INSERT INTO cash_sessions (id, terminal_code, operator_id, opened_at, opening_amount, status) VALUES (?,?,?,?,?, 'open')`,
        [id, this.d.terminalCode, op.id, at, D(amount).toFixed(2)]);
      const m = this.movement(id, 'opening', D(amount).toFixed(2), op, { authorizedBy: approver?.id });
      this.enqueue(m.id, { kind: 'opening', sessionId: id, amount: D(amount).toFixed(2), operatorId: op.id, authorizedBy: approver?.id ?? null, occurredAt: at });
      this.d.audit.record({ userId: op.id, action: 'ABERTURA_CAIXA', entity: 'cash_session', entityId: id, metadata: { terminal: this.d.terminalCode, amount: D(amount).toFixed(2), sessionId: id } });
      return this.current()!;
    });
  }

  async supply(op: Operator, amount: string, reason: string, auth?: Authorization | null) {
    const s = this.requireOpen();
    if (D(amount).lessThanOrEqualTo(0)) throw invalid('Informe o valor do suprimento');
    if (!reason?.trim()) throw invalid('Informe o motivo do suprimento');
    const approver = await this.d.auth.require(op, P.supply, auth, 'Suprimento', { amount });
    const r = this.d.db.tx(() => {
      const m = this.movement(s.id, 'supply', D(amount).toFixed(2), op, { reason, authorizedBy: approver?.id });
      this.enqueue(m.id, { kind: 'supply', sessionId: s.id, amount: D(amount).toFixed(2), reason, operatorId: op.id, authorizedBy: approver?.id ?? null, occurredAt: m.at });
      this.d.audit.record({ userId: op.id, action: 'SUPRIMENTO', entity: 'cash_session', entityId: s.id, metadata: { amount: D(amount).toFixed(2), reason, authorizedBy: approver?.id ?? null } });
      return { id: m.id, amount: D(amount).toFixed(2), at: m.at };
    });
    await this.d.openDrawer?.().catch(() => undefined);
    return r;
  }

  async withdraw(op: Operator, amount: string, reason: string, note: string | null, auth?: Authorization | null) {
    const s = this.requireOpen();
    if (D(amount).lessThanOrEqualTo(0)) throw invalid('Informe o valor da sangria');
    if (!reason?.trim()) throw invalid('Informe o motivo da sangria');
    const inDrawer = D(this.summary(s.id).expected.cash);
    if (D(amount).greaterThan(inDrawer)) throw invalid(`Sangria maior que o dinheiro na gaveta (R$ ${inDrawer.toFixed(2)})`);
    // Sangria pelo supervisor (ou autorizada por ele) quando o ERP exige
    const approver = this.d.settings().cash.withdrawalRequiresSupervisor ? await this.d.auth.require(op, P.withdrawal, auth, 'Sangria', { amount }) : null;
    const r = this.d.db.tx(() => {
      const m = this.movement(s.id, 'withdrawal', D(amount).toFixed(2), op, { reason, note, authorizedBy: approver?.id });
      this.enqueue(m.id, { kind: 'withdrawal', sessionId: s.id, amount: D(amount).toFixed(2), reason: note ? `${reason} — ${note}` : reason, operatorId: op.id,
        authorizedBy: approver?.id ?? null, occurredAt: m.at });
      this.d.audit.record({ userId: op.id, action: 'SANGRIA', entity: 'cash_session', entityId: s.id, metadata: { amount: D(amount).toFixed(2), reason, note, authorizedBy: approver?.id ?? null } });
      return { id: m.id, amount: D(amount).toFixed(2), at: m.at };
    });
    await this.d.openDrawer?.().catch(() => undefined);
    return r;
  }

  /** Esperado da sessão: abertura + suprimentos − sangrias + vendas − devoluções, por forma. */
  summary(sessionId: string): CashSummary {
    const session = this.d.db.get<CashSessionRow>(`SELECT * FROM cash_sessions WHERE id = ?`, [sessionId]);
    if (!session) throw new PdvError('NOT_FOUND', 'Sessão de caixa não encontrada', 404);
    const movements = this.d.db.all<CashSummary['movements'][number]>(`SELECT id, kind, amount, reason, operator_id, authorized_by, created_at FROM cash_movements WHERE session_id = ? ORDER BY created_at`, [sessionId]);
    const payments = this.d.db.all<{ method: PaymentMethod; amount: string }>(
      `SELECT p.method, p.amount FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.session_id = ? AND s.status = 'completed' AND p.status = 'approved'`, [sessionId]);
    // Vendas de outra sessão canceladas nesta: o dinheiro sai daqui
    const cancelledHere = this.d.db.all<{ method: PaymentMethod; amount: string }>(
      `SELECT p.method, p.amount FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.status = 'cancelled' AND s.completed_at IS NOT NULL AND s.session_id <> ? AND p.status IN ('approved', 'refunded')
          AND s.cancelled_at >= ? AND (? IS NULL OR s.cancelled_at <= ?)`, [sessionId, session.opened_at, session.closed_at, session.closed_at]);
    const returns = this.d.db.all<{ refund_method: string; total: string }>(`SELECT refund_method, total FROM returns WHERE session_id = ?`, [sessionId]);
    const refunds: { group: CashGroup; amount: string }[] = [
      ...cancelledHere.map((p) => ({ group: GROUP_OF[p.method], amount: p.amount })),
      ...returns.filter((r) => r.refund_method !== 'store_credit').map((r) => ({ group: (r.refund_method === 'card' ? 'credit' : r.refund_method) as CashGroup, amount: r.total })),
    ];
    const expected = expectedTotals({
      opening: session.opening_amount,
      supplies: movements.filter((m) => m.kind === 'supply').map((m) => m.amount),
      withdrawals: movements.filter((m) => m.kind === 'withdrawal').map((m) => m.amount),
      payments, refunds,
    });
    const sales = this.d.db.get<{ n: number; total: string | null }>(`SELECT count(*) AS n, group_concat(total, '|') AS total FROM sales WHERE session_id = ? AND status = 'completed'`, [sessionId])!;
    const salesTotal = (sales.total ?? '').split('|').filter(Boolean).reduce((a, x) => a.plus(x), D(0)).toFixed(2);
    return { session, expected, salesCount: Number(sales.n), salesTotal, movements };
  }

  /** Fechamento (seções 27 e 28): o operador informa os valores; diferenças ficam registradas. */
  async close(op: Operator, informed: Partial<Record<CashGroup, string>>, auth?: Authorization | null): Promise<{ conference: Conference[]; difference: string; summary: CashSummary }> {
    const s = this.requireOpen();
    if (informed.cash === undefined) throw invalid('Informe o dinheiro contado na gaveta');
    const approver = await this.d.auth.require(op, P.closeCash, auth, 'Fechar caixa');
    const busy = this.d.db.get(`SELECT number FROM sales WHERE session_id = ? AND status IN ('open', 'payment') AND EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = sales.id)`, [s.id]);
    if (busy) throw conflict('SALE_IN_PROGRESS', 'Há venda em andamento: finalize ou cancele antes de fechar o caixa');
    const summary = this.summary(s.id);
    const conf = conference(summary.expected, informed);
    const diff = totalDifference(conf);
    return this.d.db.tx(() => {
      const at = this.d.clock.now().toISOString();
      const closing = { at, by: op.id, authorizedBy: approver?.id ?? null, expected: summary.expected, conference: conf, difference: diff.toFixed(2), salesCount: summary.salesCount, salesTotal: summary.salesTotal };
      // Fechamentos anteriores (após reabertura) ficam no histórico de movimentos
      this.d.db.run(`UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by = ?, closing = ? WHERE id = ?`, [at, op.id, JSON.stringify(closing), s.id]);
      const m = this.movement(s.id, 'closing', informed.cash!, op, { authorizedBy: approver?.id, details: closing });
      this.enqueue(m.id, { kind: 'closing', sessionId: s.id, counted: D(informed.cash!).toFixed(2), operatorId: op.id, authorizedBy: approver?.id ?? null, occurredAt: at,
        details: { expectedCash: summary.expected.cash, expected: summary.expected, conference: conf, salesCount: summary.salesCount, salesTotal: summary.salesTotal } });
      this.d.audit.record({ userId: op.id, action: 'FECHAMENTO_CAIXA', entity: 'cash_session', entityId: s.id, metadata: { difference: diff.toFixed(2), conference: conf, authorizedBy: approver?.id ?? null } });
      return { conference: conf, difference: diff.toFixed(2), summary: this.summary(s.id) };
    });
  }

  /** Reabertura pelo gerente, com motivo; a diferença lançada no ERP é estornada e relançada no novo fechamento. */
  async reopen(op: Operator, sessionId: string, reason: string, auth?: Authorization | null): Promise<CashSessionRow> {
    if (!reason || reason.trim().length < 15) throw invalid('Informe o motivo da reabertura (mínimo 15 caracteres)');
    const approver = await this.d.auth.require(op, P.reopenCash, auth, 'Reabrir caixa');
    return this.d.db.tx(() => {
      const s = this.d.db.get<CashSessionRow>(`SELECT * FROM cash_sessions WHERE id = ?`, [sessionId]);
      if (!s || s.status !== 'closed') throw conflict('INVALID_STATUS', 'Somente caixa fechado pode ser reaberto');
      if (this.current()) throw conflict('CASH_ALREADY_OPEN', 'Feche o caixa aberto antes de reabrir outro');
      const last = this.d.db.get<{ id: string }>(`SELECT id FROM cash_sessions WHERE terminal_code = ? ORDER BY opened_at DESC LIMIT 1`, [this.d.terminalCode]);
      if (last?.id !== s.id) throw conflict('INVALID_STATUS', 'Só o último caixa do terminal pode ser reaberto');
      this.d.db.run(`UPDATE cash_sessions SET status = 'open', closed_at = NULL, closed_by = NULL, reopen_count = reopen_count + 1 WHERE id = ?`, [s.id]);
      const m = this.movement(s.id, 'reopening', '0.00', op, { reason, authorizedBy: approver?.id });
      this.enqueue(m.id, { kind: 'reopening', sessionId: s.id, reason, operatorId: op.id, authorizedBy: approver?.id ?? null, occurredAt: m.at });
      this.d.audit.record({ userId: op.id, action: 'REABERTURA_CAIXA', entity: 'cash_session', entityId: s.id, metadata: { reason, authorizedBy: approver?.id ?? null } });
      return this.current()!;
    });
  }

  sessions(limit = 30): CashSessionRow[] {
    return this.d.db.all<CashSessionRow>(`SELECT * FROM cash_sessions WHERE terminal_code = ? ORDER BY opened_at DESC LIMIT ?`, [this.d.terminalCode, limit]);
  }
}
