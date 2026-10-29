import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/http/app.js';
import { createUser, makeApp, makeCnpj, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let presumido: TenantFixture;
let productId: string;
let serviceId: string;

const pjSP = () => ({ kind: 'PJ', taxId: makeCnpj(), legalName: 'Cliente SP LTDA', roles: ['customer'], ieIndicator: 1, ie: '110.042.490.114',
  addresses: [{ kind: 'fiscal', zip: '01310100', street: 'Av. Paulista', number: '1000', district: 'Bela Vista', cityIbge: '3550308', cityName: 'São Paulo', uf: 'SP' }] });

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  presumido = await setupTenant(app, { regime: 'lucro_presumido' });
  for (const f of [t, presumido]) {
    const p = await f.admin.post('/v1/products', { sku: 'CAMISA', description: 'Camiseta', ncm: '61091000' });
    productId = p.body.id;
    const s = await f.admin.post('/v1/products', { sku: 'CONSULT', description: 'Consultoria', kind: 'service', serviceCode: '17.01', stockUnit: 'HR' });
    serviceId = s.body.id;
  }
});
afterAll(async () => app.close());

describe('Motor fiscal na API', () => {
  it('Simples Nacional: venda interna a consumidor sem destaque (CSOSN 102)', async () => {
    const pid = (await t.admin.get('/v1/products', { q: 'CAMISA' })).body.items[0].id;
    const r = await t.admin.post('/v1/fiscal/simulate', { establishmentId: t.establishmentId, items: [{ productId: pid, quantity: 2, unitPrice: '50' }] });
    expect(r.status).toBe(200);
    expect(r.body.regime).toBe('simples_nacional');
    expect(r.body.items[0]).toMatchObject({ cfop: '5102', taxes: { icms: { csosn: '102' } } });
    expect(r.body.totals.invoice).toBe('100.00');
  });

  it('Lucro presumido: venda interestadual PE→SP a contribuinte (12%), regime lido com vigência', async () => {
    const cli = await presumido.admin.post('/v1/parties', pjSP());
    const r = await presumido.admin.post('/v1/fiscal/simulate', { establishmentId: presumido.establishmentId, partyId: cli.body.id, date: '2026-10-01', items: [{ productId, quantity: 1, unitPrice: '1000' }] });
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ cfop: '6102', taxes: { icms: { rate: '12.0000', value: '120.00' }, pis: { value: '5.72' }, cofins: { value: '26.40' } } });
    // RN-FIS-04: memória de cálculo legível para o contador
    expect(r.body.items[0].memory.some((m: any) => m.tax === 'ICMS' && m.description.includes('12'))).toBe(true);
    expect(r.body.items[0].taxes.ibsCbs.informative).toBe(true);
  });

  it('RN-FIS-01 regra cadastrada é aplicada e empate é bloqueado ao salvar', async () => {
    const a = await presumido.admin.post('/v1/tax-rules', { name: 'Camisetas SP 7%', validFrom: '2020-01-01', ncmPrefix: '6109', ufDest: 'SP', result: { icms: { cst: '00', rate: '7' } } });
    expect(a.status).toBe(201);
    const tie = await presumido.admin.post('/v1/tax-rules', { name: 'Duplicada', validFrom: '2025-01-01', ncmPrefix: '6109', ufDest: 'SP', result: { icms: { rate: '9' } } });
    expect(tie.status).toBe(409);
    expect(tie.body.details.rule).toBe('RN-FIS-01');
    const cli = await presumido.admin.post('/v1/parties', pjSP());
    const r = await presumido.admin.post('/v1/fiscal/simulate', { establishmentId: presumido.establishmentId, partyId: cli.body.id, date: '2026-10-01', items: [{ productId, quantity: 1, unitPrice: '100' }] });
    expect(r.body.items[0].taxes.icms.rate).toBe('7.0000');
    expect(r.body.items[0].appliedRules[0]).toMatchObject({ group: 'icms', ruleName: 'Camisetas SP 7%' });
  });

  it('regra com resultado inválido é recusada pelo esquema', async () => {
    const r = await presumido.admin.post('/v1/tax-rules', { name: 'Inválida', validFrom: '2026-01-01', result: { icms: { cst: 'XX' } } });
    expect(r.status).toBe(422);
  });

  it('serviço sem alíquota de ISS parametrizada é erro de configuração fiscal', async () => {
    const r = await presumido.admin.post('/v1/fiscal/simulate', { establishmentId: presumido.establishmentId, operationTypeCode: 'SERVICO', items: [{ productId: serviceId, quantity: 1, unitPrice: '1000' }] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('FISCAL_CONFIG');
    await presumido.admin.post('/v1/tax-rules', { name: 'ISS Recife 5%', validFrom: '2020-01-01', itemKind: 'service', result: { iss: { rate: '5' } } });
    const ok = await presumido.admin.post('/v1/fiscal/simulate', { establishmentId: presumido.establishmentId, operationTypeCode: 'SERVICO', items: [{ productId: serviceId, quantity: 1, unitPrice: '1000' }] });
    expect(ok.body.items[0].taxes.iss.value).toBe('50.00');
  });

  it('assistente gera rascunho de regras e a validação do contador fica registrada', async () => {
    const w = await presumido.admin.post('/v1/fiscal/wizard', { establishmentId: presumido.establishmentId, apply: true, validFrom: '2026-01-01' });
    expect(w.status).toBe(200);
    expect(w.body.drafts.length).toBeGreaterThan(0);
    expect(w.body.notice).toMatch(/contador/);
    const contador = await createUser(app, presumido, ['contador']);
    const rid = w.body.created[0].id;
    const v = await contador.post(`/v1/tax-rules/${rid}/accountant-validation`);
    expect(v.body.validated_by_accountant).toBe(true);
  });

  it('RN-REF-07 simulador de impacto da reforma por produto e ano', async () => {
    const r = await presumido.admin.post('/v1/fiscal/reform-impact', { establishmentId: presumido.establishmentId, productIds: [productId], years: [2026, 2027, 2033] });
    expect(r.status).toBe(200);
    const y = r.body.rows[0].years;
    expect(Number(y[2026].taxes)).toBeGreaterThan(0);
    expect(y[2027].breakdown.pis).toBe('0.00');
    expect(Number(y[2027].breakdown.cbs)).toBeGreaterThan(0);
    expect(y[2033].breakdown.icms).toBe('0.00');
  });
});
