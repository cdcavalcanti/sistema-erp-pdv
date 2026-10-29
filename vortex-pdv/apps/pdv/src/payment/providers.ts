import { randomBytes, randomInt } from 'node:crypto';
import type { Clock } from '../clock.js';
import { dynamicBrCode } from './brcode.js';

/**
 * Provedores de pagamento (seção 18: "a arquitetura deve permitir aguardar confirmação e
 * tratar cancelamento, recusa e timeout"). Nenhum guarda dado de cartão: só NSU, autorização
 * e bandeira (seção 40).
 */
export interface PaymentRequest {
  paymentId: string;
  saleNumber: string;
  amount: string;
  installments: number;
  idempotencyKey: string;
  merchant: { name: string; city: string };
}

export type ProviderResult =
  | { status: 'pending'; transactionId: string; qrCode?: string; expiresAt?: string; message?: string }
  | { status: 'approved'; transactionId: string; nsu?: string; authorization?: string; brand?: string; message?: string }
  | { status: 'declined' | 'cancelled' | 'timeout'; transactionId?: string; message: string };

export interface PaymentProvider {
  readonly name: string;
  start(req: PaymentRequest): Promise<ProviderResult>;
  status(transactionId: string): Promise<ProviderResult>;
  cancel(transactionId: string): Promise<ProviderResult>;
  /** Estorno de pagamento aprovado (cancelamento/devolução) */
  refund(transactionId: string, amount: string): Promise<{ status: 'refunded' | 'failed'; message: string }>;
}

/** Dinheiro: confirmado pelo operador ao receber. */
export class CashProvider implements PaymentProvider {
  readonly name = 'cash';
  async start(req: PaymentRequest): Promise<ProviderResult> {
    return { status: 'approved', transactionId: `CASH-${req.paymentId.slice(0, 8)}` };
  }
  async status(transactionId: string): Promise<ProviderResult> {
    return { status: 'approved', transactionId };
  }
  async cancel(transactionId: string): Promise<ProviderResult> {
    return { status: 'cancelled', transactionId, message: 'Pagamento em dinheiro cancelado' };
  }
  async refund() {
    return { status: 'refunded' as const, message: 'Devolver o dinheiro ao cliente' };
  }
}

// ------------------------------------------------------------------ Pix

interface PixCharge {
  txid: string;
  amount: string;
  status: 'ATIVA' | 'CONCLUIDA' | 'REMOVIDA' | 'DEVOLVIDA';
  expiresAt: Date;
  e2eId?: string;
}

/**
 * PSP de Pix simulado (homologação/demonstração). A cobrança só é paga quando o "pagador"
 * paga (rota de simulação ou teste); exibir o QR Code nunca confirma nada (seção 17).
 */
export class SimulatedPixPsp implements PaymentProvider {
  readonly name = 'pix-simulado';
  readonly charges = new Map<string, PixCharge>();
  constructor(private readonly clock: Clock, private readonly ttlSeconds = 300) {}

  async start(req: PaymentRequest): Promise<ProviderResult> {
    // txid derivado da chave de idempotência: repetir o pedido devolve a mesma cobrança
    const txid = req.idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 35).padEnd(26, '0');
    const charge = this.charges.get(txid) ?? { txid, amount: req.amount, status: 'ATIVA' as const, expiresAt: new Date(this.clock.now().getTime() + this.ttlSeconds * 1000) };
    this.charges.set(txid, charge);
    return this.toResult(charge, req.merchant);
  }

  private toResult(c: PixCharge, merchant = { name: 'LOJA', city: 'CIDADE' }): ProviderResult {
    if (c.status === 'CONCLUIDA') return { status: 'approved', transactionId: c.txid, authorization: c.e2eId };
    if (c.status === 'REMOVIDA') return { status: 'cancelled', transactionId: c.txid, message: 'Cobrança Pix cancelada' };
    if (this.clock.now() > c.expiresAt) return { status: 'timeout', transactionId: c.txid, message: 'QR Code Pix expirou sem pagamento' };
    return { status: 'pending', transactionId: c.txid, expiresAt: c.expiresAt.toISOString(),
      qrCode: dynamicBrCode({ location: `pix.simulado.vortex/cob/${c.txid}`, amount: c.amount, merchantName: merchant.name, merchantCity: merchant.city }), message: 'Aguardando pagamento do Pix' };
  }

  async status(txid: string): Promise<ProviderResult> {
    const c = this.charges.get(txid);
    if (!c) return { status: 'declined', transactionId: txid, message: 'Cobrança Pix não encontrada no PSP' };
    return this.toResult(c);
  }

  async cancel(txid: string): Promise<ProviderResult> {
    const c = this.charges.get(txid);
    if (c && c.status === 'ATIVA') c.status = 'REMOVIDA';
    return c?.status === 'CONCLUIDA' ? this.toResult(c) : { status: 'cancelled', transactionId: txid, message: 'Cobrança Pix cancelada' };
  }

  async refund(txid: string) {
    const c = this.charges.get(txid);
    if (!c || c.status !== 'CONCLUIDA') return { status: 'failed' as const, message: 'Pix não pago: nada a devolver' };
    c.status = 'DEVOLVIDA';
    return { status: 'refunded' as const, message: 'Devolução Pix solicitada ao PSP' };
  }

  /** Simula o pagador pagando (equivale à notificação do PSP). */
  pay(txid: string): boolean {
    const c = this.charges.get(txid);
    if (!c || c.status !== 'ATIVA' || this.clock.now() > c.expiresAt) return false;
    c.status = 'CONCLUIDA';
    c.e2eId = `E${randomBytes(15).toString('hex').toUpperCase().slice(0, 31)}`;
    return true;
  }
}

/**
 * PSP real pela API Pix do Banco Central (cob): PUT /cob/{txid}, GET /cob/{txid}. A
 * autenticação (OAuth2 + certificado mTLS) depende do PSP escolhido e deve ser homologada.
 */
export class ApiPixProvider implements PaymentProvider {
  readonly name = 'pix-api-bacen';
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly pixKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async req(method: string, path: string, body?: unknown) {
    const r = await this.fetchImpl(new URL(path, this.baseUrl), { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`PSP respondeu ${r.status}`);
    return (await r.json()) as Record<string, any>;
  }

  private map(c: Record<string, any>): ProviderResult {
    if (c.status === 'CONCLUIDA') return { status: 'approved', transactionId: c.txid, authorization: c.pix?.[0]?.endToEndId };
    if (String(c.status).startsWith('REMOVIDA')) return { status: 'cancelled', transactionId: c.txid, message: 'Cobrança removida' };
    return { status: 'pending', transactionId: c.txid, qrCode: c.pixCopiaECola, message: 'Aguardando pagamento do Pix' };
  }

  async start(req: PaymentRequest) {
    const txid = req.idempotencyKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 35).padEnd(26, '0');
    return this.map(await this.req('PUT', `/cob/${txid}`, { calendario: { expiracao: 300 }, valor: { original: req.amount }, chave: this.pixKey, solicitacaoPagador: `Venda ${req.saleNumber}` }));
  }
  async status(txid: string) {
    return this.map(await this.req('GET', `/cob/${txid}`));
  }
  async cancel(txid: string) {
    return this.map(await this.req('PATCH', `/cob/${txid}`, { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' }));
  }
  async refund(txid: string, amount: string) {
    const c = await this.req('GET', `/cob/${txid}`);
    const e2e = c.pix?.[0]?.endToEndId;
    if (!e2e) return { status: 'failed' as const, message: 'Pix sem pagamento para devolver' };
    await this.req('PUT', `/pix/${e2e}/devolucao/${txid.slice(0, 20)}`, { valor: amount });
    return { status: 'refunded' as const, message: 'Devolução Pix solicitada ao PSP' };
  }
}

// ------------------------------------------------------------------ cartão (TEF)

interface TefTx {
  id: string;
  amount: string;
  state: 'waiting_card' | 'approved' | 'declined' | 'cancelled' | 'refunded';
  startedAt: Date;
  nsu?: string;
  authorization?: string;
  brand?: string;
  scenario: 'approve' | 'decline' | 'timeout' | 'cancel';
}

/**
 * TEF simulado com pinpad virtual, para homologação e testes. Cenários pelos centavos, como
 * os cartões de teste das adquirentes: ,51 recusa; ,52 não responde (timeout); ,53 cliente
 * cancela no pinpad; qualquer outro aprova.
 */
export class SimulatedTef implements PaymentProvider {
  readonly name = 'tef-simulado';
  readonly txs = new Map<string, TefTx>();
  constructor(private readonly clock: Clock, private readonly timeoutSeconds = 90) {}

  async start(req: PaymentRequest): Promise<ProviderResult> {
    const prior = this.txs.get(req.idempotencyKey);
    if (prior) return this.status(prior.id);
    const cents = req.amount.split('.')[1] ?? '00';
    const scenario = cents === '51' ? 'decline' : cents === '52' ? 'timeout' : cents === '53' ? 'cancel' : 'approve';
    const tx: TefTx = { id: req.idempotencyKey, amount: req.amount, state: 'waiting_card', startedAt: this.clock.now(), scenario };
    this.txs.set(tx.id, tx);
    return { status: 'pending', transactionId: tx.id, message: 'Insira, aproxime ou passe o cartão no pinpad' };
  }

  async status(id: string): Promise<ProviderResult> {
    const tx = this.txs.get(id);
    if (!tx) return { status: 'declined', transactionId: id, message: 'Transação TEF não encontrada' };
    if (tx.state === 'waiting_card') {
      if (tx.scenario === 'approve') {
        tx.state = 'approved';
        tx.nsu = String(randomInt(100000, 999999));
        tx.authorization = String(randomInt(100000, 999999));
        tx.brand = 'VISA';
      } else if (tx.scenario === 'decline') {
        tx.state = 'declined';
      } else if (tx.scenario === 'cancel') {
        tx.state = 'cancelled';
      } else if ((this.clock.now().getTime() - tx.startedAt.getTime()) / 1000 > this.timeoutSeconds) {
        return { status: 'timeout', transactionId: id, message: 'Pinpad não respondeu (tempo esgotado)' };
      }
    }
    switch (tx.state) {
      case 'approved': return { status: 'approved', transactionId: id, nsu: tx.nsu, authorization: tx.authorization, brand: tx.brand, message: 'Transação aprovada' };
      case 'declined': return { status: 'declined', transactionId: id, message: 'Transação negada pelo emissor (saldo/limite insuficiente)' };
      case 'cancelled': return { status: 'cancelled', transactionId: id, message: 'Transação cancelada no pinpad' };
      default: return { status: 'pending', transactionId: id, message: 'Aguardando o cartão no pinpad' };
    }
  }

  async cancel(id: string): Promise<ProviderResult> {
    const tx = this.txs.get(id);
    if (tx && tx.state === 'waiting_card') tx.state = 'cancelled';
    return tx?.state === 'approved' ? this.status(id) : { status: 'cancelled', transactionId: id, message: 'Transação TEF cancelada' };
  }

  async refund(id: string) {
    const tx = this.txs.get(id);
    if (!tx || tx.state !== 'approved') return { status: 'failed' as const, message: 'Transação não aprovada: nada a estornar' };
    tx.state = 'refunded';
    return { status: 'refunded' as const, message: 'Cancelamento TEF aprovado' };
  }
}

/**
 * TEF desligado (PDV_TEF_PROVIDER=none): débito/crédito integrados recusam na hora e o
 * operador usa a maquininha avulsa. Um TEF real entra como outra implementação desta interface.
 */
export class DisabledTef implements PaymentProvider {
  readonly name = 'tef-desligado';
  private readonly refusal = { status: 'declined' as const, message: 'TEF integrado não configurado neste terminal: use Débito/Crédito na maquininha' };
  async start(): Promise<ProviderResult> { return this.refusal; }
  async status(): Promise<ProviderResult> { return this.refusal; }
  async cancel(transactionId: string): Promise<ProviderResult> { return { status: 'cancelled', transactionId, message: 'Nada a cancelar' }; }
  async refund() { return { status: 'failed' as const, message: 'TEF integrado não configurado' }; }
}

/**
 * Maquininha avulsa (POS sem integração): o operador confirma com o NSU e a autorização
 * impressos no comprovante da maquininha. A confirmação é registrada e auditada.
 */
export class ExternalPosProvider implements PaymentProvider {
  readonly name = 'maquininha';
  async start(req: PaymentRequest): Promise<ProviderResult> {
    return { status: 'pending', transactionId: `POS-${req.paymentId.slice(0, 8)}`, message: 'Passe o cartão na maquininha e informe NSU e autorização do comprovante' };
  }
  async status(transactionId: string): Promise<ProviderResult> {
    return { status: 'pending', transactionId, message: 'Aguardando confirmação do operador' };
  }
  async cancel(transactionId: string): Promise<ProviderResult> {
    return { status: 'cancelled', transactionId, message: 'Pagamento na maquininha cancelado' };
  }
  async refund() {
    return { status: 'refunded' as const, message: 'Faça o cancelamento na própria maquininha' };
  }
}
