import { isValidCNPJ, isValidCPF } from '@vortex/validators';
import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Tx } from '../../db/tx.js';
import { emit } from '../../core/outbox.js';
import { aiCost, type AiModel, type AiRequest, type AiResponse } from './model.js';

// ------------------------------------------------------------------ RN-IA-03: minimização de dados pessoais

/** Mapa placeholder → valor original, para devolver os dados à resposta sem que saiam do ERP. */
export type PiiMap = Map<string, string>;

const PATTERNS: { kind: string; re: RegExp; valid?: (v: string) => boolean }[] = [
  { kind: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'CNPJ', re: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, valid: isValidCNPJ },
  { kind: 'CPF', re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, valid: isValidCPF },
  { kind: 'TELEFONE', re: /(?:\+?55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g },
];

/**
 * Troca CPF, CNPJ, e-mail e telefone por marcadores antes de enviar ao modelo. O mesmo valor
 * recebe sempre o mesmo marcador na conversa, então o modelo ainda consegue relacionar dados.
 */
export function redact(text: string, map: PiiMap): string {
  const reverse = new Map([...map].map(([k, v]) => [v, k]));
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => {
      if (/^\[[A-Z]+_\d+\]$/.test(m)) return m;
      if (p.valid && !p.valid(m)) return m;
      if (p.kind === 'TELEFONE' && m.replace(/\D/g, '').length < 10) return m;
      const known = reverse.get(m);
      if (known) return known;
      const tag = `[${p.kind}_${[...map.keys()].filter((k) => k.startsWith(`[${p.kind}_`)).length + 1}]`;
      map.set(tag, m);
      reverse.set(m, tag);
      return tag;
    });
  }
  return out;
}

export function restore(text: string, map: PiiMap): string {
  let out = text;
  for (const [tag, value] of map) out = out.split(tag).join(value);
  return out;
}

function redactBlocks(content: string | BetaContentBlockParam[], map: PiiMap): string | BetaContentBlockParam[] {
  if (typeof content === 'string') return redact(content, map);
  return content.map((b) => {
    if (b.type === 'text') return { ...b, text: redact(b.text, map) };
    if (b.type === 'tool_result' && typeof b.content === 'string') return { ...b, content: redact(b.content, map) };
    if (b.type === 'tool_result' && Array.isArray(b.content)) {
      return { ...b, content: b.content.map((c) => (c.type === 'text' ? { ...c, text: redact(c.text, map) } : c)) };
    }
    return b;
  });
}

export function redactRequest(req: AiRequest, map: PiiMap): AiRequest {
  const system = typeof req.system === 'string' ? redact(req.system, map) : req.system?.map((b) => ({ ...b, text: redact(b.text, map) }));
  const messages = req.messages.map((m) => ({ ...m, content: redactBlocks(m.content as never, map) }) as BetaMessageParam);
  return { ...req, ...(system !== undefined ? { system } : {}), messages };
}

// ------------------------------------------------------------------ RN-IA-02: toda chamada é registrada

export interface AiCall {
  callId: string;
  status: 'ok' | 'refused' | 'error' | 'unavailable';
  response: AiResponse | null;
  pii: PiiMap;
}

/**
 * Chamada ao modelo com registro de tenant, usuário, tokens, custo e resultado (ai.calls) e
 * evento ia.consumo para o VORTEX Meter. Nunca lança: falha do modelo devolve status ≠ ok e a
 * funcionalidade segue pelo caminho de regras. O contexto enviado é só do tenant da transação.
 */
export async function callAi(tx: Tx, ai: AiModel, feature: string, request: AiRequest, pii: PiiMap = new Map()): Promise<AiCall> {
  const log = async (c: { status: AiCall['status']; model?: string; stop?: string | null; usage?: AiResponse['usage']; ms?: number; summary?: string | null; error?: string | null }) => {
    const u = c.usage;
    const cost = u ? aiCost(c.model ?? ai.model, u) : 0;
    const row = await tx.one<{ id: string }>(
      `INSERT INTO ai.calls (tenant_id, user_id, feature, provider, model, status, stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, redactions,
         result_summary, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [tx.tenantId, tx.userId, feature, ai.provider, c.model ?? ai.model, c.status, c.stop ?? null, u?.input_tokens ?? 0, u?.output_tokens ?? 0, u?.cache_read_input_tokens ?? 0,
        u?.cache_creation_input_tokens ?? 0, cost.toFixed(6), c.ms ?? null, pii.size, c.summary?.slice(0, 500) ?? null, c.error?.slice(0, 500) ?? null]);
    if (c.status !== 'unavailable') {
      await emit(tx, 'ia.consumo', { type: 'ai_call', id: row.id }, {
        funcionalidade: feature, modelo: c.model ?? ai.model, status: c.status, tokensEntrada: u?.input_tokens ?? 0, tokensSaida: u?.output_tokens ?? 0, custoUsd: cost.toFixed(6), usuario: tx.userId,
      });
    }
    return row.id;
  };
  if (!ai.available()) return { callId: await log({ status: 'unavailable' }), status: 'unavailable', response: null, pii };
  const started = Date.now();
  try {
    const response = await ai.create(redactRequest(request, pii));
    const refused = response.stop_reason === 'refusal';
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
    const status = refused ? 'refused' : 'ok';
    const callId = await log({ status, model: response.model, stop: response.stop_reason, usage: response.usage, ms: Date.now() - started, summary: text });
    return { callId, status, response: refused ? null : response, pii };
  } catch (err) {
    const callId = await log({ status: 'error', ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
    return { callId, status: 'error', response: null, pii };
  }
}

/** Texto final da resposta (blocos de texto), com os dados pessoais restaurados. */
export function responseText(call: AiCall): string | null {
  if (!call.response) return null;
  const text = call.response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
  return text ? restore(text, call.pii) : null;
}

/** Saída estruturada (output_config.format json_schema): JSON já restaurado; null se inválido. */
export function responseJson<T>(call: AiCall): T | null {
  const text = responseText(call);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------------------ RN-IA-01: escrita vira rascunho

export type DraftKind = 'payable_title' | 'ncm_classification' | 'renegotiation' | 'purchase_suggestion';

export async function createDraft(tx: Tx, d: { kind: DraftKind; title: string; payload: unknown; confidence?: number | null; source: 'ai' | 'rules'; callId?: string | null }) {
  return tx.one<Record<string, any>>(
    `INSERT INTO ai.drafts (tenant_id, company_id, kind, title, payload, confidence, source, call_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tx.tenantId, tx.companyId, d.kind, d.title, JSON.stringify(d.payload), d.confidence == null ? null : Math.max(0, Math.min(100, d.confidence)).toFixed(2), d.source, d.callId ?? null, tx.userId]);
}

/** Esquema estrito para saída estruturada: todo objeto fecha propriedades adicionais. */
export function jsonFormat(schema: Record<string, unknown>) {
  return { format: { type: 'json_schema' as const, schema } };
}
