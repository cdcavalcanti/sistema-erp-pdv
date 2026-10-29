-- =====================================================================
-- 0011 — Vendas e faturamento (seção 10)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS sales;
GRANT USAGE ON SCHEMA sales TO vortex_app, vortex_worker;

CREATE TABLE sales.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  number bigint NOT NULL,
  party_id uuid NOT NULL REFERENCES registry.parties(id),
  salesperson_id uuid REFERENCES registry.parties(id),
  channel text NOT NULL DEFAULT 'counter',
  operation_type_code text NOT NULL DEFAULT 'VENDA',
  payment_term_id uuid REFERENCES registry.payment_terms(id),
  payment_method_id uuid REFERENCES registry.payment_methods(id),
  freight_mode smallint NOT NULL DEFAULT 9,
  freight numeric(18,2) NOT NULL DEFAULT 0,
  discount numeric(18,2) NOT NULL DEFAULT 0,
  valid_until date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'converted')),
  total_products numeric(18,2) NOT NULL DEFAULT 0,
  total_taxes numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  fiscal_preview jsonb,
  notes text,
  public_token text NOT NULL,
  accepted_at timestamptz,
  accepted_by_name text,
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('sales.quotes');
SELECT core.enable_touch('sales.quotes');
SELECT core.enable_audit('sales.quotes');

CREATE TABLE sales.quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  quote_id uuid NOT NULL REFERENCES sales.quotes(id) ON DELETE CASCADE,
  item_number int NOT NULL,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  list_price numeric(20,10) NOT NULL,
  unit_price numeric(20,10) NOT NULL,
  discount_percent numeric(9,4) NOT NULL DEFAULT 0,
  discount_value numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL,
  UNIQUE (quote_id, item_number)
);
SELECT core.enable_tenant_rls('sales.quote_items');

CREATE TABLE sales.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  number bigint NOT NULL,
  quote_id uuid REFERENCES sales.quotes(id),
  party_id uuid NOT NULL REFERENCES registry.parties(id),
  salesperson_id uuid REFERENCES registry.parties(id),
  channel text NOT NULL DEFAULT 'counter' CHECK (channel IN ('counter', 'ecommerce', 'marketplace', 'crm', 'whatsapp', 'api', 'pdv', 'wholesale')),
  external_id text,
  operation_type_code text NOT NULL DEFAULT 'VENDA',
  price_list_id uuid REFERENCES catalog.price_lists(id),
  payment_term_id uuid REFERENCES registry.payment_terms(id),
  payment_method_id uuid REFERENCES registry.payment_methods(id),
  freight_mode smallint NOT NULL DEFAULT 9,
  carrier_id uuid REFERENCES registry.parties(id),
  freight numeric(18,2) NOT NULL DEFAULT 0,
  insurance numeric(18,2) NOT NULL DEFAULT 0,
  other_expenses numeric(18,2) NOT NULL DEFAULT 0,
  -- Desconto geral do pedido (rateado nos itens — RN-VEN-03)
  discount numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending_approval', 'approved', 'separating', 'partially_invoiced', 'invoiced', 'cancelled')),
  total_products numeric(18,2) NOT NULL DEFAULT 0,
  total_discount numeric(18,2) NOT NULL DEFAULT 0,
  total_estimated_taxes numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  delivery_address jsonb,
  expected_delivery date,
  reserved_until timestamptz,
  customer_order_ref text,
  notes text,
  cancel_reason text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, number)
);
CREATE UNIQUE INDEX orders_idem_uq ON sales.orders (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX orders_external_uq ON sales.orders (tenant_id, channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX ON sales.orders (tenant_id, status);
CREATE INDEX ON sales.orders (tenant_id, party_id);
SELECT core.enable_tenant_rls('sales.orders');
SELECT core.enable_touch('sales.orders');
SELECT core.enable_audit('sales.orders');

CREATE TABLE sales.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  order_id uuid NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
  item_number int NOT NULL,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  unit text NOT NULL,
  -- Fator da unidade de venda para a unidade de estoque
  unit_factor numeric(18,6) NOT NULL DEFAULT 1,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  quantity_invoiced numeric(18,4) NOT NULL DEFAULT 0,
  quantity_cancelled numeric(18,4) NOT NULL DEFAULT 0,
  quantity_returned numeric(18,4) NOT NULL DEFAULT 0,
  list_price numeric(20,10) NOT NULL,
  unit_price numeric(20,10) NOT NULL,
  discount_percent numeric(9,4) NOT NULL DEFAULT 0,
  -- Desconto do item e parcela do desconto geral, registrados separadamente (RN-VEN-03)
  item_discount numeric(18,2) NOT NULL DEFAULT 0,
  header_discount_share numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL,
  promotion_ids uuid[] NOT NULL DEFAULT '{}',
  lot_id uuid REFERENCES inventory.lots(id),
  notes text,
  UNIQUE (order_id, item_number),
  -- RN-VEN-01: saldo a faturar = pedida − faturada − cancelada
  CHECK (quantity_invoiced + quantity_cancelled <= quantity)
);
SELECT core.enable_tenant_rls('sales.order_items');

-- Vínculo pedido × documentos fiscais (faturamento parcial gera várias notas)
CREATE TABLE sales.order_invoices (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  order_id uuid NOT NULL REFERENCES sales.orders(id),
  document_id uuid NOT NULL REFERENCES fiscal.documents(id),
  kind text NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice', 'shipment', 'return')),
  undone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, document_id)
);
SELECT core.enable_tenant_rls('sales.order_invoices');

-- Comissões (RN-VEN-06)
CREATE TABLE sales.commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  salesperson_id uuid REFERENCES registry.parties(id),
  product_id uuid REFERENCES catalog.products(id),
  category_id uuid REFERENCES catalog.categories(id),
  price_list_id uuid REFERENCES catalog.price_lists(id),
  -- Faixa de desconto: quanto maior o desconto, menor a comissão
  max_discount_percent numeric(9,4),
  percent numeric(9,4) NOT NULL CHECK (percent >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('sales.commission_rules');

CREATE TABLE sales.commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  salesperson_id uuid NOT NULL REFERENCES registry.parties(id),
  order_id uuid REFERENCES sales.orders(id),
  document_id uuid REFERENCES fiscal.documents(id),
  title_id uuid REFERENCES finance.titles(id),
  basis text NOT NULL CHECK (basis IN ('invoice', 'receipt')),
  base_amount numeric(18,2) NOT NULL,
  percent numeric(9,4) NOT NULL,
  amount numeric(18,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'released', 'paid', 'reversed')),
  released_at timestamptz,
  reversal_of uuid REFERENCES sales.commissions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sales.commissions (tenant_id, salesperson_id, status);
SELECT core.enable_tenant_rls('sales.commissions');

-- Metas (RN-VEN-07)
CREATE TABLE sales.targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  salesperson_id uuid REFERENCES registry.parties(id),
  team text,
  establishment_id uuid REFERENCES core.establishments(id),
  product_id uuid REFERENCES catalog.products(id),
  category_id uuid REFERENCES catalog.categories(id),
  target_amount numeric(18,2),
  target_quantity numeric(18,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CHECK (period_end >= period_start)
);
SELECT core.enable_tenant_rls('sales.targets');

-- Devoluções e trocas
CREATE TABLE sales.returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  number bigint NOT NULL,
  order_id uuid REFERENCES sales.orders(id),
  original_document_id uuid NOT NULL REFERENCES fiscal.documents(id),
  return_document_id uuid REFERENCES fiscal.documents(id),
  -- Quem emite a nota da devolução: a própria empresa (nota de entrada) ou o cliente contribuinte
  issuer text NOT NULL CHECK (issuer IN ('own', 'customer')),
  customer_document_key char(44),
  reason text NOT NULL,
  destination text NOT NULL CHECK (destination IN ('normal', 'damaged', 'discard')),
  financial_treatment text NOT NULL CHECK (financial_treatment IN ('abatement', 'store_credit', 'card_refund', 'cash_refund', 'pix_refund')),
  refund_account_id uuid REFERENCES finance.accounts(id),
  total numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  exchange_order_id uuid REFERENCES sales.orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('sales.returns');
SELECT core.enable_audit('sales.returns');

-- Separação e expedição (V1)
CREATE TABLE sales.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  order_id uuid NOT NULL REFERENCES sales.orders(id),
  document_id uuid REFERENCES fiscal.documents(id),
  carrier_id uuid REFERENCES registry.parties(id),
  status text NOT NULL DEFAULT 'picking' CHECK (status IN ('picking', 'checked', 'shipped', 'delivered', 'returned')),
  picking jsonb NOT NULL DEFAULT '[]',
  divergences jsonb NOT NULL DEFAULT '[]',
  volumes int,
  gross_weight numeric(18,4),
  tracking_code text,
  manifest_number text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  delivery_proof_key text,
  delivery_receiver text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('sales.shipments');
SELECT core.enable_audit('sales.shipments');

-- Venda perdida por falta (indicador de ruptura)
CREATE TABLE sales.lost_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  quantity numeric(18,4) NOT NULL,
  reason text NOT NULL DEFAULT 'out_of_stock',
  order_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('sales.lost_sales');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sales TO vortex_app;
