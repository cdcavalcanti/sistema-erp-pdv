import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { D } from '@vortex/money';
import { buildAccessKey } from '@vortex/validators';
import { calculate } from '@vortex/fiscal-engine';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { verifyPassword } from '../src/core/crypto.js';
import { client, createUser, makeApp, setupTenant, type Client, type TenantFixture } from './helpers.js';

/** Integração ERP ⇄ Vortex PDV (especificação do PDV): o lado do ERP. */
let app: App;
let t: TenantFixture;
let terminal: Client;
let terminalId: string;
let productId: string;
let operatorId: string;
let accounts: Record<string, string>;
let nfceNumber = 500;
const today = new Date().toISOString().slice(0, 10);
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const nfceKey = (n: number, tpEmis = '1') =>
  buildAccessKey({ cUF: '26', aamm: today.slice(2, 4) + today.slice(5, 7), cnpj: t.cnpj, modelo: '65', serie: 2, numero: n, tpEmis, cNF: String(n * 7).padStart(8, '0') });
const stockOf = async (id: string) => D((await t.admin.get('/v1/stock/balances', { productId: id })).body[0]?.quantity ?? 0);
const cashBalance = async () => D((await t.admin.get('/v1/finance/balances')).body.find((x: any) => x.code === 'CAIXA').balance);
async function balanced() {
  const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
  expect(tb.totals.debit).toBe(tb.totals.credit);
}
const sale = (n: number, extra: Record<string, unknown> = {}) => ({
  establishmentId: t.establishmentId, pdvId: '03', saleId: `PDV-03-${today.replaceAll('-', '')}-${String(n).padStart(6, '0')}`, saleUuid: randomUUID(),
  sessionId: 'S-1', operatorId, occurredAt: new Date().toISOString(), items: [{ productId, quantity: '2', unitPrice: '25.00' }],
  payments: [{ methodCode: 'DINHEIRO', amount: '60.00', change: '10.00' }],
  nfce: { accessKey: nfceKey(n), status: 'autorizada', protocol: `12626000000${n}`, authorizedAt: new Date().toISOString() },
  ...extra,
});

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true });
  const p = await t.admin.post('/v1/products', { sku: 'CAFE', description: 'Café 500g', ncm: '09012100', gtin: '7891234567895' });
  productId = p.body.id;
  const list = (await t.admin.get('/v1/price-lists')).body.find((l: any) => l.is_default);
  await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId, price: '25.00' });
  await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId, type: 'opening', quantity: '20', unitCost: '12', sourceType: 'test' }));
  accounts = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.accounts`))).map((a) => [a.code, a.id]));
});
afterAll(async () => app.close());

describe('ERP ⇄ Vortex PDV: terminais, operadores e carga', () => {
  it('cadastro do terminal gera chave própria; terminal e operador com PIN aparecem na carga', async () => {
    const r = await t.admin.post('/v1/pdv/terminals', { establishmentId: t.establishmentId, code: '03', name: 'Caixa 3' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.apiKey).toMatch(/^vx_/);
    terminalId = r.body.terminal.id;
    terminal = client(app, r.body.apiKey);
    expect((await t.admin.post('/v1/pdv/terminals', { establishmentId: t.establishmentId, code: '03', name: 'Outro' })).status).toBe(409);

    const op = await createUser(app, t, ['operador_caixa']);
    operatorId = op.userId;
    expect((await t.admin.put(`/v1/users/${operatorId}/pdv-operator`, { pdvLogin: 'ana', pin: '111111' })).status).toBe(422);
    expect((await t.admin.put(`/v1/users/${operatorId}/pdv-operator`, { pdvLogin: 'ana', pin: '482913' })).status).toBe(200);

    const sync = (await terminal.get('/v1/pdv/sync', { establishmentId: t.establishmentId })).body;
    expect(sync.terminal).toMatchObject({ code: '03', status: 'active' });
    const ana = sync.operators.find((o: any) => o.login === 'ana');
    expect(ana.permissions).toEqual(expect.arrayContaining(['pdv.venda.operar', 'pdv.caixa.abrir']));
    expect(ana.permissions).not.toContain('pdv.desconto.autorizar');
    expect(ana.discount_limit_percent).toBe('5.0000');
    expect(await verifyPassword('482913', ana.pin_hash)).toBe(true);
    expect(sync.settings.payments.cash).toBe('DINHEIRO');
    expect(sync.settings.cash.cashAccountId).toBe(accounts.CAIXA);
    expect(sync.products.find((x: any) => x.id === productId)).toMatchObject({ gtin: '7891234567895', controls_stock: true });
  });

  it('contexto fiscal da NFC-e: o PDV calcula com o mesmo motor e chega ao mesmo total do ERP', async () => {
    const { fiscal } = (await terminal.get('/v1/pdv/sync', { establishmentId: t.establishmentId })).body;
    expect(fiscal.template.operation.presential).toBe(true);
    const attrs = fiscal.products.find((x: any) => x.productId === productId);
    const r = calculate({ ...fiscal.template, items: [{ ...attrs, id: '1', quantity: '2', unitPrice: '25.00', taxableQuantity: '2', discount: '0' }] });
    expect(D(r.totals.invoice).toFixed(2)).toBe('50.00');
    const sim = (await t.admin.post('/v1/fiscal/simulate', { establishmentId: t.establishmentId, operationTypeCode: 'VENDA', presential: true, items: [{ id: '1', productId, quantity: '2', unitPrice: '25.00' }] })).body;
    expect(r.items[0]!.cfop).toBe(sim.items[0].cfop);
    expect(D(r.items[0]!.taxes.icms.value).toFixed(2)).toBe(D(sim.items[0].taxes.icms.value).toFixed(2));
  });

  it('parâmetros da loja validados contra o ERP e evento de configuração', async () => {
    const url = `/v1/pdv/settings?establishmentId=${t.establishmentId}`;
    const bad = await t.admin.put(url, { payments: { pix: 'NAO_EXISTE' } });
    expect(bad.status).toBe(422);
    const ok = await t.admin.put(url, { stock: { outOfStock: 'block' }, receipt: { footer: 'Volte sempre' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ stock: { outOfStock: 'block' }, receipt: { footer: 'Volte sempre' }, cash: { cashAccountId: accounts.CAIXA } });
    const ev = await run((tx) => tx.query(`SELECT event_type FROM integration.outbox_events WHERE event_type = 'pdv.configuracao_alterada'`));
    expect(ev.length).toBe(1);
  });
});

describe('ERP ⇄ Vortex PDV: vendas, cancelamento e devolução', () => {
  it('venda com sale_uuid é idempotente mesmo com outro número; estoque sai e muda a situação', async () => {
    const before = await stockOf(productId);
    const s = sale(++nfceNumber);
    const r = await terminal.post('/v1/pdv/sales', s);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await stockOf(productId)).toFixed(0)).toBe(before.minus(2).toFixed(0));
    const dup = await terminal.post('/v1/pdv/sales', { ...s, saleId: 'PDV-03-OUTRO' });
    expect(dup.body).toMatchObject({ duplicate: true, documentId: r.body.documentId });
    const got = await terminal.get(`/v1/pdv/sales/${s.saleId}`, { establishmentId: t.establishmentId });
    expect(got.body).toMatchObject({ status: 'active', fiscal_status: 'autorizada', items: [{ item_number: 1, quantity: '2.0000' }] });
  });

  it('cancelamento da venda do PDV: estoque volta, dinheiro sai do caixa, contábil estornado; reenvio não duplica', async () => {
    const s = sale(++nfceNumber);
    const stock0 = await stockOf(productId);
    const cash0 = await cashBalance();
    await terminal.post('/v1/pdv/sales', s);
    expect((await cashBalance()).toFixed(2)).toBe(cash0.plus(50).toFixed(2));
    const body = { establishmentId: t.establishmentId, pdvId: '03', saleId: s.saleId, reason: 'Cliente desistiu da compra no caixa', protocol: '135260000012345',
      cancelledAt: new Date().toISOString(), operatorId };
    const c = await terminal.post('/v1/pdv/sales/cancel', body);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', duplicate: false });
    expect((await stockOf(productId)).toFixed(0)).toBe(stock0.toFixed(0));
    expect((await cashBalance()).toFixed(2)).toBe(cash0.toFixed(2));
    const doc = (await t.admin.get(`/v1/fiscal/documents/${c.body.documentId}`)).body;
    expect(doc).toMatchObject({ status: 'cancelada', cancel_protocol: '135260000012345' });
    expect((await terminal.post('/v1/pdv/sales/cancel', body)).body.duplicate).toBe(true);
    expect((await stockOf(productId)).toFixed(0)).toBe(stock0.toFixed(0));
    await balanced();
  });

  it('devolução parcial pelo PDV: estoque volta, reembolso em dinheiro sai do caixa, limite da quantidade vendida', async () => {
    const s = sale(++nfceNumber, { items: [{ productId, quantity: '3', unitPrice: '25.00' }], payments: [{ methodCode: 'DINHEIRO', amount: '75.00' }] });
    await terminal.post('/v1/pdv/sales', s);
    const stock0 = await stockOf(productId);
    const cash0 = await cashBalance();
    const ret = { establishmentId: t.establishmentId, pdvId: '03', reference: 'DEV-03-1', saleId: s.saleId, items: [{ itemNumber: 1, quantity: '1' }],
      reason: 'Produto com defeito', refundMethod: 'cash', occurredAt: new Date().toISOString() };
    // Venda sem cliente identificado: a devolução pede nome e CPF
    expect((await terminal.post('/v1/pdv/returns', ret)).status).toBe(422);
    Object.assign(ret, { customer: { taxId: '529.982.247-25', name: 'Maria das Graças' } });
    const r = await terminal.post('/v1/pdv/returns', ret);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ duplicate: false, total: '25.00' });
    expect((await stockOf(productId)).toFixed(0)).toBe(stock0.plus(1).toFixed(0));
    expect((await cashBalance()).toFixed(2)).toBe(cash0.minus(25).toFixed(2));
    expect((await terminal.post('/v1/pdv/returns', ret)).body.duplicate).toBe(true);
    const tooMuch = await terminal.post('/v1/pdv/returns', { ...ret, reference: 'DEV-03-2', items: [{ itemNumber: 1, quantity: '3' }] });
    expect(tooMuch.status).toBe(422);
    await balanced();
  });

  it('chave que não é de terminal cadastrado não cancela nem devolve', async () => {
    const k = await t.admin.post('/v1/api-keys', { name: 'Integração antiga', scopes: ['pdv.sincronizacao.executar'], companyId: t.companyId });
    const legacy = client(app, k.body.key);
    const r = await legacy.post('/v1/pdv/sales/cancel', { establishmentId: t.establishmentId, pdvId: '03', saleId: 'X', reason: 'Motivo qualquer bem longo', protocol: '12345',
      cancelledAt: new Date().toISOString() });
    expect(r.status).toBe(403);
  });
});

describe('ERP ⇄ Vortex PDV: caixa e monitoramento', () => {
  it('abertura com fundo de troco, fechamento com quebra pela sessão e reabertura que desfaz a diferença', async () => {
    const mv = (kind: string, extra: Record<string, unknown>) => terminal.post('/v1/pdv/cash-movements', {
      establishmentId: t.establishmentId, pdvId: '03', reference: `${kind}-${randomUUID().slice(0, 6)}`, kind, sessionId: 'S-9', operatorId, occurredAt: new Date().toISOString(), ...extra });
    const cash0 = await cashBalance();
    const open = await mv('opening', { amount: '200.00' });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    expect((await cashBalance()).toFixed(2)).toBe(cash0.plus(200).toFixed(2));
    const close = await mv('closing', { counted: '195.00', details: { expectedCash: '200.00', pix: '0.00', card: '0.00' } });
    expect(close.body).toMatchObject({ expected: '200.00', difference: '-5.00' });
    expect((await cashBalance()).toFixed(2)).toBe(cash0.plus(195).toFixed(2));
    expect((await mv('reopening', { reason: 'curto' })).status).toBe(422);
    const reopen = await mv('reopening', { reason: 'Contagem refeita pelo gerente da loja' });
    expect(reopen.status, JSON.stringify(reopen.body)).toBe(201);
    expect((await cashBalance()).toFixed(2)).toBe(cash0.plus(200).toFixed(2));
    await balanced();
  });

  it('heartbeat alimenta o monitoramento; painel da loja; status de sincronização; terminal bloqueado perde acesso', async () => {
    const hb = await terminal.post('/v1/pdv/terminals/heartbeat', { appVersion: '1.0.0', pendingSales: 2, lastSyncAt: new Date().toISOString(),
      health: { erp: 'online', fiscal: 'online', printer: 'paper_low', avgSaleSeconds: 41.5, openSession: { sessionId: 'S-1', operatorId, openedAt: new Date().toISOString() } } });
    expect(hb.status, JSON.stringify(hb.body)).toBe(200);
    const list = (await t.admin.get('/v1/pdv/terminals', { establishmentId: t.establishmentId })).body;
    expect(list[0]).toMatchObject({ code: '03', online: true, app_version: '1.0.0', pending_sales: 2, health: { printer: 'paper_low' } });
    const dash = (await terminal.get('/v1/pdv/dashboard', { establishmentId: t.establishmentId })).body;
    expect(dash.salesCount).toBeGreaterThanOrEqual(2);
    expect(D(dash.averageTicket).greaterThan(0)).toBe(true);
    expect(dash.pendingSync).toBe(2);
    const ev = { id: randomUUID(), userId: operatorId, action: 'SANGRIA', entity: 'cash_session', entityId: 'S-1', metadata: { amount: '100.00' }, timestamp: new Date().toISOString() };
    const sent = await terminal.post('/v1/pdv/events', { establishmentId: t.establishmentId, events: [ev, ev] });
    expect(sent.body).toEqual({ accepted: 1, received: 2 });
    expect((await terminal.post('/v1/pdv/events', { establishmentId: t.establishmentId, events: [ev] })).body.accepted).toBe(0);
    const audit = (await t.admin.get('/v1/pdv/events', { action: 'SANGRIA' })).body;
    expect(audit[0]).toMatchObject({ terminal: '03', action: 'SANGRIA', metadata: { amount: '100.00' } });
    const st = (await terminal.get('/v1/pdv/sync/status')).body;
    expect(st.terminal.code).toBe('03');
    expect(st.sales_received_today).toBeGreaterThanOrEqual(3);
    const rotated = await t.admin.post(`/v1/pdv/terminals/${terminalId}/rotate-key`, {});
    expect(rotated.body.apiKey).toMatch(/^vx_/);
    expect((await terminal.get('/v1/pdv/sync/status')).status).toBe(401);
    terminal = client(app, rotated.body.apiKey);
    expect((await terminal.get('/v1/pdv/sync/status')).status).toBe(200);
    expect((await t.admin.post(`/v1/pdv/terminals/${terminalId}/block`, {})).status).toBe(200);
    expect((await terminal.get('/v1/pdv/sync/status')).status).toBe(401);
  });

  it('eventos para o cache do PDV: estoque.alterado ao zerar, promoção e cliente', async () => {
    const p = await t.admin.post('/v1/products', { sku: 'ULTIMO', description: 'Último item', ncm: '09012100' });
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p.body.id, type: 'opening', quantity: '1', unitCost: '5', sourceType: 'test' }));
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p.body.id, type: 'sale_out', quantity: '1', sourceType: 'test' }));
    const ev = await run((tx) => tx.query<{ payload: any }>(`SELECT payload FROM integration.outbox_events WHERE event_type = 'estoque.alterado' AND aggregate_id = $1 ORDER BY occurred_at`, [p.body.id]));
    expect(ev.map((e) => e.payload.status)).toEqual(['available', 'out']);
    const promo = await t.admin.post('/v1/promotions', { name: 'Leve 3', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      rule: { type: 'buy_x_pay_y', buy: 3, pay: 2 }, productIds: [productId] });
    expect(promo.status).toBe(201);
    const types = (await run((tx) => tx.query<{ event_type: string }>(`SELECT DISTINCT event_type FROM integration.outbox_events`))).map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['promocao.alterada', 'pdv.operador_alterado', 'estoque.alterado']));
    expect((await t.admin.get('/v1/events/catalog')).body).toEqual(expect.arrayContaining(['cliente.alterado', 'promocao.alterada', 'estoque.alterado', 'pdv.configuracao_alterada', 'pdv.operador_alterado']));
  });
});

describe('Vendas do PDV no backoffice e numeração do terminal', () => {
  // Terminal próprio (o 03 é bloqueado no teste de monitoramento): série da NFC-e = código 05
  let t5: Client;
  const key5 = (n: number, cNF: number) =>
    buildAccessKey({ cUF: '26', aamm: today.slice(2, 4) + today.slice(5, 7), cnpj: t.cnpj, modelo: '65', serie: 5, numero: n, tpEmis: '1', cNF: String(cNF).padStart(8, '0') });
  const sale5 = (n: number, extra: Record<string, unknown>) => ({ ...sale(n, extra), pdvId: '05', saleId: `PDV-05-${today.replaceAll('-', '')}-${String(n).padStart(6, '0')}` });
  beforeAll(async () => {
    t5 = client(app, (await t.admin.post('/v1/pdv/terminals', { establishmentId: t.establishmentId, code: '05', name: 'Caixa 5' })).body.apiKey);
  });

  it('venda com itens cancelados no caixa: aparece na lista, no resumo e no detalhe com quem cancelou e por quê', async () => {
    const body = sale5(901, {
      operator: 'Ana Operadora',
      nfce: { accessKey: key5(77, 1234), status: 'autorizada', protocol: '126260000000901', authorizedAt: new Date().toISOString() },
      cancelledItems: [{ productId, sku: 'CAFE', description: 'Café 500g', quantity: '1', unit: 'UN', unitPrice: '25.00', reason: 'Cliente desistiu', operatorId, partial: true }],
    });
    const r = await t5.post('/v1/pdv/sales', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const list = (await t.admin.get('/v1/pdv/sales', { status: 'with_cancelled_items' })).body;
    const row = list.items.find((x: any) => x.sale_id === body.saleId);
    expect(row).toMatchObject({ pdv_id: '05', operator_name: 'Ana Operadora', cancelled_items_count: 1, number: '77', items_count: 1 });
    const summary = (await t.admin.get('/v1/pdv/sales/summary', { from: today, to: today })).body;
    expect(summary.cancelled_items).toBeGreaterThanOrEqual(1);
    expect(D(summary.cancelled_items_value).greaterThanOrEqualTo(25)).toBe(true);
    expect(summary.byOperator.find((o: any) => o.operator === 'Ana Operadora')).toBeTruthy();
    const detail = (await t.admin.get(`/v1/pdv/sales/by-id/${row.id}`)).body;
    expect(detail.items).toHaveLength(1);
    expect(detail.cancelled_items[0]).toMatchObject({ quantity: '1', reason: 'Cliente desistiu', partial: true, operatorName: expect.any(String) });
    // Sem permissão de consultar o PDV, não vê
    const vendedor = await createUser(app, t, ['vendedor']);
    expect((await vendedor.get('/v1/pdv/sales')).status).toBe(403);
  });

  it('carga informa a numeração já usada; NFC-e com número repetido é recusada explicando o motivo', async () => {
    const sync = (await t5.get('/v1/pdv/sync', { establishmentId: t.establishmentId })).body;
    expect(sync.numbering.nfce).toEqual([expect.objectContaining({ series: 5, lastNumber: 77 })]);
    expect(sync.numbering.lastSaleIds).toEqual([`PDV-05-${today.replaceAll('-', '')}-000901`]);
    const again = sale5(902, { nfce: { accessKey: key5(77, 9999), status: 'autorizada', protocol: '126260000000902', authorizedAt: new Date().toISOString() } });
    const r = await t5.post('/v1/pdv/sales', again);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'PDV_NUMBER_IN_USE', message: expect.stringMatching(/série 5 número 77 já existe no ERP/) });
  });

  it('venda com NFC-e autorizada e sem saldo no ERP é aceita: estoque fica negativo e aparece no painel', async () => {
    const p = await t.admin.post('/v1/products', { sku: 'SEM-SALDO', description: 'Produto sem saldo no ERP', ncm: '09012100' });
    const list = (await t.admin.get('/v1/price-lists')).body.find((l: any) => l.is_default);
    await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId: p.body.id, price: '10.00' });
    const body = sale5(950, {
      items: [{ productId: p.body.id, quantity: '2', unitPrice: '10.00' }], payments: [{ methodCode: 'DINHEIRO', amount: '20.00' }],
      nfce: { accessKey: key5(950, 4321), status: 'autorizada', protocol: '126260000000950', authorizedAt: new Date().toISOString() },
    });
    const r = await t5.post('/v1/pdv/sales', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await t.admin.get('/v1/stock/balances', { productId: p.body.id })).body[0].quantity).toBe('-2.0000');
    const dash = (await t.admin.get('/v1/dashboard/owner')).body;
    expect(dash.alerts.find((a: any) => a.code === 'estoque_negativo').count).toBeGreaterThanOrEqual(1);
  });

  it('venda com CPF ainda não cadastrado no ERP cria o consumidor e fica ligada a ele', async () => {
    const r = await t5.post('/v1/pdv/sales', sale5(951, {
      customer: { taxId: '390.533.447-05', name: 'Cliente Novo do Caixa' },
      nfce: { accessKey: key5(951, 4322), status: 'autorizada', protocol: '126260000000951', authorizedAt: new Date().toISOString() },
    }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const party = await run((tx) => tx.one<{ id: string; legal_name: string }>(`SELECT id, legal_name FROM registry.parties WHERE tax_id = '39053344705'`));
    expect(party.legal_name).toBe('Cliente Novo do Caixa');
    const doc = await run((tx) => tx.one<{ party_id: string }>(`SELECT party_id FROM fiscal.documents WHERE id = $1`, [r.body.documentId]));
    expect(doc.party_id).toBe(party.id);
  });
});
