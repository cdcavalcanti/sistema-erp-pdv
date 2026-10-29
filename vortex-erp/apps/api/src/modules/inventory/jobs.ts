import { registerSystemJob, registerTenantJob } from '../../worker/registry.js';
import { fanOut } from '../../worker/runner.js';
import { releaseReservations, runCostRecalc } from './stock.js';
import { emit } from '../../core/outbox.js';

// RN-EST-04: recálculo de custo em fila
registerTenantJob('estoque.recalcular_custo', async (tx, payload: { recalculationId: string }) => runCostRecalc(tx, payload.recalculationId));

// Reserva expira se o pedido ficar parado além do prazo configurado (seção 10)
registerTenantJob('estoque.expirar_reservas', async (tx) => {
  const due = await tx.query<{ id: string }>(`SELECT id FROM inventory.reservations WHERE status = 'active' AND expires_at < now()`);
  for (const r of due) await releaseReservations(tx, { reservationId: r.id }, 'expired');
  // Lotes vencidos ficam bloqueados para venda (RN-EST-05) e avisos de lotes vencendo
  await tx.exec(`UPDATE inventory.lots SET status = 'expired' WHERE status = 'available' AND expires_at < current_date`);
  const expiring = await tx.query<{ id: string; product_id: string; expires_at: string }>(
    `SELECT l.id, l.product_id, l.expires_at FROM inventory.lots l WHERE l.status = 'available' AND l.expires_at = current_date + 30
       AND EXISTS (SELECT 1 FROM inventory.stock_balances b WHERE b.lot_id = l.id AND b.quantity > 0)`);
  for (const l of expiring) await emit(tx, 'estoque.lote_vencendo', { type: 'lot', id: l.id }, { lotId: l.id, productId: l.product_id, expiresAt: l.expires_at });
  return { expired: due.length, expiringLots: expiring.length };
});
registerSystemJob('estoque.expirar_reservas', async (deps) => ({ tenants: await fanOut(deps, 'estoque.expirar_reservas', {}, `res:${new Date().toISOString().slice(0, 13)}`) }));
