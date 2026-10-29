import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { D } from '@vortex/money';
import { isValidAccessKey, parseAccessKey } from '@vortex/validators';
import { login, makePdv, PRODUCT, SUP, type TestPdv } from './helpers.js';
import type { Operator } from '../src/security/permissions.js';

let t: TestPdv;
let ana: Operator;
const key = () => randomUUID();

async function openSale(amount = '100.00') {
  await t.pdv.cash.open(ana, amount);
  return t.pdv.sales.start(ana);
}

beforeEach(async () => {
  t = await makePdv();
  ana = await login(t, 'ana');
});

describe('Venda (seção 53): produto, quantidade, desconto, cliente, cancelamento', () => {
  it('não vende com caixa fechado; produto único pelo código de barras com feedback no display', async () => {
    expect(() => t.pdv.sales.start(ana)).toThrow(/Caixa fechado/);
    const s = await openSale();
    const v = await t.pdv.sales.addItem(ana, s.id, { code: '7891234567895' });
    expect(v.items).toHaveLength(1);
    expect(v.sale).toMatchObject({ number: 'PDV-03-20261027-000001', total: '24.90', status: 'open' });
    expect((t.pdv.display as any).lines[0]).toContain('Café torrado');
  });

  it('vários produtos: SKU, referência, quantidade antes do código, caixa (GTIN da embalagem) e reler incrementa', async () => {
    const s = await openSale();
    await t.pdv.sales.addItem(ana, s.id, { code: 'CAMISETA' });
    await t.pdv.sales.addItem(ana, s.id, { code: 'REF-77' });
    let v = await t.pdv.sales.addItem(ana, s.id, { code: '2*7891234567895' });
    expect(v.items.map((i) => [i.sku, i.quantity])).toEqual([['CAMISETA', '2'], ['CAFE-500', '2']]);
    v = await t.pdv.sales.addItem(ana, s.id, { code: '17891234567892' });
    expect(v.items.find((i) => i.sku === 'CAFE-500')!.quantity).toBe('14');
    expect(v.sale.total).toBe(D('2').times('49.90').plus(D('14').times('24.90')).toFixed(2));
    v = await t.pdv.sales.setQuantity(ana, s.id, v.items[1]!.id, '3');
    expect(v.sale.total).toBe('174.50');
    await expect(t.pdv.sales.setQuantity(ana, s.id, v.items[1]!.id, '1.5')).rejects.toThrow(/quantidade inteira/);
  });

  it('produto não encontrado não trava a venda', async () => {
    const s = await openSale();
    await expect(t.pdv.sales.addItem(ana, s.id, { code: '0000000000000' })).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND', status: 404 });
    expect((await t.pdv.sales.addItem(ana, s.id, { code: 'CAMISETA' })).items).toHaveLength(1);
  });

  it('pesável: balança estável; etiqueta com preço calcula o peso; peso instável é recusado', async () => {
    const s = await openSale();
    t.scale.weight = '0.355';
    let v = await t.pdv.sales.addItem(ana, s.id, { code: '123' });
    expect(v.items[0]).toMatchObject({ quantity: '0.355', weighed: 1, unit: 'KG' });
    expect(v.sale.total).toBe('6.00');
    // Etiqueta 2 00123 001690 C: R$ 16,90 → 1 kg
    const body = '200123001690';
    let sum = 0;
    body.split('').reverse().forEach((d, i) => (sum += Number(d) * (i % 2 === 0 ? 3 : 1)));
    v = await t.pdv.sales.addItem(ana, s.id, { code: body + ((10 - (sum % 10)) % 10) });
    expect(v.items[1]).toMatchObject({ quantity: '1.000', weighed: 1 });
    t.scale.stable = false;
    await expect(t.pdv.sales.addItem(ana, s.id, { code: '123' })).rejects.toMatchObject({ code: 'SCALE_UNSTABLE' });
  });

  it('estoque: aviso por padrão; bloqueio quando o ERP configura', async () => {
    const s = await openSale();
    const v = await t.pdv.sales.addItem(ana, s.id, { code: '3*CAMISETA' });
    expect(v.warnings[0]).toMatch(/sem estoque suficiente/);
    t.erp.settings = { stock: { outOfStock: 'block' } };
    await t.pdv.sync.runOnce({ full: true });
    await expect(t.pdv.sales.addItem(ana, s.id, { code: 'CAMISETA' })).rejects.toMatchObject({ code: 'STOCK_BLOCKED' });
  });

  it('desconto: dentro da alçada do operador; acima exige supervisor; acima da alçada do supervisor é negado; tudo auditado', async () => {
    const s = await openSale();
    let v = await t.pdv.sales.addItem(ana, s.id, { code: '2*CAMISETA' });
    v = await t.pdv.sales.itemDiscount(ana, s.id, v.items[0]!.id, { kind: 'percent', value: '5' });
    expect(v.sale.total).toBe('94.81');
    await expect(t.pdv.sales.saleDiscount(ana, s.id, { kind: 'value', value: '10' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED', details: { permission: 'pdv.desconto.autorizar' } });
    v = await t.pdv.sales.saleDiscount(ana, s.id, { kind: 'value', value: '10' }, SUP);
    expect(v.sale).toMatchObject({ total: '84.81', discount_total: '14.99' });
    await expect(t.pdv.sales.saleDiscount(ana, s.id, { kind: 'percent', value: '20' }, SUP)).rejects.toThrow(/acima da alçada de Sérgio/);
    expect(t.pdv.audit.list({ entityId: s.id }).filter((e) => e.action === 'DESCONTO')).toHaveLength(2);
    expect(t.pdv.audit.list({ action: 'AUTORIZACAO' })[0]).toMatchObject({ user_id: expect.any(String), entity_id: ana.id, metadata: { permission: 'pdv.desconto.autorizar' } });
  });

  it('cliente: CPF do cadastro do ERP (documento cifrado no banco local) ou cadastro rápido que vai para a fila', async () => {
    const s = await openSale();
    await t.pdv.sales.addItem(ana, s.id, { code: 'CAMISETA' });
    const found = await t.pdv.customers.search('529.982.247-25', false);
    expect(found[0]).toMatchObject({ name: 'Maria das Graças', taxIdMasked: '***.982.247-**' });
    const raw = t.pdv.db.get<{ tax_id_enc: string }>(`SELECT tax_id_enc FROM customers WHERE id = ?`, [found[0]!.id])!;
    expect(raw.tax_id_enc).not.toContain('52998224725');
    expect(t.pdv.sales.setCustomer(ana, s.id, found[0]!.id).sale.customer).toMatchObject({ name: 'Maria das Graças' });
    expect(() => t.pdv.customers.create({ taxId: '111.111.111-11', name: 'X' })).toThrow(/CPF\/CNPJ inválido/);
    const novo = t.pdv.customers.create({ taxId: '153.509.460-56', name: 'João Novo' });
    expect(novo.pending).toBe(true);
    expect(t.pdv.queue.list().some((q) => q.type === 'customer' && q.entity_id === novo.id)).toBe(true);
  });

  it('cancelamento de item com motivo; venda em andamento descartada com motivo', async () => {
    const s = await openSale();
    let v = await t.pdv.sales.addItem(ana, s.id, { code: 'CAMISETA' });
    v = await t.pdv.sales.addItem(ana, s.id, { code: '7891234567895' });
    await expect(t.pdv.sales.cancelItem(ana, s.id, v.items[0]!.id, '')).rejects.toThrow(/motivo/);
    v = await t.pdv.sales.cancelItem(ana, s.id, v.items[0]!.id, 'Cliente desistiu');
    expect(v.sale.total).toBe('24.90');
    expect(v.items[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'Cliente desistiu' });
    v = await t.pdv.sales.cancelSale(ana, s.id, 'Cliente foi embora sem levar');
    expect(v.sale.status).toBe('discarded');
    expect(t.pdv.audit.list({ action: 'CANCELAMENTO_ITEM' })).toHaveLength(1);
  });

  it('cancelamento parcial: N unidades de um item, com motivo; a parte cancelada vai ao ERP junto com a venda', async () => {
    const s = await openSale();
    let v = await t.pdv.sales.addItem(ana, s.id, { code: '3*7891234567895' });
    expect(v.sale.total).toBe('74.70');
    const line = v.items[0]!;
    await expect(t.pdv.sales.cancelItem(ana, s.id, line.id, 'Cliente desistiu', null, '4')).rejects.toThrow(/não dá para cancelar 4/);
    await expect(t.pdv.sales.cancelItem(ana, s.id, line.id, 'Cliente desistiu', null, '1.5')).rejects.toThrow();
    v = await t.pdv.sales.cancelItem(ana, s.id, line.id, 'Cliente desistiu', null, '2');
    expect(v.sale.total).toBe('24.90');
    expect(v.items.map((i) => [i.seq, i.quantity, i.status, i.cancelled_from_seq])).toEqual([[1, '1', 'active', null], [2, '2', 'cancelled', 1]]);
    expect(t.pdv.audit.list({ action: 'CANCELAMENTO_ITEM' })[0]!.metadata).toMatchObject({ quantity: '2', partial: true, remaining: '1', reason: 'Cliente desistiu' });
    t.pdv.sales.finalize(ana, s.id);
    await t.pdv.sales.addPayment(ana, s.id, { method: 'cash', amount: '24.90', idempotencyKey: key() });
    await t.pdv.sales.complete(ana, s.id);
    const payload = t.pdv.sync.salePayload(s.id);
    expect(payload.items).toEqual([expect.objectContaining({ quantity: '1', unitPrice: '24.9' })]);
    expect(payload.cancelledItems).toEqual([expect.objectContaining({ sku: 'CAFE-500', quantity: '2', unitPrice: '24.9', reason: 'Cliente desistiu', partial: true, operatorId: ana.id })]);
  });
});

describe('Pagamento (seção 53): dinheiro, Pix, cartão, múltiplos, recusa e timeout', () => {
  it('dinheiro com troco → NFC-e autorizada → comprovante com gaveta → fila do ERP', async () => {
    const s = await openSale();
    await t.pdv.sales.addItem(ana, s.id, { code: '7891234567895' });
    t.pdv.sales.finalize(ana, s.id);
    await expect(t.pdv.sales.complete(ana, s.id)).rejects.toMatchObject({ code: 'NOT_PAID' });
    let v = await t.pdv.sales.addPayment(ana, s.id, { method: 'cash', amount: '50', idempotencyKey: key() });
    expect(v.payments[0]).toMatchObject({ status: 'approved', amount: '24.90', tendered: '50.00', change: '25.10' });
    const done = await t.pdv.sales.complete(ana, s.id);
    expect(done.sale).toMatchObject({ status: 'completed', change_total: '25.10', fiscal_status: 'authorized', sync_status: 'pending' });
    const f = done.fiscal as any;
    expect(isValidAccessKey(f.accessKey)).toBe(true);
    expect(parseAccessKey(f.accessKey)).toMatchObject({ modelo: '65', serie: 3, numero: 1, tpEmis: '1' });
    expect(f.qrUrl).toContain(`p=${f.accessKey}|2|2|1|`);
    // Comprovante (seção 21) e gaveta aberta no pagamento em dinheiro
    expect(done.receipt).toContain('Café torrado 500g');
    expect(done.receipt).toContain('Troco R$');
    expect(done.receipt).toContain('PDV-03-20261027-000001');
    expect(done.receipt).toContain('EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO');
    expect(t.pdv.queue.list().find((q) => q.type === 'sale')).toMatchObject({ status: 'PENDING', entity_id: s.id });
    v = t.pdv.sales.view(s.id);
    expect(v.sale.status).toBe('completed');
  });

  it('Pix só é pago com confirmação do PSP; QR Code expira (timeout) e pode gerar outro', async () => {
    const s = await openSale();
    await t.pdv.sales.addItem(ana, s.id, { code: 'CAMISETA' });
    t.pdv.sales.finalize(ana, s.id);
    let v = await t.pdv.sales.addPayment(ana, s.id, { method: 'pix', amount: '49.90', idempotencyKey: key() });
    const pay = v.payments[0]!;
    expect(pay.status).toBe('pending');
    expect(pay.qr_code).toMatch(/^000201/);
    // Mostrar o QR Code não paga nada
    v = await t.pdv.sales.pollPayment(ana, pay.id);
    expect(v.payments[0]!.status).toBe('pending');
    await expect(t.pdv.sales.complete(ana, s.id)).rejects.toMatchObject({ code: 'PAYMENT_PENDING' });
    t.clock.advance(301_000);
    v = await t.pdv.sales.pollPayment(ana, pay.id);
    expect(v.payments[0]!.status).toBe('timeout');
    v = await t.pdv.sales.addPayment(ana, s.id, { method: 'pix', amount: '49.90', idempotencyKey: key() });
    const p2 = v.payments.at(-1)!;
    expect(t.pix.pay(p2.transaction_id!)).toBe(true);
    v = await t.pdv.sales.pollPayment(ana, p2.id);
    expect(v.payments.at(-1)).toMatchObject({ status: 'approved' });
    expect((await t.pdv.sales.complete(ana, s.id)).sale.status).toBe('completed');
    expect(t.pdv.audit.list({ action: 'ERRO_PAGAMENTO' })).toHaveLength(1);
  });

  it('cartão TEF: aprovação com NSU (sem dados do cartão), recusa (,51), cancelado no pinpad (,53) e timeout (,52)', async () => {
    const s = await openSale();
    await t.pdv.sales.addItem(ana, s.id, { code: '4*CAMISETA' });
    t.pdv.sales.finalize(ana, s.id);
    for (const [amount, expected] of [['10.51', 'declined'], ['10.53', 'cancelled']] as const) {
      const v = await t.pdv.sales.addPayment(ana, s.id, { method: 'credit', amount, idempotencyKey: key() });
      expect((await t.pdv.sales.pollPayment(ana, v.payments.at(-1)!.id)).payments.at(-1)!.status).toBe(expected);
    }
    let v = await t.pdv.sales.addPayment(ana, s.id, { method: 'debit', amount: '10.52', idempotencyKey: key() });
    const slow = v.payments.at(-1)!;
    expect((await t.pdv.sales.pollPayment(ana, slow.id)).payments.at(-1)!.status).toBe('pending');
    t.clock.advance(91_000);
    expect((await t.pdv.sales.pollPayment(ana, slow.id)).payments.at(-1)!.status).toBe('timeout');
    v = await t.pdv.sales.addPayment(ana, s.id, { method: 'credit', amount: '199.60', installments: 3, idempotencyKey: key() });
    v = await t.pdv.sales.pollPayment(ana, v.payments.at(-1)!.id);
    expect(v.payments.at(-1)).toMatchObject({ status: 'approved', brand: 'VISA', installments: 3 });
    expect(v.payments.at(-1)!.nsu).toMatch(/^\d{6}$/);
    expect(JSON.stringify(t.pdv.db.all(`SELECT * FROM payments`))).not.toMatch(/\d{13,19}/);
    expect(t.pdv.audit.list({ action: 'ERRO_PAGAMENTO' })).toHaveLength(3);
  });

  it('múltiplos pagamentos (dinheiro + Pix + maquininha) fecham exatamente o total; duplo clique não paga duas vezes', async () => {
    const s = await openSale();
    await t.pdv.sales.addItem(ana, s.id, { code: '2*CAMISETA' });
    t.pdv.sales.finalize(ana, s.id);
    const k = key();
    await t.pdv.sales.addPayment(ana, s.id, { method: 'cash', amount: '30', idempotencyKey: k });
    let v = await t.pdv.sales.addPayment(ana, s.id, { method: 'cash', amount: '30', idempotencyKey: k });
    expect(v.payments).toHaveLength(1);
    expect(v.remaining).toBe('69.80');
    v = await t.pdv.sales.addPayment(ana, s.id, { method: 'pix', amount: '40', idempotencyKey: key() });
    await expect(t.pdv.sales.addPayment(ana, s.id, { method: 'pos_debit', amount: '29.80', idempotencyKey: key() })).rejects.toMatchObject({ code: 'PAYMENT_PENDING' });
    t.pix.pay(v.payments.at(-1)!.transaction_id!);
    await t.pdv.sales.pollPayment(ana, v.payments.at(-1)!.id);
    await expect(t.pdv.sales.addPayment(ana, s.id, { method: 'pos_debit', amount: '40', idempotencyKey: key() })).rejects.toThrow(/troco só em dinheiro/);
    v = await t.pdv.sales.addPayment(ana, s.id, { method: 'pos_debit', amount: '29.80', idempotencyKey: key() });
    expect(() => t.pdv.sales.confirmExternal(ana, v.payments.at(-1)!.id, { nsu: '1', authorization: '' })).toThrow(/NSU/);
    v = t.pdv.sales.confirmExternal(ana, v.payments.at(-1)!.id, { nsu: '004512', authorization: 'A1B2C3', brand: 'ELO' });
    expect(v.remaining).toBe('0.00');
    const done = await t.pdv.sales.complete(ana, s.id);
    expect(done.receipt).toMatch(/Dinheiro\s+30,00/);
    expect(done.receipt).toMatch(/Pix\s+40,00/);
    expect(done.receipt).toContain('ELO NSU 004512 AUT A1B2C3');
    expect(t.pdv.fiscal.get(s.id)!.xml).toContain('<tPag>17</tPag>');
  });

  it('identificação obrigatória acima do valor do ERP; voltar ao carrinho só sem pagamento', async () => {
    t.erp.settings = { sale: { customerRequiredAbove: '50.00' } };
    await t.pdv.sync.runOnce({ full: true });
    const s = await openSale();
    await t.pdv.sales.addItem(ana, s.id, { code: '2*CAMISETA' });
    expect(() => t.pdv.sales.finalize(ana, s.id)).toThrow(/identifique o consumidor/);
    t.pdv.sales.setCustomerTaxId(ana, s.id, '529.982.247-25', null);
    t.pdv.sales.finalize(ana, s.id);
    await t.pdv.sales.addPayment(ana, s.id, { method: 'cash', amount: '10', idempotencyKey: key() });
    expect(() => t.pdv.sales.backToCart(ana, s.id)).toThrow(/pagamento aprovado/);
    const done = await t.pdv.sales.addPayment(ana, s.id, { method: 'cash', amount: '89.80', idempotencyKey: key() });
    expect(done.remaining).toBe('0.00');
    const c = await t.pdv.sales.complete(ana, s.id);
    expect(t.pdv.fiscal.get(s.id)!.xml).toContain('<CPF>52998224725</CPF>');
    expect(c.receipt).toContain('***.982.247-**');
  });
});
