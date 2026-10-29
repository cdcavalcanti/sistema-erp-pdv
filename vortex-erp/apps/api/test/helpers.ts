import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InjectOptions } from 'fastify';
import { createApp } from '../src/main.js';
import type { App } from '../src/http/app.js';
import type { Services } from '../src/services.js';
import { totp } from '../src/core/crypto.js';
import { isValidCNPJ, cnpjCheckDigits } from '@vortex/validators';

process.env.NODE_ENV = 'test';

export async function makeApp(services: Partial<Services> = {}): Promise<App> {
  const storageDir = mkdtempSync(join(tmpdir(), 'vortex-storage-'));
  return createApp({ config: { storageDir }, services });
}

export interface Client {
  token: string;
  companyId: string | null;
  get: (url: string, query?: Record<string, string>) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  post: (url: string, payload?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  put: (url: string, payload?: unknown) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  patch: (url: string, payload?: unknown) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  del: (url: string, payload?: unknown) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  withCompany: (companyId: string | null) => Client;
}

export function client(app: App, token: string, companyId: string | null = null, extraHeaders: Record<string, string> = {}): Client {
  const headers = (h: Record<string, string> = {}) => ({
    ...(token.startsWith('vx_') ? { 'x-api-key': token } : { authorization: `Bearer ${token}` }),
    ...(companyId ? { 'x-company-id': companyId } : {}),
    ...extraHeaders,
    ...h,
  });
  const run = async (opts: InjectOptions) => {
    const r = await app.inject(opts);
    let body: any = r.body;
    try {
      body = r.json();
    } catch {
      /* corpo não JSON */
    }
    return { status: r.statusCode, body, headers: r.headers as Record<string, unknown> };
  };
  return {
    token,
    companyId,
    get: (url, query) => run({ method: 'GET', url, query, headers: headers() }),
    post: (url, payload, h) => run({ method: 'POST', url, payload: payload as any, headers: headers(h) }),
    put: (url, payload) => run({ method: 'PUT', url, payload: payload as any, headers: headers() }),
    patch: (url, payload) => run({ method: 'PATCH', url, payload: payload as any, headers: headers() }),
    del: (url, payload) => run({ method: 'DELETE', url, payload: payload as any, headers: headers() }),
    withCompany: (c) => client(app, token, c, extraHeaders),
  };
}

let seq = 0;
/** Gera um CNPJ válido único (raiz de 8 dígitos + filial). */
export function makeCnpj(root?: string, branch = '0001'): string {
  const r = root ?? String(10_000_000 + Math.floor(Math.random() * 80_000_000) + (seq++ % 1000)).slice(0, 8);
  const base = r + branch;
  const cnpj = base + cnpjCheckDigits(base);
  if (!isValidCNPJ(cnpj)) return makeCnpj(undefined, branch);
  return cnpj;
}

export async function loginWithMfa(app: App, slug: string, email: string, password: string): Promise<string> {
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: slug, email, password } });
  if (login.statusCode === 401 && login.json().code === 'MFA_CODE_REQUIRED') throw new Error('use loginTotp');
  const body = login.json();
  if (!body.mfaSetupRequired) return body.token;
  const setup = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: { authorization: `Bearer ${body.token}` } });
  const { secret } = setup.json();
  const act = await app.inject({ method: 'POST', url: '/v1/auth/mfa/activate', headers: { authorization: `Bearer ${body.token}` }, payload: { code: totp(secret) } });
  mfaSecrets.set(`${slug}:${email}`, secret);
  return act.json().token;
}
export const mfaSecrets = new Map<string, string>();

export interface TenantFixture {
  slug: string;
  tenantId: string;
  adminEmail: string;
  adminPassword: string;
  admin: Client;
  companyId: string;
  establishmentId: string;
  warehouseId: string;
  cnpj: string;
}

/** Cria tenant + empresa + estabelecimento (PE, Simples Nacional por padrão) prontos para uso. */
export async function setupTenant(app: App, opts: { regime?: string; uf?: string; cityIbge?: string; cityName?: string; ie?: string } = {}): Promise<TenantFixture> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const adminEmail = `admin@${slug}.test`;
  const adminPassword = 'senha-forte-123';
  const r = await app.inject({ method: 'POST', url: '/v1/onboarding', payload: { tenant: { name: `Tenant ${slug}`, slug }, admin: { name: 'Admin', email: adminEmail, password: adminPassword } } });
  if (r.statusCode !== 201) throw new Error(`onboarding falhou: ${r.body}`);
  const { tenantId } = r.json();
  const token = await loginWithMfa(app, slug, adminEmail, adminPassword);
  const anon = client(app, token);
  const cnpj = makeCnpj();
  const company = await anon.post('/v1/companies', { cnpjRoot: cnpj.slice(0, 8), legalName: `Empresa ${slug} LTDA`, tradeName: `Loja ${slug}` });
  if (company.status !== 201) throw new Error(`empresa: ${JSON.stringify(company.body)}`);
  const est = await anon.post('/v1/establishments', {
    companyId: company.body.id, code: 'MATRIZ', cnpj, legalName: `Empresa ${slug} LTDA`, tradeName: `Loja ${slug}`,
    ie: opts.ie ?? '032141840', uf: opts.uf ?? 'PE', cityIbge: opts.cityIbge ?? '2611606', cityName: opts.cityName ?? 'Recife',
    street: 'Rua da Aurora', number: '100', district: 'Boa Vista', zip: '50050000',
    regime: { regime: opts.regime ?? 'simples_nacional', validFrom: '2020-01-01' },
  });
  if (est.status !== 201) throw new Error(`estabelecimento: ${JSON.stringify(est.body)}`);
  const admin = client(app, token, company.body.id);
  const whs = await admin.get('/v1/warehouses');
  return {
    slug, tenantId, adminEmail, adminPassword, admin, companyId: company.body.id, establishmentId: est.body.id,
    warehouseId: whs.body.find((w: any) => w.establishment_id === est.body.id).id, cnpj,
  };
}

/** Cria usuário com papéis e devolve um client já logado. */
export async function createUser(app: App, t: TenantFixture, roles: string[], extra: Record<string, unknown> = {}): Promise<Client & { userId: string }> {
  const email = `${roles.join('-')}-${randomUUID().slice(0, 6)}@${t.slug}.test`;
  const password = 'senha-usuario-123';
  const r = await t.admin.post('/v1/users', { email, name: `Usuário ${roles.join(',')}`, password, roles, ...extra });
  if (r.status !== 201) throw new Error(`usuário: ${JSON.stringify(r.body)}`);
  const token = await loginWithMfa(app, t.slug, email, password);
  return Object.assign(client(app, token, t.companyId), { userId: r.body.id });
}

import { createPool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import type { WorkerDeps } from '../src/worker/registry.js';
import '../src/worker/jobs.js';

let workerDeps: WorkerDeps | null = null;
/** Dependências do worker para rodar jobs nos testes (drain). */
export function getWorkerDeps(app: App): WorkerDeps {
  if (!workerDeps) {
    const config = loadConfig();
    workerDeps = { config: app.deps.config, appPool: app.deps.pool, workerPool: createPool(config.workerDatabaseUrl, 3), vault: app.deps.vault, services: app.deps.services };
  }
  return { ...workerDeps, appPool: app.deps.pool, services: app.deps.services };
}
