import { D, HUNDRED, ZERO, allocate, max, min, roundMoney, sum, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { enqueue } from '../../core/jobs.js';
import { requireReason } from '../../core/audit.js';
import type { Services } from '../../services.js';
import { createOutgoingDocument, prepareForTransmission, type DocRow } from '../fiscal-docs/documents.js';
import { createTitles } from '../finance/titles.js';
import { registerCharge } from '../finance/charges.js';
import { postEvent } from '../accounting/posting.js';
import { postMovement } from '../inventory/stock.js';

export const PERIOD_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 } as const;
export type Periodicity = keyof typeof PERIOD_MONTHS;

export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}
const addDays = (date: string, n: number) => new Date(new Date(`${date}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ cadastro

export interface ContractItemInput {
  productId: string;
  description?: string | null;
  billingType?: 'fixed' | 'usage';
  quantity?: string;
  unitPrice: string;
  usageMetric?: string | null;
  includedQuantity?: string;
}

export interface ContractInput {
  establishmentId: string;
  partyId: string;
  periodicity: Periodicity;
  billingDay: number;
  dueDays?: number;
  startDate: string;
  endDate?: string | null;
  autoRenew?: boolean;
  renewalMonths?: number;
  adjustmentIndex?: 'IPCA' | 'IGPM' | 'INPC' | 'fixed' | null;
  adjustmentPercent?: string | null;
  /** Data-base do reajuste (padrão: 12 meses após o início) */
  adjustmentDate?: string | null;
  terminationFinePercent?: string;
  proration?: 'prorata' | 'next_cycle';
  documentModel?: '99' | '55' | 'none';
  paymentMethodId?: string | null;
  chargeKind?: 'boleto' | 'pix_cob' | 'pix_cobv' | null;
  chargeAccountId?: string | null;
  categoryId?: string | null;
  costCenterId?: string | null;
  notes?: string | null;
  items: ContractItemInput[];
}

/** Primeiro faturamento: o dia de faturamento a partir do início do contrato. */
function firstBillingDate(start: string, day: number): string {
  const candidate = `${start.slice(0, 8)}${String(day).padStart(2, '0')}`;
  return candidate >= start ? candidate : addMonths(candidate, 1);
}

export async function createContract(tx: Tx, input: ContractInput) {
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  if (input.adjustmentIndex === 'fixed' && !input.adjustmentPercent) throw validation({ adjustmentPercent: 'Informe o percentual do reajuste fixo' });
  if (input.endDate && input.endDate <= input.startDate) throw validation({ endDate: 'Fim deve ser depois do início' });
  const docModel = input.documentModel ?? '99';
  for (const it of input.items) {
    const p = await tx.one<{ kind: string; service_code: string | null }>(`SELECT kind, service_code FROM catalog.products WHERE id = $1`, [it.productId], 'Produto');
    if (docModel === '99' && !p.service_code) throw validation({ items: 'Contrato com NFS-e exige itens de serviço com código da LC 116' });
    if (it.billingType === 'usage' && !it.usageMetric) throw validation({ items: 'Item por uso precisa da métrica (horas, mensagens, transações...)' });
  }
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'contract') AS n`, [est.company_id])).n;
  const category = input.categoryId ?? (await tx.maybeOne<{ id: string }>(`SELECT id FROM finance.categories WHERE code = '1.1'`))?.id ?? null;
  const c = await tx.one<{ id: string }>(
    `INSERT INTO contracts.contracts (tenant_id, company_id, establishment_id, number, party_id, periodicity, billing_day, due_days, start_date, end_date, auto_renew, renewal_months,
       adjustment_index, adjustment_percent, next_adjustment_date, termination_fine_percent, proration, document_model, payment_method_id, charge_kind, charge_account_id,
       category_id, cost_center_id, next_billing_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING id`,
    [tx.tenantId, est.company_id, input.establishmentId, number, input.partyId, input.periodicity, input.billingDay, input.dueDays ?? 5, input.startDate, input.endDate ?? null,
      input.autoRenew ?? true, input.renewalMonths ?? 12, input.adjustmentIndex ?? null, input.adjustmentPercent ?? null,
      input.adjustmentIndex ? (input.adjustmentDate ?? addMonths(input.startDate, 12)) : null, input.terminationFinePercent ?? '0', input.proration ?? 'prorata', docModel,
      input.paymentMethodId ?? null, input.chargeKind ?? null, input.chargeAccountId ?? null, category, input.costCenterId ?? null, firstBillingDate(input.startDate, input.billingDay),
      input.notes ?? null, tx.userId]);
  for (const it of input.items) await insertItem(tx, c.id, it, input.startDate, 'initial');
  return getContract(tx, c.id);
}

async function insertItem(tx: Tx, contractId: string, it: ContractItemInput, from: string, reason: 'initial' | 'plan_change') {
  const row = await tx.one<{ id: string }>(
    `INSERT INTO contracts.contract_items (tenant_id, contract_id, product_id, description, billing_type, quantity, unit_price, usage_metric, included_quantity, start_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [tx.tenantId, contractId, it.productId, it.description ?? null, it.billingType ?? 'fixed', it.quantity ?? '1', it.unitPrice, it.usageMetric ?? null, it.includedQuantity ?? '0', from]);
  await tx.exec(`INSERT INTO contracts.price_history (tenant_id, contract_id, contract_item_id, valid_from, new_price, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tx.tenantId, contractId, row.id, from, it.unitPrice, reason, tx.userId]);
  return row;
}

export async function getContract(tx: Tx, id: string) {
  const c = await tx.maybeOne(`SELECT c.*, p.legal_name AS party_name FROM contracts.contracts c JOIN registry.parties p ON p.id = c.party_id WHERE c.id = $1`, [id]);
  if (!c) throw notFound('Contrato');
  const items = await tx.query(`SELECT i.*, p.sku, p.description AS product_description, p.service_code FROM contracts.contract_items i JOIN catalog.products p ON p.id = i.product_id
                                 WHERE i.contract_id = $1 ORDER BY i.active DESC, i.created_at`, [id]);
  const history = await tx.query(`SELECT * FROM contracts.price_history WHERE contract_id = $1 ORDER BY valid_from, created_at`, [id]);
  const billings = await tx.query(`SELECT * FROM contracts.billings WHERE contract_id = $1 ORDER BY period_start DESC, created_at DESC LIMIT 36`, [id]);
  return { ...c, items, history, billings, monthlyValue: monthlyValue(c.periodicity, items).toFixed(2) };
}

/** Valor mensal equivalente (para MRR): itens fixos ativos ÷ meses do período. */
function monthlyValue(periodicity: Periodicity, items: Record<string, any>[]): Decimal {
  const period = sum(items.filter((i) => i.active && i.billing_type === 'fixed').map((i) => D(i.quantity).times(i.unit_price)));
  return roundMoney(period.dividedBy(PERIOD_MONTHS[periodicity]));
}

// ------------------------------------------------------------------ reajuste (RN-CTR-01)

/** Índice acumulado nos 12 meses anteriores à data-base: Π(1 + i) − 1. */
export async function accumulatedIndex(tx: Tx, index: string, baseDate: string): Promise<Decimal> {
  const firstMonth = `${addMonths(`${baseDate.slice(0, 7)}-01`, -12)}`;
  const rows = await tx.query<{ month: string; percent: string }>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, percent FROM contracts.index_rates WHERE index_code = $1 AND month >= $2 AND month < $3 ORDER BY month`,
    [index, firstMonth, `${baseDate.slice(0, 7)}-01`]);
  if (rows.length < 12) {
    throw new AppError('INDEX_MISSING', `Índice ${index} incompleto para o reajuste de ${baseDate}: ${rows.length} de 12 meses cadastrados`, 422);
  }
  return rows.reduce((acc, r) => acc.times(D(1).plus(D(r.percent).dividedBy(HUNDRED))), D(1)).minus(1).times(HUNDRED);
}

/**
 * Aplica o reajuste na data-base: atualiza o preço dos itens a partir dela e grava o
 * histórico. Títulos já gerados nunca mudam — o novo preço vale da competência seguinte.
 */
async function applyDueAdjustment(tx: Tx, c: Record<string, any>, periodStart: string) {
  if (!c.adjustment_index || !c.next_adjustment_date) return null;
  const base = c.next_adjustment_date instanceof Date ? c.next_adjustment_date.toISOString().slice(0, 10) : String(c.next_adjustment_date);
  if (base > periodStart) return null;
  const pct = c.adjustment_index === 'fixed' ? D(c.adjustment_percent) : await accumulatedIndex(tx, c.adjustment_index, base);
  const items = await tx.query<{ id: string; unit_price: string }>(`SELECT id, unit_price FROM contracts.contract_items WHERE contract_id = $1 AND active`, [c.id]);
  for (const it of items) {
    const newPrice = roundMoney(D(it.unit_price).times(D(1).plus(pct.dividedBy(HUNDRED))));
    await tx.exec(`UPDATE contracts.contract_items SET unit_price = $2 WHERE id = $1`, [it.id, newPrice.toFixed(2)]);
    await tx.exec(`INSERT INTO contracts.price_history (tenant_id, contract_id, contract_item_id, valid_from, old_price, new_price, reason, index_code, percent, created_by)
                   VALUES ($1,$2,$3,$4,$5,$6,'adjustment',$7,$8,$9)`, [tx.tenantId, c.id, it.id, base, it.unit_price, newPrice.toFixed(2), c.adjustment_index, pct.toFixed(4), tx.userId]);
  }
  await tx.exec(`UPDATE contracts.contracts SET next_adjustment_date = $2 WHERE id = $1`, [c.id, addMonths(base, 12)]);
  return pct.toFixed(4);
}

// ------------------------------------------------------------------ faturamento recorrente

interface BillingLine {
  itemId: string | null;
  productId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  total: string;
  kind: 'fixed' | 'usage' | 'prorata' | 'fine';
  serviceCode: string | null;
}

/**
 * Gera o faturamento de um período (idempotente por contrato + período): reajuste na
 * data-base, itens fixos do período, consumo variável do período anterior (acima da
 * franquia), crédito pendente abatido, documento fiscal (NFS-e ou NF-e), título e cobrança.
 */
export async function billContract(tx: Tx, services: Services, contractId: string, asOf = today()) {
  const c = await tx.one<Record<string, any>>(`SELECT * FROM contracts.contracts WHERE id = $1 FOR UPDATE`, [contractId], 'Contrato');
  if (c.status !== 'active') throw conflict('INVALID_STATUS', `Contrato ${c.status} não fatura`);
  const periodStart = String(c.next_billing_date instanceof Date ? c.next_billing_date.toISOString().slice(0, 10) : c.next_billing_date);
  if (periodStart > asOf) return { skipped: true, nextBillingDate: periodStart };
  const months = PERIOD_MONTHS[c.periodicity as Periodicity];
  const periodEnd = addDays(addMonths(periodStart, months), -1);
  const existing = await tx.maybeOne<{ id: string; status: string }>(`SELECT id, status FROM contracts.billings WHERE contract_id = $1 AND kind = 'regular' AND period_start = $2`, [c.id, periodStart]);
  if (existing?.status === 'invoiced') return { skipped: true, billingId: existing.id };
  const adjusted = await applyDueAdjustment(tx, c, periodStart);
  const items = await tx.query<Record<string, any>>(
    `SELECT i.*, p.description AS product_description, p.service_code FROM contracts.contract_items i JOIN catalog.products p ON p.id = i.product_id
      WHERE i.contract_id = $1 AND i.active AND i.start_date <= $2`, [c.id, periodEnd]);
  const lines: BillingLine[] = [];
  const usageIds: string[] = [];
  for (const it of items) {
    if (it.billing_type === 'fixed') {
      lines.push({ itemId: it.id, productId: it.product_id, description: it.description ?? it.product_description, quantity: D(it.quantity).toString(), unitPrice: D(it.unit_price).toFixed(2),
        total: roundMoney(D(it.quantity).times(it.unit_price)).toFixed(2), kind: 'fixed', serviceCode: it.service_code });
    } else {
      // Consumo do período anterior (cobrança postecipada), acima da franquia
      const usage = await tx.query<{ id: string; quantity: string }>(`SELECT id, quantity FROM contracts.usage WHERE contract_item_id = $1 AND billing_id IS NULL AND occurred_on < $2`, [it.id, periodStart]);
      const used = sum(usage.map((u) => u.quantity));
      usageIds.push(...usage.map((u) => u.id));
      const billable = max(used.minus(it.included_quantity), ZERO);
      if (billable.greaterThan(0)) {
        lines.push({ itemId: it.id, productId: it.product_id, description: `${it.description ?? it.product_description} — ${billable.toString()} ${it.usage_metric} excedentes`,
          quantity: billable.toString(), unitPrice: D(it.unit_price).toFixed(2), total: roundMoney(billable.times(it.unit_price)).toFixed(2), kind: 'usage', serviceCode: it.service_code });
      }
    }
  }
  const billing = existing ?? await tx.one<{ id: string }>(
    `INSERT INTO contracts.billings (tenant_id, contract_id, kind, period_start, period_end) VALUES ($1,$2,'regular',$3,$4) RETURNING id`, [tx.tenantId, c.id, periodStart, periodEnd]);
  const result = await invoiceLines(tx, services, c, billing.id, lines, asOf, `${periodStart.slice(5, 7)}/${periodStart.slice(0, 4)}`);
  if (usageIds.length) await tx.exec(`UPDATE contracts.usage SET billing_id = $2 WHERE id = ANY($1)`, [usageIds, billing.id]);
  // Próximo ciclo; fim do contrato: renova automaticamente ou encerra
  let next = addMonths(periodStart, months);
  let status = 'active';
  let endDate = c.end_date ? String(c.end_date instanceof Date ? c.end_date.toISOString().slice(0, 10) : c.end_date) : null;
  if (endDate && next > endDate) {
    if (c.auto_renew) {
      endDate = addMonths(endDate, c.renewal_months);
      await emit(tx, 'contrato.renovado', { type: 'contract', id: c.id }, { id: c.id, numero: c.number, novoFim: endDate });
    } else {
      status = 'ended';
      next = endDate;
    }
  }
  await tx.exec(`UPDATE contracts.contracts SET next_billing_date = $2, status = $3, end_date = $4 WHERE id = $1`, [c.id, next, status, endDate]);
  await emit(tx, 'contrato.faturado', { type: 'contract', id: c.id }, { id: c.id, numero: c.number, competencia: periodStart, valor: result.amount, reajuste: adjusted });
  return { billingId: billing.id, periodStart, periodEnd, adjustedPercent: adjusted, ...result };
}

/** Documento fiscal + título + cobrança + contábil para as linhas de um faturamento. */
async function invoiceLines(tx: Tx, services: Services, c: Record<string, any>, billingId: string, lines: BillingLine[], date: string, label: string) {
  const gross = sum(lines.map((l) => l.total));
  const credit = min(D(c.credit_balance), gross);
  const amount = gross.minus(credit);
  const docIds: string[] = [];
  let invoiceTotal = ZERO;
  if (amount.greaterThan(0) && c.document_model !== 'none') {
    // NFS-e: uma DPS por código de serviço; NF-e: um documento com todos os itens
    const groups = c.document_model === '99' ? [...new Set(lines.map((l) => l.serviceCode))].map((code) => lines.filter((l) => l.serviceCode === code)) : [lines];
    const creditParts = allocate(credit, lines.map((l) => l.total));
    for (const group of groups) {
      const doc = await createOutgoingDocument(tx, {
        establishmentId: c.establishment_id, operationTypeCode: c.document_model === '99' ? 'SERVICO' : 'VENDA', model: c.document_model as '99' | '55', partyId: c.party_id, date, presence: 9,
        items: group.map((l) => ({ id: `${billingId}:${lines.indexOf(l)}`, productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
          discount: creditParts[lines.indexOf(l)]!.toFixed(2) })),
        additionalInfo: `Contrato nº ${c.number} — competência ${label}`, sourceType: 'contract', sourceId: c.id, idempotencyKey: `contract:${billingId}:${groups.indexOf(group)}`,
        payments: [{ tPag: '90', value: '0.00' }],
      });
      // Pagamento a prazo pelo título do contrato (boleto/Pix)
      await tx.exec(`UPDATE fiscal.documents SET payments = $2 WHERE id = $1`, [doc.id, JSON.stringify([{ tPag: '15', value: doc.total_invoice, indPag: 1 }])]);
      await prepareForTransmission(tx, doc.id);
      await enqueue(tx, 'nota.transmitir', { documentId: doc.id }, { dedupeKey: `t:${doc.id}`, queue: 'fiscal' });
      docIds.push(doc.id);
      invoiceTotal = invoiceTotal.plus(doc.total_invoice);
      await postSale(tx, doc, c, date);
    }
  } else if (amount.greaterThan(0)) {
    invoiceTotal = amount;
    await postEvent(tx, { type: 'titulo_manual_receber', companyId: c.company_id, establishmentId: c.establishment_id, date, description: `Contrato ${c.number} ${label}`,
      number: `CT${c.number}`, originType: 'contract_billing', originId: billingId, partyId: c.party_id, categoryId: c.category_id, amounts: { amount },
      ledgers: { category_ledger: (await tx.maybeOne<{ ledger_account_id: string | null }>(`SELECT ledger_account_id FROM finance.categories WHERE id = $1`, [c.category_id]))?.ledger_account_id } });
  }
  const titleIds: string[] = [];
  let chargeError: string | null = null;
  if (invoiceTotal.greaterThan(0)) {
    const titles = await createTitles(tx, {
      kind: 'receivable', partyId: c.party_id, establishmentId: c.establishment_id, originType: 'contract', originId: c.id, fiscalDocumentId: docIds[0] ?? null,
      documentNumber: `CT${c.number}-${label}`, issueDate: date, installments: [{ dueDate: addDays(date, c.due_days), amount: invoiceTotal.toFixed(2) }],
      categoryId: c.category_id, costCenterId: c.cost_center_id, paymentMethodId: c.payment_method_id, accountId: c.charge_account_id, idempotencyKey: `contract:${billingId}`,
    });
    titleIds.push(...titles.map((t) => t.id));
    if (c.charge_kind && c.charge_account_id) {
      // Falha na cobrança não desfaz o faturamento: fica registrada para nova tentativa
      try {
        await tx.savepoint(() => registerCharge(tx, services, titles[0]!.id, c.charge_kind, c.charge_account_id));
      } catch (e) {
        chargeError = `Cobrança: ${(e as Error).message}`;
      }
    }
  }
  if (credit.greaterThan(0)) await tx.exec(`UPDATE contracts.contracts SET credit_balance = credit_balance - $2 WHERE id = $1`, [c.id, credit.toFixed(2)]);
  await tx.exec(`UPDATE contracts.billings SET status = 'invoiced', amount = $2, credit_applied = $3, lines = $4, document_ids = $5, title_ids = $6, attempts = attempts + 1, last_error = $7 WHERE id = $1`,
    [billingId, invoiceTotal.toFixed(2), credit.toFixed(2), JSON.stringify(lines), docIds, titleIds, chargeError]);
  return { amount: invoiceTotal.toFixed(2), creditApplied: credit.toFixed(2), documentIds: docIds, titleIds, lines, chargeError };
}

/** Contabiliza a venda do documento (serviço: ISS e PIS/Cofins; produto: CMV com baixa de estoque). */
async function postSale(tx: Tx, doc: DocRow, c: Record<string, any>, date: string) {
  let cmv = ZERO;
  if (doc.model === '55') {
    const wh = await tx.one<{ id: string }>(`SELECT id FROM core.warehouses WHERE establishment_id = $1 AND kind = 'own' AND active ORDER BY (code = 'PRINCIPAL') DESC LIMIT 1`, [c.establishment_id]);
    const items = await tx.query<{ id: string; product_id: string; quantity: string }>(`SELECT id, product_id, quantity FROM fiscal.document_items WHERE document_id = $1`, [doc.id]);
    for (const it of items) {
      const mv = await postMovement(tx, { warehouseId: wh.id, productId: it.product_id, type: 'sale_out', quantity: it.quantity, sourceType: 'fiscal_document', sourceId: doc.id, sourceItemId: it.id,
        idempotencyKey: `contract-doc:${doc.id}:${it.id}` });
      if (mv) {
        cmv = cmv.plus(mv.total_cost);
        await tx.exec(`UPDATE fiscal.document_items SET stock_quantity = $2, unit_cost = $3 WHERE id = $1`, [it.id, it.quantity, mv.unit_cost]);
      }
    }
  }
  const t = doc.totals as Record<string, string>;
  await postEvent(tx, {
    type: 'venda_faturada', companyId: doc.company_id, establishmentId: doc.establishment_id, date, description: `Contrato ${c.number}`, number: `CT${c.number}`,
    originType: 'fiscal_document', originId: doc.id, operationTypeCode: doc.operation_code, partyId: c.party_id,
    amounts: { invoice_total: doc.total_invoice, receivable_total: doc.total_invoice, st: t.st, fcp_st: t.fcpSt, ipi: t.ipi, icms: t.icms, fcp: t.fcp, difal: t.difal, fcp_dest: t.fcpDest,
      pis: t.pis, cofins: t.cofins, iss: t.iss, cmv },
  });
}

/** Job diário: fatura os contratos do dia; falhas ficam registradas e são tentadas de novo amanhã. */
export async function runRecurringBilling(tx: Tx, services: Services, asOf = today()) {
  const due = await tx.query<{ id: string; number: string }>(`SELECT id, number FROM contracts.contracts WHERE status = 'active' AND next_billing_date <= $1 ORDER BY next_billing_date`, [asOf]);
  const out = { invoiced: 0, failed: 0, errors: [] as { contract: string; error: string }[] };
  for (const c of due) {
    // Um contrato pode ter vários períodos atrasados (job parado): fatura um por vez
    for (let guard = 0; guard < 24; guard++) {
      try {
        const r = await tx.savepoint(() => billContract(tx, services, c.id, asOf));
        if ('skipped' in r && r.skipped) break;
        out.invoiced++;
      } catch (e) {
        out.failed++;
        const msg = (e as Error).message;
        out.errors.push({ contract: c.number, error: msg });
        const ct = await tx.one<{ next_billing_date: string; periodicity: Periodicity }>(`SELECT next_billing_date::text, periodicity FROM contracts.contracts WHERE id = $1`, [c.id]);
        await tx.exec(
          `INSERT INTO contracts.billings (tenant_id, contract_id, kind, period_start, period_end, status, attempts, last_error) VALUES ($1,$2,'regular',$3,$4,'failed',1,$5)
           ON CONFLICT (contract_id, kind, period_start) DO UPDATE SET status = 'failed', attempts = contracts.billings.attempts + 1, last_error = EXCLUDED.last_error`,
          [tx.tenantId, c.id, ct.next_billing_date, addDays(addMonths(ct.next_billing_date, PERIOD_MONTHS[ct.periodicity]), -1), msg.slice(0, 1000)]);
        await emit(tx, 'contrato.falha_faturamento', { type: 'contract', id: c.id }, { id: c.id, numero: c.number, erro: msg });
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ troca de plano (RN-CTR-02)

/**
 * Troca de plano no meio do ciclo: com pro rata, a diferença dos dias restantes do
 * período já faturado vira cobrança imediata (upgrade) ou crédito no próximo
 * faturamento (downgrade); sem pro rata, vale a partir do próximo ciclo.
 */
export async function changePlan(tx: Tx, services: Services, contractId: string, input: { items: ContractItemInput[]; effectiveDate: string }) {
  const c = await tx.one<Record<string, any>>(`SELECT * FROM contracts.contracts WHERE id = $1 FOR UPDATE`, [contractId], 'Contrato');
  if (c.status !== 'active') throw conflict('INVALID_STATUS', 'Somente contrato ativo troca de plano');
  const oldItems = await tx.query<Record<string, any>>(`SELECT * FROM contracts.contract_items WHERE contract_id = $1 AND active`, [contractId]);
  const oldValue = sum(oldItems.filter((i) => i.billing_type === 'fixed').map((i) => D(i.quantity).times(i.unit_price)));
  const newValue = sum(input.items.filter((i) => (i.billingType ?? 'fixed') === 'fixed').map((i) => D(i.quantity ?? '1').times(i.unitPrice)));
  await tx.exec(`UPDATE contracts.contract_items SET active = false, end_date = $2 WHERE contract_id = $1 AND active`, [contractId, addDays(input.effectiveDate, -1)]);
  for (const it of input.items) await insertItem(tx, contractId, it, input.effectiveDate, 'plan_change');
  // Período faturado em curso: [início, próximo faturamento)
  const next = String(c.next_billing_date instanceof Date ? c.next_billing_date.toISOString().slice(0, 10) : c.next_billing_date);
  const months = PERIOD_MONTHS[c.periodicity as Periodicity];
  const periodStart = addMonths(next, -months);
  const billed = await tx.maybeOne(`SELECT 1 FROM contracts.billings WHERE contract_id = $1 AND kind = 'regular' AND period_start = $2 AND status = 'invoiced'`, [contractId, periodStart]);
  let prorata: { amount: string; kind: 'charge' | 'credit'; days: number } | null = null;
  if (c.proration === 'prorata' && billed && input.effectiveDate < next && input.effectiveDate >= periodStart) {
    const totalDays = daysBetween(periodStart, next);
    const remaining = daysBetween(input.effectiveDate, next);
    const diff = roundMoney(newValue.minus(oldValue).times(remaining).dividedBy(totalDays));
    if (diff.greaterThan(0)) {
      const billing = await tx.one<{ id: string }>(`INSERT INTO contracts.billings (tenant_id, contract_id, kind, period_start, period_end) VALUES ($1,$2,'prorata',$3,$4) RETURNING id`,
        [tx.tenantId, contractId, input.effectiveDate, addDays(next, -1)]);
      const first = input.items[0]!;
      const p = await tx.one<{ service_code: string | null; description: string }>(`SELECT service_code, description FROM catalog.products WHERE id = $1`, [first.productId]);
      await invoiceLines(tx, services, { ...c, credit_balance: '0' }, billing.id, [{ itemId: null, productId: first.productId, description: `Ajuste pro rata (${remaining} de ${totalDays} dias)`,
        quantity: '1', unitPrice: diff.toFixed(2), total: diff.toFixed(2), kind: 'prorata', serviceCode: p.service_code }], input.effectiveDate, `pro rata ${input.effectiveDate}`);
      prorata = { amount: diff.toFixed(2), kind: 'charge', days: remaining };
    } else if (diff.lessThan(0)) {
      await tx.exec(`UPDATE contracts.contracts SET credit_balance = credit_balance + $2 WHERE id = $1`, [contractId, diff.negated().toFixed(2)]);
      prorata = { amount: diff.negated().toFixed(2), kind: 'credit', days: remaining };
    }
  }
  return { contract: await getContract(tx, contractId), prorata };
}

// ------------------------------------------------------------------ rescisão, consumo e indicadores

export async function cancelContract(tx: Tx, services: Services, contractId: string, input: { reason: string; date?: string; applyFine?: boolean }) {
  await requireReason(tx, input.reason, 'contratos.contrato.cancelar');
  const c = await tx.one<Record<string, any>>(`SELECT * FROM contracts.contracts WHERE id = $1 FOR UPDATE`, [contractId], 'Contrato');
  if (['cancelled', 'ended'].includes(c.status)) throw conflict('INVALID_STATUS', 'Contrato já encerrado');
  const date = input.date ?? today();
  let fine: string | null = null;
  const end = c.end_date ? String(c.end_date instanceof Date ? c.end_date.toISOString().slice(0, 10) : c.end_date) : null;
  if (input.applyFine !== false && D(c.termination_fine_percent).greaterThan(0) && end && end > date) {
    // Multa sobre o valor restante do contrato (meses até o fim × valor mensal)
    const items = await tx.query(`SELECT * FROM contracts.contract_items WHERE contract_id = $1 AND active`, [contractId]);
    const remainingMonths = Math.max(0, Math.ceil(daysBetween(date, end) / 30));
    const value = roundMoney(monthlyValue(c.periodicity, items).times(remainingMonths).times(c.termination_fine_percent).dividedBy(HUNDRED));
    if (value.greaterThan(0)) {
      const billing = await tx.one<{ id: string }>(`INSERT INTO contracts.billings (tenant_id, contract_id, kind, period_start, period_end) VALUES ($1,$2,'termination',$3,$3) RETURNING id`,
        [tx.tenantId, contractId, date]);
      await invoiceLines(tx, services, { ...c, document_model: 'none', credit_balance: '0' }, billing.id, [{ itemId: null, productId: items[0]!.product_id,
        description: `Multa rescisória (${remainingMonths} meses restantes)`, quantity: '1', unitPrice: value.toFixed(2), total: value.toFixed(2), kind: 'fine', serviceCode: null }], date, 'rescisão');
      fine = value.toFixed(2);
    }
  }
  await tx.exec(`UPDATE contracts.contracts SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, end_date = $3 WHERE id = $1`, [contractId, input.reason, date]);
  await emit(tx, 'contrato.cancelado', { type: 'contract', id: contractId }, { id: contractId, numero: c.number, motivo: input.reason, multa: fine });
  return { status: 'cancelled', fine };
}

export async function recordUsage(tx: Tx, input: { contractItemId: string; occurredOn: string; quantity: string; reference: string; source?: 'api' | 'csv' | 'meter' | 'manual' }) {
  const it = await tx.one<{ billing_type: string }>(`SELECT billing_type FROM contracts.contract_items WHERE id = $1`, [input.contractItemId], 'Item do contrato');
  if (it.billing_type !== 'usage') throw validation({ contractItemId: 'Item não é cobrado por uso' });
  const r = await tx.maybeOne(
    `INSERT INTO contracts.usage (tenant_id, contract_item_id, occurred_on, quantity, source, reference) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (contract_item_id, reference) DO NOTHING RETURNING *`,
    [tx.tenantId, input.contractItemId, input.occurredOn, input.quantity, input.source ?? 'api', input.reference]);
  return r ?? { duplicate: true };
}

/** MRR, churn, receita por cliente, inadimplência por contrato e renovações nos próximos 60 dias. */
export async function contractIndicators(tx: Tx, companyId: string | null, date = today()) {
  const monthStart = `${date.slice(0, 7)}-01`;
  const active = await tx.query<Record<string, any>>(`SELECT * FROM contracts.contracts WHERE status = 'active' AND ($1::uuid IS NULL OR company_id = $1)`, [companyId]);
  let mrr = ZERO;
  const byCustomer = new Map<string, Decimal>();
  for (const c of active) {
    const items = await tx.query(`SELECT * FROM contracts.contract_items WHERE contract_id = $1 AND active`, [c.id]);
    const v = monthlyValue(c.periodicity, items);
    mrr = mrr.plus(v);
    byCustomer.set(c.party_id, (byCustomer.get(c.party_id) ?? ZERO).plus(v));
  }
  const churn = await tx.one<{ cancelled: number; at_start: number }>(
    `SELECT count(*) FILTER (WHERE cancelled_at >= $2::date AND cancelled_at < ($2::date + interval '1 month'))::int AS cancelled,
            count(*) FILTER (WHERE start_date < $2::date AND (cancelled_at IS NULL OR cancelled_at >= $2::date) AND status <> 'draft')::int AS at_start
       FROM contracts.contracts WHERE ($1::uuid IS NULL OR company_id = $1)`, [companyId, monthStart]);
  const delinquency = await tx.query(
    `SELECT c.number, p.legal_name AS customer, sum(t.balance) AS overdue, count(*)::int AS titles FROM finance.titles t JOIN contracts.contracts c ON c.id = t.origin_id
       JOIN registry.parties p ON p.id = c.party_id
      WHERE t.origin_type = 'contract' AND t.status IN ('open','partially_paid') AND t.due_date < $2 AND ($1::uuid IS NULL OR c.company_id = $1)
      GROUP BY c.number, p.legal_name ORDER BY overdue DESC`, [companyId, date]);
  const renewals = await tx.query(
    `SELECT c.id, c.number, p.legal_name AS customer, c.end_date, c.auto_renew FROM contracts.contracts c JOIN registry.parties p ON p.id = c.party_id
      WHERE c.status = 'active' AND c.end_date BETWEEN $2 AND $2::date + 60 AND ($1::uuid IS NULL OR c.company_id = $1) ORDER BY c.end_date`, [companyId, date]);
  return {
    mrr: mrr.toFixed(2), arr: mrr.times(12).toFixed(2), activeContracts: active.length, customers: byCustomer.size,
    revenuePerCustomer: byCustomer.size ? mrr.dividedBy(byCustomer.size).toFixed(2) : '0.00',
    churnPercent: churn.at_start ? D(churn.cancelled).dividedBy(churn.at_start).times(100).toFixed(2) : '0.00', cancelledThisMonth: churn.cancelled,
    delinquency, renewalsNext60Days: renewals,
  };
}

export { ruleViolation };
