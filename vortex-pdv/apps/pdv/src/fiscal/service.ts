import { randomInt } from 'node:crypto';
import type { PdvSettings } from '@vortex/contracts';
import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import type { Audit } from '../audit/audit.js';
import { PdvError, conflict } from '../domain/errors.js';
import { approximateTaxes, computeTaxes, type FiscalContext } from './tax.js';
import { buildNfce, type Issuer, type NfcePayment } from './nfce.js';
import type { FiscalProvider } from './providers.js';

/**
 * FiscalService (seção 37), isolado do resto do PDV: emissão da NFC-e, contingência offline
 * (seção 38), consulta, cancelamento, rejeição e reprocessamento. Nunca emite duas vezes a
 * mesma venda (seção 44): o documento é gravado antes do envio e, se o terminal cair no meio,
 * a SEFAZ é consultada pela chave antes de qualquer reenvio.
 */
export interface SaleForFiscal {
  saleId: string;
  saleNumber: string;
  issuedAt: Date;
  customer: { taxId: string; name: string | null } | null;
  items: { productId: string; sku: string; gtin: string | null; description: string; ncm: string; unit: string; quantity: string; unitPrice: string; gross: string; discount: string }[];
  payments: { methodCode: string; amount: string; change: string; brand?: string | null; authorization?: string | null; integrated: boolean; card: boolean }[];
}

export interface FiscalDocRow {
  sale_id: string;
  series: number;
  number: number;
  access_key: string;
  emission_type: number;
  status: 'pending' | 'authorized' | 'contingency' | 'rejected' | 'cancelled';
  protocol: string | null;
  authorized_at: string | null;
  xml: string;
  qr_url: string;
  taxes: string | null;
  rejection_code: string | null;
  rejection_message: string | null;
  attempts: number;
  cancel_protocol: string | null;
  cancelled_at: string | null;
  issued_at: string;
  total: string;
  original_key: string | null;
  original_xml: string | null;
}

export interface FiscalDeps {
  db: LocalDb;
  provider: FiscalProvider;
  clock: Clock;
  audit: Audit;
  environment: 1 | 2;
  csc: { id: string; token: string };
  terminalCode: string;
  settings: () => PdvSettings;
  issuer: () => Issuer | null;
  context: () => FiscalContext | null;
  tPag: (methodCode: string) => string;
  origin: (productId: string) => number;
  cest: (productId: string) => string | null;
}

export class FiscalService {
  constructor(private readonly d: FiscalDeps) {}

  get(saleId: string): FiscalDocRow | undefined {
    return this.d.db.get<FiscalDocRow>(`SELECT * FROM fiscal_documents WHERE sale_id = ?`, [saleId]);
  }

  /** Série da NFC-e por terminal: cada caixa numera a sua série, sem colisão entre terminais. */
  get series(): number {
    return Number(this.d.terminalCode);
  }

  private build(sale: SaleForFiscal, number: number, numericCode: string, emission: { type: 1 } | { type: 9; at: Date; reason: string }) {
    const issuer = this.d.issuer();
    if (!issuer) throw new PdvError('FISCAL_CONFIG', 'Dados do emitente ausentes: sincronize com o ERP', 422);
    const date = new Date(sale.issuedAt.getTime() - 180 * 60_000).toISOString().slice(0, 10);
    const taxes = computeTaxes(this.d.context(), sale.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount })), date);
    const approx = approximateTaxes(taxes);
    const payments: NfcePayment[] = sale.payments.map((p) => ({ tPag: this.d.tPag(p.methodCode), amount: p.amount, change: p.change,
      card: p.card ? { brand: p.brand ?? null, authorization: p.authorization ?? null, integrated: p.integrated } : null }));
    const built = buildNfce({
      issuer, series: this.series, number, issuedAt: sale.issuedAt, environment: this.d.environment, emission, numericCode,
      customer: sale.customer, taxes, approximateTaxes: approx, payments, csc: this.d.csc, additionalInfo: `Venda ${sale.saleNumber}`,
      items: sale.items.map((i) => ({ code: i.sku, gtin: i.gtin, description: i.description, ncm: i.ncm, cest: this.d.cest(i.productId), origin: this.d.origin(i.productId),
        unit: i.unit, quantity: i.quantity, unitPrice: i.unitPrice, gross: i.gross, discount: i.discount })),
    });
    return { built, approx, taxes };
  }

  /** Emite a NFC-e da venda (idempotente). */
  async emit(sale: SaleForFiscal, userId: string): Promise<FiscalDocRow> {
    const existing = this.get(sale.saleId);
    if (existing && ['authorized', 'contingency', 'cancelled'].includes(existing.status)) return existing;
    if (existing?.status === 'rejected') throw conflict('FISCAL_REJECTED', `NFC-e rejeitada (${existing.rejection_code}): ${existing.rejection_message}. Corrija e reprocesse.`);
    let doc = existing;
    if (!doc) {
      const number = this.d.db.next(`nfce:${this.d.environment}:${this.series}`);
      const numericCode = String(randomInt(10_000_000, 99_999_999));
      const { built, approx } = this.build(sale, number, numericCode, { type: 1 });
      const now = this.d.clock.now().toISOString();
      // Gravado antes do envio: se o terminal cair agora, a recuperação consulta esta chave
      this.d.db.run(
        `INSERT INTO fiscal_documents (sale_id, series, number, access_key, emission_type, status, xml, qr_url, taxes, issued_at, total, created_at, updated_at)
         VALUES (?,?,?,?,1,'pending',?,?,?,?,?,?,?)`,
        [sale.saleId, this.series, number, built.accessKey, built.xml, built.qrUrl, JSON.stringify(approx), sale.issuedAt.toISOString(), built.total, now, now]);
      doc = this.get(sale.saleId)!;
    } else {
      // Envio interrompido: a SEFAZ pode ter autorizado; consulta antes de reenviar
      const q = await this.d.provider.query(doc.access_key);
      if (q.status === 'authorized') return this.markAuthorized(doc.sale_id, q.protocol, q.authorizedAt);
    }
    return this.send(doc, sale, userId);
  }

  private async send(doc: FiscalDocRow, sale: SaleForFiscal, userId: string): Promise<FiscalDocRow> {
    this.d.db.run(`UPDATE fiscal_documents SET attempts = attempts + 1, updated_at = ? WHERE sale_id = ?`, [this.d.clock.now().toISOString(), doc.sale_id]);
    const r = await this.d.provider.authorize({ accessKey: doc.access_key, xml: doc.xml, environment: this.d.environment });
    if (r.status === 'authorized') return this.markAuthorized(doc.sale_id, r.protocol, r.authorizedAt);
    if (r.status === 'rejected') {
      this.d.db.run(`UPDATE fiscal_documents SET status = 'rejected', rejection_code = ?, rejection_message = ?, updated_at = ? WHERE sale_id = ?`,
        [r.code, r.message, this.d.clock.now().toISOString(), doc.sale_id]);
      this.d.audit.record({ userId, action: 'ERRO_FISCAL', entity: 'sale', entityId: doc.sale_id, metadata: { code: r.code, message: r.message, accessKey: doc.access_key } });
      return this.get(doc.sale_id)!;
    }
    // SEFAZ/fornecedor fora do ar: contingência offline (seção 38), se o ERP permitir
    this.d.audit.record({ userId, action: 'ERRO_FISCAL', entity: 'sale', entityId: doc.sale_id, metadata: { message: r.message, contingency: this.d.settings().fiscal.contingencyAllowed } });
    if (!this.d.settings().fiscal.contingencyAllowed) {
      throw new PdvError('FISCAL_UNAVAILABLE', `Serviço fiscal indisponível e contingência não permitida: ${r.message}`, 503);
    }
    const at = this.d.clock.now();
    const numericCode = doc.access_key.slice(35, 43);
    const { built } = this.build(sale, doc.number, numericCode, { type: 9, at, reason: `SEFAZ indisponível: ${r.message}`.padEnd(15, '.') });
    this.d.db.run(
      `UPDATE fiscal_documents SET status = 'contingency', emission_type = 9, original_key = access_key, original_xml = xml, access_key = ?, xml = ?, qr_url = ?, updated_at = ? WHERE sale_id = ?`,
      [built.accessKey, built.xml, built.qrUrl, at.toISOString(), doc.sale_id]);
    return this.get(doc.sale_id)!;
  }

  private markAuthorized(saleId: string, protocol: string, authorizedAt: string): FiscalDocRow {
    this.d.db.run(`UPDATE fiscal_documents SET status = 'authorized', protocol = ?, authorized_at = ?, rejection_code = NULL, rejection_message = NULL, updated_at = ? WHERE sale_id = ?`,
      [protocol, authorizedAt, this.d.clock.now().toISOString(), saleId]);
    return this.get(saleId)!;
  }

  /** Reprocessa NFC-e rejeitada depois de corrigir o cadastro (mesmo número; nova chave se mudou algo). */
  async reprocess(sale: SaleForFiscal, userId: string): Promise<FiscalDocRow> {
    const doc = this.get(sale.saleId);
    if (!doc) return this.emit(sale, userId);
    if (doc.status !== 'rejected' && doc.status !== 'pending') return doc;
    const { built, approx } = this.build(sale, doc.number, doc.access_key.slice(35, 43), { type: 1 });
    this.d.db.run(`UPDATE fiscal_documents SET status = 'pending', access_key = ?, xml = ?, qr_url = ?, taxes = ?, total = ?, updated_at = ? WHERE sale_id = ?`,
      [built.accessKey, built.xml, built.qrUrl, JSON.stringify(approx), built.total, this.d.clock.now().toISOString(), sale.saleId]);
    return this.send(this.get(sale.saleId)!, sale, userId);
  }

  /**
   * Transmite NFC-e emitidas em contingência quando a SEFAZ volta. Se a NFC-e normal enviada
   * sem resposta tiver sido autorizada, ela vale (e a de contingência é descartada).
   */
  async transmitContingency(): Promise<{ authorized: string[]; pending: number }> {
    const docs = this.d.db.all<FiscalDocRow>(`SELECT * FROM fiscal_documents WHERE status = 'contingency' ORDER BY number`);
    const authorized: string[] = [];
    for (const doc of docs) {
      if (doc.original_key) {
        const q = await this.d.provider.query(doc.original_key);
        if (q.status === 'unavailable') break;
        if (q.status === 'authorized') {
          this.d.db.run(`UPDATE fiscal_documents SET access_key = original_key, xml = original_xml, emission_type = 1, original_key = NULL, original_xml = NULL WHERE sale_id = ?`, [doc.sale_id]);
          this.markAuthorized(doc.sale_id, q.protocol, q.authorizedAt);
          authorized.push(doc.sale_id);
          continue;
        }
      }
      const r = await this.d.provider.authorize({ accessKey: doc.access_key, xml: doc.xml, environment: this.d.environment });
      if (r.status === 'unavailable') break;
      if (r.status === 'authorized') {
        this.markAuthorized(doc.sale_id, r.protocol, r.authorizedAt);
        authorized.push(doc.sale_id);
      } else {
        this.d.db.run(`UPDATE fiscal_documents SET rejection_code = ?, rejection_message = ?, attempts = attempts + 1, updated_at = ? WHERE sale_id = ?`,
          [r.code, r.message, this.d.clock.now().toISOString(), doc.sale_id]);
        this.d.audit.record({ userId: null, action: 'ERRO_FISCAL', entity: 'sale', entityId: doc.sale_id, metadata: { code: r.code, message: r.message, contingency: true } });
      }
    }
    const pending = Number(this.d.db.get<{ n: number }>(`SELECT count(*) AS n FROM fiscal_documents WHERE status = 'contingency'`)!.n);
    return { authorized, pending };
  }

  /** Cancelamento da NFC-e (prazo definido pelo ERP; depois dele, devolução). */
  async cancel(saleId: string, reason: string, userId: string): Promise<FiscalDocRow> {
    let doc = this.get(saleId);
    if (!doc) throw new PdvError('NOT_FOUND', 'Venda sem NFC-e', 404);
    if (doc.status === 'cancelled') return doc;
    if (doc.status === 'contingency') {
      await this.transmitContingency();
      doc = this.get(saleId)!;
      if (doc.status !== 'authorized') throw new PdvError('FISCAL_UNAVAILABLE', 'NFC-e em contingência ainda não autorizada: transmita antes de cancelar', 503);
    }
    if (doc.status !== 'authorized') throw conflict('INVALID_STATUS', `NFC-e ${doc.status === 'rejected' ? 'rejeitada' : 'pendente'} não precisa de cancelamento na SEFAZ`);
    const minutes = (this.d.clock.now().getTime() - new Date(doc.authorized_at ?? doc.issued_at).getTime()) / 60_000;
    if (minutes > this.d.settings().sale.cancelWindowMinutes) {
      throw new PdvError('CANCEL_WINDOW_EXPIRED', `Prazo de cancelamento da NFC-e (${this.d.settings().sale.cancelWindowMinutes} min) encerrado: faça uma devolução`, 422);
    }
    const r = await this.d.provider.cancel({ accessKey: doc.access_key, protocol: doc.protocol!, reason, environment: this.d.environment });
    if (r.status === 'unavailable') throw new PdvError('FISCAL_UNAVAILABLE', `Não foi possível cancelar agora: ${r.message}`, 503);
    if (r.status === 'rejected') {
      this.d.audit.record({ userId, action: 'ERRO_FISCAL', entity: 'sale', entityId: saleId, metadata: { code: r.code, message: r.message, event: 'cancelamento' } });
      throw new PdvError('FISCAL_REJECTED', `SEFAZ recusou o cancelamento (${r.code}): ${r.message}`, 422);
    }
    this.d.db.run(`UPDATE fiscal_documents SET status = 'cancelled', cancel_protocol = ?, cancelled_at = ?, updated_at = ? WHERE sale_id = ?`,
      [r.protocol, this.d.clock.now().toISOString(), this.d.clock.now().toISOString(), saleId]);
    return this.get(saleId)!;
  }

  async query(saleId: string) {
    const doc = this.get(saleId);
    if (!doc) throw new PdvError('NOT_FOUND', 'Venda sem NFC-e', 404);
    return { local: doc.status, sefaz: await this.d.provider.query(doc.access_key) };
  }

  counts() {
    const rows = this.d.db.all<{ status: string; n: number }>(`SELECT status, count(*) AS n FROM fiscal_documents GROUP BY status`);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
  }
}
