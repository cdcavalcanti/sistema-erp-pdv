/**
 * Histórico fictício de 90 dias para o tenant de demonstração (pnpm db:seed), para que todas as
 * telas tenham o que mostrar: compras recebidas com XML, pedidos em todas as etapas, vendas do PDV
 * com itens cancelados no caixa, aberturas e fechamentos de caixa, contas a pagar e a receber
 * (pagas, a vencer e vencidas) e uma segunda empresa no Lucro Presumido (apuração de ICMS com
 * débito, crédito e DIFAL).
 *
 * Tudo passa pela API e pelos serviços do ERP (estoque, fiscal, financeiro e contábil coerentes).
 * Só a data de criação é ajustada no fim: o ERP grava "agora" em pedidos, notas e movimentos, então
 * os registros de cada etapa são deslocados para o dia fictício dela (somente na demonstração).
 * Idempotente: se o fornecedor-marcador já existe, não faz nada.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { D } from '@vortex/money';
import { buildAccessKey, cnpjCheckDigits } from '@vortex/validators';
import { signToken } from '../http/auth.js';
import { hashPassword } from '../core/crypto.js';
import { createTerminal } from '../modules/pdv/operation.js';
import { postMovement } from '../modules/inventory/stock.js';
import { postEvent } from '../modules/accounting/posting.js';
import { systemContext, withTenant } from './tx.js';
import type { App } from '../http/app.js';

const DAYS = Number(process.env.SEED_HISTORY_DAYS ?? 90);
const MARKER = '61238754';
const cnpj = (root: string) => root + '0001' + cnpjCheckDigits(root + '0001');

/** Gerador pseudoaleatório com semente: a demonstração sai igual em toda máquina. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
const rnd = prng(20261028);

function cpf(base9: string) {
  const dv = (s: string) => {
    const sum = [...s].reduce((acc, d, i) => acc + Number(d) * (s.length + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base9);
  return base9 + d1 + dv(base9 + d1);
}
function ean13(base12: string) {
  const sum = [...base12].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return base12 + ((10 - (sum % 10)) % 10);
}

const CITIES = {
  REC: { cityIbge: '2611606', cityName: 'Recife', uf: 'PE', zip: '50050000' },
  OLI: { cityIbge: '2609600', cityName: 'Olinda', uf: 'PE', zip: '53020000' },
  CAR: { cityIbge: '2604106', cityName: 'Caruaru', uf: 'PE', zip: '55002000' },
  JPA: { cityIbge: '2507507', cityName: 'João Pessoa', uf: 'PB', zip: '58010000' },
  MCZ: { cityIbge: '2704302', cityName: 'Maceió', uf: 'AL', zip: '57020000' },
  SSA: { cityIbge: '2927408', cityName: 'Salvador', uf: 'BA', zip: '40010000' },
  FOR: { cityIbge: '2304400', cityName: 'Fortaleza', uf: 'CE', zip: '60010000' },
  NAT: { cityIbge: '2408102', cityName: 'Natal', uf: 'RN', zip: '59010000' },
  SPO: { cityIbge: '3550308', cityName: 'São Paulo', uf: 'SP', zip: '01310100' },
} as const;
type City = keyof typeof CITIES;
const addr = (c: City, street: string, number: string) => [{ kind: 'fiscal', street, number, district: 'Centro', ...CITIES[c] }];

/** Produtos novos (os 6 do seed básico continuam). PDV = vendido na loja física. */
const PRODUCTS = [
  { sku: 'LEITE-1L', description: 'Leite UHT integral 1L', ncm: '04012010', price: '5.49', cost: '3.60', stock: 900, pdv: true, reorder: 120 },
  { sku: 'REFRI-2L', description: 'Refrigerante cola 2L', ncm: '22021000', price: '9.90', cost: '5.20', stock: 600, pdv: true, reorder: 80 },
  { sku: 'CERV-350', description: 'Cerveja pilsen lata 350ml', ncm: '22030000', price: '4.49', cost: '2.30', stock: 1500, pdv: true, reorder: 200 },
  { sku: 'SUCO-1L', description: 'Suco de uva integral 1L', ncm: '21069090', price: '12.90', cost: '7.10', stock: 300, pdv: true, reorder: 40 },
  { sku: 'SABAO-5', description: 'Sabão em barra pacote com 5', ncm: '34011190', price: '11.90', cost: '6.20', stock: 350, pdv: true, reorder: 50 },
  { sku: 'FRALDA-G', description: 'Fralda descartável G pacote 30un', ncm: '96190000', price: '64.90', cost: '38.00', stock: 180, pdv: true, reorder: 40 },
  { sku: 'CAMISETA-P', description: 'Camiseta algodão básica P', ncm: '61091000', price: '49.90', cost: '22.00', stock: 120, pdv: false, reorder: 20 },
  { sku: 'CAMISETA-G', description: 'Camiseta algodão básica G', ncm: '61091000', price: '49.90', cost: '22.00', stock: 120, pdv: false, reorder: 20 },
  { sku: 'CHINELO-38', description: 'Chinelo de borracha 38', ncm: '64029990', price: '29.90', cost: '12.50', stock: 200, pdv: true, reorder: 30 },
  { sku: 'TENIS-40', description: 'Tênis casual couro 40', ncm: '64029990', price: '189.90', cost: '92.00', stock: 60, pdv: false, reorder: 15 },
  { sku: 'PRATO-RASO', description: 'Prato raso de porcelana 26cm', ncm: '39241000', price: '24.90', cost: '11.00', stock: 240, pdv: false, reorder: 40 },
  { sku: 'LIVRO-REC', description: 'Livro de receitas nordestinas', ncm: '49019900', price: '59.90', cost: '28.00', stock: 90, pdv: false, reorder: 10 },
  { sku: 'MICRO-20', description: 'Micro-ondas 20 litros 127V', ncm: '85166000', price: '649.00', cost: '430.00', stock: 40, pdv: false, reorder: 12 },
  { sku: 'SMART-128', description: 'Smartphone 128GB tela 6,5"', ncm: '85171300', price: '1499.00', cost: '1080.00', stock: 30, pdv: false, reorder: 12 },
  { sku: 'NOTE-I5', description: 'Notebook 15,6" i5 8GB SSD 512GB', ncm: '84713012', price: '3899.00', cost: '2950.00', stock: 16, pdv: false, reorder: 10 },
  { sku: 'MESA-4L', description: 'Mesa de madeira maciça 4 lugares', ncm: '94036000', price: '1290.00', cost: '690.00', stock: 14, pdv: false, reorder: 6 },
  { sku: 'PNEU-175', description: 'Pneu 175/70 R14', ncm: '40111000', price: '389.00', cost: '245.00', stock: 64, pdv: false, reorder: 16 },
];
/** Estoque inicial para 90 dias; notebook e mesa começam curtos para aparecer o alerta de reposição. */
const openingQty = (p: (typeof PRODUCTS)[number]) => (p.pdv ? p.stock * 4 : ['NOTE-I5', 'MESA-4L'].includes(p.sku) ? p.stock : p.stock * 3);
/** Do seed básico: o que vai para o PDV e o ponto de pedido. */
const BASE = [
  { sku: 'CAFE-500', pdv: true, reorder: 60 }, { sku: 'BISC-200', pdv: true, reorder: 80 }, { sku: 'ARROZ-5', pdv: true, reorder: 40 },
  { sku: 'AGUA-500', pdv: true, reorder: 200 }, { sku: 'CAMISETA-M', pdv: false, reorder: 20 }, { sku: 'XAMPU-300', pdv: true, reorder: 30 },
];

const SUPPLIERS = [
  { root: MARKER, name: 'Atacadão Pernambuco Alimentos LTDA', city: 'REC' as City, skus: ['CAFE-500', 'BISC-200', 'ARROZ-5', 'LEITE-1L', 'SUCO-1L'] },
  { root: '61238755', name: 'Bebidas do Nordeste SA', city: 'JPA' as City, skus: ['AGUA-500', 'REFRI-2L', 'CERV-350'] },
  { root: '61238756', name: 'Higiene & Lar Distribuidora LTDA', city: 'SSA' as City, skus: ['XAMPU-300', 'SABAO-5', 'FRALDA-G'] },
  { root: '61238757', name: 'Confecções Agreste LTDA', city: 'CAR' as City, skus: ['CAMISETA-M', 'CAMISETA-P', 'CAMISETA-G', 'CHINELO-38', 'TENIS-40'] },
  { root: '61238758', name: 'Casa & Cozinha Importadora LTDA', city: 'SPO' as City, skus: ['PRATO-RASO', 'LIVRO-REC', 'MESA-4L', 'MICRO-20'] },
  { root: '61238759', name: 'TecnoSul Eletrônicos SA', city: 'SPO' as City, skus: ['SMART-128', 'NOTE-I5', 'PNEU-175'] },
];
const EXPENSE_SUPPLIERS = [
  { root: '61238760', name: 'Imobiliária Boa Vista LTDA', what: 'Aluguel da loja', cat: '5.1', amount: () => '4500.00', day: 5 },
  { root: '61238761', name: 'Companhia Energética de Pernambuco', what: 'Energia elétrica', cat: '5', amount: () => (820 + rnd.int(0, 300)).toFixed(2), day: 12 },
  { root: '61238762', name: 'NetFibra Telecom LTDA', what: 'Internet e telefone', cat: '5', amount: () => '219.90', day: 15 },
  { root: '61238763', name: 'Contabilidade Recife Assessoria', what: 'Honorários contábeis', cat: '5', amount: () => '950.00', day: 10 },
  { root: '61238764', name: 'Transportes Rápido Recife LTDA', what: 'Fretes do mês', cat: '5.3', amount: () => (600 + rnd.int(0, 900)).toFixed(2), day: 20 },
];

const PJ = ['Mercado São José', 'Empório Casa Forte', 'Padaria Pão Dourado', 'Supermercado Boa Viagem', 'Loja Praia Mar', 'Restaurante Sabor da Terra', 'Hotel Atlântico',
  'Lanchonete Ponto Certo', 'Escola Pequeno Príncipe', 'Clínica Vida Plena', 'Oficina Roda Viva', 'Construtora Horizonte', 'Pousada Maracatu', 'Farmácia Popular do Bairro'];
const PF = ['João Batista Ferreira', 'Ana Paula Cavalcanti', 'Carlos Eduardo Lima', 'Juliana Albuquerque', 'Ricardo Menezes', 'Fernanda Barros', 'Paulo Henrique Souza',
  'Luciana Tavares', 'Marcos Vinícius Rocha', 'Patrícia Gomes'];
const CITY_MIX: City[] = ['REC', 'REC', 'REC', 'OLI', 'CAR', 'REC', 'JPA', 'MCZ', 'SSA', 'FOR', 'NAT', 'REC', 'OLI', 'SPO'];
const CHANNELS = ['counter', 'ecommerce', 'ecommerce', 'marketplace', 'crm', 'whatsapp', 'wholesale'] as const;

type Call = (method: string, url: string, body?: unknown) => Promise<any>;
interface Window { t0: string; t1: string; at: Date; keepDocDates?: boolean }
interface OrderPlan { id: string; created: Date; approved?: Date; cancelled?: Date; picking?: Date; checked?: Date; shipped?: Date; delivered?: Date }

const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number, hour = 10, minute = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour + 3, minute, 0, 0); // horário de Recife (UTC−3)
  return d;
};
const plus = (d: Date, hours: number) => new Date(d.getTime() + hours * 3_600_000);
const capNow = (d: Date) => (d.getTime() > Date.now() - 60_000 ? new Date(Date.now() - 60_000) : d);

export async function seedHistory(app: App, tenantId: string, adminEmail: string) {
  const pool = app.deps.pool;
  const sys = (companyId?: string) => systemContext(tenantId, companyId);
  const has = await withTenant(pool, sys(), (tx) => tx.maybeOne(`SELECT 1 FROM registry.parties WHERE tax_id = $1`, [cnpj(MARKER)]));
  if (has) {
    console.log('  Histórico de demonstração: já existe.');
    return;
  }
  const started = Date.now();
  const admin = await withTenant(pool, sys(), (tx) => tx.one<{ id: string }>(`SELECT id FROM core.users WHERE email = $1`, [adminEmail], 'Administrador'));
  const token = await signToken(app.deps.config.jwtSecret, 3600 * 4, { sub: admin.id, tid: tenantId, mfa: true });
  // Segregação de funções (RN-ACE-01): quem aprova os pagamentos é a usuária do financeiro, não quem lançou
  const finEmail = adminEmail.replace(/^admin@/, 'financeiro@');
  const fin = await withTenant(pool, sys(), async (tx) => {
    const u = await tx.maybeOne<{ id: string }>(`SELECT id FROM core.users WHERE email = $1`, [finEmail]);
    if (u) return u;
    const n = await tx.one<{ id: string }>(`INSERT INTO core.users (tenant_id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, finEmail, 'Fernanda Financeiro', await hashPassword(`fin-${randomUUID()}`)]);
    await tx.exec(`INSERT INTO core.user_roles (tenant_id, user_id, role_id) SELECT $1, $2, id FROM core.roles WHERE code = 'financeiro'`, [tenantId, n.id]);
    return n;
  });
  const ger = await withTenant(pool, sys(), (tx) => tx.one<{ id: string }>(`SELECT id FROM core.users WHERE email = $1`, [adminEmail.replace(/^admin@/, 'gerente@')], 'Gerente'));
  const gerToken = await signToken(app.deps.config.jwtSecret, 3600 * 4, { sub: ger.id, tid: tenantId, mfa: false });
  const finToken = await signToken(app.deps.config.jwtSecret, 3600 * 4, { sub: fin.id, tid: tenantId, mfa: true });
  const mkCall = (company: string, auth: Record<string, string> = { authorization: `Bearer ${token}` }): Call => async (method, url, body) => {
    const r = await app.inject({ method: method as 'POST', url, payload: body as object, headers: { ...auth, ...(company ? { 'x-company-id': company } : {}) } });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.body ? r.json() : null;
  };
  const clock = async () => (await pool.query<{ t: string }>(`SELECT clock_timestamp()::text AS t`)).rows[0]!.t;
  const windows: Window[] = [];
  const orders: OrderPlan[] = [];
  /** Executa uma etapa e marca o que ela criou para ir para a data fictícia `at`. */
  const at = async <T>(when: Date, fn: () => Promise<T>, keepDocDates = false): Promise<T> => {
    const t0 = await clock();
    const r = await fn();
    windows.push({ t0, t1: await clock(), at: capNow(when), keepDocDates });
    return r;
  };

  const est = await withTenant(pool, sys(), (tx) => tx.one<{ id: string; company_id: string; cnpj: string }>(
    `SELECT id, company_id, cnpj FROM core.establishments WHERE code = 'MATRIZ' ORDER BY created_at LIMIT 1`, [], 'Matriz'));
  const call = mkCall(est.company_id);
  const wh = (await call('GET', '/v1/warehouses')).find((w: any) => w.establishment_id === est.id).id as string;
  const list = (await call('GET', '/v1/price-lists')).find((l: any) => l.is_default);
  const terms = Object.fromEntries((await call('GET', '/v1/payment-terms')).map((t: any) => [t.code, t.id]));
  const cats = await call('GET', '/v1/categories');
  const cat = (code: string) => cats.find((c: any) => c.code === code)?.id;

  // ---------------------------------------------------------------- catálogo e estoque inicial
  const products: Record<string, { id: string; price: string; cost: string; pdv: boolean }> = {};
  const opening = daysAgo(DAYS + 5, 7);
  for (const [i, p] of PRODUCTS.entries()) {
    const r = await call('POST', '/v1/products', { sku: p.sku, description: p.description, ncm: p.ncm, stockUnit: 'UN', saleUnit: 'UN', gtin: ean13(`789${String(4100000 + i * 37).padStart(9, '0')}`) });
    await call('PUT', `/v1/price-lists/${list.id}/items`, { productId: r.id, price: p.price });
    await withTenant(pool, sys(est.company_id), async (tx) => {
      const mv = await postMovement(tx, { warehouseId: wh, productId: r.id, type: 'opening', quantity: String(openingQty(p)), unitCost: p.cost, occurredAt: opening.toISOString(), sourceType: 'seed' });
      await postEvent(tx, { type: 'estoque_inicial', companyId: est.company_id, date: dateOnly(opening), description: `Saldo inicial ${p.sku}`, originType: 'seed', originId: mv!.id, amounts: { value: mv!.total_cost } });
    });
    products[p.sku] = { id: r.id, price: p.price, cost: p.cost, pdv: p.pdv };
    await call('PUT', `/v1/products/${r.id}/stock-params`, { warehouseId: wh, minQty: String(p.reorder / 2), maxQty: String(openingQty(p)), reorderPoint: String(p.reorder) });
  }
  const base = await withTenant(pool, sys(), (tx) => tx.query<{ id: string; sku: string; price: string | null; cost: string | null }>(
    `SELECT p.id, p.sku, (SELECT pi.price FROM catalog.price_list_items pi WHERE pi.product_id = p.id AND pi.price_list_id = $2 LIMIT 1) AS price,
            (SELECT c.avg_cost FROM inventory.product_costs c WHERE c.product_id = p.id LIMIT 1) AS cost
       FROM catalog.products p WHERE p.sku = ANY($1)`, [BASE.map((b) => b.sku), list.id]));
  for (const b of base) {
    const cfg = BASE.find((x) => x.sku === b.sku)!;
    products[b.sku] = { id: b.id, price: b.price ?? '10.00', cost: D(b.cost ?? '5').toFixed(2), pdv: cfg.pdv };
    await call('PUT', `/v1/products/${b.id}/stock-params`, { warehouseId: wh, minQty: String(cfg.reorder / 2), reorderPoint: String(cfg.reorder) });
    // Reforço do estoque do seed básico para aguentar 90 dias de loja
    await withTenant(pool, sys(est.company_id), async (tx) => {
      const mv = await postMovement(tx, { warehouseId: wh, productId: b.id, type: 'opening', quantity: cfg.pdv ? '2500' : '400', unitCost: D(b.cost ?? '5').toFixed(2), occurredAt: opening.toISOString(), sourceType: 'seed' });
      await postEvent(tx, { type: 'estoque_inicial', companyId: est.company_id, date: dateOnly(opening), description: `Saldo inicial ${b.sku}`, originType: 'seed', originId: mv!.id, amounts: { value: mv!.total_cost } });
    });
  }

  // ---------------------------------------------------------------- pessoas
  const suppliers: { id: string; cnpj: string; name: string; uf: string; skus: string[] }[] = [];
  for (const s of SUPPLIERS) {
    const r = await call('POST', '/v1/parties', { kind: 'PJ', taxId: cnpj(s.root), legalName: s.name, roles: ['supplier'], addresses: addr(s.city, 'Av. Industrial', String(rnd.int(100, 999))),
      taxRegime: 'normal', xmlEmail: `nfe@${s.root}.example` });
    suppliers.push({ id: r.id, cnpj: cnpj(s.root), name: s.name, uf: CITIES[s.city].uf, skus: s.skus });
  }
  const expenseParties: { id: string; cfg: (typeof EXPENSE_SUPPLIERS)[number] }[] = [];
  for (const s of EXPENSE_SUPPLIERS) {
    const r = await call('POST', '/v1/parties', { kind: 'PJ', taxId: cnpj(s.root), legalName: s.name, roles: ['supplier'], addresses: addr('REC', 'Rua do Hospício', String(rnd.int(10, 900))) });
    expenseParties.push({ id: r.id, cfg: s });
  }
  const customers: { id: string; pj: boolean; uf: string }[] = [];
  for (const [i, name] of PJ.entries()) {
    const city = CITY_MIX[i % CITY_MIX.length]!;
    const r = await call('POST', '/v1/parties', { kind: 'PJ', taxId: cnpj(String(70100200 + i * 13)), legalName: `${name} LTDA`, tradeName: name, roles: ['customer'], ieIndicator: 9, finalConsumer: true,
      addresses: addr(city, 'Rua Comercial', String(rnd.int(10, 2000))), creditLimit: i === 3 ? '3000' : '60000', email: `compras@cliente${i}.example` });
    customers.push({ id: r.id, pj: true, uf: CITIES[city].uf });
  }
  for (const [i, name] of PF.entries()) {
    const city = CITY_MIX[(i + 5) % CITY_MIX.length]!;
    const r = await call('POST', '/v1/parties', { kind: 'PF', taxId: cpf(String(321654000 + i * 101)), legalName: name, roles: ['customer'], ieIndicator: 9, finalConsumer: true,
      addresses: addr(city, 'Rua das Flores', String(rnd.int(10, 999))), creditLimit: '8000' });
    customers.push({ id: r.id, pj: false, uf: CITIES[city].uf });
  }
  const carrier = await call('POST', '/v1/parties', { kind: 'PJ', taxId: cnpj('61238765'), legalName: 'Expresso Capibaribe Transportes LTDA', roles: ['carrier'], addresses: addr('REC', 'BR-101', '5000') });

  // ---------------------------------------------------------------- compras (XML do fornecedor → recebimento)
  let nfeNumber = 4100 + rnd.int(0, 300);
  const receive = async (supplier: (typeof suppliers)[number], when: Date, items: { sku: string; qty: number }[], recipient: { id: string; cnpj: string; company: string }, c: Call, icmsRate?: string) => {
    const xml = supplierXml({ supplier, recipientCnpj: recipient.cnpj, number: ++nfeNumber, issuedAt: when, icmsRate,
      items: items.map((it) => ({ code: `F-${it.sku}`, description: allDescriptions[it.sku]!.toUpperCase(), ncm: allNcm[it.sku]!, quantity: String(it.qty), unitPrice: products[it.sku]!.cost })),
      dups: [28, 56].map((d) => dateOnly(plus(when, 24 * d))) });
    return at(plus(when, 4), async () => {
      const r = await c('POST', '/v1/purchasing/receipts', { establishmentId: recipient.id, xml });
      for (const [i, it] of r.items.entries()) {
        if (!['gtin', 'supplier_code'].includes(it.match_source)) await c('PUT', `/v1/purchasing/receipts/${r.id}/items/${it.id}/product`, { productId: products[items[i]!.sku]!.id, factor: '1' });
      }
      await c('POST', `/v1/purchasing/receipts/${r.id}/check`);
      return c('POST', `/v1/purchasing/receipts/${r.id}/complete`);
    }, true);
  };
  const allDescriptions = Object.fromEntries([...PRODUCTS.map((p) => [p.sku, p.description]), ['CAFE-500', 'Café torrado e moído 500g'], ['BISC-200', 'Biscoito amanteigado 200g'],
    ['ARROZ-5', 'Arroz branco tipo 1 5kg'], ['AGUA-500', 'Água mineral 500ml'], ['CAMISETA-M', 'Camiseta algodão M'], ['XAMPU-300', 'Xampu hidratante 300ml']]) as Record<string, string>;
  const allNcm = Object.fromEntries([...PRODUCTS.map((p) => [p.sku, p.ncm]), ['CAFE-500', '09012100'], ['BISC-200', '19053100'], ['ARROZ-5', '10063021'], ['AGUA-500', '22011000'],
    ['CAMISETA-M', '61091000'], ['XAMPU-300', '33051000']]) as Record<string, string>;
  const matriz = { id: est.id, cnpj: est.cnpj, company: est.company_id };
  let receipts = 0;
  for (let d = DAYS - 3; d >= 4; d -= rnd.int(6, 11)) {
    const s = suppliers[receipts % suppliers.length]!;
    const items = s.skus.filter(() => rnd.chance(0.75)).map((sku) => ({ sku, qty: Math.max(4, Math.round((PRODUCTS.find((p) => p.sku === sku)?.stock ?? 300) * (0.15 + rnd.next() * 0.2))) }));
    if (!items.length) items.push({ sku: s.skus[0]!, qty: 50 });
    // Pedido de compra antes da nota (três vias: pedido × nota × físico)
    const when = daysAgo(d, 9);
    await at(plus(when, -24 * 5), () => call('POST', '/v1/purchasing/orders', { establishmentId: est.id, supplierId: s.id, paymentTermId: terms['30/60'],
      items: items.map((it) => ({ productId: products[it.sku]!.id, quantity: String(it.qty), unitPrice: products[it.sku]!.cost })) }));
    await receive(s, when, items, matriz, call);
    receipts++;
  }
  // Pedidos de compra em aberto (aguardando o fornecedor)
  for (const [i, s] of suppliers.slice(0, 3).entries()) {
    await at(daysAgo(2 + i * 2, 11), () => call('POST', '/v1/purchasing/orders', { establishmentId: est.id, supplierId: s.id, paymentTermId: terms['30'],
      expectedDate: dateOnly(daysAgo(-5 - i)), items: s.skus.slice(0, 2).map((sku) => ({ productId: products[sku]!.id, quantity: String(rnd.int(20, 80)), unitPrice: products[sku]!.cost })) }));
  }

  // ---------------------------------------------------------------- pedidos de venda (todas as etapas)
  const orderSkus = Object.keys(products);
  const runOrder = async (c: Call, establishmentId: string, d: number, opts: { customers: typeof customers; skus: string[]; target?: string; idx: number; company?: string }) => {
    const created = daysAgo(d, rnd.int(8, 17), rnd.int(0, 59));
    const cu = opts.customers[opts.idx % opts.customers.length]!;
    const lines = Array.from({ length: rnd.int(1, 4) }, () => rnd.pick(opts.skus)).filter((v, i, a) => a.indexOf(v) === i)
      .map((sku) => {
        const price = D(products[sku]!.price);
        return { productId: products[sku]!.id, quantity: price.greaterThan(500) ? rnd.int(1, 2) : price.greaterThan(100) ? rnd.int(1, cu.pj ? 4 : 1) : cu.pj ? rnd.int(6, 36) : rnd.int(1, 4) };
      });
    // Etapa final pela idade do pedido
    const target = opts.target ?? (d > 12 ? (rnd.chance(0.07) ? 'cancelled' : rnd.chance(0.06) ? 'invoiced' : 'delivered')
      : d > 5 ? rnd.pick(['delivered', 'delivered', 'shipped', 'shipped', 'invoiced', 'cancelled'])
        : rnd.pick(['open', 'approved', 'approved', 'to_pick', 'picking', 'checked', 'invoiced', 'shipped']));
    const plan: OrderPlan = { id: '', created };
    const o = await at(created, () => c('POST', '/v1/sales/orders', { establishmentId, partyId: cu.id, channel: rnd.pick(CHANNELS), paymentTermId: rnd.pick([terms['AVISTA'], terms['30'], terms['30/60'], terms['30/60/90']]),
      items: lines, submit: target !== 'open', carrierId: carrier.id, freightMode: 0 }));
    plan.id = o.id;
    orders.push(plan);
    if (target === 'open') return;
    plan.approved = plus(created, 0.4);
    if (o.status === 'pending_approval') {
      // Acima do limite de crédito: os recentes ficam para o gerente decidir; os antigos ele já liberou
      if (d <= 2 || target === 'approved') return;
      const g = mkCall(opts.company ?? est.company_id, { authorization: `Bearer ${gerToken}` });
      try {
        for (const a of (await g('GET', '/v1/approvals')).filter((x: any) => x.entity_id === o.id)) {
          await g('POST', `/v1/approvals/${a.id}/decision`, { decision: 'approve', comment: 'Cliente com bom histórico de pagamento' });
        }
      } catch {
        return; // sem estoque para reservar: continua aguardando
      }
      if ((await c('GET', `/v1/sales/orders/${o.id}`)).status === 'pending_approval') return;
    }
    if (target === 'approved') return;
    if (target === 'cancelled') {
      if (rnd.chance(0.5)) await at(plus(created, 2), () => c('POST', `/v1/sales/orders/${o.id}/picking`, {}));
      plan.cancelled = plus(created, 20);
      await c('POST', `/v1/sales/orders/${o.id}/cancel`, { reason: rnd.pick(['Cliente desistiu da compra', 'Pedido duplicado pelo representante', 'Sem limite de crédito aprovado a tempo']) });
      return;
    }
    await at(plus(created, 2), () => c('POST', `/v1/sales/orders/${o.id}/picking`, {}));
    if (target === 'to_pick') return;
    plan.picking = plus(created, 3);
    await c('POST', `/v1/sales/orders/${o.id}/picking/start`, {});
    if (target === 'picking') return;
    plan.checked = plus(created, 5);
    await c('POST', `/v1/sales/orders/${o.id}/picking/check-all`, { volumes: rnd.int(1, 4) });
    if (target === 'checked') return;
    await at(plus(created, 6), () => c('POST', `/v1/sales/orders/${o.id}/invoice`, {}));
    if (target === 'invoiced') return;
    plan.shipped = plus(created, 24 + rnd.int(0, 20));
    await c('POST', `/v1/sales/orders/${o.id}/ship`, { carrierId: carrier.id, trackingCode: `BR${rnd.int(100000000, 999999999)}PE` });
    if (target === 'shipped') return;
    plan.delivered = plus(plan.shipped, 24 * rnd.int(1, 4));
    await c('POST', `/v1/sales/orders/${o.id}/deliver`, { receiverName: rnd.pick(['Portaria', 'Recepção', 'Próprio cliente', 'Gerente da loja', 'Almoxarifado']) });
  };
  let idx = 0;
  for (let d = DAYS; d >= 0; d--) {
    const n = d === 0 ? 3 : rnd.chance(0.35) ? 2 : rnd.chance(0.55) ? 1 : 0;
    for (let k = 0; k < n; k++) await runOrder(call, est.id, d, { customers, skus: orderSkus, idx: idx++ });
  }
  // Pedidos de hoje e de ontem em cada etapa em andamento (todas as colunas do quadro com algo)
  for (const target of ['open', 'approved', 'to_pick', 'picking', 'checked', 'invoiced', 'shipped']) {
    await runOrder(call, est.id, rnd.int(0, 1), { customers, skus: orderSkus.filter((s) => D(products[s]!.price).lessThan(100)), target, idx: idx++ });
  }
  // Um pedido acima do limite de crédito, aguardando aprovação
  await runOrder(call, est.id, 1, { customers: [customers[3]!], skus: ['NOTE-I5'], target: 'approved', idx: 0 });

  // ---------------------------------------------------------------- loja física (PDV): 90 dias de vendas e caixa
  const pdvStats = await seedPdvHistory(app, tenantId, est, products);

  // ---------------------------------------------------------------- despesas do mês (contas a pagar)
  const payables: { id: string; due: string; amount: string }[] = [];
  for (let m = 3; m >= -1; m--) {
    for (const e of expenseParties) {
      const due = daysAgo(0);
      due.setUTCMonth(due.getUTCMonth() - m, e.cfg.day);
      const issue = plus(due, -24 * 8);
      const t = await call('POST', '/v1/finance/titles', { kind: 'payable', partyId: e.id, documentNumber: `${e.cfg.what.slice(0, 3).toUpperCase()}-${dateOnly(due).slice(0, 7)}`,
        issueDate: dateOnly(issue), installments: [{ dueDate: dateOnly(due), amount: e.cfg.amount() }], categoryId: cat(e.cfg.cat) ?? cat('5'), description: e.cfg.what });
      for (const x of Array.isArray(t) ? t : t.titles ?? [t]) payables.push({ id: x.id, due: x.due_date ?? dateOnly(due), amount: x.amount });
    }
  }

  // ---------------------------------------------------------------- segunda empresa (Lucro Presumido)
  const lp = await seedPresumido(app, call, tenantId, mkCall, at, runOrder, receive, suppliers, customers, products, opening);

  // ---------------------------------------------------------------- datas fictícias
  await backdate(app, tenantId, windows, orders, opening);

  // ---------------------------------------------------------------- baixas (recebimentos e pagamentos)
  const today = dateOnly(new Date());
  let settled = 0;
  let overdue = 0;
  for (const company of [est.company_id, lp.companyId]) {
    const c = mkCall(company);
    const accs = Object.fromEntries((await withTenant(pool, sys(company), (tx) => tx.query<{ code: string; id: string }>(
      `SELECT code, id FROM finance.accounts WHERE company_id = $1`, [company]))).map((a) => [a.code, a.id]));
    const open = await withTenant(pool, sys(company), (tx) => tx.query<{ id: string; kind: string; due_date: string; balance: string; origin_type: string | null }>(
      `SELECT id, kind, due_date::text, balance, origin_type FROM finance.titles WHERE company_id = $1 AND status IN ('open', 'partially_paid') AND due_date < current_date AND balance > 0 ORDER BY due_date`, [company]));
    for (const t of open) {
      // Recebíveis de cartão/Pix do PDV a adquirente sempre paga; clientes de pedido às vezes atrasam
      if (t.origin_type !== 'pdv' && rnd.chance(t.kind === 'receivable' ? 0.2 : 0.05)) { overdue++; continue; }
      const date = dateOnly(new Date(Math.min(Date.now(), new Date(`${t.due_date}T12:00:00Z`).getTime() + rnd.int(-3, 4) * 86_400_000)));
      if (t.kind === 'payable') await mkCall(company, { authorization: `Bearer ${finToken}` })('POST', `/v1/finance/titles/${t.id}/approve`);
      await c('POST', `/v1/finance/titles/${t.id}/settle`, { date: date > today ? today : date, accountId: accs['BANCO'], amount: t.balance, waiveCharges: true });
      settled++;
    }
  }
  console.log(`  Histórico de demonstração: ${orders.length} pedidos, ${receipts + lp.receipts} recebimentos de compra, ${pdvStats.sales} vendas no PDV ` +
    `(${pdvStats.cancelled} com itens cancelados), ${payables.length} despesas, ${settled} baixas, ${overdue} títulos vencidos. ${Math.round((Date.now() - started) / 1000)}s`);
}

/** NF-e de fornecedor (XML autorizado fictício) para o recebimento de compras. */
function supplierXml(o: { supplier: { cnpj: string; name: string; uf: string }; recipientCnpj: string; number: number; issuedAt: Date; icmsRate?: string;
  items: { code: string; description: string; ncm: string; quantity: string; unitPrice: string }[]; dups: string[] }) {
  const cUF = { PE: '26', PB: '25', BA: '29', SP: '35', AL: '27', CE: '23', RN: '24' }[o.supplier.uf] ?? '26';
  const iso = o.issuedAt.toISOString();
  const local = new Date(o.issuedAt.getTime() - 3 * 3_600_000).toISOString().slice(0, 19) + '-03:00';
  const key = buildAccessKey({ cUF, aamm: iso.slice(2, 4) + iso.slice(5, 7), cnpj: o.supplier.cnpj, modelo: '55', serie: 1, numero: o.number, tpEmis: '1', cNF: String(o.number * 7919 % 99999999).padStart(8, '0') });
  const interstate = o.supplier.uf !== 'PE';
  let vProd = D(0);
  let vICMS = D(0);
  const det = o.items.map((it, i) => {
    const prod = D(it.quantity).times(it.unitPrice).toDecimalPlaces(2);
    vProd = vProd.plus(prod);
    const icms = o.icmsRate ? prod.times(o.icmsRate).dividedBy(100).toDecimalPlaces(2) : D(0);
    vICMS = vICMS.plus(icms);
    return `<det nItem="${i + 1}"><prod><cProd>${it.code}</cProd><cEAN>SEM GTIN</cEAN><xProd>${it.description}</xProd><NCM>${it.ncm}</NCM><CFOP>${interstate ? '6102' : '5102'}</CFOP>` +
      `<uCom>UN</uCom><qCom>${it.quantity}</qCom><vUnCom>${it.unitPrice}</vUnCom><vProd>${prod.toFixed(2)}</vProd></prod>` +
      `<imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><vBC>${prod.toFixed(2)}</vBC><pICMS>${o.icmsRate ?? '0'}</pICMS><vICMS>${icms.toFixed(2)}</vICMS></ICMS00></ICMS>` +
      `<PIS><PISAliq><CST>01</CST><vPIS>0.00</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>01</CST><vCOFINS>0.00</vCOFINS></COFINSAliq></COFINS></imposto></det>`;
  }).join('');
  const parts = o.dups.length;
  const each = vProd.dividedBy(parts).toDecimalPlaces(2);
  const dups = o.dups.map((due, i) => `<dup><nDup>${String(i + 1).padStart(3, '0')}</nDup><dVenc>${due}</dVenc><vDup>${(i === parts - 1 ? vProd.minus(each.times(parts - 1)) : each).toFixed(2)}</vDup></dup>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">` +
    `<ide><cUF>${cUF}</cUF><nNF>${o.number}</nNF><serie>1</serie><mod>55</mod><dhEmi>${local}</dhEmi></ide>` +
    `<emit><CNPJ>${o.supplier.cnpj}</CNPJ><xNome>${o.supplier.name}</xNome><IE>ISENTO</IE><enderEmit><xLgr>Av. Industrial</xLgr><nro>100</nro><xBairro>Distrito</xBairro><cMun>2611606</cMun><xMun>Recife</xMun><UF>${o.supplier.uf}</UF><CEP>50000000</CEP></enderEmit><CRT>3</CRT></emit>` +
    `<dest><CNPJ>${o.recipientCnpj}</CNPJ><xNome>Loja</xNome></dest>${det}` +
    `<total><ICMSTot><vProd>${vProd.toFixed(2)}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vIPI>0.00</vIPI><vST>0.00</vST><vICMS>${vICMS.toFixed(2)}</vICMS>` +
    `<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vNF>${vProd.toFixed(2)}</vNF></ICMSTot></total><cobr>${dups}</cobr>` +
    `</infNFe></NFe><protNFe><infProt><nProt>1262${String(o.number).padStart(11, '0')}</nProt></infProt></protNFe></nfeProc>`;
}

/** Vendas da loja física em dois caixas (01 e 02), com abertura, sangria e fechamento por dia. */
async function seedPdvHistory(app: App, tenantId: string, est: { id: string; company_id: string; cnpj: string }, products: Record<string, { id: string; price: string; pdv: boolean }>) {
  const pool = app.deps.pool;
  const operators = await withTenant(pool, systemContext(tenantId), (tx) => tx.query<{ id: string; name: string; pdv_login: string }>(
    `SELECT id, name, pdv_login FROM core.users WHERE pdv_login IS NOT NULL AND status = 'active' ORDER BY pdv_login`));
  const cashier = operators.filter((o) => !/super|gerente/i.test(o.name));
  const supervisor = operators.find((o) => /super/i.test(o.name)) ?? operators[0]!;
  const keys: Record<string, string> = {};
  for (const code of ['01', '02']) {
    keys[code] = await withTenant(pool, systemContext(tenantId, est.company_id), async (tx) => {
      const ex = await tx.maybeOne(`SELECT 1 FROM integration.pdv_terminals WHERE establishment_id = $1 AND code = $2`, [est.id, code]);
      if (ex) throw new Error(`Terminal ${code} já existe`);
      return (await createTerminal(tx, { establishmentId: est.id, code, name: `Caixa ${Number(code)} (histórico de demonstração)` })).apiKey;
    });
  }
  const pdvProducts = Object.entries(products).filter(([, p]) => p.pdv);
  const METHODS = ['DINHEIRO', 'DINHEIRO', 'PIX', 'PIX', 'PIX', 'DEBITO', 'DEBITO', 'CREDITO', 'CREDITO'] as const;
  let sales = 0;
  let cancelled = 0;
  for (let d = DAYS; d >= 0; d--) {
    for (const code of ['01', '02']) {
      if (code === '02' && rnd.chance(0.3)) continue; // caixa 2 só abre nos dias de movimento
      const terminalCall = async (url: string, body: unknown) => {
        const r = await app.inject({ method: 'POST', url, payload: body as object, headers: { 'x-api-key': keys[code]! } });
        if (r.statusCode >= 400) throw new Error(`POST ${url} → ${r.statusCode} ${r.body}`);
        return r.json();
      };
      const operator = cashier[(d + Number(code)) % Math.max(1, cashier.length)] ?? supervisor;
      const day = daysAgo(d, 8);
      const ymd = dateOnly(day).replaceAll('-', '');
      const session = `S-${code}-${ymd}`;
      await terminalCall('/v1/pdv/cash-movements', { establishmentId: est.id, pdvId: code, reference: `${session}-AB`, kind: 'opening', sessionId: session, amount: '200.00',
        operatorId: operator.id, occurredAt: day.toISOString() });
      const weekend = [0, 6].includes(day.getUTCDay());
      const count = d === 0 ? rnd.int(3, 6) : rnd.int(weekend ? 9 : 5, weekend ? 16 : 11);
      let cash = D(200);
      for (let k = 0; k < count; k++) {
        const when = daysAgo(d, 8 + Math.floor((k / count) * 11), rnd.int(0, 59));
        if (when.getTime() > Date.now() - 120_000) break;
        const lines = Array.from({ length: rnd.int(1, 5) }, () => rnd.pick(pdvProducts)).filter((v, i, a) => a.indexOf(v) === i)
          .map(([sku, p]) => ({ sku, p, qty: rnd.int(1, sku.startsWith('AGUA') || sku.startsWith('CERV') ? 12 : 3) }));
        const total = lines.reduce((s, l) => s.plus(D(l.p.price).times(l.qty).toDecimalPlaces(2)), D(0));
        const method = rnd.pick(METHODS);
        const paidCash = method === 'DINHEIRO' ? total.dividedBy(10).ceil().times(10) : total;
        if (method === 'DINHEIRO') cash = cash.plus(total);
        const n = ++sales;
        const number = Number(ymd.slice(2)) % 1000 * 1000 + k + 1;
        const cancel = rnd.chance(0.08) ? lines[0]! : null;
        if (cancel) cancelled++;
        const saleId = `PDV-${code}-${ymd}-${String(k + 1).padStart(6, '0')}`;
        await terminalCall('/v1/pdv/sales', {
          establishmentId: est.id, pdvId: code, saleId, saleUuid: randomUUID(), sessionId: session, operatorId: operator.id, operator: operator.name, occurredAt: when.toISOString(),
          items: lines.map((l) => ({ productId: l.p.id, quantity: String(l.qty), unitPrice: l.p.price })),
          payments: [{ methodCode: method, amount: paidCash.toFixed(2), ...(method === 'DINHEIRO' ? { change: paidCash.minus(total).toFixed(2) } : {}) }],
          nfce: { accessKey: buildAccessKey({ cUF: '26', aamm: ymd.slice(2, 6), cnpj: est.cnpj, modelo: '65', serie: Number(code), numero: number, tpEmis: '1', cNF: String((n * 7919) % 99999999).padStart(8, '0') }),
            status: 'autorizada', protocol: `1262${ymd}${String(n).padStart(6, '0')}`.slice(0, 15), authorizedAt: when.toISOString() },
          ...(cancel ? { cancelledItems: [{ productId: cancel.p.id, sku: cancel.sku, description: cancel.sku, quantity: '1', unit: 'UN', unitPrice: cancel.p.price,
            reason: rnd.pick(['Cliente desistiu', 'Item registrado em duplicidade', 'Produto com avaria', 'Preço divergente na gôndola']), operatorId: operator.id,
            authorizedBy: supervisor.id, at: when.toISOString(), partial: rnd.chance(0.5) }] } : {}),
        });
      }
      if (d === 0) continue; // caixa de hoje continua aberto
      const close = daysAgo(d, 20);
      let withdrawn = D(0);
      if (cash.greaterThan(900)) {
        withdrawn = cash.minus(300).dividedBy(50).floor().times(50);
        await terminalCall('/v1/pdv/cash-movements', { establishmentId: est.id, pdvId: code, reference: `${session}-SG`, kind: 'withdrawal', sessionId: session, amount: withdrawn.toFixed(2),
          reason: 'Sangria para o cofre', operatorId: operator.id, authorizedBy: supervisor.id, occurredAt: plus(close, -2).toISOString() });
      }
      const expected = cash.minus(withdrawn);
      const diff = rnd.chance(0.12) ? D(rnd.pick(['-5.00', '-2.50', '1.00', '-10.00', '0.50'])) : D(0);
      await terminalCall('/v1/pdv/cash-movements', { establishmentId: est.id, pdvId: code, reference: `${session}-FC`, kind: 'closing', sessionId: session, counted: expected.plus(diff).toFixed(2),
        details: { expectedCash: expected.toFixed(2) }, operatorId: operator.id, occurredAt: close.toISOString() });
    }
  }
  return { sales, cancelled };
}

/** Empresa no Lucro Presumido: vendas dentro e fora de PE e compras com crédito de ICMS. */
async function seedPresumido(app: App, _call: Call, tenantId: string, mkCall: (company: string) => Call, at: <T>(when: Date, fn: () => Promise<T>, keep?: boolean) => Promise<T>,
  runOrder: (c: Call, establishmentId: string, d: number, o: { customers: any[]; skus: string[]; target?: string; idx: number; company?: string }) => Promise<void>,
  receive: (s: any, when: Date, items: { sku: string; qty: number }[], recipient: { id: string; cnpj: string; company: string }, c: Call, icmsRate?: string) => Promise<unknown>,
  suppliers: { id: string; cnpj: string; name: string; uf: string; skus: string[] }[], customers: { id: string; pj: boolean; uf: string }[],
  products: Record<string, { id: string; price: string; cost: string }>, opening: Date) {
  const pool = app.deps.pool;
  const root = '42303017';
  const company = await mkCall('')('POST', '/v1/companies', { cnpjRoot: root, legalName: 'Vortex Distribuidora LTDA', tradeName: 'Vortex Distribuidora' });
  const c = mkCall(company.id);
  const est = await c('POST', '/v1/establishments', {
    companyId: company.id, code: 'CD-PE', cnpj: cnpj(root), legalName: 'Vortex Distribuidora LTDA', tradeName: 'Vortex Distribuidora', ie: '032150083', uf: 'PE', cityIbge: '2607901',
    cityName: 'Jaboatão dos Guararapes', street: 'Rodovia BR-101 Sul', number: '3000', district: 'Prazeres', zip: '54335000', regime: { regime: 'lucro_presumido', validFrom: '2020-01-01' },
  });
  const wh = (await c('GET', '/v1/warehouses')).find((w: any) => w.establishment_id === est.id).id as string;
  const skus = ['CAFE-500', 'ARROZ-5', 'REFRI-2L', 'CERV-350', 'SABAO-5', 'FRALDA-G', 'MICRO-20', 'SMART-128', 'PNEU-175', 'PRATO-RASO'];
  for (const sku of skus) {
    const p = products[sku]!;
    await withTenant(pool, systemContext(tenantId, company.id), async (tx) => {
      const mv = await postMovement(tx, { warehouseId: wh, productId: p.id, type: 'opening', quantity: D(p.price).greaterThan(500) ? '40' : '500', unitCost: p.cost, occurredAt: opening.toISOString(), sourceType: 'seed' });
      await postEvent(tx, { type: 'estoque_inicial', companyId: company.id, date: dateOnly(opening), description: `Saldo inicial ${sku}`, originType: 'seed', originId: mv!.id, amounts: { value: mv!.total_cost } });
    });
  }
  // Compras com ICMS destacado (crédito na apuração): de PE a 20,5% e de fora a 12%/7%
  let receipts = 0;
  for (const [i, d] of [80, 62, 47, 31, 18, 6].entries()) {
    const s = suppliers[i % suppliers.length]!;
    const items = s.skus.filter((sku) => skus.includes(sku)).map((sku) => ({ sku, qty: D(products[sku]!.price).greaterThan(500) ? 10 : 120 }));
    if (!items.length) continue;
    await receive(s, daysAgo(d, 9), items, { id: est.id, cnpj: cnpj(root), company: company.id }, c, s.uf === 'PE' ? '20.5' : s.uf === 'SP' ? '7' : '12');
    receipts++;
  }
  // Vendas: varejo de PE e clientes de outros estados (DIFAL para consumidor final)
  for (let d = DAYS - 2, i = 0; d >= 1; d -= rnd.int(2, 4), i++) {
    await runOrder(c, est.id, d, { customers, skus, idx: i * 3 + 1, target: d > 6 ? 'delivered' : undefined, company: company.id });
  }
  void at;
  return { companyId: company.id as string, receipts };
}

/**
 * Leva cada etapa para a sua data fictícia (só a demonstração faz isso): como o ERP registra
 * "agora", os registros criados em cada janela vão para o dia planejado. Os gatilhos de
 * imutabilidade ficam desligados só dentro desta transação, com o usuário dono do banco.
 */
async function backdate(app: App, tenantId: string, windows: Window[], orders: OrderPlan[], opening: Date) {
  const owner = new pg.Client({ connectionString: app.deps.config.databaseOwnerUrl });
  await owner.connect();
  const TABLES: [string, string[], string[], string[]][] = [
    // tabela, colunas de data/hora, colunas de data, colunas que vêm do documento (mantidas quando keepDocDates)
    ['fiscal.documents', ['issued_at', 'exit_at', 'authorized_at', 'created_at', 'updated_at'], ['tax_date'], ['issued_at', 'exit_at']],
    ['fiscal.document_events', ['created_at'], [], []],
    ['inventory.stock_movements', ['occurred_at', 'created_at'], [], []],
    ['accounting.journal_entries', ['created_at'], ['entry_date'], []],
    ['finance.titles', ['created_at', 'updated_at', 'approved_at'], ['issue_date', 'competence_date', 'due_date_original', 'due_date'], ['issue_date', 'competence_date', 'due_date_original', 'due_date']],
    ['finance.account_movements', ['created_at'], ['movement_date'], []],
    ['sales.order_invoices', ['created_at'], [], []],
    ['sales.shipments', ['created_at'], [], []],
    ['purchasing.orders', ['created_at', 'updated_at', 'sent_at'], [], []],
    ['purchasing.receipts', ['created_at', 'completed_at'], [], []],
    ['fiscal.tax_credits', ['created_at'], [], []],
  ];
  const all = [...TABLES.map((t) => t[0]), 'sales.orders', 'inventory.stock_movements_default'];
  try {
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    for (const t of all) await owner.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    for (const w of windows) {
      for (const [table, ts, dates, docCols] of TABLES) {
        const keep = w.keepDocDates ? docCols : [];
        const sets = [
          ...ts.filter((c) => !keep.includes(c)).map((c) => `${c} = ${c} + ($3::timestamptz - $1::timestamptz)`),
          ...dates.filter((c) => !keep.includes(c)).map((c) => `${c} = ${c} + ($3::timestamptz::date - $1::timestamptz::date)`),
        ];
        if (!sets.length) continue;
        await owner.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE tenant_id = $4 AND created_at BETWEEN $1 AND $2`, [w.t0, w.t1, w.at.toISOString(), tenantId]);
      }
    }
    for (const o of orders) {
      const iso = (x: Date | undefined) => capNow(x ?? o.created).toISOString();
      await owner.query(
        `UPDATE sales.orders SET created_at = $2, approved_at = CASE WHEN approved_at IS NOT NULL THEN $3::timestamptz END,
                cancelled_at = CASE WHEN cancelled_at IS NOT NULL THEN $4::timestamptz END, updated_at = greatest($2::timestamptz, $3, $4, $5)
          WHERE id = $1`,
        [o.id, iso(o.created), iso(o.approved), iso(o.cancelled), iso(o.delivered ?? o.shipped ?? o.checked ?? o.picking)]);
      await owner.query(
        `UPDATE sales.shipments SET picking_started_at = CASE WHEN picking_started_at IS NOT NULL THEN $2::timestamptz END,
                checked_at = CASE WHEN checked_at IS NOT NULL THEN $3::timestamptz END, shipped_at = CASE WHEN shipped_at IS NOT NULL THEN $4::timestamptz END,
                delivered_at = CASE WHEN delivered_at IS NOT NULL THEN $5::timestamptz END WHERE order_id = $1`,
        [o.id, iso(o.picking), iso(o.checked), iso(o.shipped), iso(o.delivered)]);
    }
    // Saldo inicial do seed básico (feito "agora" na primeira execução) vai para o começo do histórico
    await owner.query(`UPDATE inventory.stock_movements SET occurred_at = $2 WHERE tenant_id = $1 AND movement_type = 'opening' AND source_type = 'seed' AND occurred_at > $2`, [tenantId, opening.toISOString()]);
    for (const t of all) await owner.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);
    await owner.query('COMMIT');
  } catch (e) {
    await owner.query('ROLLBACK');
    throw e;
  } finally {
    await owner.end();
  }
}
