import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { NoScale, TcpToledoScale } from '../src/hardware/devices.js';
import { DisabledTef } from '../src/payment/providers.js';

const SRC = join(import.meta.dirname, '..', 'src');
const ENV_EXAMPLE = readFileSync(join(import.meta.dirname, '..', '.env.example'), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('Configuração do agente (seção 57: variáveis de ambiente)', () => {
  it('toda variável lida pelo agente está no .env.example', () => {
    const used = new Set<string>();
    for (const f of files(SRC)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)|required\('([A-Z0-9_]+)'/g)) used.add((m[1] ?? m[2])!);
    }
    const documented = new Set([...ENV_EXAMPLE.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(25);
    expect([...used].filter((v) => !documented.has(v))).toEqual([]);
  });

  it('produção exige chave de cifra, estabelecimento e CSC, e recusa simuladores com emissão real', () => {
    const prod = { NODE_ENV: 'production', PDV_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'), PDV_ERP_URL: 'https://erp.example', PDV_STORE_ID: 'loja', PDV_NFCE_CSC: 'csc' };
    const load = (env: Record<string, string>) => {
      vi.unstubAllEnvs();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      return loadConfig();
    };
    expect(() => load(prod)).not.toThrow();
    expect(() => load({ ...prod, PDV_SECRET_KEY: '' })).toThrow(/PDV_SECRET_KEY/);
    expect(() => load({ ...prod, PDV_STORE_ID: '' })).toThrow(/PDV_STORE_ID/);
    expect(() => load({ ...prod, PDV_NFCE_CSC: '' })).toThrow(/PDV_NFCE_CSC/);
    const real = { ...prod, PDV_SEFAZ_AMBIENTE: '1', PDV_FISCAL_PROVIDER: 'partner', PDV_PIX_PROVIDER: 'psp', PDV_TEF_PROVIDER: 'none' };
    expect(() => load(real)).not.toThrow();
    expect(() => load({ ...real, PDV_FISCAL_PROVIDER: 'simulated' })).toThrow(/provedor fiscal real/);
    expect(() => load({ ...real, PDV_PIX_PROVIDER: 'simulated' })).toThrow(/Pix simulado/);
    expect(() => load({ ...real, PDV_TEF_PROVIDER: 'simulated' })).toThrow(/TEF simulado/);
  });
});

describe('Periféricos e TEF reais/desligados', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function toledo(reply: string) {
    server = createServer((s) => s.on('data', (d) => d[0] === 0x05 && s.write(Buffer.from(reply, 'latin1'))));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return (server.address() as { port: number }).port;
  }

  it('balança Toledo por TCP: ENQ → STX peso ETX', async () => {
    const scale = new TcpToledoScale('127.0.0.1', await toledo('\x0201234\x03'));
    await expect(scale.read()).resolves.toEqual({ weight: '1.234', stable: true });
    await expect(scale.status()).resolves.toBe('ok');
  });

  it('balança instável, desligada e ausente', async () => {
    await expect(new TcpToledoScale('127.0.0.1', await toledo('\x02IIIII\x03')).read()).resolves.toEqual({ weight: '0', stable: false });
    const off = new TcpToledoScale('127.0.0.1', 1, 300);
    await expect(off.read()).rejects.toThrow(/balança inacessível/);
    await expect(off.status()).resolves.toBe('offline');
    await expect(new NoScale().read()).rejects.toThrow(/não há balança/);
  });

  it('TEF desligado recusa e orienta a usar a maquininha', async () => {
    const r = await new DisabledTef().start();
    expect(r).toMatchObject({ status: 'declined', message: expect.stringMatching(/maquininha/) });
  });
});
