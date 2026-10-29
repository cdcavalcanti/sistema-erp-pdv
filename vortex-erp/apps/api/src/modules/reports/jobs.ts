import { registerSystemJob, registerTenantJob } from '../../worker/registry.js';
import { fanOut } from '../../worker/runner.js';
import { emit } from '../../core/outbox.js';
import { executeRun, fireDueSchedules } from './service.js';

// RN-REL-02: relatórios pesados na fila "reports" (não disputam com as telas)
registerTenantJob('relatorios.executar', async (tx, p: { runId: string }, deps) => executeRun(deps.appPool, tx, deps.services, p.runId));
registerSystemJob('relatorios.agendados', async (deps) => ({ fired: await fireDueSchedules(deps.appPool, deps.workerPool) }));

/**
 * Ciclo do título (seção 23): titulo.vencendo (N dias antes) e titulo.vencido (uma vez),
 * que alimentam a régua de cobrança e os agentes de WhatsApp.
 */
registerTenantJob('financeiro.vencimentos', async (tx) => {
  const days = Number((await tx.maybeOne<{ d: string | null }>(`SELECT max((settings->'finance'->>'dueNoticeDays')) AS d FROM core.companies`))?.d ?? 3);
  const due = await tx.query<{ id: string; kind: string; party_id: string; due_date: string; balance: string; company_id: string }>(
    `UPDATE finance.titles SET due_notified_at = now()
      WHERE status IN ('open','partially_paid') AND due_notified_at IS NULL AND due_date BETWEEN current_date AND current_date + $1::int
      RETURNING id, kind, party_id, due_date, balance, company_id`, [days]);
  for (const t of due) await emit(tx, 'titulo.vencendo', { type: 'title', id: t.id }, { id: t.id, tipo: t.kind, pessoa: t.party_id, vencimento: t.due_date, saldo: t.balance });
  const overdue = await tx.query<{ id: string; kind: string; party_id: string; due_date: string; balance: string }>(
    `UPDATE finance.titles SET overdue_notified_at = now()
      WHERE status IN ('open','partially_paid') AND overdue_notified_at IS NULL AND due_date < current_date
      RETURNING id, kind, party_id, due_date, balance`);
  for (const t of overdue) await emit(tx, 'titulo.vencido', { type: 'title', id: t.id }, { id: t.id, tipo: t.kind, pessoa: t.party_id, vencimento: t.due_date, saldo: t.balance });
  return { dueSoon: due.length, overdue: overdue.length };
});
registerSystemJob('financeiro.vencimentos', async (deps) => ({ tenants: await fanOut(deps, 'financeiro.vencimentos', {}, `venc:${new Date().toISOString().slice(0, 10)}`) }));

// estoque.lote_vencendo: lotes com saldo a N dias da validade (padrão 30)
registerTenantJob('estoque.lotes_vencendo', async (tx) => {
  const days = Number((await tx.maybeOne<{ d: string | null }>(`SELECT max((settings->'inventory'->>'expiryNoticeDays')) AS d FROM core.companies`))?.d ?? 30);
  const lots = await tx.query<{ id: string; product_id: string; lot_number: string; expires_at: string; quantity: string }>(
    `UPDATE inventory.lots l SET expiry_notified_at = now()
       FROM (SELECT lot_id, sum(quantity) AS quantity FROM inventory.stock_balances WHERE lot_id IS NOT NULL GROUP BY lot_id HAVING sum(quantity) > 0) b
      WHERE b.lot_id = l.id AND l.expiry_notified_at IS NULL AND l.expires_at <= current_date + $1::int
      RETURNING l.id, l.product_id, l.lot_number, l.expires_at, b.quantity`, [days]);
  for (const l of lots) {
    await emit(tx, 'estoque.lote_vencendo', { type: 'lot', id: l.id }, { id: l.id, produto: l.product_id, lote: l.lot_number, validade: l.expires_at, saldo: l.quantity });
  }
  return { lots: lots.length };
});
registerSystemJob('estoque.lotes_vencendo', async (deps) => ({ tenants: await fanOut(deps, 'estoque.lotes_vencendo', {}, `lotes:${new Date().toISOString().slice(0, 10)}`) }));
