-- =====================================================================
-- 0005 — Estoque e custos (seção 12) + períodos contábeis (RN-CTB-04)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS inventory;
GRANT USAGE ON SCHEMA inventory TO vortex_app, vortex_worker;

-- ---------------------------------------------------------------------
-- Períodos: o contador fecha o mês; nada com data no período fechado é
-- criado, alterado ou estornado (RN-CTB-04). Vale para todos os módulos.
-- ---------------------------------------------------------------------
CREATE TABLE accounting.periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  closed_by uuid,
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, year, month)
);
SELECT core.enable_tenant_rls('accounting.periods');
SELECT core.enable_audit('accounting.periods');

CREATE OR REPLACE FUNCTION accounting.is_period_closed(p_company uuid, p_date date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM accounting.periods
                  WHERE company_id = p_company AND year = extract(year FROM p_date)::int AND month = extract(month FROM p_date)::int AND status = 'closed')
$$;

-- Trigger genérico: TG_ARGV[0] = coluna de data do fato
CREATE OR REPLACE FUNCTION accounting.block_closed_period() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_company uuid;
  v_date date;
  r jsonb;
BEGIN
  r := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  v_company := (r ->> 'company_id')::uuid;
  v_date := (r ->> TG_ARGV[0])::date;
  IF v_company IS NOT NULL AND v_date IS NOT NULL AND accounting.is_period_closed(v_company, v_date) THEN
    RAISE EXCEPTION 'RN-CTB-04: período %/% está fechado; não é possível lançar, alterar ou estornar com esta data',
      extract(month FROM v_date), extract(year FROM v_date) USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    v_date := (to_jsonb(OLD) ->> TG_ARGV[0])::date;
    IF v_date IS NOT NULL AND accounting.is_period_closed(v_company, v_date) THEN
      RAISE EXCEPTION 'RN-CTB-04: registro pertence a período fechado' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION accounting.enable_period_lock(tbl regclass, date_column text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_period_lock ON %s', tbl);
  EXECUTE format('CREATE TRIGGER trg_period_lock BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION accounting.block_closed_period(%L)', tbl, date_column);
END $$;

-- ---------------------------------------------------------------------
-- Lotes e séries
-- ---------------------------------------------------------------------
CREATE TABLE inventory.lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  lot_number text NOT NULL,
  manufactured_at date,
  expires_at date,
  supplier_id uuid REFERENCES registry.parties(id),
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'blocked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, product_id, lot_number)
);
CREATE INDEX ON inventory.lots (tenant_id, expires_at) WHERE status = 'available';
SELECT core.enable_tenant_rls('inventory.lots');

CREATE TABLE inventory.serials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  serial text NOT NULL,
  lot_id uuid REFERENCES inventory.lots(id),
  warehouse_id uuid REFERENCES core.warehouses(id),
  status text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'reserved', 'sold', 'returned', 'lost')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product_id, serial)
);
SELECT core.enable_tenant_rls('inventory.serials');

-- ---------------------------------------------------------------------
-- Livro de movimentos (kardex) — RN-GER-01: o estoque só muda por movimento.
-- Particionado por data do fato; imutável (correção = movimento de estorno).
-- ---------------------------------------------------------------------
CREATE TABLE inventory.stock_movements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL,
  establishment_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  product_id uuid NOT NULL,
  lot_id uuid,
  movement_type text NOT NULL CHECK (movement_type IN ('opening', 'purchase_in', 'sale_out', 'sale_return_in', 'purchase_return_out', 'transfer_out', 'transfer_in',
    'production_consume', 'production_output', 'inventory_adjust_in', 'inventory_adjust_out', 'loss', 'damage', 'internal_use',
    'shipment_out', 'shipment_return_in', 'third_party_in', 'third_party_return_out', 'reversal_in', 'reversal_out')),
  sign smallint NOT NULL CHECK (sign IN (-1, 1)),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(20,10) NOT NULL DEFAULT 0,
  total_cost numeric(18,2) NOT NULL DEFAULT 0,
  avg_cost_after numeric(20,10),
  occurred_at timestamptz NOT NULL,
  source_type text NOT NULL,
  source_id uuid,
  source_item_id uuid,
  reason text,
  reversal_of uuid,
  serials text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by uuid,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE TABLE inventory.stock_movements_default PARTITION OF inventory.stock_movements DEFAULT;
CREATE INDEX ON inventory.stock_movements (tenant_id, product_id, establishment_id, occurred_at);
CREATE INDEX ON inventory.stock_movements (tenant_id, source_type, source_id);
CREATE INDEX ON inventory.stock_movements USING brin (occurred_at);
SELECT core.enable_tenant_rls('inventory.stock_movements');
CREATE TRIGGER trg_movements_immutable BEFORE UPDATE OR DELETE ON inventory.stock_movements FOR EACH ROW EXECUTE FUNCTION core.forbid_change();
SELECT accounting.enable_period_lock('inventory.stock_movements', 'occurred_at');
REVOKE ALL ON inventory.stock_movements_default FROM vortex_app;

-- RN-GER-07: chave de idempotência por movimento (nunca duplica baixa)
CREATE TABLE inventory.movement_keys (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  key text NOT NULL,
  movement_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
SELECT core.enable_tenant_rls('inventory.movement_keys');

-- Saldo: soma dos movimentos, mantido na mesma transação só para leitura rápida.
CREATE TABLE inventory.stock_balances (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  lot_id uuid REFERENCES inventory.lots(id),
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  reserved numeric(18,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  blocked numeric(18,4) NOT NULL DEFAULT 0 CHECK (blocked >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (warehouse_id, product_id, lot_id)
);
CREATE INDEX ON inventory.stock_balances (tenant_id, product_id);
SELECT core.enable_tenant_rls('inventory.stock_balances');

-- Custo médio ponderado móvel por estabelecimento (RN-EST-03)
CREATE TABLE inventory.product_costs (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  avg_cost numeric(20,10) NOT NULL DEFAULT 0,
  -- RN-EST-02: produto vendido com saldo negativo fica marcado para corrigir custo
  negative_pending boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (establishment_id, product_id)
);
SELECT core.enable_tenant_rls('inventory.product_costs');

CREATE TABLE inventory.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  lot_id uuid REFERENCES inventory.lots(id),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_item_id uuid,
  expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'released', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON inventory.reservations (tenant_id, source_type, source_id) WHERE status = 'active';
CREATE INDEX ON inventory.reservations (expires_at) WHERE status = 'active';
SELECT core.enable_tenant_rls('inventory.reservations');

-- RN-EST-04: recálculo de custo a partir de uma data (job), com relatório do que mudou
CREATE TABLE inventory.cost_recalculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  from_date timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done', 'blocked', 'failed')),
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('inventory.cost_recalculations');

-- ---------------------------------------------------------------------
-- Inventário (contagem)
-- ---------------------------------------------------------------------
CREATE TABLE inventory.inventories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  number bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('general', 'sample', 'cyclic')),
  -- block: bloqueia movimentos durante a contagem; register: registra e desconta na conferência
  freeze_mode text NOT NULL DEFAULT 'register' CHECK (freeze_mode IN ('block', 'register')),
  scope jsonb NOT NULL DEFAULT '{}',
  divergence_limit_percent numeric(9,4) NOT NULL DEFAULT 2,
  status text NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'review', 'approved', 'closed', 'cancelled')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by uuid,
  closed_at timestamptz,
  reference_date date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('inventory.inventories');

CREATE TABLE inventory.inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  inventory_id uuid NOT NULL REFERENCES inventory.inventories(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  lot_id uuid REFERENCES inventory.lots(id),
  snapshot_qty numeric(18,4) NOT NULL,
  snapshot_cost numeric(20,10) NOT NULL DEFAULT 0,
  count1 numeric(18,4),
  count1_by uuid,
  count2 numeric(18,4),
  count2_by uuid,
  final_qty numeric(18,4),
  diff_qty numeric(18,4),
  diff_value numeric(18,2),
  needs_recount boolean NOT NULL DEFAULT false,
  UNIQUE NULLS NOT DISTINCT (inventory_id, product_id, lot_id)
);
SELECT core.enable_tenant_rls('inventory.inventory_items');

SELECT core.enable_audit(t) FROM unnest(ARRAY[
  'inventory.lots', 'inventory.reservations', 'inventory.inventories', 'inventory.inventory_items', 'inventory.cost_recalculations'
]::regclass[]) AS t;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA inventory TO vortex_app;
REVOKE UPDATE, DELETE ON inventory.stock_movements FROM vortex_app;
REVOKE ALL ON inventory.stock_movements_default FROM vortex_app;
GRANT SELECT, INSERT, UPDATE ON accounting.periods TO vortex_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA accounting TO vortex_app, vortex_worker;
