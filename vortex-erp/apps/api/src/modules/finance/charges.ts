import { D, sum } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, forbidden, notFound, validation } from '../../errors.js';
import type { Services } from '../../services.js';
import { newTxid } from './bank-gateway.js';
import { approvePayable, settleTitle } from './titles.js';
import { createAccountMovement } from './movements.js';
import { auditAction } from '../../core/audit.js';

/** Registra cobrança no banco: boleto (híbrido com Pix) ou Pix cob/cobv com txid único por título. */
export async function registerCharge(tx: Tx, services: Services, titleId: string, kind: 'boleto' | 'pix_cob' | 'pix_cobv', accountId?: string | null) {
  const t = await tx.one<Record<string, any>>(`SELECT t.*, p.legal_name, p.tax_id FROM finance.titles t JOIN registry.parties p ON p.id = t.party_id WHERE t.id = $1 FOR UPDATE`, [titleId], 'Título');
  if (t.kind !== 'receivable' || !['open', 'partially_paid'].includes(t.status)) throw conflict('INVALID_STATUS', 'Cobrança só para título a receber em aberto');
  const active = await tx.maybeOne(`SELECT id FROM finance.charges WHERE title_id = $1 AND status IN ('pending','registered')`, [titleId]);
  if (active) throw conflict('CHARGE_EXISTS', 'Título já tem cobrança ativa');
  const account = await tx.one<Record<string, any>>(`SELECT * FROM finance.accounts WHERE id = $1`, [accountId ?? t.account_id], 'Conta de cobrança');
  if (account.kind !== 'bank') throw validation({ accountId: 'Cobrança registrada exige conta bancária' });
  const est = t.establishment_id ? await tx.maybeOne<{ trade_name: string | null; legal_name: string; city_name: string }>(`SELECT trade_name, legal_name, city_name FROM core.establishments WHERE id = $1`, [t.establishment_id]) : null;
  const amount = D(t.balance).toFixed(2);
  let row: Record<string, any>;
  if (kind === 'boleto') {
    const our = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'our_number') AS n`, [t.company_id])).n;
    const r = await services.bankGateway.registerBoleto({
      bankCode: account.bank_code ?? '001', agreement: account.account_number ?? '0', ourNumber: our, amount, dueDate: t.due_date, payer: { name: t.legal_name, taxId: t.tax_id ?? '' },
      finePercent: t.fine_percent, interestMonthPercent: t.interest_month_percent, hybrid: Boolean(account.pix_key), pixKey: account.pix_key,
    });
    row = await tx.one(
      `INSERT INTO finance.charges (tenant_id, title_id, account_id, kind, amount, due_date, our_number, digitable_line, barcode, qr_code, gateway, gateway_id, created_by)
       VALUES ($1,$2,$3,'boleto',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tx.tenantId, titleId, account.id, amount, t.due_date, r.ourNumber, r.digitableLine, r.barcode, r.pixQrCode, services.bankGateway.name, r.gatewayId, tx.userId]);
    await tx.exec(`UPDATE finance.titles SET our_number = $2, digitable_line = $3, barcode = $4, pix_qr_code = $5, account_id = $6, bank_status = 'registered' WHERE id = $1`,
      [titleId, r.ourNumber, r.digitableLine, r.barcode, r.pixQrCode, account.id]);
  } else {
    if (!account.pix_key) throw validation({ accountId: 'Conta sem chave Pix cadastrada' });
    const txid = newTxid();
    const r = await services.bankGateway.createPix({ txid, amount, pixKey: account.pix_key, merchantName: est?.trade_name ?? est?.legal_name ?? 'VORTEX', merchantCity: est?.city_name ?? 'BRASIL',
      dueDate: kind === 'pix_cobv' ? t.due_date : null, payer: { name: t.legal_name, taxId: t.tax_id ?? '' } });
    row = await tx.one(
      `INSERT INTO finance.charges (tenant_id, title_id, account_id, kind, amount, due_date, txid, qr_code, gateway, gateway_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [tx.tenantId, titleId, account.id, kind, amount, t.due_date, r.txid, r.qrCode, services.bankGateway.name, r.gatewayId, tx.userId]);
    await tx.exec(`UPDATE finance.titles SET pix_txid = $2, pix_qr_code = $3, account_id = $4, bank_status = 'registered' WHERE id = $1`, [titleId, r.txid, r.qrCode, account.id]);
  }
  return row;
}

export interface BankNotification {
  kind: 'pix' | 'boleto';
  txid?: string;
  ourNumber?: string;
  amount: string;
  paidAt: string;
  fee?: string;
  endToEndId?: string;
}

/** Webhook do banco: liquidação de Pix (txid) ou boleto (nosso número) → baixa automática em segundos. */
export async function processBankNotification(tx: Tx, accountId: string, n: BankNotification) {
  const charge = n.kind === 'pix'
    ? await tx.maybeOne<Record<string, any>>(`SELECT * FROM finance.charges WHERE txid = $1 AND account_id = $2 FOR UPDATE`, [n.txid, accountId])
    : await tx.maybeOne<Record<string, any>>(`SELECT * FROM finance.charges WHERE our_number = $1 AND account_id = $2 FOR UPDATE`, [n.ourNumber, accountId]);
  if (!charge) throw notFound('Cobrança');
  if (charge.status === 'paid') return { duplicate: true };
  const paid = D(n.amount);
  const date = n.paidAt.slice(0, 10);
  const t = await tx.one<Record<string, any>>(`SELECT * FROM finance.titles WHERE id = $1`, [charge.title_id]);
  // Valor pago acima do saldo = juros/multa recebidos
  const extra = paid.minus(t.balance);
  const st = await settleTitle(tx, charge.title_id, {
    date, accountId, amount: paid.toFixed(2), method: n.kind, reference: n.endToEndId ?? n.txid ?? n.ourNumber, idempotencyKey: `bank:${charge.id}`,
    ...(extra.greaterThan(0) ? { interest: extra.toFixed(2), fine: '0' } : { interest: '0', fine: '0' }),
  });
  await tx.exec(`UPDATE finance.charges SET status = 'paid', paid_at = $2, paid_amount = $3, fee_amount = $4 WHERE id = $1`, [charge.id, n.paidAt, paid.toFixed(2), n.fee ?? null]);
  await tx.exec(`UPDATE finance.titles SET bank_status = 'paid' WHERE id = $1`, [charge.title_id]);
  if (n.fee && D(n.fee).greaterThan(0)) {
    // Tarifa bancária vai para despesa financeira
    const cat = await tx.maybeOne<{ id: string }>(`SELECT id FROM finance.categories WHERE code = '7.2'`);
    await createAccountMovement(tx, { accountId, date, direction: 'D', amount: D(n.fee).toFixed(2), description: `Tarifa de cobrança ${charge.kind}`, categoryId: cat?.id ?? null, source: 'bank_fee' });
  }
  return { settlementId: st.id };
}

// ------------------------------------------------------------------ borderô de pagamento (RN-FIN-07)

export async function createPaymentBatch(tx: Tx, input: { accountId: string; paymentDate: string; titleIds: string[] }) {
  const titles = await tx.query<Record<string, any>>(`SELECT * FROM finance.titles WHERE id = ANY($1) FOR UPDATE`, [input.titleIds]);
  if (titles.length !== input.titleIds.length) throw notFound('Título');
  for (const t of titles) {
    if (t.kind !== 'payable' || !['open', 'partially_paid'].includes(t.status)) throw validation({ titleIds: `Título ${t.document_number} não é um título a pagar em aberto` });
    if (!t.approved_at) throw validation({ titleIds: `Título ${t.document_number} ainda não foi aprovado` });
  }
  const account = await tx.one<{ company_id: string }>(`SELECT company_id FROM finance.accounts WHERE id = $1`, [input.accountId], 'Conta');
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'payment_batch') AS n`, [account.company_id])).n;
  const batch = await tx.one(
    `INSERT INTO finance.payment_batches (tenant_id, company_id, account_id, number, payment_date, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tx.tenantId, account.company_id, input.accountId, number, input.paymentDate, sum(titles.map((t) => t.balance)).toFixed(2), tx.userId]);
  for (const t of titles) {
    // Só contas bancárias aprovadas (RN-ACE-02) recebem pagamento
    const bank = await tx.maybeOne<{ id: string; pix_key: string | null }>(`SELECT id, pix_key FROM registry.party_bank_accounts WHERE party_id = $1 AND status = 'active' ORDER BY approved_at DESC LIMIT 1`, [t.party_id]);
    const method = t.barcode ? 'boleto' : bank?.pix_key ? 'pix' : bank ? 'ted' : null;
    if (!method) throw validation({ titleIds: `Fornecedor do título ${t.document_number} sem conta bancária aprovada nem boleto` });
    await tx.exec(`INSERT INTO finance.payment_batch_items (tenant_id, batch_id, title_id, amount, method, bank_account_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tx.tenantId, batch.id, t.id, t.balance, method, bank?.id ?? null]);
  }
  return batch;
}

export async function approvePaymentBatch(tx: Tx, batchId: string) {
  const b = await tx.one<Record<string, any>>(`SELECT * FROM finance.payment_batches WHERE id = $1 FOR UPDATE`, [batchId], 'Borderô');
  if (b.status !== 'draft') throw conflict('INVALID_STATUS', 'Borderô já aprovado ou enviado');
  if (b.created_by === tx.userId && !tx.ctx.permissions.has('*')) throw forbidden('Quem montou o borderô não o aprova (segregação de funções)', { rule: 'RN-ACE-01' });
  const items = await tx.query<{ title_id: string }>(`SELECT title_id FROM finance.payment_batch_items WHERE batch_id = $1`, [batchId]);
  for (const i of items) await approvePayable(tx, i.title_id);
  await auditAction(tx, { action: 'financeiro.bordero.aprovado', table: 'finance.payment_batches', recordId: batchId });
  return tx.one(`UPDATE finance.payment_batches SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 RETURNING *`, [batchId, tx.userId]);
}

/** Envia ao banco (API ou arquivo de remessa). Os títulos só são baixados após a confirmação. */
export async function sendPaymentBatch(tx: Tx, services: Services, batchId: string) {
  const b = await tx.one<Record<string, any>>(`SELECT * FROM finance.payment_batches WHERE id = $1 FOR UPDATE`, [batchId], 'Borderô');
  if (b.status !== 'approved') throw conflict('INVALID_STATUS', 'Borderô precisa estar aprovado');
  const items = await tx.query<Record<string, any>>(
    `SELECT i.*, t.barcode, p.legal_name, p.tax_id, ba.bank_code, ba.branch, ba.account_number, ba.pix_key
       FROM finance.payment_batch_items i JOIN finance.titles t ON t.id = i.title_id JOIN registry.parties p ON p.id = t.party_id
       LEFT JOIN registry.party_bank_accounts ba ON ba.id = i.bank_account_id WHERE i.batch_id = $1`, [batchId]);
  for (const i of items) {
    const r = await services.bankGateway.sendPayment({ method: i.method, amount: i.amount, barcode: i.barcode, reference: i.id,
      beneficiary: { name: i.legal_name, taxId: i.tax_id, bankCode: i.bank_code, branch: i.branch, account: i.account_number, pixKey: i.pix_key } });
    await tx.exec(`UPDATE finance.payment_batch_items SET status = $2, bank_reference = $3, failure_reason = $4 WHERE id = $1`, [i.id, r.status === 'failed' ? 'failed' : 'sent', r.bankReference, r.failureReason ?? null]);
  }
  const lines = items.map((i) => `${i.method.toUpperCase()};${i.tax_id};${i.legal_name};${D(i.amount).toFixed(2)};${i.barcode ?? i.pix_key ?? `${i.bank_code}/${i.branch}/${i.account_number}`}`);
  const file = await services.storage.putImmutable(`remessas/${tx.tenantId}/bordero-${b.number}.csv`, `metodo;documento;favorecido;valor;destino\n${lines.join('\n')}`, 'text/csv');
  return tx.one(`UPDATE finance.payment_batches SET status = 'sent', sent_at = now(), file_key = $2 WHERE id = $1 RETURNING *`, [batchId, file.key]);
}

/** Retorno do banco (webhook/arquivo de retorno): baixa os títulos confirmados. */
export async function confirmPaymentBatchItem(tx: Tx, itemId: string, ok: boolean, reason?: string) {
  const i = await tx.one<Record<string, any>>(`SELECT i.*, b.account_id, b.payment_date FROM finance.payment_batch_items i JOIN finance.payment_batches b ON b.id = i.batch_id WHERE i.id = $1 FOR UPDATE`, [itemId], 'Item do borderô');
  if (i.status !== 'sent') throw conflict('INVALID_STATUS', 'Item não está aguardando retorno');
  if (ok) {
    await settleTitle(tx, i.title_id, { date: i.payment_date, accountId: i.account_id, amount: i.amount, method: i.method, reference: i.bank_reference, batchId: i.batch_id, idempotencyKey: `batch-item:${i.id}`, waiveCharges: true });
  }
  await tx.exec(`UPDATE finance.payment_batch_items SET status = $2, failure_reason = $3 WHERE id = $1`, [itemId, ok ? 'confirmed' : 'failed', reason ?? null]);
  const st = await tx.one<{ pending: number; failed: number }>(`SELECT count(*) FILTER (WHERE status IN ('pending','sent'))::int AS pending, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM finance.payment_batch_items WHERE batch_id = $1`, [i.batch_id]);
  if (st.pending === 0) await tx.exec(`UPDATE finance.payment_batches SET status = $2 WHERE id = $1`, [i.batch_id, st.failed ? 'partially_confirmed' : 'confirmed']);
  return { confirmed: ok };
}

export { AppError };
