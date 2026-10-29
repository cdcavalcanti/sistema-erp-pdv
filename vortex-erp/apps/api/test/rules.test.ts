/**
 * Regras de negócio sem teste próprio até aqui (seção 25: cada RN- tem pelo menos um teste com o
 * código no nome). Os demais RN- estão nos testes de cada módulo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { createUser, makeApp, makeCnpj, setupTenant, type TenantFixture } from './helpers.js';

const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];
const today = new Date().toISOString().slice(0, 10);

let app: App;
let t: TenantFixture;
let customer: string;
let product: string;
let accounts: Record<string, string>;
let cats: Record<string, string>;
const run = <T>(fn: (tx: Tx) => Promise<T>, tf: TenantFixture = t) => withTenant(app.deps.pool, systemContext(tf.tenantId, tf.companyId), fn);
const qty = async (productId: string) => D((await t.admin.get('/v1/stock/balances', { productId })).body[0]?.quantity ?? 0).toFixed(4);
const balanced = async () => {
  const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
  expect(tb.totals.debit).toBe(tb.totals.credit);
  return tb;
};
async function invoicedOrder(body: Record<string, unknown> = {}) {
  const o = await t.admin.post('/v1/sales/orders', { establishmentId: t.establishmentId, partyId: customer, items: [{ productId: product, quantity: 2 }], ...body });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
  expect(inv.body.transmission?.status, JSON.stringify(inv.body)).toBe('autorizada');
  return { order: o.body, invoice: inv.body };
}

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app, { regime: 'lucro_presumido' });
  customer = (await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Atacado Cliente LTDA', roles: ['customer'], finalConsumer: false, ieIndicator: 9,
    addresses: ADDR, creditLimit: '100000' })).body.id;
  product = (await t.admin.post('/v1/products', { sku: 'MESA-01', description: 'Mesa de madeira maciça', ncm: '94036000', stockUnit: 'UN', saleUnit: 'UN' })).body.id;
  await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: product, type: 'opening', quantity: '50', unitCost: '300.00', sourceType: 'test' }));
  const list = (await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true })).body;
  await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId: product, price: '1000.00' });
  accounts = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.accounts`))).map((a) => [a.code, a.id]));
  cats = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.categories`))).map((a) => [a.code, a.id]));
  await run((tx) => tx.exec(`UPDATE finance.accounts SET bank_code = '001', account_number = '12345', initial_balance_date = '2026-01-01' WHERE id = $1`, [accounts.BANCO]));
});
afterAll(async () => app.close());

describe('Vendas', () => {
  it('RN-VEN-05 entrega futura: simples faturamento (5922, sem ICMS e sem estoque) e remessa (5117) vinculada', async () => {
    const before = await qty(product);
    const { order, invoice } = await invoicedOrder({ operationTypeCode: 'ENTREGA_FUT' });
    const bill = (await t.admin.get(`/v1/fiscal/documents/${invoice.document.id}`)).body;
    expect(bill.items[0].cfop).toBe('5922');
    expect(bill.total_icms).toBe('0.00');
    expect(await qty(product)).toBe(before);
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'receivable' })).body.items.filter((x: any) => x.origin_id === invoice.document.id);
    expect(titles.length).toBeGreaterThan(0);
    // Remessa parcial e depois o saldo
    const items = (await t.admin.get(`/v1/sales/orders/${order.id}`)).body.items;
    const r1 = await t.admin.post(`/v1/sales/orders/${order.id}/future-delivery-shipment`, { items: [{ orderItemId: items[0].id, quantity: '1' }] });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.transmission.status).toBe('autorizada');
    const ship = (await t.admin.get(`/v1/fiscal/documents/${r1.body.document.id}`)).body;
    expect(ship.items[0].cfop).toBe('5117');
    expect(D(ship.total_icms).greaterThan(0)).toBe(true);
    expect(ship.references).toEqual([expect.objectContaining({ kind: 'future_delivery', referenced_access_key: bill.access_key })]);
    expect(await qty(product)).toBe(D(before).minus(1).toFixed(4));
    expect((await t.admin.post(`/v1/sales/orders/${order.id}/future-delivery-shipment`, {})).status).toBe(201);
    expect(await qty(product)).toBe(D(before).minus(2).toFixed(4));
    expect((await t.admin.post(`/v1/sales/orders/${order.id}/future-delivery-shipment`, {})).status).toBe(409);
    // Remessa não gera título novo
    const after = (await t.admin.get('/v1/finance/titles', { kind: 'receivable' })).body.items.filter((x: any) => x.origin_id === r1.body.document.id);
    expect(after).toHaveLength(0);
    // Pedido comum não aceita remessa de entrega futura
    const normal = await invoicedOrder();
    expect((await t.admin.post(`/v1/sales/orders/${normal.order.id}/future-delivery-shipment`, {})).status).toBe(422);
    await balanced();
  });

  it('RN-VEN-03 desconto do pedido rateado nos itens; desconto do item e geral registrados separadamente', async () => {
    const p2 = (await t.admin.post('/v1/products', { sku: 'CADEIRA-01', description: 'Cadeira de madeira', ncm: '94036000', stockUnit: 'UN', saleUnit: 'UN' })).body.id;
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p2, type: 'opening', quantity: '10', unitCost: '100.00', sourceType: 'test' }));
    const o = await t.admin.post('/v1/sales/orders', { establishmentId: t.establishmentId, partyId: customer, discount: '50.00',
      items: [{ productId: product, quantity: 1, unitPrice: '1000.00', discountPercent: '2' }, { productId: p2, quantity: 2, unitPrice: '125.00' }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const items = (await t.admin.get(`/v1/sales/orders/${o.body.id}`)).body.items;
    // Item 1: 1000 − 2% = 980; item 2: 250. Rateio de 50 pelo líquido (980 : 250)
    expect(items.map((i: any) => i.item_discount)).toEqual(['20.00', '0.00']);
    expect(items.map((i: any) => i.header_discount_share)).toEqual(['39.84', '10.16']);
    expect(D(items[0].header_discount_share).plus(items[1].header_discount_share).toFixed(2)).toBe('50.00');
    const ord = (await t.admin.get(`/v1/sales/orders/${o.body.id}`)).body;
    expect(ord.total).toBe('1180.00');
  });

  it('RN-VEN-07 meta do mês por filial com realizado × meta', async () => {
    const start = `${today.slice(0, 8)}01`;
    const end = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const tg = await t.admin.post('/v1/sales/targets', { periodStart: start, periodEnd: end, establishmentId: t.establishmentId, targetAmount: '10000.00' });
    expect(tg.status, JSON.stringify(tg.body)).toBe(201);
    const progress = (await t.admin.get('/v1/sales/targets/progress')).body.find((x: any) => x.id === tg.body.id);
    expect(D(progress.realized_amount).greaterThan(0)).toBe(true);
    const dash = (await t.admin.get('/v1/dashboard/owner')).body;
    expect(dash.targets.find((x: any) => x.id === tg.body.id)).toBeTruthy();
  });
});

describe('Reforma tributária', () => {
  it('RN-REF-05 preço exibido com e sem IBS/CBS conforme a tabela (líquida ou cheia)', async () => {
    const q = (await t.admin.get('/v1/pricing/quote', { productId: product, establishmentId: t.establishmentId })).body;
    // 2026: CBS 0,9% + IBS 0,1% (alíquotas de teste)
    expect(q.newTaxes).toMatchObject({ ratePercent: '1.0000', withoutIbsCbs: '1000.00', withIbsCbs: '1010.00', listIncludesIbsCbs: false });
    const cheia = (await t.admin.post('/v1/price-lists', { code: 'CHEIA', name: 'Preço cheio', includesIbsCbs: true, customerId: customer })).body;
    await t.admin.put(`/v1/price-lists/${cheia.id}/items`, { productId: product, price: '1010.00' });
    const q2 = (await t.admin.get('/v1/pricing/quote', { productId: product, customerId: customer, establishmentId: t.establishmentId })).body;
    expect(q2.newTaxes).toMatchObject({ withoutIbsCbs: '1000.00', withIbsCbs: '1010.00', listIncludesIbsCbs: true });
  });

  it('RN-REF-02 alíquotas por vigência e reduções como parâmetro (cClassTrib), sem código específico', async () => {
    const rates = (await t.admin.get('/v1/fiscal/tables/ibs-cbs-rates')).body;
    expect(rates.length).toBeGreaterThan(0);
    // A redução vem do cClassTrib do produto (tabela oficial), não de código
    const food = (await t.admin.post('/v1/products', { sku: 'ALIM-01', description: 'Alimento com redução de 60%', ncm: '19053100', cclasstrib: '200034' })).body.id;
    const sim = (cclasstrib: string) => t.admin.post('/v1/fiscal/simulate', {
      establishmentId: t.establishmentId, operationTypeCode: 'VENDA', partyId: customer, items: [{ productId: cclasstrib === '200034' ? food : product, quantity: '1', unitPrice: '1000.00' }],
    });
    const full = await sim('000001');
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    const reduced = await sim('200034');
    const cbs = (r: any) => D(r.body.items[0].taxes.ibsCbs.cbs.value);
    expect(reduced.body.items[0].taxes.ibsCbs.cbs.reduction).toBe('60.0000');
    expect(cbs(reduced).lessThan(cbs(full))).toBe(true);
  });

  it('RN-REF-06 split payment: o título guarda o IBS/CBS a reter e a conciliação aceita o líquido', async () => {
    await run((tx) => tx.exec(`UPDATE core.companies SET settings = jsonb_set(coalesce(settings, '{}'), '{finance,splitPayment}', 'true') WHERE id = $1`, [t.companyId]));
    const { invoice } = await invoicedOrder();
    const doc = (await t.admin.get(`/v1/fiscal/documents/${invoice.document.id}`)).body;
    const tax = D(doc.total_ibs).plus(doc.total_cbs);
    expect(tax.greaterThan(0)).toBe(true);
    const title = (await t.admin.get('/v1/finance/titles', { kind: 'receivable' })).body.items.find((x: any) => x.origin_id === invoice.document.id);
    expect(title.split_tax_amount).toBe(tax.toFixed(2));
    const net = D(title.balance).minus(title.split_tax_amount).toFixed(2);
    const ofx = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>001<ACCTID>12345<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>${today.replace(/-/g, '')}<DTEND>${today.replace(/-/g, '')}
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>${today.replace(/-/g, '')}120000[-3:BRT]<TRNAMT>${net.replace('.', ',')}<FITID>SPLIT1<MEMO>PIX SPLIT ATACADO CLIENTE</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>${net}<DTASOF>${today.replace(/-/g, '')}</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect((await t.admin.post(`/v1/finance/accounts/${accounts.BANCO}/statements`, { content: ofx, fileName: 'split.ofx' })).status).toBe(201);
    const line = (await t.admin.get(`/v1/finance/accounts/${accounts.BANCO}/statement-lines`, { status: 'pending' })).body.find((l: any) => D(l.amount).equals(net));
    const sugg = (await t.admin.get(`/v1/finance/statement-lines/${line.id}/suggestions`)).body;
    expect(sugg[0]).toMatchObject({ kind: 'titles', reason: expect.stringContaining('split payment') });
    const fin = await createUser(app, t, ['financeiro']);
    const rec = await fin.post('/v1/finance/reconciliations', { lineIds: [line.id], titles: [{ titleId: title.id }] });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const paid = (await t.admin.get(`/v1/finance/titles/${title.id}`)).body;
    expect(paid).toMatchObject({ status: 'paid', balance: '0.00' });
    expect(paid.settlements[0]).toMatchObject({ total: net, split_tax: tax.toFixed(2) });
    const tb = await balanced();
    expect(tb.rows.find((r: any) => r.code === '1.1.4.03').closing).toBe(tax.toFixed(2));
  });
});

describe('Fiscal e contabilidade', () => {
  it('RN-FIS-02 documento emitido guarda o cálculo; mudar a regra depois não altera nota nem livros', async () => {
    const { invoice } = await invoicedOrder();
    const before = (await t.admin.get(`/v1/fiscal/documents/${invoice.document.id}`)).body;
    const icms = before.items[0].taxes.find((x: any) => x.tax === 'ICMS');
    expect(icms.rate).toBe('20.5000');
    const rule = await t.admin.post('/v1/tax-rules', { name: 'ICMS móveis 12% (nova)', validFrom: '2020-01-01', keys: { ncmPrefix: '9403' }, result: { icms: { rate: '12' } } });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const after = (await t.admin.get(`/v1/fiscal/documents/${invoice.document.id}`)).body;
    expect(after.items[0].taxes.find((x: any) => x.tax === 'ICMS')).toMatchObject({ rate: '20.5000', value: icms.value });
    // O livro lê o que foi gravado na nota
    const book = (await t.admin.post('/v1/reports/fiscal.livro/run', { params: { from: today, to: today, direction: 'S' } })).body;
    const row = book.rows.find((r: any) => String(r.number) === String(before.number) && r.model === '55');
    expect(row.total_icms).toBe(before.total_icms);
    // Nova venda já usa a regra nova (12%), a antiga não muda
    const { invoice: inv2 } = await invoicedOrder();
    expect((await t.admin.get(`/v1/fiscal/documents/${inv2.document.id}`)).body.items[0].taxes.find((x: any) => x.tax === 'ICMS').rate).toBe('12.0000');
    await t.admin.post(`/v1/tax-rules/${rule.body.id}/deactivate`, { reason: 'Regra de teste desativada para os demais casos' });
  });

  it('RN-CTB-02 contabilização por evento com conta especializada por categoria', async () => {
    const r = await t.admin.put('/v1/accounting/posting-rules', { eventType: 'titulo_manual_pagar', categoryId: cats['5.3'], lines: [
      { side: 'D', account: '4.4.3', amount: ['amount'], history: 'Tarifa {number}' }, { side: 'C', account: '2.1.1', amount: ['amount'], history: 'Fornecedor {number}' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const sup = (await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Banco Tarifas SA', roles: ['supplier'], addresses: ADDR })).body.id;
    const title = await t.admin.post('/v1/finance/titles', { kind: 'payable', partyId: sup, documentNumber: 'TAR-01', issueDate: today, installments: [{ dueDate: today, amount: '35.00' }], categoryId: cats['5.3'] });
    expect(title.status).toBe(201);
    const ledger = (await t.admin.get('/v1/accounting/ledger', { accountCode: '4.4.3', from: today, to: today })).body;
    expect(JSON.stringify(ledger)).toContain('35.00');
    await balanced();
  });

  it('RN-CTB-03 todo o plano analítico tem a conta referencial da RFB (ECD/ECF)', async () => {
    const coa = (await t.admin.get('/v1/chart-of-accounts')).body;
    const analytic = coa.filter((a: any) => a.is_analytic);
    expect(analytic.length).toBeGreaterThan(20);
    expect(analytic.filter((a: any) => !a.referential_code)).toEqual([]);
  });
});

describe('Princípios e organização', () => {
  it('RN-GER-01 saldo de estoque só muda por movimento: edição direta é recusada pelo banco; saldo = soma dos movimentos', async () => {
    const err = await run((tx) => tx.exec(`UPDATE inventory.stock_balances SET quantity = quantity + 10 WHERE product_id = $1`, [product])).catch((e) => e);
    expect(String(err?.message ?? err)).toContain('RN-GER-01');
    const check = await run((tx) => tx.query<{ product_id: string; balance: string; moves: string }>(
      `SELECT b.product_id, sum(b.quantity) AS balance,
              (SELECT coalesce(sum(m.sign * m.quantity), 0) FROM inventory.stock_movements m WHERE m.product_id = b.product_id) AS moves
         FROM inventory.stock_balances b GROUP BY b.product_id`));
    for (const c of check) expect(D(c.balance).toFixed(4)).toBe(D(c.moves).toFixed(4));
  });

  it('RN-GER-09 configurar antes de customizar: tenant nasce com tipos de operação, regras contábeis, papéis e categorias parametrizáveis', async () => {
    const other = await setupTenant(app);
    const ops = (await other.admin.get('/v1/operation-types')).body.map((o: any) => o.code);
    expect(ops).toEqual(expect.arrayContaining(['VENDA', 'ENTREGA_FUT', 'REM_ENTREGA_FUT', 'COMPRA', 'DEV_VENDA', 'SERVICO']));
    const rules = (await other.admin.get('/v1/accounting/posting-rules')).body.map((r: any) => r.event_type);
    expect(rules).toEqual(expect.arrayContaining(['venda_faturada', 'recebimento', 'pagamento', 'compra_recebida']));
    const roles = (await other.admin.get('/v1/roles')).body.map((r: any) => r.code);
    expect(roles).toEqual(expect.arrayContaining(['vendedor', 'comprador', 'financeiro', 'contador', 'gerente', 'administrador']));
    // A especialização de um tenant não vaza para outro
    expect((await other.admin.get('/v1/accounting/posting-rules')).body.some((r: any) => r.category_id)).toBe(false);
  });

  it('RN-ORG-02 cadastro de produto compartilhado ou exclusivo por empresa, conforme a implantação', async () => {
    const tenant = await setupTenant(app);
    const second = await tenant.admin.post('/v1/companies', { cnpjRoot: makeCnpj().slice(0, 8), legalName: 'Segunda Empresa LTDA' });
    expect(second.status).toBe(201);
    const inB = tenant.admin.withCompany(second.body.id);
    // Padrão: compartilhado
    await tenant.admin.post('/v1/products', { sku: 'SHARED-1', description: 'Produto compartilhado', ncm: '61091000' });
    expect((await inB.get('/v1/products', { q: 'SHARED-1' })).body.items).toHaveLength(1);
    // Exclusivo por empresa
    await run((tx) => tx.exec(`UPDATE core.tenants SET settings = jsonb_set(settings, '{sharing,products}', '"company"') WHERE id = $1`, [tenant.tenantId]), tenant);
    await tenant.admin.post('/v1/products', { sku: 'EXCL-1', description: 'Produto exclusivo da empresa A', ncm: '61091000' });
    expect((await tenant.admin.get('/v1/products', { q: 'EXCL-1' })).body.items).toHaveLength(1);
    expect((await inB.get('/v1/products', { q: 'EXCL-1' })).body.items).toHaveLength(0);
  });

  it('RN-ORG-04 certificado A1 guardado cifrado no cofre; avisos programados para 30, 15 e 5 dias antes do vencimento', async () => {
    const est = (await t.admin.get('/v1/establishments')).body.find((e: any) => e.id === t.establishmentId);
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date(Date.now() - 86_400_000);
    cert.validity.notAfter = new Date(Date.now() + 200 * 86_400_000);
    const attrs = [{ name: 'commonName', value: `EMPRESA TESTE:${est.cnpj}` }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    const pfx = forge.util.encode64(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'senha-do-cert', { algorithm: '3des' })).getBytes());
    expect((await t.admin.post(`/v1/establishments/${est.id}/certificate`, { pfxBase64: pfx, password: 'errada' })).status).toBe(422);
    const ok = await t.admin.post(`/v1/establishments/${est.id}/certificate`, { pfxBase64: pfx, password: 'senha-do-cert' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const stored = await run((tx) => tx.query<{ kind: string; ciphertext: Buffer }>(`SELECT kind, ciphertext FROM core.secrets WHERE kind IN ('certificate_a1','certificate_password')`));
    expect(stored.map((x) => x.kind).sort()).toEqual(['certificate_a1', 'certificate_password']);
    const raw = Buffer.from(pfx, 'base64');
    for (const s of stored) {
      expect(s.ciphertext.includes(raw.subarray(0, 64))).toBe(false);
      expect(s.ciphertext.toString('latin1')).not.toContain('senha-do-cert');
    }
    const jobs = await run((tx) => tx.query<{ payload: any; run_at: Date }>(`SELECT payload, run_at FROM integration.jobs WHERE name = 'certificado.aviso' ORDER BY run_at`));
    expect(jobs.map((j) => j.payload.days)).toEqual([30, 15, 5]);
    const days = (j: { run_at: Date }) => Math.round((cert.validity.notAfter.getTime() - j.run_at.getTime()) / 86_400_000);
    expect(jobs.map(days)).toEqual([30, 15, 5]);
  });
});
