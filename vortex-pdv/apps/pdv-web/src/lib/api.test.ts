import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, session } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  session.set(null);
});

describe('cliente da API local', () => {
  it('envia o token, traduz erros e encerra a sessão em 401', async () => {
    session.set('tok');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'SESSION_EXPIRED', message: 'Sessão expirada' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('GET', '/api/session')).rejects.toMatchObject({ code: 'SESSION_EXPIRED', status: 401 });
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: 'Bearer tok' });
    expect(session.token).toBeNull();
  });

  it('agente fora do ar vira erro claro', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const e = await api('GET', '/api/status').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('AGENT_OFFLINE');
  });
});
