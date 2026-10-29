import { D, ZERO } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import type { Services } from '../../services.js';
import { newTxid } from './bank-gateway.js';
import { computeCharges, settleTitle } from './titles.js';
import { createAccountMovement } from './movements.js';

// ------------------------------------------------------------------ régua de cobrança (RN-FIN-09)

export interface CollectionStep {
  offsetDays: number;
  channels: ('email' | 'whatsapp')[];
}

export const DEFAULT_STEPS: CollectionStep[] = [
  { offsetDays: -3, channels: ['email'] },
  { offsetDays: 0, channels: ['email', 'whatsapp'] },
  { offsetDays: 3, channels: ['email', 'whatsapp'] },
  { offsetDays: 10, channels: ['whatsapp'] },
];

export async function defaultCollectionRule(tx: Tx, companyId: string) {
  const ex = await tx.maybeOne<{ id: string; steps: CollectionStep[] }>(`SELECT id, steps FROM finance.collection_rules WHERE company_id = $1 AND is_default AND active`, [companyId]);
  if (ex) return ex;
  return tx.one<{ id: string; steps: CollectionStep[] }>(
    `INSERT INTO finance.collection_rules (tenant_id, company_id, name, steps, is_default, created_by) VALUES ($1,$2,'Régua padrão',$3,true,$4) RETURNING id, steps`,
    [tx.tenantId, companyId, JSON.stringify(DEFAULT_STEPS), tx.userId]);
}

export async function setCollectionRule(tx: Tx, companyId: string, steps: CollectionStep[]) {
  const offsets = steps.map((s) => s.offsetDays);
  if (new Set(offsets).size !== offsets.length) throw validation({ steps: 'Cada dia da régua aparece uma vez' });
  const rule = await defaultCollectionRule(tx, companyId);
  return tx.one(`UPDATE finance.collection_rules SET steps = $2 WHERE id = $1 RETURNING *`, [rule.id, JSON.stringify([...steps].sort((a, b) => a.offsetDays - b.offsetDays))]);
}

const brl = (v: string) => `R$ ${D(v).toFixed(2).replace('.', ',')}`;
const br = (d: string) => d.split('-').reverse().join('/');

/**
 * Executa a régua do dia: lembrete antes do vencimento, no dia e após o atraso, por
 * e-mail e WhatsApp, com 2ª via (linha digitável) e Pix atualizado com os encargos.
 * Cada passo é enviado uma única vez por título e canal; passos perdidos (job parado)
 * são recuperados em até 2 dias.
 */
export async function runCollection(tx: Tx, services: Services, today = new Date().toISOString().slice(0, 10)) {
  // Empresa sem régua cadastrada usa a padrão (D−3, D0, D+3, D+10)
  for (const c of await tx.query<{ id: string }>(`SELECT id FROM core.companies c WHERE NOT EXISTS (SELECT 1 FROM finance.collection_rules r WHERE r.company_id = c.id)`)) {
    await defaultCollectionRule(tx, c.id);
  }
  const rules = await tx.query<{ id: string; company_id: string; steps: CollectionStep[] }>(`SELECT id, company_id, steps FROM finance.collection_rules WHERE active`);
  const summary = { sent: 0, skipped: 0, failed: 0 };
  for (const rule of rules) {
    for (const step of rule.steps) {
      const titles = await tx.query<Record<string, any>>(
        `SELECT t.*, p.legal_name, p.xml_email FROM finance.titles t JOIN registry.parties p ON p.id = t.party_id
          WHERE t.company_id = $1 AND t.kind = 'receivable' AND t.status IN ('open','partially_paid') AND t.gross_amount IS NULL AND t.origin_type NOT IN ('advance','pdv')
            AND t.due_date + $2::int BETWEEN $3::date - 2 AND $3::date AND ($2::int >= 0 OR t.due_date >= $3::date)`, [rule.company_id, step.offsetDays, today]);
      for (const t of titles) {
        const contacts = await tx.query<{ email: string | null; whatsapp: string | null; consents: Record<string, boolean> }>(
          `SELECT email, whatsapp, consents FROM registry.party_contacts WHERE party_id = $1`, [t.party_id]);
        const charges = computeCharges(t as never, today);
        const updated = D(t.balance).plus(charges.fine).plus(charges.interest);
        let pix: string | null = t.pix_qr_code;
        // Atraso com encargos: Pix novo com o valor atualizado (o anterior é cancelado)
        if (step.offsetDays > 0 && updated.greaterThan(t.balance) && t.account_id) {
          const acc = await tx.maybeOne<{ pix_key: string | null }>(`SELECT pix_key FROM finance.accounts WHERE id = $1`, [t.account_id]);
          if (acc?.pix_key) {
            const r = await services.bankGateway.createPix({ txid: newTxid(), amount: updated.toFixed(2), pixKey: acc.pix_key, merchantName: 'VORTEX', merchantCity: 'BRASIL', dueDate: null,
              payer: { name: t.legal_name, taxId: '' } });
            await tx.exec(`UPDATE finance.charges SET status = 'cancelled' WHERE title_id = $1 AND kind IN ('pix_cob','pix_cobv') AND status IN ('pending','registered')`, [t.id]);
            await tx.exec(`INSERT INTO finance.charges (tenant_id, title_id, account_id, kind, amount, due_date, txid, qr_code, gateway, gateway_id) VALUES ($1,$2,$3,'pix_cob',$4,$5,$6,$7,$8,$9)`,
              [tx.tenantId, t.id, t.account_id, updated.toFixed(2), today, r.txid, r.qrCode, services.bankGateway.name, r.gatewayId]);
            await tx.exec(`UPDATE finance.titles SET pix_txid = $2, pix_qr_code = $3 WHERE id = $1`, [t.id, r.txid, r.qrCode]);
            pix = r.qrCode;
          }
        }
        const when = step.offsetDays < 0 ? `vence em ${br(t.due_date)}` : step.offsetDays === 0 ? 'vence hoje' : `venceu em ${br(t.due_date)}`;
        const text = `Olá, ${t.legal_name}. O título ${t.document_number}/${t.installment} ${when}. Valor ${step.offsetDays > 0 ? 'atualizado ' : ''}${brl(updated.toFixed(2))}.`
          + `${t.digitable_line ? ` Linha digitável: ${t.digitable_line}.` : ''}${pix ? ` Pix copia e cola: ${pix}` : ''}`;
        for (const channel of step.channels) {
          const done = await tx.maybeOne(`SELECT 1 FROM finance.collection_actions WHERE title_id = $1 AND offset_days = $2 AND channel = $3`, [t.id, step.offsetDays, channel]);
          if (done) continue;
          let status: 'sent' | 'skipped' | 'failed' = 'skipped';
          let to: string | null = null;
          try {
            if (channel === 'email') {
              to = t.xml_email ?? contacts.find((c) => c.email)?.email ?? null;
              if (to) {
                await services.mailer.send({ to, subject: `Cobrança: título ${t.document_number}/${t.installment} ${when}`, html: `<p>${text}</p>` });
                status = 'sent';
              }
            } else {
              // LGPD: WhatsApp de cobrança só com consentimento registrado
              const c = contacts.find((x) => x.whatsapp && x.consents?.cobranca_whatsapp);
              to = c?.whatsapp ?? null;
              if (to) {
                await services.messenger.sendWhatsApp(to, text);
                status = 'sent';
              }
            }
          } catch {
            status = 'failed';
          }
          summary[status]++;
          await tx.exec(`INSERT INTO finance.collection_actions (tenant_id, title_id, rule_id, offset_days, channel, status, payload) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [tx.tenantId, t.id, rule.id, step.offsetDays, channel, status, JSON.stringify({ to, amount: updated.toFixed(2), text })]);
        }
      }
    }
  }
  return summary;
}

// ------------------------------------------------------------------ extrato da adquirente (RN-FIN-08)

export interface AcquirerLine {
  kind: 'sale' | 'chargeback' | 'anticipation' | 'adjustment';
  saleDate?: string | null;
  paymentDate: string;
  nsu?: string | null;
  authorization?: string | null;
  gross: string;
  fee: string;
  net: string;
}

/**
 * Importa o que a adquirente pagou: casa com o título do cartão (bruto + data da venda),
 * baixa pelo líquido efetivo e alerta quando o pago diverge do previsto (taxa ou prazo).
 */
export async function importAcquirerStatement(tx: Tx, accountId: string, lines: AcquirerLine[]) {
  const acc = await tx.one<{ kind: string }>(`SELECT kind FROM finance.accounts WHERE id = $1`, [accountId], 'Conta');
  const out = { settled: 0, divergent: 0, unmatched: 0, duplicates: 0 };
  const feeCat = await tx.maybeOne<{ id: string }>(`SELECT id FROM finance.categories WHERE code = '7.2'`);
  for (const l of lines) {
    const ex = await tx.maybeOne(`SELECT 1 FROM finance.acquirer_settlements WHERE account_id = $1 AND nsu IS NOT DISTINCT FROM $2 AND payment_date = $3 AND kind = $4`,
      [accountId, l.nsu ?? null, l.paymentDate, l.kind]);
    if (ex) {
      out.duplicates++;
      continue;
    }
    let titleId: string | null = null;
    let expected: string | null = null;
    let status: 'settled' | 'divergent' | 'unmatched' = 'unmatched';
    if (l.kind === 'sale') {
      const t = await tx.maybeOne<{ id: string; balance: string }>(
        `SELECT id, balance FROM finance.titles WHERE kind = 'receivable' AND gross_amount IS NOT NULL AND status IN ('open','partially_paid')
            AND (gross_amount = $1 OR balance = $2) AND ($3::date IS NULL OR abs(issue_date - $3::date) <= 1)
          ORDER BY (coalesce(notes, '') LIKE '%' || coalesce($4, '#') || '%') DESC, abs(due_date - $5::date), due_date LIMIT 1 FOR UPDATE`,
        [l.gross, l.net, l.saleDate ?? null, l.nsu ?? null, l.paymentDate]);
      if (t) {
        titleId = t.id;
        expected = D(t.balance).toFixed(2);
        const diff = D(l.net).minus(t.balance);
        // Pago a menor = taxa maior que a cadastrada (despesa); a maior = ajuste a favor
        await settleTitle(tx, t.id, { date: l.paymentDate, accountId, amount: l.net, method: 'acquirer', reference: l.nsu ?? undefined,
          ...(diff.isNegative() ? { discount: diff.negated().toFixed(2), interest: '0', fine: '0' } : diff.isPositive() ? { interest: diff.toFixed(2), fine: '0' } : { interest: '0', fine: '0' }),
          waiveCharges: true, idempotencyKey: `acq:${accountId}:${l.nsu ?? t.id}:${l.paymentDate}` });
        status = diff.abs().greaterThan('0.01') ? 'divergent' : 'settled';
      }
    } else if (l.kind === 'anticipation' || l.kind === 'adjustment') {
      // Custo de antecipação ou ajuste: despesa financeira na conta da adquirente
      if (D(l.fee).greaterThan(0)) {
        await createAccountMovement(tx, { accountId, date: l.paymentDate, direction: 'D', amount: D(l.fee).toFixed(2), description: `Adquirente: ${l.kind === 'anticipation' ? 'antecipação' : 'ajuste'} ${l.nsu ?? ''}`.trim(),
          categoryId: feeCat?.id ?? null, source: 'acquirer' });
      }
      status = 'settled';
    }
    const divergence = expected ? D(l.net).minus(expected).toFixed(2) : null;
    await tx.exec(
      `INSERT INTO finance.acquirer_settlements (tenant_id, account_id, title_id, kind, sale_date, payment_date, nsu, authorization_code, gross, fee, net, expected_net, divergence, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [tx.tenantId, accountId, titleId, l.kind, l.saleDate ?? null, l.paymentDate, l.nsu ?? null, l.authorization ?? null, l.gross, l.fee, l.net, expected, divergence, status]);
    if (status === 'divergent' || l.kind === 'chargeback' || status === 'unmatched') {
      await emit(tx, 'cartao.divergencia', { type: 'title', id: titleId }, { titulo: titleId, tipo: l.kind, nsu: l.nsu, previsto: expected, pago: l.net, diferenca: divergence,
        alerta: l.kind === 'chargeback' ? 'Chargeback informado pela adquirente' : status === 'unmatched' ? 'Pagamento da adquirente sem venda correspondente' : 'Valor pago diferente do previsto' });
    }
    out[status]++;
  }
  return { ...out, account: acc.kind };
}

// ------------------------------------------------------------------ orçado × realizado

/** Alerta (uma vez por mês e linha do orçamento) quando o realizado passa do orçado. */
export async function budgetAlerts(tx: Tx, today = new Date().toISOString().slice(0, 10)) {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const rows = await tx.query<{ id: string; company_id: string; category_id: string; cost_center_id: string | null; amount: string; name: string; realized: string | null }>(
    `SELECT b.id, b.company_id, b.category_id, b.cost_center_id, b.amount, c.name,
            coalesce((SELECT sum(t.amount) FROM finance.titles t WHERE t.company_id = b.company_id AND t.kind = 'payable' AND t.status <> 'cancelled' AND t.category_id = b.category_id
               AND (b.cost_center_id IS NULL OR t.cost_center_id = b.cost_center_id) AND date_trunc('month', t.competence_date) = make_date($1, $2, 1)), 0)
            + coalesce((SELECT sum(mv.amount) FROM finance.account_movements mv WHERE mv.company_id = b.company_id AND mv.direction = 'D' AND mv.settlement_id IS NULL AND mv.transfer_id IS NULL
               AND mv.category_id = b.category_id AND (b.cost_center_id IS NULL OR mv.cost_center_id = b.cost_center_id) AND date_trunc('month', mv.movement_date) = make_date($1, $2, 1)), 0) AS realized
       FROM finance.budgets b JOIN finance.categories c ON c.id = b.category_id WHERE b.year = $1 AND b.month = $2 AND b.alerted_at IS NULL`, [y, m]);
  let alerts = 0;
  for (const r of rows) {
    const realized = D(r.realized ?? 0);
    if (realized.lessThanOrEqualTo(r.amount)) continue;
    await tx.exec(`UPDATE finance.budgets SET alerted_at = now() WHERE id = $1`, [r.id]);
    await emit(tx, 'orcamento.excedido', { type: 'budget', id: r.id }, { categoria: r.name, orcado: r.amount, realizado: realized.toFixed(2), excesso: realized.minus(r.amount).toFixed(2), mes: `${y}-${String(m).padStart(2, '0')}` });
    alerts++;
  }
  return { alerts };
}

export { ZERO };
