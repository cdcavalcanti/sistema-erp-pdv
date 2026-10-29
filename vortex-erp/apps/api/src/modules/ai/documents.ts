import { createHash } from 'node:crypto';
import { D } from '@vortex/money';
import { isValidCNPJ, isValidCPF } from '@vortex/validators';
import type { Tx } from '../../db/tx.js';
import { validation } from '../../errors.js';
import type { Services } from '../../services.js';
import { validateDigitableLine } from '../finance/bank-gateway.js';
import { callAi, createDraft, jsonFormat, responseJson } from './runtime.js';

const day = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Vencimento a partir do fator do boleto. O fator reiniciou em 1000 em 22/02/2025; entre as
 * duas leituras possíveis, vale a mais próxima de hoje.
 */
export function dueDateFromFactor(factor: string, today = new Date()): string | null {
  const f = Number(factor);
  if (!f) return null;
  const a = Date.UTC(1997, 9, 7) + f * day;
  const b = Date.UTC(2025, 1, 22) + (f - 1000) * day;
  return iso(Math.abs(a - today.getTime()) <= Math.abs(b - today.getTime()) ? a : b);
}

function mod10(n: string) {
  let sum = 0;
  let w = 2;
  for (let i = n.length - 1; i >= 0; i--) {
    const p = Number(n[i]) * w;
    sum += p > 9 ? Math.floor(p / 10) + (p % 10) : p;
    w = w === 2 ? 1 : 2;
  }
  return (10 - (sum % 10)) % 10;
}
function mod11Arrecadacao(n: string) {
  let sum = 0;
  let w = 2;
  for (let i = n.length - 1; i >= 0; i--) {
    sum += Number(n[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const r = sum % 11;
  return r === 0 || r === 1 ? 0 : 11 - r;
}

export interface ParsedBoleto {
  kind: 'bancario' | 'arrecadacao';
  digitableLine: string;
  bankCode: string | null;
  amount: string | null;
  dueDate: string | null;
}

/** Linha digitável de boleto bancário (47) ou de arrecadação/concessionária (48), com dígitos conferidos. */
export function parseDigitableLine(raw: string, today = new Date()): ParsedBoleto | null {
  const l = raw.replace(/\D/g, '');
  if (l.length === 47 && validateDigitableLine(l)) {
    const value = D(l.slice(37, 47)).dividedBy(100);
    return { kind: 'bancario', digitableLine: l, bankCode: l.slice(0, 3), amount: value.greaterThan(0) ? value.toFixed(2) : null, dueDate: dueDateFromFactor(l.slice(33, 37), today) };
  }
  if (l.length === 48 && l[0] === '8') {
    const blocks = [0, 1, 2, 3].map((i) => l.slice(i * 12, i * 12 + 12));
    const ref = l[2];
    const dv = ref === '6' || ref === '7' ? mod10 : mod11Arrecadacao;
    if (!blocks.every((b) => dv(b.slice(0, 11)) === Number(b[11]))) return null;
    const barcode = blocks.map((b) => b.slice(0, 11)).join('');
    const value = ref === '6' || ref === '8' ? D(barcode.slice(4, 15)).dividedBy(100) : null;
    return { kind: 'arrecadacao', digitableLine: l, bankCode: null, amount: value && value.greaterThan(0) ? value.toFixed(2) : null, dueDate: null };
  }
  return null;
}

/** Procura linhas digitáveis no texto (com ou sem pontuação). */
export function findDigitableLines(text: string): ParsedBoleto[] {
  const out: ParsedBoleto[] = [];
  const re = /(?:\d[\d.\s-]{45,62}\d)/g;
  for (const m of text.match(re) ?? []) {
    const p = parseDigitableLine(m);
    if (p && !out.some((x) => x.digitableLine === p.digitableLine)) out.push(p);
  }
  return out;
}

function findTaxIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g) ?? []) if (isValidCNPJ(m)) out.add(m.replace(/\D/g, ''));
  for (const m of text.match(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g) ?? []) if (isValidCPF(m)) out.add(m.replace(/\D/g, ''));
  return [...out];
}

const DOC_SCHEMA = {
  type: 'object',
  properties: {
    documentType: { type: 'string', enum: ['boleto', 'recibo', 'nota_fiscal', 'fatura', 'outro'] },
    supplierName: { type: ['string', 'null'] },
    supplierTaxId: { type: ['string', 'null'], description: 'CNPJ ou CPF de quem recebe o pagamento (beneficiário/emitente), só dígitos' },
    documentNumber: { type: ['string', 'null'] },
    issueDate: { type: ['string', 'null'], description: 'AAAA-MM-DD' },
    dueDate: { type: ['string', 'null'], description: 'AAAA-MM-DD' },
    amount: { type: ['string', 'null'], description: 'Valor a pagar com ponto decimal, ex.: 1234.56' },
    digitableLine: { type: ['string', 'null'], description: 'Linha digitável do boleto, só dígitos' },
    description: { type: ['string', 'null'], description: 'O que foi comprado/contratado, em poucas palavras' },
    categoryCode: { type: ['string', 'null'], description: 'Código da categoria financeira da lista enviada' },
  },
  required: ['documentType', 'supplierName', 'supplierTaxId', 'documentNumber', 'issueDate', 'dueDate', 'amount', 'digitableLine', 'description', 'categoryCode'],
  additionalProperties: false,
};
interface DocOut {
  documentType: string; supplierName: string | null; supplierTaxId: string | null; documentNumber: string | null; issueDate: string | null; dueDate: string | null;
  amount: string | null; digitableLine: string | null; description: string | null; categoryCode: string | null;
}

const isIsoDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Leitura de documentos (seção 20): boleto, recibo ou nota em PDF/foto vira rascunho de título a
 * pagar já classificado. A linha digitável é conferida pelos dígitos verificadores e, quando
 * válida, manda no valor e no vencimento; o que o modelo lê é validado antes de ir ao rascunho.
 */
export async function readDocument(tx: Tx, services: Services, input: { fileBase64?: string | null; contentType?: string | null; text?: string | null; fileName?: string | null }) {
  const buf = input.fileBase64 ? Buffer.from(input.fileBase64, 'base64') : null;
  if (!buf && !input.text) throw validation({ fileBase64: 'Envie o arquivo (PDF/imagem) ou o texto do documento' });
  const contentType = input.contentType ?? 'application/pdf';
  if (buf && !['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(contentType)) throw validation({ contentType: 'Use PDF, JPEG, PNG, WEBP ou GIF' });
  if (buf && buf.length > 10 * 1024 * 1024) throw validation({ fileBase64: 'Arquivo acima de 10 MB' });
  let storageKey: string | null = null;
  if (buf) {
    const sha = createHash('sha256').update(buf).digest('hex');
    storageKey = (await services.storage.putImmutable(`${tx.tenantId}/ia/documentos/${sha}`, buf, contentType)).key;
  }
  // Regras: linha digitável e CNPJ/CPF no texto (texto enviado ou PDF não compactado)
  const plain = [input.text ?? '', buf && contentType === 'application/pdf' ? buf.toString('latin1') : ''].join('\n');
  const boletos = findDigitableLines(plain);
  const own = await tx.query<{ tax_id: string }>(`SELECT cnpj AS tax_id FROM core.establishments WHERE company_id = $1`, [tx.companyId]);
  const taxIds = findTaxIds(plain).filter((t) => !own.some((o) => o.tax_id === t));
  const categories = await tx.query<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM finance.categories WHERE kind IN ('cost','expense','financial_expense','investment') AND accepts_entries AND active ORDER BY code`);

  const content: any[] = [];
  if (buf) {
    content.push(contentType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: contentType, data: buf.toString('base64') } });
  }
  content.push({ type: 'text', text: [
    'Extraia os dados para lançar este documento como conta a pagar.',
    input.text ? `Texto do documento:\n${input.text.slice(0, 20_000)}` : '',
    `Categorias financeiras (use o código):\n${categories.map((c) => `- ${c.code}: ${c.name}`).join('\n')}`,
  ].filter(Boolean).join('\n\n') });
  const call = await callAi(tx, services.ai, 'leitura_documento', {
    max_tokens: 2000,
    output_config: { effort: 'low', ...jsonFormat(DOC_SCHEMA) },
    system: 'Você lê documentos de cobrança brasileiros (boletos, recibos, notas fiscais, faturas) para um ERP. Copie os dados exatamente como estão no documento; '
      + 'use null quando um campo não estiver legível. Responda somente com o JSON pedido.',
    messages: [{ role: 'user', content }],
  });
  const out = responseJson<DocOut>(call);
  const divergences: string[] = [];

  // A linha digitável conferida manda; a do modelo só vale se passar nos dígitos verificadores
  const aiBoleto = out?.digitableLine ? parseDigitableLine(out.digitableLine) : null;
  if (out?.digitableLine && !aiBoleto) divergences.push('Linha digitável lida pela IA não confere nos dígitos verificadores');
  const boleto = boletos[0] ?? aiBoleto;
  let amount = boleto?.amount ?? null;
  const aiAmount = out?.amount && /^\d+(\.\d{1,2})?$/.test(out.amount.replace(',', '.')) ? D(out.amount.replace(',', '.')).toFixed(2) : null;
  if (amount && aiAmount && aiAmount !== amount) divergences.push(`Valor lido (${aiAmount}) difere do código de barras (${amount}); vale o código de barras`);
  amount ??= aiAmount;
  let dueDate = boleto?.dueDate ?? null;
  if (dueDate && isIsoDate(out?.dueDate) && out!.dueDate !== dueDate) divergences.push(`Vencimento lido (${out!.dueDate}) difere do código de barras (${dueDate})`);
  if (!dueDate && isIsoDate(out?.dueDate)) dueDate = out!.dueDate;

  const aiTax = out?.supplierTaxId?.replace(/\D/g, '') ?? null;
  const supplierTaxId = aiTax && (isValidCNPJ(aiTax) || isValidCPF(aiTax)) && !own.some((o) => o.tax_id === aiTax) ? aiTax : taxIds[0] ?? null;
  const party = supplierTaxId
    ? await tx.maybeOne<{ id: string; legal_name: string }>(`SELECT id, legal_name FROM registry.parties WHERE tax_id = $1`, [supplierTaxId])
    : null;
  // Categoria: a mesma do último título do fornecedor; senão a sugerida pelo modelo (se existir)
  const last = party
    ? await tx.maybeOne<{ category_id: string }>(`SELECT category_id FROM finance.titles WHERE party_id = $1 AND kind = 'payable' AND category_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [party.id])
    : null;
  const categoryId = last?.category_id ?? categories.find((c) => c.code === out?.categoryCode)?.id ?? null;

  const found = [amount, dueDate, party, categoryId].filter(Boolean).length;
  const confidence = (boleto ? 40 : 0) + found * 15;
  const payload = {
    documentType: out?.documentType ?? (boleto ? 'boleto' : 'outro'), partyId: party?.id ?? null, supplierName: party?.legal_name ?? out?.supplierName ?? null, supplierTaxId,
    documentNumber: out?.documentNumber ?? null, issueDate: isIsoDate(out?.issueDate) ? out!.issueDate : null, dueDate, amount, categoryId,
    digitableLine: boleto?.digitableLine ?? null, boletoKind: boleto?.kind ?? null, description: out?.description ?? null, storageKey, fileName: input.fileName ?? null,
    divergences, missing: [!party && 'fornecedor', !amount && 'valor', !dueDate && 'vencimento', !categoryId && 'categoria'].filter(Boolean),
  };
  if (!amount && !boleto && !out) throw validation({ fileBase64: 'Não foi possível ler o documento: lance o título manualmente' });
  return createDraft(tx, {
    kind: 'payable_title', source: out ? 'ai' : 'rules', callId: call.callId, confidence: Math.min(99, confidence),
    title: `Conta a pagar: ${payload.supplierName ?? 'fornecedor não identificado'}${amount ? ` · R$ ${amount.replace('.', ',')}` : ''}`, payload,
  });
}
