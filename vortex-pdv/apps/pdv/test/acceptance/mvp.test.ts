import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { D } from '@vortex/money';
import { useErpDb } from './erp-db.js';
import { erpModule } from './erp-dir.js';

useErpDb();
// O ERP real (projeto vortex-erp: Fastify + Postgres), carregado depois de apontar para o banco do aceite
const { makeApp, setupTenant, createUser, client } = await import(erpModule('apps/api/test/helpers.js'));
const { systemContext, withTenant } = await import(erpModule('apps/api/src/db/tx.js'));
const { postMovement } = await import(erpModule('apps/api/src/modules/inventory/stock.js'));
const { createPdv } = await import('../../src/application/pdv.js');
const { loadConfig } = await import('../../src/config.js');
const { FilePrinter } = await import('../../src/printer/drivers.js');
const { SimulatedPixPsp } = await import('../../src/payment/providers.js');

type Pdv = ReturnType<typeof createPdv>;
let erp: Awaited<ReturnType<typeof makeApp>>;
let t: Awaited<ReturnType<typeof setupTenant>>;
let pdv: Pdv;
let printer: InstanceType<typeof FilePrinter>;
const ids: Record<string, string> = {};
const PINS = { ana: '482913', sup: '730184' };

const stockOf = async (productId: string) => D((await t.admin.get('/v1/stock/balances', { productId })).body[0]?.quantity ?? 0);
const balanceOf = async (code: string) => D((await t.admin.get('/v1/finance/balances')).body.find((x: any) => x.code === code).balance);

beforeAll(async () => {
  erp = await makeApp();
  await erp.listen({ port: 0, host: '127.0.0.1' });
  const port = (erp.server.address() as { port: number }).port;
  t = await setupTenant(erp);
  await t.admin.post('/v1/fiscal/wizard', { establishmentId: t.establishmentId, apply: true });
  await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true });
  const list = (await t.admin.get('/v1/price-lists')).body.find((l: any) => l.is_default);
  for (const [k, p, price, stock] of [
    ['cafe', { sku: 'CAFE-500', description: 'Café torrado 500g', ncm: '09012100', gtin: '7891234567895' }, '24.90', '50'],
    ['pao', { sku: '123', description: 'Pão francês kg', ncm: '19053100', stockUnit: 'KG', saleUnit: 'KG' }, '16.90', '20'],
  ] as const) {
    const r = await t.admin.post('/v1/products', p);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids[k] = r.body.id;
    await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId: r.body.id, price });
    await withTenant(erp.deps.pool, systemContext(t.tenantId, t.companyId), (tx) =>
      postMovement(tx, { warehouseId: t.warehouseId, productId: r.body.id, type: 'opening', quantity: stock, unitCost: '10', sourceType: 'test' }));
  }
  ids.customer = (await t.admin.post('/v1/parties', { kind: 'PF', taxId: '529.982.247-25', legalName: 'Maria das Graças', roles: ['customer'], finalConsumer: true,
    addresses: [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }] })).body.id;
  // Terminal 03 e operadores com PIN, cadastrados no ERP
  const term = await t.admin.post('/v1/pdv/terminals', { establishmentId: t.establishmentId, code: '03', name: 'Caixa 3' });
  const ana = await createUser(erp, t, ['operador_caixa']);
  const sup = await createUser(erp, t, ['supervisor_caixa']);
  await t.admin.put(`/v1/users/${ana.userId}/pdv-operator`, { pdvLogin: 'ana', pin: PINS.ana });
  await t.admin.put(`/v1/users/${sup.userId}/pdv-operator`, { pdvLogin: 'sup', pin: PINS.sup });
  ids.ana = ana.userId;
  printer = new FilePrinter(null);
  pdv = createPdv(loadConfig({ env: 'test', dbPath: ':memory:', terminalCode: '03', erp: { url: `http://127.0.0.1:${port}`, apiKey: null, establishmentId: t.establishmentId, timeoutMs: 5000 } }),
    { printer });
  const paired = await pdv.pair({ apiKey: term.body.apiKey, establishmentId: t.establishmentId });
  expect(paired.errors).toEqual([]);
});

afterAll(async () => {
  pdv?.close();
  await erp?.close();
});

describe('Critério de aceite do MVP (seção 54), contra o ERP real', () => {
  it('LOGIN → ABERTURA → LEITURA → CARRINHO → CLIENTE → DESCONTO → FINALIZAÇÃO → PAGAMENTO → FISCAL → IMPRESSÃO → REGISTRO → SINCRONIZAÇÃO → ERP → ESTOQUE → FINANCEIRO', async () => {
    const cafe0 = await stockOf(ids.cafe!);
    const caixa0 = await balanceOf('CAIXA');
    // LOGIN (PIN do operador cadastrado no ERP)
    const { operator: ana } = await pdv.auth.login('ana', PINS.ana);
    // ABERTURA DE CAIXA (fundo de troco sai do cofre/banco para o caixa)
    await pdv.cash.open(ana, '100.00');
    // LEITURA DO PRODUTO → CARRINHO (scanner e balança)
    const sale = pdv.sales.start(ana);
    await pdv.sales.addItem(ana, sale.id, { code: '2*7891234567895' });
    (pdv.scale as any).weight = '0.500';
    let v = await pdv.sales.addItem(ana, sale.id, { code: '123' });
    expect(v.sale.total).toBe('58.25');
    // CLIENTE (CPF do cadastro do ERP)
    const [maria] = await pdv.customers.search('52998224725', true);
    v = pdv.sales.setCustomer(ana, sale.id, maria!.id);
    // DESCONTO (10% na venda: acima do limite de 5% do operador, autorizado pelo supervisor)
    v = await pdv.sales.saleDiscount(ana, sale.id, { kind: 'percent', value: '10' }, { login: 'sup', pin: PINS.sup });
    // 58,25 − 10% (5,825 → 5,83)
    expect(v.sale.total).toBe('52.42');
    // FINALIZAÇÃO → PAGAMENTO (dinheiro com troco + Pix confirmado pelo PSP)
    pdv.sales.finalize(ana, sale.id);
    await pdv.sales.addPayment(ana, sale.id, { method: 'pix', amount: '20.00', idempotencyKey: randomUUID() });
    const pix = pdv.sales.payments(sale.id)[0]!;
    (pdv.providers.pix as InstanceType<typeof SimulatedPixPsp>).pay(pix.transaction_id!);
    await pdv.sales.pollPayment(ana, pix.id);
    v = await pdv.sales.addPayment(ana, sale.id, { method: 'cash', amount: '50.00', idempotencyKey: randomUUID() });
    expect(v.payments.at(-1)).toMatchObject({ amount: '32.42', change: '17.58' });
    // FISCAL → IMPRESSÃO → REGISTRO
    const done = await pdv.sales.complete(ana, sale.id);
    expect(done.sale).toMatchObject({ status: 'completed', fiscal_status: 'authorized' });
    expect(printer.printed.at(-1)).toContain('Maria das Graças');
    expect(printer.printed.at(-1)).toContain('Troco R$');
    // SINCRONIZAÇÃO → ERP
    const sync = await pdv.sync.runOnce();
    expect(sync).toMatchObject({ online: true, failed: 0 });
    expect(pdv.sales.row(sale.id).sync_status).toBe('synced');
    const erpSale = (await client(erp, (await t.admin.post('/v1/pdv/terminals', { establishmentId: t.establishmentId, code: '04', name: 'Consulta' })).body.apiKey)
      .get(`/v1/pdv/sales/${done.sale.number}`, { establishmentId: t.establishmentId })).body;
    expect(erpSale).toMatchObject({ status: 'active', fiscal_status: 'autorizada', total: '52.42', access_key: (done.fiscal as any).accessKey });
    const doc = (await t.admin.get(`/v1/fiscal/documents/${erpSale.document_id}`)).body;
    expect(doc).toMatchObject({ model: '65', series: 3, recipient_tax_id: '52998224725' });
    // ESTOQUE
    expect((await stockOf(ids.cafe!)).toFixed(0)).toBe(cafe0.minus(2).toFixed(0));
    // FINANCEIRO: dinheiro no caixa (fundo de troco + venda), Pix baixado no banco, contábil fechado
    expect((await balanceOf('CAIXA')).toFixed(2)).toBe(caixa0.plus(100).plus('32.42').toFixed(2));
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'receivable', limit: '100' })).body.items.filter((x: any) => x.fiscal_document_id === erpSale.document_id);
    expect(titles.map((x: any) => [x.amount, x.status]).sort()).toEqual([['20.00', 'paid'], ['32.42', 'paid']]);
    const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
    expect(tb.totals.debit).toBe(tb.totals.credit);
    // Auditoria e monitoramento chegaram ao ERP
    const audit = (await t.admin.get('/v1/pdv/events', { establishmentId: t.establishmentId })).body.map((e: any) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['LOGIN', 'ABERTURA_CAIXA', 'DESCONTO', 'AUTORIZACAO', 'VENDA']));
    const terminals = (await t.admin.get('/v1/pdv/terminals', { establishmentId: t.establishmentId })).body;
    expect(terminals.find((x: any) => x.code === '03')).toMatchObject({ online: true, pending_sales: 0, app_version: '1.0.0' });
  });

  it('offline e cancelamento de ponta a ponta: ERP fora do ar, venda segue; na volta sincroniza; cancelamento estorna estoque no ERP', async () => {
    const { operator: ana } = await pdv.auth.login('ana', PINS.ana);
    // Queda da conexão: o cliente HTTP do ERP passa a apontar para uma porta sem ninguém
    const erpClient = pdv.erp as unknown as { baseUrl: string };
    const realUrl = erpClient.baseUrl;
    erpClient.baseUrl = 'http://127.0.0.1:9';
    const cafe0 = await stockOf(ids.cafe!);
    const s = pdv.sales.start(ana);
    await pdv.sales.addItem(ana, s.id, { code: '7891234567895' });
    pdv.sales.finalize(ana, s.id);
    await pdv.sales.addPayment(ana, s.id, { method: 'cash', amount: '24.90', idempotencyKey: randomUUID() });
    await pdv.sales.complete(ana, s.id);
    expect((await pdv.sync.runOnce()).online).toBe(false);
    expect(pdv.queue.counts().pendingSales).toBe(1);
    erpClient.baseUrl = realUrl;
    expect((await pdv.sync.runOnce()).online).toBe(true);
    expect((await stockOf(ids.cafe!)).toFixed(0)).toBe(cafe0.minus(1).toFixed(0));
    await pdv.sales.cancelSale(ana, s.id, 'Cliente desistiu da compra no caixa', { login: 'sup', pin: PINS.sup });
    await pdv.sync.runOnce();
    expect((await stockOf(ids.cafe!)).toFixed(0)).toBe(cafe0.toFixed(0));
    const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
    expect(tb.totals.debit).toBe(tb.totals.credit);
  });
});
