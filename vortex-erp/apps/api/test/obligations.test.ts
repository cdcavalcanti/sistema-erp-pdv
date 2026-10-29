import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { computeRetentions, nextMonthDay } from '../src/modules/obligations/services-taken.js';
import { isRevenueCfop } from '../src/modules/obligations/simples.js';
import { reinfEventId } from '../src/modules/obligations/reinf.js';
import { createUser, makeApp, makeCnpj, setupTenant, type Client, type TenantFixture } from './helpers.js';

const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];
const today = new Date().toISOString().slice(0, 10);
const period = today.slice(0, 7);
const nextPeriod = (() => {
  const d = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1));
  return d.toISOString().slice(0, 7);
})();

let app: App;
let presumido: TenantFixture;
let simples: TenantFixture;
let financeiro: Client;
const run = <T>(t: TenantFixture, fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const tb = async (t: TenantFixture) => (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;

/** Venda faturada (NF-e) de um produto com estoque, para alimentar as apurações. */
async function sell(t: TenantFixture, sku: string, qty: number, price: string) {
  const prod = await t.admin.post('/v1/products', { sku, description: `Produto ${sku}`, ncm: '61091000', stockUnit: 'UN', saleUnit: 'UN' });
  expect(prod.status, JSON.stringify(prod.body)).toBe(201);
  await run(t, (tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: prod.body.id, type: 'opening', quantity: '1000', unitCost: '10.00', sourceType: 'test' }));
  let list = (await t.admin.get('/v1/price-lists')).body.find((l: any) => l.is_default);
  if (!list) list = (await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true })).body;
  await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId: prod.body.id, price });
  const customer = (await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: `Cliente ${sku}`, roles: ['customer'], finalConsumer: false, ieIndicator: 9,
    addresses: ADDR, creditLimit: '100000' })).body.id;
  const o = await t.admin.post('/v1/sales/orders', { establishmentId: t.establishmentId, partyId: customer, items: [{ productId: prod.body.id, quantity: qty }] });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
  expect(inv.body.transmission.status, JSON.stringify(inv.body)).toBe('autorizada');
  return inv.body;
}

beforeAll(async () => {
  app = await makeApp();
  presumido = await setupTenant(app, { regime: 'lucro_presumido' });
  simples = await setupTenant(app);
  financeiro = await createUser(app, presumido, ['financeiro']);
});
afterAll(async () => app.close());

describe('Retenções na fonte sobre serviços tomados', () => {
  it('IRRF 1,5% (1% em limpeza/segurança), CSRF 4,65%, INSS 11% na cessão de mão de obra; dispensa até R$ 10; Simples não sofre IRRF/CSRF', () => {
    const r = computeRetentions({ gross: '10000.00', supplierKind: 'PJ', supplierRegime: 'normal', serviceCode: '17.01' });
    expect([r.irrf, r.csll, r.pis, r.cofins].map((x) => x.toFixed(2))).toEqual(['150.00', '100.00', '65.00', '300.00']);
    expect(computeRetentions({ gross: '10000.00', supplierKind: 'PJ', supplierRegime: null, serviceCode: '7.10' }).irrf.toFixed(2)).toBe('100.00');
    const small = computeRetentions({ gross: '500.00', supplierKind: 'PJ', supplierRegime: 'normal', serviceCode: '17.01' });
    expect(small.irrf.toFixed(2)).toBe('0.00');
    expect(small.cofins.toFixed(2)).toBe('15.00');
    expect(small.notes).toContain('IRRF de até R$ 10,00 dispensado');
    const sn = computeRetentions({ gross: '10000.00', supplierKind: 'PJ', supplierRegime: 'simples_nacional', serviceCode: '17.01', laborAssignment: true, inssDeductions: '2000' });
    expect([sn.irrf, sn.csll, sn.inss].map((x) => x.toFixed(2))).toEqual(['0.00', '0.00', '880.00']);
    expect(computeRetentions({ gross: '1000.00', supplierKind: 'PJ', supplierRegime: 'normal', serviceCode: '17.01', issRetained: true, issRate: '5' }).iss.toFixed(2)).toBe('50.00');
  });

  it('vencimento das guias: dia 20 do mês seguinte, antecipado no fim de semana', () => {
    expect(nextMonthDay('2026-10-05', 20)).toBe('2026-11-20');
    expect(nextMonthDay('2026-11-30', 20)).toBe('2026-12-18');
    expect(nextMonthDay('2026-12-10', 10)).toBe('2027-01-08');
  });
});

describe('NFS-e de serviço tomado → títulos, contábil e EFD-Reinf', () => {
  let supplier: string;
  let supplierCnpj: string;
  let invoice: any;

  it('lança a nota: fornecedor pelo líquido, DARF IRRF/CSRF e INSS para a RFB, ISS para o município; débito = crédito', async () => {
    supplierCnpj = makeCnpj();
    supplier = (await presumido.admin.post('/v1/parties', { kind: 'PJ', taxId: supplierCnpj, legalName: 'Limpeza e Conservação LTDA', roles: ['supplier'], taxRegime: 'normal',
      addresses: ADDR })).body.id;
    const cats = Object.fromEntries((await run(presumido, (tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.categories`))).map((a) => [a.code, a.id]));
    const r = await presumido.admin.post('/v1/purchasing/service-invoices', {
      establishmentId: presumido.establishmentId, supplierId: supplier, number: '2026101', issueDate: today, dueDate: today, serviceCode: '7.10', reinfServiceType: '100000003',
      description: 'Limpeza mensal', grossAmount: '10000.00', laborAssignment: true, inssDeductions: '1000.00', issRetained: true, issRate: '5', categoryId: cats['5.3'],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    invoice = r.body;
    // IRRF 1% (limpeza) 100 + CSRF 465 + INSS 11% × 9.000 = 990 + ISS 500
    expect(invoice).toMatchObject({ irrf: '100.00', csll: '100.00', pis: '65.00', cofins: '300.00', inss: '990.00', iss: '500.00', net_amount: '7945.00' });
    const docs = invoice.titles.map((t: any) => [t.document_number, t.amount]);
    expect(docs).toEqual([['NFS-e 2026101', '7945.00'], ['IRRF 1708 NFS-e 2026101', '100.00'], ['CSRF 5952 NFS-e 2026101', '465.00'], ['INSS retido NFS-e 2026101', '990.00'],
      ['ISS retido NFS-e 2026101', '500.00']]);
    expect(invoice.titles[1].due_date).toBe(nextMonthDay(today, 20));
    const b = await tb(presumido);
    expect(b.totals.debit).toBe(b.totals.credit);
    const acc = (code: string) => b.rows.find((x: any) => x.code === code)?.closing;
    expect(acc('2.1.2.08')).toBe('-565.00');
    expect(acc('2.1.2.09')).toBe('-990.00');
    expect((await financeiro.post('/v1/purchasing/service-invoices', { establishmentId: presumido.establishmentId, supplierId: supplier, number: '2026101', issueDate: today, dueDate: today,
      serviceCode: '7.10', grossAmount: '1.00' })).status).toBe(409);
    // Pagar o INSS retido debita a conta de retenções, não fornecedores
    const inss = invoice.titles[3];
    const accounts = Object.fromEntries((await run(presumido, (tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.accounts`))).map((a) => [a.code, a.id]));
    await run(presumido, (tx) => tx.exec(`UPDATE finance.accounts SET initial_balance_date = '2026-01-01'`));
    for (const t of [invoice.titles[0], inss]) {
      expect((await financeiro.post(`/v1/finance/titles/${t.id}/approve`)).status).toBe(200);
      const s = await financeiro.post(`/v1/finance/titles/${t.id}/settle`, { date: today, accountId: accounts.BANCO, amount: t.amount });
      expect(s.status, JSON.stringify(s.body)).toBe(200);
    }
    const b2 = await tb(presumido);
    expect(b2.rows.find((x: any) => x.code === '2.1.2.09')?.closing ?? '0.00').toBe('0.00');
    expect(b2.rows.find((x: any) => x.code === '2.1.1')?.closing ?? '0.00').toBe('0.00');
  });

  it('EFD-Reinf: R-1000, R-2010 (INSS), R-4020 (IRRF + CSRF agregada na data do pagamento) e fechamentos', async () => {
    const r = await presumido.admin.get('/v1/obligations/reinf', { period, includeR1000: 'true' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.events.map((e: any) => e.type)).toEqual(['R-1000', 'R-2010', 'R-4020', 'R-2099', 'R-4099']);
    for (const e of r.body.events) {
      expect(e.id).toHaveLength(36);
      expect(e.xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><Reinf xmlns="http:\/\/www\.reinf\.esocial\.gov\.br\/schemas\/[A-Za-z0-9]+\/v2_01_02">/);
    }
    const r2010 = r.body.events[1];
    expect(r2010.xml).toContain(`<cnpjPrestador>${supplierCnpj}</cnpjPrestador><vlrTotalBruto>10000,00</vlrTotalBruto><vlrTotalBaseRet>9000,00</vlrTotalBaseRet><vlrTotalRetPrinc>990,00</vlrTotalRetPrinc>`);
    expect(r2010.xml).toContain('<tpServico>100000003</tpServico>');
    const r4020 = r.body.events[2];
    expect(r4020.xml).toContain(`<cnpjBenef>${supplierCnpj}</cnpjBenef><idePgto><natRend>17001</natRend><infoPgto><dtFG>${today}</dtFG><vlrBruto>10000,00</vlrBruto>`);
    expect(r4020.xml).toContain('<vlrIR>100,00</vlrIR><vlrBaseAgreg>10000,00</vlrBaseAgreg><vlrAgreg>465,00</vlrAgreg>');
    expect(r.body.events[3].xml).toContain('<evtServTm>S</evtServTm><evtServPr>N</evtServPr>');
    expect(r.body.events[0].xml).toContain('<classTrib>99</classTrib>');
    expect(reinfEventId('12345678', new Date('2026-10-22T10:11:12Z'), 7)).toBe('ID1123456780000002026102210111200007');
    const dl = await app.inject({ method: 'GET', url: `/v1/obligations/reinf/download?period=${period}`, headers: { authorization: `Bearer ${presumido.admin.token}`, 'x-company-id': presumido.companyId } });
    expect(dl.statusCode).toBe(200);
    expect(gunzipSync(dl.rawPayload).toString('latin1')).toContain('R-2010_ID1');
    // Cancelar a nota estorna títulos em aberto e o contábil; some da Reinf
    const c = await presumido.admin.post(`/v1/purchasing/service-invoices/${invoice.id}/cancel`, { reason: 'Nota emitida em duplicidade pelo prestador' });
    expect(c.body.status).toBe('cancelled');
    expect((await presumido.admin.get('/v1/obligations/reinf', { period })).body.events.map((e: any) => e.type)).toEqual(['R-2099', 'R-4099']);
    const b = await tb(presumido);
    expect(b.totals.debit).toBe(b.totals.credit);
  });
});

describe('EFD-Contribuições (Lucro Presumido, cumulativo)', () => {
  it('blocos 0, A, C, M e 9 consistentes; PIS 0,65% e Cofins 3% sobre a receita sem o ICMS (Tema 69 do STF)', async () => {
    await sell(presumido, 'CAMISA-P', 10, '100.00');
    const r = await presumido.admin.get('/v1/obligations/efd-contribuicoes', { period });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lines: string[] = r.body.content.trim().split('\r\n');
    const reg = (code: string) => lines.filter((l) => l.startsWith(`|${code}|`)).map((l) => l.split('|').slice(1, -1));
    expect(reg('0000')[0]!.slice(0, 3)).toEqual(['0000', '006', '0']);
    expect(reg('0110')[0]).toEqual(['0110', '2', '', '1', '9']);
    expect(reg('C100')).toHaveLength(1);
    expect(reg('C170')[0]).toHaveLength(37);
    const m210 = reg('M210')[0]!;
    expect(m210).toHaveLength(16);
    // Receita 1.000,00; base 795,00 (sem o ICMS de 20,5% de PE)
    expect(m210.slice(0, 4)).toEqual(['M210', '51', '1000,00', '795,00']);
    expect(m210[10]).toBe('5,17');
    expect(reg('M610')[0]![10]).toBe('23,85');
    expect(r.body.totals).toMatchObject({ regime: 'cumulativo', revenue: '1000.00', pisBase: '795.00', pis: '5.17', cofins: '23.85', pisToPay: '5.17', cofinsToPay: '23.85' });
    // Bloco 9: 9900 de cada registro e total de linhas
    const total = reg('9999')[0]![1];
    expect(Number(total)).toBe(lines.length);
    for (const [, code, n] of reg('9900')) expect(lines.filter((l) => l.startsWith(`|${code}|`)).length).toBe(Number(n));
    for (const b of ['0', 'A', 'C', 'D', 'F', 'I', 'M', 'P', '1']) {
      // O bloco 0 conta desde o 0000
      const start = b === '0' ? 0 : lines.findIndex((l) => l.startsWith(`|${b}001|`));
      const end = lines.findIndex((l) => l.startsWith(`|${b}990|`));
      expect(Number(lines[end]!.split('|')[2])).toBe(end - start + 1);
    }
  });

  it('optante do Simples não entrega EFD-Contribuições', async () => {
    const r = await simples.admin.get('/v1/obligations/efd-contribuicoes', { period });
    expect(r.status).toBe(422);
  });
});

describe('Apoio ao PGDAS-D e à DEFIS (Simples Nacional)', () => {
  it('receita segregada por anexo; RBT12 dos 12 meses anteriores; alíquota efetiva estimada', async () => {
    expect(isRevenueCfop('5102')).toBe(true);
    expect(isRevenueCfop('5910')).toBe(false);
    expect(isRevenueCfop('7101')).toBe(true);
    await sell(simples, 'BLUSA', 20, '50.00');
    const r = await simples.admin.get('/v1/obligations/pgdas', { period });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ rbt12: '0.00', revenue: '1000.00' });
    expect(r.body.establishments[0].segments).toEqual([expect.objectContaining({ annex: 'I', activity: 'Revenda de mercadorias', revenue: '1000.00', effectiveRate: '4.0000', estimatedDas: '40.00' })]);
    // No mês seguinte a venda entra no RBT12
    const next = (await simples.admin.get('/v1/obligations/pgdas', { period: nextPeriod })).body;
    expect(next).toMatchObject({ rbt12: '1000.00', revenue: '0.00' });
    expect((await presumido.admin.get('/v1/obligations/pgdas', { period })).status).toBe(422);
  });

  it('DEFIS: receita anual por mês, saldos e estoque no início e no fim do ano', async () => {
    const r = await simples.admin.get('/v1/obligations/defis', { year: period.slice(0, 4) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.revenue).toBe('1000.00');
    expect(r.body.months.find((m: any) => m.period === period).revenue).toBe('1000.00');
    // Estoque: 1.000 un × R$ 10 de abertura − 20 vendidas
    expect(r.body.inventory.end).toBe(D(980).times(10).toFixed(2));
    expect(r.body.employees).toEqual({ start: 0, end: 0 });
  });
});
