import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pdvSettingsSchema } from '@vortex/contracts';
import { loadConfig } from '../src/config.js';
import { ManualClock } from '../src/clock.js';
import { createPdv, type Pdv } from '../src/application/pdv.js';
import { ErpRejected, ErpUnavailable, type AuditBatchItem, type ErpClient } from '../src/erp/client.js';
import { hashSecret } from '../src/security/crypto.js';
import { FilePrinter } from '../src/printer/drivers.js';
import { SimulatedScale } from '../src/hardware/devices.js';
import { SimulatedSefaz } from '../src/fiscal/providers.js';
import { SimulatedPixPsp, SimulatedTef } from '../src/payment/providers.js';

export const CTX = JSON.parse(readFileSync(new URL('./fixtures/erp-context.json', import.meta.url), 'utf8')) as Record<string, any>;
export const PRODUCT = CTX.productIds as { cafe: string; pao: string; camiseta: string };

const OPERATOR_PERMS = ['pdv.venda.operar', 'pdv.caixa.abrir', 'pdv.cliente.cadastrar', 'pdv.venda.consultar'];
const SUPERVISOR_PERMS = [...OPERATOR_PERMS, 'pdv.desconto.autorizar', 'pdv.item.autorizar_cancelamento', 'pdv.venda.cancelar', 'pdv.devolucao.autorizar', 'pdv.caixa.sangria',
  'pdv.caixa.suprimento', 'pdv.documento.reimprimir'];
const MANAGER_PERMS = [...SUPERVISOR_PERMS, 'pdv.caixa.fechar', 'pdv.caixa.reabrir', 'pdv.operador.consultar', 'pdv.relatorio.ver', 'pdv.parametro.configurar'];

export const OPS = {
  ana: { id: randomUUID(), name: 'Ana Operadora', login: 'ana', pin: '482913', permissions: OPERATOR_PERMS, roles: ['operador_caixa'], discount_limit_percent: '5' },
  sup: { id: randomUUID(), name: 'Sérgio Supervisor', login: 'sup', pin: '730184', permissions: SUPERVISOR_PERMS, roles: ['supervisor_caixa'], discount_limit_percent: '15' },
  ger: { id: randomUUID(), name: 'Gabriela Gerente', login: 'ger', pin: '915372', permissions: MANAGER_PERMS, roles: ['gerente'], discount_limit_percent: '30' },
};
const MARIA = randomUUID();
const HASHES = Promise.all(Object.values(OPS).map(async (o) => ({ ...o, pin_hash: await hashSecret(o.pin) })));
export const SUP = { login: 'sup', pin: OPS.sup.pin };
export const GER = { login: 'ger', pin: OPS.ger.pin };

/**
 * ERP falso, em memória, com o mesmo contrato do HttpErpClient: liga/desliga a conexão,
 * guarda o que recebeu e é idempotente pela venda (sale_uuid), como o ERP real.
 */
export class FakeErp implements ErpClient {
  online = true;
  rejectSales: string | null = null;
  sales = new Map<string, Record<string, any>>();
  cancels: Record<string, any>[] = [];
  returns: Record<string, any>[] = [];
  cash: Record<string, any>[] = [];
  customers: Record<string, any>[] = [];
  authorizations: Record<string, any>[] = [];
  events: AuditBatchItem[] = [];
  heartbeats: Record<string, any>[] = [];
  settings: Record<string, unknown> = {};
  /** Numeração já usada pelo terminal no ERP (terminal reinstalado) */
  numbering: { nfce: { environment: number; series: number; lastNumber: number }[]; lastSaleIds: string[] } | null = null;
  stock: Record<string, any>[] = [
    { product_id: PRODUCT.cafe, warehouse_id: 'w1', lot_id: null, quantity: '10', reserved: '0', blocked: '0' },
    { product_id: PRODUCT.camiseta, warehouse_id: 'w1', lot_id: null, quantity: '2', reserved: '0', blocked: '0' },
  ];
  private operators: Record<string, any>[] = [];

  constructor(private readonly clock: ManualClock) {}

  async init() {
    this.operators = await HASHES;
    return this;
  }

  private gate() {
    if (!this.online) throw new ErpUnavailable('ERP indisponível: fetch failed');
  }

  async sync(since: string | null) {
    this.gate();
    const full = !since;
    return {
      serverTime: this.clock.now().toISOString(), since, establishment: CTX.establishment, nfceSeries: CTX.nfceSeries, fiscal: CTX.fiscal, paymentMethods: CTX.paymentMethods,
      settings: pdvSettingsSchema.parse(this.settings), operators: this.operators, stock: this.stock, stockParams: [], numbering: this.numbering,
      products: full ? [
        { id: PRODUCT.cafe, sku: 'CAFE-500', description: 'Café torrado 500g', gtin: '7891234567895', ncm: '09012100', kind: 'goods', sale_unit: 'UN', stock_unit: 'UN', controls_stock: true,
          status: 'active', updated_at: this.clock.now().toISOString(), conversions: [{ unit: 'CX', factor: '12', gtin: '17891234567892' }] },
        { id: PRODUCT.pao, sku: '123', description: 'Pão francês kg', gtin: null, ncm: '19053100', kind: 'goods', sale_unit: 'KG', stock_unit: 'KG', controls_stock: false, status: 'active',
          updated_at: this.clock.now().toISOString(), conversions: [] },
        { id: PRODUCT.camiseta, sku: 'CAMISETA', description: 'Camiseta básica', manufacturer_code: 'REF-77', gtin: '7890000000017', ncm: '61091000', kind: 'goods', sale_unit: 'UN',
          stock_unit: 'UN', controls_stock: true, status: 'active', updated_at: this.clock.now().toISOString(), conversions: [] },
      ] : [],
      priceLists: [{ id: 'pl1', code: 'PADRAO', name: 'Padrão', is_default: true, valid_from: '2020-01-01', valid_to: null, active: true }],
      prices: full ? [
        { price_list_id: 'pl1', product_id: PRODUCT.cafe, min_qty: '0', price: '24.90' },
        { price_list_id: 'pl1', product_id: PRODUCT.pao, min_qty: '0', price: '16.90' },
        { price_list_id: 'pl1', product_id: PRODUCT.camiseta, min_qty: '0', price: '49.90' },
      ] : [],
      promotions: [],
      customers: full ? [{ id: MARIA, kind: 'PF', tax_id: '52998224725', legal_name: 'Maria das Graças', status: 'active', updated_at: this.clock.now().toISOString() }] : [],
    };
  }
  async postSale(sale: any) {
    this.gate();
    if (this.rejectSales && sale.saleId === this.rejectSales) throw new ErpRejected(422, 'PDV_TOTAL_MISMATCH', 'Total da venda no PDV difere do ERP', {});
    const dup = [...this.sales.values()].find((s) => s.saleUuid === sale.saleUuid);
    if (dup) return { duplicate: true, documentId: dup.documentId };
    const documentId = randomUUID();
    this.sales.set(sale.saleId, { ...sale, documentId });
    return { duplicate: false, documentId, total: '0' };
  }
  async getSale(saleId: string) {
    this.gate();
    const s = this.sales.get(saleId);
    if (!s) throw new ErpRejected(404, 'NOT_FOUND', 'Venda do PDV não encontrada', {});
    return { ...s, status: 'active', items: s.items.map((i: any, n: number) => ({ item_number: n + 1, product_id: i.productId, description: 'Item', quantity: i.quantity, returned_quantity: '0',
      total: (Number(i.quantity) * Number(i.unitPrice) - Number(i.discount ?? 0)).toFixed(2) })) };
  }
  async cancelSale(input: any) { this.gate(); this.cancels.push(input); return { duplicate: false, status: 'cancelled' }; }
  async authorizeContingency(input: any) { this.gate(); this.authorizations.push(input); return {}; }
  async postReturn(input: any) { this.gate(); this.returns.push(input); return { duplicate: false, total: '0' }; }
  async postCashMovement(input: any) { this.gate(); this.cash.push(input); return input; }
  async searchCustomers(q: string) { this.gate(); return this.customers.filter((c) => c.tax_id === q.replace(/\D/g, '')).map((c) => ({ ...c, legal_name: c.legalName, status: 'active' })); }
  async createCustomer(input: any) { this.gate(); const c = { id: randomUUID(), ...input, tax_id: input.taxId }; this.customers.push(c); return { id: c.id }; }
  async heartbeat(input: any) { this.gate(); this.heartbeats.push(input); return {}; }
  async syncStatus() { this.gate(); return {}; }
  async dashboard() { this.gate(); return { salesCount: this.sales.size }; }
  async postEvents(events: AuditBatchItem[]) { this.gate(); this.events.push(...events); return { accepted: events.length }; }
}

export interface TestPdv {
  pdv: Pdv;
  erp: FakeErp;
  clock: ManualClock;
  sefaz: SimulatedSefaz;
  pix: SimulatedPixPsp;
  tef: SimulatedTef;
  printer: FilePrinter;
  scale: SimulatedScale;
}

export async function makePdv(opts: { settings?: Record<string, unknown> } = {}): Promise<TestPdv> {
  const clock = new ManualClock(new Date('2026-10-27T15:00:00.000Z'));
  const erp = await new FakeErp(clock).init();
  erp.settings = opts.settings ?? {};
  const sefaz = new SimulatedSefaz(clock);
  const pix = new SimulatedPixPsp(clock, 300);
  const tef = new SimulatedTef(clock, 90);
  const printer = new FilePrinter(null);
  const scale = new SimulatedScale();
  const pdv = createPdv(loadConfig({ env: 'test', dbPath: ':memory:', terminalCode: '03', erp: { url: 'http://erp.test', apiKey: 'vx_test', establishmentId: CTX.establishment.id, timeoutMs: 1000 } }),
    { clock, erp, fiscalProvider: sefaz, pix, tef, printer, scale });
  const r = await pdv.sync.runOnce({ full: true });
  if (!r.online) throw new Error(`carga inicial falhou: ${r.errors.join('; ')}`);
  return { pdv, erp, clock, sefaz, pix, tef, printer, scale };
}

export async function login(t: TestPdv, who: keyof typeof OPS = 'ana') {
  return (await t.pdv.auth.login(OPS[who].login, OPS[who].pin)).operator;
}
