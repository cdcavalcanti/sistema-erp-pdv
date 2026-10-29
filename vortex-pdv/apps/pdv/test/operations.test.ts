import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAccessKey } from '@vortex/validators';
import { GER, login, makePdv, OPS, PRODUCT, SUP, type TestPdv } from './helpers.js';
import { createPdv } from '../src/application/pdv.js';
import { loadConfig } from '../src/config.js';
import { parseToledo } from '../src/hardware/devices.js';
import { finishUpdate } from '../src/application/system.js';
import { storeDay } from '../src/domain/ids.js';
import { hmacSha256 } from '../src/security/crypto.js';
import type { Operator } from '../src/security/permissions.js';

let t: TestPdv;
let ana: Operator;
const key = () => randomUUID();

async function sell(code: string, method: 'cash' | 'pix' | 'debit' = 'cash', amount?: string) {
  const s = t.pdv.sales.start(ana);
  await t.pdv.sales.addItem(ana, s.id, { code });
  const v = t.pdv.sales.finalize(ana, s.id);
  let p = await t.pdv.sales.addPayment(ana, s.id, { method, amount: amount ?? v.sale.total, idempotencyKey: key() });
  if (method === 'pix') t.pix.pay(p.payments.at(-1)!.transaction_id!);
  if (method !== 'cash') p = await t.pdv.sales.pollPayment(ana, p.payments.at(-1)!.id);
  return t.pdv.sales.complete(ana, s.id);
}

beforeEach(async () => {
  t = await makePdv();
  ana = await login(t, 'ana');
});

describe('Caixa (seção 53): abertura, sangria, suprimento, fechamento, diferença', () => {
  it('abertura única por terminal; suprimento e sangria com supervisor; sangria não passa do dinheiro na gaveta', async () => {
    await t.pdv.cash.open(ana, '100.00');
    await expect(t.pdv.cash.open(ana, '50')).rejects.toMatchObject({ code: 'CASH_ALREADY_OPEN' });
    await expect(t.pdv.cash.supply(ana, '50', 'Troco extra')).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
    await t.pdv.cash.supply(ana, '50', 'Troco extra', SUP);
    await sell('CAMISETA');
    await expect(t.pdv.cash.withdraw(ana, '500', 'Excesso de dinheiro', null, SUP)).rejects.toThrow(/maior que o dinheiro na gaveta/);
    await t.pdv.cash.withdraw(ana, '120', 'Excesso de dinheiro', 'Envelope 12', SUP);
    const sum = t.pdv.cash.summary(t.pdv.cash.current()!.id);
    expect(sum.expected).toMatchObject({ cash: '79.90', total: '79.90' });
    expect(sum.expected.breakdown).toEqual({ opening: '100.00', supplies: '50.00', withdrawals: '120.00', cashSales: '49.90', cashRefunds: '0.00' });
    expect(t.pdv.audit.list({ action: 'SANGRIA' })[0]!.metadata).toMatchObject({ amount: '120.00', reason: 'Excesso de dinheiro', authorizedBy: OPS.sup.id });
    expect(t.pdv.queue.list().filter((q) => q.type === 'cash_movement')).toHaveLength(3);
  });

  it('fechamento com conferência por forma (diferença negativa registrada); reabertura pelo gerente; nada se apaga', async () => {
    await t.pdv.cash.open(ana, '100.00');
    await sell('CAMISETA');
    await sell('7891234567895', 'pix');
    await expect(t.pdv.cash.close(ana, { cash: '145.00', pix: '24.90' })).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
    const c = await t.pdv.cash.close(ana, { cash: '145.00', pix: '24.90', debit: '0', credit: '0' }, GER);
    expect(c.conference.map((x) => [x.group, x.expected, x.informed, x.difference, x.kind])).toEqual([
      ['cash', '149.90', '145.00', '-4.90', 'negative'], ['pix', '24.90', '24.90', '0.00', 'none'], ['debit', '0.00', '0.00', '0.00', 'none'], ['credit', '0.00', '0.00', '0.00', 'none']]);
    expect(t.pdv.cash.current()).toBeNull();
    expect(() => t.pdv.sales.start(ana)).toThrow(/Caixa fechado/);
    const closing = t.pdv.queue.list().find((q) => JSON.parse(q.payload).kind === 'closing')!;
    expect(JSON.parse(closing.payload)).toMatchObject({ counted: '145.00', details: { expectedCash: '149.90' } });
    const sessionId = c.summary.session.id;
    await expect(t.pdv.cash.reopen(ana, sessionId, 'Contagem refeita pelo gerente', SUP)).rejects.toThrow(/não tem permissão/);
    const s = await t.pdv.cash.reopen(ana, sessionId, 'Contagem refeita pelo gerente', GER);
    expect(s).toMatchObject({ status: 'open', reopen_count: 1 });
    const again = await t.pdv.cash.close(ana, { cash: '149.90', pix: '24.90' }, GER);
    expect(again.difference).toBe('0.00');
    expect(t.pdv.db.all(`SELECT kind FROM cash_movements WHERE session_id = ? ORDER BY created_at`, [sessionId]).map((m: any) => m.kind)).toEqual(['opening', 'closing', 'reopening', 'closing']);
  });
});

describe('Offline (seção 53): queda de internet, venda offline, reconexão, sincronização, duplicidade', () => {
  it('terminal reinstalado (banco local novo) continua a numeração de NFC-e e de venda do ERP, sem repetir', async () => {
    const day = storeDay(t.clock.now());
    t.erp.numbering = { nfce: [{ environment: 2, series: 3, lastNumber: 41 }], lastSaleIds: [`PDV-03-${day}-000007`] };
    await t.pdv.sync.pull();
    await t.pdv.cash.open(ana, '0');
    const done = await sell('CAFE-500');
    expect(done.sale.number).toBe(`PDV-03-${day}-000008`);
    expect(t.pdv.db.get<{ number: number }>(`SELECT number FROM fiscal_documents WHERE sale_id = ?`, [done.sale.id])!.number).toBe(42);
    // Nunca volta: uma carga antiga não rebaixa o contador
    t.erp.numbering = { nfce: [{ environment: 2, series: 3, lastNumber: 5 }], lastSaleIds: [] };
    await t.pdv.sync.pull();
    expect((await sell('CAFE-500')).sale.number).toBe(`PDV-03-${day}-000009`);
  });

  it('terminal ligado a outra loja/ERP: recarrega tudo, inativa produtos de lá e arquiva o que não pode ir', async () => {
    // Fica um produto e uma venda da loja anterior (ERP recriado, terminal movido)
    t.pdv.db.run(`INSERT INTO products (id, sku, description, kind, sale_unit, stock_unit, status, search, updated_at) VALUES ('old-cafe', 'CAFE-500', 'Café (ERP anterior)', 'goods', 'UN', 'UN', 'active', 'cafe', '2026-01-01')`);
    await t.pdv.cash.open(ana, '0');
    t.erp.online = false;
    const old = await sell('CAFE-500');
    t.erp.online = true;
    t.pdv.db.setMeta('erp.storeId', 'loja-anterior');
    const r = await t.pdv.sync.pull();
    expect(r).toMatchObject({ rebind: 1, removedProducts: 1 });
    expect(t.pdv.catalog.lookup('CAFE-500')!.product.id).not.toBe('old-cafe');
    expect(t.pdv.db.meta('erp.storeId')).toBe(t.pdv.config.erp.establishmentId);
    // A venda antiga sai da fila (arquivada com motivo) e não gera alerta eterno
    expect(t.pdv.queue.counts()).toMatchObject({ pendingSales: 0, FAILED: 0, archived: 2 });
    expect((await t.pdv.system.status()).alerts.join(' ')).not.toMatch(/não aceito/);
    expect(t.pdv.db.get<{ sync_status: string }>(`SELECT sync_status FROM sales WHERE id = ?`, [old.sale.id])!.sync_status).toBe('failed');
    expect(t.pdv.audit.list({ action: 'SYNC' }).find((e) => e.metadata.kind === 'troca_de_loja')!.metadata).toMatchObject({ from: 'loja-anterior', archived: 2 });
    // Produto inativo não entra na venda; o novo vende e chega ao ERP
    const s = t.pdv.sales.start(ana);
    await expect(t.pdv.sales.addItem(ana, s.id, { productId: 'old-cafe' })).rejects.toThrow(/inativo/);
    await t.pdv.sales.cancelSale(ana, s.id, 'Venda vazia aberta no teste', SUP).catch(() => undefined);
    const fresh = await sell('CAFE-500');
    await t.pdv.sync.runOnce();
    expect(t.erp.sales.get(fresh.sale.number)!.items[0].productId).not.toBe('old-cafe');
  });

  it('carga completa inativa produto que saiu do ERP; envio recusado pode ser arquivado e sai dos alertas', async () => {
    t.pdv.db.run(`INSERT INTO products (id, sku, description, kind, sale_unit, stock_unit, status, search, updated_at) VALUES ('gone', 'SUMIU', 'Produto excluído', 'goods', 'UN', 'UN', 'active', 'sumiu', '2026-01-01')`);
    const r = await t.pdv.sync.pull(true);
    expect(r).toMatchObject({ rebind: 0, removedProducts: 1 });
    expect(t.pdv.catalog.product('gone')!.status).toBe('inactive');
    await t.pdv.cash.open(ana, '0');
    const done = await sell('CAFE-500');
    t.erp.rejectSales = done.sale.number;
    await t.pdv.sync.runOnce();
    const failed = t.pdv.queue.list({ status: 'FAILED' }).find((i) => i.type === 'sale')!;
    expect((await t.pdv.system.status()).alerts.join(' ')).toMatch(/não aceito/);
    expect(t.pdv.queue.archive(failed.id, 'Teste: venda recusada pelo ERP', OPS.ger.id)).toBeTruthy();
    expect(t.pdv.queue.archive(failed.id, 'de novo', OPS.ger.id)).toBeUndefined();
    expect(t.pdv.queue.counts()).toMatchObject({ FAILED: 0, archived: 1, pendingSales: 0 });
    expect(t.pdv.queue.claim()).toHaveLength(0);
    expect(t.pdv.queue.list({ status: 'FAILED', archived: true })[0]!.archived_reason).toBe('Teste: venda recusada pelo ERP');
  });

  it('produto sem nenhuma entrada no ERP conta como sem estoque: avisa ao vender (política padrão)', async () => {
    t.erp.stock = t.erp.stock.filter((x) => x.product_id !== PRODUCT.cafe);
    await t.pdv.sync.pull(true);
    t.pdv.db.run(`DELETE FROM stock WHERE product_id = ?`, [PRODUCT.cafe]);
    expect(t.pdv.catalog.available(PRODUCT.cafe)).toBe('0');
    await t.pdv.cash.open(ana, '0');
    const s = t.pdv.sales.start(ana);
    const v = await t.pdv.sales.addItem(ana, s.id, { code: 'CAFE-500' });
    expect(v.warnings.join(' ')).toMatch(/sem estoque suficiente/);
  });

  it('ERP fora do ar: vende normalmente, fila guarda; ao reconectar envia na ordem e não duplica', async () => {
    await t.pdv.cash.open(ana, '50');
    t.erp.online = false;
    const cust = t.pdv.customers.create({ taxId: '153.509.460-56', name: 'João Offline' });
    const s = t.pdv.sales.start(ana);
    await t.pdv.sales.addItem(ana, s.id, { code: 'CAMISETA' });
    t.pdv.sales.setCustomer(ana, s.id, cust.id);
    t.pdv.sales.finalize(ana, s.id);
    await t.pdv.sales.addPayment(ana, s.id, { method: 'cash', amount: '49.90', idempotencyKey: key() });
    expect((await t.pdv.sales.complete(ana, s.id)).sale.status).toBe('completed');
    let r = await t.pdv.sync.runOnce();
    expect(r.online).toBe(false);
    expect(t.pdv.queue.counts()).toMatchObject({ pendingSales: 1 });
    expect((await t.pdv.system.status()).alerts[0]).toMatch(/ERP offline/);
    // Estoque local já desconta a venda não sincronizada
    expect(t.pdv.catalog.available(t.pdv.catalog.lookup('CAMISETA')!.product.id)).toBe('1');
    t.erp.online = true;
    t.clock.advance(120_000);
    r = await t.pdv.sync.runOnce();
    expect(r).toMatchObject({ online: true });
    expect(t.erp.customers).toHaveLength(1);
    // Consumidor do balcão vai com o endereço fiscal da loja (o ERP exige endereço no cadastro)
    expect(t.erp.customers[0]!.address).toMatchObject({ uf: 'PE', cityIbge: expect.any(String), zip: expect.any(String) });
    const sent = [...t.erp.sales.values()][0]!;
    expect(sent).toMatchObject({ saleId: s.number, saleUuid: s.id, pdvId: '03', customer: { taxId: '15350946056' }, nfce: { status: 'autorizada' } });
    expect(t.pdv.sales.row(s.id).sync_status).toBe('synced');
    // Reenvio (fila reprocessada, duplo envio) não cria segunda venda no ERP
    t.pdv.queue.enqueue('sale', 'sale', s.id, { saleId: s.id });
    await t.pdv.sync.push();
    await t.erp.postSale(t.pdv.sync.salePayload(s.id));
    expect(t.erp.sales.size).toBe(1);
    expect(t.erp.events.some((e) => e.action === 'VENDA')).toBe(true);
    expect(t.erp.heartbeats.at(-1)).toMatchObject({ appVersion: '1.0.0', pendingSales: 0 });
  });

  it('recusa do ERP vai para FAILED com o motivo sem travar o resto; venda offline além do limite do ERP é bloqueada', async () => {
    await t.pdv.cash.open(ana, '50');
    const a = await sell('CAMISETA');
    const b = await sell('7891234567895');
    t.erp.rejectSales = a.sale.number;
    const r = await t.pdv.sync.runOnce();
    expect(r.failed).toBe(1);
    expect(t.erp.sales.has(b.sale.number)).toBe(true);
    expect(t.pdv.queue.list({ status: 'FAILED' })[0]).toMatchObject({ entity_id: a.sale.id, last_error: expect.stringContaining('difere') });
    t.erp.online = false;
    t.clock.advance(25 * 3_600_000);
    await t.pdv.sync.runOnce();
    expect(() => t.pdv.sales.start(ana)).toThrow(/sem contato com o ERP há mais de 24 h/);
  });

  it('itens largados em PROCESSING (queda no meio do envio) voltam para a fila', async () => {
    await t.pdv.cash.open(ana, '0');
    await sell('CAMISETA');
    t.pdv.queue.claim();
    expect(t.pdv.queue.counts().PROCESSING).toBeGreaterThan(0);
    expect(t.pdv.queue.recoverProcessing()).toBeGreaterThan(0);
    expect(t.pdv.queue.counts().PROCESSING).toBe(0);
  });

  it('webhook do ERP com assinatura válida pede carga; assinatura errada ou antiga é recusada', async () => {
    const pdv = createPdv(loadConfig({ env: 'test', dbPath: ':memory:', webhookSecret: 'whsec_teste', erp: { url: 'http://x', apiKey: 'k', establishmentId: 'e', timeoutMs: 100 } }),
      { clock: t.clock, erp: t.erp });
    const body = JSON.stringify({ id: randomUUID(), type: 'preco.alterado', data: {} });
    const ts = Math.floor(t.clock.now().getTime() / 1000);
    expect(await pdv.sync.handleWebhook(`t=${ts},v1=${hmacSha256('whsec_teste', `${ts}.${body}`)}`, body)).toEqual({ accepted: true, event: 'price.updated' });
    expect((await pdv.sync.handleWebhook(`t=${ts},v1=${'0'.repeat(64)}`, body)).accepted).toBe(false);
    expect((await pdv.sync.handleWebhook(`t=${ts - 900},v1=${hmacSha256('whsec_teste', `${ts - 900}.${body}`)}`, body)).accepted).toBe(false);
    pdv.close();
  });
});

describe('Fiscal (seção 53): autorização, rejeição, cancelamento, indisponibilidade', () => {
  it('SEFAZ indisponível: NFC-e em contingência offline (tpEmis 9, QR offline), transmitida ao voltar', async () => {
    await t.pdv.cash.open(ana, '0');
    t.sefaz.online = false;
    const done = await sell('CAMISETA');
    const doc = t.pdv.fiscal.get(done.sale.id)!;
    expect(doc).toMatchObject({ status: 'contingency', emission_type: 9 });
    expect(parseAccessKey(doc.access_key).tpEmis).toBe('9');
    expect(doc.xml).toContain('<tpEmis>9</tpEmis>');
    expect(doc.xml).toContain('<xJust>');
    expect(doc.qr_url.split('|')).toHaveLength(8);
    expect(done.receipt).toContain('EMITIDA EM CONTINGÊNCIA');
    await t.pdv.sync.runOnce();
    expect(t.erp.sales.get(done.sale.number)!.nfce).toMatchObject({ status: 'contingencia', accessKey: doc.access_key });
    t.sefaz.online = true;
    await t.pdv.sync.runOnce();
    expect(t.pdv.fiscal.get(done.sale.id)!.status).toBe('authorized');
    expect(t.erp.authorizations).toEqual([expect.objectContaining({ saleId: done.sale.number, protocol: expect.any(String) })]);
  });

  it('rejeição: venda fica registrada, não vai ao ERP; corrigido o cadastro, o reprocessamento autoriza com o mesmo número', async () => {
    await t.pdv.cash.open(ana, '0');
    // NCM inexistente no cadastro: a SEFAZ rejeita (778)
    t.pdv.db.run(`UPDATE products SET ncm = '99999999' WHERE sku = 'CAMISETA'`);
    const done = await sell('CAMISETA');
    expect(done.sale.fiscal_status).toBe('rejected');
    expect(done.fiscal).toMatchObject({ status: 'rejected', rejection: { code: '778' } });
    expect(t.pdv.queue.list().some((q) => q.type === 'sale')).toBe(false);
    expect(t.pdv.audit.list({ action: 'ERRO_FISCAL' })).toHaveLength(1);
    expect((await t.pdv.system.status()).alerts).toContain('1 NFC-e rejeitada(s): reprocessar');
    // ERP corrige o NCM e a carga traz o produto atualizado
    t.pdv.db.run(`UPDATE products SET ncm = '61091000' WHERE sku = 'CAMISETA'`);
    const number = t.pdv.fiscal.get(done.sale.id)!.number;
    const v = await t.pdv.sales.reprocessFiscal(ana, done.sale.id);
    expect(v.fiscal).toMatchObject({ status: 'authorized', number });
    expect(t.pdv.queue.list().some((q) => q.type === 'sale' && q.entity_id === done.sale.id)).toBe(true);
  });

  it('cancelamento de venda concluída: supervisor, NFC-e cancelada na SEFAZ, estorno do Pix, ERP avisado; fora do prazo vira devolução', async () => {
    await t.pdv.cash.open(ana, '0');
    const done = await sell('CAMISETA', 'pix');
    await expect(t.pdv.sales.cancelSale(ana, done.sale.id, 'Cliente desistiu da compra')).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
    const v = await t.pdv.sales.cancelSale(ana, done.sale.id, 'Cliente desistiu da compra', SUP);
    expect(v.sale.status).toBe('cancelled');
    expect(v.payments[0]!.status).toBe('refunded');
    expect(t.pdv.fiscal.get(done.sale.id)).toMatchObject({ status: 'cancelled', cancel_protocol: expect.any(String) });
    await t.pdv.sync.runOnce();
    expect(t.erp.sales.has(done.sale.number)).toBe(true);
    expect(t.erp.cancels[0]).toMatchObject({ saleId: done.sale.number, reason: 'Cliente desistiu da compra', protocol: expect.any(String) });
    const late = await sell('7891234567895');
    t.clock.advance(31 * 60_000);
    await expect(t.pdv.sales.cancelSale(ana, late.sale.id, 'Cliente desistiu da compra', SUP)).rejects.toMatchObject({ code: 'CANCEL_WINDOW_EXPIRED' });
  });

  it('devolução: itens limitados ao vendido, motivo, autorização, reembolso em dinheiro e envio ao ERP', async () => {
    await t.pdv.cash.open(ana, '100');
    const done = await sell('2*CAMISETA');
    const info = await t.pdv.returns.returnable(done.sale.number, true);
    expect(info.items[0]).toMatchObject({ itemNumber: 1, quantity: '2', returned: '0' });
    const input = { saleNumber: done.sale.number, items: [{ itemNumber: 1, quantity: '1' }], reason: 'Tamanho errado', refundMethod: 'cash' as const,
      customer: { taxId: '529.982.247-25', name: 'Maria das Graças' }, reference: `DEV-${randomUUID().slice(0, 8)}` };
    await expect(t.pdv.returns.create(ana, input, true)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
    const r = await t.pdv.returns.create(ana, input, true, SUP) as any;
    expect(r.total).toBe('49.90');
    await expect(t.pdv.returns.create(ana, { ...input, reference: 'DEV-2', items: [{ itemNumber: 1, quantity: '2' }] }, true, SUP)).rejects.toThrow(/maior que a vendida/);
    // 100 de abertura + 99,80 da venda − 49,90 devolvidos
    expect(t.pdv.cash.summary(t.pdv.cash.current()!.id).expected.cash).toBe('149.90');
    await t.pdv.sync.runOnce();
    expect(t.erp.returns[0]).toMatchObject({ saleId: done.sale.number, refundMethod: 'cash', items: [{ itemNumber: 1, quantity: '1' }] });
  });
});

describe('Recuperação, hardware, segurança e auditoria', () => {
  it('queda de energia no meio da venda: ao voltar detecta a venda e continua; NFC-e pendente é consultada antes de reenviar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdv-'));
    const cfg = loadConfig({ env: 'test', dbPath: join(dir, 'pdv.sqlite'), terminalCode: '03', erp: { url: 'http://x', apiKey: 'k', establishmentId: 'e', timeoutMs: 100 } });
    const a = createPdv(cfg, { clock: t.clock, erp: t.erp, fiscalProvider: t.sefaz, pix: t.pix, tef: t.tef, printer: t.printer, scale: t.scale });
    await a.sync.runOnce({ full: true });
    const op = (await a.auth.login('ana', OPS.ana.pin)).operator;
    await a.cash.open(op, '0');
    const s = a.sales.start(op);
    await a.sales.addItem(op, s.id, { code: 'CAMISETA' });
    a.sales.finalize(op, s.id);
    await a.sales.addPayment(op, s.id, { method: 'cash', amount: '49.90', idempotencyKey: key() });
    // Simula envio à SEFAZ sem resposta: documento gravado como pendente, depois o terminal "cai"
    t.sefaz.online = false;
    const fiscalEmit = a.fiscal.emit.bind(a.fiscal);
    await expect((async () => { (a.fiscal as any).d.settings = () => ({ ...a.settings(), fiscal: { contingencyAllowed: false } }); return fiscalEmit((a.sales as any).forFiscal(a.sales.row(s.id)), op.id); })())
      .rejects.toMatchObject({ code: 'FISCAL_UNAVAILABLE' });
    a.db.close();
    t.sefaz.online = true;
    const b = createPdv(cfg, { clock: t.clock, erp: t.erp, fiscalProvider: t.sefaz, pix: t.pix, tef: t.tef, printer: t.printer, scale: t.scale });
    const recovered = b.sales.inProgress()!;
    expect(recovered.id).toBe(s.id);
    expect(b.fiscal.get(s.id)!.status).toBe('pending');
    const done = await b.sales.complete(op, s.id);
    expect(done.sale.status).toBe('completed');
    expect(b.fiscal.get(s.id)!.number).toBe(1);
    expect(b.db.get<{ n: number }>(`SELECT count(*) AS n FROM fiscal_documents`)!.n).toBe(1);
    b.close();
  });

  it('impressora sem papel não perde a venda (reimpressão auditada); gaveta abre no dinheiro, na sangria e no suprimento; balança Toledo', async () => {
    await t.pdv.cash.open(ana, '0');
    t.printer.simulated = 'paper_out';
    const done = await sell('CAMISETA');
    expect(done.sale.status).toBe('completed');
    expect(done.printError).toMatch(/impressão falhou/);
    t.printer.simulated = 'ok';
    await expect(t.pdv.sales.reprint(ana, done.sale.id)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
    const r = await t.pdv.sales.reprint(ana, done.sale.id, SUP);
    expect(r.text).toContain('REIMPRESSÃO');
    expect(t.pdv.audit.list({ action: 'REIMPRESSAO' })).toHaveLength(1);
    const { escpos } = t.pdv.printer.render(t.pdv.sales.receiptData(done.sale.id, 'Ana'));
    expect(escpos.includes(Buffer.from([0x1d, 0x28, 0x6b]))).toBe(true);
    const kick = Buffer.from([0x1b, 0x70, 0x00]);
    await sell('CAMISETA');
    expect(t.printer.jobs.at(-1)!.includes(kick)).toBe(true);
    const jobs = t.printer.jobs.length;
    await t.pdv.cash.supply(ana, '50', 'Troco', SUP);
    await t.pdv.cash.withdraw(ana, '20', 'Depósito', null, SUP);
    expect(t.printer.jobs.slice(jobs).map((j) => j.includes(kick))).toEqual([true, true]);
    expect(parseToledo('\x0201250\x03')).toEqual({ weight: '1.250', stable: true });
    expect(parseToledo('\x02IIIII\x03').stable).toBe(false);
    expect(() => parseToledo('\x02SSSSS\x03')).toThrow(/sobrecarga/);
  });

  it('login por PIN com bloqueio após 5 erros; sessão expira por inatividade; operador sem permissão de painel', async () => {
    for (let i = 0; i < 5; i++) await expect(t.pdv.auth.login('sup', '000000')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(t.pdv.auth.login('sup', OPS.sup.pin)).rejects.toMatchObject({ code: 'LOCKED' });
    t.clock.advance(6 * 60_000);
    const s = await t.pdv.auth.login('sup', OPS.sup.pin);
    expect(t.pdv.auth.resolve(s.token).login).toBe('sup');
    t.clock.advance(16 * 60_000);
    expect(() => t.pdv.auth.resolve(s.token)).toThrow(/Sessão expirada/);
    await expect(t.pdv.system.dashboard(ana)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(t.pdv.audit.list({ action: 'LOGIN_FALHOU' })).toHaveLength(5);
  });

  it('auditoria tem os campos da seção 39 e não pode ser alterada nem apagada; atualização espera a venda terminar', async () => {
    await t.pdv.cash.open(ana, '0');
    const e = t.pdv.audit.list({ action: 'ABERTURA_CAIXA' })[0]!;
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['user_id', 'terminal_id', 'action', 'entity', 'entity_id', 'metadata', 'timestamp']));
    expect(() => t.pdv.db.run(`UPDATE events SET action = 'LOGIN'`)).toThrow(/não pode ser alterada/);
    expect(() => t.pdv.db.run(`DELETE FROM events`)).toThrow(/não pode ser apagada/);
    const s = t.pdv.sales.start(ana);
    await t.pdv.sales.addItem(ana, s.id, { code: 'CAMISETA' });
    expect(t.pdv.system.requestUpdate('1.1.0')).toMatchObject({ requested: '1.1.0', safe: false, reason: expect.stringContaining('em andamento') });
    await t.pdv.sales.cancelSale(ana, s.id, 'Cliente desistiu da compra');
    expect(t.pdv.system.updateState()).toMatchObject({ safe: true });
    expect(() => t.pdv.system.assertNoUpdateLock()).toThrow(/Atualização para a versão 1.1.0/);
    // O agente sobe com a versão nova e o caixa volta a vender
    expect(finishUpdate(t.pdv.db, '1.1.0')).toEqual({ requested: '1.1.0', applied: true });
    expect(() => t.pdv.system.assertNoUpdateLock()).not.toThrow();
    expect(finishUpdate(t.pdv.db, '1.1.0')).toBeNull();
  });

  it('painel operacional do gerente: vendas, ticket médio, caixa aberto e pendências', async () => {
    await t.pdv.cash.open(ana, '0');
    await sell('CAMISETA');
    await sell('7891234567895');
    const ger = await login(t, 'ger');
    const d = await t.pdv.system.dashboard(ger);
    expect(d.terminal).toMatchObject({ salesCount: 2, salesTotal: '74.80', averageTicket: '37.40', pendingSync: 2 });
    expect(d.terminal.openCash).toHaveLength(1);
  });
});
