import { D, roundMoney } from '@vortex/money';
import type { LocalDb } from '../db/sqlite.js';
import type { Clock } from '../clock.js';
import type { Audit } from '../audit/audit.js';
import type { SyncQueue } from '../sync/queue.js';
import type { ErpClient } from '../erp/client.js';
import { PdvError, conflict, invalid } from '../domain/errors.js';
import { uuid } from '../domain/ids.js';
import { P, type Operator } from '../security/permissions.js';
import type { PaymentProvider } from '../payment/providers.js';
import type { PaymentMethod } from '../domain/payments.js';
import type { AuthService, Authorization } from './auth.js';
import type { CashService } from './cash.js';
import type { CustomerService } from './customers.js';
import type { SaleService } from './sales.js';

export interface ReturnableItem {
  itemNumber: number;
  productId: string;
  description: string;
  quantity: string;
  returned: string;
  unitTotal: string;
}

/**
 * Devolução (seção 24): pesquisar a venda, selecionar itens, motivo, autorização e reembolso
 * (dinheiro da gaveta, Pix devolvido pelo PSP, estorno no cartão ou crédito em loja). O ERP
 * recebe a operação (nota de entrada, estoque e financeiro) pela fila.
 */
export class ReturnService {
  constructor(private readonly d: {
    db: LocalDb; clock: Clock; audit: Audit; queue: SyncQueue; erp: ErpClient; auth: AuthService; cash: CashService; customers: CustomerService; sales: SaleService;
    providers: Record<PaymentMethod, PaymentProvider>; terminalCode: string; establishmentId: () => string;
  }) {}

  /** Itens que ainda podem ser devolvidos (venda deste terminal ou consultada no ERP). */
  async returnable(saleNumber: string, online: boolean): Promise<{ saleNumber: string; local: boolean; customerIdentified: boolean; items: ReturnableItem[] }> {
    const local = this.d.db.get<{ id: string; status: string; customer: string | null }>(`SELECT id, status, customer FROM sales WHERE number = ?`, [saleNumber]);
    if (local) {
      if (local.status !== 'completed') throw conflict('INVALID_STATUS', 'Só venda concluída admite devolução');
      const items = this.d.sales.items(local.id, true);
      return {
        saleNumber, local: true, customerIdentified: Boolean(local.customer),
        items: items.map((i, idx) => ({ itemNumber: idx + 1, productId: i.product_id, description: i.description, quantity: i.quantity, returned: this.returnedQty(saleNumber, idx + 1),
          unitTotal: D(i.total).dividedBy(i.quantity).toString() })),
      };
    }
    if (!online) throw new PdvError('ERP_OFFLINE', 'Venda de outro terminal: consulte com o ERP online', 503);
    const s = await this.d.erp.getSale(saleNumber);
    if (s.status !== 'active') throw conflict('INVALID_STATUS', 'Venda cancelada não admite devolução');
    return {
      saleNumber, local: false, customerIdentified: false,
      items: (s.items as Record<string, any>[]).map((i) => ({ itemNumber: i.item_number, productId: i.product_id, description: i.description, quantity: D(i.quantity).toString(),
        returned: D(i.returned_quantity).toString(), unitTotal: D(i.total).dividedBy(i.quantity).toString() })),
    };
  }

  private returnedQty(saleNumber: string, itemNumber: number): string {
    return this.d.db.all<{ items: string }>(`SELECT items FROM returns WHERE sale_number = ?`, [saleNumber])
      .flatMap((r) => JSON.parse(r.items) as { itemNumber: number; quantity: string }[])
      .filter((i) => i.itemNumber === itemNumber).reduce((a, i) => a.plus(i.quantity), D(0)).toString();
  }

  async create(op: Operator, input: {
    saleNumber: string; items: { itemNumber: number; quantity: string }[]; reason: string; refundMethod: 'cash' | 'pix' | 'card' | 'store_credit';
    customer?: { taxId: string; name: string } | null; reference: string;
  }, online: boolean, auth?: Authorization | null) {
    const done = this.d.db.get(`SELECT * FROM returns WHERE reference = ?`, [input.reference]);
    if (done) return done;
    if (!input.reason || input.reason.trim().length < 5) throw invalid('Informe o motivo da devolução');
    if (!input.items.length) throw invalid('Selecione os itens devolvidos');
    const session = this.d.cash.requireOpen();
    const info = await this.returnable(input.saleNumber, online);
    if (!info.customerIdentified && !input.customer) throw invalid('Venda sem cliente identificado: informe nome e CPF de quem devolve (exigido na nota de entrada)');
    let total = D(0);
    for (const i of input.items) {
      const it = info.items.find((x) => x.itemNumber === i.itemNumber);
      if (!it) throw invalid(`Item ${i.itemNumber} não existe na venda`);
      if (D(i.quantity).lessThanOrEqualTo(0) || D(i.quantity).greaterThan(D(it.quantity).minus(it.returned))) {
        throw invalid(`Item ${i.itemNumber}: quantidade maior que a vendida e ainda não devolvida`);
      }
      total = total.plus(roundMoney(D(it.unitTotal).times(i.quantity)));
    }
    const approver = await this.d.auth.require(op, P.authorizeReturn, auth, `Devolução da venda ${input.saleNumber}`, { total: total.toFixed(2) });
    const sale = this.d.db.get<{ id: string }>(`SELECT id FROM sales WHERE number = ?`, [input.saleNumber]) ?? null;
    if (input.refundMethod === 'cash' && total.greaterThan(this.d.cash.summary(session.id).expected.cash)) throw invalid('Dinheiro insuficiente na gaveta para o reembolso');
    // Reembolso eletrônico pelo mesmo meio da venda (só para venda deste terminal, onde está a transação)
    if (input.refundMethod === 'pix' || input.refundMethod === 'card') {
      if (!sale) throw invalid('Venda de outro terminal: reembolse em dinheiro ou crédito em loja (o estorno eletrônico é feito no terminal de origem)');
      const pay = this.d.sales.payments(sale.id).find((p) => p.status === 'approved' && (input.refundMethod === 'pix' ? p.method === 'pix' : p.method !== 'cash' && p.method !== 'pix'));
      if (!pay) throw invalid(`A venda não foi paga com ${input.refundMethod === 'pix' ? 'Pix' : 'cartão'}`);
      const r = await this.d.providers[pay.method].refund(pay.transaction_id ?? '', total.toFixed(2));
      if (r.status !== 'refunded') throw new PdvError('REFUND_FAILED', r.message, 422);
    }
    const id = uuid();
    const now = this.d.clock.now().toISOString();
    return this.d.db.tx(() => {
      this.d.db.run(`INSERT INTO returns (id, reference, sale_id, sale_number, items, reason, refund_method, total, customer, session_id, operator_id, authorized_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, input.reference, sale?.id ?? null, input.saleNumber, JSON.stringify(input.items), input.reason.trim(), input.refundMethod, total.toFixed(2), input.customer ? JSON.stringify({ name: input.customer.name }) : null,
          session.id, op.id, approver?.id ?? null, now]);
      this.d.queue.enqueue('return', 'return', id, {
        establishmentId: this.d.establishmentId(), pdvId: this.d.terminalCode, reference: input.reference, saleId: input.saleNumber, items: input.items, reason: input.reason.trim(),
        refundMethod: input.refundMethod, customer: input.customer ?? null, occurredAt: now, operatorId: op.id, authorizedBy: approver?.id ?? null,
      });
      this.d.audit.record({ userId: op.id, action: 'DEVOLUCAO', entity: 'sale', entityId: sale?.id ?? input.saleNumber, metadata: { reference: input.reference, items: input.items, total: total.toFixed(2),
        refundMethod: input.refundMethod, reason: input.reason.trim(), authorizedBy: approver?.id ?? null } });
      return this.d.db.get(`SELECT * FROM returns WHERE id = ?`, [id]);
    });
  }
}
