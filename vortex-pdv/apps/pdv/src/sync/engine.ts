import { D } from '@vortex/money';
import type { PdvSaleInput, PdvSettings } from '@vortex/contracts';
import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import type { Audit } from '../audit/audit.js';
import type { Sealer } from '../security/crypto.js';
import { hmacSha256, safeEqual } from '../security/crypto.js';
import { ErpRejected, ErpUnavailable, type AuditBatchItem, type ErpClient } from '../erp/client.js';
import type { FiscalService } from '../fiscal/service.js';
import type { CustomerService } from '../application/customers.js';
import type { SaleService } from '../application/sales.js';
import { applySyncPayload } from './catalog.js';
import type { QueueItem, SyncQueue } from './queue.js';

/** Eventos do ERP (seção 34) → nomes da especificação; todos levam a uma carga delta. */
export const WEBHOOK_EVENTS: Record<string, string> = {
  'produto.alterado': 'product.updated', 'preco.alterado': 'price.updated', 'estoque.alterado': 'stock.updated', 'cliente.criado': 'customer.updated',
  'cliente.alterado': 'customer.updated', 'cliente.bloqueado': 'customer.updated', 'promocao.alterada': 'promotion.updated', 'pdv.configuracao_alterada': 'configuration.updated',
  'pdv.operador_alterado': 'user.updated',
};

export interface SyncDeps {
  db: LocalDb;
  clock: Clock;
  queue: SyncQueue;
  erp: ErpClient;
  audit: Audit;
  sealer: Sealer;
  fiscal: FiscalService;
  sales: SaleService;
  customers: CustomerService;
  settings: () => PdvSettings;
  terminalCode: string;
  establishmentId: () => string;
  appVersion: string;
  webhookSecret: string;
  health: () => Promise<Record<string, unknown>>;
  /** Carga delta (preços, produtos, estoque) sem webhook: o ERP na nuvem não alcança o agente na loja */
  pullIntervalMs?: number;
}

export interface SyncResult {
  online: boolean;
  pulled: boolean;
  pushed: number;
  failed: number;
  errors: string[];
}

/**
 * Sync Engine (seções 29 a 35): baixa a carga do ERP (delta), envia a fila na ordem de
 * dependência, transmite NFC-e de contingência, envia a auditoria e o heartbeat. ERP fora do
 * ar coloca o terminal em modo offline (vendas continuam e ficam na fila); recusa por regra
 * vai para FAILED com o motivo, sem bloquear o resto da fila.
 */
export class SyncEngine {
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private pullRequested = true;

  constructor(private readonly d: SyncDeps) {}

  get online(): boolean {
    return this.d.db.meta<boolean>('sync.online') ?? false;
  }

  private setOnline(online: boolean) {
    const was = this.online;
    this.d.db.setMeta('sync.online', online);
    if (online) this.d.db.setMeta('sync.lastContactAt', this.d.clock.now().toISOString());
    if (was !== online) this.d.audit.record({ userId: null, action: 'SYNC', entity: 'terminal', entityId: this.d.terminalCode, metadata: { online } });
  }

  /** Carga do ERP; sem cursor é carga completa (primeira vez ou "Recarregar tudo"). */
  async pull(full = false): Promise<Record<string, number>> {
    // Loja/ERP do .env diferente da última carga (ERP trocado ou recriado, terminal movido de loja):
    // o banco local tem catálogo, clientes e fila da loja anterior; recarrega tudo e tira da fila o
    // que não pode ir para este ERP (produtos de lá não existem aqui).
    const storeId = this.d.establishmentId();
    const bound = this.d.db.meta<string>('erp.storeId') ?? this.d.db.meta<{ id?: string }>('establishment')?.id ?? null;
    const rebind = Boolean(bound && storeId && bound !== storeId);
    const cursor = full || rebind ? null : this.d.db.meta<string>('sync.cursor');
    const payload = await this.d.erp.sync(cursor);
    const r = applySyncPayload(this.d.db, this.d.sealer, payload, this.d.clock.now().toISOString(), { full: cursor === null, rebind });
    if (storeId) this.d.db.setMeta('erp.storeId', storeId);
    if (rebind) {
      const archived = this.d.queue.archiveUnsent(`feito quando o terminal estava ligado a outra loja/ERP (${bound}); não pode ser enviado ao ERP atual`);
      for (const i of archived) if (i.type === 'sale') this.d.db.run(`UPDATE sales SET sync_status = 'failed' WHERE id = ?`, [i.entity_id]);
      this.d.audit.record({ userId: null, action: 'SYNC', entity: 'terminal', entityId: this.d.terminalCode,
        metadata: { kind: 'troca_de_loja', from: bound, to: storeId, archived: archived.length, removedProducts: r.removedProducts, removedCustomers: r.removedCustomers } });
    }
    this.pullRequested = false;
    return { ...r, rebind: rebind ? 1 : 0 };
  }

  /** Payload da venda montado no envio: leva a situação fiscal atual (contingência ou autorizada). */
  salePayload(saleId: string): PdvSaleInput {
    const s = this.d.sales.row(saleId);
    const doc = this.d.fiscal.get(s.id);
    if (!doc || (doc.status !== 'authorized' && doc.status !== 'contingency' && doc.status !== 'cancelled')) throw new Error('Venda sem NFC-e autorizada ou em contingência');
    const customer = s.customer ? JSON.parse(s.customer) as { id: string; name: string } : null;
    const local = customer ? this.d.customers.get(customer.id) : null;
    const op = this.d.db.get<{ name: string }>(`SELECT name FROM operators WHERE id = ?`, [s.operator_id]);
    return {
      establishmentId: this.d.establishmentId(), pdvId: this.d.terminalCode, saleId: s.number, saleUuid: s.id, sessionId: s.session_id, occurredAt: s.completed_at ?? s.created_at,
      operator: op?.name ?? null, operatorId: s.operator_id, cashAccountId: this.d.settings().cash.cashAccountId,
      customer: customer ? { partyId: local && !local.pending ? local.id : null, taxId: this.d.customers.taxIdOf(customer.id), name: customer.name } : null,
      items: this.d.sales.items(s.id, true).map((i) => ({ productId: i.product_id, quantity: i.quantity, unitPrice: i.unit_price, discount: D(i.discount).toFixed(2) })),
      payments: this.d.sales.payments(s.id).filter((p) => p.status === 'approved' || p.status === 'refunded').map((p) => ({
        methodCode: p.method_code, amount: D(p.amount).plus(p.change).toFixed(2), change: D(p.change).toFixed(2), transactionId: p.transaction_id,
        card: p.method === 'cash' || p.method === 'pix' ? null : { nsu: p.nsu ?? undefined, authorization: p.authorization ?? undefined, brand: p.brand ?? undefined, installments: p.installments },
      })),
      cancelledItems: this.d.sales.items(s.id).filter((i) => i.status === 'cancelled').map((i) => ({
        productId: i.product_id, sku: i.sku, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, reason: i.cancel_reason ?? 'Sem motivo',
        operatorId: i.cancelled_by, authorizedBy: i.cancel_authorized_by, at: i.cancelled_at, partial: i.cancelled_from_seq !== null,
      })),
      nfce: doc.status === 'contingency' || (doc.status === 'cancelled' && !doc.protocol)
        ? { accessKey: doc.access_key, status: 'contingencia', xml: doc.xml }
        : { accessKey: doc.access_key, status: 'autorizada', protocol: doc.protocol, authorizedAt: doc.authorized_at, xml: doc.xml },
    };
  }

  private async send(item: QueueItem): Promise<void> {
    const payload = JSON.parse(item.payload) as Record<string, any>;
    switch (item.type) {
      case 'customer': {
        const taxId = this.d.sealer.open(payload.taxId);
        let erpId: string;
        try {
          const e = this.d.db.meta<Record<string, string | null>>('establishment');
          const address = e?.zip && e.city_ibge ? { zip: e.zip, street: e.street, number: e.number, complement: e.complement ?? null, district: e.district, cityIbge: e.city_ibge, cityName: e.city_name, uf: e.uf } : null;
          erpId = (await this.d.erp.createCustomer({ ...payload, taxId, address } as never, `pdv-customer-${item.entity_id}`)).id;
        } catch (e) {
          // Já cadastrado no ERP (por outro terminal ou no backoffice): usa o existente
          if (!(e instanceof ErpRejected) || e.status !== 409) throw e;
          const found = (await this.d.erp.searchCustomers(taxId)).find((c) => c.tax_id === taxId);
          if (!found) throw e;
          erpId = found.id;
        }
        this.d.customers.confirmed(item.entity_id, erpId);
        return;
      }
      case 'cash_movement':
        await this.d.erp.postCashMovement(payload as never);
        return;
      case 'sale': {
        const body = this.salePayload(item.entity_id);
        const s = this.d.sales.row(item.entity_id);
        await this.d.erp.postSale(body, `pdv-sale-${s.idempotency_key}`);
        this.d.db.run(`UPDATE sales SET sync_status = 'synced', synced_at = ? WHERE id = ?`, [this.d.clock.now().toISOString(), s.id]);
        return;
      }
      case 'nfce_authorization': {
        const doc = this.d.fiscal.get(item.entity_id)!;
        const s = this.d.sales.row(item.entity_id);
        await this.d.erp.authorizeContingency({ pdvId: this.d.terminalCode, saleId: s.number, protocol: doc.protocol!, authorizedAt: doc.authorized_at! });
        return;
      }
      case 'sale_cancel':
        await this.d.erp.cancelSale({ establishmentId: this.d.establishmentId(), pdvId: this.d.terminalCode, ...payload } as never);
        return;
      case 'return':
        await this.d.erp.postReturn(payload as never);
        return;
    }
  }

  /** Envia a fila; para no primeiro sinal de ERP fora do ar (o resto espera a reconexão). */
  async push(): Promise<{ pushed: number; failed: number; errors: string[]; offline: boolean }> {
    let pushed = 0;
    let failed = 0;
    const errors: string[] = [];
    for (;;) {
      const batch = this.d.queue.claim(20);
      if (!batch.length) break;
      for (const item of batch) {
        try {
          await this.send(item);
          this.d.queue.markSynced(item.id);
          pushed++;
        } catch (e) {
          const retryable = !(e instanceof ErpRejected);
          this.d.queue.markFailed(item.id, (e as Error).message, retryable);
          if (item.type === 'sale') this.d.db.run(`UPDATE sales SET sync_status = 'failed' WHERE id = ?`, [item.entity_id]);
          if (e instanceof ErpUnavailable) {
            // Devolve o restante do lote para a fila e encerra a rodada
            this.d.queue.recoverProcessing();
            return { pushed, failed, errors: [...errors, e.message], offline: true };
          }
          failed++;
          errors.push(`${item.type} ${item.entity_id}: ${(e as Error).message}`);
        }
      }
    }
    if (pushed || failed) this.d.audit.record({ userId: null, action: 'SYNC', entity: 'sync_queue', metadata: { pushed, failed, errors: errors.slice(0, 5) } });
    return { pushed, failed, errors, offline: false };
  }

  /** NFC-e de contingência autorizadas: avisa o ERP das vendas já enviadas como contingência. */
  async transmitFiscal(): Promise<void> {
    const r = await this.d.fiscal.transmitContingency();
    for (const saleId of r.authorized) {
      this.d.db.run(`UPDATE sales SET fiscal_status = 'authorized' WHERE id = ?`, [saleId]);
      const sale = this.d.sales.row(saleId);
      if (sale.sync_status === 'synced') this.d.queue.enqueue('nfce_authorization', 'sale', saleId, { saleId });
    }
  }

  /** Auditoria (eventos operacionais) enviada ao ERP em lotes. */
  async pushEvents(): Promise<number> {
    const cursor = this.d.db.meta<number>('events.cursor') ?? 0;
    const rows = this.d.db.all<{ rowid: number } & Record<string, string>>(`SELECT rowid, * FROM events WHERE rowid > ? ORDER BY rowid LIMIT 500`, [cursor]);
    if (!rows.length) return 0;
    const batch: AuditBatchItem[] = rows.map((r) => ({ id: r.id!, userId: r.user_id ?? null, action: r.action!, entity: r.entity ?? null, entityId: r.entity_id ?? null,
      metadata: JSON.parse(r.metadata ?? '{}'), timestamp: r.timestamp! }));
    await this.d.erp.postEvents(batch);
    this.d.db.setMeta('events.cursor', Number(rows.at(-1)!.rowid));
    return rows.length;
  }

  async heartbeat(): Promise<void> {
    const counts = this.d.queue.counts();
    await this.d.erp.heartbeat({ appVersion: this.d.appVersion, lastSyncAt: this.d.db.meta<string>('sync.lastPullAt'), pendingSales: counts.pendingSales, health: await this.d.health() as never });
  }

  /** Uma rodada completa; chamada pelo agendador, ao reconectar e pelo botão "Sincronizar". */
  async runOnce(opts: { full?: boolean; pull?: boolean } = {}): Promise<SyncResult> {
    if (this.running) return { online: this.online, pulled: false, pushed: 0, failed: 0, errors: ['Sincronização já em andamento'] };
    this.running = true;
    const wasOnline = this.online;
    const errors: string[] = [];
    let pulled = false;
    let pushed = 0;
    let failed = 0;
    try {
      // Envia antes de baixar: o saldo de estoque do ERP já reflete as vendas deste terminal
      const p = await this.push();
      pushed = p.pushed;
      failed = p.failed;
      errors.push(...p.errors);
      if (p.offline) throw new ErpUnavailable(p.errors.at(-1) ?? 'ERP indisponível');
      const lastPull = this.d.db.meta<string>('sync.lastPullAt');
      if (opts.full || opts.pull || this.pullRequested || !lastPull || this.d.clock.now().getTime() - new Date(lastPull).getTime() > (this.d.pullIntervalMs ?? 60_000)) {
        await this.pull(Boolean(opts.full));
        pulled = true;
      }
      await this.transmitFiscal().catch((e: Error) => errors.push(`Fiscal: ${e.message}`));
      // Conexão restabelecida: o que falhou por indisponibilidade vai agora, sem esperar a retentativa
      if (!wasOnline) this.d.queue.retryNow({ onlyUnavailable: true });
      const again = await this.push();
      pushed += again.pushed;
      failed += again.failed;
      await this.pushEvents();
      await this.heartbeat();
      this.setOnline(true);
    } catch (e) {
      if (e instanceof ErpUnavailable) this.setOnline(false);
      errors.push((e as Error).message);
    } finally {
      this.running = false;
    }
    return { online: this.online, pulled, pushed, failed, errors };
  }

  start(intervalMs: number): void {
    this.d.queue.recoverProcessing();
    const tick = () => void this.runOnce().catch(() => undefined);
    tick();
    this.timers.push(setInterval(tick, intervalMs));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /**
   * Webhook do ERP (seção 34): assinatura "t=<unix>,v1=<hmac>" de "<t>.<corpo>" com o segredo
   * do webhook; janela de 5 minutos contra repetição. Qualquer evento conhecido pede uma carga delta.
   */
  async handleWebhook(signature: string | undefined, rawBody: string): Promise<{ accepted: boolean; event?: string }> {
    if (!this.d.webhookSecret) return { accepted: false };
    const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(signature ?? '');
    if (!m) return { accepted: false };
    const age = Math.abs(this.d.clock.now().getTime() / 1000 - Number(m[1]));
    if (age > 300 || !safeEqual(hmacSha256(this.d.webhookSecret, `${m[1]}.${rawBody}`), m[2]!)) return { accepted: false };
    const body = JSON.parse(rawBody) as { type: string };
    const event = WEBHOOK_EVENTS[body.type];
    if (event) {
      this.pullRequested = true;
      void this.runOnce().catch(() => undefined);
    }
    return { accepted: true, event: event ?? body.type };
  }
}
