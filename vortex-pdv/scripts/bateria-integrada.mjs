// Bateria integrada ERP × PDV: vendas reais pelo agente do PDV e conferência do lado do ERP.
//
// Pré-requisitos: ERP (vortex-erp) no ar em :3333 com o tenant "demo" (pnpm db:seed) e o agente
// deste projeto em :4545 ligado ao terminal 03 (o seed grava o .env). Faz vendas de verdade no
// ambiente de homologação (SEFAZ e pagamentos simulados).
//
//   node scripts/bateria-integrada.mjs                      → todos os cenários com o ERP no ar
//   node scripts/bateria-integrada.mjs setup,caixa          → só alguns
//   (pare o ERP) OFFLINE_READY=1 node scripts/bateria-integrada.mjs offline
//   (suba o ERP) OFFLINE_SALE=<número impresso> node scripts/bateria-integrada.mjs offline_back
import { randomUUID } from 'node:crypto';

const AGENT = 'http://127.0.0.1:4545';
const ERP = 'http://localhost:3333';
const SUP = { login: 'sup', pin: '730184' };
const GER = { login: 'ger', pin: '915372' };
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(base, method, path, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!r.ok) { const e = new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`); e.status = r.status; e.body = json; throw e; }
  return json;
}
let agentToken;
const agent = (m, p, b) => http(AGENT, m, p, b, { authorization: `Bearer ${agentToken}` });
let erpToken;
let company;
const erp = (m, p, b) => http(ERP, m, p, b, { authorization: `Bearer ${erpToken}`, 'x-company-id': company });

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function scenario(name, fn) {
  try { await fn(); } catch (e) { check(name, false, `erro: ${e.message}`); }
}
async function syncNow(full = false) {
  for (let i = 0; i < 3; i++) {
    const r = await agent('POST', '/api/sync', { full });
    if (!r.errors?.length) return r;
    await sleep(500);
  }
  return agent('POST', '/api/sync', { full });
}
async function erpSale(number) {
  const list = await erp('GET', `/v1/pdv/sales?pdvId=03&q=${encodeURIComponent(number)}&limit=5`);
  return list.items.find((x) => x.sale_id === number) ?? null;
}
async function stockOf(sku) {
  const p = (await erp('GET', `/v1/products?q=${encodeURIComponent(sku)}&limit=5`)).items.find((x) => x.sku === sku);
  const b = await erp('GET', `/v1/stock/balances?productId=${p.id}`);
  return { id: p.id, qty: b.reduce((s, x) => s + Number(x.quantity), 0) };
}
async function pay(saleId, method, amount) {
  let v = await agent('POST', `/api/sales/${saleId}/payments`, { method, amount, idempotencyKey: randomUUID() });
  const p = v.payments.at(-1);
  for (let i = 0; i < 20 && p.method !== 'cash' && v.payments.at(-1).status !== 'approved'; i++) {
    await sleep(400);
    v = await agent('POST', `/api/payments/${p.id}/poll`, {});
  }
  return v;
}
async function sell(codes, { method = 'cash', customer, beforeFinalize } = {}) {
  let v = await agent('POST', '/api/sales', {});
  if (v.items?.length) {
    // Venda aberta que sobrou de um cenário interrompido: cancela e começa outra
    await agent('POST', `/api/sales/${v.sale.id}/cancel`, { reason: 'Venda de teste interrompida na bateria', authorization: SUP });
    v = await agent('POST', '/api/sales', {});
  }
  const id = v.sale?.id ?? v.id;
  for (const c of codes) v = await agent('POST', `/api/sales/${id}/items`, { code: c });
  if (customer) v = await agent('POST', `/api/sales/${id}/customer`, customer);
  if (beforeFinalize) v = await beforeFinalize(id, v);
  v = await agent('POST', `/api/sales/${id}/finalize`, {});
  v = await pay(id, method, v.sale.total);
  return agent('POST', `/api/sales/${id}/complete`, {});
}

const ALL = ['setup', 'caixa', 'venda_cancel_parcial', 'cliente', 'cancelamento', 'devolucao', 'preco', 'produto_novo', 'cliente_novo', 'fechamento', 'monitor', 'painel'];
const want = new Set((process.argv[2] ?? ALL.join(',')).split(','));
const ctx = {};

await scenario('login', async () => {
  agentToken = (await http(AGENT, 'POST', '/api/auth/login', { login: 'ana', pin: '482913' })).token;
  erpToken = (await http(ERP, 'POST', '/v1/auth/login', { tenant: 'demo', email: 'gerente@demo.local', password: 'vortex-gerente-123' })).token;
  company = (await http(ERP, 'GET', '/v1/me', undefined, { authorization: `Bearer ${erpToken}` })).companies[0].id;
  check('login no PDV (ana) e no ERP (gerente)', agentToken && erpToken);
});

if (want.has('setup')) await scenario('setup', async () => {
  const r = await syncNow(true);
  check('carga completa do ERP no PDV', r.online && !r.errors.length, JSON.stringify(r).slice(0, 120));
  const leite = await agent('GET', '/api/products?q=leite');
  check('produtos do seed novo chegam ao PDV (LEITE-1L)', leite.some((p) => p.sku === 'LEITE-1L'));
  const dup = (await agent('GET', '/api/products?q=cafe')).filter((p) => p.sku === 'CAFE-500');
  check('sem produto duplicado de ERP anterior (CAFE-500 único)', dup.length === 1, `${dup.length} encontrado(s)`);
  const bruno = await http(AGENT, 'POST', '/api/auth/login', { login: 'bruno', pin: '640271' }).catch((e) => e);
  check('operador novo do ERP (bruno) entra no PDV', bruno.token);
});

if (want.has('caixa')) await scenario('caixa', async () => {
  const cur = await agent('GET', '/api/cash/summary').catch(() => null);
  // Caixa aberto antes do ERP ser recriado: fecha e abre de novo para a abertura existir neste ERP
  if (cur?.session?.status === 'open') {
    await agent('POST', '/api/cash/close', { informed: { cash: '100.00' }, authorization: GER }).catch((e) => console.log('      fechamento anterior:', e.message));
  }
  await agent('POST', '/api/cash/open', { amount: '150.00' });
  await syncNow();
  const mv = await erp('GET', '/v1/pdv/cash-movements?pdvId=03&limit=20');
  check('abertura de caixa chega ao ERP', mv.some((m) => m.kind === 'opening'), `${mv.length} movimento(s) do caixa 03`);
});

if (want.has('venda_cancel_parcial')) await scenario('venda_cancel_parcial', async () => {
  const before = await stockOf('CAFE-500');
  const leiteBefore = await stockOf('LEITE-1L');
  const done = await sell(['3*CAFE-500', 'LEITE-1L'], {
    beforeFinalize: async (id, v) => {
      const cafe = v.items.find((i) => i.sku === 'CAFE-500' && i.status === 'active');
      return agent('POST', `/api/sales/${id}/items/${cafe.id}/cancel`, { reason: 'Cliente desistiu de duas', quantity: '2', authorization: SUP });
    },
  });
  ctx.saleA = done.sale.number;
  check('venda com cancelamento parcial concluída no PDV', done.sale.status === 'completed', `${done.sale.number} total ${done.sale.total}`);
  await syncNow();
  const row = await erpSale(done.sale.number);
  check('venda chega ao ERP', row, row ? `NFC-e ${row.number} · operador ${row.operator_name}` : 'não encontrada');
  if (!row) return;
  check('total no ERP igual ao do PDV', Number(row.total) === Number(done.sale.total), `${row.total} × ${done.sale.total}`);
  check('operador da venda no ERP', row.operator_name === 'Ana Operadora');
  const detail = await erp('GET', `/v1/pdv/sales/by-id/${row.id}`);
  const ci = detail.cancelled_items?.[0];
  check('item cancelado no caixa (2 de 3) aparece no ERP com motivo e operador', ci && Number(ci.quantity) === 2 && ci.partial && ci.operatorName && ci.reason,
    ci ? `${ci.quantity} × ${ci.sku} · ${ci.reason} · por ${ci.operatorName}${ci.authorizedByName ? ` · autorizado por ${ci.authorizedByName}` : ' (loja não exige supervisor)'}` : 'sem itens cancelados');
  const after = await stockOf('CAFE-500');
  const leiteAfter = await stockOf('LEITE-1L');
  check('estoque do ERP baixa só o vendido (1 café, 1 leite)', before.qty - after.qty === 1 && leiteBefore.qty - leiteAfter.qty === 1,
    `café ${before.qty}→${after.qty}, leite ${leiteBefore.qty}→${leiteAfter.qty}`);
  check('NFC-e autorizada no ERP', row.fiscal_status === 'autorizada', `situação ${row.fiscal_status} · série ${row.series} nº ${row.number}`);
});

if (want.has('cliente')) await scenario('cliente', async () => {
  const done = await sell(['ARROZ-5'], { customer: { taxId: '52998224725' } });
  ctx.saleB = done.sale.number;
  await syncNow();
  const row = await erpSale(done.sale.number);
  check('venda com CPF do cliente chega ao ERP', row, done.sale.number);
  check('cliente identificado no ERP (pessoa já cadastrada)', row && /Maria/.test(row.recipient_name ?? ''), row ? `${row.recipient_name}` : '');
});

if (want.has('cancelamento')) await scenario('cancelamento', async () => {
  const before = await stockOf('BISC-200');
  const done = await sell(['2*BISC-200'], { method: 'debit' });
  await syncNow();
  await agent('POST', `/api/sales/${done.sale.id}/cancel`, { reason: 'Cliente desistiu após pagar no débito', authorization: SUP });
  await syncNow();
  const row = await erpSale(done.sale.number);
  check('cancelamento da venda chega ao ERP', row?.status === 'cancelled' || row?.cancelled_at, row ? `status ${row.status}` : 'venda não encontrada');
  const after = await stockOf('BISC-200');
  check('estoque volta no ERP após cancelamento', after.qty === before.qty, `${before.qty}→${after.qty}`);
});

if (want.has('devolucao')) await scenario('devolucao', async () => {
  if (!ctx.saleB) { check('devolução', false, 'sem venda B'); return; }
  const before = await stockOf('ARROZ-5');
  await agent('POST', '/api/returns', { saleNumber: ctx.saleB, items: [{ itemNumber: 1, quantity: '1' }], reason: 'Embalagem rasgada', refundMethod: 'cash',
    reference: `DEV-${Date.now()}`, authorization: SUP });
  await syncNow();
  const row = await erpSale(ctx.saleB);
  const detail = row ? await erp('GET', `/v1/pdv/sales/by-id/${row.id}`) : null;
  check('devolução chega ao ERP', detail?.returns?.length > 0, detail ? `${detail.returns?.length ?? 0} devolução(ões)` : '');
  const after = await stockOf('ARROZ-5');
  check('estoque volta no ERP após devolução', after.qty - before.qty === 1, `${before.qty}→${after.qty}`);
});

if (want.has('preco')) await scenario('preco', async () => {
  const lists = await erp('GET', '/v1/price-lists');
  const list = lists.find((l) => l.is_default);
  const cafe = await stockOf('XAMPU-300');
  const price = (19 + Math.floor(Math.random() * 5)).toFixed(2);
  await erp('PUT', `/v1/price-lists/${list.id}/items`, { productId: cafe.id, price });
  const t0 = Date.now();
  await syncNow();
  const p1 = (await agent('GET', '/api/products?q=xampu')).find((p) => p.sku === 'XAMPU-300');
  check('preço alterado no ERP chega ao PDV na sincronização comum', Number(p1.price) === Number(price),
    Number(p1.price) === Number(price) ? `${price} em ${Date.now() - t0} ms` : `PDV ainda com ${p1.price} (ERP ${price}); só na carga periódica/completa`);
  if (Number(p1.price) !== Number(price)) {
    await syncNow(true);
    const p2 = (await agent('GET', '/api/products?q=xampu')).find((p) => p.sku === 'XAMPU-300');
    check('preço chega com "Recarregar tudo"', Number(p2.price) === Number(price), p2.price);
  }
});

if (want.has('produto_novo')) await scenario('produto_novo', async () => {
  const sku = `BAT-${Date.now() % 100000}`;
  const p = await erp('POST', '/v1/products', { sku, description: 'Produto da bateria de testes', ncm: '21069090', stockUnit: 'UN', saleUnit: 'UN' });
  const list = (await erp('GET', '/v1/price-lists')).find((l) => l.is_default);
  await erp('PUT', `/v1/price-lists/${list.id}/items`, { productId: p.id, price: '9.99' });
  await syncNow();
  let found = (await agent('GET', `/api/products?q=${sku}`)).find((x) => x.sku === sku);
  check('produto novo do ERP aparece no PDV na sincronização comum', found, found ? `${sku} R$ ${found.price}` : 'não apareceu sem carga completa');
  if (!found) {
    await syncNow(true);
    found = (await agent('GET', `/api/products?q=${sku}`)).find((x) => x.sku === sku);
    check('produto novo aparece com "Recarregar tudo"', found);
  }
  ctx.newSku = sku;
  const v = await agent('POST', '/api/sales', {});
  const added = await agent('POST', `/api/sales/${v.sale?.id ?? v.id}/items`, { code: sku }).catch((e) => e);
  check('produto sem estoque no ERP: PDV avisa ao vender', added.warnings?.length || added.status === 422, added.warnings?.join('; ') ?? added.message);
  await agent('POST', `/api/sales/${v.sale?.id ?? v.id}/cancel`, { reason: 'Venda de teste da bateria, descartada', authorization: SUP }).catch(() => undefined);
});

if (want.has('cliente_novo')) await scenario('cliente_novo', async () => {
  const cpf = '39053344705';
  await agent('POST', '/api/customers', { taxId: cpf, name: 'Cliente Novo do Caixa' }).catch(() => undefined);
  const done = await sell(['AGUA-500'], { customer: { taxId: cpf } });
  await agent('POST', '/api/sync/retry', {}); // "Reenviar falhas": cadastro recusado antes da correção
  await syncNow();
  const parties = await erp('GET', `/v1/parties?q=${cpf}`);
  check('cliente cadastrado no caixa vira pessoa no ERP', (parties.items ?? parties).some((p) => p.tax_id === cpf));
  const row = await erpSale(done.sale.number);
  check('venda do cliente novo chega ligada a ele', row && /Cliente Novo/.test(row.recipient_name ?? ''), row ? (row.recipient_name ?? '—') : 'venda não encontrada');
});

if (want.has('offline')) await scenario('offline', async () => {
  console.log('      (para o ERP: aguarda o processo da API cair; reinicie-o quando pedir)');
  const ready = await fetch(`${ERP}/health`).then(() => true).catch(() => false);
  if (ready && !process.env.OFFLINE_READY) { check('offline', false, 'rode com o ERP parado e OFFLINE_READY=1'); return; }
  const cur = await agent('GET', '/api/cash/summary').catch(() => null);
  if (cur?.session?.status !== 'open') await agent('POST', '/api/cash/open', { amount: '100.00' });
  const done = await sell(['CERV-350', 'CERV-350']);
  const st = await agent('POST', '/api/sync', {});
  check('com o ERP fora, a venda é concluída e fica na fila', done.sale.status === 'completed' && !st.online, `online=${st.online}`);
  ctx.offlineSale = done.sale.number;
  console.log(`OFFLINE_SALE=${done.sale.number}`);
});

if (want.has('offline_back')) await scenario('offline_back', async () => {
  const number = process.env.OFFLINE_SALE;
  await syncNow();
  const row = await erpSale(number);
  check('ao voltar, a venda feita offline chega ao ERP (uma vez só)', row, number);
  const st = await agent('GET', '/api/sync/queue');
  check('fila do PDV zerada após reconexão', st.counts.PENDING === 0 && st.counts.FAILED === 0, JSON.stringify(st.counts));
});

if (want.has('fechamento')) await scenario('fechamento', async () => {
  await agent('POST', '/api/cash/withdraw', { amount: '50.00', reason: 'Sangria para o cofre', authorization: SUP });
  // Fechamento cego: o operador informa o que contou (aqui, um valor redondo); o PDV calcula a diferença
  await agent('POST', '/api/cash/close', { informed: { cash: '300.00' }, authorization: GER });
  await syncNow();
  const mv = await erp('GET', '/v1/pdv/cash-movements?pdvId=03&limit=50');
  check('sangria chega ao ERP', mv.some((m) => m.kind === 'withdrawal'));
  const close = mv.find((m) => m.kind === 'closing');
  check('fechamento chega ao ERP com esperado, contado e diferença coerentes', close && Math.abs(Number(close.counted ?? close.amount ?? 0) - Number(close.expected) - Number(close.difference)) < 0.01,
    close ? `esperado ${close.expected} · contado ${close.counted ?? close.amount} · diferença ${close.difference}` : 'sem fechamento');
});

if (want.has('monitor')) await scenario('monitor', async () => {
  const terms = await erp('GET', '/v1/pdv/terminals');
  const t3 = terms.find((t) => t.code === '03');
  const age = t3?.last_seen_at ? (Date.now() - new Date(t3.last_seen_at).getTime()) / 1000 : null;
  check('ERP vê o terminal 03 online (sinal de vida recente)', age !== null && age < 300, t3 ? `último sinal há ${Math.round(age)} s · versão ${t3.app_version ?? '—'} · pendências ${t3.pending_sales ?? '—'}` : 'terminal não listado');
  const ev = await erp('GET', '/v1/pdv/events?limit=50').catch((e) => e);
  check('auditoria do PDV chega ao ERP', Array.isArray(ev) ? ev.length > 0 : ev.items?.length > 0, Array.isArray(ev) ? `${ev.length} evento(s)` : ev.message);
});

if (want.has('painel')) await scenario('painel', async () => {
  const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const s = await erp('GET', `/v1/pdv/sales/summary?from=${today}&to=${today}&pdvId=03`);
  check('resumo do PDV no ERP inclui as vendas de hoje do caixa 03', s.count > 0 || s.sales > 0, JSON.stringify(s).slice(0, 160));
  const charts = await erp('GET', '/v1/dashboard/owner/charts?days=7');
  const day = charts.daily.at(-1);
  check('painel do dono soma a loja física de hoje', Number(day.pdv) > 0, `hoje: pedidos ${day.orders} · PDV ${day.pdv}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações ok`);
process.exitCode = failed.length ? 1 : 0;
