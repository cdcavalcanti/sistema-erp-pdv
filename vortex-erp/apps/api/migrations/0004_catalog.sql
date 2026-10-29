-- =====================================================================
-- 0004 — Produtos, unidades e preços (seção 06)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS catalog;
GRANT USAGE ON SCHEMA catalog TO vortex_app, vortex_worker;

CREATE TABLE catalog.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  parent_id uuid REFERENCES catalog.categories(id),
  min_margin_percent numeric(9,4),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('catalog.categories');

CREATE TABLE catalog.brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, name)
);
SELECT core.enable_tenant_rls('catalog.brands');

CREATE TABLE catalog.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid REFERENCES core.companies(id),
  sku text NOT NULL,
  description text NOT NULL CHECK (length(description) <= 120),
  short_description text CHECK (length(short_description) <= 40),
  gtin varchar(14),
  manufacturer_code text,
  brand_id uuid REFERENCES catalog.brands(id),
  category_id uuid REFERENCES catalog.categories(id),
  kind text NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods', 'raw_material', 'finished', 'service', 'kit', 'fixed_asset', 'consumable', 'packaging')),
  -- Grade: produto pai com variações (cada variação é um SKU com estoque e GTIN próprios)
  parent_id uuid REFERENCES catalog.products(id),
  is_variant_parent boolean NOT NULL DEFAULT false,
  variant_attributes jsonb NOT NULL DEFAULT '{}',
  -- Fiscal
  ncm char(8) CHECK (ncm ~ '^\d{8}$'),
  cest char(7) CHECK (cest ~ '^\d{7}$'),
  origin smallint NOT NULL DEFAULT 0 CHECK (origin BETWEEN 0 AND 8),
  tax_group text,
  service_code text,
  nbs text,
  cclasstrib char(6),
  own_production boolean NOT NULL DEFAULT false,
  -- Unidades: estoque, venda e tributável (NF-e uTrib quando diferente da comercial)
  stock_unit text NOT NULL DEFAULT 'UN',
  sale_unit text NOT NULL DEFAULT 'UN',
  taxable_unit text,
  taxable_factor numeric(18,6) NOT NULL DEFAULT 1 CHECK (taxable_factor > 0),
  -- Controle
  controls_stock boolean NOT NULL DEFAULT true,
  controls_lot boolean NOT NULL DEFAULT false,
  controls_expiry boolean NOT NULL DEFAULT false,
  controls_serial boolean NOT NULL DEFAULT false,
  allow_negative_stock boolean NOT NULL DEFAULT false,
  gross_weight numeric(18,4),
  net_weight numeric(18,4),
  width_cm numeric(18,4),
  height_cm numeric(18,4),
  depth_cm numeric(18,4),
  -- Kit: baixa os componentes no estoque (true) ou o próprio kit (false)
  kit_explodes_stock boolean NOT NULL DEFAULT true,
  -- Custos: somente leitura, alterados pelos movimentos (o custo médio fica por estabelecimento no estoque)
  last_purchase_cost numeric(20,10) NOT NULL DEFAULT 0,
  replacement_cost numeric(20,10) NOT NULL DEFAULT 0,
  standard_cost numeric(20,10) NOT NULL DEFAULT 0,
  -- Política comercial
  min_margin_percent numeric(9,4),
  commission_percent numeric(9,4),
  photos jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, sku),
  CHECK (kind <> 'service' OR controls_stock = false),
  CHECK (kind = 'service' OR is_variant_parent OR ncm IS NOT NULL)
);
CREATE UNIQUE INDEX products_gtin_uq ON catalog.products (tenant_id, gtin) WHERE gtin IS NOT NULL AND gtin <> 'SEM GTIN';
CREATE INDEX products_search_idx ON catalog.products USING gin (to_tsvector('simple', sku || ' ' || description || ' ' || coalesce(gtin, '')));
CREATE INDEX ON catalog.products (tenant_id, parent_id);
SELECT core.enable_tenant_rls('catalog.products');
SELECT core.enable_touch('catalog.products');

-- Conversões: caixa com 12 = 12 UN (fator para a unidade de estoque)
CREATE TABLE catalog.unit_conversions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  unit text NOT NULL,
  factor numeric(18,6) NOT NULL CHECK (factor > 0),
  purpose text NOT NULL DEFAULT 'both' CHECK (purpose IN ('purchase', 'sale', 'both')),
  gtin varchar(14),
  UNIQUE (product_id, unit)
);
SELECT core.enable_tenant_rls('catalog.unit_conversions');

-- Fornecedores do produto (de-para — RN-COM-03)
CREATE TABLE catalog.product_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  supplier_id uuid NOT NULL REFERENCES registry.parties(id),
  supplier_code text NOT NULL,
  supplier_unit text,
  -- quantidade na unidade de estoque para 1 unidade do fornecedor
  factor numeric(18,6) NOT NULL DEFAULT 1 CHECK (factor > 0),
  supplier_gtin varchar(14),
  lead_time_days int,
  min_lot numeric(18,4),
  last_price numeric(20,10),
  last_purchase_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, supplier_id, supplier_code)
);
SELECT core.enable_tenant_rls('catalog.product_suppliers');

-- Parâmetros de suprimento por depósito
CREATE TABLE catalog.stock_params (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  min_qty numeric(18,4) NOT NULL DEFAULT 0,
  max_qty numeric(18,4),
  reorder_point numeric(18,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id)
);
SELECT core.enable_tenant_rls('catalog.stock_params');

-- Kit: produto vendido como um item, composto por outros
CREATE TABLE catalog.kit_items (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  kit_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES catalog.products(id),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  -- Percentual do preço do kit atribuído ao componente na nota fiscal (soma 100)
  price_share_percent numeric(9,4) NOT NULL CHECK (price_share_percent >= 0),
  PRIMARY KEY (kit_id, component_id),
  CHECK (kit_id <> component_id)
);
SELECT core.enable_tenant_rls('catalog.kit_items');

-- ---------------------------------------------------------------------
-- Preços
-- ---------------------------------------------------------------------
CREATE TABLE catalog.price_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  valid_from date NOT NULL DEFAULT '2000-01-01',
  valid_to date,
  -- Canais: counter (balcão), pdv, ecommerce, wholesale (atacado), marketplace
  channels text[] NOT NULL DEFAULT '{}',
  establishment_ids uuid[] NOT NULL DEFAULT '{}',
  segment text,
  customer_id uuid REFERENCES registry.parties(id),
  is_default boolean NOT NULL DEFAULT false,
  -- RN-REF-05: o preço cadastrado já inclui IBS/CBS ("cheio") ou não ("líquido")
  includes_ibs_cbs boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX price_lists_one_default ON catalog.price_lists (tenant_id) WHERE is_default AND active;
SELECT core.enable_tenant_rls('catalog.price_lists');
SELECT core.enable_touch('catalog.price_lists');

ALTER TABLE registry.parties ADD CONSTRAINT parties_price_list_fk FOREIGN KEY (price_list_id) REFERENCES catalog.price_lists(id);

CREATE TABLE catalog.price_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  price_list_id uuid NOT NULL REFERENCES catalog.price_lists(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  price numeric(20,10) NOT NULL CHECK (price >= 0),
  min_qty numeric(18,4) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (price_list_id, product_id, min_qty)
);
SELECT core.enable_tenant_rls('catalog.price_list_items');
SELECT core.enable_touch('catalog.price_list_items');

-- RN-PRE-04: histórico de preço (somente inserção) e alteração agendada
CREATE TABLE catalog.price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  price_list_id uuid NOT NULL REFERENCES catalog.price_lists(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  min_qty numeric(18,4) NOT NULL DEFAULT 0,
  old_price numeric(20,10),
  new_price numeric(20,10) NOT NULL,
  reason text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  scheduled_change_id uuid
);
CREATE INDEX ON catalog.price_history (tenant_id, product_id, changed_at DESC);
SELECT core.enable_tenant_rls('catalog.price_history');
CREATE TRIGGER trg_price_history_immutable BEFORE UPDATE OR DELETE ON catalog.price_history FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

CREATE TABLE catalog.scheduled_price_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  price_list_id uuid NOT NULL REFERENCES catalog.price_lists(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  min_qty numeric(18,4) NOT NULL DEFAULT 0,
  new_price numeric(20,10) NOT NULL CHECK (new_price >= 0),
  effective_at timestamptz NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'cancelled')),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON catalog.scheduled_price_changes (effective_at) WHERE status = 'pending';
SELECT core.enable_tenant_rls('catalog.scheduled_price_changes');

-- RN-PRE-02: promoções com início, fim, limite de quantidade e regra
CREATE TABLE catalog.promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- {"type":"percent_off","percent":"10"} | {"type":"fixed_price","price":"9.90"}
  -- {"type":"buy_x_pay_y","buy":3,"pay":2} | {"type":"progressive","tiers":[{"minQty":"5","percent":"5"}]}
  rule jsonb NOT NULL,
  product_ids uuid[] NOT NULL DEFAULT '{}',
  category_ids uuid[] NOT NULL DEFAULT '{}',
  channels text[] NOT NULL DEFAULT '{}',
  establishment_ids uuid[] NOT NULL DEFAULT '{}',
  max_quantity numeric(18,4),
  used_quantity numeric(18,4) NOT NULL DEFAULT 0,
  cumulative boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CHECK (ends_at > starts_at),
  CHECK (max_quantity IS NULL OR used_quantity <= max_quantity)
);
CREATE INDEX ON catalog.promotions (tenant_id, starts_at, ends_at) WHERE active;
SELECT core.enable_tenant_rls('catalog.promotions');

SELECT core.enable_audit(t) FROM unnest(ARRAY[
  'catalog.categories', 'catalog.brands', 'catalog.products', 'catalog.unit_conversions', 'catalog.product_suppliers', 'catalog.stock_params',
  'catalog.kit_items', 'catalog.price_lists', 'catalog.scheduled_price_changes', 'catalog.promotions'
]::regclass[]) AS t;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA catalog TO vortex_app;
REVOKE UPDATE, DELETE ON catalog.price_history FROM vortex_app;
