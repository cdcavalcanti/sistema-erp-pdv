import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.js';
import { makePdv, OPS, type TestPdv } from './helpers.js';

let t: TestPdv;
let app: FastifyInstance;
let token: string;
const call = async (method: string, url: string, body?: unknown, tk: string | null = token) => {
  const r = await app.inject({ method: method as 'POST', url, payload: body as object, headers: tk ? { authorization: `Bearer ${tk}` } : {} });
  return { status: r.statusCode, body: r.json() };
};

beforeEach(async () => {
  t = await makePdv();
  app = await buildServer(t.pdv);
  token = (await call('POST', '/api/auth/login', { login: 'ana', pin: OPS.ana.pin }, null)).body.token;
});
afterEach(async () => app.close());

describe('API local do agente', () => {
  it('fluxo pela API: abertura, leitura, finalização, dinheiro, conclusão com NFC-e', async () => {
    expect((await call('GET', '/api/session', undefined, null)).status).toBe(401);
    expect((await call('POST', '/api/cash/open', { amount: '100,00' })).status).toBe(200);
    const sale = (await call('POST', '/api/sales')).body;
    expect((await call('POST', `/api/sales/${sale.sale.id}/items`, { code: '2*7891234567895' })).body.sale.total).toBe('49.80');
    expect((await call('POST', `/api/sales/${sale.sale.id}/finalize`)).body.sale.status).toBe('payment');
    const paid = await call('POST', `/api/sales/${sale.sale.id}/payments`, { method: 'cash', amount: '50', idempotencyKey: randomUUID() });
    expect(paid.body.payments[0].change).toBe('0.20');
    const done = await call('POST', `/api/sales/${sale.sale.id}/complete`);
    expect(done.body).toMatchObject({ sale: { status: 'completed' }, fiscal: { status: 'authorized' } });
    const receipt = await call('GET', `/api/sales/${sale.sale.id}/receipt`);
    expect(receipt.body.text).toContain('VALOR A PAGAR R$');
    expect((await call('GET', '/api/session')).body.sale).toBeNull();
  });

  it('erros: validação em português, autorização pedida com a permissão, produto não encontrado; status sem login', async () => {
    const v = await call('POST', '/api/cash/open', { amount: 'abc' });
    expect(v).toMatchObject({ status: 422, body: { code: 'VALIDATION', message: 'Valor inválido' } });
    await call('POST', '/api/cash/open', { amount: '10' });
    const auth = await call('POST', '/api/cash/supply', { amount: '10', reason: 'Troco' });
    expect(auth).toMatchObject({ status: 403, body: { code: 'AUTHORIZATION_REQUIRED', details: { permission: 'pdv.caixa.suprimento' } } });
    expect((await call('POST', '/api/cash/supply', { amount: '10', reason: 'Troco', authorization: { login: 'sup', pin: OPS.sup.pin } })).status).toBe(200);
    expect((await call('GET', '/api/products/lookup?code=000')).status).toBe(404);
    const st = await call('GET', '/api/status', undefined, null);
    expect(st.body.services.erp.status).toBe('online');
    const term = await call('GET', '/api/terminal', undefined, null);
    expect(term.body).toMatchObject({ terminal: '03', paired: true, simulators: expect.arrayContaining(['Pix (PSP simulado)', 'SEFAZ (homologação simulada)']) });
    expect((await call('POST', '/api/auth/login', { login: 'ana', pin: '000000' }, null)).status).toBe(401);
  });

  it('simulador de Pix de homologação: o pagamento só aprova quando o "pagador" paga', async () => {
    await call('POST', '/api/cash/open', { amount: '0' });
    const sale = (await call('POST', '/api/sales')).body;
    await call('POST', `/api/sales/${sale.sale.id}/items`, { code: 'CAMISETA' });
    await call('POST', `/api/sales/${sale.sale.id}/finalize`);
    const p = (await call('POST', `/api/sales/${sale.sale.id}/payments`, { method: 'pix', amount: '49.90', idempotencyKey: randomUUID() })).body.payments[0];
    expect((await call('POST', `/api/payments/${p.id}/poll`)).body.payments[0].status).toBe('pending');
    expect((await call('POST', `/api/dev/pix/${p.transaction_id}/pay`)).body.paid).toBe(true);
    expect((await call('POST', `/api/payments/${p.id}/poll`)).body.payments[0].status).toBe('approved');
  });
});
