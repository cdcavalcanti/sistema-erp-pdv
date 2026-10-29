import { allocate, D, ZERO, HUNDRED, max, min, roundMoney, splitInstallments, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, forbidden, notFound, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { auditAction, requireReason } from '../../core/audit.js';
import { postEvent, reverseEntries } from '../accounting/posting.js';

export interface TitleRow {
  id: string;
  company_id: string;
  establishment_id: string | null;
  kind: 'receivable' | 'payable';
  document_number: string;
  installment: number;
  party_id: string;
  origin_type: string;
  origin_id: string | null;
  fiscal_document_id: string | null;
  due_date: string;
  amount: string;
  balance: string;
  paid_principal: string;
  paid_interest: string;
  paid_fine: string;
  discount_given: string;
  abatements: string;
  fine_percent: string;
  interest_month_percent: string;
  status: string;
  account_id: string | null;
  category_id: string | null;
  cost_center_id: string | null;
  approved_at: Date | null;
  created_by: string | null;
  version: number;
  [k: string]: any;
}

export interface InstallmentInput {
  dueDate: string;
  amount: string;
}

/** Parcelas a partir da condição de pagamento (dias e percentuais; entrada; dia fixo). */
export async function installmentsFromTerm(tx: Tx, paymentTermId: string | null, total: string, baseDate: string): Promise<InstallmentInput[]> {
  if (!paymentTermId) return [{ dueDate: baseDate, amount: D(total).toFixed(2) }];
  const term = await tx.one<{ installments: { days: number; percent: string }[]; down_payment_percent: string; fixed_due_day: number | null }>(
    `SELECT installments, down_payment_percent, fixed_due_day FROM registry.payment_terms WHERE id = $1`, [paymentTermId], 'Condição de pagamento');
  const percents = [...(D(term.down_payment_percent).greaterThan(0) ? [term.down_payment_percent] : []), ...term.installments.map((i) => i.percent)];
  const days = [...(D(term.down_payment_percent).greaterThan(0) ? [0] : []), ...term.installments.map((i) => i.days)];
  const parts = splitInstallments(total, percents);
  return parts.map((amount, i) => {
    const d = new Date(`${baseDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days[i]!);
    if (term.fixed_due_day && days[i]! > 0) {
      const day = Math.min(term.fixed_due_day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate());
      if (d.getUTCDate() > day) d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(day);
    }
    return { dueDate: d.toISOString().slice(0, 10), amount: amount.toFixed(2) };
  });
}

export interface CreateTitlesInput {
  kind: 'receivable' | 'payable';
  partyId: string;
  establishmentId?: string | null;
  originType: string;
  originId?: string | null;
  fiscalDocumentId?: string | null;
  documentNumber: string;
  issueDate: string;
  competenceDate?: string;
  installments: InstallmentInput[];
  categoryId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  paymentMethodId?: string | null;
  accountId?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
  card?: { grossAmount: string; feeAmount: string } | null;
  /** Conta contábil de controle (ex.: salários a pagar); a baixa debita/credita essa conta */
  ledgerAccountId?: string | null;
}

export async function createTitles(tx: Tx, input: CreateTitlesInput): Promise<TitleRow[]> {
  if (input.idempotencyKey) {
    const ex = await tx.query<TitleRow>(`SELECT * FROM finance.titles WHERE idempotency_key LIKE $1 || ':%' ORDER BY installment`, [input.idempotencyKey]);
    if (ex.length) return ex;
  }
  const company = await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [tx.companyId]);
  const party = await tx.one<{ kind: string; final_consumer: boolean }>(`SELECT kind, final_consumer FROM registry.parties WHERE id = $1`, [input.partyId], 'Pessoa');
  let fine = D(company.settings?.finance?.finePercent ?? '2');
  // RN-FIN-02: em relação de consumo a multa por atraso é limitada a 2% (CDC art. 52)
  if (input.kind === 'receivable' && party.kind === 'PF' && party.final_consumer) fine = min(fine, 2);
  const interest = company.settings?.finance?.interestMonthPercent ?? '1';
  const total = input.installments.length;
  const out: TitleRow[] = [];
  for (const [i, inst] of input.installments.entries()) {
    if (D(inst.amount).lessThanOrEqualTo(0)) continue;
    const t = await tx.one<TitleRow>(
      `INSERT INTO finance.titles (tenant_id, company_id, establishment_id, kind, document_number, installment, installments_total, party_id, origin_type, origin_id, fiscal_document_id,
         issue_date, competence_date, due_date_original, due_date, amount, balance, fine_percent, interest_month_percent, category_id, cost_center_id, project_id, payment_method_id,
         account_id, gross_amount, fee_amount, notes, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING *`,
      [tx.tenantId, tx.companyId, input.establishmentId ?? null, input.kind, input.documentNumber, i + 1, total, input.partyId, input.originType, input.originId ?? null,
        input.fiscalDocumentId ?? null, input.issueDate, input.competenceDate ?? input.issueDate, inst.dueDate, inst.amount, input.kind === 'receivable' ? fine.toFixed(4) : '0',
        input.kind === 'receivable' ? interest : '0', input.categoryId ?? null, input.costCenterId ?? null, input.projectId ?? null, input.paymentMethodId ?? null, input.accountId ?? null,
        input.card?.grossAmount ?? null, input.card?.feeAmount ?? null, input.notes ?? null, input.idempotencyKey ? `${input.idempotencyKey}:${i + 1}` : null, tx.userId]);
    if (input.ledgerAccountId) await tx.exec(`UPDATE finance.titles SET ledger_account_id = $2 WHERE id = $1`, [t.id, input.ledgerAccountId]);
    out.push(t);
    await emit(tx, 'titulo.criado', { type: 'title', id: t.id }, { id: t.id, tipo: t.kind, valor: t.amount, vencimento: t.due_date, pessoa: t.party_id });
  }
  return out;
}

/**
 * Encargos de atraso (RN-FIN-02): multa (%) uma vez e juros de mora (% ao mês, pro rata dia),
 * calculados sobre o saldo em aberto.
 */
export function computeCharges(t: Pick<TitleRow, 'due_date' | 'balance' | 'fine_percent' | 'interest_month_percent' | 'paid_fine'>, date: string): { fine: Decimal; interest: Decimal; daysLate: number } {
  const daysLate = Math.max(0, Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${t.due_date}T00:00:00Z`)) / 86_400_000));
  if (daysLate === 0) return { fine: ZERO, interest: ZERO, daysLate };
  const bal = D(t.balance);
  const fine = D(t.paid_fine).greaterThan(0) ? ZERO : roundMoney(bal.times(t.fine_percent).dividedBy(HUNDRED));
  const interest = roundMoney(bal.times(t.interest_month_percent).dividedBy(HUNDRED).dividedBy(30).times(daysLate));
  return { fine, interest, daysLate };
}

async function ledgerOfAccount(tx: Tx, accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  return (await tx.maybeOne<{ ledger_account_id: string | null }>(`SELECT ledger_account_id FROM finance.accounts WHERE id = $1`, [accountId]))?.ledger_account_id ?? null;
}

export interface SettleInput {
  date: string;
  accountId: string;
  /** Valor efetivamente recebido/pago (dinheiro) */
  amount: string;
  /** Encargos negociados; se omitidos, são calculados */
  interest?: string;
  fine?: string;
  discount?: string;
  method?: string;
  reference?: string;
  idempotencyKey?: string | null;
  batchId?: string | null;
  /** Encargos dispensados por quem tem permissão */
  waiveCharges?: boolean;
  /** RN-REF-06: parcela de IBS/CBS retida pelo meio de pagamento (o valor recebido é o líquido) */
  splitTax?: string;
}

/**
 * Baixa de título (RN-FIN-03): parcial mantém o título aberto com saldo; ordem de
 * abatimento configurável (primeiro juros e multa, depois principal). Gera o
 * movimento de conta e o lançamento contábil na mesma transação.
 */
export async function settleTitle(tx: Tx, titleId: string, s: SettleInput) {
  if (s.idempotencyKey) {
    const ex = await tx.maybeOne(`SELECT * FROM finance.settlements WHERE idempotency_key = $1`, [s.idempotencyKey]);
    if (ex) return ex;
  }
  const t = await tx.one<TitleRow>(`SELECT * FROM finance.titles WHERE id = $1 FOR UPDATE`, [titleId], 'Título');
  if (!['open', 'partially_paid'].includes(t.status)) throw conflict('TITLE_CLOSED', `Título ${t.status === 'paid' ? 'já pago' : t.status}`);
  if (t.kind === 'payable' && !t.approved_at) throw ruleViolation('RN-ACE-01', 'Pagamento exige título aprovado');
  const company = await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [t.company_id]);
  const calc = computeCharges(t, s.date);
  let fine = s.fine !== undefined ? D(s.fine) : s.waiveCharges ? ZERO : calc.fine;
  let interest = s.interest !== undefined ? D(s.interest) : s.waiveCharges ? ZERO : calc.interest;
  const discount = D(s.discount ?? '0');
  // Desconto por antecipação vigente
  const early = t.early_discount_until && s.date <= t.early_discount_until ? D(t.early_discount_amount) : ZERO;
  const totalDiscount = discount.plus(early);
  let cash = D(s.amount);
  if (cash.lessThanOrEqualTo(0) && totalDiscount.isZero()) throw validation({ amount: 'Valor deve ser maior que zero' });
  const order = company.settings?.finance?.abatementOrder ?? 'charges_first';
  let principal: Decimal;
  if (order === 'charges_first') {
    const charges = fine.plus(interest);
    if (cash.lessThan(charges)) {
      // Valor não cobre os encargos: abate primeiro a multa, depois os juros
      fine = min(fine, cash);
      interest = min(interest, cash.minus(fine));
    }
    principal = cash.minus(fine).minus(interest);
  } else {
    principal = min(cash, D(t.balance).minus(totalDiscount));
    const rest = cash.minus(principal);
    fine = min(fine, rest);
    interest = min(interest, rest.minus(fine));
  }
  principal = max(ZERO, principal);
  // Split payment: o tributo retido na liquidação quita o título junto com o valor líquido recebido
  const split = D(s.splitTax ?? '0');
  if (split.greaterThan(0)) {
    if (t.kind !== 'receivable') throw validation({ splitTax: 'Split payment só se aplica a recebimentos' });
    const used = await tx.one<{ v: string | null }>(`SELECT sum(split_tax) AS v FROM finance.settlements WHERE title_id = $1 AND NOT reversed`, [titleId]);
    if (split.greaterThan(D(t.split_tax_amount).minus(used.v ?? 0))) throw validation({ splitTax: 'Parcela de split maior que a prevista no título' });
    principal = principal.plus(split);
  }
  const balance = D(t.balance);
  if (principal.plus(totalDiscount).greaterThan(balance)) {
    throw validation({ amount: `Valor maior que o saldo do título (${balance.toFixed(2)} + encargos ${fine.plus(interest).toFixed(2)})` });
  }
  cash = principal.minus(split).plus(fine).plus(interest);
  const newBalance = balance.minus(principal).minus(totalDiscount);
  const status = newBalance.isZero() ? 'paid' : 'partially_paid';
  const mv = cash.greaterThan(0)
    ? await tx.one<{ id: string }>(
      `INSERT INTO finance.account_movements (tenant_id, company_id, account_id, movement_date, direction, amount, description, category_id, cost_center_id, party_id, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'settlement',$11) RETURNING id`,
      [tx.tenantId, t.company_id, s.accountId, s.date, t.kind === 'receivable' ? 'C' : 'D', cash.toFixed(2),
        `${t.kind === 'receivable' ? 'Recebimento' : 'Pagamento'} ${t.document_number}/${t.installment}`, t.category_id, t.cost_center_id, t.party_id, tx.userId])
    : null;
  const st = await tx.one(
    `INSERT INTO finance.settlements (tenant_id, company_id, title_id, settlement_date, account_id, principal, interest, fine, discount, total, kind, method, reference,
       account_movement_id, batch_id, idempotency_key, created_by, split_tax)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'payment',$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [tx.tenantId, t.company_id, titleId, s.date, s.accountId, principal.toFixed(2), interest.toFixed(2), fine.toFixed(2), totalDiscount.toFixed(2), cash.toFixed(2),
      s.method ?? null, s.reference ?? null, mv?.id ?? null, s.batchId ?? null, s.idempotencyKey ?? null, tx.userId, split.toFixed(2)]);
  if (mv) await tx.exec(`UPDATE finance.account_movements SET settlement_id = $2 WHERE id = $1`, [mv.id, st.id]);
  await tx.exec(
    `UPDATE finance.titles SET paid_principal = paid_principal + $2, paid_interest = paid_interest + $3, paid_fine = paid_fine + $4, discount_given = discount_given + $5,
            balance = $6, status = $7 WHERE id = $1`,
    [titleId, principal.toFixed(2), interest.toFixed(2), fine.toFixed(2), totalDiscount.toFixed(2), newBalance.toFixed(2), status]);
  await postEvent(tx, {
    type: t.kind === 'receivable' ? 'recebimento' : 'pagamento', companyId: t.company_id, establishmentId: t.establishment_id, date: s.date,
    description: `${t.kind === 'receivable' ? 'Recebimento' : 'Pagamento'} ${t.document_number}/${t.installment}`, number: `${t.document_number}/${t.installment}`,
    originType: 'settlement', originId: st.id, partyId: t.party_id, costCenterId: t.cost_center_id, categoryId: t.category_id,
    amounts: { total: cash, principal, interest, fine, discount: totalDiscount, split_tax: split },
    ledgers: { settlement_ledger: await ledgerOfAccount(tx, s.accountId),
      title_ledger: t.ledger_account_id ?? (t.gross_amount ? (await tx.maybeOne<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = '1.1.2.02'`))?.id : null) },
  });
  if (status === 'paid') await emit(tx, 'titulo.pago', { type: 'title', id: titleId }, { id: titleId, tipo: t.kind, valor: cash.toFixed(2), origem: t.origin_type, origemId: t.origin_id });
  return st;
}

/** RN-FIN-06: estorno só pelo caminho inverso e com motivo; baixa conciliada exige desfazer a conciliação. */
export async function reverseSettlement(tx: Tx, settlementId: string, reason: string) {
  await requireReason(tx, reason, 'financeiro.baixa.estornar');
  const s = await tx.one<Record<string, any>>(`SELECT * FROM finance.settlements WHERE id = $1 FOR UPDATE`, [settlementId], 'Baixa');
  if (s.reversed || s.kind === 'reversal') throw conflict('ALREADY_REVERSED', 'Baixa já estornada');
  if (s.account_movement_id) {
    const mv = await tx.one<{ reconciled: boolean }>(`SELECT reconciled FROM finance.account_movements WHERE id = $1`, [s.account_movement_id]);
    if (mv.reconciled) throw ruleViolation('RN-FIN-06', 'Baixa conciliada com o extrato: desfaça a conciliação antes de estornar');
  }
  const t = await tx.one<TitleRow>(`SELECT * FROM finance.titles WHERE id = $1 FOR UPDATE`, [s.title_id]);
  const today = new Date().toISOString().slice(0, 10);
  let revMv: { id: string } | null = null;
  if (s.account_movement_id) {
    const mv = await tx.one(`SELECT * FROM finance.account_movements WHERE id = $1`, [s.account_movement_id]);
    revMv = await tx.one<{ id: string }>(
      `INSERT INTO finance.account_movements (tenant_id, company_id, account_id, movement_date, direction, amount, description, party_id, reversal_of, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reversal',$10) RETURNING id`,
      [tx.tenantId, mv.company_id, mv.account_id, today, mv.direction === 'C' ? 'D' : 'C', mv.amount, `Estorno: ${mv.description}`, mv.party_id, mv.id, tx.userId]);
  }
  const rev = await tx.one(
    `INSERT INTO finance.settlements (tenant_id, company_id, title_id, settlement_date, account_id, principal, interest, fine, discount, total, kind, reversal_of, account_movement_id, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'reversal',$11,$12,$13,$14) RETURNING *`,
    [tx.tenantId, s.company_id, s.title_id, today, s.account_id, s.principal, s.interest, s.fine, s.discount, s.total, s.id, revMv?.id ?? null, reason, tx.userId]);
  await tx.exec(`UPDATE finance.settlements SET reversed = true WHERE id = $1`, [s.id]);
  const newBalance = D(t.balance).plus(s.principal).plus(s.discount).plus(s.kind === 'abatement' ? s.abatement : 0);
  await tx.exec(
    `UPDATE finance.titles SET paid_principal = paid_principal - $2, paid_interest = paid_interest - $3, paid_fine = paid_fine - $4, discount_given = discount_given - $5,
            abatements = abatements - $6, balance = $7, status = CASE WHEN $7::numeric = amount THEN 'open' ELSE 'partially_paid' END WHERE id = $1`,
    [s.title_id, s.principal, s.interest, s.fine, s.discount, s.abatement, newBalance.toFixed(2)]);
  await reverseEntries(tx, 'settlement', s.id, today, reason);
  return rev;
}

/** Abatimento (ex.: devolução) — reduz o saldo sem movimento de dinheiro. */
export async function abateTitle(tx: Tx, titleId: string, amount: string, reason: string, origin?: { type: string; id: string }) {
  const t = await tx.one<TitleRow>(`SELECT * FROM finance.titles WHERE id = $1 FOR UPDATE`, [titleId], 'Título');
  const a = min(D(amount), D(t.balance));
  if (a.lessThanOrEqualTo(0)) return null;
  const newBalance = D(t.balance).minus(a);
  await tx.exec(`UPDATE finance.titles SET abatements = abatements + $2, balance = $3, status = CASE WHEN $3::numeric = 0 THEN 'paid' ELSE 'partially_paid' END WHERE id = $1`,
    [titleId, a.toFixed(2), newBalance.toFixed(2)]);
  return tx.one(
    `INSERT INTO finance.settlements (tenant_id, company_id, title_id, settlement_date, abatement, total, kind, reason, reference, created_by)
     VALUES ($1,$2,$3,current_date,$4,0,'abatement',$5,$6,$7) RETURNING *`,
    [tx.tenantId, t.company_id, titleId, a.toFixed(2), reason, origin ? `${origin.type}:${origin.id}` : null, tx.userId]);
}

/**
 * RN-FIN-04: renegociação cancela os títulos originais (status "renegociado") e cria
 * novos vinculados, preservando histórico, encargos negociados e desconto (vai para a DRE).
 */
export async function renegotiate(tx: Tx, input: { titleIds: string[]; installments: InstallmentInput[]; chargesNegotiated: string; discountGranted: string; reason: string; date?: string }) {
  await requireReason(tx, input.reason, 'financeiro.titulo.renegociar');
  const titles = await tx.query<TitleRow>(`SELECT * FROM finance.titles WHERE id = ANY($1) FOR UPDATE`, [input.titleIds]);
  if (titles.length !== input.titleIds.length) throw notFound('Título');
  const party = titles[0]!.party_id;
  if (titles.some((t) => t.party_id !== party || t.kind !== 'receivable' || !['open', 'partially_paid'].includes(t.status))) {
    throw validation({ titleIds: 'Renegocie títulos a receber em aberto do mesmo cliente' });
  }
  const balance = titles.reduce((a, t) => a.plus(t.balance), ZERO);
  const newTotal = balance.plus(input.chargesNegotiated).minus(input.discountGranted);
  const sumInst = input.installments.reduce((a, i) => a.plus(i.amount), ZERO);
  if (!sumInst.equals(newTotal)) throw validation({ installments: `Parcelas (${sumInst.toFixed(2)}) devem somar o novo total (${newTotal.toFixed(2)})` });
  const reneg = await tx.one<{ id: string }>(
    `INSERT INTO finance.renegotiations (tenant_id, company_id, party_id, original_balance, charges_negotiated, discount_granted, new_total, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tx.tenantId, titles[0]!.company_id, party, balance.toFixed(2), input.chargesNegotiated, input.discountGranted, newTotal.toFixed(2), input.reason, tx.userId]);
  for (const t of titles) {
    await tx.exec(`INSERT INTO finance.settlements (tenant_id, company_id, title_id, settlement_date, principal, total, kind, reason, created_by) VALUES ($1,$2,$3,current_date,$4,0,'renegotiation',$5,$6)`,
      [tx.tenantId, t.company_id, t.id, t.balance, input.reason, tx.userId]);
    await tx.exec(`UPDATE finance.titles SET status = 'renegotiated', paid_principal = paid_principal + balance, balance = 0, renegotiation_id = $2 WHERE id = $1`, [t.id, reneg.id]);
  }
  const created = await createTitles(tx, {
    kind: 'receivable', partyId: party, originType: 'renegotiation', originId: reneg.id, documentNumber: `RENEG-${titles[0]!.document_number}`,
    issueDate: input.date ?? new Date().toISOString().slice(0, 10), installments: input.installments, categoryId: titles[0]!.category_id, establishmentId: titles[0]!.establishment_id,
  });
  await postEvent(tx, { type: 'renegociacao', companyId: titles[0]!.company_id, date: input.date ?? new Date().toISOString().slice(0, 10), description: 'Renegociação', number: reneg.id.slice(0, 8),
    originType: 'renegotiation', originId: reneg.id, partyId: party, amounts: { charges: input.chargesNegotiated, discount: input.discountGranted } });
  return { renegotiationId: reneg.id, titles: created };
}

/** RN-FIN-05: adiantamento fica como crédito na conta da pessoa. */
export async function createAdvance(tx: Tx, input: { partyId: string; from: 'customer' | 'supplier'; amount: string; accountId: string; date: string; reference?: string }) {
  // Adiantamento de cliente: dinheiro entra e vira um "título a pagar" (crédito do cliente). De fornecedor: o inverso.
  const kind = input.from === 'customer' ? 'payable' : 'receivable';
  const [title] = await createTitles(tx, {
    kind, partyId: input.partyId, originType: 'advance', documentNumber: `ADT-${input.reference ?? new Date().toISOString().slice(0, 10)}`, issueDate: input.date,
    installments: [{ dueDate: input.date, amount: input.amount }],
  });
  await tx.exec(`UPDATE finance.titles SET approved_at = now(), approved_by = $2 WHERE id = $1`, [title!.id, tx.userId]);
  await tx.one(
    `INSERT INTO finance.account_movements (tenant_id, company_id, account_id, movement_date, direction, amount, description, party_id, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'advance',$9) RETURNING id`,
    [tx.tenantId, tx.companyId, input.accountId, input.date, input.from === 'customer' ? 'C' : 'D', input.amount, `Adiantamento ${input.from === 'customer' ? 'de cliente' : 'a fornecedor'}`, input.partyId, tx.userId]);
  await postEvent(tx, { type: input.from === 'customer' ? 'adiantamento_cliente' : 'adiantamento_fornecedor', companyId: tx.companyId, date: input.date, description: 'Adiantamento',
    number: title!.document_number, originType: 'advance', originId: title!.id, partyId: input.partyId, amounts: { amount: input.amount }, ledgers: { settlement_ledger: await ledgerOfAccount(tx, input.accountId) } });
  return title;
}

/** Compensa adiantamento com títulos futuros da mesma pessoa. */
export async function compensateAdvance(tx: Tx, advanceTitleId: string, titleId: string, amount?: string) {
  const adv = await tx.one<TitleRow>(`SELECT * FROM finance.titles WHERE id = $1 FOR UPDATE`, [advanceTitleId], 'Adiantamento');
  const t = await tx.one<TitleRow>(`SELECT * FROM finance.titles WHERE id = $1 FOR UPDATE`, [titleId], 'Título');
  if (adv.origin_type !== 'advance' || adv.party_id !== t.party_id || adv.kind === t.kind) throw validation({ advanceTitleId: 'Adiantamento incompatível com o título' });
  const value = min(D(amount ?? adv.balance), min(D(adv.balance), D(t.balance)));
  if (value.lessThanOrEqualTo(0)) throw validation({ amount: 'Nada a compensar' });
  for (const [row, other] of [[adv, t], [t, adv]] as const) {
    const nb = D(row.balance).minus(value);
    await tx.exec(`UPDATE finance.titles SET paid_principal = paid_principal + $2, balance = $3, status = CASE WHEN $3::numeric = 0 THEN 'paid' ELSE 'partially_paid' END WHERE id = $1`,
      [row.id, value.toFixed(2), nb.toFixed(2)]);
    await tx.exec(`INSERT INTO finance.settlements (tenant_id, company_id, title_id, settlement_date, principal, total, kind, advance_title_id, created_by)
                   VALUES ($1,$2,$3,current_date,$4,0,'advance_compensation',$5,$6)`, [tx.tenantId, row.company_id, row.id, value.toFixed(2), other.id, tx.userId]);
  }
  await postEvent(tx, { type: 'compensacao_adiantamento', companyId: t.company_id, date: new Date().toISOString().slice(0, 10), description: 'Compensação de adiantamento',
    number: t.document_number, originType: 'advance_compensation', originId: t.id, partyId: t.party_id, amounts: { amount: value },
    ledgers: t.kind === 'payable' ? { advance_ledger: (await tx.maybeOne<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = '2.1.1'`))?.id,
      title_ledger: (await tx.maybeOne<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = '1.1.5'`))?.id } : {} });
  return { compensated: value.toFixed(2) };
}

/**
 * Aprovação de pagamento com segregação de funções (RN-ACE-01): quem cadastrou o
 * fornecedor ou a conta bancária dele não aprova o pagamento para ele.
 */
export async function approvePayable(tx: Tx, titleId: string) {
  const t = await tx.one<TitleRow>(`SELECT * FROM finance.titles WHERE id = $1 FOR UPDATE`, [titleId], 'Título');
  if (t.kind !== 'payable') throw validation({ titleId: 'Somente títulos a pagar são aprovados' });
  if (t.approved_at) return t;
  const company = await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [t.company_id]);
  const segregation = company.settings?.finance?.segregationOfDuties !== false;
  if (segregation && !tx.ctx.permissions.has('*')) {
    const conflictRow = await tx.maybeOne(
      `SELECT 1 FROM registry.parties p WHERE p.id = $1 AND p.created_by = $2
        UNION ALL SELECT 1 FROM registry.party_bank_accounts b WHERE b.party_id = $1 AND b.created_by = $2 AND b.status = 'active'
        UNION ALL SELECT 1 FROM finance.titles x WHERE x.id = $3 AND x.created_by = $2 AND x.origin_type = 'manual'`,
      [t.party_id, tx.userId, titleId]);
    if (conflictRow) throw forbidden('Segregação de funções: quem cadastrou o fornecedor, a conta bancária dele ou o título não aprova o pagamento', { rule: 'RN-ACE-01' });
  }
  await auditAction(tx, { action: 'financeiro.titulo.aprovado', table: 'finance.titles', recordId: titleId });
  return tx.one(`UPDATE finance.titles SET approved_at = now(), approved_by = $2 WHERE id = $1 RETURNING *`, [titleId, tx.userId]);
}

/**
 * Desfaz títulos de um documento (cancelamento/denegação de nota): título sem baixa é
 * cancelado; valor já recebido vira crédito (adiantamento) da pessoa.
 */
export async function cancelTitlesOfOrigin(tx: Tx, originType: string, originId: string, reason: string) {
  const titles = await tx.query<TitleRow>(`SELECT * FROM finance.titles WHERE origin_type = $1 AND origin_id = $2 AND status NOT IN ('cancelled') FOR UPDATE`, [originType, originId]);
  for (const t of titles) {
    const paid = D(t.paid_principal);
    if (paid.greaterThan(0)) {
      await createTitles(tx, { kind: t.kind === 'receivable' ? 'payable' : 'receivable', partyId: t.party_id, originType: 'advance', originId: t.id,
        documentNumber: `CRED-${t.document_number}`, issueDate: new Date().toISOString().slice(0, 10), installments: [{ dueDate: new Date().toISOString().slice(0, 10), amount: paid.toFixed(2) }],
        notes: `Crédito gerado pelo cancelamento: ${reason}` });
    }
    await tx.exec(`UPDATE finance.titles SET status = 'cancelled', notes = coalesce(notes || ' | ', '') || $2 WHERE id = $1`, [t.id, `Cancelado: ${reason}`]);
  }
  return titles.length;
}

/** Transferência entre contas (dois movimentos ligados) com lançamento contábil. */
export async function transferBetweenAccounts(tx: Tx, input: { fromAccountId: string; toAccountId: string; amount: string; date: string; description: string }) {
  if (input.fromAccountId === input.toAccountId) throw validation({ toAccountId: 'Contas iguais' });
  const id = (await tx.one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id;
  const companyId = (await tx.one<{ company_id: string }>(`SELECT company_id FROM finance.accounts WHERE id = $1`, [input.fromAccountId], 'Conta')).company_id;
  for (const [acc, dir] of [[input.fromAccountId, 'D'], [input.toAccountId, 'C']] as const) {
    await tx.exec(`INSERT INTO finance.account_movements (tenant_id, company_id, account_id, movement_date, direction, amount, description, transfer_id, source, created_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'transfer',$9)`, [tx.tenantId, companyId, acc, input.date, dir, input.amount, input.description, id, tx.userId]);
  }
  const led = async (a: string) => (await tx.one<{ ledger_account_id: string | null }>(`SELECT ledger_account_id FROM finance.accounts WHERE id = $1`, [a])).ledger_account_id;
  await postEvent(tx, { type: 'transferencia_contas', companyId, date: input.date, description: input.description, number: id.slice(0, 8), originType: 'transfer', originId: id,
    amounts: { amount: input.amount }, ledgers: { from_ledger: await led(input.fromAccountId), to_ledger: await led(input.toAccountId) } });
  return { transferId: id };
}

export async function getTitle(tx: Tx, id: string) {
  const t = await tx.maybeOne(`SELECT t.*, p.legal_name AS party_name FROM finance.titles t JOIN registry.parties p ON p.id = t.party_id WHERE t.id = $1`, [id]);
  if (!t) throw notFound('Título');
  const settlements = await tx.query(`SELECT * FROM finance.settlements WHERE title_id = $1 ORDER BY created_at`, [id]);
  const charges = await tx.query(`SELECT * FROM finance.charges WHERE title_id = $1 ORDER BY created_at`, [id]);
  const today = new Date().toISOString().slice(0, 10);
  const due = ['open', 'partially_paid'].includes(t.status) ? computeCharges(t as TitleRow, today) : null;
  return { ...t, overdue: due ? due.daysLate > 0 : false, chargesToday: due ? { fine: due.fine.toFixed(2), interest: due.interest.toFixed(2), daysLate: due.daysLate } : null, settlements, charges };
}

export { AppError };

/**
 * RN-REF-06: previsão do split payment. Com a opção ligada na empresa, cada título a receber da nota
 * guarda a parcela de IBS/CBS que o meio de pagamento vai reter, rateada pelo valor das parcelas.
 */
export async function provisionSplitPayment(tx: Tx, companyId: string, titleIds: string[], taxTotal: string) {
  if (!titleIds.length || D(taxTotal).lessThanOrEqualTo(0)) return;
  const company = await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [companyId]);
  if (!company.settings?.finance?.splitPayment) return;
  const titles = await tx.query<{ id: string; amount: string }>(`SELECT id, amount FROM finance.titles WHERE id = ANY($1) AND kind = 'receivable' AND gross_amount IS NULL ORDER BY installment`, [titleIds]);
  const parts = allocate(taxTotal, titles.map((t) => t.amount));
  for (const [i, t] of titles.entries()) await tx.exec(`UPDATE finance.titles SET split_tax_amount = $2 WHERE id = $1`, [t.id, parts[i]!.toFixed(2)]);
}
