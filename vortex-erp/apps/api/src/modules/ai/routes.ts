import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate } from '../../http/schemas.js';
import { requirePerm } from '../../core/access.js';
import { validation } from '../../errors.js';
import { ask } from './ask.js';
import { chat, deleteConversation, getConversation, listConversations } from './chat.js';
import { classifyProduct } from './ncm.js';
import { readDocument } from './documents.js';
import { suggestReceiptMatches } from './matching.js';
import { negotiate } from './collection-agent.js';
import { forecastDemand } from './forecast.js';
import { detectAnomalies } from './anomalies.js';
import { confirmDraft, discardDraft, listDrafts } from './drafts.js';

const tags = ['IA'];
const P = 'ia.assistente.usar';

export function registerAiRoutes(app: App) {
  route(app, {
    method: 'POST', url: '/v1/ai/ask', summary: 'Pergunta em linguagem natural (consultas só de leitura, com as permissões do usuário)', tags, permission: P, company: true,
    body: z.object({ question: z.string().min(3).max(1000) }),
  }, async ({ tx, ctx, body, deps }) => ask(tx, ctx, deps.services.ai, body.question));

  route(app, {
    method: 'POST', url: '/v1/ai/chat', summary: 'Chat com a assistente (várias rodadas; consultas só de leitura com as permissões do usuário)', tags, permission: P, company: true,
    body: z.object({ conversationId: z.string().uuid().nullish(), message: z.string().trim().min(1).max(4000) }),
  }, async ({ tx, ctx, body, deps }) => chat(tx, ctx, deps.services.ai, body));

  route(app, { method: 'GET', url: '/v1/ai/conversations', summary: 'Conversas do usuário com a assistente', tags, permission: P }, async ({ tx }) => listConversations(tx));
  route(app, { method: 'GET', url: '/v1/ai/conversations/:id', summary: 'Conversa com as mensagens', tags, permission: P, params: idParams }, async ({ tx, params }) => getConversation(tx, params.id));
  route(app, { method: 'DELETE', url: '/v1/ai/conversations/:id', summary: 'Apaga a conversa', tags, permission: P, params: idParams }, async ({ tx, params }) => deleteConversation(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/ai/classify-product', summary: 'Sugere NCM, CEST e cClassTrib (rascunho para o contador aprovar)', tags, permission: P, status: 201, company: true,
    body: z.object({ productId: z.string().uuid().nullish(), description: z.string().min(3).max(120).nullish() }),
  }, async ({ tx, ctx, body, deps }) => {
    requirePerm(ctx, 'produtos.produto.ler');
    return classifyProduct(tx, deps.services.ai, body);
  });

  route(app, {
    method: 'POST', url: '/v1/ai/read-document', summary: 'Lê boleto, recibo ou nota (PDF/foto) e cria o rascunho do título a pagar', tags, permission: P, status: 201, company: true,
    body: z.object({ fileBase64: z.string().max(14_000_000).nullish(), contentType: z.string().nullish(), text: z.string().max(50_000).nullish(), fileName: z.string().max(200).nullish() }),
  }, async ({ tx, ctx, body, deps }) => {
    requirePerm(ctx, 'financeiro.titulo.ler');
    return readDocument(tx, deps.services, body);
  });

  route(app, {
    method: 'POST', url: '/v1/ai/receipts/:id/suggest-matches', summary: 'De-para inteligente: sugere o produto interno de cada item do XML', tags, permission: P, params: idParams, company: true,
  }, async ({ tx, ctx, params, deps }) => {
    requirePerm(ctx, 'compras.recebimento.criar');
    return suggestReceiptMatches(tx, deps.services.ai, params.id);
  });

  const negotiateBody = z.object({
    partyId: z.string().uuid(), titleIds: z.array(z.string().uuid()).nullish(), customerMessage: z.string().max(2000).nullish(), send: z.boolean().optional(),
    requested: z.object({ installments: z.number().int().min(1).max(60).nullish(), discountPercent: decimal({ min: 0 }).nullish(), firstDueInDays: z.number().int().min(0).max(90).nullish() }).nullish(),
  });
  route(app, {
    method: 'POST', url: '/v1/ai/collection/negotiate', summary: 'Agente de cobrança: proposta dentro dos limites, Pix e acordo para aprovação', tags, permission: P, status: 201, company: true,
    body: negotiateBody,
  }, async ({ tx, ctx, body, deps }) => {
    requirePerm(ctx, 'financeiro.titulo.ler');
    return negotiate(tx, deps.services, body);
  });

  route(app, {
    method: 'POST', url: '/v1/ai/collection/whatsapp', summary: 'Mensagem recebida no WhatsApp de cobrança (integração VORTEX): responde com a proposta', tags, permission: P, status: 201, company: true,
    body: z.object({ from: z.string().min(8), text: z.string().min(1).max(2000) }),
  }, async ({ tx, ctx, body, deps }) => {
    requirePerm(ctx, 'financeiro.titulo.ler');
    const digits = body.from.replace(/\D/g, '');
    const c = await tx.maybeOne<{ party_id: string }>(
      `SELECT c.party_id FROM registry.party_contacts c WHERE regexp_replace(c.whatsapp, '\\D', '', 'g') IN ($1, right($1, 11), right($1, 10))
          AND EXISTS (SELECT 1 FROM finance.titles t WHERE t.party_id = c.party_id AND t.kind = 'receivable' AND t.status IN ('open','partially_paid')) LIMIT 1`, [digits]);
    if (!c) throw validation({ from: 'Número sem cliente com títulos em aberto' });
    return negotiate(tx, deps.services, { partyId: c.party_id, customerMessage: body.text, send: true });
  });

  route(app, {
    method: 'POST', url: '/v1/ai/demand-forecast', summary: 'Previsão de demanda com sazonalidade e promoções; gera a sugestão de compra', tags, permission: P, status: 201, company: true,
    body: z.object({ warehouseId: z.string().uuid(), horizonDays: z.number().int().min(7).max(180).optional(),
      promotions: z.array(z.object({ productId: z.string().uuid(), upliftPercent: decimal({ min: 0 }) })).nullish() }),
  }, async ({ tx, ctx, body }) => {
    requirePerm(ctx, 'compras.pedido.ler');
    return forecastDemand(tx, body);
  });

  route(app, {
    method: 'GET', url: '/v1/ai/drafts', summary: 'Rascunhos criados pela IA aguardando confirmação', tags, permission: P,
    query: z.object({ status: z.enum(['pending', 'confirmed', 'discarded']).optional(), kind: z.string().optional() }),
  }, async ({ tx, query }) => listDrafts(tx, query));

  route(app, {
    method: 'POST', url: '/v1/ai/drafts/:id/confirm', summary: 'Confirma o rascunho (com ajustes); exige a mesma permissão da ação manual', tags, permission: P, params: idParams,
    body: z.object({ overrides: z.record(z.string(), z.any()).optional() }).optional(),
  }, async ({ tx, ctx, params, body }) => confirmDraft(tx, ctx, params.id, body?.overrides ?? {}));

  route(app, { method: 'POST', url: '/v1/ai/drafts/:id/discard', summary: 'Descarta o rascunho', tags, permission: P, params: idParams },
    async ({ tx, params }) => discardDraft(tx, params.id));

  route(app, {
    method: 'GET', url: '/v1/ai/anomalies', summary: 'Anomalias detectadas', tags, permission: P,
    query: z.object({ status: z.enum(['open', 'dismissed', 'resolved']).optional() }),
  }, async ({ tx, query }) => tx.query(`SELECT * FROM ai.anomalies WHERE ($1::text IS NULL OR status = $1) ORDER BY detected_at DESC LIMIT 200`, [query.status ?? null]));

  route(app, { method: 'POST', url: '/v1/ai/anomalies/scan', summary: 'Executa a detecção de anomalias agora', tags, permission: P },
    async ({ tx }) => detectAnomalies(tx));

  route(app, {
    method: 'PATCH', url: '/v1/ai/anomalies/:id', summary: 'Marca a anomalia como resolvida ou descartada', tags, permission: P, params: idParams,
    body: z.object({ status: z.enum(['dismissed', 'resolved']) }),
  }, async ({ tx, params, body }) => tx.one(`UPDATE ai.anomalies SET status = $2 WHERE id = $1 RETURNING *`, [params.id, body.status], 'Anomalia'));

  route(app, {
    method: 'GET', url: '/v1/ai/usage', summary: 'Consumo de IA por funcionalidade (tokens e custo, RN-IA-02)', tags, permission: 'relatorios.painel.ler',
    query: z.object({ from: isoDate, to: isoDate }),
  }, async ({ tx, query }) => tx.query(
    `SELECT feature, status, count(*)::int AS calls, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens, sum(cost_usd) AS cost_usd
       FROM ai.calls WHERE created_at >= $1::date AND created_at < $2::date + 1 GROUP BY 1, 2 ORDER BY 1, 2`, [query.from, query.to]));
}
