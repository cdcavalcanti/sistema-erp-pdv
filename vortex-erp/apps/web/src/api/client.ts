/**
 * Cliente da API VORTEX: token de sessão, empresa ativa (X-Company-Id), Idempotency-Key em toda
 * escrita (RN-GER-07: clique duplo não duplica pedido nem título) e erros no formato da API.
 */
const BASE = import.meta.env.VITE_API_URL ?? '';
const TOKEN_KEY = 'vx.token';
const COMPANY_KEY = 'vx.company';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
  requestId?: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: ApiErrorBody) {
    super(body.message);
  }
  get code() {
    return this.body.code;
  }
  /** Erros de campo ("addresses.0.zip": "CEP com 8 dígitos") para exibir junto do formulário. */
  get fieldErrors(): Record<string, string> {
    const d = this.body.details;
    if (!d || typeof d !== 'object') return {};
    const fields = ((d as { fields?: unknown }).fields ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(fields).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k.replace(/^(body|query|params)\./, ''), v as string]));
  }
}

// Sessão: sessionStorage (some ao fechar o navegador; o token expira em 8 h na API)
const store = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch {
      /* armazenamento indisponível: a sessão fica só em memória */
    }
  },
};
let memToken: string | null = store.get(TOKEN_KEY);
let memCompany: string | null = store.get(COMPANY_KEY);
const listeners = new Set<() => void>();

export const session = {
  get token() {
    return memToken;
  },
  get companyId() {
    return memCompany;
  },
  setToken(t: string | null) {
    memToken = t;
    store.set(TOKEN_KEY, t);
    listeners.forEach((l) => l());
  },
  setCompany(id: string | null) {
    memCompany = id;
    store.set(COMPANY_KEY, id);
    listeners.forEach((l) => l());
  },
  onChange(l: () => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export type Query = Record<string, string | number | boolean | null | undefined>;

function url(path: string, query?: Query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return `${BASE}${path}${s ? `?${s}` : ''}`;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(memToken ? { authorization: `Bearer ${memToken}` } : {}),
    ...(memCompany ? { 'x-company-id': memCompany } : {}),
    ...extra,
  };
}

export function newIdempotencyKey() {
  return crypto.randomUUID();
}

export async function request<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
  const mutating = method !== 'GET';
  const h = headers({
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(mutating ? { 'idempotency-key': opts.idempotencyKey ?? newIdempotencyKey() } : {}),
  });
  const res = await fetch(url(path, opts.query), { method, headers: h, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: opts.signal });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const body = (data && typeof data === 'object' ? data : { code: 'HTTP_' + res.status, message: String(data || res.statusText) }) as ApiErrorBody;
    if (res.status === 401 && memToken && !path.startsWith('/v1/auth/')) session.setToken(null);
    throw new ApiError(res.status, body);
  }
  return data as T;
}

export const api = {
  get: <T = unknown>(path: string, query?: Query, signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T = unknown>(path: string, body?: unknown, opts: { idempotencyKey?: string } = {}) => request<T>('POST', path, { body: body ?? {}, ...opts }),
  put: <T = unknown>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T = unknown>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  del: <T = unknown>(path: string, body?: unknown) => request<T>('DELETE', path, { body }),
};

/** Baixa um arquivo autenticado (DANFE, XML, exportações) e entrega ao navegador. */
export async function download(path: string, query?: Query, fallbackName = 'arquivo') {
  const res = await fetch(url(path, query), { headers: headers() });
  if (!res.ok) {
    let body: ApiErrorBody = { code: `HTTP_${res.status}`, message: res.statusText };
    try {
      body = await res.json();
    } catch {
      /* corpo não JSON */
    }
    throw new ApiError(res.status, body);
  }
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Baixa o resultado de um POST (ex.: relatório exportado em Excel/PDF/CSV). */
export async function downloadPost(path: string, body: unknown, fallbackName = 'arquivo') {
  const res = await fetch(url(path), { method: 'POST', headers: headers({ 'content-type': 'application/json', 'idempotency-key': newIdempotencyKey() }), body: JSON.stringify(body) });
  if (!res.ok) {
    let b: ApiErrorBody = { code: `HTTP_${res.status}`, message: res.statusText };
    try {
      b = await res.json();
    } catch {
      /* corpo não JSON */
    }
    throw new ApiError(res.status, b);
  }
  const name = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Abre um documento autenticado (ex.: DANFE em HTML) em nova aba. */
export async function openAuthed(path: string) {
  const win = window.open('', '_blank');
  const res = await fetch(url(path), { headers: headers() });
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  if (win) win.location.href = href;
  else window.location.href = href;
}

/** Salva texto gerado pela API (ex.: arquivo SPED devolvido em JSON) como arquivo. */
export function saveText(content: string, name: string, type = 'text/plain;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
