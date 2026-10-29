-- =====================================================================
-- 0012 — Compras e recebimento (seção 11) + livro de créditos IBS/CBS (RN-REF-04)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS purchasing;
GRANT USAGE ON SCHEMA purchasing TO vortex_app, vortex_worker;

-- Requisição (qualquer área pede um item ou serviço, com centro de custo e justificativa)
CREATE TABLE purchasing.requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  number bigint NOT NULL,
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  justification text NOT NULL,
  needed_by date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'quoting', 'ordered', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('purchasing.requests');

CREATE TABLE purchasing.request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  request_id uuid NOT NULL REFERENCES purchasing.requests(id) ON DELETE CASCADE,
  product_id uuid REFERENCES catalog.products(id),
  description text NOT NULL,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL DEFAULT 'UN'
);
SELECT core.enable_tenant_rls('purchasing.request_items');

-- Cotação: envio a vários fornecedores (link ou WhatsApp), mapa comparativo
CREATE TABLE purchasing.rfqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  number bigint NOT NULL,
  request_id uuid REFERENCES purchasing.requests(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('purchasing.rfqs');

CREATE TABLE purchasing.rfq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  rfq_id uuid NOT NULL REFERENCES purchasing.rfqs(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL
);
SELECT core.enable_tenant_rls('purchasing.rfq_items');

CREATE TABLE purchasing.rfq_suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  rfq_id uuid NOT NULL REFERENCES purchasing.rfqs(id) ON DELETE CASCADE,
  supplier_id uuid NOT NULL REFERENCES registry.parties(id),
  token text NOT NULL UNIQUE,
  freight numeric(18,2),
  freight_mode smallint,
  payment_terms text,
  responded_at timestamptz,
  UNIQUE (rfq_id, supplier_id)
);
SELECT core.enable_tenant_rls('purchasing.rfq_suppliers');

CREATE TABLE purchasing.rfq_responses (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  rfq_supplier_id uuid NOT NULL REFERENCES purchasing.rfq_suppliers(id) ON DELETE CASCADE,
  rfq_item_id uuid NOT NULL REFERENCES purchasing.rfq_items(id) ON DELETE CASCADE,
  unit_price numeric(20,10) NOT NULL CHECK (unit_price >= 0),
  lead_time_days int,
  selected boolean NOT NULL DEFAULT false,
  PRIMARY KEY (rfq_supplier_id, rfq_item_id)
);
SELECT core.enable_tenant_rls('purchasing.rfq_responses');

CREATE TABLE purchasing.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  number bigint NOT NULL,
  supplier_id uuid NOT NULL REFERENCES registry.parties(id),
  rfq_id uuid REFERENCES purchasing.rfqs(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'partially_received', 'received', 'cancelled')),
  -- CIF (0: por conta do remetente) ou FOB (1: por conta do destinatário)
  freight_mode smallint NOT NULL DEFAULT 0,
  freight numeric(18,2) NOT NULL DEFAULT 0,
  payment_term_id uuid REFERENCES registry.payment_terms(id),
  expected_date date,
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  category_id uuid REFERENCES finance.categories(id),
  total_products numeric(18,2) NOT NULL DEFAULT 0,
  total_estimated_taxes numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL DEFAULT 0,
  notes text,
  sent_at timestamptz,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, number)
);
CREATE UNIQUE INDEX purchase_orders_idem_uq ON purchasing.orders (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
SELECT core.enable_tenant_rls('purchasing.orders');
SELECT core.enable_touch('purchasing.orders');
SELECT core.enable_audit('purchasing.orders');

CREATE TABLE purchasing.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  order_id uuid NOT NULL REFERENCES purchasing.orders(id) ON DELETE CASCADE,
  item_number int NOT NULL,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  -- Quantidade e preço na unidade de estoque
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,10) NOT NULL CHECK (unit_price >= 0),
  ipi_rate numeric(9,4) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL,
  quantity_received numeric(18,4) NOT NULL DEFAULT 0,
  quantity_cancelled numeric(18,4) NOT NULL DEFAULT 0,
  request_item_id uuid REFERENCES purchasing.request_items(id),
  UNIQUE (order_id, item_number)
);
SELECT core.enable_tenant_rls('purchasing.order_items');

-- Recebimento a partir do XML (pré-recebimento → conferência → entrada)
CREATE TABLE purchasing.receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  supplier_id uuid NOT NULL REFERENCES registry.parties(id),
  order_id uuid REFERENCES purchasing.orders(id),
  inbound_document_id uuid REFERENCES fiscal.inbound_documents(id),
  fiscal_document_id uuid REFERENCES fiscal.documents(id),
  access_key char(44) NOT NULL,
  number text NOT NULL,
  series text NOT NULL,
  issue_date date NOT NULL,
  operation_type_code text NOT NULL DEFAULT 'COMPRA',
  xml_key text,
  parsed jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pre_receipt' CHECK (status IN ('pre_receipt', 'checking', 'divergent', 'completed', 'cancelled')),
  blind_count boolean NOT NULL DEFAULT false,
  -- RN-COM-06: nota sem pedido de compra (fica marcada no relatório de compras fora do processo)
  without_order boolean NOT NULL DEFAULT false,
  total_invoice numeric(18,2) NOT NULL,
  extra_freight numeric(18,2) NOT NULL DEFAULT 0,
  completed_at timestamptz,
  completed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, access_key)
);
SELECT core.enable_tenant_rls('purchasing.receipts');
SELECT core.enable_audit('purchasing.receipts');
ALTER TABLE fiscal.inbound_documents ADD CONSTRAINT inbound_receipt_fk FOREIGN KEY (receipt_id) REFERENCES purchasing.receipts(id);

CREATE TABLE purchasing.receipt_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  receipt_id uuid NOT NULL REFERENCES purchasing.receipts(id) ON DELETE CASCADE,
  xml_item_number int NOT NULL,
  supplier_code text NOT NULL,
  description text NOT NULL,
  ean text,
  ncm text,
  cfop text,
  supplier_unit text NOT NULL,
  supplier_quantity numeric(18,4) NOT NULL,
  supplier_unit_price numeric(20,10) NOT NULL,
  total numeric(18,2) NOT NULL,
  discount numeric(18,2) NOT NULL DEFAULT 0,
  freight numeric(18,2) NOT NULL DEFAULT 0,
  insurance numeric(18,2) NOT NULL DEFAULT 0,
  other_expenses numeric(18,2) NOT NULL DEFAULT 0,
  ipi numeric(18,2) NOT NULL DEFAULT 0,
  st numeric(18,2) NOT NULL DEFAULT 0,
  icms numeric(18,2) NOT NULL DEFAULT 0,
  icms_cst text,
  pis numeric(18,2) NOT NULL DEFAULT 0,
  cofins numeric(18,2) NOT NULL DEFAULT 0,
  ibs numeric(18,2) NOT NULL DEFAULT 0,
  cbs numeric(18,2) NOT NULL DEFAULT 0,
  -- De-para (RN-COM-03)
  product_id uuid REFERENCES catalog.products(id),
  match_source text CHECK (match_source IN ('supplier_code', 'gtin', 'suggestion', 'manual', 'order')),
  match_confidence numeric(5,2),
  factor numeric(18,6) NOT NULL DEFAULT 1,
  stock_quantity numeric(18,4),
  order_item_id uuid REFERENCES purchasing.order_items(id),
  counted_quantity numeric(18,4),
  divergences jsonb NOT NULL DEFAULT '[]',
  lot_number text,
  lot_manufactured_at date,
  lot_expires_at date,
  -- Custo de entrada calculado (RN-COM-04)
  entry_unit_cost numeric(20,10),
  entry_total_cost numeric(18,2),
  recoverable_icms numeric(18,2) NOT NULL DEFAULT 0,
  recoverable_pis_cofins numeric(18,2) NOT NULL DEFAULT 0,
  recoverable_ibs_cbs numeric(18,2) NOT NULL DEFAULT 0,
  UNIQUE (receipt_id, xml_item_number)
);
SELECT core.enable_tenant_rls('purchasing.receipt_items');

-- CT-e de frete de compra rateado entre notas e itens (RN-COM-05)
CREATE TABLE purchasing.freight_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  carrier_id uuid NOT NULL REFERENCES registry.parties(id),
  access_key char(44),
  number text NOT NULL,
  issue_date date NOT NULL,
  total numeric(18,2) NOT NULL CHECK (total > 0),
  icms_credit numeric(18,2) NOT NULL DEFAULT 0,
  allocation_method text NOT NULL DEFAULT 'value' CHECK (allocation_method IN ('value', 'weight')),
  receipt_ids uuid[] NOT NULL,
  allocations jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('purchasing.freight_documents');

-- Livro de créditos de IBS/CBS por estabelecimento e documento de origem (RN-REF-04)
CREATE TABLE fiscal.tax_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  document_id uuid REFERENCES fiscal.documents(id),
  tax text NOT NULL CHECK (tax IN ('IBS', 'CBS', 'ICMS', 'PIS', 'COFINS')),
  amount numeric(18,2) NOT NULL CHECK (amount >= 0),
  -- apropriado; condicionado ao pagamento (fornecedor ainda não recolheu); estornado; utilizado
  status text NOT NULL CHECK (status IN ('appropriated', 'conditional', 'reversed', 'used')),
  competence date NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON fiscal.tax_credits (tenant_id, establishment_id, tax, status);
SELECT core.enable_tenant_rls('fiscal.tax_credits');
SELECT core.enable_audit('fiscal.tax_credits');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA purchasing TO vortex_app;
GRANT SELECT, INSERT, UPDATE ON fiscal.tax_credits TO vortex_app;
GRANT SELECT ON purchasing.orders TO vortex_worker;
