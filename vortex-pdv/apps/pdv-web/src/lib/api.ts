/**
 * Cliente da API local do agente do terminal (127.0.0.1). A interface não fala com o ERP nem
 * com provedores: toda integração passa pelo agente (seção 57: "integrações diretamente na UI" não).
 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, any> = {}) {
    super(message);
  }
  get needsAuthorization(): boolean {
    return this.code === 'AUTHORIZATION_REQUIRED';
  }
}

const KEY = 'vortex-pdv-token';
let token: string | null = null;
try {
  token = sessionStorage.getItem(KEY);
} catch {
  token = null;
}
const listeners = new Set<() => void>();

export const session = {
  get token() {
    return token;
  },
  set(t: string | null) {
    token = t;
    try {
      if (t) sessionStorage.setItem(KEY, t);
      else sessionStorage.removeItem(KEY);
    } catch {
      /* armazenamento indisponível: fica só em memória */
    }
    listeners.forEach((l) => l());
  },
  onChange(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'AGENT_OFFLINE', 'Agente do PDV não responde: verifique se o serviço está em execução');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && token && path !== '/api/auth/login') session.set(null);
    throw new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? `Erro ${res.status}`, data?.details ?? {});
  }
  return data as T;
}

export const newKey = () => crypto.randomUUID();
