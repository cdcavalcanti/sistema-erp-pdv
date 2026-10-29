-- =====================================================================
-- 0027 — Vendas do PDV visíveis no ERP: itens cancelados no caixa e operador
-- =====================================================================
ALTER TABLE integration.pdv_sales ADD COLUMN cancelled_items jsonb NOT NULL DEFAULT '[]';
ALTER TABLE integration.pdv_sales ADD COLUMN operator_name text;
CREATE INDEX pdv_sales_occurred_idx ON integration.pdv_sales (tenant_id, establishment_id, occurred_at DESC);
