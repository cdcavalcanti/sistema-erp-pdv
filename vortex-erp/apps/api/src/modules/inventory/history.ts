import type { Tx } from '../../db/tx.js';

/**
 * Histórico de entradas e saídas de todo o estoque (não só de um produto, como o kardex), com a
 * origem legível: nota de venda, venda do PDV, recebimento de compra, devolução, ajuste...
 */
export const MOVEMENT_LABEL: Record<string, string> = {
  opening: 'Saldo inicial', purchase_in: 'Compra', sale_out: 'Venda', sale_return_in: 'Devolução de cliente', purchase_return_out: 'Devolução a fornecedor',
  transfer_out: 'Transferência (saída)', transfer_in: 'Transferência (entrada)', production_consume: 'Consumo na produção', production_output: 'Produção',
  inventory_adjust_in: 'Ajuste de inventário (+)', inventory_adjust_out: 'Ajuste de inventário (−)', loss: 'Perda', damage: 'Avaria', internal_use: 'Uso interno',
  shipment_out: 'Remessa', shipment_return_in: 'Retorno de remessa', third_party_in: 'Entrada de terceiros', third_party_return_out: 'Retorno a terceiros',
  reversal_in: 'Estorno (+)', reversal_out: 'Estorno (−)',
};

export async function listMovements(tx: Tx, f: {
  companyId: string | null; from: string | null; to: string | null; direction: 'in' | 'out' | null; type: string | null; productId: string | null; q: string | null;
  limit: number; cursor: { at: string; id: string } | null;
}) {
  return tx.query<Record<string, any> & { created_at: string; id: string }>(
    `SELECT m.id, m.occurred_at AS created_at, m.occurred_at, m.movement_type, m.sign, m.quantity, m.unit_cost, m.total_cost, m.reason, m.source_type,
            p.id AS product_id, p.sku, p.description, p.stock_unit, w.name AS warehouse,
            d.model AS doc_model, d.number AS doc_number, d.source_type AS doc_source, coalesce(d.recipient_name, sup.legal_name) AS party_name
       FROM inventory.stock_movements m JOIN catalog.products p ON p.id = m.product_id JOIN core.warehouses w ON w.id = m.warehouse_id
       LEFT JOIN fiscal.documents d ON m.source_type = 'fiscal_document' AND d.id = m.source_id
       LEFT JOIN registry.parties sup ON sup.id = d.party_id
      WHERE ($1::uuid IS NULL OR m.company_id = $1) AND ($2::date IS NULL OR m.occurred_at >= $2::date) AND ($3::date IS NULL OR m.occurred_at < $3::date + 1)
        AND ($4::int IS NULL OR m.sign = $4) AND ($5::text IS NULL OR m.movement_type = $5) AND ($6::uuid IS NULL OR m.product_id = $6)
        AND ($7::text IS NULL OR p.sku ILIKE '%' || $7 || '%' OR p.description ILIKE '%' || $7 || '%')
        AND ($8::timestamptz IS NULL OR (m.occurred_at, m.id) < ($8, $9::uuid))
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT $10`,
    [f.companyId, f.from, f.to, f.direction === 'in' ? 1 : f.direction === 'out' ? -1 : null, f.type, f.productId, f.q, f.cursor?.at ?? null, f.cursor?.id ?? null, f.limit + 1]);
}

/** Totais de entradas e saídas por tipo no período (quadro acima do histórico). */
export async function movementTotals(tx: Tx, f: { companyId: string | null; from: string | null; to: string | null }) {
  return tx.query<{ movement_type: string; sign: number; movements: number; quantity: string; total_cost: string }>(
    `SELECT movement_type, sign, count(*)::int AS movements, sum(quantity) AS quantity, sum(total_cost) AS total_cost FROM inventory.stock_movements
      WHERE ($1::uuid IS NULL OR company_id = $1) AND ($2::date IS NULL OR occurred_at >= $2::date) AND ($3::date IS NULL OR occurred_at < $3::date + 1)
      GROUP BY movement_type, sign ORDER BY sign DESC, total_cost DESC`, [f.companyId, f.from, f.to]);
}
