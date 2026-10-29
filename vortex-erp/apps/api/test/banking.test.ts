import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { createTitles } from '../src/modules/finance/titles.js';
import { parseOfx } from '../src/modules/finance/reconciliation.js';
import { MemoryMailer, MemoryMessenger } from '../src/core/mailer.js';
import { makeApp, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let maria: string;
let accounts: Record<string, string>;
let cats: Record<string, string>;
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ofxDay = (d: string) => d.replace(/-/g, '');
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];

async function receivable(amount: string, due: string, doc: string) {
  const r = await t.admin.post('/v1/finance/titles', { kind: 'receivable', partyId: maria, documentNumber: doc, issueDate: day(-20), installments: [{ dueDate: due, amount }], categoryId: cats['1.1'] });
  expect(r.status).toBe(201);
  return r.body[0];
}
function ofx(lines: { date: string; amount: string; memo: string; fitid: string }[], balance: string) {
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>001<ACCTID>12345<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>${ofxDay(day(-5))}<DTEND>${ofxDay(today)}
${lines.map((l) => `<STMTTRN><TRNTYPE>${D(l.amount).isNegative() ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${ofxDay(l.date)}120000[-3:BRT]<TRNAMT>${l.amount.replace('.', ',')}<FITID>${l.fitid}<MEMO>${l.memo}</STMTTRN>`).join('\n')}
</BANKTRANLIST><LEDGERBAL><BALAMT>${balance}<DTASOF>${ofxDay(today)}</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  maria = (await t.admin.post('/v1/parties', { kind: 'PF', taxId: '529.982.247-25', legalName: 'Maria Cliente', roles: ['customer'], finalConsumer: true, addresses: ADDR,
    contacts: [{ name: 'Maria', email: 'maria@cliente.test', whatsapp: '5581988887777', consents: { cobranca_whatsapp: true } }] })).body.id;
  expect(maria).toBeTruthy();
  accounts = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.accounts`))).map((a) => [a.code, a.id]));
  cats = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.categories`))).map((a) => [a.code, a.id]));
  await run((tx) => tx.exec(`UPDATE finance.accounts SET pix_key = 'financeiro@loja.test', bank_code = '001', account_number = '12345', initial_balance_date = '2026-01-01' WHERE id = $1`, [accounts.BANCO]));
});
afterAll(async () => app.close());

describe('Conciliação bancária (seção 13)', () => {
  it('lê OFX 1.x (SGML) com vírgula decimal e saldo final', () => {
    const o = parseOfx(ofx([{ date: today, amount: '-12.50', memo: 'TARIFA', fitid: 'A1' }], '100.00'));
    expect(o.transactions[0]).toMatchObject({ date: today, amount: '-12.50', fitid: 'A1', memo: 'TARIFA' });
    expect(o.balance).toBe('100.00');
    expect(() => parseOfx('não é ofx')).toThrow();
  });

  it('automática por txid, valor+data e regra salva; sugestão um-para-muitos; aprende; saldo diário bate', async () => {
    const tPix = await receivable('300.00', day(5), 'PIX-1');
    const pix = await t.admin.post(`/v1/finance/titles/${tPix.id}/charge`, { kind: 'pix_cob', accountId: accounts.BANCO });
    expect(pix.status, JSON.stringify(pix.body)).toBe(201);
    const tManual = await receivable('89.90', day(-2), 'MAN-1');
    expect((await t.admin.post(`/v1/finance/titles/${tManual.id}/settle`, { date: day(-2), accountId: accounts.BANCO, amount: '89.90', waiveCharges: true })).status).toBe(200);
    const a = await receivable('100.00', day(10), 'A-1');
    const b = await receivable('150.00', day(10), 'B-1');
    await t.admin.post('/v1/finance/reconciliation-rules', { descriptionPattern: 'TARIFA', direction: 'D', categoryId: cats['7.2'] });

    const file = ofx([
      { date: day(-1), amount: '300.00', memo: `PIX RECEBIDO TXID: ${pix.body.txid}`, fitid: 'F1' },
      { date: day(-1), amount: '89.90', memo: 'TED RECEBIDA', fitid: 'F2' },
      { date: today, amount: '-12.50', memo: 'TARIFA PACOTE SERVICOS', fitid: 'F3' },
      { date: today, amount: '250.00', memo: 'PIX RECEBIDO MARIA CLIENTE', fitid: 'F4' },
      { date: today, amount: '40.00', memo: 'RENDIMENTO APLICACAO', fitid: 'F5' },
    ], '667.40');
    const imp = await t.admin.post(`/v1/finance/accounts/${accounts.BANCO}/statements`, { content: file, fileName: 'extrato.ofx' });
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ transactions: 5, imported: 5, byTxid: 1, byValue: 1, byRule: 1, autoReconciled: 3 });
    expect((await t.admin.get(`/v1/finance/titles/${tPix.id}`)).body.status).toBe('paid');
    // Reimportar o mesmo arquivo não duplica (FITID)
    expect((await t.admin.post(`/v1/finance/accounts/${accounts.BANCO}/statements`, { content: file })).body).toMatchObject({ imported: 0, duplicates: 5 });

    const pending = (await t.admin.get(`/v1/finance/accounts/${accounts.BANCO}/statement-lines`, { status: 'pending' })).body;
    expect(pending.map((l: any) => l.fitid).sort()).toEqual(['F4', 'F5']);
    const f4 = pending.find((l: any) => l.fitid === 'F4');
    const sug = (await t.admin.get(`/v1/finance/statement-lines/${f4.id}/suggestions`)).body;
    expect(sug[0].kind).toBe('titles');
    expect(sug[0].titles.map((x: any) => x.titleId).sort()).toEqual([a.id, b.id].sort());
    const rec = await t.admin.post('/v1/finance/reconciliations', { lineIds: [f4.id], titles: sug[0].titles.map((x: any) => ({ titleId: x.titleId })) });
    expect(rec.status).toBe(201);
    for (const x of [a, b]) expect((await t.admin.get(`/v1/finance/titles/${x.id}`)).body.status).toBe('paid');

    const f5 = pending.find((l: any) => l.fitid === 'F5');
    const wrong = await t.admin.post('/v1/finance/reconciliations', { lineIds: [f5.id], movementIds: [] });
    expect(wrong.status).toBe(422);
    expect((await t.admin.post('/v1/finance/reconciliations', { lineIds: [f5.id], newMovement: { categoryId: cats['6'] } })).status).toBe(201);

    // Aprendeu: próxima linha "MARIA" sugere títulos da Maria primeiro
    const memory = await run((tx) => tx.query(`SELECT token FROM finance.reconciliation_memory WHERE party_id = $1`, [maria]));
    expect(memory.map((m: any) => m.token)).toContain('MARIA');

    const pos = (await t.admin.get(`/v1/finance/accounts/${accounts.BANCO}/daily-position`, { from: day(-3), to: today })).body;
    const last = pos.at(-1);
    expect(last).toMatchObject({ system: '667.40', bank: '667.40', reconciled: true, difference: '0.00', alert: false });

    // Desfazer: a linha volta a pendente e o movimento fica livre
    const tarifaLine = (await t.admin.get(`/v1/finance/accounts/${accounts.BANCO}/statement-lines`)).body.find((l: any) => l.fitid === 'F3');
    expect((await t.admin.post(`/v1/finance/reconciliations/${tarifaLine.reconciliation_id}/undo`, { reason: 'curto' })).status).toBe(422);
    expect((await t.admin.post(`/v1/finance/reconciliations/${tarifaLine.reconciliation_id}/undo`, { reason: 'Tarifa lançada na categoria errada' })).status).toBe(200);
    const pos2 = (await t.admin.get(`/v1/finance/accounts/${accounts.BANCO}/daily-position`, { from: today, to: today })).body;
    expect(pos2[0].reconciled).toBe(false);
    const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
    expect(tb.totals.debit).toBe(tb.totals.credit);
  });
});

describe('Régua de cobrança (RN-FIN-09)', () => {
  it('D−3 por e-mail; D+3 por e-mail e WhatsApp (com consentimento) e Pix atualizado; sem repetir', async () => {
    const mailer = app.deps.services.mailer as MemoryMailer;
    const wa = app.deps.services.messenger as MemoryMessenger;
    const soon = await receivable('200.00', day(3), 'REG-1');
    const late = await receivable('500.00', day(-3), 'REG-2');
    await run((tx) => tx.exec(`UPDATE finance.titles SET account_id = $2 WHERE id = $1`, [late.id, accounts.BANCO]));
    const before = { mail: mailer.sent.length, wa: wa.sent.length };
    const r1 = await t.admin.post('/v1/finance/collection/run', {});
    expect(r1.status).toBe(200);
    const mails = mailer.sent.slice(before.mail);
    expect(mails.some((m) => m.subject.includes('REG-1') && m.subject.includes('vence em'))).toBe(true);
    const lateMail = mails.find((m) => m.subject.includes('REG-2'));
    expect(lateMail?.html).toContain('atualizado');
    expect(lateMail?.html).toContain('Pix copia e cola');
    const msgs = wa.sent.slice(before.wa);
    expect(msgs.some((m) => m.text.includes('REG-2'))).toBe(true);
    expect(msgs.some((m) => m.text.includes('REG-1'))).toBe(false);
    // Pix novo com multa (2%) + juros pro rata: valor acima do saldo
    const charge = await run((tx) => tx.one<{ amount: string; status: string }>(`SELECT amount, status FROM finance.charges WHERE title_id = $1 AND status = 'registered'`, [late.id]));
    expect(D(charge.amount).greaterThan('510.00')).toBe(true);
    // Rodar de novo no mesmo dia não reenvia
    const again = (await t.admin.post('/v1/finance/collection/run', {})).body;
    expect(again.sent).toBe(0);
    const hist = (await t.admin.get(`/v1/finance/titles/${late.id}/collection`)).body;
    expect(hist.map((h: any) => `${h.offset_days}:${h.channel}:${h.status}`).sort()).toEqual(['3:email:sent', '3:whatsapp:sent']);
    void soon;
  });

  it('régua configurável por empresa', async () => {
    const r = await t.admin.put('/v1/finance/collection-rule', { steps: [{ offsetDays: 0, channels: ['email'] }, { offsetDays: 15, channels: ['whatsapp'] }] });
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: any) => s.offsetDays)).toEqual([0, 15]);
    expect((await t.admin.put('/v1/finance/collection-rule', { steps: [{ offsetDays: 0, channels: ['email'] }, { offsetDays: 0, channels: ['whatsapp'] }] })).status).toBe(422);
  });
});

describe('Adquirente e orçamento', () => {
  it('RN-FIN-08 baixa o recebível pelo líquido pago e alerta divergência de taxa; chargeback vira alerta', async () => {
    const [card] = await run((tx) => createTitles(tx, { kind: 'receivable', partyId: maria, originType: 'card', documentNumber: 'CARD-1', issueDate: today,
      installments: [{ dueDate: day(30), amount: '96.50' }], accountId: accounts.ADQUIRENTE, card: { grossAmount: '100.00', feeAmount: '3.50' }, notes: 'NSU 777' }));
    const r = await t.admin.post(`/v1/finance/accounts/${accounts.ADQUIRENTE}/acquirer-statement`, {
      lines: [{ kind: 'sale', saleDate: today, paymentDate: day(1), nsu: '777', gross: '100.00', fee: '4.00', net: '96.00' }, { kind: 'chargeback', paymentDate: day(1), nsu: '888', gross: '50.00', net: '0' }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ divergent: 1, unmatched: 1 });
    expect((await t.admin.get(`/v1/finance/titles/${card!.id}`)).body.status).toBe('paid');
    const ev = await run((tx) => tx.query(`SELECT payload FROM integration.outbox_events WHERE event_type = 'cartao.divergencia'`));
    expect(ev.map((e: any) => e.payload.diferenca)).toContain('-0.50');
    const dup = await t.admin.post(`/v1/finance/accounts/${accounts.ADQUIRENTE}/acquirer-statement`, { lines: [{ kind: 'sale', saleDate: today, paymentDate: day(1), nsu: '777', gross: '100.00', fee: '4.00', net: '96.00' }] });
    expect(dup.body.duplicates).toBe(1);
  });

  it('orçado × realizado: alerta uma vez quando a despesa passa do orçamento', async () => {
    const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    expect((await t.admin.put('/v1/finance/budgets', { year: y, lines: [{ month: m, categoryId: cats['5.1'], amount: '1000.00' }] })).status).toBeLessThan(300);
    const sup = (await t.admin.post('/v1/parties', { kind: 'PJ', taxId: '11.222.333/0001-81', legalName: 'Imobiliária', roles: ['supplier'], addresses: ADDR })).body.id;
    await t.admin.post('/v1/finance/titles', { kind: 'payable', partyId: sup, documentNumber: 'ALUGUEL', issueDate: today, installments: [{ dueDate: day(5), amount: '1200.00' }], categoryId: cats['5.1'] });
    expect((await t.admin.post('/v1/finance/budget-alerts/run', {})).body.alerts).toBe(1);
    expect((await t.admin.post('/v1/finance/budget-alerts/run', {})).body.alerts).toBe(0);
  });
});
