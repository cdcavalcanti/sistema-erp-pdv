-- =====================================================================
-- 0007 — Operações de estoque: baixas manuais com aprovação (RN-EST-06)
-- e ajustes de custo do recálculo retroativo (RN-EST-04)
-- =====================================================================

-- Baixa por perda, avaria ou consumo interno: motivo obrigatório; acima do limite, aprovação.
CREATE TABLE inventory.manual_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  lot_id uuid REFERENCES inventory.lots(id),
  movement_type text NOT NULL CHECK (movement_type IN ('loss', 'damage', 'internal_use', 'inventory_adjust_in', 'inventory_adjust_out', 'opening')),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(20,10),
  estimated_value numeric(18,2) NOT NULL DEFAULT 0,
  reason_code text NOT NULL,
  reason text NOT NULL CHECK (length(reason) >= 5),
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'posted', 'rejected')),
  movement_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('inventory.manual_movements');
SELECT core.enable_audit('inventory.manual_movements');

-- Ajuste de custo das saídas após recálculo retroativo (o movimento original é imutável)
CREATE TABLE inventory.cost_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  recalculation_id uuid NOT NULL REFERENCES inventory.cost_recalculations(id),
  movement_id uuid NOT NULL,
  movement_occurred_at timestamptz NOT NULL,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  old_unit_cost numeric(20,10) NOT NULL,
  new_unit_cost numeric(20,10) NOT NULL,
  difference numeric(18,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON inventory.cost_adjustments (tenant_id, movement_id);
SELECT core.enable_tenant_rls('inventory.cost_adjustments');

GRANT SELECT, INSERT, UPDATE ON inventory.manual_movements, inventory.cost_adjustments TO vortex_app;
