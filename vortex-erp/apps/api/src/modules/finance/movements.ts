import type { Tx } from '../../db/tx.js';
import { postEvent } from '../accounting/posting.js';

export interface AccountMovementInput {
  accountId: string;
  date: string;
  /** C = entrada de dinheiro; D = saída */
  direction: 'C' | 'D';
  amount: string;
  description: string;
  categoryId?: string | null;
  costCenterId?: string | null;
  partyId?: string | null;
  source: string;
}

/**
 * Movimento de conta avulso (tarifa, rendimento, diferença de caixa) com o lançamento
 * contábil contra a conta da categoria — o saldo da conta e o razão andam juntos.
 */
export async function createAccountMovement(tx: Tx, m: AccountMovementInput) {
  const acc = await tx.one<{ company_id: string; ledger_account_id: string | null }>(`SELECT company_id, ledger_account_id FROM finance.accounts WHERE id = $1`, [m.accountId], 'Conta');
  const row = await tx.one<{ id: string }>(
    `INSERT INTO finance.account_movements (tenant_id, company_id, account_id, movement_date, direction, amount, description, category_id, cost_center_id, party_id, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [tx.tenantId, acc.company_id, m.accountId, m.date, m.direction, m.amount, m.description, m.categoryId ?? null, m.costCenterId ?? null, m.partyId ?? null, m.source, tx.userId]);
  const cat = m.categoryId ? await tx.maybeOne<{ ledger_account_id: string | null }>(`SELECT ledger_account_id FROM finance.categories WHERE id = $1`, [m.categoryId]) : null;
  await postEvent(tx, {
    type: 'movimento_conta', companyId: acc.company_id, date: m.date, description: m.description, number: m.description, originType: 'account_movement', originId: row.id,
    costCenterId: m.costCenterId ?? null, partyId: m.partyId ?? null, amounts: { amount: m.amount },
    ledgers: m.direction === 'D' ? { debit_ledger: cat?.ledger_account_id, credit_ledger: acc.ledger_account_id } : { debit_ledger: acc.ledger_account_id, credit_ledger: cat?.ledger_account_id },
  });
  return row;
}
