import { D, ZERO, sum, type Decimal } from '@vortex/money';
import { cleanDoc } from '@vortex/validators';
import type { Tx } from '../../db/tx.js';
import { conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { requireReason } from '../../core/audit.js';
import { settleTitle } from './titles.js';
import { createAccountMovement } from './movements.js';

// ------------------------------------------------------------------ OFX

export interface OfxTransaction {
  fitid: string;
  date: string;
  amount: string;
  type: string;
  name: string;
  memo: string;
  checknum: string | null;
}

const ofxDate = (v: string | null) => (v && /^\d{8}/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
function field(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1]!.trim() : null;
}

/** Lê extrato OFX 1.x (SGML) ou 2.x (XML). */
export function parseOfx(text: string) {
  const body = text.slice(Math.max(0, text.indexOf('<OFX>')));
  if (!/<OFX>/i.test(body)) throw validation({ content: 'Arquivo não é um extrato OFX' });
  const txs: OfxTransaction[] = [];
  const re = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const b = m[1]!;
    const amount = (field(b, 'TRNAMT') ?? '0').replace(',', '.');
    const date = ofxDate(field(b, 'DTPOSTED'));
    if (!date || !/^-?\d+(\.\d+)?$/.test(amount) || D(amount).isZero()) continue;
    txs.push({ fitid: field(b, 'FITID') ?? `${date}:${amount}:${txs.length}`, date, amount: D(amount).toFixed(2), type: field(b, 'TRNTYPE') ?? '', name: field(b, 'NAME') ?? '',
      memo: field(b, 'MEMO') ?? '', checknum: field(b, 'CHECKNUM') });
  }
  const ledger = /<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|$)/i.exec(body)?.[1] ?? '';
  return {
    bankId: field(body, 'BANKID'), accountId: field(body, 'ACCTID'), start: ofxDate(field(body, 'DTSTART')), end: ofxDate(field(body, 'DTEND')),
    balance: field(ledger, 'BALAMT')?.replace(',', '.') ?? null, balanceDate: ofxDate(field(ledger, 'DTASOF')), transactions: txs,
  };
}

const TXID_RE = /txid[:\s]*([A-Za-z0-9]{25,35})/i;
const OUR_NUMBER_RE = /nosso\s*n[uú]mero[:\s]*(\d{4,20})/i;
const TAX_ID_RE = /\b(\d{3}\.?\d{3}\.?\d{3}-?\d{2}|\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})\b/;

export async function importStatement(tx: Tx, accountId: string, input: { content: string; fileName?: string | null }) {
  const acc = await tx.one<{ kind: string }>(`SELECT kind FROM finance.accounts WHERE id = $1`, [accountId], 'Conta');
  if (!['bank', 'acquirer'].includes(acc.kind)) throw validation({ accountId: 'Extrato só para conta bancária' });
  const ofx = parseOfx(input.content);
  const st = await tx.one<{ id: string }>(
    `INSERT INTO finance.bank_statements (tenant_id, account_id, source, file_name, period_start, period_end, closing_balance, imported_by) VALUES ($1,$2,'ofx',$3,$4,$5,$6,$7) RETURNING id`,
    [tx.tenantId, accountId, input.fileName ?? null, ofx.start, ofx.end ?? ofx.balanceDate, ofx.balance, tx.userId]);
  let imported = 0;
  for (const t of ofx.transactions) {
    const text = `${t.name} ${t.memo}`;
    const taxId = TAX_ID_RE.exec(text)?.[1];
    const r = await tx.maybeOne(
      `INSERT INTO finance.statement_lines (tenant_id, statement_id, account_id, line_date, amount, description, fitid, pix_txid, our_number, counterpart_name, counterpart_tax_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (account_id, fitid) DO NOTHING RETURNING id`,
      [tx.tenantId, st.id, accountId, t.date, t.amount, text.trim() || t.type, t.fitid, TXID_RE.exec(text)?.[1] ?? null, OUR_NUMBER_RE.exec(text)?.[1] ?? null, t.name || null,
        taxId ? cleanDoc(taxId) : null]);
    if (r) imported++;
  }
  const auto = await autoReconcile(tx, accountId);
  return { statementId: st.id, transactions: ofx.transactions.length, imported, duplicates: ofx.transactions.length - imported, ...auto };
}

// ------------------------------------------------------------------ conciliação automática

interface Line { id: string; account_id: string; line_date: string; amount: string; description: string; pix_txid: string | null; our_number: string | null;
  counterpart_name: string | null; counterpart_tax_id: string | null }

const tokensOf = (s: string) => [...new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z0-9]+/)
  .filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !['PIX', 'TED', 'DOC', 'TRANSF', 'TRANSFERENCIA', 'RECEBIDO', 'ENVIADO', 'PAGAMENTO', 'BOLETO', 'LTDA', 'EIRELI', 'CRED', 'DEB'].includes(w)))];

/**
 * Regras automáticas (seção 13): txid do Pix, nosso número do boleto, valor + data +
 * documento, e regras salvas pelo usuário (ex.: "tarifa bancária" sempre na categoria X).
 */
export async function autoReconcile(tx: Tx, accountId: string) {
  const lines = await tx.query<Line>(`SELECT * FROM finance.statement_lines WHERE account_id = $1 AND status = 'pending' ORDER BY line_date, amount`, [accountId]);
  const rules = await tx.query<{ id: string; description_pattern: string; direction: string | null; category_id: string; cost_center_id: string | null }>(
    `SELECT * FROM finance.reconciliation_rules WHERE account_id IS NULL OR account_id = $1 ORDER BY length(description_pattern) DESC`, [accountId]);
  const counts = { byTxid: 0, byOurNumber: 0, byValue: 0, byRule: 0 };
  for (const l of lines) {
    const amount = D(l.amount);
    const dir = amount.isPositive() ? 'C' : 'D';
    // 1) Pix pelo txid / boleto pelo nosso número: a baixa (webhook) já gerou o movimento — ou é feita agora
    const charge = l.pix_txid ? await tx.maybeOne<{ id: string; title_id: string; status: string }>(`SELECT id, title_id, status FROM finance.charges WHERE txid = $1 AND account_id = $2`, [l.pix_txid, accountId])
      : l.our_number ? await tx.maybeOne<{ id: string; title_id: string; status: string }>(`SELECT id, title_id, status FROM finance.charges WHERE our_number = $1 AND account_id = $2`, [l.our_number, accountId]) : null;
    if (charge && dir === 'C') {
      let mv = await tx.maybeOne<{ id: string }>(
        `SELECT m.id FROM finance.settlements s JOIN finance.account_movements m ON m.id = s.account_movement_id
          WHERE s.title_id = $1 AND NOT s.reversed AND s.kind = 'payment' AND NOT m.reconciled AND m.amount = $2 ORDER BY s.created_at DESC LIMIT 1`, [charge.title_id, amount.abs().toFixed(2)]);
      if (!mv && charge.status !== 'paid') {
        const st = await settleTitle(tx, charge.title_id, { date: l.line_date, accountId, amount: amount.toFixed(2), method: l.pix_txid ? 'pix' : 'boleto', reference: l.pix_txid ?? l.our_number ?? undefined,
          idempotencyKey: `stmt:${l.id}` });
        await tx.exec(`UPDATE finance.charges SET status = 'paid', paid_at = $2, paid_amount = $3 WHERE id = $1`, [charge.id, l.line_date, amount.toFixed(2)]);
        mv = st.account_movement_id ? { id: st.account_movement_id } : null;
      }
      if (mv) {
        await link(tx, accountId, [l.id], [mv.id], l.pix_txid ? 'txid' : 'our_number');
        l.pix_txid ? counts.byTxid++ : counts.byOurNumber++;
        continue;
      }
    }
    // 2) Valor + data (±3 dias) + documento da contraparte, quando houver um único candidato
    const cands = await tx.query<{ id: string; tax_id: string | null }>(
      `SELECT m.id, p.tax_id FROM finance.account_movements m LEFT JOIN registry.parties p ON p.id = m.party_id
        WHERE m.account_id = $1 AND NOT m.reconciled AND m.direction = $2 AND m.amount = $3 AND abs(m.movement_date - $4::date) <= 3
          AND NOT EXISTS (SELECT 1 FROM finance.reconciliation_items i JOIN finance.reconciliations r ON r.id = i.reconciliation_id WHERE i.account_movement_id = m.id AND r.undone_at IS NULL)`,
      [accountId, dir, amount.abs().toFixed(2), l.line_date]);
    const byDoc = l.counterpart_tax_id ? cands.filter((c) => c.tax_id === l.counterpart_tax_id) : [];
    const pick = byDoc.length === 1 ? byDoc[0] : cands.length === 1 ? cands[0] : null;
    if (pick) {
      await link(tx, accountId, [l.id], [pick.id], 'rule');
      counts.byValue++;
      continue;
    }
    // 3) Regras salvas: cria o movimento (tarifa, rendimento...) na categoria da regra
    const rule = rules.find((r) => (!r.direction || r.direction === dir) && l.description.toUpperCase().includes(r.description_pattern.toUpperCase()));
    if (rule) {
      const mv = await createAccountMovement(tx, { accountId, date: l.line_date, direction: dir, amount: amount.abs().toFixed(2), description: l.description, categoryId: rule.category_id,
        costCenterId: rule.cost_center_id, source: 'reconciliation_rule' });
      await link(tx, accountId, [l.id], [mv.id], 'rule');
      await tx.exec(`UPDATE finance.reconciliation_rules SET hits = hits + 1 WHERE id = $1`, [rule.id]);
      counts.byRule++;
    }
  }
  return { autoReconciled: counts.byTxid + counts.byOurNumber + counts.byValue + counts.byRule, ...counts };
}

async function link(tx: Tx, accountId: string, lineIds: string[], movementIds: string[], method: string) {
  const rec = await tx.one<{ id: string }>(`INSERT INTO finance.reconciliations (tenant_id, account_id, method, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [tx.tenantId, accountId, method, tx.userId]);
  for (const id of lineIds) {
    await tx.exec(`INSERT INTO finance.reconciliation_items (tenant_id, reconciliation_id, statement_line_id) VALUES ($1,$2,$3)`, [tx.tenantId, rec.id, id]);
    await tx.exec(`UPDATE finance.statement_lines SET status = 'reconciled', reconciliation_id = $2 WHERE id = $1`, [id, rec.id]);
  }
  for (const id of movementIds) {
    await tx.exec(`INSERT INTO finance.reconciliation_items (tenant_id, reconciliation_id, account_movement_id) VALUES ($1,$2,$3)`, [tx.tenantId, rec.id, id]);
    await tx.exec(`UPDATE finance.account_movements SET reconciled = true WHERE id = $1`, [id]);
  }
  return rec.id;
}

// ------------------------------------------------------------------ sugestões (conciliação inteligente)

export interface Suggestion {
  kind: 'movement' | 'titles' | 'category';
  score: number;
  reason: string;
  movementIds?: string[];
  titles?: { titleId: string; documentNumber: string; party: string; balance: string; dueDate: string }[];
  categoryId?: string;
}

/** Sugestões ordenadas por probabilidade; aprende com as escolhas anteriores (memória por palavra do extrato). */
export async function suggestionsFor(tx: Tx, lineId: string): Promise<Suggestion[]> {
  const l = await tx.one<Line & { status: string }>(`SELECT * FROM finance.statement_lines WHERE id = $1`, [lineId], 'Linha do extrato');
  const amount = D(l.amount);
  const dir = amount.isPositive() ? 'C' : 'D';
  const abs = amount.abs();
  const words = tokensOf(`${l.description} ${l.counterpart_name ?? ''}`);
  const memory = await tx.query<{ party_id: string | null; category_id: string | null; hits: number }>(
    `SELECT party_id, category_id, sum(hits)::int AS hits FROM finance.reconciliation_memory WHERE account_id = $1 AND token = ANY($2) GROUP BY 1, 2`, [l.account_id, words]);
  const memParty = new Map(memory.filter((m) => m.party_id).map((m) => [m.party_id!, m.hits]));
  const out: Suggestion[] = [];
  const nameScore = (name: string | null) => {
    if (!name) return 0;
    const n = tokensOf(name);
    return n.length ? n.filter((w) => words.includes(w)).length / n.length : 0;
  };
  // Movimentos do sistema ainda não conciliados
  const movs = await tx.query<{ id: string; movement_date: string; description: string; party_name: string | null; tax_id: string | null }>(
    `SELECT m.id, m.movement_date, m.description, p.legal_name AS party_name, p.tax_id FROM finance.account_movements m LEFT JOIN registry.parties p ON p.id = m.party_id
      WHERE m.account_id = $1 AND NOT m.reconciled AND m.direction = $2 AND m.amount = $3 AND abs(m.movement_date - $4::date) <= 10`, [l.account_id, dir, abs.toFixed(2), l.line_date]);
  for (const m of movs) {
    const days = Math.abs((new Date(m.movement_date).getTime() - new Date(l.line_date).getTime()) / 86_400_000);
    const score = 0.6 + 0.25 * (1 - days / 10) + (l.counterpart_tax_id && l.counterpart_tax_id === m.tax_id ? 0.15 : 0.1 * nameScore(m.party_name));
    out.push({ kind: 'movement', score, reason: `Mesmo valor${days ? `, ${days} dia(s) de diferença` : ', mesma data'}`, movementIds: [m.id] });
  }
  // Títulos em aberto: um título com o valor exato ou vários da mesma pessoa somando o valor (um para muitos)
  const titles = await tx.query<{ id: string; document_number: string; balance: string; due_date: string; party_id: string; party_name: string; tax_id: string | null; split_open: string }>(
    `SELECT t.id, t.document_number, t.balance, t.due_date, t.party_id, p.legal_name AS party_name, p.tax_id,
            t.split_tax_amount - coalesce((SELECT sum(split_tax) FROM finance.settlements s WHERE s.title_id = t.id AND NOT s.reversed), 0) AS split_open
       FROM finance.titles t JOIN registry.parties p ON p.id = t.party_id
      WHERE t.kind = $1 AND t.status IN ('open','partially_paid') AND t.gross_amount IS NULL AND t.origin_type <> 'advance'
        AND (t.kind = 'receivable' OR t.approved_at IS NOT NULL) ORDER BY t.due_date LIMIT 500`, [dir === 'C' ? 'receivable' : 'payable']);
  const partyBonus = (t: { party_id: string; party_name: string; tax_id: string | null }) =>
    (l.counterpart_tax_id && l.counterpart_tax_id === t.tax_id ? 0.35 : 0) + Math.min(0.25, 0.08 * (memParty.get(t.party_id) ?? 0)) + 0.2 * nameScore(t.party_name);
  const view = (t: (typeof titles)[number]) => ({ titleId: t.id, documentNumber: t.document_number, party: t.party_name, balance: D(t.balance).toFixed(2), dueDate: t.due_date });
  for (const t of titles.filter((x) => D(x.balance).equals(abs))) {
    const days = Math.abs((new Date(t.due_date).getTime() - new Date(l.line_date).getTime()) / 86_400_000);
    out.push({ kind: 'titles', score: 0.45 + partyBonus(t) + (days <= 5 ? 0.1 : 0), reason: 'Título com o mesmo valor', titles: [view(t)] });
  }
  // RN-REF-06: recebimento líquido do split payment (valor do título menos o IBS/CBS retido na fonte)
  for (const t of titles.filter((x) => D(x.split_open).greaterThan(0) && D(x.balance).minus(x.split_open).equals(abs))) {
    out.push({ kind: 'titles', score: 0.5 + partyBonus(t), reason: `Recebimento líquido do split payment (IBS/CBS de ${D(t.split_open).toFixed(2)} retidos na fonte)`, titles: [view(t)] });
  }
  const byParty = new Map<string, typeof titles>();
  for (const t of titles) byParty.set(t.party_id, [...(byParty.get(t.party_id) ?? []), t]);
  for (const group of byParty.values()) {
    if (group.length < 2) continue;
    const bonus = partyBonus(group[0]!);
    if (bonus <= 0) continue;
    const combo = subsetSum(group.slice(0, 14).map((t) => D(t.balance)), abs, 5);
    if (combo && combo.length > 1) out.push({ kind: 'titles', score: 0.5 + bonus, reason: `${combo.length} títulos de ${group[0]!.party_name} somam o valor`, titles: combo.map((i) => view(group[i]!)) });
  }
  // Categoria aprendida (ex.: tarifa, aluguel recorrente)
  const cat = memory.filter((m) => m.category_id && !m.party_id).sort((a, b) => b.hits - a.hits)[0];
  if (cat) out.push({ kind: 'category', score: Math.min(0.85, 0.4 + 0.1 * cat.hits), reason: `Lançado nesta categoria ${cat.hits} vez(es) antes`, categoryId: cat.category_id! });
  return out.sort((a, b) => b.score - a.score).slice(0, 5).map((s) => ({ ...s, score: Math.round(Math.min(s.score, 0.99) * 100) / 100 }));
}

/** Combinação de até "max" valores que soma exatamente o alvo (índices). */
function subsetSum(values: Decimal[], target: Decimal, max: number): number[] | null {
  const cents = values.map((v) => Math.round(v.toNumber() * 100));
  const goal = Math.round(target.toNumber() * 100);
  const walk = (start: number, left: number, picked: number[]): number[] | null => {
    if (left === 0 && picked.length) return picked;
    if (left < 0 || picked.length >= max) return null;
    for (let i = start; i < cents.length; i++) {
      const r = walk(i + 1, left - cents[i]!, [...picked, i]);
      if (r) return r;
    }
    return null;
  };
  return walk(0, goal, []);
}

// ------------------------------------------------------------------ conciliação manual

export interface ReconcileInput {
  lineIds: string[];
  movementIds?: string[];
  titles?: { titleId: string; amount?: string }[];
  newMovement?: { categoryId: string; description?: string; costCenterId?: string | null } | null;
}

/**
 * Tela lado a lado: uma ou mais linhas do extrato contra movimentos existentes, baixa de
 * títulos (um depósito pagando vários) ou um movimento novo na categoria escolhida.
 */
export async function reconcile(tx: Tx, input: ReconcileInput) {
  const lines = await tx.query<Line & { status: string }>(`SELECT * FROM finance.statement_lines WHERE id = ANY($1) FOR UPDATE`, [input.lineIds]);
  if (lines.length !== input.lineIds.length) throw notFound('Linha do extrato');
  if (lines.some((l) => l.status !== 'pending')) throw conflict('LINE_NOT_PENDING', 'Linha já conciliada ou ignorada');
  const accountId = lines[0]!.account_id;
  if (lines.some((l) => l.account_id !== accountId)) throw validation({ lineIds: 'Linhas de contas diferentes' });
  const linesTotal = sum(lines.map((l) => l.amount));
  const date = lines.map((l) => l.line_date).sort().at(-1)!;
  const movementIds = [...(input.movementIds ?? [])];
  const parties = new Set<string>();
  for (const t of input.titles ?? []) {
    const title = await tx.one<{ balance: string; party_id: string; kind: string; split_open: string }>(
      `SELECT balance, party_id, kind, split_tax_amount - coalesce((SELECT sum(split_tax) FROM finance.settlements s WHERE s.title_id = finance.titles.id AND NOT s.reversed), 0) AS split_open
         FROM finance.titles WHERE id = $1`, [t.titleId], 'Título');
    if ((title.kind === 'receivable') !== linesTotal.isPositive()) throw validation({ titles: 'Título a receber concilia com entrada; a pagar, com saída' });
    // Um título só, recebido pelo líquido do split: o tributo retido completa a baixa
    const netOfSplit = D(title.balance).minus(title.split_open);
    const split = !t.amount && input.titles!.length === 1 && D(title.split_open).greaterThan(0) && linesTotal.equals(netOfSplit) ? D(title.split_open) : null;
    const st = await settleTitle(tx, t.titleId, { date, accountId, amount: split ? netOfSplit.toFixed(2) : t.amount ?? title.balance, splitTax: split?.toFixed(2),
      method: 'bank_statement', reference: `extrato ${lines[0]!.id.slice(0, 8)}` });
    if (st.account_movement_id) movementIds.push(st.account_movement_id);
    parties.add(title.party_id);
  }
  const movs = movementIds.length ? await tx.query<{ id: string; account_id: string; direction: string; amount: string; reconciled: boolean; party_id: string | null; category_id: string | null }>(
    `SELECT id, account_id, direction, amount, reconciled, party_id, category_id FROM finance.account_movements WHERE id = ANY($1) FOR UPDATE`, [movementIds]) : [];
  if (movs.some((m) => m.account_id !== accountId)) throw validation({ movementIds: 'Movimento de outra conta' });
  if (movs.some((m) => m.reconciled)) throw conflict('ALREADY_RECONCILED', 'Movimento já conciliado');
  let systemTotal = sum(movs.map((m) => (m.direction === 'C' ? D(m.amount) : D(m.amount).negated())));
  const diff = linesTotal.minus(systemTotal);
  if (!diff.isZero() && input.newMovement) {
    const mv = await createAccountMovement(tx, { accountId, date, direction: diff.isPositive() ? 'C' : 'D', amount: diff.abs().toFixed(2),
      description: input.newMovement.description ?? lines.map((l) => l.description).join(' / ').slice(0, 200), categoryId: input.newMovement.categoryId,
      costCenterId: input.newMovement.costCenterId ?? null, source: 'reconciliation' });
    movementIds.push(mv.id);
    systemTotal = systemTotal.plus(diff);
  }
  if (!linesTotal.equals(systemTotal)) {
    throw ruleViolation('RN-FIN-CONC', `Extrato (${linesTotal.toFixed(2)}) e sistema (${systemTotal.toFixed(2)}) não batem: diferença de ${linesTotal.minus(systemTotal).toFixed(2)}`);
  }
  const recId = await link(tx, accountId, input.lineIds, movementIds, input.titles?.length ? 'suggestion' : 'manual');
  // Aprende: palavras do extrato → pessoa (títulos) ou categoria (movimento novo)
  const words = tokensOf(lines.map((l) => `${l.description} ${l.counterpart_name ?? ''}`).join(' ')).slice(0, 8);
  for (const m of movs) if (m.party_id) parties.add(m.party_id);
  for (const w of words) {
    for (const p of parties) await remember(tx, accountId, w, p, null);
    if (input.newMovement && !parties.size) await remember(tx, accountId, w, null, input.newMovement.categoryId);
  }
  return { reconciliationId: recId, lines: input.lineIds.length, movements: movementIds.length, total: linesTotal.toFixed(2) };
}

async function remember(tx: Tx, accountId: string, token: string, partyId: string | null, categoryId: string | null) {
  await tx.exec(
    `INSERT INTO finance.reconciliation_memory (tenant_id, account_id, token, party_id, category_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, account_id, token, party_id, category_id) DO UPDATE SET hits = finance.reconciliation_memory.hits + 1, updated_at = now()`,
    [tx.tenantId, accountId, token, partyId, categoryId]);
}

/** Desfaz a conciliação (exigido antes de estornar uma baixa conciliada — RN-FIN-06). */
export async function undoReconciliation(tx: Tx, reconciliationId: string, reason: string) {
  await requireReason(tx, reason, 'financeiro.conciliacao.desfazer');
  const r = await tx.one<{ undone_at: Date | null }>(`SELECT undone_at FROM finance.reconciliations WHERE id = $1 FOR UPDATE`, [reconciliationId], 'Conciliação');
  if (r.undone_at) throw conflict('ALREADY_UNDONE', 'Conciliação já desfeita');
  await tx.exec(`UPDATE finance.reconciliations SET undone_at = now(), undone_by = $2 WHERE id = $1`, [reconciliationId, tx.userId]);
  await tx.exec(`UPDATE finance.statement_lines SET status = 'pending', reconciliation_id = NULL WHERE reconciliation_id = $1`, [reconciliationId]);
  await tx.exec(`UPDATE finance.account_movements SET reconciled = false WHERE id IN (SELECT account_movement_id FROM finance.reconciliation_items WHERE reconciliation_id = $1 AND account_movement_id IS NOT NULL)`,
    [reconciliationId]);
  return { undone: true };
}

/**
 * Saldo do sistema × saldo do banco por dia. Em dia totalmente conciliado os dois
 * precisam bater; a diferença aparece em destaque.
 */
export async function dailyPosition(tx: Tx, accountId: string, from: string, to: string) {
  const acc = await tx.one<{ initial_balance: string; initial_balance_date: string }>(`SELECT initial_balance, initial_balance_date FROM finance.accounts WHERE id = $1`, [accountId], 'Conta');
  const st = await tx.maybeOne<{ closing_balance: string | null; period_end: string | null }>(
    `SELECT closing_balance, period_end FROM finance.bank_statements WHERE account_id = $1 AND closing_balance IS NOT NULL ORDER BY period_end DESC NULLS LAST, imported_at DESC LIMIT 1`, [accountId]);
  const days = await tx.query<{ day: string; system: string; bank_after: string | null; lines: number; pending: number }>(
    `SELECT d::date::text AS day,
            $3::numeric + coalesce((SELECT sum(CASE WHEN direction = 'C' THEN amount ELSE -amount END) FROM finance.account_movements
                                     WHERE account_id = $1 AND movement_date >= $4 AND movement_date <= d::date), 0) AS system,
            (SELECT sum(amount) FROM finance.statement_lines WHERE account_id = $1 AND line_date > d::date AND line_date <= $5::date) AS bank_after,
            (SELECT count(*)::int FROM finance.statement_lines WHERE account_id = $1 AND line_date = d::date) AS lines,
            (SELECT count(*)::int FROM finance.statement_lines WHERE account_id = $1 AND line_date = d::date AND status = 'pending') AS pending
       FROM generate_series($6::date, $2::date, interval '1 day') d ORDER BY 1`,
    [accountId, to, acc.initial_balance, acc.initial_balance_date, st?.period_end ?? to, from]);
  return days.map((d) => {
    const bank = st?.closing_balance != null && st.period_end && d.day <= st.period_end ? D(st.closing_balance).minus(d.bank_after ?? 0) : null;
    const reconciled = d.pending === 0;
    const difference = bank ? D(d.system).minus(bank) : null;
    return { day: d.day, system: D(d.system).toFixed(2), bank: bank?.toFixed(2) ?? null, statementLines: d.lines, pendingLines: d.pending, reconciled,
      difference: difference?.toFixed(2) ?? null, alert: reconciled && difference !== null && !difference.isZero() };
  });
}

export { ZERO };
