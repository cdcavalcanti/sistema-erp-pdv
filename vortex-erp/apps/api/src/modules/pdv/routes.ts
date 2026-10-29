import { z } from 'zod';
import { pdvCashMovementSchema, pdvHeartbeatSchema, pdvOperatorSchema, pdvReturnSchema, pdvSaleCancelSchema, pdvSaleSchema, terminalCode } from '@vortex/contracts';
import { route, type App } from '../../http/app.js';
import { decodeCursor, idParams, isoDate, page } from '../../http/schemas.js';
import { assertEstablishmentScope } from '../../core/access.js';
import { authorizePdvContingency, importPdvSale, pdvCashMovement, pdvNumbering, pdvSync } from './service.js';
import {
  callingTerminal, cancelPdvSale, createTerminal, rotateTerminalKey, getPdvSale, getSettings, heartbeat, listTerminals, pdvReturn, putSettings, setOperator, setTerminalStatus, storeDashboard,
  syncStatus, receiveEvents, listEvents, PDV_AUDIT_ACTIONS, listPdvSales, pdvSalesSummary, getPdvSaleById, listPdvCash,
} from './operation.js';

const ts = z.string().datetime({ offset: true });

/**
 * Integração com o Vortex PDV. Rotas de terminal usam a chave de API do terminal (escopo
 * "pdv.sincronizacao.executar"); rotas de administração usam o login do ERP.
 */
export function registerPdvRoutes(app: App) {
  // ---------------------------------------------------------------- terminal → ERP
  route(app, {
    method: 'GET', url: '/v1/pdv/sync', summary: 'Carga para o PDV offline: produtos, preços, promoções, clientes, saldos, operadores, parâmetros e contexto fiscal da NFC-e (delta por "since")',
    tags: ['PDV'], permission: 'pdv.sincronizacao.executar', query: z.object({ establishmentId: z.string().uuid(), since: ts.optional() }),
  }, async ({ tx, ctx, query }) => {
    assertEstablishmentScope(ctx, query.establishmentId);
    const terminal = ctx.apiKeyId ? await tx.maybeOne<{ id: string; code: string }>(`SELECT id, code, name, status FROM integration.pdv_terminals WHERE api_key_id = $1`, [ctx.apiKeyId]) : null;
    const numbering = terminal ? await pdvNumbering(tx, query.establishmentId, terminal.code) : null;
    return { ...(await pdvSync(tx, query.establishmentId, query.since ?? null)), terminal, numbering };
  });

  route(app, {
    method: 'POST', url: '/v1/pdv/sales', summary: 'Recebe venda do PDV com NFC-e autorizada ou em contingência: estoque, recebimentos e contábil (idempotente)', tags: ['PDV'],
    permission: 'pdv.sincronizacao.executar', status: 201, body: pdvSaleSchema,
  }, async ({ tx, ctx, body, deps }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return importPdvSale(tx, deps.services, body);
  });

  route(app, {
    method: 'GET', url: '/v1/pdv/sales/:saleId', summary: 'Venda do PDV no ERP: situação fiscal, itens e devoluções', tags: ['PDV'], permission: 'pdv.sincronizacao.executar',
    params: z.object({ saleId: z.string().min(1).max(80) }), query: z.object({ establishmentId: z.string().uuid() }),
  }, async ({ tx, ctx, params, query }) => {
    assertEstablishmentScope(ctx, query.establishmentId);
    return getPdvSale(tx, query.establishmentId, params.saleId);
  });

  route(app, {
    method: 'POST', url: '/v1/pdv/sales/authorization', summary: 'Autorização posterior de NFC-e emitida offline', tags: ['PDV'], permission: 'pdv.sincronizacao.executar',
    body: z.object({ establishmentId: z.string().uuid(), pdvId: z.string(), saleId: z.string(), protocol: z.string().min(5), authorizedAt: ts }),
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return authorizePdvContingency(tx, body);
  });

  route(app, {
    method: 'POST', url: '/v1/pdv/sales/cancel', summary: 'Cancelamento de venda do PDV (NFC-e cancelada na SEFAZ): estorna estoque, recebimentos e contábil (idempotente)', tags: ['PDV'],
    permission: 'pdv.sincronizacao.executar', body: pdvSaleCancelSchema,
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return cancelPdvSale(tx, await callingTerminal(tx, ctx, body.establishmentId), body);
  });

  route(app, {
    method: 'POST', url: '/v1/pdv/returns', summary: 'Devolução de venda do PDV: nota de entrada, estoque de volta e reembolso (idempotente)', tags: ['PDV'],
    permission: 'pdv.sincronizacao.executar', status: 201, body: pdvReturnSchema,
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    await callingTerminal(tx, ctx, body.establishmentId);
    return pdvReturn(tx, body);
  });

  route(app, {
    method: 'POST', url: '/v1/pdv/cash-movements', summary: 'Abertura, suprimento, sangria, fechamento e reabertura de caixa (diferença lançada no financeiro e na contabilidade)', tags: ['PDV'],
    permission: 'pdv.sincronizacao.executar', status: 201, body: pdvCashMovementSchema,
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return pdvCashMovement(tx, body);
  });

  route(app, {
    method: 'POST', url: '/v1/pdv/terminals/heartbeat', summary: 'Sinal de vida do terminal: versão, pendências e saúde dos serviços (monitoramento)', tags: ['PDV'],
    permission: 'pdv.sincronizacao.executar', body: pdvHeartbeatSchema,
  }, async ({ tx, ctx, body }) => heartbeat(tx, (await callingTerminal(tx, ctx)).id, body));

  route(app, {
    method: 'GET', url: '/v1/pdv/sync/status', summary: 'O que o ERP já recebeu deste terminal', tags: ['PDV'], permission: 'pdv.sincronizacao.executar',
  }, async ({ tx, ctx }) => syncStatus(tx, await callingTerminal(tx, ctx)));

  route(app, {
    method: 'GET', url: '/v1/pdv/dashboard', summary: 'Painel operacional da loja: vendas do dia, ticket médio, caixas abertos, operadores e pendências', tags: ['PDV'],
    permission: 'pdv.sincronizacao.executar', query: z.object({ establishmentId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  }, async ({ tx, ctx, query }) => {
    assertEstablishmentScope(ctx, query.establishmentId);
    return storeDashboard(tx, query.establishmentId, query.date ?? new Date().toISOString().slice(0, 10));
  });

  route(app, {
    method: 'POST', url: '/v1/pdv/events', summary: 'Auditoria do terminal em lote (login, vendas, cancelamentos, descontos, autorizações, caixa, erros) — idempotente', tags: ['PDV'],
    permission: 'pdv.sincronizacao.executar',
    body: z.object({
      establishmentId: z.string().uuid(),
      events: z.array(z.object({ id: z.string().uuid(), userId: z.string().uuid().nullable(), action: z.enum(PDV_AUDIT_ACTIONS), entity: z.string().max(60).nullable(),
        entityId: z.string().max(120).nullable(), metadata: z.record(z.string(), z.unknown()), timestamp: ts })).max(500),
    }),
  }, async ({ tx, ctx, body }) => receiveEvents(tx, await callingTerminal(tx, ctx, body.establishmentId), body.events));

  route(app, {
    method: 'GET', url: '/v1/pdv/events', summary: 'Auditoria dos terminais de PDV', tags: ['PDV'], permission: 'pdv.operador.consultar',
    query: z.object({ establishmentId: z.string().uuid().optional(), action: z.enum(PDV_AUDIT_ACTIONS).optional(), from: ts.optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }),
  }, async ({ tx, query }) => listEvents(tx, { establishmentId: query.establishmentId ?? null, action: query.action ?? null, from: query.from ?? null, limit: query.limit }));

  // ---------------------------------------------------------------- vendas e caixas do PDV no backoffice
  const salesFilter = z.object({ establishmentId: z.string().uuid().optional(), pdvId: z.string().max(10).optional(), from: isoDate.optional(), to: isoDate.optional(),
    status: z.enum(['active', 'cancelled', 'with_cancelled_items']).optional(), q: z.string().max(80).optional() });
  const toFilter = (q: z.infer<typeof salesFilter>) => ({ establishmentId: q.establishmentId ?? null, pdvId: q.pdvId ?? null, from: q.from ?? null, to: q.to ?? null,
    status: q.status ?? null, q: q.q ?? null });
  route(app, {
    method: 'GET', url: '/v1/pdv/sales', summary: 'Vendas recebidas dos terminais (NFC-e, operador, itens cancelados no caixa), com filtros', tags: ['PDV'], permission: 'pdv.operador.consultar',
    query: salesFilter.extend({ limit: z.coerce.number().int().min(1).max(500).default(50), cursor: z.string().optional() }),
  }, async ({ tx, query }) => page(await listPdvSales(tx, toFilter(query), query.limit, decodeCursor(query.cursor)), query.limit));

  route(app, {
    method: 'GET', url: '/v1/pdv/sales/summary', summary: 'Totais das vendas do PDV no período: ticket médio, cancelamentos, por terminal e por operador', tags: ['PDV'],
    permission: 'pdv.operador.consultar', query: salesFilter,
  }, async ({ tx, query }) => pdvSalesSummary(tx, toFilter(query)));

  route(app, {
    method: 'GET', url: '/v1/pdv/sales/by-id/:id', summary: 'Venda do PDV: itens, itens cancelados no caixa, pagamentos, devoluções e auditoria', tags: ['PDV'],
    permission: 'pdv.operador.consultar', params: idParams,
  }, async ({ tx, params }) => getPdvSaleById(tx, params.id));

  route(app, {
    method: 'GET', url: '/v1/pdv/cash-movements', summary: 'Movimentos de caixa dos terminais (abertura, suprimento, sangria, fechamento e diferença)', tags: ['PDV'],
    permission: 'pdv.operador.consultar', query: z.object({ establishmentId: z.string().uuid().optional(), pdvId: z.string().max(10).optional(), from: isoDate.optional(),
      to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(1000).default(300) }),
  }, async ({ tx, query }) => listPdvCash(tx, { establishmentId: query.establishmentId ?? null, pdvId: query.pdvId ?? null, from: query.from ?? null, to: query.to ?? null, limit: query.limit }));

  // ---------------------------------------------------------------- administração no ERP
  route(app, {
    method: 'GET', url: '/v1/pdv/terminals', summary: 'Terminais de PDV com monitoramento (online, última sincronização, pendências, erros, versão)', tags: ['PDV'],
    permission: 'pdv.operador.consultar', query: z.object({ establishmentId: z.string().uuid().optional() }),
  }, async ({ tx, query }) => listTerminals(tx, query.establishmentId ?? null));

  route(app, {
    method: 'POST', url: '/v1/pdv/terminals', summary: 'Cadastra terminal de PDV e gera a chave de API dele (mostrada uma única vez)', tags: ['PDV'],
    permission: 'pdv.terminal.gerenciar', status: 201, body: z.object({ establishmentId: z.string().uuid(), code: terminalCode, name: z.string().min(2).max(60) }),
  }, async ({ tx, ctx, body }) => {
    assertEstablishmentScope(ctx, body.establishmentId);
    return createTerminal(tx, body);
  });

  route(app, {
    method: 'POST', url: '/v1/pdv/terminals/:id/rotate-key', summary: 'Gera nova chave do terminal e revoga a anterior (mostrada uma única vez)', tags: ['PDV'],
    permission: 'pdv.terminal.gerenciar', params: idParams,
  }, async ({ tx, params }) => rotateTerminalKey(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/pdv/terminals/:id/block', summary: 'Bloqueia terminal (revoga a chave)', tags: ['PDV'], permission: 'pdv.terminal.gerenciar', params: idParams,
  }, async ({ tx, params }) => setTerminalStatus(tx, params.id, 'blocked'));

  route(app, {
    method: 'GET', url: '/v1/pdv/settings', summary: 'Parâmetros do PDV da loja', tags: ['PDV'], permission: 'pdv.operador.consultar', query: z.object({ establishmentId: z.string().uuid() }),
  }, async ({ tx, ctx, query }) => {
    assertEstablishmentScope(ctx, query.establishmentId);
    return getSettings(tx, query.establishmentId);
  });

  route(app, {
    method: 'PUT', url: '/v1/pdv/settings', summary: 'Define parâmetros do PDV da loja (limites, estoque, pagamentos, recibo, balança)', tags: ['PDV'], permission: 'pdv.terminal.gerenciar',
    query: z.object({ establishmentId: z.string().uuid() }), body: z.record(z.string(), z.unknown()),
  }, async ({ tx, ctx, query, body }) => {
    assertEstablishmentScope(ctx, query.establishmentId);
    return putSettings(tx, query.establishmentId, body);
  });

  route(app, {
    method: 'PUT', url: '/v1/users/:id/pdv-operator', summary: 'Habilita o usuário no PDV: login curto e PIN de 6 dígitos', tags: ['PDV'], permission: 'pdv.terminal.gerenciar',
    params: idParams, body: pdvOperatorSchema,
  }, async ({ tx, params, body }) => setOperator(tx, params.id, body));
}
