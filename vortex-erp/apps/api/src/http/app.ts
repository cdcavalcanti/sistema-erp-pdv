import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { jsonSchema } from './schemas.js';
import { installPtBrMessages } from '@vortex/contracts';

installPtBrMessages();
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { Tx, withTenant, type RequestContext } from '../db/tx.js';
import { AppError, mapDbError } from '../errors.js';
import { requirePerm } from '../core/access.js';
import { sha256 } from '../core/crypto.js';
import type { Vault } from '../core/vault.js';
import { buildApiKeyContext, buildUserContext, verifyToken } from './auth.js';
import type { Services } from '../services.js';
import { registerMetrics } from './metrics.js';

export interface Deps {
  config: Config;
  pool: Pool;
  vault: Vault;
  services: Services;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
    /** Todas as rotas registradas (usado pelo teste de isolamento de tenant em todas as rotas) */
    routeTable: { method: string; url: string }[];
  }
  interface FastifyRequest {
    vxCtx?: RequestContext;
  }
}

export type App = FastifyInstance;

export interface HandlerArgs<B, Q, P> {
  tx: Tx;
  ctx: RequestContext;
  body: B;
  query: Q;
  params: P;
  req: FastifyRequest;
  reply: FastifyReply;
  deps: Deps;
}

export interface RouteDef<B extends ZodTypeAny, Q extends ZodTypeAny, P extends ZodTypeAny> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  summary: string;
  tags: string[];
  /** Permissão modulo.recurso.acao; null = qualquer usuário autenticado */
  permission: string | null;
  body?: B;
  query?: Q;
  params?: P;
  status?: number;
  /** Exige empresa selecionada (X-Company-Id) */
  company?: boolean;
  /** GET que grava algo (ex.: auditoria de exportação de dados pessoais) */
  writes?: boolean;
  /**
   * Ação depois do commit (fora da transação), ex.: transmitir a NF-e à SEFAZ.
   * Recebe o resultado do handler e devolve a resposta final. Roda também em replays idempotentes.
   */
  afterCommit?: (result: any, a: { ctx: RequestContext; deps: Deps; req: FastifyRequest }) => Promise<unknown>;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function headerString(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' && v.length ? v : null;
}

export async function resolveContext(app: App, req: FastifyRequest): Promise<RequestContext> {
  if (req.vxCtx) return req.vxCtx;
  const meta = {
    companyId: headerString(req, 'x-company-id'),
    ip: req.ip ?? null,
    device: headerString(req, 'x-device') ?? (headerString(req, 'user-agent')?.slice(0, 200) ?? null),
    requestId: String(req.id),
  };
  const auth = headerString(req, 'authorization');
  const apiKey = headerString(req, 'x-api-key');
  let ctx: RequestContext;
  if (auth?.startsWith('Bearer ')) {
    const claims = await verifyToken(app.deps.config.jwtSecret, auth.slice(7));
    ctx = await buildUserContext(app.deps.pool, claims, meta);
  } else if (apiKey) {
    ctx = await buildApiKeyContext(app.deps.pool, apiKey, meta);
  } else {
    throw new AppError('UNAUTHENTICATED', 'Autenticação necessária', 401);
  }
  req.vxCtx = ctx;
  return ctx;
}

function parseWith<T extends ZodTypeAny>(schema: T | undefined, data: unknown, where: string): z.infer<T> {
  if (!schema) return data as z.infer<T>;
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw zodToAppError(r.error, where);
  return r.data;
}

export function zodToAppError(err: ZodError, where = 'body'): AppError {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = [where, ...issue.path].join('.');
    if (!fields[key]) fields[key] = issue.message;
  }
  return new AppError('VALIDATION', 'Dados inválidos', 422, { fields });
}

/**
 * Registra uma rota com: autenticação, permissão, validação por esquema (zod),
 * transação com contexto de tenant (RLS) e idempotência (RN-GER-07).
 */
export function route<B extends ZodTypeAny = ZodTypeAny, Q extends ZodTypeAny = ZodTypeAny, P extends ZodTypeAny = ZodTypeAny>(
  app: App,
  def: RouteDef<B, Q, P>,
  handler: (a: HandlerArgs<z.infer<B>, z.infer<Q>, z.infer<P>>) => Promise<unknown>,
): void {
  const schema: Record<string, unknown> = { summary: def.summary, tags: def.tags };
  if (def.body) schema.body = jsonSchema(def.body);
  if (def.query) schema.querystring = jsonSchema(def.query);
  if (def.params) schema.params = jsonSchema(def.params);
  if (def.permission) schema.description = `Permissão: \`${def.permission}\``;

  app.route({
    method: def.method,
    url: def.url,
    schema,
    handler: async (req, reply) => {
      const ctx = await resolveContext(app, req);
      if (def.permission) requirePerm(ctx, def.permission);
      if (def.company !== false && !ctx.companyId && def.company) {
        throw new AppError('COMPANY_REQUIRED', 'Selecione a empresa (cabeçalho X-Company-Id)', 400);
      }
      const body = parseWith(def.body, req.body, 'body');
      const query = parseWith(def.query, req.query, 'query');
      const params = parseWith(def.params, req.params, 'params');
      const mutating = MUTATING.has(def.method);
      const idemKey = mutating ? headerString(req, 'idempotency-key') : null;

      const result = await withTenant(app.deps.pool, ctx, async (tx) => {
        if (idemKey) {
          if (idemKey.length > 200) throw new AppError('VALIDATION', 'Idempotency-Key muito longa', 422);
          const hash = sha256(JSON.stringify({ m: def.method, u: req.url, b: req.body ?? null }));
          const inserted = await tx.maybeOne(
            `INSERT INTO integration.idempotency_keys (tenant_id, key, method, path, request_hash)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
            [ctx.tenantId, idemKey, def.method, req.url, hash],
          );
          if (!inserted) {
            const prev = await tx.one<{ request_hash: string; response_status: number | null; response_body: unknown }>(
              `SELECT request_hash, response_status, response_body FROM integration.idempotency_keys WHERE tenant_id = $1 AND key = $2`,
              [ctx.tenantId, idemKey]);
            if (prev.request_hash !== hash) {
              throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key já usada com outra requisição', 422, { rule: 'RN-GER-07' });
            }
            return { replay: true as const, status: prev.response_status ?? 200, body: prev.response_body };
          }
          const body2 = await handler({ tx, ctx, body, query, params, req, reply, deps: app.deps });
          const status = def.status ?? 200;
          await tx.exec(
            `UPDATE integration.idempotency_keys SET response_status = $3, response_body = $4 WHERE tenant_id = $1 AND key = $2`,
            [ctx.tenantId, idemKey, status, JSON.stringify(body2 ?? null)]);
          return { replay: false as const, status, body: body2 };
        }
        const out = await handler({ tx, ctx, body, query, params, req, reply, deps: app.deps });
        return { replay: false as const, status: def.status ?? 200, body: out };
      }, { readOnly: !mutating && !def.writes });

      if (reply.sent) return reply;
      if (result.replay) reply.header('Idempotent-Replay', 'true');
      reply.status(result.status);
      if (def.afterCommit) return (await def.afterCommit(result.body, { ctx, deps: app.deps, req })) ?? null;
      return result.body ?? null;
    },
  });
}

export async function buildApp(deps: Deps, registerModules: (app: App) => Promise<void> | void): Promise<App> {
  const app = Fastify({
    logger: deps.config.env === 'test' ? false : { level: deps.config.logLevel },
    genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : randomUUID()),
    bodyLimit: 15 * 1024 * 1024,
    trustProxy: true,
  });
  app.decorate('deps', deps);
  const routeTable: { method: string; url: string }[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const m of [r.method].flat()) if (m !== 'HEAD' && m !== 'OPTIONS') routeTable.push({ method: m, url: r.url });
  });
  // Validação feita pelo zod no helper `route`; o JSON Schema serve só para a documentação.
  app.setValidatorCompiler(() => (data) => ({ value: data }));

  await app.register(cors, { origin: true, exposedHeaders: ['Idempotent-Replay', 'X-Request-Id'] });
  await app.register(rateLimit, {
    max: deps.config.rateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: (req) => sha256(String(req.headers['x-api-key'] ?? req.headers.authorization ?? req.ip)),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, code: 'RATE_LIMITED', message: `Limite de requisições excedido; tente em ${Math.ceil(ctx.ttl / 1000)} s` }),
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'VORTEX ERP API', version: '1.0.0', description: 'API REST do ERP VORTEX. Autenticação: Bearer (VORTEX ID) ou X-Api-Key. Toda criação aceita Idempotency-Key.' },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        },
      },
      security: [{ bearer: [] }, { apiKey: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', String(req.id));
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    let e: AppError | null = null;
    if (err instanceof AppError) e = err;
    else if (err instanceof ZodError) e = zodToAppError(err);
    else e = mapDbError(err);
    if (!e && err.statusCode === 429) {
      return reply.status(429).send({ code: 'RATE_LIMITED', message: err.message });
    }
    if (!e && err.validation) e = new AppError('VALIDATION', err.message, 400);
    if (!e && err.statusCode && err.statusCode < 500) e = new AppError('BAD_REQUEST', err.message, err.statusCode);
    if (!e) {
      req.log.error({ err, tenant: req.vxCtx?.tenantId }, 'erro inesperado');
      return reply.status(500).send({ code: 'INTERNAL', message: 'Erro interno. Informe o código da requisição ao suporte.', requestId: req.id });
    }
    return reply.status(e.status).send({ code: e.code, message: e.message, details: e.details, requestId: req.id });
  });

  registerMetrics(app, deps);

  app.get('/health', { schema: { hide: true } }, async () => {
    await deps.pool.query('SELECT 1');
    return { status: 'ok' };
  });

  await registerModules(app);
  return app;
}
