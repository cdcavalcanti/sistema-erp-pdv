import { D } from '@vortex/money';
import type { BetaMessageParam, BetaTool, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { RequestContext, Tx } from '../../db/tx.js';
import { has } from '../../core/access.js';
import { AppError, notFound } from '../../errors.js';
import { ownerCharts, ownerDashboard } from '../reports/dashboard.js';
import { orderStageCounts, STAGE_EXPR, STAGE_JOIN } from '../sales/orders.js';
import { pdvSalesSummary } from '../pdv/operation.js';
import { taxAssessment } from '../fiscal/assessment.js';
import { supplierOverview } from '../purchasing/suppliers.js';
import { TOOLS as ASK_TOOLS, askByRules, runTool as runAskTool } from './ask.js';
import type { AiModel } from './model.js';
import { callAi, redact, restore, responseText, type PiiMap } from './runtime.js';

/**
 * Chat com a assistente (seção 20): conversa de várias rodadas, com acesso de leitura a toda a
 * operação pelas ferramentas abaixo, sempre com as permissões de quem pergunta (RN-IA-01: a
 * IA só lê). Sem modelo configurado, responde pelas regras (visão geral e perguntas de venda).
 */
const MAX_TURNS = 8;
const HISTORY = 20;
const MAX_ROWS = 40;
const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const dateProp = { type: 'string', description: 'Data AAAA-MM-DD' };

const CHAT_TOOLS: BetaTool[] = [
  ...ASK_TOOLS,
  { name: 'operation_overview', strict: true, input_schema: obj(),
    description: 'Visão geral da operação agora: faturamento do mês × mês anterior, margem, caixa, inadimplência, últimos 7 dias, canais (inclusive PDV), '
      + 'pedidos parados em cada etapa, vendas do PDV de hoje e alertas. Use para "como está a operação", resumos e diagnósticos.' },
  { name: 'sales_charts', strict: true, input_schema: obj({ days: { type: 'integer', description: 'Janela em dias (7 a 365)' } }, ['days']),
    description: 'Faturamento diário (pedidos × PDV), canais, top produtos e top clientes, vencimentos a receber/pagar, saldo de caixa projetado 30 dias e estoque abaixo do ponto de pedido.' },
  { name: 'orders_by_stage', strict: true, input_schema: obj({ from: dateProp, to: dateProp }, ['from', 'to']),
    description: 'Quantidade e valor de pedidos de venda por etapa: open (aguardando aprovação), pending_approval, approved, to_pick (enviado p/ separação), picking, checked, invoiced, shipped, delivered, cancelled.' },
  { name: 'list_orders', strict: true,
    input_schema: obj({ stage: { type: 'string', description: 'Etapa (ex.: approved, invoiced) ou vazio para todas' }, query: { type: 'string', description: 'Cliente ou número; vazio para todos' } }, ['stage', 'query']),
    description: 'Lista até 20 pedidos de venda recentes com número, cliente, total, etapa e data.' },
  { name: 'pdv_sales', strict: true, input_schema: obj({ from: dateProp, to: dateProp }, ['from', 'to']),
    description: 'Vendas da loja física (PDV) no período: total, quantidade, ticket médio, vendas e itens cancelados, por terminal e por operador.' },
  { name: 'tax_assessment', strict: true, input_schema: obj({ from: dateProp, to: dateProp }, ['from', 'to']),
    description: 'Apuração gerencial de impostos: débitos das saídas × créditos das entradas (ICMS, IPI, PIS, Cofins, ISS, IBS, CBS), ST/DIFAL/FCP, ICMS por CFOP e UF; no Simples, a estimativa do DAS.' },
  { name: 'suppliers', strict: true, input_schema: obj({ query: { type: 'string', description: 'Nome ou CNPJ; vazio para todos' } }, ['query']),
    description: 'Fornecedores: compras nos últimos 12 meses, última compra, produtos fornecidos, pedidos de compra em aberto e saldo a pagar.' },
  { name: 'overdue_titles', strict: true, input_schema: obj({ kind: { type: 'string', enum: ['receivable', 'payable'] } }, ['kind']),
    description: 'Títulos vencidos (a receber ou a pagar), maiores primeiro: pessoa, valor em aberto, vencimento e dias de atraso.' },
  { name: 'fiscal_problems', strict: true, input_schema: obj(),
    description: 'Notas com problema: rejeitadas pela SEFAZ e em contingência aguardando autorização (número, destinatário, motivo).' },
];

const today = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;

/** Retrato da operação (ferramenta e resposta sem IA). Cada bloco respeita a permissão de quem pergunta. */
export async function operationOverview(tx: Tx, ctx: RequestContext) {
  const t = today();
  const out: Record<string, unknown> = { date: t };
  if (has(ctx, 'relatorios.painel.ler')) {
    out.dashboard = await ownerDashboard(tx, ctx, t);
    const charts = await ownerCharts(tx, ctx, { date: t, days: 7 });
    out.last7Days = { daily: charts.daily, channels: charts.channels, topProducts: charts.topProducts.slice(0, 5), lowStock: charts.lowStock, cashForecast30: charts.cash.forecast.at(-1) };
  }
  if (has(ctx, 'vendas.pedido.ler')) out.ordersByStage = await orderStageCounts(tx, { from: null, to: null });
  if (has(ctx, 'pdv.operador.consultar')) {
    out.pdvToday = await pdvSalesSummary(tx, { establishmentId: null, pdvId: null, from: t, to: t, status: null, q: null });
  }
  return out;
}

async function runChatTool(tx: Tx, ctx: RequestContext, name: string, input: Record<string, any>): Promise<unknown> {
  const need = (perm: string) => {
    if (!has(ctx, perm)) throw new Error(`Sem permissão (${perm}) para esta consulta`);
  };
  switch (name) {
    case 'operation_overview': return operationOverview(tx, ctx);
    case 'sales_charts': need('relatorios.painel.ler'); return ownerCharts(tx, ctx, { days: Math.min(365, Math.max(7, Number(input.days) || 30)) });
    case 'orders_by_stage': need('vendas.pedido.ler'); return orderStageCounts(tx, { from: input.from || null, to: input.to || null });
    case 'list_orders': {
      need('vendas.pedido.ler');
      return tx.query(
        `SELECT o.number, p.legal_name AS customer, o.total, ${STAGE_EXPR} AS stage, o.created_at::date AS date FROM sales.orders o JOIN registry.parties p ON p.id = o.party_id ${STAGE_JOIN}
          WHERE ($1::uuid IS NULL OR o.company_id = $1) AND ($2::text = '' OR ${STAGE_EXPR} = $2)
            AND ($3::text = '' OR o.number::text = $3 OR p.legal_name ILIKE '%' || $3 || '%') ORDER BY o.created_at DESC LIMIT 20`,
        [ctx.companyId, String(input.stage ?? ''), String(input.query ?? '')]);
    }
    case 'pdv_sales': need('pdv.operador.consultar'); return pdvSalesSummary(tx, { establishmentId: null, pdvId: null, from: input.from, to: input.to, status: null, q: null });
    case 'tax_assessment': need('fiscal.nota.ler'); return taxAssessment(tx, ctx, { from: input.from, to: input.to, establishmentId: null });
    case 'suppliers': need('compras.pedido.ler'); return (await supplierOverview(tx, ctx.companyId, String(input.query ?? '') || null)).slice(0, MAX_ROWS);
    case 'overdue_titles': {
      need('financeiro.titulo.ler');
      return tx.query(
        `SELECT p.legal_name AS party, t.document_number, t.balance, t.due_date, (current_date - t.due_date) AS days_late FROM finance.titles t JOIN registry.parties p ON p.id = t.party_id
          WHERE t.kind = $2 AND t.status IN ('open', 'partially_paid') AND t.due_date < current_date AND ($1::uuid IS NULL OR t.company_id = $1)
          ORDER BY t.balance DESC LIMIT ${MAX_ROWS}`, [ctx.companyId, input.kind === 'payable' ? 'payable' : 'receivable']);
    }
    case 'fiscal_problems': {
      need('fiscal.nota.ler');
      return tx.query(
        `SELECT model, series, number, status, recipient_name, total_invoice, sefaz_message, rejection_explanation, issued_at FROM fiscal.documents
          WHERE status IN ('rejeitada', 'contingencia') AND ($1::uuid IS NULL OR company_id = $1) ORDER BY created_at DESC LIMIT 30`, [ctx.companyId]);
    }
    default: return runAskTool(tx, ctx, name, input);
  }
}

// ------------------------------------------------------------------ conversas

export async function listConversations(tx: Tx) {
  return tx.query(
    `SELECT c.id, c.title, c.updated_at, (SELECT count(*) FROM ai.messages m WHERE m.conversation_id = c.id)::int AS messages
       FROM ai.conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 100`, [tx.userId]);
}

export async function getConversation(tx: Tx, id: string) {
  const c = await tx.maybeOne(`SELECT id, title, created_at, updated_at FROM ai.conversations WHERE id = $1 AND user_id = $2`, [id, tx.userId]);
  if (!c) throw notFound('Conversa');
  const messages = await tx.query(`SELECT id, role, content, source, tool_calls, created_at FROM ai.messages WHERE conversation_id = $1 ORDER BY created_at, id`, [id]);
  return { ...c, messages };
}

export async function deleteConversation(tx: Tx, id: string) {
  const r = await tx.exec(`DELETE FROM ai.conversations WHERE id = $1 AND user_id = $2`, [id, tx.userId]);
  if (!r) throw notFound('Conversa');
  return { deleted: true };
}

export interface ChatReply { conversationId: string; title: string; message: { id: string; role: 'assistant'; content: string; source: 'ai' | 'rules'; tool_calls: unknown[]; created_at: string } }

/** Uma rodada do chat: grava a pergunta, consulta o que precisar e grava a resposta. */
export async function chat(tx: Tx, ctx: RequestContext, ai: AiModel, input: { conversationId?: string | null; message: string }): Promise<ChatReply> {
  const text = input.message.trim();
  let conv = input.conversationId
    ? await tx.maybeOne<{ id: string; title: string }>(`SELECT id, title FROM ai.conversations WHERE id = $1 AND user_id = $2`, [input.conversationId, tx.userId])
    : null;
  if (input.conversationId && !conv) throw notFound('Conversa');
  conv ??= await tx.one<{ id: string; title: string }>(
    `INSERT INTO ai.conversations (tenant_id, company_id, user_id, title) VALUES ($1,$2,$3,$4) RETURNING id, title`,
    [tx.tenantId, ctx.companyId ?? null, tx.userId, text.length > 60 ? `${text.slice(0, 57)}…` : text]);
  const history = await tx.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content FROM (SELECT role, content, created_at, id FROM ai.messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${HISTORY}) h ORDER BY created_at, id`,
    [conv.id]);
  // clock_timestamp: pergunta e resposta da mesma rodada ficam em ordem (now() é o mesmo na transação)
  await tx.exec(`INSERT INTO ai.messages (tenant_id, conversation_id, role, content, created_at) VALUES ($1,$2,'user',$3,clock_timestamp())`, [tx.tenantId, conv.id, text]);

  const reply = ai.available() ? await chatWithModel(tx, ctx, ai, history, text) : null;
  const final = reply ?? await chatByRules(tx, ctx, text);
  const saved = await tx.one<ChatReply['message']>(
    `INSERT INTO ai.messages (tenant_id, conversation_id, role, content, source, tool_calls, created_at) VALUES ($1,$2,'assistant',$3,$4,$5,clock_timestamp())
     RETURNING id, role, content, source, tool_calls, created_at`, [tx.tenantId, conv.id, final.content, final.source, JSON.stringify(final.toolCalls)]);
  await tx.exec(`UPDATE ai.conversations SET updated_at = now() WHERE id = $1`, [conv.id]);
  return { conversationId: conv.id, title: conv.title, message: saved };
}

async function chatWithModel(tx: Tx, ctx: RequestContext, ai: AiModel, history: { role: 'user' | 'assistant'; content: string }[], text: string) {
  const pii: PiiMap = new Map();
  const toolCalls: { name: string; input: unknown; ok: boolean }[] = [];
  const messages: BetaMessageParam[] = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: text }];
  const system = `Você é a assistente do VORTEX ERP e conversa com quem administra a empresa, em português do Brasil. Hoje é ${today()}. `
    + 'Você tem acesso de leitura a vendas, pedidos e suas etapas, PDV, estoque, compras e fornecedores, financeiro, impostos e notas, sempre pelas ferramentas. '
    + 'Nunca invente números: consulte. Se não tiver permissão ou o dado não existir, diga. Você não altera nada no sistema; quando fizer sentido, sugira a ação e onde fazê-la no ERP. '
    + 'Para pedidos de visão geral, use operation_overview e destaque o que pede atenção. Responda de forma objetiva, em Markdown simples (títulos curtos, listas e tabelas pequenas), '
    + 'com valores no formato R$ 1.234,56 e o período considerado.';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const call = await callAi(tx, ai, 'chat', { max_tokens: 6000, output_config: { effort: 'medium' }, system, tools: CHAT_TOOLS, tool_choice: { type: 'auto' }, messages }, pii);
    if (!call.response) return null;
    const res = call.response;
    if (res.stop_reason !== 'tool_use') return { content: responseText(call) ?? 'Não consegui formular uma resposta.', source: 'ai' as const, toolCalls };
    messages.push({ role: 'assistant', content: res.content as never });
    const results: BetaToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      const toolInput = JSON.parse(restore(JSON.stringify(block.input ?? {}), pii)) as Record<string, unknown>;
      try {
        const out = await tx.savepoint(() => runChatTool(tx, ctx, block.name, toolInput));
        toolCalls.push({ name: block.name, input: toolInput, ok: true });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: redact(JSON.stringify(out), pii) });
      } catch (err) {
        toolCalls.push({ name: block.name, input: toolInput, ok: false });
        const msg = err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: msg, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { content: 'Não consegui concluir a consulta. Tente uma pergunta mais específica.', source: 'ai' as const, toolCalls };
}

// ------------------------------------------------------------------ sem IA: regras

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const brl = (v: string | number) => `${D(v).isNegative() ? '−' : ''}R$ ${D(v).abs().toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '#').replace('.', ',').replace(/#/g, '.')}`;
const STAGE_PT: Record<string, string> = {
  open: 'aguardando envio para aprovação', pending_approval: 'aguardando aprovação', approved: 'aprovados aguardando separação', to_pick: 'enviados para separação',
  picking: 'em separação', checked: 'separados aguardando faturamento', invoiced: 'faturados aguardando despacho', shipped: 'despachados aguardando entrega',
};

async function chatByRules(tx: Tx, ctx: RequestContext, text: string) {
  const q = norm(text);
  if (/(como (esta|vai|anda)|visao geral|overview|resumo|panorama|operacao|situacao|diagnostico|bom dia|boa tarde|boa noite|^oi\b|^ola\b)/.test(q)) {
    return { content: await overviewText(tx, ctx), source: 'rules' as const, toolCalls: [{ name: 'operation_overview', input: {}, ok: true }] };
  }
  const a = await askByRules(tx, ctx, text, new Date());
  if (a.answer) return { content: a.answer, source: 'rules' as const, toolCalls: a.toolCalls };
  const hint = a.suggestions?.length ? `\n\nRelatórios que podem ajudar: ${a.suggestions.map((s) => `**${s.title}**`).join(', ')} (em Relatórios).` : '';
  return {
    source: 'rules' as const, toolCalls: a.toolCalls,
    content: 'Sem a IA configurada eu respondo a visão geral da operação ("como está a operação?") e perguntas de venda e faturamento '
      + '("quanto vendi este mês?", "quanto vendi de camiseta em setembro?"). Para conversar sobre qualquer assunto, configure a chave da IA (ANTHROPIC_API_KEY) no servidor do ERP.' + hint,
  };
}

/** Visão geral em texto (Markdown), montada sem IA a partir do retrato da operação. */
export async function overviewText(tx: Tx, ctx: RequestContext): Promise<string> {
  const o = await operationOverview(tx, ctx) as Record<string, any>;
  const lines: string[] = [`## Como está a operação — ${o.date.split('-').reverse().join('/')}`];
  if (o.dashboard) {
    const d = o.dashboard;
    const v = Number(d.revenue.variationPercent);
    lines.push('', '**Vendas e resultado**',
      `- Faturamento do mês: ${brl(d.revenue.month)} (${D(d.revenue.previousMonth).isZero() ? 'sem vendas no mês anterior para comparar' : `${v >= 0 ? '+' : ''}${v.toFixed(1).replace('.', ',')}% sobre o mês anterior`}, ${d.revenue.documents} notas, ticket médio ${brl(d.revenue.averageTicket)})`,
      `- Margem bruta: ${brl(d.margin.value)} (${String(d.margin.percent).replace('.', ',')}%)`,
      `- Caixa disponível: ${brl(d.cash.available)}`,
      `- Inadimplência: ${brl(d.delinquency.overdue)} vencidos de ${brl(d.delinquency.open)} a receber`);
    const week = (o.last7Days.daily as any[]).reduce((s, x) => s.plus(x.orders).plus(x.pdv), D(0));
    const pdv = (o.last7Days.daily as any[]).reduce((s, x) => s.plus(x.pdv), D(0));
    lines.push(`- Últimos 7 dias: ${brl(week.toFixed(2))}${week.greaterThan(0) ? ` (${pdv.dividedBy(week).times(100).toFixed(0)}% na loja física)` : ''}`);
    if (o.last7Days.topProducts.length) lines.push(`- Mais vendidos na semana: ${(o.last7Days.topProducts as any[]).slice(0, 3).map((p) => p.description).join(', ')}`);
    if (o.last7Days.cashForecast30) lines.push(`- Saldo projetado em 30 dias: ${brl(o.last7Days.cashForecast30.balance)}`);
  }
  if (o.ordersByStage) {
    const pending = (o.ordersByStage as any[]).filter((s) => STAGE_PT[s.stage] && s.orders > 0);
    if (pending.length) lines.push('', '**Pedidos em andamento**', ...pending.map((s) => `- ${s.orders} ${STAGE_PT[s.stage]} (${brl(s.total)})`));
  }
  if (o.pdvToday) {
    const p = o.pdvToday;
    lines.push('', '**Loja física (PDV) hoje**', `- ${p.sales} vendas, ${brl(p.total)}, ticket médio ${brl(p.averageTicket)}`
      + `${p.cancelled_sales ? `, ${p.cancelled_sales} cancelada(s)` : ''}${p.cancelled_items ? `, ${p.cancelled_items} item(ns) cancelado(s) no caixa` : ''}`);
  }
  const alerts = (o.dashboard?.alerts ?? []) as { title: string; count: number; severity: string }[];
  const low = (o.last7Days?.lowStock ?? []) as any[];
  if (alerts.length || low.length) {
    lines.push('', '**Pede atenção**', ...alerts.map((a) => `- ${a.severity === 'critical' ? '🔴' : '🟡'} ${a.title}: ${a.count}`));
    if (low.length) lines.push(`- 🟡 ${low.length} produto(s) no ponto de pedido ou abaixo: ${low.slice(0, 4).map((p) => p.description).join(', ')}`);
  }
  if (lines.length === 1) lines.push('', 'Você não tem permissão para os indicadores da empresa. Peça ao administrador o acesso ao painel.');
  return lines.join('\n');
}
