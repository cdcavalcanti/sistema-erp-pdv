/**
 * Dados de demonstração para desenvolvimento e para o teste ponta a ponta do web app.
 * Cria (uma vez) o tenant "demo" pela própria API, com empresa no Simples Nacional, usuários,
 * produtos com estoque e preço, clientes, pedidos faturados e contas a pagar.
 *
 *   pnpm db:seed            → tenant "demo"
 *   SEED_TENANT=x pnpm db:seed
 */
import { cnpjCheckDigits } from '@vortex/validators';
import { createApp } from '../main.js';
import { totp } from '../core/crypto.js';
import { systemContext, withTenant } from './tx.js';
import { postMovement } from '../modules/inventory/stock.js';
import { postEvent } from '../modules/accounting/posting.js';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../core/crypto.js';
import { createTerminal, rotateTerminalKey, setOperator } from '../modules/pdv/operation.js';
import type { App } from '../http/app.js';
import { seedHistory } from './seed-history.js';

const slug = process.env.SEED_TENANT ?? 'demo';
const ADMIN = { email: `admin@${slug}.local`, password: 'vortex-admin-123' };
const GERENTE = { email: `gerente@${slug}.local`, password: 'vortex-gerente-123' };
const VENDEDOR = { email: `vendedor@${slug}.local`, password: 'vortex-vendedor-123' };
const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];
const cnpj = (root: string) => root + '0001' + cnpjCheckDigits(root + '0001');
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const PRODUCTS = [
  { sku: 'CAFE-500', description: 'Café torrado e moído 500g', ncm: '09012100', price: '24.90', cost: '14.20', stock: '240' },
  { sku: 'BISC-200', description: 'Biscoito amanteigado 200g', ncm: '19053100', price: '7.50', cost: '3.90', stock: '400' },
  { sku: 'ARROZ-5', description: 'Arroz branco tipo 1 pacote 5kg', ncm: '10063021', price: '29.90', cost: '21.50', stock: '120' },
  { sku: 'AGUA-500', description: 'Água mineral sem gás 500ml', ncm: '22011000', price: '2.50', cost: '0.90', stock: '1200' },
  { sku: 'CAMISETA-M', description: 'Camiseta algodão básica M', ncm: '61091000', price: '49.90', cost: '22.00', stock: '80' },
  { sku: 'XAMPU-300', description: 'Xampu hidratante 300ml', ncm: '33051000', price: '18.90', cost: '9.40', stock: '150' },
];
const CUSTOMERS = [
  { kind: 'PJ', taxId: cnpj('12345678'), legalName: 'Mercadinho Boa Vista LTDA', tradeName: 'Mercadinho Boa Vista', ieIndicator: 9, finalConsumer: false },
  { kind: 'PJ', taxId: cnpj('23456789'), legalName: 'Padaria Pão Quente ME', tradeName: 'Pão Quente', ieIndicator: 9, finalConsumer: false },
  { kind: 'PF', taxId: '52998224725', legalName: 'Maria das Graças Silva', ieIndicator: 9, finalConsumer: true },
];

async function main() {
  // Carga em lote pela própria API: sem limite por minuto e sem log de cada requisição
  process.env.RATE_LIMIT_MAX ??= '1000000';
  process.env.LOG_LEVEL ??= 'warn';
  const app = await createApp();
  const call = async (method: string, url: string, token: string | null, body?: unknown, company?: string) => {
    const r = await app.inject({ method: method as 'POST', url, payload: body as object, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(company ? { 'x-company-id': company } : {}) } });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json();
  };
  const exists = await app.deps.pool.query(`SELECT core.resolve_tenant_by_slug($1) AS id`, [slug]);
  if (exists.rows[0]?.id) {
    console.log(`Tenant "${slug}" já existe.`);
    await seedPdv(app, exists.rows[0].id);
    if (process.env.SEED_HISTORY !== '0') await seedHistory(app, exists.rows[0].id, ADMIN.email);
    await app.close();
    return;
  }
  const { tenantId } = await call('POST', '/v1/onboarding', null, { tenant: { name: 'Empresa Demonstração', slug }, admin: { name: 'Administrador', email: ADMIN.email, password: ADMIN.password } });
  // O perfil administrador exige MFA: ativa e mostra a chave para o aplicativo autenticador
  const login = await call('POST', '/v1/auth/login', null, { tenant: slug, ...ADMIN });
  const { secret } = await call('POST', '/v1/auth/mfa/setup', login.token);
  const { token } = await call('POST', '/v1/auth/mfa/activate', login.token, { code: totp(secret) });
  const company = await call('POST', '/v1/companies', token, { cnpjRoot: '42303002', legalName: 'Comércio Demonstração LTDA', tradeName: 'Loja Demo' });
  const c = company.id as string;
  const est = await call('POST', '/v1/establishments', token, {
    companyId: c, code: 'MATRIZ', cnpj: cnpj('42303002'), legalName: 'Comércio Demonstração LTDA', tradeName: 'Loja Demo', ie: '032141840', uf: 'PE', cityIbge: '2611606', cityName: 'Recife',
    street: 'Rua da Aurora', number: '100', district: 'Boa Vista', zip: '50050000', regime: { regime: 'simples_nacional', validFrom: '2020-01-01' },
  }, c);
  for (const u of [{ ...GERENTE, name: 'Gerente Demo', roles: ['gerente'] }, { ...VENDEDOR, name: 'Vendedor Demo', roles: ['vendedor'] }]) {
    await call('POST', '/v1/users', token, { email: u.email, name: u.name, password: u.password, roles: u.roles }, c);
  }
  const whs = await call('GET', '/v1/warehouses', token, undefined, c);
  const warehouseId = whs.find((w: { establishment_id: string }) => w.establishment_id === est.id).id as string;
  const list = await call('POST', '/v1/price-lists', token, { code: 'PADRAO', name: 'Tabela padrão', isDefault: true }, c);
  const productIds: string[] = [];
  for (const p of PRODUCTS) {
    const r = await call('POST', '/v1/products', token, { sku: p.sku, description: p.description, ncm: p.ncm, stockUnit: 'UN', saleUnit: 'UN' }, c);
    productIds.push(r.id);
    await call('PUT', `/v1/price-lists/${list.id}/items`, token, { productId: r.id, price: p.price }, c);
    await withTenant(app.deps.pool, systemContext(tenantId, c), async (tx) => {
      const mv = await postMovement(tx, { warehouseId, productId: r.id, type: 'opening', quantity: p.stock, unitCost: p.cost, sourceType: 'seed' });
      await postEvent(tx, { type: 'estoque_inicial', companyId: c, date: day(0), description: `Saldo inicial ${p.sku}`, originType: 'seed', originId: mv!.id, amounts: { value: mv!.total_cost } });
    });
  }
  const customerIds: string[] = [];
  for (const cu of CUSTOMERS) customerIds.push((await call('POST', '/v1/parties', token, { ...cu, roles: ['customer'], addresses: ADDR, creditLimit: '20000' }, c)).id);
  const supplier = await call('POST', '/v1/parties', token, { kind: 'PJ', taxId: cnpj('34567890'), legalName: 'Distribuidora Nordeste SA', roles: ['supplier'], addresses: ADDR, taxRegime: 'normal' }, c);
  // Vendas faturadas (NF-e autorizada no gateway simulado)
  for (const [i, partyId] of customerIds.entries()) {
    const o = await call('POST', '/v1/sales/orders', token, { establishmentId: est.id, partyId, items: [{ productId: productIds[i % productIds.length], quantity: 6 + i * 2 }, { productId: productIds[(i + 3) % productIds.length], quantity: 12 }] }, c);
    await call('POST', `/v1/sales/orders/${o.id}/invoice`, token, {}, c);
  }
  // Contas a pagar
  const cats = await call('GET', '/v1/categories', token, undefined, c);
  const expense = cats.find((x: { kind: string; accepts_entries: boolean }) => x.kind === 'expense' && x.accepts_entries)?.id;
  for (const [i, amount] of ['1850.00', '320.40', '4200.00'].entries()) {
    await call('POST', '/v1/finance/titles', token, { kind: 'payable', partyId: supplier.id, documentNumber: `NF-${9100 + i}`, issueDate: day(-10), installments: [{ dueDate: day(i * 7 - 2), amount }], categoryId: expense }, c);
  }
  await seedPdv(app, tenantId);
  // 90 dias de operação fictícia para as telas terem o que mostrar (SEED_HISTORY=0 pula)
  if (process.env.SEED_HISTORY !== '0') await seedHistory(app, tenantId, ADMIN.email);
  await app.close();
  console.log(`\n✓ Tenant "${slug}" pronto.\n`);
  console.log(`  Empresa (identificador): ${slug}`);
  console.log(`  Gerente:  ${GERENTE.email} / ${GERENTE.password}`);
  console.log(`  Vendedor: ${VENDEDOR.email} / ${VENDEDOR.password}`);
  console.log(`  Admin:    ${ADMIN.email} / ${ADMIN.password}  (MFA — chave TOTP: ${secret})\n`);
}

const PDV_OPERATORS = [
  { email: `ana.caixa@${slug}.local`, name: 'Ana Operadora', role: 'operador_caixa', login: 'ana', pin: '482913' },
  { email: `bruno.caixa@${slug}.local`, name: 'Bruno Operador', role: 'operador_caixa', login: 'bruno', pin: '640271' },
  { email: `sergio.supervisor@${slug}.local`, name: 'Sérgio Supervisor', role: 'supervisor_caixa', login: 'sup', pin: '730184' },
];

/**
 * Demonstração do Vortex PDV (idempotente): operadores com PIN, gerente habilitado no PDV e o
 * terminal 03 da matriz. O PDV é outro projeto (vortex-pdv): a chave do terminal vai para o
 * .env do agente dele quando ele está na pasta vizinha (../vortex-pdv) e o arquivo ainda não
 * existe, ou para SEED_PDV_ENV; senão, é mostrada no console para colar.
 */
async function seedPdv(app: App, tenantId: string) {
  await withTenant(app.deps.pool, systemContext(tenantId), async (tx) => {
    const est = await tx.maybeOne<{ id: string }>(`SELECT id FROM core.establishments WHERE code = 'MATRIZ' ORDER BY created_at LIMIT 1`);
    if (!est) return;
    for (const o of PDV_OPERATORS) {
      let u = await tx.maybeOne<{ id: string }>(`SELECT id FROM core.users WHERE email = $1`, [o.email]);
      if (!u) {
        u = await tx.one<{ id: string }>(`INSERT INTO core.users (tenant_id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
          [tenantId, o.email, o.name, await hashPassword(`${o.pin}-${o.login}-senha`)]);
        await tx.exec(`INSERT INTO core.user_roles (tenant_id, user_id, role_id) SELECT $1, $2, id FROM core.roles WHERE code = $3`, [tenantId, u.id, o.role]);
      }
      await setOperator(tx, u.id, { pdvLogin: o.login, pin: o.pin });
    }
    const ger = await tx.maybeOne<{ id: string }>(`SELECT id FROM core.users WHERE email = $1`, [GERENTE.email]);
    if (ger) await setOperator(tx, ger.id, { pdvLogin: 'ger', pin: '915372' });
    // SEED_PDV_ENV: arquivo de ambiente do agente a (re)gerar, com chave nova (usado pelo teste ponta a ponta)
    const forced = process.env.SEED_PDV_ENV;
    const sibling = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'vortex-pdv', 'apps', 'pdv');
    const envFile = forced ?? (existsSync(sibling) && !existsSync(join(sibling, '.env')) ? join(sibling, '.env') : null);
    const terminal = await tx.maybeOne<{ id: string }>(`SELECT id FROM integration.pdv_terminals WHERE establishment_id = $1 AND code = '03' AND status = 'active'`, [est.id]);
    if (terminal && !envFile) {
      console.log('  PDV: terminal 03 já cadastrado. Para uma chave nova no .env do agente: SEED_PDV_ENV=<vortex-pdv>/apps/pdv/.env pnpm db:seed');
      return;
    }
    const r = terminal ? await rotateTerminalKey(tx, terminal.id) : await createTerminal(tx, { establishmentId: est.id, code: '03', name: 'Caixa 3 (demonstração)' });
    const env = [`PDV_ERP_URL=http://localhost:3333`, `PDV_ERP_API_KEY=${r.apiKey}`, `PDV_STORE_ID=${est.id}`, `PDV_TERMINAL_CODE=03`, `PDV_DB_PATH=./data/pdv.sqlite`];
    if (envFile) {
      writeFileSync(envFile, [`# Gerado por pnpm db:seed do vortex-erp (demonstração). Não versionar.`, ...env, ''].join('\n'));
      console.log(`  PDV: terminal 03 pronto; chave gravada em ${envFile}`);
    } else {
      console.log('  PDV: terminal 03 cadastrado. Cole no vortex-pdv/apps/pdv/.env (a chave é mostrada uma vez):');
      for (const l of env) console.log(`    ${l}`);
    }
  });
  console.log('  PDV: operadores ana / 482913 e bruno / 640271 (operadores), sup / 730184 (supervisor), ger / 915372 (gerente)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
