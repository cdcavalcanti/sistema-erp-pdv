import { D } from '@vortex/money';
import type { BetaMessageParam, BetaTool, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { RequestContext, Tx } from '../../db/tx.js';
import { has } from '../../core/access.js';
import { AppError } from '../../errors.js';
import { similarity, tokens } from '../purchasing/receiving.js';
import { catalog, resolveRelative, runReport } from '../reports/service.js';
import { ownerDashboard } from '../reports/dashboard.js';
import type { AiModel } from './model.js';
import { callAi, redact, restore, responseText, type PiiMap } from './runtime.js';

const MAX_TURNS = 6;
const MAX_ROWS = 40;

export const TOOLS: BetaTool[] = [
  {
    name: 'list_establishments', strict: true,
    description: 'Lista as filiais (estabelecimentos) da empresa que o usuário pode ver, com id, código e nome. Use para descobrir o id da "filial 2" ou de uma filial pelo nome.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_products', strict: true,
    description: 'Busca produtos do cadastro por parte da descrição, SKU ou GTIN. Devolve id, sku e descrição (até 10).',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'list_reports', strict: true,
    description: 'Lista os relatórios que o usuário pode executar, com código, título e descrição.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_report', strict: true,
    description: 'Executa um relatório de leitura pelo código. paramsJson é um objeto JSON em texto com os parâmetros, por exemplo '
      + '{"from":"2026-09-01","to":"2026-09-30","groupBy":"product","establishmentId":"<uuid>"}. Datas no formato AAAA-MM-DD. '
      + 'Para "quanto vendi de X" use vendas.por_periodo com groupBy "product" e procure o produto nas linhas.',
    input_schema: { type: 'object', properties: { code: { type: 'string' }, paramsJson: { type: 'string' } }, required: ['code', 'paramsJson'], additionalProperties: false },
  },
  {
    name: 'owner_dashboard', strict: true,
    description: 'Painel do dono: faturamento, margem, caixa, inadimplência, estoque parado e alertas do dia.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function establishments(tx: Tx, ctx: RequestContext) {
  return tx.query<{ id: string; code: string; name: string }>(
    `SELECT id, code, coalesce(trade_name, legal_name) AS name FROM core.establishments WHERE company_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY code`,
    [ctx.companyId, ctx.establishmentIds]);
}

async function searchProducts(tx: Tx, q: string) {
  const like = `%${q.trim().toLowerCase()}%`;
  return tx.query<{ id: string; sku: string; description: string }>(
    `SELECT id, sku, description FROM catalog.products WHERE status = 'active' AND (lower(description) LIKE $1 OR lower(sku) LIKE $1 OR gtin = $2) ORDER BY sku LIMIT 10`, [like, q.trim()]);
}

/** Ferramentas só de leitura (RN-IA-01), executadas com o contexto e as permissões do usuário. */
export async function runTool(tx: Tx, ctx: RequestContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === 'list_establishments') return establishments(tx, ctx);
  if (name === 'search_products') return searchProducts(tx, String(input.query ?? ''));
  if (name === 'list_reports') return catalog(ctx).filter((r) => !r.heavy).map((r) => ({ code: r.code, title: r.title, description: r.description }));
  if (name === 'run_report') {
    let params: unknown;
    try {
      params = JSON.parse(String(input.paramsJson ?? '{}'));
    } catch {
      throw new Error('paramsJson não é um JSON válido');
    }
    const r = await runReport(tx, ctx, String(input.code), params);
    return { title: r.title, params: r.params, columns: r.columns.map((c) => c.key), rows: r.rows.slice(0, MAX_ROWS), truncated: r.rows.length > MAX_ROWS, totalRows: r.rows.length };
  }
  if (name === 'owner_dashboard') {
    if (!has(ctx, 'relatorios.painel.ler')) throw new Error('Sem permissão para o painel do dono');
    return ownerDashboard(tx, ctx);
  }
  throw new Error(`Ferramenta desconhecida: ${name}`);
}

export interface Answer {
  answer: string | null;
  source: 'ai' | 'rules';
  toolCalls: { name: string; input: unknown; ok: boolean }[];
  data?: unknown;
  suggestions?: { code: string; title: string }[];
}

/**
 * Perguntas em linguagem natural (seção 20): "Quanto vendi de X no mês passado na filial 2?"
 * respondida com consultas de leitura controladas, respeitando permissões e tenant. O modelo
 * só enxerga o que as ferramentas devolvem para este usuário.
 */
export async function ask(tx: Tx, ctx: RequestContext, ai: AiModel, question: string, today = new Date()): Promise<Answer> {
  if (!ai.available()) return askByRules(tx, ctx, question, today);
  const pii: PiiMap = new Map();
  const toolCalls: Answer['toolCalls'] = [];
  const localToday = new Date(today.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
  const messages: BetaMessageParam[] = [{ role: 'user', content: question }];
  const system = `Você é o assistente do ERP VORTEX e responde perguntas sobre os dados da empresa em português do Brasil. Hoje é ${localToday}. `
    + 'Use as ferramentas para consultar os dados; nunca invente números. Se não tiver permissão ou o dado não existir, diga isso. '
    + 'Responda de forma curta, com valores em reais no formato R$ 1.234,56 e o período considerado.';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const call = await callAi(tx, ai, 'perguntas', { max_tokens: 4000, output_config: { effort: 'medium' }, system, tools: TOOLS, tool_choice: { type: 'auto' }, messages }, pii);
    if (!call.response) {
      const fallback = await askByRules(tx, ctx, question, today);
      return { ...fallback, toolCalls };
    }
    const res = call.response;
    if (res.stop_reason !== 'tool_use') return { answer: responseText(call), source: 'ai', toolCalls };
    messages.push({ role: 'assistant', content: res.content as never });
    const results: BetaToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue;
      // O modelo vê marcadores no lugar de dados pessoais; a ferramenta recebe os valores reais
      const input = JSON.parse(restore(JSON.stringify(block.input ?? {}), pii)) as Record<string, unknown>;
      try {
        const out = await tx.savepoint(() => runTool(tx, ctx, block.name, input));
        toolCalls.push({ name: block.name, input, ok: true });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: redact(JSON.stringify(out), pii) });
      } catch (err) {
        toolCalls.push({ name: block.name, input, ok: false });
        const msg = err instanceof AppError ? `${err.message}${err.details ? ` ${JSON.stringify(err.details)}` : ''}` : err instanceof Error ? err.message : String(err);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: msg, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'Não consegui concluir a consulta. Tente uma pergunta mais específica.', source: 'ai', toolCalls };
}

// ------------------------------------------------------------------ sem IA: regras simples

const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const brl = (v: string) => `R$ ${D(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '#').replace('.', ',').replace(/#/g, '.')}`;
const br = (d: string) => d.split('-').reverse().join('/');

export function periodFrom(question: string, today = new Date()): { from: string; to: string; label: string } {
  const q = norm(question);
  const local = new Date(today.getTime() - 3 * 3_600_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  if (/mes passado|mes anterior|ultimo mes/.test(q)) return { ...resolveRelative('previous_month', today)!, label: 'no mês passado' };
  if (/\bontem\b/.test(q)) return { ...resolveRelative('yesterday', today)!, label: 'ontem' };
  if (/\bhoje\b/.test(q)) return { from: iso(local), to: iso(local), label: 'hoje' };
  if (/ultimos 7 dias|ultima semana|semana passada/.test(q)) return { ...resolveRelative('last_7_days', today)!, label: 'nos últimos 7 dias' };
  if (/este ano|neste ano|no ano/.test(q)) return { from: `${local.getUTCFullYear()}-01-01`, to: iso(local), label: 'neste ano' };
  const m = MONTHS.findIndex((x) => new RegExp(`\\b${x}\\b`).test(q));
  if (m >= 0) {
    const y = m > local.getUTCMonth() ? local.getUTCFullYear() - 1 : local.getUTCFullYear();
    const last = new Date(Date.UTC(y, m + 1, 0));
    return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(last), label: `em ${MONTHS[m]}` };
  }
  return { ...resolveRelative('current_month', today)!, label: 'neste mês' };
}

export async function askByRules(tx: Tx, ctx: RequestContext, question: string, today: Date): Promise<Answer> {
  const q = norm(question);
  const period = periodFrom(question, today);
  const toolCalls: Answer['toolCalls'] = [];
  if (/\b(vend|fatur)/.test(q) && has(ctx, 'vendas.pedido.ler')) {
    const ests = await establishments(tx, ctx);
    let est: { id: string; code: string; name: string } | undefined;
    const fil = /\bfilial\s+(\d+)\b/.exec(q);
    if (fil) est = ests.find((e) => e.code === fil[1] || Number(e.code) === Number(fil[1])) ?? ests[Number(fil[1]) - 1];
    est ??= ests.find((e) => q.includes(norm(e.name)) && ests.length > 1);
    // Produto: o mais parecido com as palavras da pergunta
    const qt = tokens(question);
    const words = [...qt].filter((t) => t.length >= 3 && !/^(quanto|vendi|vendemos|vendeu|vendas|filial|passado|anterior|mes|hoje|ontem|ano|semana|dias|ultimos|faturei|faturamento)$/.test(t));
    let product: { id: string; sku: string; description: string } | null = null;
    let best = 0;
    for (const w of words) {
      for (const p of await searchProducts(tx, w)) {
        const s = similarity(qt, tokens(`${p.sku} ${p.description}`));
        if (s > best) {
          best = s;
          product = p;
        }
      }
    }
    const params = { from: period.from, to: period.to, groupBy: product ? 'product' : 'establishment', ...(est ? { establishmentId: est.id } : {}) };
    const r = await runReport(tx, ctx, 'vendas.por_periodo', params);
    toolCalls.push({ name: 'run_report', input: { code: 'vendas.por_periodo', params }, ok: true });
    const where = est ? ` na filial ${est.code} (${est.name})` : '';
    const range = `de ${br(period.from)} a ${br(period.to)}`;
    if (product) {
      const row = r.rows.find((x) => String(x.group).startsWith(`${product!.sku} — `));
      const qty = D(String(row?.quantity ?? 0));
      return { source: 'rules', toolCalls, data: row ?? null,
        answer: `Você vendeu ${qty.toString().replace('.', ',')} ${qty.equals(1) ? 'unidade' : 'unidades'} de ${product.description} ${period.label}${where} (${range}), somando ${brl(String(row?.revenue ?? 0))}.` };
    }
    const total = r.rows.reduce((a, x) => a.plus(String(x.revenue ?? 0)), D(0));
    return { source: 'rules', toolCalls, data: r.rows, answer: `O faturamento ${period.label}${where} (${range}) foi de ${brl(total.toFixed(2))}.` };
  }
  // Sem intenção reconhecida: sugere os relatórios mais próximos da pergunta
  const qt = tokens(question);
  const suggestions = catalog(ctx).map((r) => ({ code: r.code, title: r.title, s: similarity(qt, tokens(`${r.title} ${r.description}`)) }))
    .filter((r) => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 3).map(({ code, title }) => ({ code, title }));
  return { source: 'rules', toolCalls, answer: null, suggestions };
}
