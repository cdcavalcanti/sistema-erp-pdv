import { D, ZERO } from '@vortex/money';
import type { PdvSettings } from '@vortex/contracts';
import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import type { Audit } from '../audit/audit.js';
import type { SyncQueue } from '../sync/queue.js';
import { PdvError, conflict, invalid, needsAuthorization, notFound } from '../domain/errors.js';
import { saleNumber, storeDay, uuid } from '../domain/ids.js';
import { computeTotals, discountAmount, effectivePercent, lineGross, saleDiscountBase, type CartLine, type DiscountSpec } from '../domain/cart.js';
import { METHOD_LABEL, isFullyPaid, planPayment, remainingAmount, type PaymentMethod, type PaymentStatus } from '../domain/payments.js';
import { stockDecision } from '../domain/stock.js';
import { splitQuantity } from '../domain/barcode.js';
import { P, can, type Operator } from '../security/permissions.js';
import type { PaymentProvider, ProviderResult } from '../payment/providers.js';
import type { FiscalService, SaleForFiscal } from '../fiscal/service.js';
import type { PrinterService } from '../printer/service.js';
import type { ReceiptData } from '../printer/receipt.js';
import type { Scale, CustomerDisplay } from '../hardware/devices.js';
import type { AuthService, Authorization } from './auth.js';
import type { CatalogService } from './catalog.js';
import type { CustomerService } from './customers.js';
import type { CashService } from './cash.js';

export interface SaleRow {
  id: string;
  number: string;
  idempotency_key: string;
  session_id: string;
  operator_id: string;
  status: 'open' | 'payment' | 'completed' | 'cancelled' | 'discarded';
  customer: string | null;
  sale_discount: string | null;
  subtotal: string;
  discount_total: string;
  total: string;
  paid_total: string;
  change_total: string;
  fiscal_status: string | null;
  sync_status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

export interface ItemRow {
  id: string;
  sale_id: string;
  seq: number;
  product_id: string;
  sku: string;
  description: string;
  barcode: string | null;
  unit: string;
  quantity: string;
  unit_price: string;
  base_price: string;
  promotions: string | null;
  weighed: number;
  manual_discount: string | null;
  gross: string;
  discount: string;
  total: string;
  status: 'active' | 'cancelled';
  cancel_reason: string | null;
  cancelled_by: string | null;
  cancel_authorized_by: string | null;
  /** Cancelamento parcial: seq da linha de onde estas unidades saíram */
  cancelled_from_seq: number | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  sale_id: string;
  method: PaymentMethod;
  method_code: string;
  amount: string;
  tendered: string | null;
  change: string;
  installments: number;
  status: PaymentStatus;
  provider: string;
  transaction_id: string | null;
  nsu: string | null;
  authorization: string | null;
  brand: string | null;
  qr_code: string | null;
  message: string | null;
  idempotency_key: string;
  expires_at: string | null;
  created_at: string;
  confirmed_at: string | null;
}

export interface SaleView {
  sale: Omit<SaleRow, 'customer' | 'sale_discount'> & { customer: { id: string | null; name: string | null; taxIdMasked: string | null } | null; saleDiscount: (DiscountSpec & { amount: string }) | null };
  items: (Omit<ItemRow, 'promotions' | 'manual_discount'> & { promotions: { id: string; name: string }[]; manualDiscount: DiscountSpec | null })[];
  payments: PaymentRow[];
  remaining: string;
  fiscal: Record<string, unknown> | null;
  warnings: string[];
}

export interface SaleDeps {
  db: LocalDb;
  clock: Clock;
  audit: Audit;
  queue: SyncQueue;
  auth: AuthService;
  catalog: CatalogService;
  customers: CustomerService;
  cash: CashService;
  fiscal: FiscalService;
  printer: PrinterService;
  scale: Scale;
  display: CustomerDisplay;
  providers: Record<PaymentMethod, PaymentProvider>;
  settings: () => PdvSettings;
  terminalCode: string;
  merchant: () => { name: string; city: string };
  receiptStore: () => ReceiptData['store'];
  environment: 1 | 2;
}

const UNIT_INTEGER = new Set(['UN', 'PC', 'CX', 'PCT', 'DZ', 'FD', 'KIT']);

/**
 * Venda (seções 8 a 24, 43 e 44): carrinho, descontos com alçada, cliente, finalização,
 * pagamentos com confirmação real, NFC-e, impressão, registro e envio ao ERP pela fila.
 */
export class SaleService {
  constructor(private readonly d: SaleDeps) {}

  // ---------------------------------------------------------------- leitura
  row(saleId: string): SaleRow {
    const s = this.d.db.get<SaleRow>(`SELECT * FROM sales WHERE id = ? OR number = ?`, [saleId, saleId]);
    if (!s) throw notFound('Venda');
    return s;
  }

  items(saleId: string, onlyActive = false): ItemRow[] {
    return this.d.db.all<ItemRow>(`SELECT * FROM sale_items WHERE sale_id = ? ${onlyActive ? `AND status = 'active'` : ''} ORDER BY seq`, [saleId]);
  }

  payments(saleId: string): PaymentRow[] {
    return this.d.db.all<PaymentRow>(`SELECT * FROM payments WHERE sale_id = ? ORDER BY created_at`, [saleId]);
  }

  view(saleId: string, warnings: string[] = []): SaleView {
    const s = this.row(saleId);
    const items = this.items(s.id);
    const payments = this.payments(s.id);
    const f = this.d.fiscal.get(s.id);
    const { customer, sale_discount, ...rest } = s;
    return {
      sale: { ...rest, customer: customer ? JSON.parse(customer) : null, saleDiscount: sale_discount ? JSON.parse(sale_discount) : null },
      items: items.map(({ promotions, manual_discount, ...i }) => ({ ...i, promotions: promotions ? JSON.parse(promotions) : [], manualDiscount: manual_discount ? JSON.parse(manual_discount) : null })),
      payments, remaining: remainingAmount(s.total, payments).toFixed(2),
      fiscal: f ? { status: f.status, series: f.series, number: f.number, accessKey: f.access_key, protocol: f.protocol, emissionType: f.emission_type,
        rejection: f.rejection_code ? { code: f.rejection_code, message: f.rejection_message } : null, qrUrl: f.qr_url } : null,
      warnings,
    };
  }

  /** Venda em andamento na sessão (recuperação após queda de energia, seção 43). */
  inProgress(): SaleRow | null {
    const session = this.d.cash.current();
    if (!session) return null;
    return this.d.db.get<SaleRow>(`SELECT * FROM sales WHERE session_id = ? AND status IN ('open', 'payment') ORDER BY created_at DESC LIMIT 1`, [session.id]) ?? null;
  }

  private editable(saleId: string): SaleRow {
    const s = this.row(saleId);
    if (s.status === 'payment') throw conflict('SALE_IN_PAYMENT', 'Venda em pagamento: volte ao carrinho (ESC) para alterar');
    if (s.status !== 'open') throw conflict('SALE_CLOSED', 'Venda encerrada não pode ser alterada');
    return s;
  }

  // ---------------------------------------------------------------- início e itens
  start(op: Operator): SaleRow {
    const current = this.inProgress();
    if (current) return current;
    const session = this.d.cash.requireOpen();
    if (!can(op, P.sell)) throw new PdvError('FORBIDDEN', 'Sem permissão para vender', 403);
    this.assertOfflineAllowed();
    const now = this.d.clock.now();
    const day = storeDay(now);
    const id = uuid();
    const number = saleNumber(this.d.terminalCode, day, this.d.db.next(`sale:${day}`));
    this.d.db.run(`INSERT INTO sales (id, number, idempotency_key, session_id, operator_id, status, created_at, updated_at) VALUES (?,?,?,?,?, 'open', ?, ?)`,
      [id, number, uuid(), session.id, op.id, now.toISOString(), now.toISOString()]);
    return this.row(id);
  }

  /** Venda offline além do limite do ERP fica bloqueada (seção 29: "dentro das operações permitidas"). */
  private assertOfflineAllowed() {
    const s = this.d.settings().sale;
    const lastOk = this.d.db.meta<string>('sync.lastContactAt');
    if (!s.allowOffline && this.d.db.meta<boolean>('sync.online') === false) throw new PdvError('OFFLINE_NOT_ALLOWED', 'Venda offline não permitida pelo ERP', 503);
    if (lastOk && this.d.clock.now().getTime() - new Date(lastOk).getTime() > s.offlineMaxHours * 3_600_000) {
      throw new PdvError('OFFLINE_TOO_LONG', `Terminal sem contato com o ERP há mais de ${s.offlineMaxHours} h: restabeleça a conexão para vender`, 503);
    }
  }

  /**
   * Leitura/digitação do produto (seções 9 a 12): "3*código" informa a quantidade antes;
   * GTIN de embalagem multiplica; etiqueta de balança traz peso/preço; pesável sem peso lê a
   * balança. Reler o mesmo produto incrementa a quantidade.
   */
  async addItem(op: Operator, saleId: string, input: { code?: string; productId?: string; quantity?: string | null }): Promise<SaleView> {
    const s = this.editable(saleId);
    let quantity = input.quantity ?? null;
    let code = input.code ?? '';
    if (code) {
      const split = splitQuantity(code);
      quantity ??= split.quantity;
      code = split.code;
    }
    const found = input.productId ? (() => { const p = this.d.catalog.product(input.productId!); return p ? { product: p, quantity: null, labelPrice: null, barcode: null } : null; })()
      : this.d.catalog.lookup(code);
    if (!found) throw new PdvError('PRODUCT_NOT_FOUND', `Produto não encontrado: ${code}`, 404, { code });
    const p = found.product;
    // Inativo no ERP (ou de uma carga de outra loja): o ERP recusaria a venda
    if (p.status !== 'active') throw new PdvError('PRODUCT_INACTIVE', `${p.description} (${p.sku}) está inativo no ERP e não pode ser vendido`, 422, { productId: p.id });
    const weighable = this.d.catalog.weighable(p);
    let qty = found.quantity && quantity ? D(found.quantity).times(quantity).toString() : (found.quantity ?? quantity);
    let weighed = Boolean(found.quantity && weighable);
    if (!qty && weighable) {
      const r = await this.d.scale.read().catch((e: Error) => { throw new PdvError('SCALE_ERROR', `Balança: ${e.message}`, 503); });
      if (!r.stable || D(r.weight).lessThanOrEqualTo(0)) throw new PdvError('SCALE_UNSTABLE', 'Peso instável ou zerado: aguarde a balança estabilizar', 422);
      qty = r.weight;
      weighed = true;
    }
    qty ??= '1';
    this.validateQuantity(p.sale_unit, qty, weighable);
    const warnings: string[] = [];
    this.d.db.tx(() => {
      // Incremento pelo scanner: mesma mercadoria não pesada e sem desconto manual soma na linha
      const same = !weighed && !weighable
        ? this.d.db.get<ItemRow>(`SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ? AND status = 'active' AND weighed = 0 AND manual_discount IS NULL ORDER BY seq DESC LIMIT 1`, [s.id, p.id])
        : undefined;
      const totalQty = same ? D(same.quantity).plus(qty!).toString() : qty!;
      const decision = stockDecision(this.d.catalog.view(p, totalQty, this.customerPriceList(s)).stockStatus, this.d.settings().stock.outOfStock, {
        available: p.controls_stock ? this.d.catalog.available(p.id) : null, requested: this.productQuantity(s.id, p.id, qty!), allowNegative: Boolean(p.allow_negative_stock), description: p.description });
      if (decision.action === 'block') throw new PdvError('STOCK_BLOCKED', decision.message, 409);
      if (decision.action === 'warn') warnings.push(decision.message);
      if (same) {
        this.d.db.run(`UPDATE sale_items SET quantity = ? WHERE id = ?`, [totalQty, same.id]);
      } else {
        const seq = Number(this.d.db.get<{ n: number }>(`SELECT coalesce(max(seq), 0) + 1 AS n FROM sale_items WHERE sale_id = ?`, [s.id])!.n);
        this.d.db.run(
          `INSERT INTO sale_items (id, sale_id, seq, product_id, sku, description, barcode, unit, quantity, unit_price, base_price, weighed, gross, discount, total, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?, '0', '0', ?, '0', '0', '0', 'active', ?)`,
          [uuid(), s.id, seq, p.id, p.sku, p.short_description || p.description, found.barcode, p.sale_unit, qty!, weighed ? 1 : 0, this.d.clock.now().toISOString()]);
      }
      this.reprice(s.id);
    });
    const v = this.view(s.id, warnings);
    const last = v.items.filter((i) => i.status === 'active').at(-1);
    if (last) this.d.display.show(last.description, `R$ ${v.sale.total}`);
    return v;
  }

  private validateQuantity(unit: string, qty: string, weighable: boolean) {
    const q = D(qty);
    if (q.lessThanOrEqualTo(0)) throw invalid('Quantidade deve ser maior que zero');
    if (q.greaterThan(9999)) throw invalid('Quantidade acima do permitido (9999)');
    if (!weighable && UNIT_INTEGER.has(unit.toUpperCase()) && !q.isInteger()) throw invalid(`Produto vendido por ${unit}: quantidade inteira`);
  }

  /** Quantidade total do produto na venda (para estoque e preço por faixa/promoção). */
  private productQuantity(saleId: string, productId: string, extra: string | null): string {
    const rows = this.d.db.all<{ quantity: string }>(`SELECT quantity FROM sale_items WHERE sale_id = ? AND product_id = ? AND status = 'active'`, [saleId, productId]);
    return rows.reduce((a, r) => a.plus(r.quantity), D(extra ?? 0)).toString();
  }

  private customerPriceList(s: SaleRow): string | null {
    const c = s.customer ? JSON.parse(s.customer) as { id: string | null } : null;
    return c?.id ? this.d.customers.get(c.id)?.price_list_id ?? null : null;
  }

  /** Recalcula preços (faixa de quantidade e promoções pela quantidade total do produto) e totais. */
  private reprice(saleId: string) {
    const s = this.row(saleId);
    const items = this.items(saleId, true);
    const list = this.customerPriceList(s);
    for (const productId of new Set(items.map((i) => i.product_id))) {
      const price = this.d.catalog.priceFor(productId, this.productQuantity(saleId, productId, null), list);
      if (D(price.price).isZero()) throw new PdvError('NO_PRICE', `Produto sem preço na tabela: ${items.find((i) => i.product_id === productId)!.description}`, 422);
      this.d.db.run(`UPDATE sale_items SET unit_price = ?, base_price = ?, promotions = ? WHERE sale_id = ? AND product_id = ? AND status = 'active'`,
        [price.price, price.basePrice, price.promotions.length ? JSON.stringify(price.promotions) : null, saleId, productId]);
    }
    this.recompute(saleId);
  }

  private cartLines(saleId: string): CartLine[] {
    return this.items(saleId).map((i) => ({ id: i.id, quantity: i.quantity, unitPrice: i.unit_price, manualDiscount: i.manual_discount ? JSON.parse(i.manual_discount) : null, status: i.status }));
  }

  private recompute(saleId: string) {
    const s = this.row(saleId);
    const saleDisc = s.sale_discount ? JSON.parse(s.sale_discount) as DiscountSpec & { amount: string } : null;
    const t = computeTotals(this.cartLines(saleId), saleDisc);
    for (const l of t.lines) this.d.db.run(`UPDATE sale_items SET gross = ?, discount = ?, total = ? WHERE id = ?`, [l.gross, l.discount, l.total, l.id]);
    this.d.db.run(`UPDATE sale_items SET gross = '0', discount = '0', total = '0' WHERE sale_id = ? AND status = 'cancelled'`, [saleId]);
    const sd = saleDisc ? JSON.stringify({ ...saleDisc, amount: t.saleDiscount }) : null;
    this.d.db.run(`UPDATE sales SET subtotal = ?, discount_total = ?, total = ?, sale_discount = ?, updated_at = ? WHERE id = ?`,
      [t.subtotal, t.discountTotal, t.total, sd, this.d.clock.now().toISOString(), saleId]);
  }

  async setQuantity(op: Operator, saleId: string, itemId: string, quantity: string): Promise<SaleView> {
    const s = this.editable(saleId);
    const it = this.items(s.id).find((i) => i.id === itemId && i.status === 'active');
    if (!it) throw notFound('Item');
    const p = this.d.catalog.product(it.product_id)!;
    this.validateQuantity(p.sale_unit, quantity, this.d.catalog.weighable(p));
    const warnings: string[] = [];
    if (D(quantity).greaterThan(it.quantity)) {
      const decision = stockDecision(this.d.catalog.view(p, quantity, null).stockStatus, this.d.settings().stock.outOfStock, {
        available: p.controls_stock ? this.d.catalog.available(p.id) : null, requested: D(this.productQuantity(s.id, p.id, null)).minus(it.quantity).plus(quantity).toString(),
        allowNegative: Boolean(p.allow_negative_stock), description: p.description });
      if (decision.action === 'block') throw new PdvError('STOCK_BLOCKED', decision.message, 409);
      if (decision.action === 'warn') warnings.push(decision.message);
    }
    this.d.db.tx(() => {
      this.d.db.run(`UPDATE sale_items SET quantity = ? WHERE id = ?`, [D(quantity).toString(), it.id]);
      this.reprice(s.id);
    });
    return this.view(s.id, warnings);
  }

  /**
   * Cancelamento de item (seção 22): motivo obrigatório; autorização quando o ERP exige. Com
   * `quantity` menor que a da linha, cancela só essas unidades: a linha fica com o restante e a
   * parte cancelada vira uma linha cancelada própria (aparece no cupom e vai para o ERP).
   */
  async cancelItem(op: Operator, saleId: string, itemId: string, reason: string, auth?: Authorization | null, quantity?: string | null): Promise<SaleView> {
    const s = this.editable(saleId);
    if (!reason?.trim()) throw invalid('Informe o motivo do cancelamento do item');
    const it = this.items(s.id).find((i) => i.id === itemId && i.status === 'active');
    if (!it) throw notFound('Item');
    const qty = D(quantity ?? it.quantity);
    if (qty.lessThanOrEqualTo(0)) throw invalid('Informe a quantidade a cancelar');
    if (qty.greaterThan(it.quantity)) throw invalid(`O item ${it.seq} tem ${D(it.quantity).toString()} ${it.unit}: não dá para cancelar ${qty.toString()}`);
    const p = this.d.catalog.product(it.product_id);
    if (p) this.validateQuantity(p.sale_unit, qty.toString(), this.d.catalog.weighable(p));
    const partial = qty.lessThan(it.quantity);
    const approver = this.d.settings().sale.itemCancelRequiresAuthorization
      ? await this.d.auth.require(op, P.authorizeItemCancel, auth, `Cancelar ${partial ? `${qty.toString()} ${it.unit} do ` : ''}item ${it.seq}`, { item: it.description, quantity: qty.toString() }) : null;
    this.d.db.tx(() => {
      if (!partial) {
        this.d.db.run(`UPDATE sale_items SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancel_authorized_by = ?, cancelled_at = ? WHERE id = ?`,
          [reason, op.id, approver?.id ?? null, this.d.clock.now().toISOString(), it.id]);
      } else {
        const remaining = D(it.quantity).minus(qty);
        // Desconto em valor acompanha a quantidade que fica
        const md = it.manual_discount ? JSON.parse(it.manual_discount) as { kind: string; value: string; amount?: string } : null;
        const scaled = md && md.kind === 'value' ? JSON.stringify({ ...md, value: D(md.value).times(remaining).dividedBy(it.quantity).toFixed(2) }) : it.manual_discount;
        this.d.db.run(`UPDATE sale_items SET quantity = ?, manual_discount = ? WHERE id = ?`, [remaining.toString(), scaled, it.id]);
        const seq = Number(this.d.db.get<{ n: number }>(`SELECT coalesce(max(seq), 0) + 1 AS n FROM sale_items WHERE sale_id = ?`, [s.id])!.n);
        this.d.db.run(
          `INSERT INTO sale_items (id, sale_id, seq, product_id, sku, description, barcode, unit, quantity, unit_price, base_price, promotions, weighed, manual_discount, gross, discount, total,
                                   status, cancel_reason, cancelled_by, cancel_authorized_by, cancelled_from_seq, cancelled_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'0','0','0','cancelled',?,?,?,?,?,?)`,
          [uuid(), s.id, seq, it.product_id, it.sku, it.description, it.barcode, it.unit, qty.toString(), it.unit_price, it.base_price, it.promotions, it.weighed,
            reason, op.id, approver?.id ?? null, it.seq, this.d.clock.now().toISOString(), this.d.clock.now().toISOString()]);
      }
      this.reprice(s.id);
      this.d.audit.record({ userId: op.id, action: 'CANCELAMENTO_ITEM', entity: 'sale', entityId: s.id, metadata: { item: it.seq, product: it.sku, description: it.description,
        quantity: qty.toString(), unit: it.unit, unitPrice: it.unit_price, partial, remaining: D(it.quantity).minus(qty).toString(), reason, authorizedBy: approver?.id ?? null } });
    });
    return this.view(s.id);
  }

  // ---------------------------------------------------------------- descontos (seção 13)
  /**
   * Desconto acima do limite do operador (alçada definida no ERP) exige autorização de quem
   * tem permissão e alçada suficiente. Tudo auditado.
   */
  private async checkDiscount(op: Operator, percent: string, auth: Authorization | null | undefined, what: string): Promise<Operator | null> {
    if (D(percent).lessThanOrEqualTo(op.discountLimitPercent) && !auth) return null;
    if (!auth) {
      throw needsAuthorization(P.authorizeDiscount, `${what} de ${D(percent).toFixed(2)}% acima do seu limite (${D(op.discountLimitPercent).toFixed(2)}%): requer autorização`,
        { percent: D(percent).toFixed(2), limit: op.discountLimitPercent });
    }
    const approver = await this.d.auth.require(op, P.authorizeDiscount, auth, what, { percent: D(percent).toFixed(2) });
    const a = approver ?? op;
    if (D(percent).greaterThan(a.discountLimitPercent)) {
      throw new PdvError('FORBIDDEN', `Desconto de ${D(percent).toFixed(2)}% acima da alçada de ${a.name} (${D(a.discountLimitPercent).toFixed(2)}%)`, 403, { permission: P.authorizeDiscount });
    }
    return approver;
  }

  async itemDiscount(op: Operator, saleId: string, itemId: string, spec: DiscountSpec | null, auth?: Authorization | null): Promise<SaleView> {
    const s = this.editable(saleId);
    const it = this.items(s.id).find((i) => i.id === itemId && i.status === 'active');
    if (!it) throw notFound('Item');
    let approver: Operator | null = null;
    let amount = ZERO;
    if (spec) {
      const gross = lineGross(it.quantity, it.unit_price);
      amount = discountAmount(spec, gross);
      approver = await this.checkDiscount(op, effectivePercent(amount, gross).toFixed(4), auth, `Desconto no item ${it.seq}`);
    }
    this.d.db.tx(() => {
      this.d.db.run(`UPDATE sale_items SET manual_discount = ? WHERE id = ?`, [spec ? JSON.stringify({ ...spec, authorizedBy: approver?.id ?? null }) : null, it.id]);
      this.recompute(s.id);
      this.d.audit.record({ userId: op.id, action: 'DESCONTO', entity: 'sale', entityId: s.id, metadata: { scope: 'item', item: it.seq, spec, amount: amount.toFixed(2), authorizedBy: approver?.id ?? null } });
    });
    return this.view(s.id);
  }

  async saleDiscount(op: Operator, saleId: string, spec: DiscountSpec | null, auth?: Authorization | null): Promise<SaleView> {
    const s = this.editable(saleId);
    let approver: Operator | null = null;
    let amount = ZERO;
    if (spec) {
      const base = saleDiscountBase(this.cartLines(s.id));
      amount = discountAmount(spec, base);
      approver = await this.checkDiscount(op, effectivePercent(amount, base).toFixed(4), auth, 'Desconto na venda');
    }
    this.d.db.tx(() => {
      this.d.db.run(`UPDATE sales SET sale_discount = ? WHERE id = ?`, [spec ? JSON.stringify({ ...spec, amount: amount.toFixed(2), authorizedBy: approver?.id ?? null }) : null, s.id]);
      this.recompute(s.id);
      this.d.audit.record({ userId: op.id, action: 'DESCONTO', entity: 'sale', entityId: s.id, metadata: { scope: 'sale', spec, amount: amount.toFixed(2), authorizedBy: approver?.id ?? null } });
    });
    return this.view(s.id);
  }

  // ---------------------------------------------------------------- cliente (seção 14)
  setCustomer(op: Operator, saleId: string, customerId: string | null): SaleView {
    const s = this.editable(saleId);
    if (customerId) {
      const c = this.d.customers.get(customerId);
      if (!c) throw notFound('Cliente');
      if (c.status === 'blocked') throw new PdvError('CUSTOMER_BLOCKED', `Cliente bloqueado no ERP${c.block_reason ? `: ${c.block_reason}` : ''}`, 422);
      this.d.db.run(`UPDATE sales SET customer = ? WHERE id = ?`, [JSON.stringify({ id: c.id, name: c.name, taxIdMasked: c.tax_id_masked }), s.id]);
    } else {
      this.d.db.run(`UPDATE sales SET customer = NULL WHERE id = ?`, [s.id]);
    }
    this.d.db.tx(() => this.reprice(s.id));
    return this.view(s.id);
  }

  /** CPF/CNPJ na nota sem cadastro (consumidor identificado só na NFC-e). */
  setCustomerTaxId(op: Operator, saleId: string, taxId: string, name: string | null): SaleView {
    const c = this.d.customers.create({ taxId, name: name || 'CONSUMIDOR' });
    return this.setCustomer(op, saleId, c.id);
  }

  // ---------------------------------------------------------------- finalização e pagamento (seções 15 a 19)
  finalize(op: Operator, saleId: string): SaleView {
    const s = this.editable(saleId);
    const items = this.items(s.id, true);
    if (!items.length) throw invalid('Inclua ao menos um item');
    if (D(s.total).lessThanOrEqualTo(0)) throw invalid('Total da venda deve ser maior que zero');
    if (D(s.total).greaterThan(this.d.settings().sale.customerRequiredAbove) && !s.customer) {
      throw new PdvError('CUSTOMER_REQUIRED', `Venda acima de R$ ${D(this.d.settings().sale.customerRequiredAbove).toFixed(2)}: identifique o consumidor (CPF/CNPJ)`, 422);
    }
    this.d.db.run(`UPDATE sales SET status = 'payment', updated_at = ? WHERE id = ?`, [this.d.clock.now().toISOString(), s.id]);
    this.d.display.show('TOTAL A PAGAR', `R$ ${s.total}`);
    return this.view(s.id);
  }

  /** Volta ao carrinho (ESC) se nenhum pagamento foi aprovado ou está pendente. */
  backToCart(op: Operator, saleId: string): SaleView {
    const s = this.row(saleId);
    if (s.status !== 'payment') return this.view(s.id);
    if (this.payments(s.id).some((p) => p.status === 'approved' || p.status === 'pending')) {
      throw conflict('PAYMENT_EXISTS', 'Há pagamento aprovado ou em andamento: cancele-o antes de alterar a venda');
    }
    this.d.db.run(`UPDATE sales SET status = 'open' WHERE id = ?`, [s.id]);
    return this.view(s.id);
  }

  private methodCode(method: PaymentMethod): string {
    const p = this.d.settings().payments;
    return method === 'cash' ? p.cash : method === 'pix' ? p.pix : method === 'debit' || method === 'pos_debit' ? p.debit : p.credit;
  }

  /**
   * Inicia um pagamento. A chave de idempotência vem da tela: duplo clique ou reenvio devolve o
   * mesmo pagamento (seção 44). Só um pagamento eletrônico pendente por vez.
   */
  async addPayment(op: Operator, saleId: string, input: { method: PaymentMethod; amount: string; installments?: number; idempotencyKey: string }): Promise<SaleView> {
    const prior = this.d.db.get<PaymentRow>(`SELECT * FROM payments WHERE idempotency_key = ?`, [input.idempotencyKey]);
    if (prior) return this.view(prior.sale_id);
    const s = this.row(saleId);
    if (s.status !== 'payment') throw conflict('INVALID_STATUS', 'Finalize a venda (F9) antes de receber');
    const payments = this.payments(s.id);
    if (payments.some((p) => p.status === 'pending')) throw conflict('PAYMENT_PENDING', 'Já há um pagamento aguardando confirmação');
    const settings = this.d.settings().payments;
    const plan = planPayment(s.total, payments, input.method, input.amount, { installments: input.installments, maxInstallments: settings.maxInstallments, minInstallmentValue: settings.minInstallmentValue });
    const provider = this.d.providers[input.method];
    const id = uuid();
    const now = this.d.clock.now().toISOString();
    this.d.db.run(
      `INSERT INTO payments (id, sale_id, method, method_code, amount, tendered, change, installments, status, provider, idempotency_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?)`,
      [id, s.id, input.method, this.methodCode(input.method), plan.amount, plan.tendered, plan.change, input.installments ?? 1, provider.name, input.idempotencyKey, now, now]);
    let r: ProviderResult;
    try {
      r = await provider.start({ paymentId: id, saleNumber: s.number, amount: plan.amount, installments: input.installments ?? 1, idempotencyKey: `${s.idempotency_key}-${id}`, merchant: this.d.merchant() });
    } catch (e) {
      r = { status: 'declined', message: `Falha de comunicação com ${METHOD_LABEL[input.method]}: ${(e as Error).message}` };
    }
    this.applyResult(op, id, r);
    if (input.method === 'cash' && this.row(s.id).status === 'payment') this.d.display.show(`TROCO R$ ${plan.change}`, `FALTA R$ ${remainingAmount(s.total, this.payments(s.id)).toFixed(2)}`);
    return this.view(s.id);
  }

  private applyResult(op: Operator | null, paymentId: string, r: ProviderResult) {
    const now = this.d.clock.now().toISOString();
    const pay = this.d.db.get<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, [paymentId])!;
    if (r.status === 'pending') {
      this.d.db.run(`UPDATE payments SET transaction_id = ?, qr_code = coalesce(?, qr_code), expires_at = ?, message = ?, updated_at = ? WHERE id = ?`,
        [r.transactionId, r.qrCode ?? null, r.expiresAt ?? null, r.message ?? null, now, paymentId]);
    } else if (r.status === 'approved') {
      this.d.db.run(`UPDATE payments SET status = 'approved', transaction_id = ?, nsu = ?, authorization = ?, brand = ?, message = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`,
        [r.transactionId, r.nsu ?? null, r.authorization ?? null, r.brand ?? null, r.message ?? null, now, now, paymentId]);
    } else {
      this.d.db.run(`UPDATE payments SET status = ?, transaction_id = coalesce(?, transaction_id), message = ?, updated_at = ? WHERE id = ?`,
        [r.status, r.transactionId ?? null, r.message, now, paymentId]);
      this.d.audit.record({ userId: op?.id ?? null, action: 'ERRO_PAGAMENTO', entity: 'sale', entityId: pay.sale_id,
        metadata: { method: pay.method, amount: pay.amount, status: r.status, message: r.message } });
    }
  }

  /** Consulta o provedor (Pix aguardando pagamento, TEF aguardando cartão); trata o tempo esgotado. */
  async pollPayment(op: Operator | null, paymentId: string): Promise<SaleView> {
    const pay = this.d.db.get<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
    if (!pay) throw notFound('Pagamento');
    if (pay.status !== 'pending') return this.view(pay.sale_id);
    const provider = this.d.providers[pay.method];
    let r: ProviderResult;
    try {
      r = await provider.status(pay.transaction_id ?? '');
    } catch (e) {
      return this.view(pay.sale_id, [`Sem resposta de ${METHOD_LABEL[pay.method]}: ${(e as Error).message}`]);
    }
    if (r.status === 'pending' && pay.method === 'pix' && pay.expires_at && this.d.clock.now() > new Date(pay.expires_at)) {
      await provider.cancel(pay.transaction_id ?? '').catch(() => undefined);
      r = { status: 'timeout', transactionId: pay.transaction_id ?? undefined, message: 'QR Code Pix expirou sem pagamento' };
    }
    this.applyResult(op, paymentId, r);
    return this.view(pay.sale_id);
  }

  /** Maquininha: o operador confirma com NSU e autorização do comprovante (nunca o número do cartão). */
  confirmExternal(op: Operator, paymentId: string, input: { nsu: string; authorization: string; brand?: string | null }): SaleView {
    const pay = this.d.db.get<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
    if (!pay) throw notFound('Pagamento');
    if (!pay.method.startsWith('pos_')) throw invalid('Confirmação manual só para maquininha');
    if (pay.status !== 'pending') return this.view(pay.sale_id);
    if (!/^\d{4,12}$/.test(input.nsu) || !/^[0-9A-Za-z]{4,12}$/.test(input.authorization)) throw invalid('Informe NSU e código de autorização do comprovante da maquininha');
    this.applyResult(op, paymentId, { status: 'approved', transactionId: pay.transaction_id ?? `POS-${paymentId.slice(0, 8)}`, nsu: input.nsu, authorization: input.authorization,
      brand: input.brand ?? undefined, message: `Confirmado pelo operador ${op.login}` });
    return this.view(pay.sale_id);
  }

  /** Cancela pagamento pendente; aprovado é estornado no provedor (dinheiro: devolver ao cliente). */
  async cancelPayment(op: Operator, paymentId: string): Promise<SaleView> {
    const pay = this.d.db.get<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, [paymentId]);
    if (!pay) throw notFound('Pagamento');
    const s = this.row(pay.sale_id);
    if (s.status !== 'payment') throw conflict('INVALID_STATUS', 'Venda não está em pagamento');
    const provider = this.d.providers[pay.method];
    if (pay.status === 'pending') {
      const r = await provider.cancel(pay.transaction_id ?? '');
      // O cliente pode ter pago no último instante: vale o que o provedor disser
      this.applyResult(op, paymentId, r.status === 'approved' ? r : { status: 'cancelled', transactionId: pay.transaction_id ?? undefined, message: 'Cancelado pelo operador' });
    } else if (pay.status === 'approved') {
      const r = await provider.refund(pay.transaction_id ?? '', pay.amount);
      if (r.status !== 'refunded') throw new PdvError('REFUND_FAILED', r.message, 422);
      this.d.db.run(`UPDATE payments SET status = 'refunded', message = ?, updated_at = ? WHERE id = ?`, [r.message, this.d.clock.now().toISOString(), paymentId]);
    }
    return this.view(s.id);
  }

  // ---------------------------------------------------------------- conclusão (seções 20, 21, 37)
  private forFiscal(s: SaleRow): SaleForFiscal {
    const items = this.items(s.id, true);
    const payments = this.payments(s.id).filter((p) => p.status === 'approved');
    const customer = s.customer ? JSON.parse(s.customer) as { id: string; name: string } : null;
    const taxId = customer?.id ? this.d.customers.taxIdOf(customer.id) : null;
    return {
      saleId: s.id, saleNumber: s.number, issuedAt: new Date(s.completed_at ?? this.d.clock.now().toISOString()),
      customer: taxId ? { taxId, name: customer!.name === 'CONSUMIDOR' ? null : customer!.name } : null,
      items: items.map((i) => {
        const p = this.d.catalog.product(i.product_id)!;
        return { productId: i.product_id, sku: i.sku, gtin: p.gtin, description: i.description, ncm: p.ncm ?? '00000000', unit: i.unit, quantity: i.quantity, unitPrice: i.unit_price, gross: i.gross, discount: i.discount };
      }),
      payments: payments.map((p) => ({ methodCode: p.method_code, amount: p.amount, change: p.change, brand: p.brand, authorization: p.authorization,
        integrated: p.method === 'debit' || p.method === 'credit', card: p.method !== 'cash' && p.method !== 'pix' })),
    };
  }

  /**
   * Conclui: total pago confere → NFC-e (ou contingência) → registra → imprime → fila do ERP.
   * Reentrante: depois de queda de energia, chamar de novo continua de onde parou.
   */
  async complete(op: Operator, saleId: string): Promise<SaleView & { receipt: string | null; printError: string | null }> {
    let s = this.row(saleId);
    if (s.status === 'completed') return { ...this.view(s.id), receipt: null, printError: null };
    if (s.status !== 'payment') throw conflict('INVALID_STATUS', 'Venda não está em pagamento');
    const payments = this.payments(s.id);
    if (payments.some((p) => p.status === 'pending')) throw conflict('PAYMENT_PENDING', 'Aguarde a confirmação do pagamento em andamento');
    if (!isFullyPaid(s.total, payments)) throw new PdvError('NOT_PAID', `Falta receber R$ ${remainingAmount(s.total, payments).toFixed(2)}`, 422);
    const at = s.completed_at ?? this.d.clock.now().toISOString();
    if (!s.completed_at) this.d.db.run(`UPDATE sales SET completed_at = ? WHERE id = ?`, [at, s.id]);
    s = this.row(s.id);
    const doc = await this.d.fiscal.emit(this.forFiscal(s), op.id);
    const change = payments.filter((p) => p.status === 'approved').reduce((a, p) => a.plus(p.change), ZERO).toFixed(2);
    const paid = payments.filter((p) => p.status === 'approved').reduce((a, p) => a.plus(p.amount), ZERO).toFixed(2);
    this.d.db.tx(() => {
      this.d.db.run(`UPDATE sales SET status = 'completed', paid_total = ?, change_total = ?, fiscal_status = ?, updated_at = ? WHERE id = ?`,
        [paid, change, doc.status, this.d.clock.now().toISOString(), s.id]);
      // Rejeitada não vai ao ERP até ser reprocessada (o ERP exige NFC-e autorizada ou em contingência)
      if (doc.status === 'authorized' || doc.status === 'contingency') {
        this.d.queue.enqueue('sale', 'sale', s.id, { saleId: s.id });
        this.d.db.run(`UPDATE sales SET sync_status = 'pending' WHERE id = ?`, [s.id]);
      }
      this.d.audit.record({ userId: op.id, action: 'VENDA', entity: 'sale', entityId: s.id, metadata: { number: s.number, total: s.total, items: this.items(s.id, true).length,
        payments: payments.filter((p) => p.status === 'approved').map((p) => ({ method: p.method, amount: p.amount })), fiscal: doc.status, accessKey: doc.access_key } });
    });
    let receipt: string | null = null;
    let printError: string | null = null;
    try {
      receipt = (await this.d.printer.print(this.receiptData(s.id, op.name), { openDrawer: payments.some((p) => p.method === 'cash' && p.status === 'approved') })).text;
    } catch (e) {
      printError = `Venda registrada, mas a impressão falhou: ${(e as Error).message}. Use Reimprimir (F11).`;
    }
    this.d.display.show('OBRIGADO!', `TROCO R$ ${change}`);
    return { ...this.view(s.id), receipt, printError };
  }

  /** Reprocessa a NFC-e rejeitada depois de corrigir o cadastro no ERP e sincronizar. */
  async reprocessFiscal(op: Operator, saleId: string): Promise<SaleView> {
    const s = this.row(saleId);
    if (s.status !== 'completed') throw conflict('INVALID_STATUS', 'Só venda concluída tem NFC-e para reprocessar');
    const doc = await this.d.fiscal.reprocess(this.forFiscal(s), op.id);
    this.d.db.tx(() => {
      this.d.db.run(`UPDATE sales SET fiscal_status = ? WHERE id = ?`, [doc.status, s.id]);
      if (doc.status === 'authorized' || doc.status === 'contingency') {
        this.d.queue.enqueue('sale', 'sale', s.id, { saleId: s.id });
        this.d.db.run(`UPDATE sales SET sync_status = 'pending' WHERE id = ?`, [s.id]);
      }
    });
    return this.view(s.id);
  }

  // ---------------------------------------------------------------- cancelamento da venda (seção 23)
  /**
   * Venda em andamento: descarta (estornando pagamentos já aprovados). Venda concluída: exige
   * permissão (supervisor), cancela a NFC-e no prazo, estorna os pagamentos e avisa o ERP.
   */
  async cancelSale(op: Operator, saleId: string, reason: string, auth?: Authorization | null): Promise<SaleView> {
    const s = this.row(saleId);
    if (!reason || reason.trim().length < 15) throw invalid('Informe o motivo do cancelamento (mínimo 15 caracteres)');
    if (s.status === 'cancelled' || s.status === 'discarded') return this.view(s.id);
    const completed = s.status === 'completed';
    const approver = completed || this.payments(s.id).some((p) => p.status === 'approved')
      ? await this.d.auth.require(op, P.cancelSale, auth, `Cancelar venda ${s.number}`, { total: s.total }) : null;
    if (completed) {
      const doc = this.d.fiscal.get(s.id);
      if (doc && (doc.status === 'authorized' || doc.status === 'contingency')) await this.d.fiscal.cancel(s.id, reason.trim(), op.id);
    }
    // Estorno dos pagamentos no provedor (Pix devolvido, TEF cancelado; dinheiro devolvido na gaveta)
    for (const p of this.payments(s.id)) {
      if (p.status === 'pending') await this.d.providers[p.method].cancel(p.transaction_id ?? '').catch(() => undefined);
      if (p.status === 'approved') {
        const r = await this.d.providers[p.method].refund(p.transaction_id ?? '', p.amount).catch((e: Error) => ({ status: 'failed' as const, message: e.message }));
        if (r.status !== 'refunded') {
          this.d.audit.record({ userId: op.id, action: 'ERRO_PAGAMENTO', entity: 'sale', entityId: s.id, metadata: { method: p.method, amount: p.amount, refund: r.message } });
        }
      }
    }
    const now = this.d.clock.now().toISOString();
    this.d.db.tx(() => {
      this.d.db.run(`UPDATE payments SET status = CASE WHEN status = 'approved' THEN 'refunded' WHEN status = 'pending' THEN 'cancelled' ELSE status END, updated_at = ? WHERE sale_id = ?`, [now, s.id]);
      this.d.db.run(`UPDATE sales SET status = ?, cancelled_at = ?, cancel_reason = ?, cancelled_by = ?, cancel_authorized_by = ?, fiscal_status = coalesce(?, fiscal_status), updated_at = ? WHERE id = ?`,
        [completed ? 'cancelled' : 'discarded', now, reason.trim(), op.id, approver?.id ?? null, this.d.fiscal.get(s.id)?.status ?? null, now, s.id]);
      const fiscal = this.d.fiscal.get(s.id);
      if (completed && fiscal?.status === 'cancelled') {
        this.d.queue.enqueue('sale_cancel', 'sale', s.id, { saleId: s.number, reason: reason.trim(), protocol: fiscal.cancel_protocol, cancelledAt: fiscal.cancelled_at,
          operatorId: op.id, authorizedBy: approver?.id ?? null });
      }
      this.d.audit.record({ userId: op.id, action: 'CANCELAMENTO_VENDA', entity: 'sale', entityId: s.id, metadata: { number: s.number, total: s.total, reason: reason.trim(), completed,
        authorizedBy: approver?.id ?? null } });
    });
    return this.view(s.id);
  }

  // ---------------------------------------------------------------- comprovante
  receiptData(saleId: string, operatorName: string, opts: { reprint?: boolean } = {}): ReceiptData {
    const s = this.row(saleId);
    const items = this.items(s.id, true);
    const pays = this.payments(s.id).filter((p) => p.status === 'approved' || p.status === 'refunded');
    const doc = this.d.fiscal.get(s.id);
    const settings = this.d.settings();
    const customer = s.customer ? JSON.parse(s.customer) as { name: string | null; taxIdMasked: string | null } : null;
    return {
      store: this.d.receiptStore(), header: settings.receipt.header, footer: settings.receipt.footer, saleNumber: s.number, terminal: this.d.terminalCode, operator: operatorName,
      at: new Date(s.completed_at ?? s.created_at), customer,
      items: items.map((i) => ({ seq: i.seq, code: i.sku, description: i.description, quantity: i.quantity, unit: i.unit, unitPrice: i.unit_price, gross: i.gross, discount: i.discount, total: i.total })),
      subtotal: s.subtotal, discount: s.discount_total, total: s.total,
      payments: pays.map((p) => ({ label: `${METHOD_LABEL[p.method]}${p.installments > 1 ? ` ${p.installments}x` : ''}`, amount: D(p.amount).plus(p.change).toFixed(2),
        detail: p.nsu ? `${p.brand ?? ''} NSU ${p.nsu} AUT ${p.authorization ?? ''}`.trim() : p.method === 'pix' && p.authorization ? `E2E ${p.authorization}` : null })),
      change: s.change_total,
      approximateTaxes: doc?.taxes ? (JSON.parse(doc.taxes) as { total: string }).total : null,
      fiscal: doc && doc.status !== 'rejected' && doc.status !== 'pending' ? {
        status: doc.status, series: doc.series, number: doc.number, accessKey: doc.access_key, protocol: doc.protocol, authorizedAt: doc.authorized_at, qrUrl: doc.qr_url,
        consultUrl: doc.qr_url.replace(/\?.*$/, ''), environment: this.d.environment, contingency: doc.emission_type === 9,
      } : null,
      reprint: opts.reprint, cancelled: s.status === 'cancelled',
    };
  }

  /** Reimpressão (seção 5: supervisor) — auditada. */
  async reprint(op: Operator, saleId: string, auth?: Authorization | null): Promise<{ text: string }> {
    const s = this.row(saleId);
    if (s.status !== 'completed' && s.status !== 'cancelled') throw conflict('INVALID_STATUS', 'Só venda concluída tem comprovante');
    const approver = await this.d.auth.require(op, P.reprint, auth, `Reimprimir ${s.number}`);
    const operator = this.d.auth.operatorById(s.operator_id)?.name ?? '-';
    const out = await this.d.printer.print(this.receiptData(s.id, operator, { reprint: true }));
    this.d.audit.record({ userId: op.id, action: 'REIMPRESSAO', entity: 'sale', entityId: s.id, metadata: { number: s.number, authorizedBy: approver?.id ?? null } });
    return out;
  }

  /** Vendas do operador (seção 5) ou de todos (quem consulta operadores). */
  /**
   * Histórico de vendas: período (dias da loja), busca por número/cliente, situação e situação no ERP.
   * Operador vê as próprias; quem consulta operadores ou cancela vendas vê todas do terminal.
   */
  list(op: Operator, filter: { q?: string; sessionId?: string; from?: string; to?: string; status?: string; sync?: string; limit?: number } = {}) {
    const all = can(op, P.operators) || can(op, P.cancelSale);
    // Dia da loja (America/Sao_Paulo, sem horário de verão) → instantes em UTC
    const from = filter.from ? new Date(`${filter.from}T00:00:00-03:00`).toISOString() : null;
    const to = filter.to ? new Date(new Date(`${filter.to}T00:00:00-03:00`).getTime() + 86_400_000).toISOString() : null;
    const status = filter.status === 'with_cancelled_items' ? null : filter.status ?? null;
    return this.d.db.all<SaleRow & { operator_name: string | null; items_count: number; cancelled_items: number; methods: string | null; sync_error: string | null }>(
      `SELECT s.*, o.name AS operator_name,
              (SELECT count(*) FROM sale_items i WHERE i.sale_id = s.id AND i.status = 'active') AS items_count,
              (SELECT count(*) FROM sale_items i WHERE i.sale_id = s.id AND i.status = 'cancelled') AS cancelled_items,
              (SELECT group_concat(DISTINCT p.method) FROM payments p WHERE p.sale_id = s.id AND p.status IN ('approved', 'refunded')) AS methods,
              (SELECT q.last_error FROM sync_queue q WHERE q.type = 'sale' AND q.entity_id = s.id AND q.status = 'FAILED') AS sync_error
         FROM sales s LEFT JOIN operators o ON o.id = s.operator_id
        WHERE s.status IN ('completed', 'cancelled') AND (? = 1 OR s.operator_id = ?) AND (? IS NULL OR s.session_id = ?)
          AND (? IS NULL OR s.number LIKE ? OR s.customer LIKE ?) AND (? IS NULL OR s.completed_at >= ?) AND (? IS NULL OR s.completed_at < ?)
          AND (? IS NULL OR s.status = ?) AND (? IS NULL OR s.sync_status = ?)
          AND (? = 0 OR EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id AND i.status = 'cancelled'))
        ORDER BY s.completed_at DESC LIMIT ?`,
      [all ? 1 : 0, op.id, filter.sessionId ?? null, filter.sessionId ?? null, filter.q || null, `%${filter.q ?? ''}%`, `%${filter.q ?? ''}%`, from, from, to, to,
        status, status, filter.sync ?? null, filter.sync ?? null, filter.status === 'with_cancelled_items' ? 1 : 0, filter.limit ?? 300]);
  }
}
