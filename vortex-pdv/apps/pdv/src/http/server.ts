import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z, ZodError } from 'zod';
import { installPtBrMessages } from '@vortex/contracts';
import { PdvError } from '../domain/errors.js';
import { setLocalSetting } from '../sync/catalog.js';
import { P, can, type Operator } from '../security/permissions.js';
import type { Pdv } from '../application/pdv.js';
import { SimulatedPixPsp, SimulatedTef } from '../payment/providers.js';
import { SimulatedSefaz } from '../fiscal/providers.js';
import { SimulatedScale } from '../hardware/devices.js';
import { FilePrinter } from '../printer/drivers.js';

installPtBrMessages();

declare module 'fastify' {
  interface FastifyRequest {
    operator?: Operator;
    token?: string;
  }
}

type Route = { Params: { id: string; itemId: string; number: string; txid: string }; Querystring: unknown; Body: unknown };
type Req = FastifyRequest<Route>;

const authSchema = z.object({ login: z.string().min(1), pin: z.string().min(4) }).nullish();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida');
const money = z.union([z.string(), z.number()]).transform((v) => String(v).replace(',', '.')).pipe(z.string().regex(/^\d+(\.\d{1,4})?$/, 'Valor inválido'));
const discountSchema = z.object({ kind: z.enum(['percent', 'value']), value: money }).nullable();

/**
 * API local do agente (127.0.0.1), consumida pela frente de caixa. Toda regra está na camada de
 * aplicação; aqui só autenticação, validação de entrada e tradução de erros (seção 40:
 * validação no servidor, tokens, rate limiting).
 */
export async function buildServer(pdv: Pdv): Promise<FastifyInstance> {
  const app = Fastify({ logger: pdv.config.env === 'test' ? false : { level: 'info' }, bodyLimit: 1_048_576 });
  await app.register(cors, { origin: [pdv.config.uiOrigin, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] });
  await app.register(rateLimit, { max: 1200, timeWindow: '1 minute' });

  // Webhook do ERP: corpo cru para conferir a assinatura
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (req.url.startsWith('/webhooks/')) return done(null, body);
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof PdvError) return reply.status(err.status).send({ code: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) {
      const fields = Object.fromEntries(err.issues.map((i) => [i.path.join('.') || 'body', i.message]));
      return reply.status(422).send({ code: 'VALIDATION', message: Object.values(fields)[0] ?? 'Dados inválidos', details: { fields } });
    }
    if (err.statusCode === 429) return reply.status(429).send({ code: 'RATE_LIMITED', message: 'Muitas tentativas: aguarde um instante' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ code: 'BAD_REQUEST', message: err.message });
    app.log.error(err);
    return reply.status(500).send({ code: 'INTERNAL', message: `Erro inesperado: ${err.message}` });
  });

  const auth = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new PdvError('UNAUTHENTICATED', 'Faça login', 401);
    req.token = h.slice(7);
    req.operator = pdv.auth.resolve(req.token);
  };
  const op = (req: FastifyRequest) => req.operator!;
  const need = (req: FastifyRequest, perm: string) => {
    if (!can(op(req), perm)) throw new PdvError('FORBIDDEN', 'Sem permissão para esta função', 403, { permission: perm });
  };
  const online = () => pdv.sync.online;
  type H = (req: Req, reply: FastifyReply) => Promise<unknown> | unknown;
  const get = (url: string, h: H, open = false) => app.get<Route>(url, open ? {} : { preHandler: auth }, h);
  const post = (url: string, h: H, open = false) => app.post<Route>(url, open ? {} : { preHandler: auth }, h);

  // ---------------------------------------------------------------- terminal e sessão
  get('/api/health', () => ({ ok: true, terminal: pdv.config.terminalCode, version: pdv.config.appVersion }), true);
  get('/api/status', () => pdv.system.status(), true);
  get('/api/terminal', () => ({
    terminal: pdv.config.terminalCode, version: pdv.config.appVersion, store: pdv.db.meta('establishment'), online: online(), environment: pdv.config.fiscal.environment,
    paired: Boolean(pdv.db.get(`SELECT 1 FROM operators LIMIT 1`)), simulators: simulators(pdv),
  }), true);

  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ login: z.string().min(1).max(40), pin: z.string().min(4).max(12) }).parse(req.body);
    return pdv.auth.login(b.login.trim(), b.pin);
  });
  post('/api/auth/logout', (req) => {
    pdv.auth.logout(req.token!, op(req));
    return { ok: true };
  });
  get('/api/auth/me', (req) => ({ operator: op(req) }));
  get('/api/session', (req) => {
    const cash = pdv.cash.current();
    const inProgress = pdv.sales.inProgress();
    return { operator: op(req), cash, sale: inProgress ? pdv.sales.view(inProgress.id) : null, online: online(), settings: pdv.settings() };
  });

  // ---------------------------------------------------------------- caixa
  post('/api/cash/open', (req) => {
    const b = z.object({ amount: money, authorization: authSchema }).parse(req.body);
    return pdv.cash.open(op(req), b.amount, b.authorization);
  });
  post('/api/cash/supply', (req) => {
    const b = z.object({ amount: money, reason: z.string().min(2).max(200), authorization: authSchema }).parse(req.body);
    return pdv.cash.supply(op(req), b.amount, b.reason, b.authorization);
  });
  post('/api/cash/withdraw', (req) => {
    const b = z.object({ amount: money, reason: z.string().min(2).max(200), note: z.string().max(200).nullish(), authorization: authSchema }).parse(req.body);
    return pdv.cash.withdraw(op(req), b.amount, b.reason, b.note ?? null, b.authorization);
  });
  get('/api/cash/summary', (req) => {
    const s = pdv.cash.requireOpen();
    const sum = pdv.cash.summary(s.id);
    // Fechamento cego: o esperado só aparece para quem fecha o caixa
    return pdv.settings().cash.blindClosing && !can(op(req), P.closeCash) ? { ...sum, expected: null, blind: true } : { ...sum, blind: false };
  });
  post('/api/cash/close', (req) => {
    const b = z.object({ informed: z.object({ cash: money, pix: money.optional(), debit: money.optional(), credit: money.optional() }), authorization: authSchema }).parse(req.body);
    return pdv.cash.close(op(req), b.informed, b.authorization);
  });
  post('/api/cash/:id/reopen', (req) => {
    const b = z.object({ reason: z.string().min(15), authorization: authSchema }).parse(req.body);
    return pdv.cash.reopen(op(req), req.params.id, b.reason, b.authorization);
  });
  get('/api/cash/sessions', (req) => {
    need(req, P.operators);
    return pdv.cash.sessions();
  });

  // ---------------------------------------------------------------- produtos e clientes
  get('/api/products', (req) => pdv.catalog.search(z.object({ q: z.string().min(1).max(80) }).parse(req.query).q));
  get('/api/products/lookup', (req) => {
    const { code } = z.object({ code: z.string().min(1).max(60) }).parse(req.query);
    const r = pdv.catalog.lookup(code);
    if (!r) throw new PdvError('PRODUCT_NOT_FOUND', `Produto não encontrado: ${code}`, 404);
    return { ...pdv.catalog.view(r.product, r.quantity ?? '1', null), quantity: r.quantity };
  });
  get('/api/customers', (req) => pdv.customers.search(z.object({ q: z.string().min(1).max(80) }).parse(req.query).q, online()));
  post('/api/customers', (req) => {
    need(req, P.customer);
    const b = z.object({ taxId: z.string().min(11).max(18), name: z.string().min(2).max(120), email: z.string().email().nullish(), phone: z.string().max(20).nullish() }).parse(req.body);
    return pdv.customers.create(b);
  });

  // ---------------------------------------------------------------- venda
  post('/api/sales', (req) => {
    pdv.system.assertNoUpdateLock();
    return pdv.sales.view(pdv.sales.start(op(req)).id);
  });
  get('/api/sales', (req) => pdv.sales.list(op(req), z.object({
    q: z.string().max(40).optional(), sessionId: z.string().optional(), from: day.optional(), to: day.optional(),
    status: z.enum(['completed', 'cancelled', 'with_cancelled_items']).optional(), sync: z.enum(['pending', 'synced', 'failed', 'local']).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }).parse(req.query)));
  get('/api/sales/:id', (req) => pdv.sales.view(req.params.id));
  post('/api/sales/:id/items', (req) => {
    const b = z.object({ code: z.string().max(60).optional(), productId: z.string().uuid().optional(), quantity: money.nullish() })
      .refine((x) => x.code || x.productId, 'Informe o código ou o produto').parse(req.body);
    return pdv.sales.addItem(op(req), req.params.id, b);
  });
  app.patch<Route>('/api/sales/:id/items/:itemId', { preHandler: auth }, (req: Req) =>
    pdv.sales.setQuantity(op(req), req.params.id, req.params.itemId, z.object({ quantity: money }).parse(req.body).quantity));
  post('/api/sales/:id/items/:itemId/cancel', (req) => {
    const b = z.object({ reason: z.string().min(2).max(200), quantity: money.nullish(), authorization: authSchema }).parse(req.body);
    return pdv.sales.cancelItem(op(req), req.params.id, req.params.itemId, b.reason, b.authorization, b.quantity ?? null);
  });
  post('/api/sales/:id/items/:itemId/discount', (req) => {
    const b = z.object({ discount: discountSchema, authorization: authSchema }).parse(req.body);
    return pdv.sales.itemDiscount(op(req), req.params.id, req.params.itemId, b.discount, b.authorization);
  });
  post('/api/sales/:id/discount', (req) => {
    const b = z.object({ discount: discountSchema, authorization: authSchema }).parse(req.body);
    return pdv.sales.saleDiscount(op(req), req.params.id, b.discount, b.authorization);
  });
  post('/api/sales/:id/customer', (req) => {
    const b = z.object({ customerId: z.string().nullish(), taxId: z.string().min(11).max(18).nullish(), name: z.string().max(120).nullish() }).parse(req.body);
    return b.taxId ? pdv.sales.setCustomerTaxId(op(req), req.params.id, b.taxId, b.name ?? null) : pdv.sales.setCustomer(op(req), req.params.id, b.customerId ?? null);
  });
  post('/api/sales/:id/finalize', (req) => pdv.sales.finalize(op(req), req.params.id));
  post('/api/sales/:id/back', (req) => pdv.sales.backToCart(op(req), req.params.id));
  post('/api/sales/:id/payments', (req) => {
    const b = z.object({ method: z.enum(['cash', 'pix', 'debit', 'credit', 'pos_debit', 'pos_credit']), amount: money, installments: z.number().int().min(1).max(24).optional(),
      idempotencyKey: z.string().min(8).max(80) }).parse(req.body);
    return pdv.sales.addPayment(op(req), req.params.id, b);
  });
  post('/api/payments/:id/poll', (req) => pdv.sales.pollPayment(op(req), req.params.id));
  post('/api/payments/:id/confirm', (req) => {
    const b = z.object({ nsu: z.string().max(12), authorization: z.string().max(12), brand: z.string().max(20).nullish() }).parse(req.body);
    return pdv.sales.confirmExternal(op(req), req.params.id, b);
  });
  post('/api/payments/:id/cancel', (req) => pdv.sales.cancelPayment(op(req), req.params.id));
  post('/api/sales/:id/complete', (req) => pdv.sales.complete(op(req), req.params.id));
  post('/api/sales/:id/cancel', (req) => {
    const b = z.object({ reason: z.string().min(15, 'Motivo com no mínimo 15 caracteres').max(255), authorization: authSchema }).parse(req.body);
    return pdv.sales.cancelSale(op(req), req.params.id, b.reason, b.authorization);
  });
  post('/api/sales/:id/reprint', (req) => pdv.sales.reprint(op(req), req.params.id, authSchema.parse((req.body as any)?.authorization)));
  post('/api/sales/:id/reprocess-fiscal', (req) => pdv.sales.reprocessFiscal(op(req), req.params.id));
  get('/api/sales/:id/receipt', (req) => {
    const s = pdv.sales.row(req.params.id);
    const data = pdv.sales.receiptData(s.id, pdv.auth.operatorById(s.operator_id)?.name ?? '-');
    return { text: pdv.printer.render(data).text, qrUrl: data.fiscal?.qrUrl ?? null, consultUrl: data.fiscal?.consultUrl ?? null, accessKey: data.fiscal?.accessKey ?? null };
  });

  // ---------------------------------------------------------------- devolução
  get('/api/returns/sale/:number', (req) => pdv.returns.returnable(req.params.number, online()));
  post('/api/returns', (req) => {
    const b = z.object({
      saleNumber: z.string().min(5), items: z.array(z.object({ itemNumber: z.number().int().min(1), quantity: money })).min(1), reason: z.string().min(5).max(255),
      refundMethod: z.enum(['cash', 'pix', 'card', 'store_credit']), customer: z.object({ taxId: z.string().min(11).max(18), name: z.string().min(2).max(120) }).nullish(),
      reference: z.string().min(8).max(80), authorization: authSchema,
    }).parse(req.body);
    return pdv.returns.create(op(req), b, online(), b.authorization);
  });

  // ---------------------------------------------------------------- sincronização, painel, sistema
  // "Sincronizar agora": envia a fila e baixa o que mudou no ERP (preços, produtos, estoque) na hora
  post('/api/sync', (req) => pdv.sync.runOnce({ full: z.object({ full: z.boolean().optional() }).parse(req.body ?? {}).full, pull: true }));
  get('/api/sync/queue', (req) => ({ counts: pdv.queue.counts(), items: pdv.queue.list(z.object({ status: z.enum(['PENDING', 'PROCESSING', 'SYNCED', 'FAILED']).optional(),
    archived: z.enum(['0', '1']).optional().transform((v) => v === '1') }).parse(req.query)) }));
  post('/api/sync/retry', () => ({ retried: pdv.queue.retryNow() }));
  // Envio que o ERP não vai aceitar (ex.: venda da loja/ERP anterior): o gerente arquiva com motivo
  post('/api/sync/:id/archive', async (req) => {
    const b = z.object({ reason: z.string().min(10, 'Motivo com no mínimo 10 caracteres').max(255), authorization: authSchema }).parse(req.body);
    const operator = op(req);
    const approver = await pdv.auth.require(operator, P.settings, b.authorization, 'Arquivar envio ao ERP');
    const item = pdv.queue.archive(req.params.id, b.reason, (approver ?? operator).id);
    if (!item) throw new PdvError('NOT_FOUND', 'Envio com falha não encontrado (já enviado ou arquivado)', 404);
    if (item.type === 'sale') pdv.db.run(`UPDATE sales SET sync_status = 'failed' WHERE id = ?`, [item.entity_id]);
    pdv.audit.record({ userId: operator.id, action: 'SYNC', entity: item.entity, entityId: item.entity_id,
      metadata: { kind: 'envio_arquivado', type: item.type, reason: b.reason, lastError: item.last_error, authorizedBy: approver?.id ?? null } });
    return { archived: item.id };
  });
  get('/api/dashboard', (req) => pdv.system.dashboard(op(req)));
  get('/api/audit', (req) => {
    need(req, P.operators);
    return pdv.audit.list(z.object({ action: z.string().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query));
  });
  get('/api/settings', () => pdv.settings());
  app.put<Route>('/api/settings', { preHandler: auth }, (req: Req) => {
    need(req, P.settings);
    const b = z.object({ path: z.string(), value: z.unknown() }).parse(req.body);
    try {
      return setLocalSetting(pdv.db, b.path, b.value);
    } catch (e) {
      throw new PdvError('FORBIDDEN', (e as Error).message, 403);
    }
  });
  get('/api/system/update', () => pdv.system.updateState(), true);
  post('/api/system/update', (req) => {
    need(req, P.settings);
    return pdv.system.requestUpdate(z.object({ version: z.string().min(1).max(20) }).parse(req.body).version);
  });
  post('/api/system/backup', (req) => {
    need(req, P.operators);
    return pdv.system.backup();
  });
  get('/api/system/backups', () => pdv.system.backups());
  app.post('/webhooks/erp', async (req, reply) => {
    const r = await pdv.sync.handleWebhook(req.headers['x-vortex-signature'] as string | undefined, req.body as string);
    return reply.status(r.accepted ? 200 : 401).send(r);
  });

  // ---------------------------------------------------------------- homologação: comandos dos simuladores (nunca em produção)
  if (pdv.config.env !== 'production') {
    app.post<Route>('/api/dev/pix/:txid/pay', async (req: Req) => {
      if (!(pdv.providers.pix instanceof SimulatedPixPsp)) throw new PdvError('NOT_SIMULATED', 'Pix real configurado', 409);
      return { paid: pdv.providers.pix.pay(req.params.txid) };
    });
    app.post('/api/dev/sefaz', async (req) => {
      if (!(pdv.fiscalProvider instanceof SimulatedSefaz)) throw new PdvError('NOT_SIMULATED', 'Fornecedor fiscal real configurado', 409);
      pdv.fiscalProvider.online = z.object({ online: z.boolean() }).parse(req.body).online;
      return { online: pdv.fiscalProvider.online };
    });
    app.post('/api/dev/scale', async (req) => {
      if (!(pdv.scale instanceof SimulatedScale)) throw new PdvError('NOT_SIMULATED', 'Balança real configurada', 409);
      const b = z.object({ weight: money, stable: z.boolean().default(true) }).parse(req.body);
      pdv.scale.weight = b.weight;
      pdv.scale.stable = b.stable;
      return b;
    });
    app.post('/api/dev/printer', async (req) => {
      const drv = pdv.printer.driver;
      if (!(drv instanceof FilePrinter)) throw new PdvError('NOT_SIMULATED', 'Impressora real configurada', 409);
      drv.simulated = z.object({ status: z.enum(['ok', 'paper_low', 'paper_out', 'offline']) }).parse(req.body).status;
      return { status: drv.simulated };
    });
  }
  return app;
}

/** Quais integrações estão simuladas (mostrado claramente na tela de status). */
export function simulators(pdv: Pdv): string[] {
  return [
    pdv.providers.pix instanceof SimulatedPixPsp && 'Pix (PSP simulado)',
    pdv.providers.debit instanceof SimulatedTef && 'TEF (pinpad simulado)',
    pdv.fiscalProvider instanceof SimulatedSefaz && 'SEFAZ (homologação simulada)',
    pdv.scale instanceof SimulatedScale && 'Balança simulada',
    pdv.printer.driver instanceof FilePrinter && 'Impressora em arquivo',
  ].filter(Boolean) as string[];
}
