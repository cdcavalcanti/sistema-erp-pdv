import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { entryCost } from '../src/modules/purchasing/receiving.js';
import { MemoryMailer } from '../src/core/mailer.js';
import { SimulatedFiscalGateway } from '../src/modules/fiscal-docs/gateway.js';
import { drain } from '../src/worker/runner.js';
import { createUser, getWorkerDeps, makeApp, makeCnpj, setupTenant, type Client, type TenantFixture } from './helpers.js';
import { supplierNfe, type XmlItem } from './nfe-fixture.js';

// ------------------------------------------------------------------ XML de NF-e do fornecedor (fixture)

// ------------------------------------------------------------------ cenário

const ADDR = [{ kind: 'fiscal', zip: '01310100', street: 'Av. Paulista', number: '1000', district: 'Bela Vista', cityIbge: '3550308', cityName: 'São Paulo', uf: 'SP' }];

let app: App;
let t: TenantFixture;
let supplierId: string;
let supplierCnpj: string;
let carrierId: string;
let comprador: Client & { userId: string };
let gerente: Client & { userId: string };
let estoquista: Client & { userId: string };
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
/** EAN-13 válido a partir de 12 dígitos. */
function ean(base12: string): string {
  const sum = [...base12].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return base12 + ((10 - (sum % 10)) % 10);
}
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function newProduct(sku: string, extra: Record<string, unknown> = {}) {
  const p = await t.admin.post('/v1/products', { sku, description: `Produto ${sku}`, ncm: '61091000', ...extra });
  expect(p.status).toBe(201);
  return p.body.id as string;
}
async function balance(pid: string) {
  return (await t.admin.get('/v1/stock/balances', { productId: pid })).body[0];
}
async function avgCost(pid: string) {
  return run((tx) => tx.one<{ avg_cost: string; quantity: string }>(`SELECT avg_cost, quantity FROM inventory.product_costs WHERE product_id = $1`, [pid]));
}
async function po(client: Client, items: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return client.post('/v1/purchasing/orders', { establishmentId: t.establishmentId, supplierId, items, ...extra });
}
async function receive(client: Client, x: { xml: string }, extra: Record<string, unknown> = {}) {
  return client.post('/v1/purchasing/receipts', { establishmentId: t.establishmentId, xml: x.xml, ...extra });
}
async function approveAll(client: Client, entityId: string) {
  const list = (await client.get('/v1/approvals')).body.filter((a: any) => a.entity_id === entityId);
  for (const a of list) expect((await client.post(`/v1/approvals/${a.id}/decision`, { decision: 'approve' })).status).toBe(200);
  return list.length;
}
async function balanced() {
  const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
  expect(tb.totals.debit).toBe(tb.totals.credit);
}

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  supplierCnpj = makeCnpj();
  const s = await t.admin.post('/v1/parties', {
    kind: 'PJ', taxId: supplierCnpj, legalName: 'Fornecedor Têxtil LTDA', roles: ['supplier'], ieIndicator: 1, ie: '110.042.490.114', xmlEmail: 'vendas@fornecedor.test',
    addresses: [{ kind: 'fiscal', zip: '01310100', street: 'Av. Paulista', number: '1000', district: 'Bela Vista', cityIbge: '3550308', cityName: 'São Paulo', uf: 'SP' }],
  });
  expect(s.status).toBe(201);
  supplierId = s.body.id;
  const c = await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Transportadora Rápida LTDA', roles: ['carrier'], addresses: ADDR });
  carrierId = c.body.id;
  comprador = await createUser(app, t, ['comprador']);
  gerente = await createUser(app, t, ['gerente']);
  estoquista = await createUser(app, t, ['estoquista']);
});
afterAll(async () => app.close());

describe('Pedido de compra e aprovação por alçada (seção 11)', () => {
  it('dentro da alçada do comprador é aprovado na hora; acima vai para o gerente; PDF enviado ao fornecedor', async () => {
    const pid = await newProduct('PC-ALCADA');
    const small = await po(comprador, [{ productId: pid, quantity: '10', unitPrice: '50.00' }], { freight: '20.00' });
    expect(small.status).toBe(201);
    expect(small.body.status).toBe('approved');
    expect(small.body.total).toBe('520.00');

    const big = await po(comprador, [{ productId: pid, quantity: '160', unitPrice: '50.00' }]);
    expect(big.body.status).toBe('pending_approval');
    expect(big.body.approvals[0].reason).toContain('acima da alçada');
    // O comprador não tem permissão para aprovar
    const own = (await comprador.get('/v1/approvals')).body.filter((a: any) => a.entity_id === big.body.id);
    expect(own).toHaveLength(0);
    expect(await approveAll(gerente, big.body.id)).toBe(1);
    expect((await t.admin.get(`/v1/purchasing/orders/${big.body.id}`)).body.status).toBe('approved');

    const pdf = await t.admin.get(`/v1/purchasing/orders/${big.body.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(String(pdf.body).startsWith('%PDF-1.4')).toBe(true);
    const mailer = app.deps.services.mailer as MemoryMailer;
    const sent = await comprador.post(`/v1/purchasing/orders/${big.body.id}/send`);
    expect(sent.body.sentTo).toBe('vendas@fornecedor.test');
    expect(mailer.sent.at(-1)!.attachments![0]!.contentType).toBe('application/pdf');
  });

  it('política por centro de custo exige duas aprovações mesmo dentro da alçada', async () => {
    const cc = await run((tx) => tx.one<{ id: string }>(`SELECT id FROM finance.cost_centers WHERE code = 'ADM'`));
    expect((await t.admin.put('/v1/approval-policies', { action: 'compras.pedido.cc.ADM', minValue: '0', requiredApprovals: 2, approverPermission: 'compras.pedido.aprovar' })).status).toBe(200);
    const pid = await newProduct('PC-CC');
    const o = await po(comprador, [{ productId: pid, quantity: '1', unitPrice: '100.00' }], { costCenterId: cc.id });
    expect(o.body.status).toBe('pending_approval');
    expect(o.body.approvals[0].required_approvals).toBe(2);
    await approveAll(gerente, o.body.id);
    expect((await t.admin.get(`/v1/purchasing/orders/${o.body.id}`)).body.status).toBe('pending_approval');
    await approveAll(t.admin, o.body.id);
    expect((await t.admin.get(`/v1/purchasing/orders/${o.body.id}`)).body.status).toBe('approved');
  });
});

describe('Requisição, cotação e mapa comparativo (V1)', () => {
  it('fornecedores respondem pelo link; escolha por item gera um pedido por fornecedor', async () => {
    const p1 = await newProduct('RFQ-1');
    const p2 = await newProduct('RFQ-2');
    const other = await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Outro Fornecedor SA', roles: ['supplier'], addresses: ADDR,
      contacts: [{ name: 'Vendas', whatsapp: '5581999990000' }] });
    const req = await t.admin.post('/v1/purchasing/requests', { establishmentId: t.establishmentId, justification: 'Reposição da vitrine de verão',
      items: [{ productId: p1, quantity: '10' }, { productId: p2, quantity: '5' }] });
    expect(req.status).toBe(201);
    const rfq = await comprador.post('/v1/purchasing/rfqs', { establishmentId: t.establishmentId, requestId: req.body.id, supplierIds: [supplierId, other.body.id] });
    expect(rfq.status).toBe(201);
    expect(rfq.body.items).toHaveLength(2);
    const item = (pid: string) => rfq.body.items.find((i: any) => i.product_id === pid).id;
    const [a, b] = rfq.body.suppliers.map((s: any) => s);
    const link = (s: any) => s.link as string;
    const view = await app.inject({ method: 'GET', url: link(a) });
    expect(view.json().items).toHaveLength(2);
    const prices: Record<string, [string, string]> = { [supplierId]: ['10.00', '30.00'], [other.body.id]: ['12.00', '25.00'] };
    for (const s of [a, b]) {
      const [x, y] = prices[s.supplier_id]!;
      const r = await app.inject({ method: 'POST', url: link(s), payload: { items: [{ rfqItemId: item(p1), unitPrice: x, leadTimeDays: 5 }, { rfqItemId: item(p2), unitPrice: y, leadTimeDays: 7 }], freight: '15.00' } });
      expect(r.statusCode).toBe(200);
    }
    const map = (await comprador.get(`/v1/purchasing/rfqs/${rfq.body.id}/map`)).body;
    expect(map.items.find((i: any) => i.productId === p1).bestSupplierId).toBe(supplierId);
    expect(map.items.find((i: any) => i.productId === p2).bestSupplierId).toBe(other.body.id);
    // Global: 10×10 + 5×30 + 15 = 265 contra 10×12 + 5×25 + 15 = 260
    expect(map.bestGlobalSupplierId).toBe(other.body.id);
    const award = await comprador.post(`/v1/purchasing/rfqs/${rfq.body.id}/award`, { mode: 'item' });
    expect(award.status).toBe(200);
    expect(award.body.orders).toHaveLength(2);
    expect((await t.admin.get(`/v1/purchasing/requests/${req.body.id}`)).body.status).toBe('ordered');
    const closed = await app.inject({ method: 'POST', url: link(a), payload: { items: [{ rfqItemId: item(p1), unitPrice: '1.00' }] } });
    expect(closed.statusCode).toBe(409);
  });
});

describe('Recebimento a partir do XML (MVP)', () => {
  it('vincula ao pedido, faz de-para por GTIN, lança estoque com custo de entrada, títulos pelas duplicatas e contábil (RN-COM-03/04)', async () => {
    const pid = await newProduct('CAMISA-AZ', { gtin: ean('789123456789') });
    const o = await po(comprador, [{ productId: pid, quantity: '100', unitPrice: '20.00' }], { paymentTermId: null });
    const nfe = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'F-001', ean: ean('789123456789'), description: 'CAMISETA AZUL M', quantity: '100', unitPrice: '20.00', icmsRate: '12', ipi: '100.00' }],
      dups: [{ dueDate: addDays(30), amount: '1050.00' }, { dueDate: addDays(60), amount: '1050.00' }] });
    (app.deps.services.fiscalGateway as SimulatedFiscalGateway).addInbound(t.cnpj, { accessKey: nfe.key, issuerCnpj: supplierCnpj, issuerName: 'Fornecedor Têxtil LTDA',
      issuedAt: new Date().toISOString(), total: nfe.total, situation: 'autorizada', xml: nfe.xml });
    const r = await receive(estoquista, nfe);
    expect(r.status).toBe(201);
    expect(r.body.order_id).toBe(o.body.id);
    expect(r.body.status).toBe('pre_receipt');
    // Repetir o mesmo XML não duplica
    expect((await receive(estoquista, nfe)).status).toBe(409);

    const check = await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/check`);
    expect(check.body.readyToComplete).toBe(true);
    const done = await comprador.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    expect(done.body.manifestation).toBe('confirmada');
    // Simples Nacional: sem crédito → custo = 2000 + IPI 100 = 2100 / 100 = 21,00
    expect(done.body.items[0].match_source).toBe('gtin');
    expect(done.body.items[0].entry_total_cost).toBe('2100.00');
    expect(D((await avgCost(pid)).avg_cost).toFixed(2)).toBe('21.00');
    expect((await balance(pid)).quantity).toBe('100.0000');
    expect((await t.admin.get(`/v1/purchasing/orders/${o.body.id}`)).body.status).toBe('received');
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'payable' })).body.items.filter((x: any) => x.origin_id === r.body.id);
    expect(titles.map((x: any) => x.amount)).toEqual(['1050.00', '1050.00']);
    const doc = (await t.admin.get(`/v1/fiscal/documents/${done.body.documentId}`)).body;
    expect(doc.issuer_kind).toBe('third_party');
    expect(doc.items[0].cfop).toBe('2102');
    const ps = await run((tx) => tx.one(`SELECT * FROM catalog.product_suppliers WHERE supplier_id = $1 AND supplier_code = 'F-001'`, [supplierId]));
    expect(ps.product_id).toBe(pid);
    await balanced();

    // Segundo recebimento do mesmo código: vínculo automático pelo de-para gravado
    await po(comprador, [{ productId: pid, quantity: '10', unitPrice: '20.00' }]);
    const n2 = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'F-001', description: 'CAMISETA AZ M (NOVA DESCRIÇÃO)', quantity: '10', unitPrice: '20.00' }] });
    const r2 = await receive(estoquista, n2);
    expect(r2.body.items[0].match_source).toBe('supplier_code');
  });

  it('RN-COM-03 sem GTIN nem histórico: sugestão por descrição precisa ser confirmada; unidade do fornecedor com fator', async () => {
    const pid = await newProduct('MEIA-ALG', { description: 'Meia algodão cano curto preta' });
    await po(comprador, [{ productId: pid, quantity: '120', unitPrice: '3.00' }]);
    const nfe = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'MEIA-CX12', description: 'MEIA ALGODAO CANO CURTO PRETA CX', unit: 'CX', quantity: '10', unitPrice: '36.00' }] });
    const r = await receive(estoquista, nfe);
    expect(r.body.items[0].match_source).toBe('suggestion');
    expect(r.body.items[0].product_id).toBe(pid);
    const blocked = await comprador.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.details.rule).toBe('RN-COM-03');
    const mapped = await estoquista.put(`/v1/purchasing/receipts/${r.body.id}/items/${r.body.items[0].id}/product`, { productId: pid, factor: '12' });
    expect(mapped.status).toBe(200);
    const done = await comprador.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.items[0].stock_quantity).toBe('120.0000');
    expect(D(done.body.items[0].entry_unit_cost).toFixed(2)).toBe('3.00');
    const ps = await run((tx) => tx.one(`SELECT factor, supplier_unit FROM catalog.product_suppliers WHERE supplier_code = 'MEIA-CX12'`));
    expect(ps).toMatchObject({ factor: '12.000000', supplier_unit: 'CX' });
  });

  it('RN-COM-01 preço acima da tolerância bloqueia a entrada até o comprador liberar', async () => {
    const pid = await newProduct('CALCA-JEANS', { gtin: ean('789490001151') });
    await po(comprador, [{ productId: pid, quantity: '10', unitPrice: '100.00' }]);
    const nfe = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'CJ-1', ean: ean('789490001151'), description: 'CALCA JEANS', quantity: '10', unitPrice: '105.00' }] });
    const r = await receive(estoquista, nfe);
    const check = await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/check`);
    expect(check.body.status).toBe('divergent');
    expect(check.body.divergences[0].kind).toBe('price');
    expect(check.body.divergences[0].message).toContain('+5.00%');
    const blocked = await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.details.rule).toBe('RN-COM-01');
    expect(await approveAll(comprador, r.body.id)).toBe(1);
    const done = await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    expect(done.status).toBe(200);
    expect(D(done.body.items[0].entry_unit_cost).toFixed(2)).toBe('105.00');
  });

  it('RN-COM-02 conferência cega: o conferente não vê a quantidade da nota; contagem diferente vira divergência', async () => {
    const pid = await newProduct('BONE-PRETO', { gtin: ean('789600400389') });
    await po(comprador, [{ productId: pid, quantity: '50', unitPrice: '15.00' }]);
    const nfe = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'BN-1', ean: ean('789600400389'), description: 'BONE PRETO', quantity: '50', unitPrice: '15.00' }] });
    const r = await receive(estoquista, nfe, { blindCount: true });
    const view = (await estoquista.get(`/v1/purchasing/receipts/${r.body.id}`)).body;
    expect(view.blind).toBe(true);
    expect(view.items[0].supplier_quantity).toBeUndefined();
    expect(view.total_invoice).toBeUndefined();
    const notCounted = await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    expect(notCounted.body.details.rule).toBe('RN-COM-02');
    await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/count`, { items: [{ itemId: view.items[0].id, quantity: '48' }] });
    const check = await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/check`);
    expect(check.body.divergences.map((d: any) => d.kind)).toEqual(['count']);
    await approveAll(comprador, r.body.id);
    expect((await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/complete`)).status).toBe(200);
  });

  it('RN-COM-06 nota sem pedido só com permissão e aparece no relatório de compras fora do processo', async () => {
    const pid = await newProduct('CINTO-COURO', { gtin: ean('789100031550') });
    const nfe = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'CT-1', ean: ean('789100031550'), description: 'CINTO COURO', quantity: '5', unitPrice: '40.00' }] });
    const r = await receive(estoquista, nfe);
    expect(r.body.without_order).toBe(true);
    const denied = await estoquista.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    expect(denied.status).toBe(422);
    expect(denied.body.details.rule).toBe('RN-COM-06');
    expect((await comprador.post(`/v1/purchasing/receipts/${r.body.id}/complete`)).status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    const report = (await t.admin.get('/v1/purchasing/reports/off-process', { from: today, to: today })).body;
    expect(report.some((x: any) => x.id === r.body.id && x.accepted_by)).toBe(true);
    expect((await balance(pid)).quantity).toBe('5.0000');
  });

  it('RN-COM-05 CT-e rateado por valor entre as notas antes da conclusão; título à transportadora', async () => {
    const pa = await newProduct('FRETE-A', { gtin: ean('789191000019') });
    const pb = await newProduct('FRETE-B', { gtin: ean('789191000711') });
    const n1 = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'FA', ean: ean('789191000019'), description: 'A', quantity: '10', unitPrice: '30.00' }] });
    const n2 = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'FB', ean: ean('789191000711'), description: 'B', quantity: '10', unitPrice: '10.00' }] });
    const r1 = await receive(comprador, n1);
    const r2 = await receive(comprador, n2);
    const fr = await comprador.post('/v1/purchasing/freight-documents', { carrierId, number: '5501', issueDate: new Date().toISOString().slice(0, 10), total: '40.00', icmsCredit: '4.80',
      method: 'value', receiptIds: [r1.body.id, r2.body.id] });
    expect(fr.status).toBe(201);
    expect(fr.body.allocations.map((a: any) => a.freight)).toEqual(['30.00', '10.00']);
    for (const r of [r1, r2]) expect((await comprador.post(`/v1/purchasing/receipts/${r.body.id}/complete`)).status).toBe(200);
    // Simples: o crédito de ICMS do CT-e não é aproveitado → frete integral no custo
    expect(D((await avgCost(pa)).avg_cost).toFixed(2)).toBe('33.00');
    expect(D((await avgCost(pb)).avg_cost).toFixed(2)).toBe('11.00');
    const late = await comprador.post('/v1/purchasing/freight-documents', { carrierId, number: '5502', issueDate: new Date().toISOString().slice(0, 10), total: '10.00', receiptIds: [r1.body.id] });
    expect(late.body.details.rule).toBe('RN-COM-05');
    const carrierTitles = (await t.admin.get('/v1/finance/titles', { kind: 'payable' })).body.items.filter((x: any) => x.party_id === carrierId);
    expect(carrierTitles[0].amount).toBe('40.00');
    await balanced();
    const rec = (await t.admin.get('/v1/accounting/reconciliation', { date: '2027-12-31' })).body;
    expect(rec.find((l: any) => l.account.startsWith('Fornecedores')).ok).toBe(true);
    expect(rec.find((l: any) => l.account.startsWith('Estoque')).ok).toBe(true);
  });

  it('RN-COM-07 devolução a fornecedor: NF-e de devolução, estoque pelo custo de entrada, abatimento do título e contábil', async () => {
    const pid = await newProduct('JAQUETA', { gtin: ean('789835741001') });
    await po(comprador, [{ productId: pid, quantity: '10', unitPrice: '80.00' }]);
    const nfe = supplierNfe({ supplierCnpj, recipientCnpj: t.cnpj, items: [{ code: 'JQ', ean: ean('789835741001'), description: 'JAQUETA', quantity: '10', unitPrice: '80.00', icmsRate: '12' }],
      dups: [{ dueDate: addDays(30), amount: '800.00' }] });
    const r = await receive(comprador, nfe);
    const done = await comprador.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    const ret = await comprador.post('/v1/purchasing/returns', { receiptId: r.body.id, items: [{ receiptItemId: done.body.items[0].id, quantity: '2' }], reason: 'Peças com defeito de costura' });
    expect(ret.status).toBe(201);
    expect(ret.body.total).toBe('160.00');
    expect(ret.body.transmission.status).toBe('autorizada');
    const doc = (await t.admin.get(`/v1/fiscal/documents/${ret.body.document_id}`)).body;
    expect(doc.direction).toBe('S');
    expect(doc.purpose).toBe(4);
    expect(doc.recipient_tax_id).toBe(supplierCnpj);
    expect(doc.items[0].cfop).toBe('6202');
    // Tributos espelhados da nota de entrada: ICMS de 12% sobre 160
    expect(doc.total_icms).toBe('19.20');
    expect((await balance(pid)).quantity).toBe('8.0000');
    const title = (await t.admin.get('/v1/finance/titles', { kind: 'payable' })).body.items.find((x: any) => x.origin_id === r.body.id);
    expect(title.balance).toBe('640.00');
    // Devolver mais que o saldo não devolvido é recusado
    const over = await comprador.post('/v1/purchasing/returns', { receiptId: r.body.id, items: [{ receiptItemId: done.body.items[0].id, quantity: '9' }], reason: 'Teste de saldo' });
    expect(over.status).toBe(422);
    await balanced();
  });

  it('sugestão de compra considera saldo, pedidos em aberto, consumo médio e prazo do fornecedor', async () => {
    const pid = await newProduct('SUGERE-1');
    await t.admin.put(`/v1/products/${pid}/stock-params`, { warehouseId: t.warehouseId, minQty: '5', maxQty: '100', reorderPoint: '20' });
    await t.admin.post(`/v1/products/${pid}/suppliers`, { supplierId, supplierCode: 'SG-1', leadTimeDays: 10, minLot: '12' });
    await run(async (tx) => {
      await postMovement(tx, { warehouseId: t.warehouseId, productId: pid, type: 'opening', quantity: '60', unitCost: '5.00', sourceType: 'test' });
      await postMovement(tx, { warehouseId: t.warehouseId, productId: pid, type: 'sale_out', quantity: '45', sourceType: 'test' });
    });
    const sug = (await comprador.get('/v1/purchasing/suggestions', { warehouseId: t.warehouseId })).body;
    const s = sug.find((x: any) => x.productId === pid);
    expect(s).toBeTruthy();
    expect(s.available).toBe('15.0000');
    expect(s.supplierId).toBe(supplierId);
    // alvo 100 − 15 = 85 → múltiplo do lote mínimo (12) = 96
    expect(s.suggestedQuantity).toBe('96.0000');
    await po(comprador, [{ productId: pid, quantity: '96', unitPrice: '5.00' }]);
    expect((await comprador.get('/v1/purchasing/suggestions', { warehouseId: t.warehouseId })).body.find((x: any) => x.productId === pid)).toBeUndefined();
  });
});

describe('RN-COM-04 custo de entrada por regime (função pura)', () => {
  const base = { total: '1000.00', discount: '0', freight: '0', insurance: '0', other_expenses: '0', ipi: '50.00', st: '0', icms: '120.00', icms_cst: '00', pis_cst: '01',
    ibs: '0', cbs: '0', extra_freight: '0', extra_freight_icms: '0', payable_amount: '1050.00' };
  const ctx = { forResale: true, ibsCbsInformative: true, pisCofinsActive: true };
  it('Simples: nada é recuperável', () => {
    expect(entryCost(base, { ...ctx, regime: 'simples_nacional' }).total.toFixed(2)).toBe('1050.00');
  });
  it('Presumido: ICMS recuperável; IPI não recuperável no custo', () => {
    const c = entryCost(base, { ...ctx, regime: 'lucro_presumido' });
    expect(c.icmsCredit.toFixed(2)).toBe('120.00');
    expect(c.total.toFixed(2)).toBe('930.00');
  });
  it('Real: ICMS + PIS/Cofins (9,25% sobre 1000 + 50 − 120)', () => {
    const c = entryCost(base, { ...ctx, regime: 'lucro_real' });
    expect(c.pisCredit.toFixed(2)).toBe('15.35');
    expect(c.cofinsCredit.toFixed(2)).toBe('70.68');
    expect(c.total.toFixed(2)).toBe('843.97');
  });
  it('ST no custo e sem crédito do ICMS próprio; monofásico sem PIS/Cofins', () => {
    const c = entryCost({ ...base, st: '80.00', icms_cst: '10', pis_cst: '04', payable_amount: '1130.00' }, { ...ctx, regime: 'lucro_real' });
    expect(c.icmsCredit.toFixed(2)).toBe('0.00');
    expect(c.pisCredit.toFixed(2)).toBe('0.00');
    expect(c.total.toFixed(2)).toBe('1130.00');
  });
  it('Uso e consumo: sem crédito de ICMS; IBS/CBS creditáveis a partir de 2027', () => {
    const c = entryCost({ ...base, ibs: '10.00', cbs: '88.00', payable_amount: '1148.00' }, { ...ctx, forResale: false, ibsCbsInformative: false, pisCofinsActive: false, regime: 'lucro_presumido' });
    expect(c.icmsCredit.toFixed(2)).toBe('0.00');
    expect(c.ibsCredit.plus(c.cbsCredit).toFixed(2)).toBe('98.00');
    expect(c.total.toFixed(2)).toBe('1050.00');
  });
});

describe('Créditos no lucro presumido e IBS/CBS condicionados ao pagamento (RN-REF-04)', () => {
  let t2: TenantFixture;
  let sup2: string;
  let sup2Cnpj: string;
  beforeAll(async () => {
    t2 = await setupTenant(app, { regime: 'lucro_presumido' });
    sup2Cnpj = makeCnpj();
    sup2 = (await t2.admin.post('/v1/parties', { kind: 'PJ', taxId: sup2Cnpj, legalName: 'Fornecedor Presumido', roles: ['supplier'], addresses: ADDR })).body.id;
  });

  it('ICMS creditado (fora do custo); IBS/CBS de nota de 2027 ficam condicionados até o título ser pago', async () => {
    const p = (await t2.admin.post('/v1/products', { sku: 'PRES-1', description: 'Tênis corrida', ncm: '61091000', gtin: ean('789123400001') })).body.id;
    const nfe = supplierNfe({ supplierCnpj: sup2Cnpj, recipientCnpj: t2.cnpj, issuedAt: '2027-01-15T10:00:00-03:00',
      items: [{ code: 'TN', ean: ean('789123400001'), description: 'TENIS', ncm: '61091000', quantity: '10', unitPrice: '100.00', icmsRate: '12', ibs: '1.00', cbs: '88.00' }] });
    const r = await t2.admin.post('/v1/purchasing/receipts', { establishmentId: t2.establishmentId, xml: nfe.xml });
    expect(r.status).toBe(201);
    const done = await t2.admin.post(`/v1/purchasing/receipts/${r.body.id}/complete`);
    expect(done.status).toBe(200);
    const it0 = done.body.items[0];
    expect(it0.recoverable_icms).toBe('120.00');
    expect(it0.recoverable_ibs_cbs).toBe('89.00');
    // 1000 + 89 (IBS/CBS por fora) − 120 − 89 = 880
    expect(it0.entry_total_cost).toBe('880.00');
    const book = async () => (await t2.admin.get('/v1/fiscal/tax-credits', { from: '2027-01-01', to: '2027-12-31' })).body;
    const b1 = await book();
    expect(b1.find((x: any) => x.tax === 'ICMS').available).toBe('120.00');
    expect(b1.find((x: any) => x.tax === 'CBS').conditional).toBe('88.00');
    // Paga o fornecedor → crédito apropriado
    const title = (await t2.admin.get('/v1/finance/titles', { kind: 'payable' })).body.items.find((x: any) => x.origin_id === r.body.id);
    expect(title.amount).toBe('1089.00');
    const bank = await withTenant(app.deps.pool, systemContext(t2.tenantId, t2.companyId), (tx) => tx.one<{ id: string }>(`SELECT id FROM finance.accounts WHERE code = 'BANCO'`));
    // Segregação de funções (RN-ACE-01): quem cadastrou o fornecedor não aprova; aprova o financeiro
    expect((await t2.admin.post(`/v1/finance/titles/${title.id}/approve`)).status).toBe(403);
    const fin = await createUser(app, t2, ['financeiro']);
    expect((await fin.post(`/v1/finance/titles/${title.id}/approve`)).status).toBe(200);
    const st = await t2.admin.post(`/v1/finance/titles/${title.id}/settle`, { date: new Date().toISOString().slice(0, 10), accountId: bank.id, amount: '1089.00' });
    expect(st.status).toBe(200);
    const deps = getWorkerDeps(app);
    await deps.workerPool.query(`INSERT INTO integration.jobs (name, queue) VALUES ('outbox.dispatch','system')`);
    await drain(deps);
    const b2 = await book();
    expect(b2.find((x: any) => x.tax === 'CBS').conditional).toBe('0.00');
    expect(b2.find((x: any) => x.tax === 'CBS').available).toBe('88.00');
    const tb = (await t2.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.rows.find((x: any) => x.code === '1.1.4.03').closing).toBe('89.00');
  });

  it('isolamento: outro tenant não enxerga recebimentos nem créditos', async () => {
    const mine = (await t2.admin.get('/v1/purchasing/receipts')).body;
    const other = (await t.admin.get('/v1/purchasing/receipts')).body;
    expect(mine.every((x: any) => !other.some((y: any) => y.id === x.id))).toBe(true);
  });
});
