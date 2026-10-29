import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { D } from '@vortex/money';
import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import type { SyncQueue } from '../sync/queue.js';
import type { FiscalService } from '../fiscal/service.js';
import type { FiscalProvider } from '../fiscal/providers.js';
import type { PrinterService } from '../printer/service.js';
import type { Scale } from '../hardware/devices.js';
import type { PaymentProvider } from '../payment/providers.js';
import type { ErpClient } from '../erp/client.js';
import type { PaymentMethod } from '../domain/payments.js';
import { storeDay } from '../domain/ids.js';
import { PdvError } from '../domain/errors.js';
import { P, can, type Operator } from '../security/permissions.js';
import type { CashService } from './cash.js';

export interface SystemDeps {
  db: LocalDb;
  clock: Clock;
  queue: SyncQueue;
  fiscal: FiscalService;
  fiscalProvider: FiscalProvider;
  printer: PrinterService;
  scale: Scale;
  providers: Record<PaymentMethod, PaymentProvider>;
  cash: CashService;
  erp: ErpClient;
  terminalCode: string;
  appVersion: string;
  dbPath: string;
}

/**
 * Atualização controlada (seção 51): o instalador pede a atualização (pela tela do gerente ou
 * por `cli/update-gate`); ela só é liberada sem venda, pagamento ou NFC-e em andamento, e a
 * partir daí nenhuma venda nova começa. O agente, ao subir, encerra o pedido.
 */
export interface UpdateState { requested: string | null; safe: boolean; reason: string | null }

export function requestUpdate(db: LocalDb, clock: Clock, version: string): UpdateState {
  db.setMeta('update.requested', { version, at: clock.now().toISOString() });
  return updateState(db);
}

export function updateState(db: LocalDb): UpdateState {
  const req = db.meta<{ version: string }>('update.requested');
  const busy = db.get<{ number: string }>(
    `SELECT number FROM sales WHERE status IN ('open', 'payment') AND EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = sales.id AND i.status = 'active')`);
  const pendingPay = db.get(`SELECT 1 FROM payments WHERE status = 'pending'`);
  const pendingFiscal = db.get(`SELECT 1 FROM fiscal_documents WHERE status = 'pending'`);
  const reason = busy ? `Venda ${busy.number} em andamento` : pendingPay ? 'Pagamento aguardando confirmação' : pendingFiscal ? 'NFC-e aguardando retorno' : null;
  return { requested: req?.version ?? null, safe: !reason, reason };
}

/** Na subida do agente: o pedido termina (versão nova no ar, ou atualização desistida). */
export function finishUpdate(db: LocalDb, runningVersion: string): { requested: string; applied: boolean } | null {
  const req = db.meta<{ version: string }>('update.requested');
  if (!req) return null;
  db.run(`DELETE FROM meta WHERE key = 'update.requested'`);
  return { requested: req.version, applied: req.version === runningVersion };
}

/**
 * Status (seção 42), painel operacional (47), monitoramento (50), atualização controlada (51)
 * e backup do banco local (52).
 */
export class SystemService {
  constructor(private readonly d: SystemDeps) {}

  private todayRange(): { from: string; to: string } {
    const day = storeDay(this.d.clock.now());
    const start = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T03:00:00.000Z`);
    return { from: start.toISOString(), to: new Date(start.getTime() + 86_400_000).toISOString() };
  }

  async status() {
    const counts = this.d.queue.counts();
    const fiscalCounts = this.d.fiscal.counts();
    const [fiscalOnline, printer, scale] = await Promise.all([
      this.d.fiscalProvider.available().catch(() => false), this.d.printer.status().catch(() => 'error' as const), this.d.scale.status().catch(() => 'offline' as const)]);
    let localDb: 'ok' | 'error' = 'ok';
    try {
      localDb = this.d.db.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check === 'ok' ? 'ok' : 'error';
    } catch {
      localDb = 'error';
    }
    const online = this.d.db.meta<boolean>('sync.online') ?? false;
    const services = {
      erp: { status: online ? 'online' : 'offline', lastPullAt: this.d.db.meta<string>('sync.lastPullAt'), lastContactAt: this.d.db.meta<string>('sync.lastContactAt'), queue: counts },
      fiscal: { status: fiscalOnline ? 'online' : (fiscalCounts.contingency ? 'contingency' : 'offline'), provider: this.d.fiscalProvider.name, contingency: fiscalCounts.contingency ?? 0,
        rejected: fiscalCounts.rejected ?? 0, pending: fiscalCounts.pending ?? 0 },
      payment: { status: 'online', pix: this.d.providers.pix.name, tef: this.d.providers.debit.name },
      printer: { status: printer },
      localDb: { status: localDb },
      scale: { status: scale },
    };
    const firstFailure = counts.FAILED > 0 ? this.d.db.get<{ type: string; last_error: string | null }>(`SELECT type, last_error FROM sync_queue WHERE status = 'FAILED' AND archived_at IS NULL ORDER BY created_at LIMIT 1`) : undefined;
    const alerts = [
      !online && 'ERP offline: vendas ficam na fila e sincronizam ao reconectar',
      !fiscalOnline && 'Serviço fiscal indisponível: NFC-e em contingência offline',
      (fiscalCounts.rejected ?? 0) > 0 && `${fiscalCounts.rejected} NFC-e rejeitada(s): reprocessar`,
      counts.FAILED > 0 && `${counts.FAILED} envio(s) não aceito(s) pelo ERP${firstFailure?.last_error ? `: ${firstFailure.last_error}` : ''} (Menu → Status)`,
      printer !== 'ok' && `Impressora: ${({ paper_low: 'pouco papel', paper_out: 'sem papel', offline: 'desconectada', error: 'erro' } as Record<string, string>)[printer] ?? printer}`,
      localDb !== 'ok' && 'Banco local com erro: acione o suporte',
    ].filter(Boolean) as string[];
    return { terminal: this.d.terminalCode, version: this.d.appVersion, services, alerts, update: this.updateState() };
  }

  /** Para o heartbeat (monitoramento no ERP). */
  async health(): Promise<Record<string, unknown>> {
    const st = await this.status();
    const { from } = this.todayRange();
    const avg = this.d.db.all<{ created_at: string; completed_at: string }>(`SELECT created_at, completed_at FROM sales WHERE status = 'completed' AND completed_at >= ?`, [from]);
    const avgSaleSeconds = avg.length ? avg.reduce((a, s) => a + (new Date(s.completed_at).getTime() - new Date(s.created_at).getTime()) / 1000, 0) / avg.length : 0;
    const errors = this.d.db.all<{ action: string; metadata: string; timestamp: string }>(
      `SELECT action, metadata, timestamp FROM events WHERE action IN ('ERRO_FISCAL', 'ERRO_PAGAMENTO') ORDER BY timestamp DESC LIMIT 5`);
    const payFail = Number(this.d.db.get<{ n: number }>(`SELECT count(*) AS n FROM events WHERE action = 'ERRO_PAGAMENTO' AND timestamp >= ?`, [from])!.n);
    const session = this.d.cash.current();
    return {
      erp: st.services.erp.status, fiscal: st.services.fiscal.status, payment: 'online', printer: st.services.printer.status, localDb: st.services.localDb.status,
      fiscalFailures: st.services.fiscal.rejected, paymentFailures: payFail, syncFailures: st.services.erp.queue.FAILED, avgSaleSeconds: Math.round(avgSaleSeconds * 10) / 10,
      lastErrors: errors.map((e) => `${e.timestamp} ${e.action}: ${String((JSON.parse(e.metadata) as { message?: string }).message ?? '').slice(0, 200)}`),
      openSession: session ? { sessionId: session.id, operatorId: session.operator_id, openedAt: session.opened_at } : null,
    };
  }

  /** Painel operacional (seção 47): do terminal sempre; da loja quando há ERP e permissão. */
  async dashboard(op: Operator) {
    if (!can(op, P.reports)) throw new PdvError('FORBIDDEN', 'Sem permissão para o painel operacional', 403, { permission: P.reports });
    const { from, to } = this.todayRange();
    const sales = this.d.db.all<{ total: string; operator_id: string }>(`SELECT total, operator_id FROM sales WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?`, [from, to]);
    const total = sales.reduce((a, s) => a.plus(s.total), D(0));
    const operators = this.d.db.all<{ name: string; n: number }>(
      `SELECT o.name, count(*) AS n FROM sales s JOIN operators o ON o.id = s.operator_id WHERE s.status = 'completed' AND s.completed_at >= ? GROUP BY o.name ORDER BY n DESC`, [from]);
    const session = this.d.cash.current();
    const terminal = {
      salesCount: sales.length, salesTotal: total.toFixed(2), averageTicket: sales.length ? total.dividedBy(sales.length).toFixed(2) : '0.00',
      openCash: session ? [{ terminal: this.d.terminalCode, sessionId: session.id, openedAt: session.opened_at }] : [],
      operators, pendingSync: this.d.queue.counts().pendingSales,
    };
    let store: Record<string, unknown> | null = null;
    if (this.d.db.meta<boolean>('sync.online')) {
      store = await this.d.erp.dashboard(storeDay(this.d.clock.now()).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')).catch(() => null);
    }
    return { terminal, store };
  }

  // ---------------------------------------------------------------- atualização controlada (seção 51)
  requestUpdate(version: string) {
    return requestUpdate(this.d.db, this.d.clock, version);
  }

  updateState() {
    return updateState(this.d.db);
  }

  /** Com atualização pedida e segura, nenhuma venda nova começa até reiniciar. */
  assertNoUpdateLock(): void {
    const st = this.updateState();
    if (st.requested && st.safe) throw new PdvError('UPDATING', `Atualização para a versão ${st.requested} em andamento: aguarde o reinício do PDV`, 503);
  }

  // ---------------------------------------------------------------- backup (seção 52)
  backup(keep = 48): { file: string } {
    if (this.d.dbPath === ':memory:') throw new PdvError('NO_BACKUP', 'Banco em memória (teste) não tem backup', 422);
    const dir = join(dirname(this.d.dbPath), 'backup');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `pdv-${this.d.clock.now().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    this.d.db.raw.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, old));
    return { file };
  }

  backups(): { file: string; size: number }[] {
    if (this.d.dbPath === ':memory:') return [];
    const dir = join(dirname(this.d.dbPath), 'backup');
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.sqlite')).sort().reverse().map((f) => ({ file: f, size: statSync(join(dir, f)).size }));
    } catch {
      return [];
    }
  }
}
