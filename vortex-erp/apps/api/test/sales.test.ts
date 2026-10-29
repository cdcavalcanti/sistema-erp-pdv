import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import { isValidAccessKey, parseAccessKey } from '@vortex/validators';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { SimulatedFiscalGateway } from '../src/modules/fiscal-docs/gateway.js';
import { MemoryMailer } from '../src/core/mailer.js';
import { drain } from '../src/worker/runner.js';
import { createUser, getWorkerDeps, makeApp, makeCnpj, setupTenant, type Client, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let gw: SimulatedFiscalGateway;
let customerId: string;
let productId: string;
let terms: Record<string, string>;
let methods: Record<string, string>;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);

async function newProduct(sku: string, price: string, stock: string, cost: string, extra: Record<string, unknown> = {}) {
  const p = await t.admin.post('/v1/products', { sku, description: `Produto ${sku}`, ncm: '61091000', minMarginPercent: '10', ...extra });
  const list = (await t.admin.get('/v1/price-lists')).body.find((l: any) => l.is_default);
  await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId: p.body.id, price });
  if (D(stock).greaterThan(0)) await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p.body.id, type: 'opening', quantity: stock, unitCost: cost, sourceType: 'test' }));
  return p.body.id as string;
}

async function balance(pid: string) {
  return (await t.admin.get('/v1/stock/balances', { productId: pid })).body[0];
}

async function order(client: Client, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return client.post('/v1/sales/orders', { establishmentId: t.establishmentId, partyId: customerId, paymentTermId: terms['30/60'], paymentMethodId: methods.BOLETO, items, ...extra });
}

beforeAll(async () => {
  app = await makeApp();
  gw = app.deps.services.fiscalGateway as SimulatedFiscalGateway;
  t = await setupTenant(app, { regime: 'lucro_presumido' });
  await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true });
  terms = Object.fromEntries((await t.admin.get('/v1/payment-terms')).body.map((x: any) => [x.code, x.id]));
  methods = Object.fromEntries((await t.admin.get('/v1/payment-methods')).body.map((x: any) => [x.code, x.id]));
  const cli = await t.admin.post('/v1/parties', {
    kind: 'PJ', taxId: makeCnpj(), legalName: 'Magazine Cliente LTDA', roles: ['customer'], ieIndicator: 1, ie: '110.042.490.114', creditLimit: '50000',
    xmlEmail: 'fiscal@cliente.test', addresses: [{ kind: 'fiscal', zip: '01310100', street: 'Av. Paulista', number: '1000', district: 'Bela Vista', cityIbge: '3550308', cityName: 'São Paulo', uf: 'SP' }],
  });
  customerId = cli.body.id;
  productId = await newProduct('CAMISA-P', '100.00', '100', '40.00');
});
afterAll(async () => app.close());

describe('Pedido → faturamento → NF-e (seção 10, ordem do MVP)', () => {
  it('faturamento numa transação: NF-e autorizada, estoque baixado, títulos 30/60, contábil balanceado, RN-VEN-06 comissão, RN-NFE-08 XML guardado, RN-NFE-10 envio ao destinatário e RN-VEN-04 pedido faturado imutável', async () => {
    const vendedor = await t.admin.post('/v1/parties', { kind: 'PF', taxId: '111.444.777-35', legalName: 'Vendedor', roles: ['salesperson'], addresses: [] });
    await t.admin.patch(`/v1/products/${productId}`, { version: (await t.admin.get(`/v1/products/${productId}`)).body.version, commissionPercent: '3' });
    const o = await order(t.admin, [{ productId, quantity: 10 }], { salespersonId: vendedor.body.id });
    expect(o.status).toBe(201);
    expect(o.body.status).toBe('approved');
    expect(o.body.total).toBe('1000.00');
    expect((await balance(productId)).reserved).toBe('10.0000');

    const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
    expect(inv.status).toBe(200);
    expect(inv.body.transmission.status).toBe('autorizada');
    const doc = (await t.admin.get(`/v1/fiscal/documents/${inv.body.document.id}`)).body;
    expect(doc.status).toBe('autorizada');
    expect(isValidAccessKey(doc.access_key)).toBe(true);
    expect(doc.number).toBe('1');
    expect(doc.items[0].cfop).toBe('6102');
    // PE → SP: 12%; presumido: PIS/Cofins sobre (1000 − 120)
    expect(doc.total_icms).toBe('120.00');
    expect(doc.total_pis).toBe('5.72');
    expect(doc.items[0].taxes.find((x: any) => x.tax === 'CBS').details.informative).toBe(true);
    expect(doc.items[0].tax_memory.length).toBeGreaterThan(3);
    // Estoque e custo
    const b = await balance(productId);
    expect(b.quantity).toBe('90.0000');
    expect(b.reserved).toBe('0.0000');
    expect(doc.items[0].unit_cost).toBe('40.0000000000');
    // Títulos 30/60
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'receivable', partyId: customerId })).body.items;
    const mine = titles.filter((x: any) => x.fiscal_document_id === doc.id).sort((a: any, b: any) => a.installment - b.installment);
    expect(mine.map((x: any) => x.amount)).toEqual(['500.00', '500.00']);
    // Pedido faturado e comissão
    expect((await t.admin.get(`/v1/sales/orders/${o.body.id}`)).body.status).toBe('invoiced');
    const comm = (await t.admin.get('/v1/sales/commissions', { salespersonId: vendedor.body.id })).body;
    expect(comm.totalReleased).toBe('30.00');
    // Contábil: lançamento de venda balanceado com receita, impostos e CMV
    const entries = await run((tx) => tx.query(`SELECT e.event_type, sum(l.debit) AS d, sum(l.credit) AS c FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id = e.id WHERE e.origin_id = $1 GROUP BY e.id`, [doc.id]));
    expect(entries[0].event_type).toBe('venda_faturada');
    expect(entries[0].d).toBe(entries[0].c);
    const cmv = await run((tx) => tx.one(`SELECT l.debit FROM accounting.journal_lines l JOIN accounting.chart_of_accounts a ON a.id = l.account_id JOIN accounting.journal_entries e ON e.id = l.entry_id WHERE e.origin_id = $1 AND a.code = '4.1'`, [doc.id]));
    expect(cmv.debit).toBe('400.00');
    // RN-NFE-08: XML autorizado guardado e acessível
    const xml = await t.admin.get(`/v1/fiscal/documents/${doc.id}/xml`);
    expect(String(xml.body)).toContain('<nfeProc');
    expect(String(xml.body)).toContain('<IBSCBS>');
    // RN-NFE-10: envio ao destinatário pelo job
    await drain(getWorkerDeps(app));
    const mailer = app.deps.services.mailer as MemoryMailer;
    expect(mailer.sent.some((m) => m.to === 'fiscal@cliente.test' && m.attachments?.some((a) => a.filename.endsWith('.xml')))).toBe(true);
    // RN-VEN-04: pedido faturado não pode ser alterado
    const edit = await t.admin.put(`/v1/sales/orders/${o.body.id}/items`, { version: 99, items: [{ productId, quantity: 1 }] });
    expect(edit.status).toBe(409);
  });

  it('RN-VEN-01 faturamento parcial: saldo a faturar = pedida − faturada − cancelada', async () => {
    const o = await order(t.admin, [{ productId, quantity: 10 }]);
    const item = o.body.items[0];
    const inv1 = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, { items: [{ orderItemId: item.id, quantity: 4 }] });
    expect(inv1.body.transmission.status).toBe('autorizada');
    let ord = (await t.admin.get(`/v1/sales/orders/${o.body.id}`)).body;
    expect(ord.status).toBe('partially_invoiced');
    expect(ord.items[0].quantity_to_invoice).toBe('6.0000');
    const over = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, { items: [{ orderItemId: item.id, quantity: 7 }] });
    expect(over.status).toBe(422);
    expect(over.body.details.rule).toBe('RN-VEN-01');
    const cancel = await t.admin.post(`/v1/sales/orders/${o.body.id}/cancel`, { reason: 'Cliente desistiu do restante do pedido' });
    expect(cancel.body.status).toBe('invoiced');
    ord = (await t.admin.get(`/v1/sales/orders/${o.body.id}`)).body;
    expect(ord.items[0].quantity_cancelled).toBe('6.0000');
    expect(ord.invoices).toHaveLength(1);
  });

  it('RN-VEN-02 limite de crédito bloqueia e o gerente aprova', async () => {
    const big = await newProduct('TV', '30000.00', '10', '20000');
    const cli = await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Cliente Limite Baixo', roles: ['customer'], creditLimit: '5000',
      addresses: [{ kind: 'fiscal', zip: '01310100', street: 'Av. Paulista', number: '1', district: 'Bela Vista', cityIbge: '3550308', cityName: 'São Paulo', uf: 'SP' }] });
    const o = await order(t.admin, [{ productId: big, quantity: 2 }], { partyId: cli.body.id });
    expect(o.body.status).toBe('pending_approval');
    expect(o.body.approvals.map((a: any) => a.reason_code)).toContain('limite_credito');
    expect((await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {})).status).toBe(409);
    const ger = await createUser(app, t, ['gerente']);
    const ap = await ger.post(`/v1/approvals/${o.body.approvals.find((a: any) => a.reason_code === 'limite_credito').id}/decision`, { decision: 'approve' });
    expect(ap.body.status).toBe('approved');
    expect((await t.admin.get(`/v1/sales/orders/${o.body.id}`)).body.status).toBe('approved');
  });

  it('alçada de desconto (vendedor 5%) e RN-PRE-03 margem mínima', async () => {
    const vend = await createUser(app, t, ['vendedor']);
    const o = await order(vend, [{ productId, quantity: 1, discountPercent: '8' }]);
    expect(o.body.status).toBe('pending_approval');
    expect(o.body.approvals.map((a: any) => a.reason_code)).toContain('desconto_alcada');
    const o2 = await order(vend, [{ productId, quantity: 1, unitPrice: '39.00' }]);
    expect(o2.body.approvals.map((a: any) => a.reason_code)).toContain('abaixo_custo');
    const o3 = await order(vend, [{ productId, quantity: 1, discountPercent: '4' }]);
    expect(o3.body.status).toBe('approved');
  });

  it('RN-NFE-03 rejeição volta com explicação em português e mantém o número; correção e reenvio', async () => {
    const p = await newProduct('REJ-1', '50.00', '10', '20');
    gw.rejectWhen = (_doc, raw) => (raw.includes('REJ-1') ? { code: '778', message: 'Informado NCM inexistente' } : null);
    const o = await order(t.admin, [{ productId: p, quantity: 1 }]);
    const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
    expect(inv.body.transmission.status).toBe('rejeitada');
    expect(inv.body.transmission.explanation).toMatch(/NCM/);
    const docId = inv.body.document.id;
    const number = inv.body.document.number;
    gw.rejectWhen = () => null;
    const again = await t.admin.post(`/v1/fiscal/documents/${docId}/transmit`);
    expect(again.body.transmission.status).toBe('autorizada');
    expect((await t.admin.get(`/v1/fiscal/documents/${docId}`)).body.number).toBe(number);
  });

  it('RN-NFE-07 / RN-GER-10 contingência SVC quando a SEFAZ autorizadora cai', async () => {
    gw.offline = true;
    const o = await order(t.admin, [{ productId, quantity: 1 }]);
    const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
    gw.offline = false;
    expect(inv.body.transmission.status).toBe('autorizada');
    const doc = (await t.admin.get(`/v1/fiscal/documents/${inv.body.document.id}`)).body;
    // PE usa SVC-RS (tpEmis 7); a chave muda com o tipo de emissão
    expect(doc.emission_type).toBe(7);
    expect(parseAccessKey(doc.access_key).tpEmis).toBe('7');
    expect(doc.events.some((e: any) => e.kind === 'contingency')).toBe(true);
  });

  it('RN-NFE-04 denegação encerra a numeração e devolve os itens ao pedido (estoque e títulos estornados)', async () => {
    const before = (await balance(productId)).quantity;
    gw.denyWhen = () => ({ code: '302', message: 'Uso Denegado: Irregularidade fiscal do destinatário' });
    const o = await order(t.admin, [{ productId, quantity: 2 }]);
    const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
    gw.denyWhen = () => null;
    expect(inv.body.transmission.status).toBe('denegada');
    expect((await balance(productId)).quantity).toBe(before);
    const ord = (await t.admin.get(`/v1/sales/orders/${o.body.id}`)).body;
    expect(ord.items[0].quantity_to_invoice).toBe('2.0000');
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'receivable' })).body.items.filter((x: any) => x.fiscal_document_id === inv.body.document.id);
    expect(titles.every((x: any) => x.status === 'cancelled')).toBe(true);
    const cancel = await t.admin.post(`/v1/fiscal/documents/${inv.body.document.id}/cancellation`, { reason: 'Tentativa de cancelar nota denegada', goodsDidNotCirculate: true });
    expect(cancel.status).toBe(409);
  });

  it('RN-NFE-05 cancelamento estorna estoque, títulos e contábil', async () => {
    const before = (await balance(productId)).quantity;
    const o = await order(t.admin, [{ productId, quantity: 3 }]);
    const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
    const docId = inv.body.document.id;
    expect((await balance(productId)).quantity).toBe(D(before).minus(3).toFixed(4));
    const circulou = await t.admin.post(`/v1/fiscal/documents/${docId}/cancellation`, { reason: 'Cliente desistiu da compra', goodsDidNotCirculate: false });
    expect(circulou.status).toBe(422);
    const c = await t.admin.post(`/v1/fiscal/documents/${docId}/cancellation`, { reason: 'Cliente desistiu da compra antes da saída', goodsDidNotCirculate: true });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('cancelada');
    expect((await balance(productId)).quantity).toBe(before);
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'receivable' })).body.items.filter((x: any) => x.fiscal_document_id === docId);
    expect(titles.every((x: any) => x.status === 'cancelled')).toBe(true);
    const bal = await run((tx) => tx.one(`SELECT sum(l.debit) - sum(l.credit) AS net, count(DISTINCT e.id)::int AS n FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id = e.id
      JOIN accounting.chart_of_accounts a ON a.id = l.account_id WHERE e.origin_id = $1 AND a.code = '3.1'`, [docId]));
    expect(bal.n).toBe(2);
    expect(bal.net).toBe('0.00');
    // Documento cancelado é imutável
    await expect(run((tx) => tx.exec(`UPDATE fiscal.documents SET total_invoice = 1 WHERE id = $1`, [docId]))).rejects.toThrow(/não pode ser alterado/);
  });

  it('RN-NFE-06 carta de correção: campos permitidos, consolidação das correções e bloqueio de valores', async () => {
    const o = await order(t.admin, [{ productId, quantity: 1 }]);
    const docId = (await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {})).body.document.id;
    const bad = await t.admin.post(`/v1/fiscal/documents/${docId}/correction-letter`, { corrections: [{ field: 'valor', text: 'Corrigir valor para 90' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.details.rule).toBe('RN-NFE-06');
    const c1 = await t.admin.post(`/v1/fiscal/documents/${docId}/correction-letter`, { corrections: [{ field: 'dados_adicionais', text: 'Pedido do cliente 4321' }] });
    expect(c1.body.sequence).toBe(1);
    const c2 = await t.admin.post(`/v1/fiscal/documents/${docId}/correction-letter`, { corrections: [{ field: 'volumes', text: '2 caixas, 3,5 kg' }] });
    expect(c2.body.sequence).toBe(2);
    expect(c2.body.text).toContain('Pedido do cliente 4321');
    expect(c2.body.text).toContain('2 caixas');
  });

  it('RN-NFE-01 inutilização de número abandonado após rejeição', async () => {
    const p = await newProduct('ABAND', '10.00', '5', '5');
    gw.rejectWhen = (_d, raw) => (raw.includes('ABAND') ? { code: '233', message: 'IE do destinatário não cadastrada' } : null);
    const o = await order(t.admin, [{ productId: p, quantity: 1 }]);
    const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
    gw.rejectWhen = () => null;
    const n = Number(inv.body.document.number);
    const gaps = (await t.admin.get('/v1/fiscal/numbering-gaps')).body;
    expect(gaps.some((g: any) => Number(g.number) === n)).toBe(true);
    const r = await t.admin.post('/v1/fiscal/inutilizations', { establishmentId: t.establishmentId, model: '55', series: 1, from: n, to: n, reason: 'Nota rejeitada e abandonada pelo usuário' });
    expect(r.status).toBe(201);
    expect((await t.admin.get(`/v1/fiscal/documents/${inv.body.document.id}`)).body.status).toBe('inutilizada');
    expect((await balance(p)).quantity).toBe('5.0000');
    const used = await t.admin.post('/v1/fiscal/inutilizations', { establishmentId: t.establishmentId, model: '55', series: 1, from: 1, to: 1, reason: 'Tentando inutilizar número já autorizado' });
    expect(used.status).toBe(409);
  });

  it('RN-NFE-09 devolução item a item limitada ao saldo, tributos espelhados, estoque e título abatidos', async () => {
    const o = await order(t.admin, [{ productId, quantity: 5 }]);
    const docId = (await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {})).body.document.id;
    const doc = (await t.admin.get(`/v1/fiscal/documents/${docId}`)).body;
    const before = (await balance(productId)).quantity;
    const ret = await t.admin.post('/v1/sales/returns', { originalDocumentId: docId, items: [{ originalItemId: doc.items[0].id, quantity: 2 }], reason: 'Produto com defeito',
      destination: 'normal', financialTreatment: 'abatement', issuer: 'own' });
    expect(ret.status).toBe(201);
    expect(ret.body.transmission.status).toBe('autorizada');
    const rdoc = (await t.admin.get(`/v1/fiscal/documents/${ret.body.documentId}`)).body;
    expect(rdoc.purpose).toBe(4);
    expect(rdoc.items[0].cfop).toBe('2202');
    expect(rdoc.references[0].referenced_access_key).toBe(doc.access_key);
    // tributos espelhados: 2/5 do ICMS original
    expect(rdoc.items[0].taxes.find((x: any) => x.tax === 'ICMS').value).toBe(D(doc.items[0].taxes.find((x: any) => x.tax === 'ICMS').value).times(2).dividedBy(5).toFixed(2));
    expect((await balance(productId)).quantity).toBe(D(before).plus(2).toFixed(4));
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'receivable' })).body.items.filter((x: any) => x.fiscal_document_id === docId);
    expect(D(titles.reduce((a: string, x: any) => D(a).plus(x.balance).toFixed(2), '0')).toFixed(2)).toBe(D(doc.total_invoice).minus(rdoc.total_invoice).toFixed(2));
    const over = await t.admin.post('/v1/sales/returns', { originalDocumentId: docId, items: [{ originalItemId: doc.items[0].id, quantity: 4 }], reason: 'Teste de excesso',
      destination: 'normal', financialTreatment: 'store_credit', issuer: 'own' });
    expect(over.status).toBe(422);
    expect(over.body.details.rule).toBe('RN-NFE-09');
  });

  it('orçamento com total real (impostos) e aceite online pelo link', async () => {
    const q = await t.admin.post('/v1/sales/quotes', { establishmentId: t.establishmentId, partyId: customerId, items: [{ productId, quantity: 2 }] });
    expect(q.status).toBe(201);
    expect(q.body.total).toBe('200.00');
    expect(Number(q.body.total_taxes)).toBeGreaterThan(0);
    const pub = await app.inject({ method: 'GET', url: q.body.acceptLink });
    expect(pub.json().items).toHaveLength(1);
    const acc = await app.inject({ method: 'POST', url: q.body.acceptLink.replace('?', '/accept?'), payload: { name: 'João Comprador' } });
    expect(acc.json().accepted).toBe(true);
    const conv = await t.admin.post(`/v1/sales/quotes/${q.body.id}/convert`);
    expect(conv.status).toBe(201);
    expect(conv.body.quote_id).toBe(q.body.id);
  });

  it('idempotência no faturamento: repetir não gera segunda nota', async () => {
    const o = await order(t.admin, [{ productId, quantity: 1 }]);
    const a = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {}, { 'idempotency-key': `fat-${o.body.id}` });
    const b = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {}, { 'idempotency-key': `fat-${o.body.id}` });
    expect(b.body.document.id).toBe(a.body.document.id);
    expect((await t.admin.get(`/v1/sales/orders/${o.body.id}`)).body.invoices).toHaveLength(1);
  });
});

describe('Etapas do pedido: pedido → aprovado → separação → conferido → faturado → despachado → entregue', () => {
  it('cada ação avança uma etapa, com data na linha do tempo; despacho só com NF-e; cancelamento antes de faturar', async () => {
    const pid = await newProduct('ETAPA-1', '50.00', '30', '20.00', { gtin: '7891000315507' });
    const created = await order(t.admin, [{ productId: pid, quantity: 3 }], { submit: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;
    const get = async () => (await t.admin.get(`/v1/sales/orders/${id}`)).body;
    expect((await get()).stage).toBe('open');

    expect((await t.admin.post(`/v1/sales/orders/${id}/submit`, {})).body.stage).toBe('approved');
    expect((await t.admin.post(`/v1/sales/orders/${id}/picking`, {})).status).toBe(201);
    expect((await get()).stage).toBe('to_pick');
    expect((await t.admin.post(`/v1/sales/orders/${id}/picking/start`, {})).body.stage).toBe('picking');
    // Não despacha sem nota
    const early = await t.admin.post(`/v1/sales/orders/${id}/ship`, { trackingCode: 'BR123' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVOICE_REQUIRED');
    expect((await t.admin.post(`/v1/sales/orders/${id}/picking/check-all`, { volumes: 2 })).body.stage).toBe('checked');
    const inv = await t.admin.post(`/v1/sales/orders/${id}/invoice`, {});
    expect(inv.body.transmission.status).toBe("autorizada");
    expect((await get()).stage).toBe('invoiced');
    expect((await t.admin.post(`/v1/sales/orders/${id}/ship`, { trackingCode: 'BR123456789' })).body.stage).toBe('shipped');
    const delivered = (await t.admin.post(`/v1/sales/orders/${id}/deliver`, { receiverName: 'Portaria — João' })).body;
    expect(delivered.stage).toBe('delivered');
    expect(delivered.timeline.map((x: any) => x.stage)).toEqual(['open', 'approved', 'to_pick', 'picking', 'checked', 'invoiced', 'shipped', 'delivered']);
    expect(delivered.timeline.every((x: any) => x.at)).toBe(true);
    expect(delivered.shipments.at(-1)).toMatchObject({ tracking_code: 'BR123456789', delivery_receiver: 'Portaria — João', volumes: 2 });

    // Lista por etapa e quadro de contagens
    const list = (await t.admin.get('/v1/sales/orders', { stage: 'delivered' })).body.items;
    expect(list.map((x: any) => x.id)).toContain(id);
    const stages = (await t.admin.get('/v1/sales/orders/stages')).body;
    expect(stages.find((x: any) => x.stage === 'delivered').orders).toBeGreaterThanOrEqual(1);

    // Cancelamento antes de faturar: etapa cancelada, com data
    const other = (await order(t.admin, [{ productId: pid, quantity: 1 }])).body;
    await t.admin.post(`/v1/sales/orders/${other.id}/picking`, {});
    const cancelled = (await t.admin.post(`/v1/sales/orders/${other.id}/cancel`, { reason: 'Cliente desistiu da compra por telefone' })).body;
    expect(cancelled.stage).toBe('cancelled');
    expect(cancelled.timeline.at(-1)).toMatchObject({ stage: 'cancelled', at: expect.anything() });
  });
});

describe('Apuração de impostos (painel fiscal)', () => {
  it('valor por CFOP e por UF soma cada item uma vez, mesmo com vários tributos por item', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const a = (await t.admin.get('/v1/fiscal/assessment', { from: today, to: today })).body;
    expect(a.regime).toBe('lucro_presumido');
    const real = await run((tx) => tx.one<{ amount: string; icms: string }>(
      `SELECT coalesce(sum(i.total - i.discount), 0) AS amount,
              coalesce((SELECT sum(x.value) FROM fiscal.document_item_taxes x JOIN fiscal.document_items y ON y.id = x.document_item_id JOIN fiscal.documents z ON z.id = y.document_id
                         WHERE x.tax = 'ICMS' AND z.direction = 'S' AND z.purpose = 1 AND z.issuer_kind = 'own' AND z.status IN ('autorizada', 'contingencia') AND z.tax_date = $1), 0) AS icms
         FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id
        WHERE d.direction = 'S' AND d.purpose = 1 AND d.issuer_kind = 'own' AND d.status IN ('autorizada', 'contingencia') AND d.tax_date = $1`, [today]));
    expect(D(real.amount).greaterThan(0)).toBe(true);
    const sumOf = (rows: any[], k: string) => rows.reduce((s, r) => s.plus(r[k]), D(0)).toFixed(2);
    expect(sumOf(a.byCfop, 'amount')).toBe(D(real.amount).toFixed(2));
    expect(sumOf(a.byUf, 'amount')).toBe(D(real.amount).toFixed(2));
    expect(sumOf(a.byCfop, 'icms')).toBe(D(real.icms).toFixed(2));
  });
});
