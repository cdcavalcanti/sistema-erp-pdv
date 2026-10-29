-- =====================================================================
-- 0018 — Produção e ficha técnica (seção 17)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS production;
GRANT USAGE ON SCHEMA production TO vortex_app, vortex_worker;

-- Ficha técnica (BOM) com rendimento, fator de perda e versões com vigência
CREATE TABLE production.boms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  version int NOT NULL,
  valid_from date NOT NULL,
  valid_to date,
  -- Quantidade do produto acabado que a receita rende (ex.: 10 porções)
  yield_quantity numeric(18,4) NOT NULL DEFAULT 1 CHECK (yield_quantity > 0),
  -- Modo simples (food service): a venda baixa os insumos, sem ordem de produção
  simple_mode boolean NOT NULL DEFAULT false,
  labor_cost_per_unit numeric(20,10) NOT NULL DEFAULT 0,
  overhead_percent numeric(9,4) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (product_id, version),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ON production.boms (tenant_id, product_id, valid_from);
SELECT core.enable_tenant_rls('production.boms');
SELECT core.enable_audit('production.boms');

CREATE TABLE production.bom_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  bom_id uuid NOT NULL REFERENCES production.boms(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES catalog.products(id),
  -- Quantidade líquida para o rendimento da ficha
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  -- Perda no processo (ex.: 10% no corte): consumo bruto = líquido × (1 + perda)
  loss_percent numeric(9,4) NOT NULL DEFAULT 0 CHECK (loss_percent >= 0),
  notes text,
  UNIQUE (bom_id, component_id)
);
SELECT core.enable_tenant_rls('production.bom_items');

-- Ordem de produção: reserva de insumos, apontamentos, perdas, lote do acabado e encerramento
CREATE TABLE production.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  number bigint NOT NULL,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  bom_id uuid NOT NULL REFERENCES production.boms(id),
  quantity_planned numeric(18,4) NOT NULL CHECK (quantity_planned > 0),
  quantity_produced numeric(18,4) NOT NULL DEFAULT 0,
  quantity_lost numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'in_progress', 'closed', 'cancelled')),
  planned_date date,
  lot_number text,
  lot_id uuid REFERENCES inventory.lots(id),
  standard_unit_cost numeric(20,10),
  real_unit_cost numeric(20,10),
  materials_cost numeric(18,2),
  labor_cost numeric(18,2),
  overhead_cost numeric(18,2),
  started_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('production.orders');
SELECT core.enable_audit('production.orders');

CREATE TABLE production.order_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  order_id uuid NOT NULL REFERENCES production.orders(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES catalog.products(id),
  planned_quantity numeric(18,4) NOT NULL,
  consumed_quantity numeric(18,4) NOT NULL DEFAULT 0,
  consumed_cost numeric(18,2) NOT NULL DEFAULT 0,
  standard_unit_cost numeric(20,10),
  UNIQUE (order_id, component_id)
);
SELECT core.enable_tenant_rls('production.order_materials');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA production TO vortex_app;
GRANT SELECT ON ALL TABLES IN SCHEMA production TO vortex_worker;
