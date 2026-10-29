import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/http/app.js';
import { FakePublicLookup } from '../src/core/lookups.js';
import { createUser, makeApp, makeCnpj, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;

const customerPJ = (cnpj: string, extra: Record<string, unknown> = {}) => ({
  kind: 'PJ', taxId: cnpj, legalName: 'Cliente Atacado LTDA', roles: ['customer'], ieIndicator: 1, ie: '110.042.490.114',
  addresses: [{ kind: 'fiscal', zip: '01310100', street: 'Av. Paulista', number: '1000', district: 'Bela Vista', cityIbge: '3550308', cityName: 'São Paulo', uf: 'SP' }],
  ...extra,
});

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
});
afterAll(async () => app.close());

describe('Padrões de implantação', () => {
  it('tenant nasce com condições, formas de pagamento, plano de contas, DRE e tipos de operação', async () => {
    const [terms, methods, coa, cats, ops, accounts] = await Promise.all([
      t.admin.get('/v1/payment-terms'), t.admin.get('/v1/payment-methods'), t.admin.get('/v1/chart-of-accounts'),
      t.admin.get('/v1/categories'), t.admin.get('/v1/operation-types'), t.admin.get('/v1/financial-accounts'),
    ]);
    expect(terms.body.map((x: any) => x.code)).toContain('30/60/90');
    expect(methods.body.find((m: any) => m.code === 'PIX').nfe_tpag).toBe('17');
    expect(coa.body.length).toBeGreaterThan(30);
    expect(coa.body.every((c: any) => c.referential_code)).toBe(true);
    expect(cats.body.length).toBeGreaterThan(10);
    expect(ops.body.find((o: any) => o.code === 'VENDA').cfop_interstate).toBe('6102');
    expect(accounts.body.map((a: any) => a.code)).toEqual(['ADQUIRENTE', 'BANCO', 'CAIXA']);
  });
});

describe('Pessoas (cadastro único com papéis)', () => {
  it('RN-CAD-01 rejeita CPF/CNPJ inválido e aceita CNPJ alfanumérico', async () => {
    const bad = await t.admin.post('/v1/parties', { kind: 'PF', taxId: '123.456.789-00', legalName: 'Fulano', roles: ['customer'], addresses: [] });
    expect(bad.status).toBe(422);
    expect(bad.body.details.fields.taxId).toBe('CPF inválido');
    const alfa = await t.admin.post('/v1/parties', customerPJ('12.ABC.345/01DE-35', { ieIndicator: 9, ie: null }));
    expect(alfa.status).toBe(201);
    expect(alfa.body.tax_id).toBe('12ABC34501DE35');
  });

  it('RN-CAD-02 CPF/CNPJ único entre ativos: duplicar devolve o cadastro existente', async () => {
    const cnpj = makeCnpj();
    const a = await t.admin.post('/v1/parties', customerPJ(cnpj));
    expect(a.status).toBe(201);
    const b = await t.admin.post('/v1/parties', customerPJ(cnpj));
    expect(b.status).toBe(409);
    expect(b.body.details.existingId).toBe(a.body.id);
    // Uma empresa que compra e vende não é cadastrada duas vezes: ganha outro papel
    const upd = await t.admin.patch(`/v1/parties/${a.body.id}`, { version: a.body.version, roles: ['customer', 'supplier'] });
    expect(upd.status).toBe(200);
    expect(upd.body.roles.sort()).toEqual(['customer', 'supplier']);
  });

  it('RN-CAD-03 IE obrigatória para contribuinte e validada pela UF; isento grava "ISENTO"', async () => {
    const semIe = await t.admin.post('/v1/parties', customerPJ(makeCnpj(), { ie: null }));
    expect(semIe.status).toBe(422);
    expect(semIe.body.details.fields.ie).toMatch(/obrigatória/);
    const ieErrada = await t.admin.post('/v1/parties', customerPJ(makeCnpj(), { ie: '110.042.490.115' }));
    expect(ieErrada.status).toBe(422);
    const isento = await t.admin.post('/v1/parties', customerPJ(makeCnpj(), { ieIndicator: 2, ie: null }));
    expect(isento.status).toBe(201);
    expect(isento.body.ie).toBe('ISENTO');
  });

  it('não contribuinte é sempre consumidor final', async () => {
    const r = await t.admin.post('/v1/parties', { kind: 'PF', taxId: '529.982.247-25', legalName: 'Maria Consumidora', roles: ['customer'], ieIndicator: 9, finalConsumer: false,
      addresses: [{ kind: 'fiscal', zip: '50050000', street: 'Rua da Aurora', number: '1', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }] });
    expect(r.status).toBe(201);
    expect(r.body.final_consumer).toBe(true);
  });

  it('valida município × UF pelo código IBGE', async () => {
    const r = await t.admin.post('/v1/parties', customerPJ(makeCnpj(), {
      addresses: [{ kind: 'fiscal', zip: '01310100', street: 'Av', number: '1', district: 'X', cityIbge: '2611606', cityName: 'Recife', uf: 'SP' }],
    }));
    expect(r.status).toBe(422);
    expect(r.body.details.fields['addresses.0.cityIbge']).toMatch(/UF/);
  });

  it('concorrência otimista: alteração com versão antiga é recusada', async () => {
    const a = await t.admin.post('/v1/parties', customerPJ(makeCnpj()));
    const u1 = await t.admin.patch(`/v1/parties/${a.body.id}`, { version: a.body.version, tradeName: 'Nome 1' });
    expect(u1.status).toBe(200);
    const u2 = await t.admin.patch(`/v1/parties/${a.body.id}`, { version: a.body.version, tradeName: 'Nome 2' });
    expect(u2.status).toBe(409);
    expect(u2.body.code).toBe('VERSION_CONFLICT');
  });

  it('RN-CAD-05 exclusão física só sem vínculo; RN-ACE-03 bloqueio exige motivo', async () => {
    const a = await t.admin.post('/v1/parties', customerPJ(makeCnpj()));
    const semMotivo = await t.admin.post(`/v1/parties/${a.body.id}/status`, { status: 'blocked' });
    expect(semMotivo.status).toBe(422);
    expect(semMotivo.body.details.rule).toBe('RN-ACE-03');
    const bloq = await t.admin.post(`/v1/parties/${a.body.id}/status`, { status: 'blocked', reason: 'Inadimplência recorrente acima de 90 dias' });
    expect(bloq.body.status).toBe('blocked');
    const del = await t.admin.del(`/v1/parties/${a.body.id}`);
    expect(del.status).toBe(200);
  });

  it('RN-CAD-04 consulta pública de CNPJ e situação cadastral', async () => {
    const cnpj = makeCnpj();
    (app.deps.services.lookups as FakePublicLookup).cnpjs.set(cnpj, {
      cnpj, legalName: 'Empresa Baixada SA', tradeName: null, registrationStatus: 'baixada', cnae: '4711302', phone: null, email: null, simplesNacional: false,
      address: { zip: '01310100', street: 'Av. Paulista', number: '1', complement: null, district: 'Bela Vista', cityName: 'São Paulo', cityIbge: '3550308', uf: 'SP' },
    });
    const r = await t.admin.get(`/v1/lookups/cnpj/${cnpj}`);
    expect(r.status).toBe(200);
    expect(r.body.blocksCreditSale).toBe(true);
    const p = await t.admin.post('/v1/parties', customerPJ(cnpj));
    const ref = await t.admin.post(`/v1/parties/${p.body.id}/refresh-registration`);
    expect(ref.body.registrationStatus).toBe('baixada');
    const cep = await t.admin.get('/v1/lookups/cep/50050-000');
    expect(cep.body.cityIbge).toBe('2611606');
  });

  it('vendedor com carteira própria só vê os próprios clientes', async () => {
    const vendedorParty = await t.admin.post('/v1/parties', { kind: 'PF', taxId: '111.444.777-35', legalName: 'Vendedor Um', roles: ['salesperson', 'employee'], addresses: [] });
    const v = await createUser(app, t, ['vendedor'], { ownPortfolioOnly: true, partyId: vendedorParty.body.id });
    const meu = await t.admin.post('/v1/parties', customerPJ(makeCnpj(), { salespersonId: vendedorParty.body.id }));
    const outro = await t.admin.post('/v1/parties', customerPJ(makeCnpj()));
    const list = await v.get('/v1/parties', { role: 'customer' });
    const ids = list.body.items.map((x: any) => x.id);
    expect(ids).toContain(meu.body.id);
    expect(ids).not.toContain(outro.body.id);
    expect((await v.get(`/v1/parties/${outro.body.id}`)).status).toBe(403);
  });
});

describe('RN-ACE-02 conta bancária de fornecedor com dupla aprovação', () => {
  it('nasce pendente, exige 2 aprovadores distintos e quem solicitou não aprova', async () => {
    const forn = await t.admin.post('/v1/parties', customerPJ(makeCnpj(), { roles: ['supplier'] }));
    const fin = await createUser(app, t, ['financeiro']);
    const acc = await fin.post(`/v1/parties/${forn.body.id}/bank-accounts`, { pixKeyType: 'cnpj', pixKey: forn.body.tax_id, holderName: forn.body.legal_name, holderTaxId: forn.body.tax_id });
    expect(acc.status).toBe(201);
    expect(acc.body.status).toBe('pending_approval');
    // financeiro não tem a permissão de aprovar; e quem solicitou não aprova o próprio pedido
    const selfApprove = await fin.post(`/v1/approvals/${acc.body.approvalRequestId}/decision`, { decision: 'approve' });
    expect(selfApprove.status).toBe(403);
    const ap1 = await createUser(app, t, ['administrador']);
    const ap2 = await createUser(app, t, ['administrador']);
    const v1 = await ap1.post(`/v1/approvals/${acc.body.approvalRequestId}/decision`, { decision: 'approve' });
    expect(v1.body.status).toBe('pending');
    const v1b = await ap1.post(`/v1/approvals/${acc.body.approvalRequestId}/decision`, { decision: 'approve' });
    expect(v1b.status).toBe(409);
    const v2 = await ap2.post(`/v1/approvals/${acc.body.approvalRequestId}/decision`, { decision: 'approve' });
    expect(v2.body.status).toBe('approved');
    const party = await t.admin.get(`/v1/parties/${forn.body.id}`);
    expect(party.body.bankAccounts[0].status).toBe('active');
    expect(party.body.bankAccounts[0].pix_key_masked).toMatch(/\*\*\*\*$/);
    const events = await t.admin.get('/v1/events', { type: 'fornecedor.conta_bancaria_alterada' });
    expect(events.body.length).toBeGreaterThan(0);
  });
});

describe('RN-ACE-04 LGPD', () => {
  it('exporta e anonimiza dados pessoais de PF', async () => {
    const p = await t.admin.post('/v1/parties', { kind: 'PF', taxId: '390.533.447-05', legalName: 'João Titular', roles: ['customer'], birthDate: '1990-01-01',
      addresses: [{ kind: 'fiscal', zip: '50050000', street: 'Rua', number: '1', district: 'Centro', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }],
      contacts: [{ name: 'João', email: 'joao@example.com', consents: { marketing: true } }] });
    const exp = await t.admin.get(`/v1/parties/${p.body.id}/lgpd-export`);
    expect(exp.body.titular.contacts[0].email).toBe('joao@example.com');
    const an = await t.admin.post(`/v1/parties/${p.body.id}/anonymize`, { reason: 'Solicitação do titular via canal de privacidade' });
    expect(an.body.anonymized).toBe(true);
    const after = await t.admin.get(`/v1/parties/${p.body.id}`);
    expect(after.body.contacts).toHaveLength(0);
    expect(after.body.birth_date).toBeNull();
    expect(after.body.status).toBe('inactive');
  });
});

describe('Tabelas auxiliares', () => {
  it('condição de pagamento deve somar 100%', async () => {
    const bad = await t.admin.post('/v1/payment-terms', { code: 'X', name: 'X', installments: [{ days: 30, percent: 50 }] });
    expect(bad.status).toBe(422);
    const ok = await t.admin.post('/v1/payment-terms', { code: '28/56', name: '28/56', installments: [{ days: 28, percent: 50 }, { days: 56, percent: 50 }] });
    expect(ok.status).toBe(201);
  });

  it('tabelas oficiais com busca', async () => {
    const r = await t.admin.get('/v1/official/cfop', { q: '5102' });
    expect(r.body[0].description).toMatch(/Venda de mercadoria/);
    const n = await t.admin.get('/v1/official/ncm', { q: 'Smartphones' });
    expect(n.body[0].code).toBe('85171300');
  });
});
