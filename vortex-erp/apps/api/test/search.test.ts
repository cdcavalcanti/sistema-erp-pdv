import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/http/app.js';
import { createUser, makeApp, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  await t.admin.post('/v1/products', { sku: 'CAFE-500', description: 'Café torrado e moído 500g', ncm: '09012100', stockUnit: 'UN', saleUnit: 'UN' });
  await t.admin.post('/v1/parties', { kind: 'PF', taxId: '529.982.247-25', legalName: 'Maria Cafeteira', roles: ['customer'], finalConsumer: true, addresses: ADDR });
});
afterAll(async () => app.close());

describe('Busca global', () => {
  it('encontra produto e pessoa; documento da pessoa sai mascarado; respeita permissões e tenant', async () => {
    const r = await t.admin.get('/v1/search', { q: 'caf' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.hits.map((h: any) => h.type).sort()).toEqual(['party', 'product']);
    expect(r.body.hits.find((h: any) => h.type === 'party')).toMatchObject({ title: 'Maria Cafeteira', subtitle: 'CPF 529***25' });
    expect(JSON.stringify(r.body)).not.toContain('52998224725');
    // Pela parte do CPF também
    expect((await t.admin.get('/v1/search', { q: '529.982' })).body.hits[0].type).toBe('party');
    // Estoquista não lê pessoas
    const est = await createUser(app, t, ['estoquista']);
    expect((await est.get('/v1/search', { q: 'caf' })).body.hits.map((h: any) => h.type)).toEqual(['product']);
    const other = await setupTenant(app);
    expect((await other.admin.get('/v1/search', { q: 'caf' })).body.hits).toEqual([]);
  });
});
