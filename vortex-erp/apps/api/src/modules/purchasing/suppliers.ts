import type { Tx } from '../../db/tx.js';

/**
 * Fornecedores de reposição: o que compramos de cada um (12 meses), quando foi a última compra,
 * quantos produtos ele fornece, pedidos de compra em aberto e quanto devemos a ele.
 */
export async function supplierOverview(tx: Tx, companyId: string | null, q: string | null) {
  return tx.query(
    `SELECT p.id, p.legal_name, p.trade_name, p.tax_id, p.status,
            (SELECT a.city_name || '/' || a.uf FROM registry.party_addresses a WHERE a.party_id = p.id ORDER BY (a.kind = 'fiscal') DESC LIMIT 1) AS city,
            coalesce(r.receipts, 0) AS receipts, coalesce(r.total, 0) AS total_12m, r.last_purchase,
            coalesce(r.products, 0) AS products,
            (SELECT count(*) FROM purchasing.orders po WHERE po.supplier_id = p.id AND po.status IN ('approved', 'partially_received')
                AND ($1::uuid IS NULL OR po.company_id = $1))::int AS open_orders,
            (SELECT coalesce(sum(t.balance), 0) FROM finance.titles t WHERE t.party_id = p.id AND t.kind = 'payable' AND t.status IN ('open', 'partially_paid')
                AND ($1::uuid IS NULL OR t.company_id = $1)) AS payable_open
       FROM registry.parties p JOIN registry.party_roles pr ON pr.party_id = p.id AND pr.role = 'supplier'
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT rc.id)::int AS receipts, sum(rc.total_invoice) FILTER (WHERE rc.issue_date >= current_date - 365) AS total, max(rc.issue_date) AS last_purchase,
                (SELECT count(DISTINCT ri.product_id) FROM purchasing.receipt_items ri JOIN purchasing.receipts r2 ON r2.id = ri.receipt_id
                  WHERE r2.supplier_id = p.id AND r2.status = 'completed' AND ri.product_id IS NOT NULL)::int AS products
           FROM purchasing.receipts rc WHERE rc.supplier_id = p.id AND rc.status = 'completed' AND ($1::uuid IS NULL OR rc.company_id = $1)) r ON true
      WHERE ($2::text IS NULL OR p.legal_name ILIKE '%' || $2 || '%' OR p.trade_name ILIKE '%' || $2 || '%' OR p.tax_id = regexp_replace($2, '\\D', '', 'g'))
      ORDER BY coalesce(r.total, 0) DESC, p.legal_name LIMIT 300`, [companyId, q]);
}

/** O que um fornecedor nos vende: produtos, último custo e data da última compra. */
export async function supplierProducts(tx: Tx, supplierId: string) {
  return tx.query(
    `SELECT DISTINCT ON (ri.product_id) ri.product_id, p.sku, p.description, ri.supplier_unit_price AS last_unit_price, ri.supplier_unit AS unit, r.issue_date AS last_purchase,
            (SELECT sum(ri2.supplier_quantity) FROM purchasing.receipt_items ri2 JOIN purchasing.receipts r3 ON r3.id = ri2.receipt_id
              WHERE r3.supplier_id = $1 AND r3.status = 'completed' AND ri2.product_id = ri.product_id) AS quantity_bought
       FROM purchasing.receipt_items ri JOIN purchasing.receipts r ON r.id = ri.receipt_id JOIN catalog.products p ON p.id = ri.product_id
      WHERE r.supplier_id = $1 AND r.status = 'completed' ORDER BY ri.product_id, r.issue_date DESC`, [supplierId]);
}
