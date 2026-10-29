import type { z } from 'zod';
import type { PdvSaleInput, pdvCashMovementSchema, pdvHeartbeatSchema, pdvReturnSchema, pdvSaleCancelSchema } from '@vortex/contracts';

/**
 * Cliente da API do Vortex ERP (seção 33), desacoplado da interface e dos casos de uso.
 * Distingue ERP indisponível (rede, tempo esgotado, 5xx, 429: tentar de novo depois) de
 * recusa por regra (4xx: não adianta reenviar igual; vai para FAILED com o motivo).
 */
export class ErpUnavailable extends Error {
  readonly retryable = true;
}

export class ErpRejected extends Error {
  readonly retryable = false;
  constructor(readonly status: number, readonly code: string, message: string, readonly body: unknown) {
    super(message);
  }
}

export type SaleCancelInput = z.input<typeof pdvSaleCancelSchema>;
export type ReturnInput = z.input<typeof pdvReturnSchema>;
export type CashMovementInput = z.input<typeof pdvCashMovementSchema>;
export type HeartbeatInput = z.input<typeof pdvHeartbeatSchema>;

export interface CustomerInput {
  kind: 'PF' | 'PJ';
  taxId: string;
  legalName: string;
  email?: string | null;
  phone?: string | null;
  /** Endereço fiscal: consumidor do balcão não informa; vai o da loja (como o ERP faz na devolução) */
  address?: Record<string, string | null> | null;
}

export interface AuditBatchItem {
  id: string;
  userId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface ErpClient {
  /** Carga do PDV (produtos, preços, clientes, operadores, parâmetros, contexto fiscal); delta com "since" */
  sync(since: string | null): Promise<Record<string, any>>;
  postSale(sale: PdvSaleInput, idempotencyKey: string): Promise<{ duplicate: boolean; documentId: string; total?: string }>;
  getSale(saleId: string): Promise<Record<string, any>>;
  cancelSale(input: SaleCancelInput): Promise<{ duplicate: boolean; status: string }>;
  authorizeContingency(input: { pdvId: string; saleId: string; protocol: string; authorizedAt: string }): Promise<unknown>;
  postReturn(input: ReturnInput): Promise<{ duplicate: boolean; total: string }>;
  postCashMovement(input: CashMovementInput): Promise<Record<string, any>>;
  searchCustomers(q: string): Promise<Record<string, any>[]>;
  createCustomer(input: CustomerInput, idempotencyKey: string): Promise<{ id: string }>;
  heartbeat(input: HeartbeatInput): Promise<unknown>;
  syncStatus(): Promise<Record<string, any>>;
  dashboard(date: string): Promise<Record<string, any>>;
  postEvents(events: AuditBatchItem[]): Promise<{ accepted: number }>;
}

type Fetch = typeof fetch;

export class HttpErpClient implements ErpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: () => string | null,
    private readonly establishmentId: () => string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, opts: { query?: Record<string, string | null | undefined>; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const key = this.apiKey();
    if (!key) throw new ErpUnavailable('Terminal sem chave de API do ERP (faça o pareamento)');
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { 'x-api-key': key, 'content-type': 'application/json', ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}), 'x-device': 'vortex-pdv' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ErpUnavailable(`ERP indisponível: ${(e as Error).message}`);
    }
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (res.status >= 500 || res.status === 429 || res.status === 408) throw new ErpUnavailable(`ERP respondeu ${res.status}`);
    if (!res.ok) throw new ErpRejected(res.status, body?.code ?? 'ERP_ERROR', body?.message ?? `ERP respondeu ${res.status}`, body);
    return body as T;
  }

  sync(since: string | null) {
    return this.call<Record<string, any>>('GET', '/v1/pdv/sync', { query: { establishmentId: this.establishmentId(), since } });
  }
  postSale(sale: PdvSaleInput, idempotencyKey: string) {
    return this.call<{ duplicate: boolean; documentId: string; total?: string }>('POST', '/v1/pdv/sales', { body: sale, idempotencyKey });
  }
  getSale(saleId: string) {
    return this.call<Record<string, any>>('GET', `/v1/pdv/sales/${encodeURIComponent(saleId)}`, { query: { establishmentId: this.establishmentId() } });
  }
  cancelSale(input: SaleCancelInput) {
    return this.call<{ duplicate: boolean; status: string }>('POST', '/v1/pdv/sales/cancel', { body: input });
  }
  authorizeContingency(input: { pdvId: string; saleId: string; protocol: string; authorizedAt: string }) {
    return this.call('POST', '/v1/pdv/sales/authorization', { body: { establishmentId: this.establishmentId(), ...input } });
  }
  postReturn(input: ReturnInput) {
    return this.call<{ duplicate: boolean; total: string }>('POST', '/v1/pdv/returns', { body: input });
  }
  postCashMovement(input: CashMovementInput) {
    return this.call<Record<string, any>>('POST', '/v1/pdv/cash-movements', { body: input });
  }
  async searchCustomers(q: string) {
    const r = await this.call<{ items: Record<string, any>[] }>('GET', '/v1/parties', { query: { q, role: 'customer', limit: '20' } });
    return r.items;
  }
  createCustomer(input: CustomerInput, idempotencyKey: string) {
    // Cadastro mínimo de consumidor; o cadastro completo continua no ERP (seção 14)
    return this.call<{ id: string }>('POST', '/v1/parties', {
      idempotencyKey,
      body: { kind: input.kind, taxId: input.taxId, legalName: input.legalName, roles: ['customer'], finalConsumer: true, ieIndicator: 9, lgpdPurpose: 'Identificação na venda (PDV)',
        contacts: input.email || input.phone ? [{ name: input.legalName, email: input.email ?? null, phone: input.phone ?? null }] : [],
        addresses: input.address ? [{ kind: 'fiscal', isDefault: true, countryCode: '1058', ...input.address }] : [] },
    });
  }
  heartbeat(input: HeartbeatInput) {
    return this.call('POST', '/v1/pdv/terminals/heartbeat', { body: input });
  }
  syncStatus() {
    return this.call<Record<string, any>>('GET', '/v1/pdv/sync/status');
  }
  dashboard(date: string) {
    return this.call<Record<string, any>>('GET', '/v1/pdv/dashboard', { query: { establishmentId: this.establishmentId(), date } });
  }
  postEvents(events: AuditBatchItem[]) {
    return this.call<{ accepted: number }>('POST', '/v1/pdv/events', { body: { establishmentId: this.establishmentId(), events } });
  }
}
