import type { Tx } from '../../db/tx.js';
import { validation } from '../../errors.js';
import { similarity, tokens } from '../purchasing/receiving.js';
import type { AiModel } from './model.js';
import { callAi, createDraft, jsonFormat, responseJson } from './runtime.js';

interface Evidence {
  source: 'compra_do_produto' | 'compra_semelhante' | 'produto_semelhante';
  ncm: string;
  cest: string | null;
  weight: number;
  detail: string;
}

const NCM_SCHEMA = {
  type: 'object',
  properties: {
    ncm: { type: 'string', description: 'NCM com 8 dígitos' },
    cest: { type: ['string', 'null'], description: 'CEST com 7 dígitos, se o produto estiver sujeito a ST; senão null' },
    cclasstrib: { type: ['string', 'null'], description: 'cClassTrib com 6 dígitos da lista enviada; null se nenhum se aplica' },
    confidence: { type: 'number', description: 'Confiança de 0 a 100' },
    rationale: { type: 'string', description: 'Justificativa curta em português' },
  },
  required: ['ncm', 'cest', 'cclasstrib', 'confidence', 'rationale'],
  additionalProperties: false,
};

async function validNcm(tx: Tx, code: string | null | undefined) {
  if (!code || !/^\d{8}$/.test(code)) return null;
  return tx.maybeOne<{ code: string; description: string }>(
    `SELECT code, description FROM fiscal.ncm WHERE code = $1 AND valid_from <= current_date AND (valid_to IS NULL OR valid_to >= current_date)`, [code]);
}
async function validCest(tx: Tx, code: string | null | undefined, ncm: string) {
  if (!code || !/^\d{7}$/.test(code)) return null;
  const c = await tx.maybeOne<{ ncm_prefixes: string[] }>(`SELECT ncm_prefixes FROM fiscal.cest WHERE code = $1 AND (valid_to IS NULL OR valid_to >= current_date)`, [code]);
  return c && (!c.ncm_prefixes.length || c.ncm_prefixes.some((p) => ncm.startsWith(p))) ? code : null;
}
async function validClassTrib(tx: Tx, code: string | null | undefined) {
  if (!code || !/^\d{6}$/.test(code)) return null;
  return (await tx.maybeOne(`SELECT 1 FROM fiscal.cclasstrib WHERE code = $1 AND (valid_to IS NULL OR valid_to >= current_date)`, [code])) ? code : null;
}

/**
 * Classificação fiscal assistida (seção 20): NCM, CEST e cClassTrib a partir da descrição e das
 * notas de compra do mesmo produto, com grau de confiança. A sugestão vira rascunho que o
 * contador aprova (RN-IA-01); o que o modelo devolve é validado contra as tabelas vigentes.
 */
export async function classifyProduct(tx: Tx, ai: AiModel, input: { productId?: string | null; description?: string | null }) {
  const product = input.productId
    ? await tx.one<{ id: string; sku: string; description: string; ncm: string | null; cest: string | null; cclasstrib: string | null; kind: string }>(
      `SELECT id, sku, description, ncm, cest, cclasstrib, kind FROM catalog.products WHERE id = $1`, [input.productId], 'Produto')
    : null;
  const description = product?.description ?? input.description ?? '';
  if (description.trim().length < 3) throw validation({ description: 'Informe o produto ou a descrição' });
  const tk = tokens(description);
  const evidence: Evidence[] = [];

  // 1. Notas de compra do próprio produto: o NCM que os fornecedores usam é a evidência mais forte
  if (product) {
    const rows = await tx.query<{ ncm: string; cest: string | null; n: number }>(
      `SELECT ncm, cest, count(*)::int AS n FROM purchasing.receipt_items WHERE product_id = $1 AND ncm ~ '^\\d{8}$' GROUP BY 1, 2 ORDER BY 3 DESC`, [product.id]);
    const total = rows.reduce((a, r) => a + r.n, 0);
    for (const r of rows) evidence.push({ source: 'compra_do_produto', ncm: r.ncm, cest: r.cest, weight: 0.6 + 0.4 * (r.n / total), detail: `${r.n} de ${total} nota(s) de compra do produto` });
  }
  // 2. Itens de notas de compra com descrição parecida
  const query = [...tk].filter((t) => /^[a-z0-9]+$/.test(t)).join(' | ');
  if (query) {
    const items = await tx.query<{ description: string; ncm: string; cest: string | null }>(
      `SELECT DISTINCT ON (description, ncm) description, ncm, cest FROM purchasing.receipt_items
        WHERE ncm ~ '^\\d{8}$' AND ($2::uuid IS NULL OR product_id IS DISTINCT FROM $2)
          AND to_tsvector('simple', translate(lower(description), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) @@ to_tsquery('simple', $1) LIMIT 200`, [query, product?.id ?? null]);
    for (const it of items) {
      const s = similarity(tk, tokens(it.description));
      if (s >= 0.3) evidence.push({ source: 'compra_semelhante', ncm: it.ncm, cest: it.cest, weight: 0.75 * s, detail: `Compra de "${it.description}"` });
    }
    // 3. Produtos já classificados no cadastro com descrição parecida
    const prods = await tx.query<{ sku: string; description: string; ncm: string; cest: string | null }>(
      `SELECT sku, description, ncm, cest FROM catalog.products WHERE ncm IS NOT NULL AND ($2::uuid IS NULL OR id <> $2)
          AND to_tsvector('simple', translate(lower(description), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) @@ to_tsquery('simple', $1) LIMIT 200`, [query, product?.id ?? null]);
    for (const p of prods) {
      const s = similarity(tk, tokens(p.description));
      if (s >= 0.3) evidence.push({ source: 'produto_semelhante', ncm: p.ncm, cest: p.cest, weight: 0.65 * s, detail: `Produto ${p.sku} "${p.description}"` });
    }
  }
  const scores = new Map<string, { score: number; cest: string | null }>();
  for (const e of evidence) {
    const cur = scores.get(e.ncm) ?? { score: 0, cest: e.cest };
    // Evidências somam com retorno decrescente; nunca chegam a 100%
    cur.score = 1 - (1 - cur.score) * (1 - e.weight);
    cur.cest ??= e.cest;
    scores.set(e.ncm, cur);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  let suggestion: { ncm: string; cest: string | null; cclasstrib: string | null } | null = null;
  let confidence = 0;
  let rationale = '';
  let source: 'ai' | 'rules' = 'rules';
  if (ranked[0] && (await validNcm(tx, ranked[0][0]))) {
    suggestion = { ncm: ranked[0][0], cest: await validCest(tx, ranked[0][1].cest, ranked[0][0]), cclasstrib: null };
    confidence = Math.min(99, ranked[0][1].score * 100);
    rationale = 'Baseado em notas de compra e produtos semelhantes';
  }

  // Candidatos da tabela NCM para o modelo escolher (por palavras da descrição)
  const tableCandidates = query
    ? await tx.query<{ code: string; description: string }>(
      `SELECT code, description FROM fiscal.ncm WHERE (valid_to IS NULL OR valid_to >= current_date)
          AND to_tsvector('simple', translate(lower(description), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) @@ to_tsquery('simple', $1) LIMIT 30`, [query])
    : [];
  const classTribs = await tx.query<{ code: string; description: string }>(`SELECT code, description FROM fiscal.cclasstrib WHERE valid_to IS NULL OR valid_to >= current_date ORDER BY code LIMIT 60`);
  const call = await callAi(tx, ai, 'classificacao_fiscal', {
    max_tokens: 2000,
    output_config: { effort: 'low', ...jsonFormat(NCM_SCHEMA) },
    system: 'Você é um analista fiscal brasileiro. Classifique mercadorias na NCM (TIPI vigente), indique CEST só quando houver substituição tributária aplicável e o cClassTrib do IBS/CBS. '
      + 'Prefira o NCM que os fornecedores usam nas notas de compra do mesmo produto. Responda somente com o JSON pedido.',
    messages: [{ role: 'user', content: [
      `Produto: ${description}${product?.kind ? ` (tipo: ${product.kind})` : ''}`,
      evidence.length ? `Evidências do próprio ERP:\n${evidence.slice(0, 15).map((e) => `- NCM ${e.ncm}${e.cest ? ` CEST ${e.cest}` : ''}: ${e.detail}`).join('\n')}` : 'Sem notas de compra nem produtos semelhantes no ERP.',
      tableCandidates.length ? `NCMs da tabela com palavras em comum:\n${tableCandidates.map((c) => `- ${c.code}: ${c.description}`).join('\n')}` : '',
      `cClassTrib disponíveis:\n${classTribs.map((c) => `- ${c.code}: ${c.description}`).join('\n')}`,
    ].filter(Boolean).join('\n\n') }],
  });
  const out = responseJson<{ ncm: string; cest: string | null; cclasstrib: string | null; confidence: number; rationale: string }>(call);
  if (out) {
    const ncm = await validNcm(tx, out.ncm?.replace(/\D/g, ''));
    if (ncm) {
      const known = scores.has(ncm.code) || tableCandidates.some((c) => c.code === ncm.code);
      // A regra valida: NCM fora das evidências e da busca tem confiança limitada
      const conf = Math.max(0, Math.min(known ? 99 : 70, Number(out.confidence) || 0));
      // Se o modelo discorda das notas de compra com confiança menor, as notas prevalecem
      if (!suggestion || suggestion.ncm === ncm.code || conf >= confidence) {
        suggestion = { ncm: ncm.code, cest: await validCest(tx, out.cest, ncm.code), cclasstrib: await validClassTrib(tx, out.cclasstrib) };
        confidence = suggestion.ncm === ranked[0]?.[0] ? Math.max(conf, confidence) : conf;
        rationale = out.rationale;
        source = 'ai';
      } else if (suggestion) {
        suggestion.cclasstrib = await validClassTrib(tx, out.cclasstrib);
      }
    }
  }
  if (!suggestion) throw validation({ ncm: 'Sem base para sugerir a classificação: informe o NCM manualmente' }, );
  const ncmRow = await validNcm(tx, suggestion.ncm);
  const draft = await createDraft(tx, {
    kind: 'ncm_classification', source, callId: call.callId, confidence,
    title: `Classificação fiscal: ${description.slice(0, 80)}`,
    payload: {
      productId: product?.id ?? null, description, current: product ? { ncm: product.ncm, cest: product.cest, cclasstrib: product.cclasstrib } : null,
      suggestion: { ...suggestion, ncmDescription: ncmRow?.description ?? null }, rationale,
      alternatives: ranked.slice(0, 5).map(([ncm, s]) => ({ ncm, confidence: Number((s.score * 100).toFixed(2)) })),
      evidence: evidence.sort((a, b) => b.weight - a.weight).slice(0, 10),
    },
  });
  return draft;
}
