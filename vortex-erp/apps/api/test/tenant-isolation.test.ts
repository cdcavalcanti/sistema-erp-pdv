/**
 * Seção 25: teste automatizado que tenta ler e escrever dados de outro tenant em TODAS as rotas e
 * deve falhar. O tenant A tem dados marcados com "SEGREDO-A"; o tenant B chama cada rota registrada
 * com os ids de A (leitura e escrita) e as listas sem filtro. Nada de A pode aparecer nem mudar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant } from '../src/db/tx.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { makeApp, makeCnpj, setupTenant, type TenantFixture } from './helpers.js';

const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];
const MARK = 'SEGREDO-A';
const today = new Date().toISOString().slice(0, 10);

let app: App;
let a: TenantFixture;
let b: TenantFixture;
const ids: Record<string, string> = {};
const bIds: Record<string, string> = {};

beforeAll(async () => {
  app = await makeApp();
  a = await setupTenant(app);
  b = await setupTenant(app);
  // ----------------------------------------------------------------- dados do tenant A
  ids.party = (await a.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: `${MARK} Cliente LTDA`, roles: ['customer', 'supplier'], finalConsumer: false, addresses: ADDR,
    creditLimit: '50000', contacts: [{ name: `${MARK} Contato`, email: 'segredo@a.test' }] })).body.id;
  ids.product = (await a.admin.post('/v1/products', { sku: 'SEGA-1', description: `${MARK} Produto`, ncm: '61091000' })).body.id;
  await withTenant(app.deps.pool, systemContext(a.tenantId, a.companyId), (tx) => postMovement(tx, { warehouseId: a.warehouseId, productId: ids.product!, type: 'opening', quantity: '100', unitCost: '10', sourceType: 'test' }));
  ids.priceList = (await a.admin.post('/v1/price-lists', { code: 'SEGA', name: `${MARK} Tabela`, isDefault: true })).body.id;
  await a.admin.put(`/v1/price-lists/${ids.priceList}/items`, { productId: ids.product, price: '50.00' });
  const order = await a.admin.post('/v1/sales/orders', { establishmentId: a.establishmentId, partyId: ids.party, items: [{ productId: ids.product, quantity: 2 }], notes: MARK });
  ids.order = order.body.id;
  const inv = await a.admin.post(`/v1/sales/orders/${ids.order}/invoice`, {});
  ids.document = inv.body.document.id;
  ids.openOrder = (await a.admin.post('/v1/sales/orders', { establishmentId: a.establishmentId, partyId: ids.party, items: [{ productId: ids.product, quantity: 1 }], notes: MARK })).body.id;
  const cats = await a.admin.get('/v1/categories');
  const expense = cats.body.find((c: any) => c.kind === 'expense' && c.accepts_entries).id;
  ids.title = (await a.admin.post('/v1/finance/titles', { kind: 'payable', partyId: ids.party, documentNumber: `${MARK}-T1`, issueDate: today, installments: [{ dueDate: today, amount: '123.45' }], categoryId: expense })).body[0].id;
  ids.purchaseOrder = (await a.admin.post('/v1/purchasing/orders', { establishmentId: a.establishmentId, supplierId: ids.party, notes: MARK, items: [{ productId: ids.product, quantity: '5', unitPrice: '10.00' }] })).body.id;
  ids.account = (await a.admin.get('/v1/financial-accounts')).body[0].id;
  ids.establishment = a.establishmentId;
  ids.warehouse = a.warehouseId;
  ids.company = a.companyId;
  ids.draft = (await withTenant(app.deps.pool, systemContext(a.tenantId, a.companyId), (tx) => tx.one<{ id: string }>(
    `INSERT INTO ai.drafts (tenant_id, company_id, kind, title, payload, source) VALUES ($1,$2,'ncm_classification',$3,$4,'rules') RETURNING id`,
    [a.tenantId, a.companyId, `${MARK} rascunho`, JSON.stringify({ productId: ids.product, suggestion: { ncm: '61091000' } })]))).id;
  ids.user = (await a.admin.post('/v1/users', { email: `segredo@${a.slug}.test`, name: `${MARK} Usuário`, password: 'senha-segredo-123', roles: ['vendedor'] })).body.id;
  for (const [k, v] of Object.entries(ids)) expect(v, k).toBeTruthy();
  // ----------------------------------------------------------------- referências próprias de B (para tentar misturar com dados de A)
  bIds.account = (await b.admin.get('/v1/financial-accounts')).body[0].id;
  bIds.priceList = (await b.admin.post('/v1/price-lists', { code: 'B', name: 'Tabela B', isDefault: true })).body.id;
  bIds.party = (await b.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Cliente de B', roles: ['customer', 'supplier'], finalConsumer: false, addresses: ADDR })).body.id;
});
afterAll(async () => app.close());

/** Id de A para cada recurso, pelo prefixo da rota. */
function idFor(url: string): string {
  const map: [RegExp, string][] = [
    [/^\/v1\/parties/, 'party'], [/^\/v1\/products/, 'product'], [/^\/v1\/price-lists/, 'priceList'], [/^\/v1\/sales\/orders/, 'order'], [/^\/v1\/fiscal\/documents/, 'document'],
    [/^\/v1\/finance\/titles/, 'title'], [/^\/v1\/purchasing\/orders/, 'purchaseOrder'], [/^\/v1\/finance\/accounts/, 'account'], [/^\/v1\/establishments/, 'establishment'],
    [/^\/v1\/ai\/drafts/, 'draft'], [/^\/v1\/users/, 'user'], [/^\/v1\/companies/, 'company'],
  ];
  for (const [re, key] of map) if (re.test(url)) return ids[key]!;
  return ids.order!;
}
const fill = (url: string) => url.replace(/:id\b/g, idFor(url)).replace(/:itemId|:partId|:addressId/g, ids.product!).replace(/:accountId/g, ids.account!).replace(/:tenantId/g, a.tenantId)
  .replace(/:code/g, 'vendas.por_periodo').replace(/:cep/g, '50050000').replace(/:cnpj/g, makeCnpj());
const QUERY = { from: '2026-01-01', to: '2027-12-31', date: today, period: today.slice(0, 7), year: today.slice(0, 4), q: 'SEGA', establishmentId: '', productId: ids.product ?? '' };
const SKIP = [/^\/public\//, /^\/v1\/public\//, /^\/health$/, /^\/docs/, /^\/v1\/auth\//, /^\/v1\/onboarding$/, /^\/v1\/me$/];
const leaks = (body: string) => body.includes(MARK) || Object.values(ids).some((v) => v !== a.companyId && body.includes(v));

describe('Isolamento de tenant em todas as rotas (seção 25)', () => {
  it('leitura: nenhuma rota de B devolve dados de A (por id ou em listas)', async () => {
    const routes = app.routeTable.filter((r) => r.method === 'GET' && !SKIP.some((s) => s.test(r.url)));
    expect(routes.length).toBeGreaterThan(100);
    const found: string[] = [];
    for (const r of routes) {
      const url = fill(r.url);
      const res = await app.inject({ method: 'GET', url, query: { ...QUERY, productId: ids.product!, establishmentId: b.establishmentId },
        headers: { authorization: `Bearer ${b.admin.token}`, 'x-company-id': b.companyId } });
      if (res.statusCode < 300 && leaks(res.body)) found.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(found).toEqual([]);
  });

  it('escrita: toda rota de escrita de B com ids de A falha e nada de A muda', async () => {
    const routes = app.routeTable.filter((r) => r.method !== 'GET' && r.url.includes(':') && !SKIP.some((s) => s.test(r.url)));
    expect(routes.length).toBeGreaterThan(80);
    const succeeded: string[] = [];
    for (const r of routes) {
      const res = await app.inject({ method: r.method as 'POST', url: fill(r.url), payload: { reason: 'Tentativa de acesso indevido entre tenants', decision: 'approve' },
        headers: { authorization: `Bearer ${b.admin.token}`, 'x-company-id': b.companyId } });
      if (res.statusCode < 300) succeeded.push(`${r.method} ${r.url} → ${res.statusCode} ${res.body.slice(0, 120)}`);
    }
    expect(succeeded).toEqual([]);
  });

  it('escrita com corpo válido: B não altera nem referencia registros de A', async () => {
    const B = b.admin;
    const product = (await a.admin.get(`/v1/products/${ids.product}`)).body;
    const attempts = [
      await B.patch(`/v1/products/${ids.product}`, { version: product.version, description: 'Alterado por B' }),
      await B.patch(`/v1/parties/${ids.party}`, { version: 1, legalName: 'Alterado por B' }),
      await B.post(`/v1/finance/titles/${ids.title}/approve`),
      await B.post(`/v1/finance/titles/${ids.title}/settle`, { date: today, accountId: bIds.account, amount: '1.00' }),
      await B.post(`/v1/sales/orders/${ids.openOrder}/cancel`, { reason: 'Cancelamento indevido por outro tenant' }),
      await B.post(`/v1/sales/orders/${ids.openOrder}/invoice`, {}),
      await B.post(`/v1/ai/drafts/${ids.draft}/confirm`, {}),
      // Referências cruzadas: B tentando usar ids de A nos próprios registros
      await B.put(`/v1/price-lists/${bIds.priceList}/items`, { productId: ids.product, price: '1.00' }),
      await B.post('/v1/sales/orders', { establishmentId: b.establishmentId, partyId: ids.party, items: [{ productId: ids.product, quantity: 1, unitPrice: '1.00' }] }),
      await B.post('/v1/sales/orders', { establishmentId: a.establishmentId, partyId: bIds.party, items: [{ productId: ids.product, quantity: 1, unitPrice: '1.00' }] }),
      await B.post('/v1/finance/titles', { kind: 'receivable', partyId: ids.party, documentNumber: 'X', issueDate: today, installments: [{ dueDate: today, amount: '1.00' }],
        categoryId: (await B.get('/v1/categories')).body[0].id }),
      await B.post('/v1/purchasing/orders', { establishmentId: b.establishmentId, supplierId: ids.party, items: [{ productId: ids.product, quantity: '1', unitPrice: '1.00' }] }),
      await B.post(`/v1/products/${ids.product}/suppliers`, { supplierId: bIds.party, supplierCode: 'X', factor: '1' }),
      await B.post('/v1/ai/classify-product', { productId: ids.product }),
      await B.post(`/v1/finance/titles/${ids.title}/charge`, { kind: 'pix_cob' }),
    ];
    expect(attempts.map((r, i) => [i, r.status, JSON.stringify(r.body).slice(0, 160)]).filter(([, s]) => (s as number) < 300)).toEqual([]);
    // Nada mudou em A
    expect((await a.admin.get(`/v1/products/${ids.product}`)).body.description).toBe(`${MARK} Produto`);
    expect((await a.admin.get(`/v1/parties/${ids.party}`)).body.legal_name).toBe(`${MARK} Cliente LTDA`);
    expect((await a.admin.get(`/v1/finance/titles/${ids.title}`)).body).toMatchObject({ status: 'open', approved_at: null });
    expect((await a.admin.get(`/v1/sales/orders/${ids.openOrder}`)).body.status).not.toBe('cancelled');
    expect((await a.admin.get('/v1/ai/drafts', { status: 'pending' })).body.map((d: any) => d.id)).toContain(ids.draft);
    // E B não ficou com nenhuma linha apontando para A
    const crossRefs = await withTenant(app.deps.pool, systemContext(b.tenantId), (tx) => tx.query(
      `SELECT 'price_list_items' AS t FROM catalog.price_list_items WHERE product_id = $1
       UNION ALL SELECT 'product_suppliers' FROM catalog.product_suppliers WHERE product_id = $1
       UNION ALL SELECT 'titles' FROM finance.titles WHERE party_id = $2
       UNION ALL SELECT 'orders' FROM sales.orders WHERE party_id = $2`, [ids.product, ids.party]));
    expect(crossRefs).toEqual([]);
  });

  it('toda FK entre tabelas de tenant tem a FK composta (tenant_id, coluna); migrations novas não podem esquecer', async () => {
    const missing = await app.deps.pool.query(
      `SELECT n.nspname || '.' || t.relname || '(' || a.attname || ')' AS fk
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class rt ON rt.oid = c.confrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
         JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = c.confkey[1]
        WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND ra.attname = 'id' AND a.attname <> 'tenant_id'
          AND NOT t.relispartition AND NOT rt.relispartition
          AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = t.oid AND x.attname = 'tenant_id' AND x.attnotnull)
          AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = rt.oid AND x.attname = 'tenant_id' AND x.attnotnull)
          AND NOT EXISTS (SELECT 1 FROM pg_constraint c2 WHERE c2.conrelid = c.conrelid AND c2.contype = 'f' AND array_length(c2.conkey, 1) = 2
                            AND c2.confrelid = c.confrelid AND c.conkey[1] = ANY(c2.conkey))
        ORDER BY 1`);
    expect(missing.rows.map((r) => r.fk)).toEqual([]);
  });
});
