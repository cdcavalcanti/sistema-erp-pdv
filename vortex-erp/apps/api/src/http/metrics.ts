import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../core/crypto.js';
import type { Deps } from './app.js';

/**
 * Métricas no formato texto do Prometheus (seção 24, observabilidade): requisições e
 * latência por rota, erros por código, filas, outbox e emissão fiscal.
 * Em produção só responde com METRICS_TOKEN configurado e enviado como Bearer.
 */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Histogram { buckets: number[]; sum: number; count: number }

export function registerMetrics(app: FastifyInstance, deps: Deps) {
  const requests = new Map<string, number>();
  const errors = new Map<string, number>();
  const latency = new Map<string, Histogram>();
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'desconhecida';
    if (route === '/metrics') return;
    inc(requests, JSON.stringify({ method: req.method, route, status: `${Math.floor(reply.statusCode / 100)}xx` }));
    const h = latency.get(route) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    const s = reply.elapsedTime / 1000;
    BUCKETS.forEach((b, i) => { if (s <= b) h.buckets[i]!++; });
    h.sum += s;
    h.count++;
    latency.set(route, h);
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode >= 400 && typeof payload === 'string' && payload.startsWith('{')) {
      try {
        const code = (JSON.parse(payload) as { code?: unknown }).code;
        if (typeof code === 'string') inc(errors, JSON.stringify({ code }));
      } catch { /* corpo não é JSON */ }
    }
    return payload;
  });

  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    const token = deps.config.metricsToken;
    const auth = req.headers.authorization;
    if (token ? !(typeof auth === 'string' && safeEqual(auth, `Bearer ${token}`)) : deps.config.env === 'production') {
      return reply.status(404).send({ code: 'NOT_FOUND', message: 'Não encontrado' });
    }
    const out: string[] = [];
    const labels = (l: Record<string, unknown>) => {
      const parts = Object.entries(l).map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`);
      return parts.length ? `{${parts.join(',')}}` : '';
    };
    const counter = (name: string, help: string, m: Map<string, number>) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [k, v] of m) out.push(`${name}${labels(JSON.parse(k))} ${v}`);
    };
    counter('vortex_http_requests_total', 'Requisições HTTP por rota e classe de status', requests);
    counter('vortex_http_errors_total', 'Respostas de erro por código', errors);
    out.push('# HELP vortex_http_request_duration_seconds Latência por rota', '# TYPE vortex_http_request_duration_seconds histogram');
    for (const [route, h] of latency) {
      BUCKETS.forEach((b, i) => out.push(`vortex_http_request_duration_seconds_bucket${labels({ route, le: b })} ${h.buckets[i]}`));
      out.push(`vortex_http_request_duration_seconds_bucket${labels({ route, le: '+Inf' })} ${h.count}`,
        `vortex_http_request_duration_seconds_sum${labels({ route })} ${h.sum.toFixed(6)}`,
        `vortex_http_request_duration_seconds_count${labels({ route })} ${h.count}`);
    }
    const snap = await deps.pool.query<{ metric: string; labels: Record<string, unknown>; value: string }>(`SELECT metric, labels, value FROM core.metrics_snapshot()`);
    const seen = new Set<string>();
    for (const r of snap.rows) {
      if (!seen.has(r.metric)) {
        seen.add(r.metric);
        out.push(`# TYPE ${r.metric} gauge`);
      }
      out.push(`${r.metric}${labels(r.labels)} ${Number(r.value)}`);
    }
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return out.join('\n') + '\n';
  });
}
