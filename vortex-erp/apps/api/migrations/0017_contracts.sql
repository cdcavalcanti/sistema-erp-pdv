-- =====================================================================
-- 0017 — Serviços, contratos e recorrência (seção 16) + NFS-e padrão nacional (seção 09)
-- =====================================================================

-- NFS-e nacional: chave de 50 dígitos, número da NFS-e e código de verificação (a DPS usa série/número próprios)
ALTER TABLE fiscal.documents
  ADD COLUMN nfse_key varchar(50) CHECK (nfse_key IS NULL OR nfse_key ~ '^\d{50}$'),
  ADD COLUMN nfse_number text,
  ADD COLUMN nfse_verification_code text;
CREATE UNIQUE INDEX documents_nfse_key_uq ON fiscal.documents (tenant_id, nfse_key) WHERE nfse_key IS NOT NULL;

CREATE SCHEMA IF NOT EXISTS contracts;
GRANT USAGE ON SCHEMA contracts TO vortex_app, vortex_worker;

-- Índices de reajuste (IPCA, IGP-M, INPC) mensais, mantidos pelo tenant ou importados
CREATE TABLE contracts.index_rates (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  index_code text NOT NULL CHECK (index_code IN ('IPCA', 'IGPM', 'INPC')),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  percent numeric(9,4) NOT NULL,
  PRIMARY KEY (tenant_id, index_code, month)
);
SELECT core.enable_tenant_rls('contracts.index_rates');

CREATE TABLE contracts.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  number bigint NOT NULL,
  party_id uuid NOT NULL REFERENCES registry.parties(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'suspended', 'cancelled', 'ended')),
  periodicity text NOT NULL CHECK (periodicity IN ('monthly', 'quarterly', 'semiannual', 'annual')),
  billing_day smallint NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
  due_days smallint NOT NULL DEFAULT 5 CHECK (due_days BETWEEN 0 AND 90),
  start_date date NOT NULL,
  end_date date,
  auto_renew boolean NOT NULL DEFAULT true,
  renewal_months smallint NOT NULL DEFAULT 12,
  -- Reajuste na data-base: índice acumulado em 12 meses ou percentual fixo (RN-CTR-01)
  adjustment_index text CHECK (adjustment_index IN ('IPCA', 'IGPM', 'INPC', 'fixed')),
  adjustment_percent numeric(9,4),
  next_adjustment_date date,
  termination_fine_percent numeric(9,4) NOT NULL DEFAULT 0,
  -- RN-CTR-02: troca de plano no meio do ciclo cobra/credita pro rata ou só no próximo ciclo
  proration text NOT NULL DEFAULT 'prorata' CHECK (proration IN ('prorata', 'next_cycle')),
  document_model text NOT NULL DEFAULT '99' CHECK (document_model IN ('99', '55', 'none')),
  payment_method_id uuid REFERENCES registry.payment_methods(id),
  charge_kind text CHECK (charge_kind IN ('boleto', 'pix_cob', 'pix_cobv')),
  charge_account_id uuid REFERENCES finance.accounts(id),
  category_id uuid REFERENCES finance.categories(id),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  next_billing_date date NOT NULL,
  credit_balance numeric(18,2) NOT NULL DEFAULT 0,
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, number)
);
CREATE INDEX ON contracts.contracts (tenant_id, status, next_billing_date);
SELECT core.enable_tenant_rls('contracts.contracts');
SELECT core.enable_touch('contracts.contracts');
SELECT core.enable_audit('contracts.contracts');

CREATE TABLE contracts.contract_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  contract_id uuid NOT NULL REFERENCES contracts.contracts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  description text,
  -- fixed: valor do período; usage: cobrado por uso (horas, mensagens, transações) acima da franquia
  billing_type text NOT NULL DEFAULT 'fixed' CHECK (billing_type IN ('fixed', 'usage')),
  quantity numeric(18,4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(20,10) NOT NULL CHECK (unit_price >= 0),
  usage_metric text,
  included_quantity numeric(18,4) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  start_date date NOT NULL,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT core.enable_tenant_rls('contracts.contract_items');

-- Histórico de valores do contrato (reajustes e trocas de plano)
CREATE TABLE contracts.price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  contract_id uuid NOT NULL REFERENCES contracts.contracts(id),
  contract_item_id uuid NOT NULL REFERENCES contracts.contract_items(id),
  valid_from date NOT NULL,
  old_price numeric(20,10),
  new_price numeric(20,10) NOT NULL,
  reason text NOT NULL CHECK (reason IN ('initial', 'adjustment', 'plan_change')),
  index_code text,
  percent numeric(9,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('contracts.price_history');

-- Consumo variável lido de API, planilha ou do VORTEX Meter antes do faturamento
CREATE TABLE contracts.usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  contract_item_id uuid NOT NULL REFERENCES contracts.contract_items(id),
  occurred_on date NOT NULL,
  quantity numeric(18,4) NOT NULL,
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'csv', 'meter', 'manual')),
  reference text NOT NULL,
  billing_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_item_id, reference)
);
SELECT core.enable_tenant_rls('contracts.usage');

CREATE TABLE contracts.billings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  contract_id uuid NOT NULL REFERENCES contracts.contracts(id),
  kind text NOT NULL DEFAULT 'regular' CHECK (kind IN ('regular', 'prorata', 'termination')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'invoiced', 'failed')),
  amount numeric(18,2) NOT NULL DEFAULT 0,
  credit_applied numeric(18,2) NOT NULL DEFAULT 0,
  lines jsonb NOT NULL DEFAULT '[]',
  document_ids uuid[] NOT NULL DEFAULT '{}',
  title_ids uuid[] NOT NULL DEFAULT '{}',
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, kind, period_start)
);
SELECT core.enable_tenant_rls('contracts.billings');

-- Ordens de serviço: técnico, agenda, peças (baixam estoque), horas, assinatura e faturamento
CREATE TABLE contracts.service_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id),
  number bigint NOT NULL,
  party_id uuid NOT NULL REFERENCES registry.parties(id),
  contract_id uuid REFERENCES contracts.contracts(id),
  service_product_id uuid NOT NULL REFERENCES catalog.products(id),
  technician_id uuid REFERENCES registry.parties(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'scheduled', 'in_progress', 'done', 'invoiced', 'cancelled')),
  description text NOT NULL,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  hours numeric(9,2) NOT NULL DEFAULT 0,
  hourly_rate numeric(18,2) NOT NULL DEFAULT 0,
  signed_by text,
  signed_at timestamptz,
  signature_key text,
  document_id uuid REFERENCES fiscal.documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('contracts.service_orders');
SELECT core.enable_audit('contracts.service_orders');

CREATE TABLE contracts.service_order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  service_order_id uuid NOT NULL REFERENCES contracts.service_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES catalog.products(id),
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,10) NOT NULL DEFAULT 0,
  unit_cost numeric(20,10),
  movement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT core.enable_tenant_rls('contracts.service_order_parts');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA contracts TO vortex_app;
GRANT SELECT ON contracts.contracts TO vortex_worker;
