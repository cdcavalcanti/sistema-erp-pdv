import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/main.js';
import { loadConfig } from '../src/config.js';
import { DisabledAiModel } from '../src/modules/ai/model.js';
import { SimulatedFiscalGateway } from '../src/modules/fiscal-docs/gateway.js';

const SRC = join(import.meta.dirname, '..', 'src');
const ENV_EXAMPLE = readFileSync(join(import.meta.dirname, '..', '..', '..', '.env.example'), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Configuração e subida (seção 25)', () => {
  it('toda variável de ambiente lida pela API está documentada no .env.example', () => {
    const used = new Set<string>();
    for (const f of files(SRC)) {
      const code = readFileSync(f, 'utf8');
      for (const m of code.matchAll(/process\.env\.([A-Z0-9_]+)|process\.env\[['"]([A-Z0-9_]+)['"]\]|\breq\(\s*(?:isTest \? )?['"]([A-Z0-9_]+)['"](?:\s*:\s*['"]([A-Z0-9_]+)['"])?/g)) {
        for (const name of m.slice(1)) if (name) used.add(name);
      }
      // Nomes lidos de forma dinâmica (process.env[nome]) aparecem como literais no mesmo arquivo
      if (/process\.env\[[a-z]/.test(code)) for (const m of code.matchAll(/['"]([A-Z][A-Z0-9]*_(?:URL|KEY|TOKEN|SECRET))['"]/g)) used.add(m[1]!);
    }
    const documented = new Set([...ENV_EXAMPLE.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((v) => !documented.has(v))).toEqual([]);
  });

  it('produção exige segredos fortes', () => {
    const base = { env: 'production' as const, jwtSecret: 'x'.repeat(40), provisioningKey: 'k'.repeat(40) };
    expect(() => loadConfig(base)).not.toThrow();
    expect(() => loadConfig({ ...base, jwtSecret: 'curto' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...base, provisioningKey: '' })).toThrow(/PROVISIONING_KEY/);
  });

  it('sobe sem rede: gateways simulados, IA desligada, /health responde', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('rede bloqueada no teste')));
    vi.stubGlobal('fetch', fetchSpy);
    const app = await createApp();
    try {
      expect(app.deps.services.fiscalGateway).toBeInstanceOf(SimulatedFiscalGateway);
      expect(app.deps.services.ai).toBeInstanceOf(DisabledAiModel);
      const r = await app.inject({ method: 'GET', url: '/health' });
      expect(r.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('em produção o provisionamento de tenant exige a chave do console', async () => {
    const provisioningKey = randomUUID() + randomUUID();
    const app = await createApp({ config: { env: 'production', jwtSecret: 'p'.repeat(40), provisioningKey } });
    try {
      const slug = `prov-${randomUUID().slice(0, 8)}`;
      const payload = { tenant: { name: 'Provisionado', slug }, admin: { name: 'Admin', email: `a@${slug}.test`, password: 'senha-forte-123' } };
      const call = (key?: string) => app.inject({ method: 'POST', url: '/v1/onboarding', payload, headers: key === undefined ? {} : { 'x-provisioning-key': key } });
      expect((await call()).statusCode).toBe(403);
      expect((await call('errada')).statusCode).toBe(403);
      expect((await call(provisioningKey)).statusCode).toBe(201);
    } finally {
      await app.close();
    }
  });

  it('observabilidade: /metrics expõe requisições, erros, filas e emissão fiscal; fechado em produção sem token', async () => {
    const app = await createApp({ config: { metricsToken: '' } });
    try {
      await app.inject({ method: 'GET', url: '/health' });
      await app.inject({ method: 'GET', url: '/v1/products' });
      const r = await app.inject({ method: 'GET', url: '/metrics' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/plain/);
      expect(r.body).toContain('vortex_http_requests_total{method="GET",route="/health",status="2xx"} 1');
      expect(r.body).toContain('vortex_http_errors_total{code="UNAUTHENTICATED"} 1');
      expect(r.body).toMatch(/vortex_http_request_duration_seconds_count\{route="\/health"\} 1/);
      expect(r.body).toMatch(/vortex_tenants_active \d+/);
      expect(r.body).toMatch(/vortex_outbox_pending \d+/);
    } finally {
      await app.close();
    }
    const prod = await createApp({ config: { env: 'production', jwtSecret: 'p'.repeat(40), provisioningKey: 'k'.repeat(40), metricsToken: 'm'.repeat(40) } });
    try {
      expect((await prod.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
      expect((await prod.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${'m'.repeat(40)}` } })).statusCode).toBe(200);
    } finally {
      await prod.close();
    }
  });
});
