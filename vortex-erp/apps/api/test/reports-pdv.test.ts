import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import { buildAccessKey } from '@vortex/validators';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement, getOrCreateLot } from '../src/modules/inventory/stock.js';
import { createTitles } from '../src/modules/finance/titles.js';
import { nextRunAt, resolveRelative } from '../src/modules/reports/service.js';
import { MemoryMailer } from '../src/core/mailer.js';
import { drain } from '../src/worker/runner.js';
import { client, createUser, getWorkerDeps, makeApp, makeCnpj, setupTenant, type Client, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let productId: string;
let customerId: string;
let accounts: Record<string, string>;
const today = new Date().toISOString().slice(0, 10);
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];

async function newProduct(sku: string, price: string, stock: string, cost: string, extra: Record<string, unknown> = {}) {
  const p = await t.admin.post('/v1/products', { sku, description: `Produto ${sku}`, ncm: '61091000', ...extra });
  expect(p.status).toBe(201);
  const list = (await t.admin.get('/v1/price-lists')).body.find((l: any) => l.is_default);
  await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId: p.body.id, price });
  if (D(stock).greaterThan(0)) await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p.body.id, type: 'opening', quantity: stock, unitCost: cost, sourceType: 'test' }));
  return p.body.id as string;
}
async function workerRun(name: string) {
  const deps = getWorkerDeps(app);
  await deps.workerPool.query(`INSERT INTO integration.jobs (name, queue) VALUES ($1, 'system')`, [name]);
  await drain(deps);
}
async function balanced() {
  const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
  expect(tb.totals.debit).toBe(tb.totals.credit);
}

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true });
  customerId = (await t.admin.post('/v1/parties', { kind: 'PF', taxId: '529.982.247-25', legalName: 'Maria Cliente', roles: ['customer'], finalConsumer: true, addresses: ADDR, creditLimit: '10000' })).body.id;
  productId = await newProduct('VESTIDO', '100.00', '50', '40.00');
  accounts = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.accounts`))).map((a) => [a.code, a.id]));
  // Uma venda faturada para alimentar os relatórios
  const terms = Object.fromEntries((await t.admin.get('/v1/payment-terms')).body.map((x: any) => [x.code, x.id]));
  const o = await t.admin.post('/v1/sales/orders', { establishmentId: t.establishmentId, partyId: customerId, paymentTermId: terms['30'], items: [{ productId, quantity: 3 }] });
  expect(o.status).toBe(201);
  const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
  expect(inv.body.transmission.status).toBe('autorizada');
});
afterAll(async () => app.close());

describe('Relatórios (seção 19, RN-REL-01/02)', () => {
  it('catálogo respeita as permissões do usuário', async () => {
    const est = await createUser(app, t, ['estoquista']);
    const codes = (await est.get('/v1/reports')).body.map((r: any) => r.code);
    expect(codes).toContain('estoque.posicao');
    expect(codes).toContain('compras.pedidos_atrasados');
    expect(codes).not.toContain('vendas.por_periodo');
    expect(codes).not.toContain('financeiro.aging');
    const denied = await est.post('/v1/reports/financeiro.aging/run', { params: {} });
    expect(denied.status).toBe(403);
    const all = (await t.admin.get('/v1/reports')).body;
    expect(new Set(all.map((r: any) => r.area))).toEqual(new Set(['vendas', 'compras', 'estoque', 'financeiro', 'fiscal', 'gestao']));
  });

  it('vendas por produto com ticket médio e margem bruta (receita − tributos − CMV)', async () => {
    const r = await t.admin.post('/v1/reports/vendas.por_periodo/run', { params: { from: today, to: today, groupBy: 'product' } });
    expect(r.status).toBe(200);
    const row = r.body.rows.find((x: any) => x.group.startsWith('VESTIDO'));
    expect(row.revenue).toBe('300.00');
    expect(row.cmv).toBe('120.00');
    expect(row.gross_margin).toBe(D(300).minus(row.taxes).minus(120).toFixed(2));
    expect(row.average_ticket).toBe('300.00');
    expect(r.body.columns[0].label).toBe('Produto');
    // Parâmetro inválido devolve erro por campo
    const bad = await t.admin.post('/v1/reports/vendas.por_periodo/run', { params: { from: 'ontem' } });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.details.fields)).toContain('params.from');
  });

  it('exporta CSV (padrão brasileiro), Excel (.xlsx) e PDF', async () => {
    const csv = await app.inject({ method: 'POST', url: '/v1/reports/estoque.posicao/run', headers: { authorization: `Bearer ${t.admin.token}`, 'x-company-id': t.companyId },
      payload: { params: {}, format: 'csv' } });
    expect(csv.headers['content-type']).toContain('text/csv');
    const text = csv.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Depósito;SKU;Descrição');
    expect(text).toContain('PRINCIPAL;VESTIDO;Produto VESTIDO;47,0000;0,0000;47,0000;40,0000;1880,00');
    const xlsx = await app.inject({ method: 'POST', url: '/v1/reports/estoque.posicao/run', headers: { authorization: `Bearer ${t.admin.token}`, 'x-company-id': t.companyId },
      payload: { params: {}, format: 'xlsx' } });
    expect(xlsx.rawPayload.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(xlsx.rawPayload.includes(Buffer.from('xl/worksheets/sheet1.xml'))).toBe(true);
    const pdf = await app.inject({ method: 'POST', url: '/v1/reports/fiscal.livro/run', headers: { authorization: `Bearer ${t.admin.token}`, 'x-company-id': t.companyId },
      payload: { params: { from: today, to: today, direction: 'S' }, format: 'pdf' } });
    expect(pdf.rawPayload.subarray(0, 8).toString()).toBe('%PDF-1.4');
  });

  it('relatórios de todas as áreas executam sem erro com parâmetros mínimos', async () => {
    const params: Record<string, Record<string, unknown>> = {
      'compras.evolucao_preco': { productId }, 'estoque.abc': { establishmentId: t.establishmentId }, 'estoque.kardex': { productId, from: today, to: today },
      'financeiro.titulos': { kind: 'receivable', from: '2026-01-01', to: '2027-12-31' }, 'financeiro.extrato': { accountId: accounts.CAIXA, from: '2026-01-01', to: today },
      'fiscal.livro': { from: today, to: today, direction: 'S' }, 'estoque.cmv_teorico_real': { establishmentId: t.establishmentId, from: today, to: today },
    };
    for (const r of (await t.admin.get('/v1/reports')).body) {
      const p = params[r.code] ?? { from: '2026-01-01', to: today };
      const res = await t.admin.post(`/v1/reports/${r.code}/run`, { params: p });
      expect(res.status, `${r.code}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    }
    const kardex = (await t.admin.post('/v1/reports/estoque.kardex/run', { params: { productId, from: today, to: today } })).body.rows;
    expect(kardex.at(-1).balance).toBe('47.0000');
    const aging = (await t.admin.post('/v1/reports/financeiro.aging/run', { params: { kind: 'receivable' } })).body.rows;
    expect(aging[0]).toMatchObject({ bucket: 'A vencer', value: '300.00', percent: '100.00' });
  });

  it('RN-REL-02 execução em fila: arquivo no armazenamento, aviso por e-mail e download', async () => {
    const mailer = app.deps.services.mailer as MemoryMailer;
    const q = await t.admin.post('/v1/reports/vendas.por_periodo/runs', { params: { from: today, to: today }, format: 'xlsx' });
    expect(q.status).toBe(202);
    expect(q.body.status).toBe('queued');
    await drain(getWorkerDeps(app), { queues: ['reports'] });
    const st = (await t.admin.get(`/v1/reports/runs/${q.body.id}`)).body;
    expect(st.status).toBe('done');
    expect(st.row_count).toBe(1);
    expect(mailer.sent.at(-1)!.subject).toContain('Relatório pronto');
    const dl = await app.inject({ method: 'GET', url: `/v1/reports/runs/${q.body.id}/download`, headers: { authorization: `Bearer ${t.admin.token}`, 'x-company-id': t.companyId } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 2).toString()).toBe('PK');
    // Outro usuário não vê a execução
    const other = await createUser(app, t, ['gerente']);
    expect((await other.get(`/v1/reports/runs/${q.body.id}`)).status).toBe(404);
  });

  it('filtros salvos e agendamento com período relativo, enviado com as permissões de quem agendou', async () => {
    const f = await t.admin.post('/v1/reports/vendas.por_periodo/filters', { name: 'Por vendedor', params: { groupBy: 'salesperson' }, shared: true });
    expect(f.status).toBe(201);
    const ger = await createUser(app, t, ['gerente']);
    expect((await ger.get('/v1/reports/vendas.por_periodo/filters')).body.map((x: any) => x.name)).toContain('Por vendedor');
    expect((await ger.del(`/v1/reports/filters/${f.body.id}`)).status).toBe(404);

    const s = await t.admin.post('/v1/reports/schedules', { reportCode: 'vendas.por_periodo', name: 'Vendas de ontem', params: { groupBy: 'product' }, relativePeriod: 'current_month',
      format: 'csv', frequency: 'daily', hour: 7, recipients: ['dono@loja.test'] });
    expect(s.status).toBe(201);
    expect(new Date(s.body.next_run_at).getTime()).toBeGreaterThan(Date.now());
    await run((tx) => tx.exec(`UPDATE reports.schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [s.body.id]));
    await workerRun('relatorios.agendados');
    const mailer = app.deps.services.mailer as MemoryMailer;
    const mail = mailer.sent.find((m) => m.to === 'dono@loja.test');
    expect(mail?.attachments?.[0]?.filename).toMatch(/\.csv$/);
    expect(String(mail!.attachments![0]!.content)).toContain('VESTIDO');
    const after = await run((tx) => tx.one<{ next_run_at: Date; last_run_at: Date }>(`SELECT next_run_at, last_run_at FROM reports.schedules WHERE id = $1`, [s.body.id]));
    expect(after.last_run_at).toBeTruthy();
    expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('datas relativas e próxima execução no horário de Brasília', () => {
    const now = new Date('2026-03-10T15:00:00Z');
    expect(resolveRelative('previous_month', now)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolveRelative('yesterday', now)).toEqual({ from: '2026-03-09', to: '2026-03-09' });
    expect(nextRunAt({ frequency: 'daily', hour: 7 }, now).toISOString()).toBe('2026-03-11T10:00:00.000Z');
    expect(nextRunAt({ frequency: 'weekly', hour: 7, weekday: 1 }, now).toISOString()).toBe('2026-03-16T10:00:00.000Z');
    expect(nextRunAt({ frequency: 'monthly', hour: 7, month_day: 5 }, now).toISOString()).toBe('2026-04-05T10:00:00.000Z');
  });
});

describe('Painel do dono e jobs de alerta (seções 19 e 23)', () => {
  it('faturamento, margem, caixa, inadimplência, estoque parado e alertas', async () => {
    await t.admin.put(`/v1/products/${productId}/stock-params`, { warehouseId: t.warehouseId, minQty: '10', reorderPoint: '60' });
    const idle = await newProduct('PARADO', '10.00', '5', '8.00');
    const d = (await t.admin.get('/v1/dashboard/owner')).body;
    expect(d.revenue.month).toBe('300.00');
    expect(d.revenue.documents).toBe(1);
    expect(d.delinquency.overdue).toBe('0.00');
    expect(d.delinquency.open).toBe('300.00');
    expect(D(d.idleStock.value).greaterThanOrEqualTo(40)).toBe(true);
    expect(d.alerts.map((a: any) => a.code)).toContain('estoque_minimo');
    expect(idle).toBeTruthy();
    const vend = await createUser(app, t, ['vendedor']);
    expect((await vend.get('/v1/dashboard/owner')).status).toBe(403);
  });

  it('titulo.vencendo / titulo.vencido uma única vez e estoque.lote_vencendo', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const [soon] = await run((tx) => createTitles(tx, { kind: 'receivable', partyId: customerId, originType: 'manual', documentNumber: 'R-1', issueDate: today, installments: [{ dueDate: tomorrow, amount: '50.00' }] }));
    const [late] = await run((tx) => createTitles(tx, { kind: 'receivable', partyId: customerId, originType: 'manual', documentNumber: 'R-2', issueDate: yesterday, installments: [{ dueDate: yesterday, amount: '70.00' }] }));
    const lotProduct = await newProduct('IOGURTE', '5.00', '0', '2.00', { controlsLot: true, controlsExpiry: true });
    await run(async (tx) => {
      const lot = await getOrCreateLot(tx, lotProduct, 'L-01', { expiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10) });
      await postMovement(tx, { warehouseId: t.warehouseId, productId: lotProduct, lotId: lot, type: 'opening', quantity: '12', unitCost: '2.00', sourceType: 'test' });
    });
    await workerRun('financeiro.vencimentos');
    await workerRun('estoque.lotes_vencendo');
    await workerRun('financeiro.vencimentos');
    const events = await run((tx) => tx.query<{ event_type: string; aggregate_id: string }>(
      `SELECT event_type, aggregate_id FROM integration.outbox_events WHERE event_type IN ('titulo.vencendo','titulo.vencido','estoque.lote_vencendo')`));
    expect(events.filter((e) => e.event_type === 'titulo.vencendo' && e.aggregate_id === soon!.id)).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'titulo.vencido' && e.aggregate_id === late!.id)).toHaveLength(1);
    expect(events.filter((e) => e.event_type === 'estoque.lote_vencendo')).toHaveLength(1);
    const catalog = (await t.admin.get('/v1/events/catalog')).body;
    expect(catalog).toEqual(expect.arrayContaining(['titulo.vencendo', 'titulo.vencido', 'estoque.lote_vencendo', 'compra.recebida']));
  });
});

describe('Integração com o PDV (seção 21)', () => {
  let pdv: Client;
  let nfceNumber = 100;
  const nfceKey = (n: number, tpEmis = '1') => buildAccessKey({ cUF: '26', aamm: today.slice(2, 4) + today.slice(5, 7), cnpj: t.cnpj, modelo: '65', serie: 2, numero: n, tpEmis, cNF: String(n * 13).padStart(8, '0') });
  const sale = (n: number, extra: Record<string, unknown> = {}) => ({
    establishmentId: t.establishmentId, pdvId: 'CX01', saleId: `V-${n}`, occurredAt: new Date().toISOString(), operator: 'Ana',
    items: [{ productId, quantity: '2', unitPrice: '100.00' }],
    payments: [{ methodCode: 'DINHEIRO', amount: '150.00', change: '30.00' }, { methodCode: 'CREDITO', amount: '80.00', card: { brand: 'VISA', nsu: '123', installments: 2 } }],
    nfce: { accessKey: nfceKey(n), status: 'autorizada', protocol: `12626000000${n}`, authorizedAt: new Date().toISOString() },
    ...extra,
  });

  beforeAll(async () => {
    const k = await t.admin.post('/v1/api-keys', { name: 'PDV loja', scopes: ['pdv.sincronizacao.executar'], companyId: t.companyId });
    expect(k.status).toBe(201);
    pdv = client(app, k.body.key);
  });

  it('sincronização para operar offline, com delta por "since"', async () => {
    const full = (await pdv.get('/v1/pdv/sync', { establishmentId: t.establishmentId })).body;
    expect(full.products.some((p: any) => p.id === productId)).toBe(true);
    expect(full.prices.some((p: any) => p.product_id === productId && p.price.startsWith('100'))).toBe(true);
    expect(full.paymentMethods.map((m: any) => m.code)).toContain('PIX');
    expect(full.customers.some((c: any) => c.id === customerId)).toBe(true);
    expect(full.nfceSeries.length).toBeGreaterThan(0);
    const delta = (await pdv.get('/v1/pdv/sync', { establishmentId: t.establishmentId, since: new Date(full.serverTime).toISOString() })).body;
    expect(delta.products).toHaveLength(0);
    // Chave sem a permissão do PDV não sincroniza
    expect((await (await createUser(app, t, ['vendedor'])).get('/v1/pdv/sync', { establishmentId: t.establishmentId })).status).toBe(403);
  });

  it('venda com NFC-e autorizada: documento, estoque, dinheiro baixado no caixa, cartão parcelado na adquirente e contábil', async () => {
    const before = (await t.admin.get('/v1/stock/balances', { productId })).body[0].quantity;
    const n = ++nfceNumber;
    const r = await pdv.post('/v1/pdv/sales', sale(n));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.total).toBe('200.00');
    const doc = (await t.admin.get(`/v1/fiscal/documents/${r.body.documentId}`)).body;
    expect(doc).toMatchObject({ model: '65', status: 'autorizada', number: String(n), series: 2, source_type: 'pdv' });
    expect(D((await t.admin.get('/v1/stock/balances', { productId })).body[0].quantity).toFixed(0)).toBe(D(before).minus(2).toFixed(0));
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'receivable', limit: '100' })).body.items.filter((x: any) => x.fiscal_document_id === r.body.documentId);
    const cash = titles.find((x: any) => !x.gross_amount);
    expect(cash).toMatchObject({ amount: '120.00', status: 'paid' });
    const card = titles.filter((x: any) => x.gross_amount);
    expect(card).toHaveLength(2);
    expect(card.map((x: any) => x.amount).sort()).toEqual(['38.60', '38.60']);
    // Idempotente: reenviar a mesma venda não duplica nada
    const again = await pdv.post('/v1/pdv/sales', sale(n));
    expect(again.body).toMatchObject({ duplicate: true, documentId: r.body.documentId });
    await balanced();
  });

  it('PDV desatualizado (total diferente do motor do ERP) e chave de outro CNPJ são recusados', async () => {
    const n = ++nfceNumber;
    const wrong = await pdv.post('/v1/pdv/sales', sale(n, { payments: [{ methodCode: 'DINHEIRO', amount: '190.00' }] }));
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('PDV_TOTAL_MISMATCH');
    const otherKey = buildAccessKey({ cUF: '26', aamm: '2610', cnpj: makeCnpj(), modelo: '65', serie: 2, numero: n, tpEmis: '1', cNF: '00000001' });
    const bad = await pdv.post('/v1/pdv/sales', sale(n, { nfce: { accessKey: otherKey, status: 'autorizada', protocol: '1' } }));
    expect(bad.status).toBe(422);
  });

  it('NFC-e offline em contingência e autorização posterior', async () => {
    const n = ++nfceNumber;
    const r = await pdv.post('/v1/pdv/sales', sale(n, { payments: [{ methodCode: 'PIX', amount: '200.00' }], nfce: { accessKey: nfceKey(n, '9'), status: 'contingencia' } }));
    expect(r.status).toBe(201);
    let doc = (await t.admin.get(`/v1/fiscal/documents/${r.body.documentId}`)).body;
    expect(doc.status).toBe('contingencia');
    expect(doc.emission_type).toBe(9);
    const a = await pdv.post('/v1/pdv/sales/authorization', { establishmentId: t.establishmentId, pdvId: 'CX01', saleId: `V-${n}`, protocol: '126260000099999', authorizedAt: new Date().toISOString() });
    expect(a.body.status).toBe('autorizada');
    doc = (await t.admin.get(`/v1/fiscal/documents/${r.body.documentId}`)).body;
    expect(doc.status).toBe('autorizada');
  });

  it('sangria, suprimento e fechamento com quebra de caixa', async () => {
    const bal = async () => (await t.admin.get('/v1/finance/balances')).body.find((x: any) => x.code === 'CAIXA').balance;
    const start = D(await bal());
    const w = await pdv.post('/v1/pdv/cash-movements', { establishmentId: t.establishmentId, pdvId: 'CX01', reference: 'SG-1', kind: 'withdrawal', amount: '100.00',
      cashAccountId: accounts.CAIXA, counterpartAccountId: accounts.BANCO, occurredAt: new Date().toISOString() });
    expect(w.status).toBe(201);
    expect(D(await bal()).toFixed(2)).toBe(start.minus(100).toFixed(2));
    const expected = start.minus(100);
    const close = await pdv.post('/v1/pdv/cash-movements', { establishmentId: t.establishmentId, pdvId: 'CX01', reference: 'FECH-1', kind: 'closing',
      counted: expected.minus('2.50').toFixed(2), cashAccountId: accounts.CAIXA, occurredAt: new Date().toISOString() });
    expect(close.body).toMatchObject({ expected: expected.toFixed(2), difference: '-2.50' });
    expect(D(await bal()).toFixed(2)).toBe(expected.minus('2.50').toFixed(2));
    // Reenvio da mesma referência não duplica
    await pdv.post('/v1/pdv/cash-movements', { establishmentId: t.establishmentId, pdvId: 'CX01', reference: 'SG-1', kind: 'withdrawal', amount: '100.00',
      cashAccountId: accounts.CAIXA, counterpartAccountId: accounts.BANCO, occurredAt: new Date().toISOString() });
    expect(D(await bal()).toFixed(2)).toBe(expected.minus('2.50').toFixed(2));
    await balanced();
  });
});
