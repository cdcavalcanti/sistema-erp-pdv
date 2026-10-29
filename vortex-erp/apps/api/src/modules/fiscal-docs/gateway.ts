import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

/**
 * Interface interna FiscalGateway (seção 03): fase 1 via API de parceiro emissor,
 * fase 2 emissor próprio. O resto do ERP só conhece esta interface.
 */
export interface TransmitRequest {
  documentId: string;
  accessKey: string;
  model: '55' | '65';
  environment: 1 | 2;
  uf: string;
  issuerCnpj: string;
  emissionType: number;
  xml: string;
  /** Estrutura de dados da nota (para parceiros que recebem JSON em vez de XML) */
  payload: Record<string, unknown>;
  certificate?: { pfx: Buffer; password: string } | null;
}

export type GatewayStatus = 'authorized' | 'rejected' | 'denied' | 'processing' | 'unavailable';

export interface TransmitResult {
  status: GatewayStatus;
  code: string;
  message: string;
  protocol?: string;
  receipt?: string;
  authorizedAt?: string;
  /** XML de distribuição (nfeProc: NF-e + protocolo) */
  authorizedXml?: string;
}

export interface EventResult {
  status: 'registered' | 'rejected' | 'unavailable';
  code: string;
  message: string;
  protocol?: string;
  xml?: string;
}

export interface InboundDoc {
  nsu: number;
  accessKey: string;
  issuerCnpj: string;
  issuerName: string;
  issuerIe?: string;
  issuedAt: string;
  total: string;
  situation: 'autorizada' | 'cancelada' | 'denegada';
  /** XML completo (só disponível após a ciência da operação) */
  xml?: string;
}

/** NFS-e padrão nacional: a DPS (Declaração de Prestação de Serviço) vai ao Sefin Nacional. */
export interface NfseRequest {
  documentId: string;
  environment: 1 | 2;
  issuerCnpj: string;
  cityIbge: string;
  series: number;
  number: number;
  xml: string;
  payload: Record<string, unknown>;
}

export interface NfseResult extends TransmitResult {
  /** Chave de acesso da NFS-e (50 dígitos) */
  nfseKey?: string;
  nfseNumber?: string;
  verificationCode?: string;
}

export interface FiscalGateway {
  readonly name: string;
  transmitNfse(req: NfseRequest): Promise<NfseResult>;
  cancelNfse(req: { nfseKey: string; reason: string; environment: 1 | 2; issuerCnpj: string }): Promise<EventResult>;
  serviceStatus(uf: string, model: '55' | '65', environment: 1 | 2): Promise<{ online: boolean; message: string }>;
  transmit(req: TransmitRequest): Promise<TransmitResult>;
  /** Consulta pela chave: evita reenviar e receber duplicidade (204) */
  query(accessKey: string, environment: 1 | 2): Promise<TransmitResult>;
  cancel(req: { accessKey: string; protocol: string; reason: string; environment: 1 | 2; issuerCnpj: string }): Promise<EventResult>;
  correctionLetter(req: { accessKey: string; sequence: number; text: string; environment: 1 | 2; issuerCnpj: string }): Promise<EventResult>;
  inutilize(req: { issuerCnpj: string; uf: string; model: string; series: number; from: number; to: number; year: number; reason: string; environment: 1 | 2 }): Promise<EventResult>;
  epec?(req: TransmitRequest): Promise<EventResult>;
  distribution(req: { cnpj: string; uf: string; lastNsu: number; environment: 1 | 2 }): Promise<{ code: string; docs: InboundDoc[]; lastNsu: number; maxNsu: number }>;
  manifest(req: { cnpj: string; accessKey: string; kind: 'ciencia' | 'confirmada' | 'desconhecida' | 'nao_realizada'; reason?: string; environment: 1 | 2 }): Promise<EventResult & { xml?: string }>;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });

/**
 * SEFAZ simulada (homologação local). Determinística e configurável nos testes:
 * - offline = true → indisponível (aciona contingência — RN-NFE-10);
 * - rejectWhen/denyWhen → rejeição/denegação por regra;
 * - inbound → notas "emitidas contra" o CNPJ para a distribuição de DF-e.
 */
export class SimulatedFiscalGateway implements FiscalGateway {
  readonly name = 'simulated';
  offline = false;
  protocolSeq = 100000;
  readonly authorized = new Map<string, TransmitResult & { cancelled?: boolean; xml: string }>();
  readonly inbound = new Map<string, InboundDoc[]>();
  readonly events: { kind: string; key?: string; payload: unknown }[] = [];
  rejectWhen: (xml: Record<string, any>, raw: string) => { code: string; message: string } | null = () => null;
  denyWhen: (xml: Record<string, any>) => { code: string; message: string } | null = () => null;

  private protocol(env: number) {
    return `${env === 1 ? '1' : '2'}26${String(++this.protocolSeq).padStart(12, '0')}`;
  }

  async serviceStatus() {
    return this.offline ? { online: false, message: 'Serviço paralisado temporariamente' } : { online: true, message: 'Serviço em operação' };
  }

  async transmit(req: TransmitRequest): Promise<TransmitResult> {
    if (this.offline && req.emissionType === 1) return { status: 'unavailable', code: '108', message: 'Serviço paralisado momentaneamente (curto prazo)' };
    const prev = this.authorized.get(req.accessKey);
    if (prev) return { status: 'rejected', code: '204', message: 'Duplicidade de NF-e' };
    let doc: Record<string, any>;
    try {
      doc = parser.parse(req.xml);
    } catch {
      return { status: 'rejected', code: '215', message: 'Falha no schema XML' };
    }
    const inf = doc?.NFe?.infNFe;
    if (!inf || !inf.ide || !inf.emit || !inf.det) return { status: 'rejected', code: '225', message: 'Falha no Schema XML da NFe' };
    // Regras básicas de validação da SEFAZ
    const dets = Array.isArray(inf.det) ? inf.det : [inf.det];
    for (const d of dets) {
      const vProd = Number(d.prod.vProd);
      if (Math.abs(Number(d.prod.qCom) * Number(d.prod.vUnCom) - vProd) > 0.011) return { status: 'rejected', code: '629', message: 'Valor do Produto difere do produto Valor Unitário de Comercialização e Quantidade Comercial' };
    }
    const custom = this.rejectWhen(doc, req.xml);
    if (custom) return { status: 'rejected', ...custom };
    const deny = this.denyWhen(doc);
    const protocol = this.protocol(req.environment);
    const now = new Date().toISOString();
    const prot = `<protNFe versao="4.00"><infProt><tpAmb>${req.environment}</tpAmb><verAplic>VORTEX-SIM</verAplic><chNFe>${req.accessKey}</chNFe><dhRecbto>${now}</dhRecbto><nProt>${protocol}</nProt><cStat>${deny ? deny.code : '100'}</cStat><xMotivo>${deny ? deny.message : 'Autorizado o uso da NF-e'}</xMotivo></infProt></protNFe>`;
    const authorizedXml = `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${req.xml.replace(/^<\?xml[^>]*\?>/, '')}${prot}</nfeProc>`;
    const result: TransmitResult = deny
      ? { status: 'denied', code: deny.code, message: deny.message, protocol, authorizedAt: now, authorizedXml }
      : { status: 'authorized', code: '100', message: 'Autorizado o uso da NF-e', protocol, authorizedAt: now, authorizedXml };
    this.authorized.set(req.accessKey, { ...result, xml: req.xml });
    return result;
  }

  async query(accessKey: string): Promise<TransmitResult> {
    if (this.offline) return { status: 'unavailable', code: '108', message: 'Serviço paralisado' };
    const a = this.authorized.get(accessKey);
    if (!a) return { status: 'rejected', code: '217', message: 'NF-e não consta na base de dados da SEFAZ' };
    return a.cancelled ? { ...a, code: '101', message: 'Cancelamento de NF-e homologado' } : a;
  }

  async cancel(req: { accessKey: string; protocol: string; reason: string }): Promise<EventResult> {
    if (this.offline) return { status: 'unavailable', code: '108', message: 'Serviço paralisado' };
    const a = this.authorized.get(req.accessKey);
    if (!a || a.status !== 'authorized') return { status: 'rejected', code: '217', message: 'NF-e não consta na base de dados da SEFAZ' };
    if (a.protocol !== req.protocol) return { status: 'rejected', code: '222', message: 'Protocolo de Autorização de Uso difere do cadastrado' };
    if (a.cancelled) return { status: 'rejected', code: '218', message: 'NF-e já está cancelada na base de dados da SEFAZ' };
    a.cancelled = true;
    this.events.push({ kind: 'cancel', key: req.accessKey, payload: req });
    return { status: 'registered', code: '135', message: 'Evento registrado e vinculado a NF-e', protocol: this.protocol(2) };
  }

  async correctionLetter(req: { accessKey: string; sequence: number; text: string }): Promise<EventResult> {
    if (this.offline) return { status: 'unavailable', code: '108', message: 'Serviço paralisado' };
    const a = this.authorized.get(req.accessKey);
    if (!a || a.cancelled) return { status: 'rejected', code: '217', message: 'NF-e não consta na base de dados da SEFAZ' };
    this.events.push({ kind: 'cce', key: req.accessKey, payload: req });
    return { status: 'registered', code: '135', message: 'Evento registrado e vinculado a NF-e', protocol: this.protocol(2) };
  }

  async inutilize(req: { from: number; to: number; series: number }): Promise<EventResult> {
    if (this.offline) return { status: 'unavailable', code: '108', message: 'Serviço paralisado' };
    this.events.push({ kind: 'inutilize', payload: req });
    return { status: 'registered', code: '102', message: 'Inutilização de número homologado', protocol: this.protocol(2) };
  }

  async epec(req: TransmitRequest): Promise<EventResult> {
    this.events.push({ kind: 'epec', key: req.accessKey, payload: {} });
    return { status: 'registered', code: '136', message: 'Evento registrado, mas não vinculado a NF-e', protocol: this.protocol(2) };
  }

  async distribution(req: { cnpj: string; lastNsu: number }) {
    const all = (this.inbound.get(req.cnpj) ?? []).filter((d) => d.nsu > req.lastNsu).sort((a, b) => a.nsu - b.nsu);
    const page = all.slice(0, 50);
    const maxNsu = Math.max(req.lastNsu, ...(this.inbound.get(req.cnpj) ?? []).map((d) => d.nsu));
    return { code: page.length ? '138' : '137', docs: page.map((d) => ({ ...d, xml: undefined })), lastNsu: page.length ? page[page.length - 1]!.nsu : req.lastNsu, maxNsu };
  }

  async manifest(req: { cnpj: string; accessKey: string; kind: string }) {
    const doc = [...this.inbound.values()].flat().find((d) => d.accessKey === req.accessKey);
    if (!doc) return { status: 'rejected' as const, code: '217', message: 'NF-e não consta na base de dados da SEFAZ' };
    this.events.push({ kind: `manifest:${req.kind}`, key: req.accessKey, payload: req });
    return { status: 'registered' as const, code: '135', message: 'Evento registrado e vinculado a NF-e', protocol: this.protocol(2), xml: req.kind === 'ciencia' || req.kind === 'confirmada' ? doc.xml : undefined };
  }

  readonly nfse = new Map<string, NfseResult & { cancelled?: boolean; dpsId: string }>();
  nfseSeq = 0;

  async transmitNfse(req: NfseRequest): Promise<NfseResult> {
    if (this.offline) return { status: 'unavailable', code: 'E999', message: 'Sefin Nacional indisponível' };
    let dps: Record<string, any>;
    try {
      dps = parser.parse(req.xml);
    } catch {
      return { status: 'rejected', code: 'E1235', message: 'Falha no esquema XML da DPS' };
    }
    const inf = dps?.DPS?.infDPS;
    if (!inf?.prest || !inf.serv?.cServ?.cTribNac || !inf.valores?.vServPrest) return { status: 'rejected', code: 'E1235', message: 'Falha no esquema XML da DPS' };
    if (!inf.toma?.CNPJ && !inf.toma?.CPF) return { status: 'rejected', code: 'E0400', message: 'Tomador não identificado' };
    if (!(Number(inf.valores.vServPrest.vServ) > 0)) return { status: 'rejected', code: 'E0610', message: 'Valor do serviço deve ser maior que zero' };
    const dpsId = String(inf['@Id']);
    const prev = [...this.nfse.values()].find((n) => n.dpsId === dpsId);
    if (prev) return prev;
    const custom = this.rejectWhen(dps, req.xml);
    if (custom) return { status: 'rejected', ...custom };
    const n = ++this.nfseSeq;
    const now = new Date();
    const base = `${req.cityIbge}${req.environment === 1 ? '1' : '2'}2${req.issuerCnpj.padStart(14, '0')}${String(n).padStart(13, '0')}${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    let sum = 0;
    let w = 2;
    for (let i = base.length - 1; i >= 0; i--) {
      sum += Number(base[i]) * w;
      w = w === 9 ? 2 : w + 1;
    }
    const dv = 11 - (sum % 11);
    const nfseKey = `${base}${dv >= 10 ? 0 : dv}`;
    const authorizedXml = `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infNFSe Id="NFS${nfseKey}"><nNFSe>${n}</nNFSe><dhProc>${now.toISOString()}</dhProc>${req.xml.replace(/^<\?xml[^>]*\?>/, '')}</infNFSe></NFSe>`;
    const result: NfseResult & { dpsId: string } = { status: 'authorized', code: '100', message: 'NFS-e gerada', protocol: this.protocol(req.environment), authorizedAt: now.toISOString(),
      authorizedXml, nfseKey, nfseNumber: String(n), verificationCode: nfseKey.slice(-9, -1), dpsId };
    this.nfse.set(nfseKey, result);
    return result;
  }

  async cancelNfse(req: { nfseKey: string; reason: string }): Promise<EventResult> {
    if (this.offline) return { status: 'unavailable', code: 'E999', message: 'Sefin Nacional indisponível' };
    const n = this.nfse.get(req.nfseKey);
    if (!n) return { status: 'rejected', code: 'E0840', message: 'NFS-e não encontrada' };
    if (n.cancelled) return { status: 'rejected', code: 'E0841', message: 'NFS-e já cancelada' };
    n.cancelled = true;
    this.events.push({ kind: 'cancel_nfse', key: req.nfseKey, payload: req });
    return { status: 'registered', code: '101101', message: 'Evento de cancelamento registrado', protocol: this.protocol(2) };
  }

  /** Ajuda de teste: registra uma nota de fornecedor emitida contra o CNPJ. */
  addInbound(cnpj: string, doc: Omit<InboundDoc, 'nsu'>): InboundDoc {
    const list = this.inbound.get(cnpj) ?? [];
    const d = { ...doc, nsu: list.length + 1 };
    list.push(d);
    this.inbound.set(cnpj, list);
    return d;
  }
}

/**
 * Parceiro emissor por API (fase 1). Implementação no formato REST comum aos
 * parceiros de mercado (envio por referência, consulta, cancelamento, CC-e,
 * inutilização). O mapeamento de campos deve ser homologado com o parceiro
 * escolhido pelos sócios (seção 27) antes da produção.
 */
export class PartnerFiscalGateway implements FiscalGateway {
  readonly name = 'partner';
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`${this.token}:`).toString('base64')}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* resposta não JSON */
    }
    return { status: res.status, data };
  }

  private toResult(r: { status: number; data: any }): TransmitResult {
    if (r.status >= 500 || r.status === 0) return { status: 'unavailable', code: String(r.status), message: 'Parceiro emissor indisponível' };
    const st = String(r.data?.status ?? '');
    if (st === 'autorizado') return { status: 'authorized', code: String(r.data.status_sefaz ?? '100'), message: r.data.mensagem_sefaz ?? 'Autorizado', protocol: r.data.protocolo, authorizedAt: r.data.data_emissao };
    if (st === 'denegado') return { status: 'denied', code: String(r.data.status_sefaz ?? '301'), message: r.data.mensagem_sefaz ?? 'Uso denegado', protocol: r.data.protocolo };
    if (st === 'processando_autorizacao') return { status: 'processing', code: '105', message: 'Lote em processamento' };
    return { status: 'rejected', code: String(r.data?.status_sefaz ?? r.data?.codigo ?? '999'), message: r.data?.mensagem_sefaz ?? r.data?.mensagem ?? 'Rejeitada' };
  }

  async transmitNfse(req: NfseRequest): Promise<NfseResult> {
    try {
      const r = await this.call('POST', `/v2/nfsen?ref=${req.documentId}`, req.payload);
      const base = this.toResult(r);
      return base.status === 'authorized' ? { ...base, nfseKey: r.data?.chave_nfse, nfseNumber: r.data?.numero_nfse, verificationCode: r.data?.codigo_verificacao } : base;
    } catch {
      return { status: 'unavailable', code: '0', message: 'Falha de comunicação com o parceiro emissor' };
    }
  }

  async cancelNfse(req: { nfseKey: string; reason: string }) {
    const r = await this.call('DELETE', `/v2/nfsen/chave/${req.nfseKey}`, { justificativa: req.reason });
    return r.data?.status === 'cancelado'
      ? { status: 'registered' as const, code: '101101', message: 'Cancelamento registrado', protocol: r.data.protocolo }
      : { status: 'rejected' as const, code: String(r.data?.codigo ?? '999'), message: r.data?.mensagem ?? 'Cancelamento recusado' };
  }

  async serviceStatus() {
    try {
      const r = await this.call('GET', '/v2/nfe/status');
      return { online: r.status < 500, message: String(r.data?.mensagem ?? r.status) };
    } catch (e) {
      return { online: false, message: (e as Error).message };
    }
  }

  async transmit(req: TransmitRequest) {
    try {
      return this.toResult(await this.call('POST', `/v2/nfe?ref=${req.documentId}`, req.payload));
    } catch {
      return { status: 'unavailable' as const, code: '0', message: 'Falha de comunicação com o parceiro emissor' };
    }
  }

  async query(accessKey: string) {
    try {
      return this.toResult(await this.call('GET', `/v2/nfe/chave/${accessKey}`));
    } catch {
      return { status: 'unavailable' as const, code: '0', message: 'Falha de comunicação com o parceiro emissor' };
    }
  }

  async cancel(req: { accessKey: string; reason: string }) {
    const r = await this.call('DELETE', `/v2/nfe/chave/${req.accessKey}`, { justificativa: req.reason });
    return r.data?.status === 'cancelado'
      ? { status: 'registered' as const, code: '135', message: 'Cancelamento homologado', protocol: r.data.protocolo }
      : { status: 'rejected' as const, code: String(r.data?.status_sefaz ?? '999'), message: r.data?.mensagem_sefaz ?? 'Cancelamento recusado' };
  }

  async correctionLetter(req: { accessKey: string; text: string }) {
    const r = await this.call('POST', `/v2/nfe/chave/${req.accessKey}/carta_correcao`, { correcao: req.text });
    return r.data?.status === 'autorizado'
      ? { status: 'registered' as const, code: '135', message: 'Carta de correção registrada', protocol: r.data.protocolo }
      : { status: 'rejected' as const, code: String(r.data?.status_sefaz ?? '999'), message: r.data?.mensagem_sefaz ?? 'CC-e recusada' };
  }

  async inutilize(req: { issuerCnpj: string; series: number; from: number; to: number; reason: string; model: string }) {
    const r = await this.call('POST', '/v2/nfe/inutilizacao', { cnpj: req.issuerCnpj, serie: req.series, numero_inicial: req.from, numero_final: req.to, justificativa: req.reason, modelo: req.model });
    return r.data?.status === 'autorizado'
      ? { status: 'registered' as const, code: '102', message: 'Inutilização homologada', protocol: r.data.protocolo }
      : { status: 'rejected' as const, code: String(r.data?.status_sefaz ?? '999'), message: r.data?.mensagem_sefaz ?? 'Inutilização recusada' };
  }

  async distribution(req: { cnpj: string; lastNsu: number }) {
    const r = await this.call('GET', `/v2/nfes_recebidas?cnpj=${req.cnpj}&versao=${req.lastNsu}`);
    const docs: InboundDoc[] = (Array.isArray(r.data) ? r.data : []).map((d: any) => ({
      nsu: Number(d.versao), accessKey: d.chave_nfe, issuerCnpj: d.documento_emitente, issuerName: d.nome_emitente, issuedAt: d.data_emissao,
      total: String(d.valor_total), situation: d.situacao === 'cancelada' ? 'cancelada' : 'autorizada',
    }));
    const last = docs.length ? docs[docs.length - 1]!.nsu : req.lastNsu;
    return { code: docs.length ? '138' : '137', docs, lastNsu: last, maxNsu: last };
  }

  async manifest(req: { accessKey: string; kind: string; reason?: string }) {
    const tipo = { ciencia: 'ciencia', confirmada: 'confirmacao', desconhecida: 'desconhecimento', nao_realizada: 'nao_realizada' }[req.kind];
    const r = await this.call('POST', `/v2/nfes_recebidas/${req.accessKey}/manifesto`, { tipo, justificativa: req.reason });
    return r.status < 300
      ? { status: 'registered' as const, code: '135', message: 'Manifestação registrada', protocol: r.data?.protocolo }
      : { status: 'rejected' as const, code: String(r.status), message: String(r.data?.mensagem ?? 'Manifestação recusada') };
  }
}

export function newNumericCode(): string {
  return String(parseInt(randomUUID().replace(/-/g, '').slice(0, 8), 16) % 100_000_000).padStart(8, '0');
}
