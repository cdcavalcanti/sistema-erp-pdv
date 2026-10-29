import type { Tx } from '../../db/tx.js';
import { conflict } from '../../errors.js';
import { similarity, tokens } from '../purchasing/receiving.js';
import type { AiModel } from './model.js';
import { callAi, jsonFormat, responseJson } from './runtime.js';

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          productId: { type: ['string', 'null'], description: 'id do produto da lista de candidatos; null se nenhum corresponde' },
          factor: { type: 'string', description: 'Quantas unidades de estoque há em 1 unidade do fornecedor (ex.: caixa com 12 = "12"); "1" se igual' },
          confidence: { type: 'number' },
        },
        required: ['itemId', 'productId', 'factor', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

/**
 * De-para inteligente (seção 20): no primeiro recebimento de um fornecedor, sugere qual produto
 * interno corresponde a cada item do XML. O modelo escolhe só entre candidatos do cadastro; a
 * sugestão fica como "suggestion" e precisa ser confirmada no recebimento (RN-IA-01).
 */
export async function suggestReceiptMatches(tx: Tx, ai: AiModel, receiptId: string) {
  const r = await tx.one<{ status: string; supplier_id: string }>(`SELECT status, supplier_id FROM purchasing.receipts WHERE id = $1`, [receiptId], 'Recebimento');
  if (['completed', 'cancelled'].includes(r.status)) throw conflict('INVALID_STATUS', 'Recebimento já concluído ou cancelado');
  const items = await tx.query<{ id: string; description: string; ncm: string | null; supplier_unit: string | null; ean: string | null; xml_item_number: number }>(
    `SELECT id, description, ncm, supplier_unit, ean, xml_item_number FROM purchasing.receipt_items WHERE receipt_id = $1 AND (product_id IS NULL OR match_source = 'suggestion') ORDER BY xml_item_number`,
    [receiptId]);
  if (!items.length) return { suggested: 0, items: [] };
  const candidates = new Map<string, { id: string; sku: string; description: string; stock_unit: string; ncm: string | null }[]>();
  for (const it of items) {
    const tk = tokens(it.description);
    const q = [...tk].filter((t) => /^[a-z0-9]+$/.test(t)).join(' | ');
    const rows = await tx.query<{ id: string; sku: string; description: string; stock_unit: string; ncm: string | null }>(
      `SELECT id, sku, description, stock_unit, ncm FROM catalog.products WHERE status = 'active' AND NOT is_variant_parent
          AND (ncm = $1 OR ($2 <> '' AND to_tsvector('simple', translate(lower(description), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) @@ to_tsquery('simple', $2))) LIMIT 200`,
      [it.ncm, q]);
    const ranked = rows.map((p) => ({ p, s: similarity(tk, tokens(p.description)) + (p.ncm && p.ncm === it.ncm ? 0.2 : 0) })).sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.p);
    candidates.set(it.id, ranked);
  }
  const call = await callAi(tx, ai, 'de_para', {
    max_tokens: 3000,
    output_config: { effort: 'low', ...jsonFormat(MATCH_SCHEMA) },
    system: 'Você relaciona itens de notas fiscais de compra com o cadastro de produtos de um ERP. Escolha apenas entre os candidatos listados para cada item. '
      + 'Considere marca, tamanho, sabor, volume e a unidade (caixa/fardo com N unidades → fator N).',
    messages: [{ role: 'user', content: items.map((it) => [
      `Item ${it.id}: "${it.description}" (unidade ${it.supplier_unit ?? '?'}${it.ncm ? `, NCM ${it.ncm}` : ''})`,
      ...(candidates.get(it.id) ?? []).map((c) => `  - ${c.id} | ${c.sku} | ${c.description} | unidade ${c.stock_unit}`),
    ].join('\n')).join('\n\n') }],
  });
  const out = responseJson<{ matches: { itemId: string; productId: string | null; factor: string; confidence: number }[] }>(call);
  const applied = [];
  for (const m of out?.matches ?? []) {
    const it = items.find((x) => x.id === m.itemId);
    // A regra valida: produto tem de estar entre os candidatos e o fator ser positivo
    if (!it || !m.productId || !(candidates.get(it.id) ?? []).some((c) => c.id === m.productId)) continue;
    const factor = /^\d+(\.\d+)?$/.test(m.factor) && Number(m.factor) > 0 ? m.factor : '1';
    const confidence = Math.max(0, Math.min(95, Number(m.confidence) || 0));
    await tx.exec(
      `UPDATE purchasing.receipt_items SET product_id = $2, factor = $3, match_source = 'suggestion', match_confidence = $4, stock_quantity = supplier_quantity * $3::numeric WHERE id = $1`,
      [it.id, m.productId, factor, confidence.toFixed(2)]);
    applied.push({ itemId: it.id, productId: m.productId, factor, confidence });
  }
  return { suggested: applied.length, items: applied, source: out ? 'ai' : 'rules', callId: call.callId };
}
