import { randomInt } from 'node:crypto';
import type { Clock } from '../clock.js';

/**
 * Provedor fiscal (seção 37): a camada que fala com a SEFAZ, direto ou via fornecedor
 * homologado. A implementação concreta deve ser validada com contador e fornecedor.
 */
export type AuthorizeResult =
  | { status: 'authorized'; protocol: string; authorizedAt: string; message?: string }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unavailable'; message: string };

export type CancelResult =
  | { status: 'registered'; protocol: string; message?: string }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unavailable'; message: string };

export type QueryResult =
  | { status: 'authorized'; protocol: string; authorizedAt: string }
  | { status: 'cancelled'; protocol: string }
  | { status: 'not_found' }
  | { status: 'unavailable'; message: string };

export interface FiscalProvider {
  readonly name: string;
  authorize(doc: { accessKey: string; xml: string; environment: 1 | 2 }): Promise<AuthorizeResult>;
  cancel(doc: { accessKey: string; protocol: string; reason: string; environment: 1 | 2 }): Promise<CancelResult>;
  query(accessKey: string): Promise<QueryResult>;
  /** Ping leve para a tela de status */
  available(): Promise<boolean>;
}

/**
 * SEFAZ de homologação simulada, determinística, para desenvolvimento e testes: autoriza;
 * rejeita NCM inexistente (778) e itens marcados; pode ficar indisponível (contingência).
 * Reenviar a mesma chave devolve o mesmo protocolo (como a duplicidade da SEFAZ).
 */
export class SimulatedSefaz implements FiscalProvider {
  readonly name = 'sefaz-simulada';
  online = true;
  readonly authorized = new Map<string, { protocol: string; authorizedAt: string; cancelled?: string }>();
  constructor(private readonly clock: Clock) {}

  async available() {
    return this.online;
  }

  async authorize(doc: { accessKey: string; xml: string; environment: 1 | 2 }): Promise<AuthorizeResult> {
    if (!this.online) return { status: 'unavailable', message: 'SEFAZ indisponível (simulação)' };
    const prior = this.authorized.get(doc.accessKey);
    if (prior) return { status: 'authorized', ...prior, message: 'Duplicidade: NFC-e já autorizada (204)' };
    if (doc.xml.includes('<NCM>99999999</NCM>')) return { status: 'rejected', code: '778', message: 'Rejeição 778: Informado NCM inexistente' };
    if (/<xProd>[^<]*REJEITAR[^<]*<\/xProd>/.test(doc.xml)) return { status: 'rejected', code: '999', message: 'Rejeição simulada para teste' };
    const rec = { protocol: `${doc.environment === 2 ? '2' : '1'}26${String(randomInt(1e11, 1e12 - 1))}`.slice(0, 15), authorizedAt: this.clock.now().toISOString() };
    this.authorized.set(doc.accessKey, rec);
    return { status: 'authorized', ...rec };
  }

  async cancel(doc: { accessKey: string; protocol: string; reason: string }): Promise<CancelResult> {
    if (!this.online) return { status: 'unavailable', message: 'SEFAZ indisponível (simulação)' };
    const a = this.authorized.get(doc.accessKey);
    if (!a) return { status: 'rejected', code: '217', message: 'Rejeição 217: NFC-e não consta na base da SEFAZ' };
    if (a.protocol !== doc.protocol) return { status: 'rejected', code: '222', message: 'Rejeição 222: protocolo de autorização difere do cadastrado' };
    if (a.cancelled) return { status: 'registered', protocol: a.cancelled, message: 'Evento já registrado' };
    a.cancelled = `${doc.protocol.slice(0, 3)}${String(randomInt(1e11, 1e12 - 1))}`.slice(0, 15);
    return { status: 'registered', protocol: a.cancelled };
  }

  async query(accessKey: string): Promise<QueryResult> {
    if (!this.online) return { status: 'unavailable', message: 'SEFAZ indisponível (simulação)' };
    const a = this.authorized.get(accessKey);
    if (!a) return { status: 'not_found' };
    return a.cancelled ? { status: 'cancelled', protocol: a.cancelled } : { status: 'authorized', protocol: a.protocol, authorizedAt: a.authorizedAt };
  }
}

/**
 * Fornecedor fiscal homologado por HTTP (emissor terceirizado, como no ERP — ADR-0006).
 * Contrato genérico: POST /nfce, POST /nfce/{chave}/cancelamento, GET /nfce/{chave}. Adaptar ao
 * fornecedor escolhido e validar em homologação nas UFs atendidas antes de produção.
 */
export class PartnerFiscalProvider implements FiscalProvider {
  readonly name = 'fornecedor-fiscal';
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any } | null> {
    try {
      const r = await this.fetchImpl(new URL(path, this.baseUrl), { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    } catch {
      return null;
    }
  }

  async available() {
    return (await this.req('GET', '/status'))?.status === 200;
  }

  async authorize(doc: { accessKey: string; xml: string; environment: 1 | 2 }): Promise<AuthorizeResult> {
    const r = await this.req('POST', '/nfce', { chave: doc.accessKey, xml: doc.xml, ambiente: doc.environment });
    if (!r || r.status >= 500) return { status: 'unavailable', message: 'Fornecedor fiscal/SEFAZ indisponível' };
    if (r.body.status === 'autorizada') return { status: 'authorized', protocol: r.body.protocolo, authorizedAt: r.body.dataAutorizacao };
    return { status: 'rejected', code: String(r.body.codigo ?? r.status), message: r.body.mensagem ?? 'Rejeitada' };
  }

  async cancel(doc: { accessKey: string; protocol: string; reason: string; environment: 1 | 2 }): Promise<CancelResult> {
    const r = await this.req('POST', `/nfce/${doc.accessKey}/cancelamento`, { protocolo: doc.protocol, justificativa: doc.reason, ambiente: doc.environment });
    if (!r || r.status >= 500) return { status: 'unavailable', message: 'Fornecedor fiscal/SEFAZ indisponível' };
    if (r.body.status === 'registrado') return { status: 'registered', protocol: r.body.protocolo };
    return { status: 'rejected', code: String(r.body.codigo ?? r.status), message: r.body.mensagem ?? 'Cancelamento rejeitado' };
  }

  async query(accessKey: string): Promise<QueryResult> {
    const r = await this.req('GET', `/nfce/${accessKey}`);
    if (!r || r.status >= 500) return { status: 'unavailable', message: 'Fornecedor fiscal indisponível' };
    if (r.status === 404) return { status: 'not_found' };
    if (r.body.status === 'cancelada') return { status: 'cancelled', protocol: r.body.protocoloCancelamento };
    return r.body.status === 'autorizada' ? { status: 'authorized', protocol: r.body.protocolo, authorizedAt: r.body.dataAutorizacao } : { status: 'not_found' };
  }
}
