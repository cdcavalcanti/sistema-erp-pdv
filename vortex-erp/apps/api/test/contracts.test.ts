import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { addMonths } from '../src/modules/contracts/service.js';
import { nationalServiceCode } from '../src/modules/fiscal-docs/nfse-xml.js';
import { makeApp, makeCnpj, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let customer: string;
let consulting: string;
let messages: string;
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const ADDR = [{ kind: 'fiscal', zip: '01310100', street: 'Av. Paulista', number: '1000', district: 'Bela Vista', cityIbge: '3550308', cityName: 'São Paulo', uf: 'SP' }];

async function titlesOf(contractId: string) {
  return (await t.admin.get('/v1/finance/titles', { kind: 'receivable', limit: '200' })).body.items.filter((x: any) => x.origin_id === contractId).sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));
}
async function balanced() {
  const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
  expect(tb.totals.debit).toBe(tb.totals.credit);
}

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app, { regime: 'lucro_presumido' });
  expect((await t.admin.post('/v1/tax-rules', { name: 'ISS Recife 5%', validFrom: '2020-01-01', itemKind: 'service', result: { iss: { rate: '5' } } })).status).toBe(201);
  customer = (await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Cliente Assinante SA', roles: ['customer'], ieIndicator: 9, addresses: ADDR, xmlEmail: 'fin@assinante.test' })).body.id;
  consulting = (await t.admin.post('/v1/products', { sku: 'SUPORTE', description: 'Suporte e manutenção de sistemas', kind: 'service', serviceCode: '1.07', stockUnit: 'UN' })).body.id;
  messages = (await t.admin.post('/v1/products', { sku: 'MSG', description: 'Mensagens de IA', kind: 'service', serviceCode: '1.07', stockUnit: 'UN' })).body.id;
  expect(consulting && messages && customer).toBeTruthy();
});
afterAll(async () => app.close());

describe('Contratos e faturamento recorrente (seção 16)', () => {
  let contractId: string;
  let usageItem: string;

  it('cria contrato e fatura o 1º período com NFS-e nacional autorizada, título e contábil', async () => {
    const c = await t.admin.post('/v1/contracts', {
      establishmentId: t.establishmentId, partyId: customer, periodicity: 'monthly', billingDay: 10, dueDays: 5, startDate: '2026-01-10', endDate: '2026-12-31', autoRenew: false,
      adjustmentIndex: 'fixed', adjustmentPercent: '10', adjustmentDate: '2026-03-10', terminationFinePercent: '20',
      items: [{ productId: consulting, unitPrice: '1000.00' }, { productId: messages, billingType: 'usage', unitPrice: '0.05', usageMetric: 'mensagens', includedQuantity: '1000' }],
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    contractId = c.body.id;
    expect(c.body.next_billing_date).toBe('2026-01-10');
    expect(c.body.monthlyValue).toBe('1000.00');
    usageItem = c.body.items.find((i: any) => i.billing_type === 'usage').id;

    const b = await t.admin.post(`/v1/contracts/${contractId}/bill`, { date: '2026-01-10' });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.amount).toBe('1000.00');
    expect(b.body.transmissions[0].status).toBe('autorizada');
    const doc = (await t.admin.get(`/v1/fiscal/documents/${b.body.documentIds[0]}`)).body;
    expect(doc.model).toBe('99');
    expect(doc.nfse_key).toMatch(/^\d{50}$/);
    expect(doc.total_invoice).toBe('1000.00');
    expect(doc.items[0].taxes.find((x: any) => x.tax === 'ISS').value).toBe('50.00');
    const titles = await titlesOf(contractId);
    expect(titles[0]).toMatchObject({ amount: '1000.00', due_date: '2026-01-15' });
    // Mesmo período de novo não duplica
    expect((await t.admin.post(`/v1/contracts/${contractId}/bill`, { date: '2026-01-10' })).body.skipped).toBe(true);
    await balanced();
  });

  it('consumo variável acima da franquia entra no período seguinte; idempotente pela referência', async () => {
    const u = await t.admin.post('/v1/contracts/usage', { records: [
      { contractItemId: usageItem, occurredOn: '2026-01-20', quantity: '900', reference: 'meter-jan-1' },
      { contractItemId: usageItem, occurredOn: '2026-01-31', quantity: '600', reference: 'meter-jan-2' },
      { contractItemId: usageItem, occurredOn: '2026-01-31', quantity: '600', reference: 'meter-jan-2' },
    ] });
    expect(u.body).toEqual({ created: 2, duplicates: 1 });
    const b = await t.admin.post(`/v1/contracts/${contractId}/bill`, { date: '2026-02-10' });
    expect(b.body.amount).toBe('1025.00');
    expect(b.body.lines.find((l: any) => l.kind === 'usage')).toMatchObject({ quantity: '500', total: '25.00' });
  });

  it('RN-CTR-01 reajuste na data-base vale da competência seguinte, com histórico; títulos anteriores não mudam', async () => {
    const b = await t.admin.post(`/v1/contracts/${contractId}/bill`, { date: '2026-03-10' });
    expect(b.body.adjustedPercent).toBe('10.0000');
    expect(b.body.amount).toBe('1100.00');
    const titles = await titlesOf(contractId);
    expect(titles.map((x: any) => x.amount)).toEqual(['1000.00', '1025.00', '1100.00']);
    const c = (await t.admin.get(`/v1/contracts/${contractId}`)).body;
    expect(c.history.filter((h: any) => h.reason === 'adjustment').map((h: any) => [h.old_price, h.new_price, h.valid_from.slice(0, 10)]))
      .toEqual(expect.arrayContaining([['1000.0000000000', '1100.0000000000', '2026-03-10']]));
    expect(c.next_adjustment_date.slice(0, 10)).toBe('2027-03-10');
  });

  it('RN-CTR-02 upgrade no meio do ciclo cobra a diferença pro rata dos dias restantes', async () => {
    const r = await t.admin.post(`/v1/contracts/${contractId}/plan`, { effectiveDate: '2026-03-25', items: [{ productId: consulting, unitPrice: '1650.00' },
      { productId: messages, billingType: 'usage', unitPrice: '0.05', usageMetric: 'mensagens', includedQuantity: '1000' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // (1650 − 1100) × 16 dias restantes / 31 dias do período
    expect(r.body.prorata).toEqual({ amount: '283.87', kind: 'charge', days: 16 });
    const titles = await titlesOf(contractId);
    expect(titles.some((x: any) => x.amount === '283.87')).toBe(true);
    const ind = (await t.admin.get('/v1/contracts/indicators', { date: '2026-03-26' })).body;
    expect(ind.mrr).toBe('1650.00');
    expect(ind.activeContracts).toBe(1);
  });

  it('downgrade gera crédito abatido no próximo faturamento', async () => {
    const r = await t.admin.post(`/v1/contracts/${contractId}/plan`, { effectiveDate: '2026-03-30', items: [{ productId: consulting, unitPrice: '1340.00' }] });
    // (1340 − 1650) × 11 / 31 = −110,00
    expect(r.body.prorata).toEqual({ amount: '110.00', kind: 'credit', days: 11 });
    const b = await t.admin.post(`/v1/contracts/${contractId}/bill`, { date: '2026-04-10' });
    expect(b.body).toMatchObject({ amount: '1230.00', creditApplied: '110.00' });
    expect(D((await t.admin.get(`/v1/contracts/${contractId}`)).body.credit_balance).isZero()).toBe(true);
  });

  it('rescisão com multa sobre os meses restantes; motivo obrigatório', async () => {
    expect((await t.admin.post(`/v1/contracts/${contractId}/cancel`, { reason: 'curto', date: '2026-04-15' })).status).toBe(422);
    const r = await t.admin.post(`/v1/contracts/${contractId}/cancel`, { reason: 'Cliente encerrou as operações da filial', date: '2026-04-15' });
    expect(r.status).toBe(200);
    // 1340 × 9 meses restantes × 20%
    expect(r.body.fine).toBe(D(1340).times(Math.ceil((Date.parse('2026-12-31') - Date.parse('2026-04-15')) / 86_400_000 / 30)).times('0.2').toFixed(2));
    expect((await t.admin.get(`/v1/contracts/${contractId}`)).body.status).toBe('cancelled');
    await balanced();
  });

  it('reajuste por índice: sem os 12 meses cadastrados o faturamento falha e é registrado; depois fatura com o acumulado', async () => {
    const c = await t.admin.post('/v1/contracts', { establishmentId: t.establishmentId, partyId: customer, periodicity: 'quarterly', billingDay: 5, startDate: '2025-01-05',
      adjustmentIndex: 'IPCA', adjustmentDate: '2026-01-05', documentModel: 'none', items: [{ productId: consulting, unitPrice: '3000.00' }] });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await run((tx) => tx.exec(`UPDATE contracts.contracts SET next_billing_date = '2026-01-05' WHERE id = $1`, [c.body.id]));
    const r1 = (await t.admin.post('/v1/contracts/billing/run', { date: '2026-01-05' })).body;
    expect(r1.failed).toBe(1);
    expect(r1.errors[0].error).toContain('IPCA');
    const failed = (await t.admin.get(`/v1/contracts/${c.body.id}`)).body.billings[0];
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    const rates = Array.from({ length: 12 }, (_, i) => ({ index: 'IPCA', month: addMonths('2025-01-01', i).slice(0, 7), percent: '0.40' }));
    expect((await t.admin.put('/v1/contracts/index-rates', { rates })).status).toBe(200);
    const r2 = (await t.admin.post('/v1/contracts/billing/run', { date: '2026-01-05' })).body;
    expect(r2.invoiced).toBe(1);
    const got = (await t.admin.get(`/v1/contracts/${c.body.id}`)).body;
    // (1,004)^12 − 1 = 4,9070%
    expect(D(got.items[0].unit_price).toFixed(2)).toBe('3147.21');
    expect(got.billings[0]).toMatchObject({ status: 'invoiced', amount: '3147.21' });
    expect(got.next_billing_date.slice(0, 10)).toBe('2026-04-05');
    // Fluxo de caixa projetado inclui o próximo faturamento do contrato (vencimento 10/04)
    const cf = (await t.admin.get('/v1/finance/cash-flow', { from: '2026-04-01', to: '2026-04-30', granularity: 'month' })).body;
    expect(cf.rows.find((r: any) => r.period === '2026-04-01').projectedIn).toBe('3147.21');
  });
});

describe('Ordens de serviço e NFS-e avulsa', () => {
  it('OS: agenda, peça baixa estoque, assinatura obrigatória para concluir, faturamento por NFS-e', async () => {
    const part = (await t.admin.post('/v1/products', { sku: 'CABO-HDMI', description: 'Cabo HDMI 2m', ncm: '61091000' })).body.id;
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: part, type: 'opening', quantity: '10', unitCost: '12.00', sourceType: 'test' }));
    const so = await t.admin.post('/v1/service-orders', { establishmentId: t.establishmentId, partyId: customer, serviceProductId: consulting, description: 'Instalação de sala de reunião',
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), hourlyRate: '150.00' });
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    expect(so.body.status).toBe('scheduled');
    const id = so.body.id;
    await t.admin.post(`/v1/service-orders/${id}/parts`, { productId: part, quantity: '2', unitPrice: '30.00' });
    expect((await t.admin.get('/v1/stock/balances', { productId: part })).body[0].quantity).toBe('8.0000');
    expect((await t.admin.patch(`/v1/service-orders/${id}`, { status: 'done', hours: '2' })).status).toBe(422);
    await t.admin.post(`/v1/service-orders/${id}/signature`, { signedBy: 'João do Cliente', signaturePng: Buffer.from('fake-png').toString('base64') });
    const done = await t.admin.patch(`/v1/service-orders/${id}`, { status: 'done', hours: '2' });
    expect(done.body).toMatchObject({ status: 'done', laborTotal: '300.00', partsTotal: '60.00' });
    const inv = await t.admin.post(`/v1/service-orders/${id}/invoice`, {});
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect(inv.body.total).toBe('360.00');
    expect(inv.body.transmission.status).toBe('autorizada');
    expect((await t.admin.get(`/v1/service-orders/${id}`)).body.status).toBe('invoiced');
    await balanced();
  });

  it('NFS-e avulsa: DPS com código de tributação nacional e alíquota do ISS; cancelamento', async () => {
    expect(nationalServiceCode('1.07')).toBe('010701');
    const r = await t.admin.post('/v1/fiscal/nfse', { establishmentId: t.establishmentId, partyId: customer, items: [{ productId: consulting, quantity: '1', unitPrice: '500.00' }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.transmission.status).toBe('autorizada');
    const doc = (await t.admin.get(`/v1/fiscal/documents/${r.body.id}`)).body;
    const dps = await app.deps.services.storage.get(doc.xml_key);
    expect(dps.toString()).toContain('<cTribNac>010701</cTribNac>');
    expect(dps.toString()).toContain('<pAliq>5.00</pAliq>');
    const c = await t.admin.post(`/v1/fiscal/documents/${r.body.id}/cancellation`, { reason: 'Serviço faturado em duplicidade', goodsDidNotCirculate: false });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await t.admin.get(`/v1/fiscal/documents/${r.body.id}`)).body.status).toBe('cancelada');
  });
});
