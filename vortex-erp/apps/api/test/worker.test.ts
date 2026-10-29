import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { App } from '../src/http/app.js';
import { hmacSha256 } from '../src/core/crypto.js';
import { emit } from '../src/core/outbox.js';
import { enqueue } from '../src/core/jobs.js';
import { systemContext, withTenant } from '../src/db/tx.js';
import { registerTenantJob } from '../src/worker/registry.js';
import { drain } from '../src/worker/runner.js';
import { getWorkerDeps, makeApp, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let server: Server;
const received: { headers: Record<string, unknown>; body: string }[] = [];
let failNext = 0;

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failNext > 0) {
        failNext--;
        res.statusCode = 500;
        return res.end();
      }
      received.push({ headers: req.headers, body });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});
afterAll(async () => {
  server.close();
  await app.close();
});

describe('RN-GER-08 outbox e webhooks', () => {
  it('evento gravado na transação é entregue com assinatura HMAC; falha é reenviada', async () => {
    const port = (server.address() as AddressInfo).port;
    const wh = await t.admin.post('/v1/webhooks', { url: `http://127.0.0.1:${port}/hook`, events: ['pedido.criado'] });
    expect(wh.status).toBe(201);
    await withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), (tx) => emit(tx, 'pedido.criado', { type: 'sales_order', id: null }, { numero: 1 }));
    const deps = getWorkerDeps(app);
    failNext = 1;
    await deps.workerPool.query(`INSERT INTO integration.jobs (name, queue) VALUES ('outbox.dispatch','system'), ('webhooks.deliver','system')`);
    await drain(deps);
    expect(received).toHaveLength(0); // primeira tentativa falhou (HTTP 500)
    await deps.workerPool.query(`UPDATE integration.webhook_deliveries SET next_attempt_at = now() WHERE webhook_id = $1`, [wh.body.id]);
    await deps.workerPool.query(`INSERT INTO integration.jobs (name, queue) VALUES ('webhooks.deliver','system')`);
    await drain(deps);
    expect(received).toHaveLength(1);
    const sig = String(received[0]!.headers['x-vortex-signature']);
    const [, ts, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(sig)!;
    expect(hmacSha256(wh.body.secret, `${ts}.${received[0]!.body}`)).toBe(v1);
    expect(JSON.parse(received[0]!.body).type).toBe('pedido.criado');
    const deliveries = await t.admin.get(`/v1/webhooks/${wh.body.id}/deliveries`);
    expect(deliveries.body[0].status).toBe('delivered');
    expect(deliveries.body[0].attempts).toBe(2);
  });

  it('job de tenant roda com RLS do tenant e reenvia com backoff ao falhar', async () => {
    let calls = 0;
    registerTenantJob('teste.falha_uma_vez', async (tx) => {
      calls++;
      const { n } = await tx.one(`SELECT count(*)::int AS n FROM core.companies`);
      if (calls === 1) throw new Error('falha transitória');
      return { companies: n };
    });
    await withTenant(app.deps.pool, systemContext(t.tenantId), (tx) => enqueue(tx, 'teste.falha_uma_vez', {}));
    const deps = getWorkerDeps(app);
    await drain(deps);
    const r1 = await deps.workerPool.query(`SELECT status, attempts, last_error FROM integration.jobs WHERE name = 'teste.falha_uma_vez'`);
    expect(r1.rows[0].status).toBe('failed');
    await deps.workerPool.query(`UPDATE integration.jobs SET run_at = now() WHERE name = 'teste.falha_uma_vez'`);
    await drain(deps);
    const r2 = await deps.workerPool.query(`SELECT status, result FROM integration.jobs WHERE name = 'teste.falha_uma_vez'`);
    expect(r2.rows[0].status).toBe('done');
    expect(r2.rows[0].result).toEqual({ companies: 1 });
  });
});
