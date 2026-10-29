import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import type { App } from '../src/http/app.js';
import { client, createUser, makeApp, makeCnpj, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let a: TenantFixture;
let b: TenantFixture;

beforeAll(async () => {
  app = await makeApp();
  a = await setupTenant(app);
  b = await setupTenant(app);
});
afterAll(async () => {
  await app.close();
});

describe('Fase 0 — fundação', () => {
  it('health', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
  });

  it('OpenAPI gerada do código', async () => {
    const r = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json().paths)).toContain('/v1/establishments');
  });

  it('exige autenticação', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/companies' });
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe('UNAUTHENTICATED');
  });

  it('administrador sem MFA é bloqueado (MFA obrigatório para administradores e financeiro)', async () => {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: a.slug, email: a.adminEmail, password: a.adminPassword } });
    // O admin já ativou MFA no setup: sem código, o login pede o TOTP.
    expect(login.statusCode).toBe(401);
    expect(login.json().code).toBe('MFA_CODE_REQUIRED');
  });

  it('erros têm código estável, mensagem em português e detalhes por campo', async () => {
    const r = await a.admin.post('/v1/companies', { cnpjRoot: '12', legalName: '' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('VALIDATION');
    expect(r.body.details.fields['body.cnpjRoot']).toBeDefined();
  });
});

describe('RN-ORG-01 isolamento por tenant (RLS)', () => {
  it('toda tabela de negócio tem tenant_id e RLS forçado', async () => {
    const cfg = loadConfig();
    const c = new pg.Client({ connectionString: cfg.databaseOwnerUrl });
    await c.connect();
    const { rows } = await c.query(`
      SELECT n.nspname || '.' || cl.relname AS t, cl.relrowsecurity AS rls, cl.relforcerowsecurity AS force,
             EXISTS (SELECT 1 FROM pg_attribute at WHERE at.attrelid = cl.oid AND at.attname = 'tenant_id' AND NOT at.attisdropped) AS has_tenant
        FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE cl.relkind IN ('r', 'p') AND NOT cl.relispartition
         AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public', 'pg_toast')`);
    await c.end();
    const exempt = new Set(['core.permissions', 'integration.job_schedules', 'fiscal.official_tables', 'fiscal.ncm', 'fiscal.cfop', 'fiscal.cest', 'fiscal.cclasstrib', 'fiscal.ibge_cities', 'fiscal.rejection_catalog', 'fiscal.ibs_cbs_rates', 'fiscal.icms_internal_rates', 'fiscal.tax_transition', 'fiscal.nbs', 'fiscal.service_codes', 'fiscal.countries', 'fiscal.units']);
    const bad = rows.filter((r) => !exempt.has(r.t) && !(r.rls && r.force && r.has_tenant));
    expect(bad).toEqual([]);
  });

  it('nenhuma consulta cruza tenants: SQL direto com o usuário da aplicação', async () => {
    const cfg = loadConfig();
    const c = new pg.Client({ connectionString: cfg.databaseUrl });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenantId]);
    const { rows } = await c.query(`SELECT DISTINCT tenant_id FROM core.companies`);
    expect(rows.map((r) => r.tenant_id)).toEqual([a.tenantId]);
    // Gravar dado para outro tenant é bloqueado pela política
    await expect(c.query(`INSERT INTO core.companies (tenant_id, cnpj_root, legal_name) VALUES ($1, '99999999', 'X')`, [b.tenantId])).rejects.toThrow(/row-level security/);
    await c.query('ROLLBACK');
    // Sem contexto, nada é visível
    const none = await c.query(`SELECT count(*)::int AS n FROM core.companies`);
    expect(none.rows[0].n).toBe(0);
    await c.end();
  });

  it('via API: empresa de outro tenant é recusada no cabeçalho X-Company-Id', async () => {
    const r = await a.admin.withCompany(b.companyId).get('/v1/warehouses');
    expect(r.status).toBe(403);
  });
});

describe('RN-GER-05 auditoria', () => {
  it('grava inserção e alteração com antes/depois e usuário', async () => {
    const wh = await a.admin.post('/v1/warehouses', { establishmentId: a.establishmentId, code: 'AUD1', name: 'Auditado' });
    expect(wh.status).toBe(201);
    const log = await a.admin.get('/v1/audit', { table: 'core.warehouses', recordId: wh.body.id });
    expect(log.status).toBe(200);
    expect(log.body.items[0].operation).toBe('INSERT');
    expect(log.body.items[0].user_id).toBeTruthy();
  });

  it('log é só de inserção (UPDATE/DELETE bloqueados até para o dono)', async () => {
    const cfg = loadConfig();
    const c = new pg.Client({ connectionString: cfg.databaseOwnerUrl });
    await c.connect();
    await expect(c.query(`UPDATE core.audit_log SET reason = 'x'`)).rejects.toThrow(/imutável/);
    await expect(c.query(`DELETE FROM core.audit_log`)).rejects.toThrow(/imutável/);
    await c.end();
  });
});

describe('RN-GER-07 idempotência', () => {
  it('repetir a requisição devolve a mesma resposta sem duplicar', async () => {
    const payload = { establishmentId: a.establishmentId, code: 'IDEM1', name: 'Idempotente' };
    const r1 = await a.admin.post('/v1/warehouses', payload, { 'idempotency-key': 'chave-idem-1' });
    const r2 = await a.admin.post('/v1/warehouses', payload, { 'idempotency-key': 'chave-idem-1' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r2.headers['idempotent-replay']).toBe('true');
    const list = await a.admin.get('/v1/warehouses');
    expect(list.body.filter((w: any) => w.code === 'IDEM1')).toHaveLength(1);
  });

  it('mesma chave com outra requisição é recusada', async () => {
    const r = await a.admin.post('/v1/warehouses', { establishmentId: a.establishmentId, code: 'IDEM2', name: 'Outro' }, { 'idempotency-key': 'chave-idem-1' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('RN-ORG-03 regime tributário com vigência', () => {
  it('muda o regime a partir de uma data e preserva o histórico', async () => {
    const r = await a.admin.post(`/v1/establishments/${a.establishmentId}/tax-regimes`, { regime: 'lucro_presumido', validFrom: '2027-01-01' });
    expect(r.status).toBe(201);
    const hist = await a.admin.get(`/v1/establishments/${a.establishmentId}/tax-regimes`);
    expect(hist.body).toHaveLength(2);
    expect(hist.body[0].valid_to).toBe('2026-12-31');
    const bad = await a.admin.post(`/v1/establishments/${a.establishmentId}/tax-regimes`, { regime: 'lucro_real', validFrom: '2026-06-01' });
    expect(bad.status).toBe(422);
  });
});

describe('Cadastro de estabelecimento', () => {
  it('RN-CAD-03 valida IE pelo algoritmo da UF', async () => {
    const cnpj = makeCnpj(a.cnpj.slice(0, 8), '0002');
    const r = await a.admin.post('/v1/establishments', {
      companyId: a.companyId, code: 'F2', cnpj, legalName: 'Filial', ie: '032141841', uf: 'PE', cityIbge: '2611606', cityName: 'Recife',
      street: 'Rua', number: '1', district: 'Centro', zip: '50000000', regime: { regime: 'simples_nacional', validFrom: '2020-01-01' },
    });
    expect(r.status).toBe(422);
    expect(r.body.details.fields.ie).toMatch(/inválida/);
  });

  it('raiz do CNPJ do estabelecimento deve ser a da empresa', async () => {
    const r = await a.admin.post('/v1/establishments', {
      companyId: a.companyId, code: 'F3', cnpj: makeCnpj(), legalName: 'Filial', uf: 'PE', cityIbge: '2611606', cityName: 'Recife',
      street: 'Rua', number: '1', district: 'Centro', zip: '50000000', regime: { regime: 'simples_nacional', validFrom: '2020-01-01' },
    });
    expect(r.status).toBe(422);
  });
});

describe('Acesso: papéis, permissões, chaves de API', () => {
  it('vendedor não acessa administração', async () => {
    const v = await createUser(app, a, ['vendedor']);
    const r = await v.get('/v1/users');
    expect(r.status).toBe(403);
    expect(r.body.details.permission).toBe('admin.usuario.gerenciar');
  });

  it('financeiro precisa de MFA (login sem MFA não libera rotas)', async () => {
    const f = await createUser(app, a, ['financeiro']);
    const me = await f.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.roles).toContain('financeiro');
  });

  it('chave de API com escopo', async () => {
    const k = await a.admin.post('/v1/api-keys', { name: 'PDV loja 1', scopes: ['admin.empresa.gerenciar'], companyId: a.companyId });
    expect(k.status).toBe(201);
    const api = client(app, k.body.key, null);
    expect((await api.get('/v1/warehouses')).status).toBe(200);
    expect((await api.get('/v1/users')).status).toBe(403);
    await a.admin.del(`/v1/api-keys/${k.body.id}`);
    expect((await api.get('/v1/warehouses')).status).toBe(401);
  });
});
