import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { hmacSha256 } from '../src/core/crypto.js';
import { computeCharges } from '../src/modules/finance/titles.js';
import { buildBoletoCodes, buildPixBrCode, validateDigitableLine, validatePixBrCode } from '../src/modules/finance/bank-gateway.js';
import { createUser, makeApp, makeCnpj, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let accounts: Record<string, string>;
let cats: Record<string, string>;
let customerPF: string;
let supplier: string;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const today = () => new Date().toISOString().slice(0, 10);
const addr = { kind: 'fiscal', zip: '50050000', street: 'Rua da Aurora', number: '1', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' };

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app, { regime: 'lucro_presumido' });
  accounts = Object.fromEntries((await t.admin.get('/v1/financial-accounts')).body.map((a: any) => [a.code, a.id]));
  cats = Object.fromEntries((await t.admin.get('/v1/categories')).body.map((c: any) => [c.code, c.id]));
  await run((tx) => tx.exec(`UPDATE finance.accounts SET bank_code = '001', account_number = '1234567', pix_key = 'financeiro@loja.test' WHERE id = $1`, [accounts.BANCO]));
  customerPF = (await t.admin.post('/v1/parties', { kind: 'PF', taxId: '529.982.247-25', legalName: 'Maria Consumidora', roles: ['customer'], addresses: [addr] })).body.id;
  supplier = (await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Fornecedor de Serviços SA', roles: ['supplier'], addresses: [addr] })).body.id;
});
afterAll(async () => app.close());

async function receivable(amount: string, due: string, partyId = customerPF) {
  const r = await t.admin.post('/v1/finance/titles', { kind: 'receivable', partyId, documentNumber: `R-${Math.random().toString(36).slice(2, 7)}`, issueDate: '2026-01-02',
    installments: [{ dueDate: due, amount }], categoryId: cats['1.1'] });
  expect(r.status).toBe(201);
  return r.body[0];
}

describe('Boleto e Pix (códigos válidos)', () => {
  it('linha digitável FEBRABAN e BR Code Pix com CRC16 válidos', () => {
    const c = buildBoletoCodes('001', '2026-12-10', '1500.75', '0001234560000012345000000');
    expect(c.barcode).toHaveLength(44);
    expect(c.digitableLine).toHaveLength(47);
    expect(validateDigitableLine(c.digitableLine)).toBe(true);
    expect(validateDigitableLine(`${c.digitableLine.slice(0, 46)}${(Number(c.digitableLine[46]) + 1) % 10}`)).toBe(false); // alterar o valor invalida o DV geral
    const pix = buildPixBrCode({ pixKey: 'chave@x.com', amount: '10.50', txid: 'ABC123', merchantName: 'Loja São João', merchantCity: 'Recife' });
    expect(validatePixBrCode(pix)).toBe(true);
    expect(pix).toContain('br.gov.bcb.pix');
  });
});

describe('Títulos e baixas', () => {
  it('RN-FIN-02 multa limitada a 2% para consumidor (CDC) e juros pro rata dia', () => {
    const ch = computeCharges({ due_date: '2026-01-10', balance: '1000.00', fine_percent: '2', interest_month_percent: '1', paid_fine: '0' }, '2026-01-25');
    expect(ch.daysLate).toBe(15);
    expect(ch.fine.toFixed(2)).toBe('20.00');
    expect(ch.interest.toFixed(2)).toBe('5.00');
  });

  it('RN-FIN-03 baixa parcial mantém saldo; encargos abatidos primeiro; contábil e movimento de conta', async () => {
    const tt = await receivable('1000.00', '2026-01-10');
    expect(tt.fine_percent).toBe('2.0000');
    const s1 = await t.admin.post(`/v1/finance/titles/${tt.id}/settle`, { date: '2026-01-25', accountId: accounts.BANCO, amount: '525.00' });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ fine: '20.00', interest: '5.00', principal: '500.00' });
    const t1 = (await t.admin.get(`/v1/finance/titles/${tt.id}`)).body;
    expect(t1.status).toBe('partially_paid');
    expect(t1.balance).toBe('500.00');
    // segunda baixa no prazo de nova cobrança: multa não se repete
    const s2 = await t.admin.post(`/v1/finance/titles/${tt.id}/settle`, { date: '2026-01-25', accountId: accounts.BANCO, amount: '502.50' });
    expect(s2.body).toMatchObject({ fine: '0.00', interest: '2.50', principal: '500.00' });
    expect((await t.admin.get(`/v1/finance/titles/${tt.id}`)).body.status).toBe('paid');
    const bal = await run((tx) => tx.one(`SELECT sum(debit) AS d, sum(credit) AS c FROM accounting.journal_lines l JOIN accounting.journal_entries e ON e.id = l.entry_id WHERE e.event_type = 'recebimento' AND e.origin_id = $1`, [s1.body.id]));
    expect(bal.d).toBe(bal.c);
    expect(bal.d).toBe('525.00');
  });

  it('RN-FIN-01 título de documento fiscal não tem valor alterado; RN-FIN-06 estorno com motivo', async () => {
    const tt = await receivable('300.00', '2026-12-31');
    const s = await t.admin.post(`/v1/finance/titles/${tt.id}/settle`, { date: '2026-03-01', accountId: accounts.CAIXA, amount: '300.00' });
    const semMotivo = await t.admin.post(`/v1/finance/settlements/${s.body.id}/reverse`, { reason: 'erro' });
    expect(semMotivo.status).toBe(422);
    const rev = await t.admin.post(`/v1/finance/settlements/${s.body.id}/reverse`, { reason: 'Baixa feita no título errado pelo caixa' });
    expect(rev.status).toBe(200);
    const after = (await t.admin.get(`/v1/finance/titles/${tt.id}`)).body;
    expect(after.status).toBe('open');
    expect(after.balance).toBe('300.00');
    // conciliada → não estorna
    const s2 = await t.admin.post(`/v1/finance/titles/${tt.id}/settle`, { date: '2026-03-02', accountId: accounts.CAIXA, amount: '300.00' });
    await run((tx) => tx.exec(`UPDATE finance.account_movements SET reconciled = true WHERE id = $1`, [s2.body.account_movement_id]));
    const blocked = await t.admin.post(`/v1/finance/settlements/${s2.body.id}/reverse`, { reason: 'Tentativa de estorno de baixa conciliada' });
    expect(blocked.body.details.rule).toBe('RN-FIN-06');
  });

  it('RN-FIN-04 renegociação cancela originais e cria novos títulos vinculados', async () => {
    const a = await receivable('400.00', '2026-02-10');
    const b = await receivable('600.00', '2026-03-10');
    const r = await t.admin.post('/v1/finance/renegotiations', { titleIds: [a.id, b.id], chargesNegotiated: '50.00', discountGranted: '30.00', reason: 'Cliente em dificuldade, acordo em 2x',
      installments: [{ dueDate: '2026-11-10', amount: '510.00' }, { dueDate: '2026-12-10', amount: '510.00' }] });
    expect(r.status).toBe(201);
    expect(r.body.titles).toHaveLength(2);
    expect((await t.admin.get(`/v1/finance/titles/${a.id}`)).body.status).toBe('renegotiated');
    const wrong = await t.admin.post('/v1/finance/renegotiations', { titleIds: [r.body.titles[0].id], reason: 'Teste com valores errados', installments: [{ dueDate: '2026-12-10', amount: '1.00' }] });
    expect(wrong.status).toBe(422);
  });

  it('RN-FIN-05 adiantamento vira crédito e compensa títulos futuros', async () => {
    const adv = await t.admin.post('/v1/finance/advances', { partyId: customerPF, from: 'customer', amount: '200.00', accountId: accounts.CAIXA, date: today() });
    expect(adv.status).toBe(201);
    const tt = await receivable('350.00', '2026-12-20');
    const c = await t.admin.post(`/v1/finance/advances/${adv.body.id}/compensate`, { titleId: tt.id });
    expect(c.body.compensated).toBe('200.00');
    expect((await t.admin.get(`/v1/finance/titles/${tt.id}`)).body.balance).toBe('150.00');
  });
});

describe('Cobrança registrada e webhook do banco', () => {
  it('Pix com txid único: webhook assinado baixa o título em segundos', async () => {
    const tt = await receivable('150.00', '2026-12-31');
    const ch = await t.admin.post(`/v1/finance/titles/${tt.id}/charge`, { kind: 'pix_cob', accountId: accounts.BANCO });
    expect(ch.status).toBe(201);
    expect(validatePixBrCode(ch.body.qr_code)).toBe(true);
    const payload = { kind: 'pix', txid: ch.body.txid, amount: '150.00', paidAt: new Date().toISOString(), endToEndId: 'E123' };
    const bad = await app.inject({ method: 'POST', url: `/v1/public/bank-webhooks/${t.tenantId}/${accounts.BANCO}`, payload, headers: { 'x-signature': 'x' } });
    expect(bad.statusCode).toBe(401);
    const sig = hmacSha256(`${app.deps.config.webhookSigningSecret}:${accounts.BANCO}`, JSON.stringify(payload));
    const ok = await app.inject({ method: 'POST', url: `/v1/public/bank-webhooks/${t.tenantId}/${accounts.BANCO}`, payload, headers: { 'x-signature': sig } });
    expect(ok.statusCode).toBe(200);
    expect((await t.admin.get(`/v1/finance/titles/${tt.id}`)).body.status).toBe('paid');
    // reentrega do webhook não duplica a baixa
    const again = await app.inject({ method: 'POST', url: `/v1/public/bank-webhooks/${t.tenantId}/${accounts.BANCO}`, payload, headers: { 'x-signature': sig } });
    expect(again.json().duplicate).toBe(true);
  });

  it('boleto híbrido registrado com linha digitável válida', async () => {
    const tt = await receivable('99.90', '2026-12-31');
    const ch = await t.admin.post(`/v1/finance/titles/${tt.id}/charge`, { kind: 'boleto', accountId: accounts.BANCO });
    expect(validateDigitableLine(ch.body.digitable_line)).toBe(true);
    expect(ch.body.qr_code).toBeTruthy();
  });
});

describe('Contas a pagar: segregação de funções e borderô', () => {
  it('RN-ACE-01 quem cadastrou a conta bancária do fornecedor não aprova o pagamento; RN-FIN-07 borderô só baixa após o retorno', async () => {
    const fin1 = await createUser(app, t, ['financeiro']);
    const fin2 = await createUser(app, t, ['financeiro']);
    const acc = await fin1.post(`/v1/parties/${supplier}/bank-accounts`, { pixKeyType: 'email', pixKey: 'pagamentos@fornecedor.test', holderName: 'Fornecedor de Serviços SA',
      holderTaxId: (await t.admin.get(`/v1/parties/${supplier}`)).body.tax_id });
    const a1 = await createUser(app, t, ['administrador']);
    await a1.post(`/v1/approvals/${acc.body.approvalRequestId}/decision`, { decision: 'approve' });
    await t.admin.post(`/v1/approvals/${acc.body.approvalRequestId}/decision`, { decision: 'approve' }).catch(() => undefined);
    const a2 = await createUser(app, t, ['administrador']);
    await a2.post(`/v1/approvals/${acc.body.approvalRequestId}/decision`, { decision: 'approve' });
    const pay = await t.admin.post('/v1/finance/titles', { kind: 'payable', partyId: supplier, documentNumber: 'NFS-77', issueDate: today(), installments: [{ dueDate: today(), amount: '1200.00' }], categoryId: cats['5.3'] });
    const denied = await fin1.post(`/v1/finance/titles/${pay.body[0].id}/approve`);
    expect(denied.status).toBe(403);
    expect(denied.body.details.rule).toBe('RN-ACE-01');
    const batch = await fin2.post('/v1/finance/payment-batches', { accountId: accounts.BANCO, paymentDate: today(), titleIds: [pay.body[0].id] });
    expect(batch.status).toBe(422); // ainda não aprovado
    expect((await fin2.post(`/v1/finance/titles/${pay.body[0].id}/approve`)).status).toBe(200);
    const b = await fin2.post('/v1/finance/payment-batches', { accountId: accounts.BANCO, paymentDate: today(), titleIds: [pay.body[0].id] });
    expect(b.status).toBe(201);
    expect((await fin2.post(`/v1/finance/payment-batches/${b.body.id}/approve`)).status).toBe(403); // quem montou não aprova
    expect((await fin1.post(`/v1/finance/payment-batches/${b.body.id}/approve`)).body.status).toBe('approved');
    const sent = await fin1.post(`/v1/finance/payment-batches/${b.body.id}/send`);
    expect(sent.body.status).toBe('sent');
    expect((await t.admin.get(`/v1/finance/titles/${pay.body[0].id}`)).body.status).toBe('open');
    const items = (await t.admin.get(`/v1/finance/payment-batches/${b.body.id}`)).body.items;
    expect(items[0].method).toBe('pix');
    await fin1.post(`/v1/finance/payment-batch-items/${items[0].id}/return`, { ok: true });
    expect((await t.admin.get(`/v1/finance/titles/${pay.body[0].id}`)).body.status).toBe('paid');
  });
});

describe('Relatórios financeiros e contabilidade', () => {
  it('fluxo de caixa realizado e projetado, DRE gerencial e aging', async () => {
    const cf = await t.admin.get('/v1/finance/cash-flow', { from: '2026-01-01', to: '2026-12-31', granularity: 'month' });
    expect(cf.status).toBe(200);
    expect(cf.body.rows.length).toBeGreaterThan(0);
    const dre = await t.admin.get('/v1/finance/dre', { from: '2026-01-01', to: '2026-12-31', basis: 'competence' });
    expect(dre.body.lines.map((l: any) => l.key)).toContain('resultado');
    const caixa = await t.admin.get('/v1/finance/dre', { from: '2026-01-01', to: '2026-12-31', basis: 'cash' });
    expect(caixa.status).toBe(200);
    const aging = await t.admin.get('/v1/finance/aging');
    expect(Number(aging.body.total)).toBeGreaterThan(0);
  });

  it('RN-CTB-01 banco recusa lançamento desbalanceado; RN-CTB-05 só contas que aceitam manual', async () => {
    const bad = await t.admin.post('/v1/accounting/entries', { date: today(), description: 'Teste', lines: [{ accountCode: '1.1.1.01', debit: '10', history: 'x1x' }, { accountCode: '2.3.1', credit: '9', history: 'x2x' }] });
    expect(bad.status).toBe(422);
    const notManual = await t.admin.post('/v1/accounting/entries', { date: today(), description: 'Teste', lines: [{ accountCode: '1.1.2.01', debit: '10', history: 'abc' }, { accountCode: '2.3.1', credit: '10', history: 'abc' }] });
    expect(notManual.status).toBe(422);
    expect(notManual.body.details.rule).toBe('RN-CTB-05');
    const ok = await t.admin.post('/v1/accounting/entries', { date: today(), description: 'Integralização de capital', lines: [{ accountCode: '1.1.1.02', debit: '10000', history: 'Depósito do capital' }, { accountCode: '2.3.1', credit: '10000', history: 'Capital social' }] });
    expect(ok.status).toBe(201);
    // Direto no banco: o trigger diferido barra desbalanceamento mesmo sem a API
    await expect(run(async (tx) => {
      const e = await tx.one(`INSERT INTO accounting.journal_entries (tenant_id, company_id, number, entry_date, description, event_type) VALUES ($1,$2,999999,current_date,'x','x') RETURNING id`, [t.tenantId, t.companyId]);
      const acc = await tx.one(`SELECT id FROM accounting.chart_of_accounts WHERE code = '1.1.1.01'`);
      await tx.exec(`INSERT INTO accounting.journal_lines (tenant_id, entry_id, account_id, debit, history) VALUES ($1,$2,$3,10,'x'), ($1,$2,$3,0.01,'y')`, [t.tenantId, e.id, acc.id]);
    })).rejects.toThrow(/RN-CTB-01/);
  });

  it('balancete fecha (débitos = créditos), razão e balanço', async () => {
    const tb = await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2026-12-31' });
    expect(tb.body.totals.debit).toBe(tb.body.totals.credit);
    expect(tb.body.totals.closing).toBe('0.00');
    const led = await t.admin.get('/v1/accounting/ledger', { accountCode: '1.1.1.02', from: '2026-01-01', to: '2026-12-31' });
    expect(led.body.rows.length).toBeGreaterThan(0);
    const st = await t.admin.get('/v1/accounting/statements', { from: '2026-01-01', to: '2026-12-31' });
    expect(st.body.balanceSheet.balanced).toBe(true);
  });

  it('RN-CTB-04 fechamento do período bloqueia baixas e lançamentos; reabertura só por contador com motivo', async () => {
    const tt = await receivable('80.00', '2026-12-31');
    const close = await t.admin.post('/v1/accounting/periods/close', { year: 2026, month: 2 });
    expect(close.status).toBe(200);
    const blocked = await t.admin.post(`/v1/finance/titles/${tt.id}/settle`, { date: '2026-02-15', accountId: accounts.CAIXA, amount: '80.00' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.details.rule).toBe('RN-CTB-04');
    const vendedor = await createUser(app, t, ['gerente']);
    expect((await vendedor.post('/v1/accounting/periods/reopen', { year: 2026, month: 2, reason: 'Ajuste de baixa esquecida no mês' })).status).toBe(403);
    const contador = await createUser(app, t, ['contador']);
    const re = await contador.post('/v1/accounting/periods/reopen', { year: 2026, month: 2, reason: 'Ajuste de baixa esquecida no mês' });
    expect(re.body.status).toBe('open');
    expect((await t.admin.post(`/v1/finance/titles/${tt.id}/settle`, { date: '2026-02-15', accountId: accounts.CAIXA, amount: '80.00' })).status).toBe(200);
  });

  it('RN-CTB-04 título de competência fechada continua recebível depois (a baixa leva a data dela)', async () => {
    const r = await t.admin.post('/v1/finance/titles', { kind: 'receivable', partyId: customerPF, documentNumber: 'R-MAR', issueDate: '2026-03-10',
      installments: [{ dueDate: '2026-04-10', amount: '45.00' }], categoryId: cats['1.1'] });
    expect((await t.admin.post('/v1/accounting/periods/close', { year: 2026, month: 3 })).status).toBe(200);
    const late = new Date().toISOString().slice(0, 10);
    const s = await t.admin.post(`/v1/finance/titles/${r.body[0].id}/settle`, { date: late, accountId: accounts.CAIXA, amount: '45.00', waiveCharges: true });
    expect(s.status).toBe(200);
    expect((await t.admin.get(`/v1/finance/titles/${r.body[0].id}`)).body.status).toBe('paid');
    // Mas mudar a competência para dentro do mês fechado continua bloqueado
    const moved = await t.admin.post('/v1/finance/titles', { kind: 'receivable', partyId: customerPF, documentNumber: 'R-MAR2', issueDate: '2026-03-15',
      installments: [{ dueDate: '2026-04-10', amount: '10.00' }], categoryId: cats['1.1'] });
    expect(moved.status).toBe(422);
  });

  it('exportação ao contador gera pacote .tar.gz com livros, lançamentos e EFD', async () => {
    const r = await t.admin.post('/v1/accounting/exports', { from: '2026-01-01', to: '2026-12-31' });
    expect(r.status).toBe(201);
    expect(r.body.files).toEqual(expect.arrayContaining(['livros/registro-saidas.csv', 'contabil/lancamentos.csv', 'LEIAME.json']));
    expect(r.body.files.some((f: string) => f.startsWith('sped/efd-icms-ipi'))).toBe(true);
    const file = await app.inject({ method: 'GET', url: `/v1/accounting/exports/download?key=${encodeURIComponent(r.body.key)}`, headers: { authorization: `Bearer ${t.admin.token}`, 'x-company-id': t.companyId } });
    const tar = gunzipSync(file.rawPayload);
    expect(tar.toString('latin1')).toContain('|0000|');
    expect(tar.toString('latin1')).toContain('|9999|');
    void D;
  });
});
