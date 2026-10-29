import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, session } from './client';

const calls: { url: string; init: RequestInit }[] = [];
function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
}

describe('cliente da API', () => {
  beforeEach(() => {
    calls.length = 0;
    session.setToken('tok-1');
    session.setCompany('c-1');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('envia token, empresa e Idempotency-Key em toda escrita; GET sem chave', async () => {
    mockFetch(200, { ok: true });
    await api.post('/v1/sales/orders', { a: 1 });
    await api.get('/v1/products', { q: 'café', limit: 10, vazio: '' });
    const h0 = calls[0]!.init.headers as Record<string, string>;
    expect(h0.authorization).toBe('Bearer tok-1');
    expect(h0['x-company-id']).toBe('c-1');
    expect(h0['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect((calls[1]!.init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
    expect(calls[1]!.url).toBe('/v1/products?q=caf%C3%A9&limit=10');
  });

  it('erro de validação vira ApiError com campos sem o prefixo "body."', async () => {
    mockFetch(422, { code: 'VALIDATION', message: 'Dados inválidos', details: { fields: { 'body.legalName': 'Obrigatório', 'addresses.0.zip': 'CEP com 8 dígitos' } } });
    const e = (await api.post('/v1/parties', {}).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('VALIDATION');
    expect(e.fieldErrors).toEqual({ legalName: 'Obrigatório', 'addresses.0.zip': 'CEP com 8 dígitos' });
  });

  it('401 fora do login encerra a sessão', async () => {
    mockFetch(401, { code: 'UNAUTHORIZED', message: 'Sessão expirada' });
    await api.get('/v1/me').catch(() => null);
    expect(session.token).toBeNull();
  });
});
