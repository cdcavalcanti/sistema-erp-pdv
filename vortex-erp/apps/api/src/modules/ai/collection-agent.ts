import { D, ZERO, allocate, roundMoney } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { validation } from '../../errors.js';
import type { Services } from '../../services.js';
import { newTxid } from '../finance/bank-gateway.js';
import { computeCharges } from '../finance/titles.js';
import { callAi, createDraft, jsonFormat, responseJson } from './runtime.js';

/** Limites do agente de cobrança (core.companies.settings.ai.collection). */
export interface CollectionLimits {
  maxDiscountPercent: string;
  discountOnInstallments: boolean;
  maxInstallments: number;
  minInstallment: string;
  maxFirstDueDays: number;
  intervalDays: number;
}
export const DEFAULT_LIMITS: CollectionLimits = { maxDiscountPercent: '5', discountOnInstallments: false, maxInstallments: 3, minInstallment: '50.00', maxFirstDueDays: 7, intervalDays: 30 };

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['propor', 'aceitar', 'recusar', 'duvida'], description: 'O que o cliente quer' },
    installments: { type: ['integer', 'null'], description: 'Parcelas pedidas pelo cliente (1 = à vista); null se não disse' },
    discountPercent: { type: ['number', 'null'], description: 'Desconto pedido em %, se pediu' },
    firstDueInDays: { type: ['integer', 'null'], description: 'Em quantos dias quer pagar a primeira parcela, se disse' },
    summary: { type: 'string', description: 'Resumo de uma linha do que o cliente pediu' },
  },
  required: ['intent', 'installments', 'discountPercent', 'firstDueInDays', 'summary'],
  additionalProperties: false,
};

const brl = (v: string) => `R$ ${D(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, '#').replace('.', ',').replace(/#/g, '.')}`;
const br = (d: string) => d.split('-').reverse().join('/');
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Agente de cobrança (seção 20): negocia dentro dos limites da empresa (desconto máximo, parcelas,
 * valor mínimo), gera o Pix e registra o acordo como rascunho para aprovação (RN-IA-01). O modelo só
 * interpreta a mensagem do cliente; valores, datas e o texto da proposta saem das regras.
 */
export async function negotiate(tx: Tx, services: Services, input: {
  partyId: string; titleIds?: string[] | null; customerMessage?: string | null; send?: boolean;
  requested?: { installments?: number | null; discountPercent?: string | null; firstDueInDays?: number | null } | null;
}, today = new Date().toISOString().slice(0, 10)) {
  const company = await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [tx.companyId]);
  const limits: CollectionLimits = { ...DEFAULT_LIMITS, ...(company.settings?.ai?.collection ?? {}) };
  const party = await tx.one<{ id: string; legal_name: string }>(`SELECT id, legal_name FROM registry.parties WHERE id = $1`, [input.partyId], 'Cliente');
  const titles = await tx.query<Record<string, any>>(
    `SELECT * FROM finance.titles WHERE party_id = $1 AND company_id = $2 AND kind = 'receivable' AND status IN ('open','partially_paid') AND gross_amount IS NULL
        AND origin_type NOT IN ('advance') AND ($3::uuid[] IS NULL OR id = ANY($3)) ORDER BY due_date`, [party.id, tx.companyId, input.titleIds?.length ? input.titleIds : null]);
  if (!titles.length) throw validation({ partyId: 'Cliente sem títulos a receber em aberto' });
  let balance = ZERO;
  let charges = ZERO;
  for (const t of titles) {
    const c = computeCharges(t as never, today);
    balance = balance.plus(t.balance);
    charges = charges.plus(c.fine).plus(c.interest);
  }
  charges = roundMoney(charges);
  const debt = balance.plus(charges);

  // O que o cliente pediu: interpretação pelo modelo (se houver mensagem) ou parâmetros explícitos
  let request = { installments: input.requested?.installments ?? null, discountPercent: input.requested?.discountPercent ?? null, firstDueInDays: input.requested?.firstDueInDays ?? null };
  let intent: string | null = null;
  let summary: string | null = null;
  let callId: string | null = null;
  let source: 'ai' | 'rules' = 'rules';
  if (input.customerMessage) {
    const call = await callAi(tx, services.ai, 'agente_cobranca', {
      max_tokens: 1000,
      output_config: { effort: 'low', ...jsonFormat(INTENT_SCHEMA) },
      system: 'Você interpreta mensagens de clientes brasileiros em uma negociação de dívida pelo WhatsApp. Extraia apenas o que o cliente pediu; não invente valores.',
      messages: [{ role: 'user', content: `Dívida em aberto: ${brl(debt.toFixed(2))} (${titles.length} título(s)).\nMensagem do cliente: "${input.customerMessage.slice(0, 2000)}"` }],
    });
    callId = call.callId;
    const out = responseJson<{ intent: string; installments: number | null; discountPercent: number | null; firstDueInDays: number | null; summary: string }>(call);
    if (out) {
      source = 'ai';
      intent = out.intent;
      summary = out.summary;
      request = {
        installments: request.installments ?? out.installments, discountPercent: request.discountPercent ?? (out.discountPercent == null ? null : String(out.discountPercent)),
        firstDueInDays: request.firstDueInDays ?? out.firstDueInDays,
      };
    }
  }

  // As regras decidem a proposta dentro dos limites
  const adjustments: string[] = [];
  let n = Math.max(1, Math.trunc(request.installments ?? 1));
  if (n > limits.maxInstallments) {
    adjustments.push(`Parcelas limitadas a ${limits.maxInstallments}`);
    n = limits.maxInstallments;
  }
  const maxDisc = n === 1 || limits.discountOnInstallments ? D(limits.maxDiscountPercent) : ZERO;
  let discPct = request.discountPercent == null ? (n === 1 ? maxDisc : ZERO) : D(request.discountPercent);
  if (discPct.greaterThan(maxDisc)) {
    adjustments.push(maxDisc.isZero() ? 'Desconto só para pagamento à vista' : `Desconto limitado a ${maxDisc.toFixed(2).replace('.', ',')}%`);
    discPct = maxDisc;
  }
  if (discPct.lessThan(0)) discPct = ZERO;
  const discount = roundMoney(debt.times(discPct).dividedBy(100));
  const total = debt.minus(discount);
  while (n > 1 && total.dividedBy(n).lessThan(limits.minInstallment)) n--;
  if (request.installments && n < request.installments && !adjustments.some((a) => a.startsWith('Parcelas'))) adjustments.push(`Parcela mínima de ${brl(limits.minInstallment)}`);
  let firstIn = Math.max(0, Math.trunc(request.firstDueInDays ?? 1));
  if (firstIn > limits.maxFirstDueDays) {
    adjustments.push(`Primeiro pagamento em até ${limits.maxFirstDueDays} dias`);
    firstIn = limits.maxFirstDueDays;
  }
  const amounts = allocate(total, Array.from({ length: n }, () => 1));
  const installments = amounts.map((a, i) => ({ dueDate: addDays(today, firstIn + i * limits.intervalDays), amount: a.toFixed(2) }));

  // Pix da primeira parcela (ou do valor à vista) na conta da empresa com chave Pix
  const acc = await tx.maybeOne<{ id: string; pix_key: string }>(
    `SELECT id, pix_key FROM finance.accounts WHERE company_id = $1 AND pix_key IS NOT NULL AND active ORDER BY created_at LIMIT 1`, [tx.companyId]);
  let pix: { txid: string; qrCode: string; gatewayId: string; accountId: string } | null = null;
  if (acc) {
    const r = await services.bankGateway.createPix({ txid: newTxid(), amount: installments[0]!.amount, pixKey: acc.pix_key, merchantName: 'VORTEX', merchantCity: 'BRASIL', dueDate: null,
      payer: { name: party.legal_name, taxId: '' } });
    pix = { txid: r.txid, qrCode: r.qrCode, gatewayId: r.gatewayId, accountId: acc.id };
  }
  const offer = n === 1
    ? `pagamento à vista de ${brl(total.toFixed(2))} até ${br(installments[0]!.dueDate)}${discount.greaterThan(0) ? ` (desconto de ${brl(discount.toFixed(2))})` : ''}`
    : `${n} parcelas de ${brl(installments[0]!.amount)}, a primeira em ${br(installments[0]!.dueDate)}`;
  const reply = `Olá, ${party.legal_name}. Sua dívida atualizada é de ${brl(debt.toFixed(2))}. Podemos fazer ${offer}.`
    + `${adjustments.length ? ` ${adjustments.join('; ')}.` : ''} O acordo será confirmado pela nossa equipe.${pix ? ` Pix copia e cola: ${pix.qrCode}` : ''}`;
  let sentTo: string | null = null;
  if (input.send) {
    // LGPD: WhatsApp de cobrança só com consentimento registrado
    const c = await tx.maybeOne<{ whatsapp: string }>(
      `SELECT whatsapp FROM registry.party_contacts WHERE party_id = $1 AND whatsapp IS NOT NULL AND (consents->>'cobranca_whatsapp')::boolean LIMIT 1`, [party.id]);
    if (c) {
      await services.messenger.sendWhatsApp(c.whatsapp, reply);
      sentTo = c.whatsapp;
    }
  }
  return createDraft(tx, {
    kind: 'renegotiation', source, callId, confidence: adjustments.length ? 70 : 90,
    title: `Acordo de cobrança: ${party.legal_name} · ${offer}`,
    payload: {
      partyId: party.id, titleIds: titles.map((t) => t.id), balance: balance.toFixed(2), charges: charges.toFixed(2), debt: debt.toFixed(2), discountPercent: discPct.toFixed(2),
      discount: discount.toFixed(2), total: total.toFixed(2), installments, pix, limits, intent, customerSummary: summary, adjustments, reply, sentTo, date: today,
    },
  });
}
