-- =====================================================================
-- 0002 — Cadastros base e tabelas auxiliares (seção 05)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS fiscal;
CREATE SCHEMA IF NOT EXISTS finance;
CREATE SCHEMA IF NOT EXISTS accounting;
GRANT USAGE ON SCHEMA registry, fiscal, finance, accounting TO vortex_app, vortex_worker;

-- ---------------------------------------------------------------------
-- Tabelas oficiais (globais, sem tenant): importadas e atualizadas por job, com vigência
-- ---------------------------------------------------------------------
CREATE TABLE fiscal.ncm (
  code char(8) NOT NULL CHECK (code ~ '^\d{8}$'),
  description text NOT NULL,
  valid_from date NOT NULL DEFAULT '2017-01-01',
  valid_to date,
  -- Alíquota IPI pela TIPI (referência) e flags úteis ao motor
  ipi_rate numeric(9,4),
  pis_cofins_monofasico boolean NOT NULL DEFAULT false,
  PRIMARY KEY (code, valid_from)
);

CREATE TABLE fiscal.cest (
  code char(7) PRIMARY KEY CHECK (code ~ '^\d{7}$'),
  description text NOT NULL,
  segment text,
  ncm_prefixes text[] NOT NULL DEFAULT '{}',
  valid_from date NOT NULL DEFAULT '2016-01-01',
  valid_to date
);

CREATE TABLE fiscal.cfop (
  code char(4) PRIMARY KEY CHECK (code ~ '^[1-7]\d{3}$'),
  description text NOT NULL,
  -- 1/2/3 entradas (estadual/interestadual/exterior), 5/6/7 saídas
  direction char(1) NOT NULL GENERATED ALWAYS AS (CASE WHEN left(code,1) IN ('1','2','3') THEN 'E' ELSE 'S' END) STORED,
  scope char(1) NOT NULL GENERATED ALWAYS AS (CASE WHEN left(code,1) IN ('1','5') THEN 'I' WHEN left(code,1) IN ('2','6') THEN 'X' ELSE 'E' END) STORED,
  is_return boolean NOT NULL DEFAULT false,
  valid_from date NOT NULL DEFAULT '2000-01-01',
  valid_to date
);

-- Código de classificação tributária do IBS/CBS (LC 214/2025, NT 2025.002)
CREATE TABLE fiscal.cclasstrib (
  code char(6) NOT NULL CHECK (code ~ '^\d{6}$'),
  cst char(3) NOT NULL CHECK (cst ~ '^\d{3}$'),
  description text NOT NULL,
  -- Percentual de redução de alíquota (ex.: 60, 30) e flags de tratamento
  reduction_ibs numeric(9,4) NOT NULL DEFAULT 0,
  reduction_cbs numeric(9,4) NOT NULL DEFAULT 0,
  presumed_credit boolean NOT NULL DEFAULT false,
  deferral boolean NOT NULL DEFAULT false,
  exempt boolean NOT NULL DEFAULT false,
  legal_basis text,
  valid_from date NOT NULL DEFAULT '2026-01-01',
  valid_to date,
  PRIMARY KEY (code, valid_from)
);

CREATE TABLE fiscal.ibge_cities (
  code char(7) PRIMARY KEY,
  name text NOT NULL,
  uf char(2) NOT NULL
);
CREATE INDEX ON fiscal.ibge_cities (uf, name);

CREATE TABLE fiscal.countries (
  bacen_code char(4) PRIMARY KEY,
  name text NOT NULL,
  iso2 char(2)
);

CREATE TABLE fiscal.nbs (
  code text PRIMARY KEY,
  description text NOT NULL,
  valid_from date NOT NULL DEFAULT '2026-01-01',
  valid_to date
);

-- Lista de serviços da LC 116/2003
CREATE TABLE fiscal.service_codes (
  code text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE fiscal.units (
  code text PRIMARY KEY,
  description text NOT NULL
);

GRANT SELECT ON fiscal.ncm, fiscal.cest, fiscal.cfop, fiscal.cclasstrib, fiscal.ibge_cities, fiscal.countries, fiscal.nbs, fiscal.service_codes, fiscal.units TO vortex_app, vortex_worker;

-- ---------------------------------------------------------------------
-- Pessoas (cadastro único com papéis)
-- ---------------------------------------------------------------------
CREATE TABLE registry.parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  -- NULL = compartilhado entre as empresas do tenant (RN-ORG-02)
  company_id uuid REFERENCES core.companies(id),
  code bigint,
  kind char(2) NOT NULL CHECK (kind IN ('PF', 'PJ', 'EX')),
  -- CPF (11) ou CNPJ (14, pode ser alfanumérico). Sempre texto.
  tax_id varchar(14) CHECK (tax_id IS NULL OR tax_id ~ '^(\d{11}|[0-9A-Z]{12}\d{2})$'),
  foreign_id text,
  legal_name text NOT NULL,
  trade_name text,
  birth_date date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'inactive')),
  block_reason text,
  -- Fiscal
  ie_indicator smallint NOT NULL DEFAULT 9 CHECK (ie_indicator IN (1, 2, 9)),
  ie text,
  im text,
  suframa text,
  tax_regime text CHECK (tax_regime IN ('simples_nacional', 'mei', 'normal')),
  final_consumer boolean NOT NULL DEFAULT true,
  xml_email text,
  -- Situação cadastral na Receita (RN-CAD-04)
  registration_status text CHECK (registration_status IN ('ativa', 'suspensa', 'inapta', 'baixada', 'nula')),
  registration_checked_at timestamptz,
  -- Comercial
  price_list_id uuid,
  salesperson_id uuid REFERENCES registry.parties(id),
  payment_term_id uuid,
  segment text,
  carrier_id uuid REFERENCES registry.parties(id),
  credit_limit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  risk_class char(1) CHECK (risk_class IN ('A', 'B', 'C', 'D', 'E')),
  -- Financeiro
  payment_method_id uuid,
  ledger_account_id uuid,
  cost_center_id uuid,
  -- LGPD (RN-ACE-04)
  lgpd_purpose text,
  anonymized_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
-- RN-CAD-02: CPF/CNPJ único por tenant entre pessoas ativas
CREATE UNIQUE INDEX parties_tax_id_active_uq ON registry.parties (tenant_id, tax_id) WHERE tax_id IS NOT NULL AND status <> 'inactive';
CREATE UNIQUE INDEX ON registry.parties (tenant_id, code);
CREATE INDEX parties_name_idx ON registry.parties USING gin (to_tsvector('simple', legal_name || ' ' || coalesce(trade_name, '')));
SELECT core.enable_tenant_rls('registry.parties');
SELECT core.enable_touch('registry.parties');

CREATE TABLE registry.party_roles (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  party_id uuid NOT NULL REFERENCES registry.parties(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('customer', 'supplier', 'carrier', 'salesperson', 'employee', 'partner')),
  active boolean NOT NULL DEFAULT true,
  since date NOT NULL DEFAULT current_date,
  PRIMARY KEY (party_id, role)
);
SELECT core.enable_tenant_rls('registry.party_roles');

CREATE TABLE registry.party_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  party_id uuid NOT NULL REFERENCES registry.parties(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('fiscal', 'delivery', 'billing')),
  zip char(8),
  street text NOT NULL,
  number text NOT NULL,
  complement text,
  district text NOT NULL,
  city_ibge char(7),
  city_name text NOT NULL,
  uf char(2),
  country_code char(4) NOT NULL DEFAULT '1058',
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CHECK (country_code <> '1058' OR (city_ibge IS NOT NULL AND uf IS NOT NULL AND zip IS NOT NULL))
);
CREATE INDEX ON registry.party_addresses (party_id);
SELECT core.enable_tenant_rls('registry.party_addresses');

CREATE TABLE registry.party_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  party_id uuid NOT NULL REFERENCES registry.parties(id) ON DELETE CASCADE,
  name text NOT NULL,
  job_title text,
  phone text,
  whatsapp text,
  email text,
  -- Consentimentos LGPD e preferências de canal: {"marketing":true,"cobranca_whatsapp":true}
  consents jsonb NOT NULL DEFAULT '{}',
  preferred_channel text CHECK (preferred_channel IN ('email', 'whatsapp', 'phone')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON registry.party_contacts (party_id);
SELECT core.enable_tenant_rls('registry.party_contacts');

-- RN-ACE-02: conta bancária/chave Pix de pessoa nasce pendente e exige dupla aprovação
CREATE TABLE registry.party_bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  party_id uuid NOT NULL REFERENCES registry.parties(id),
  bank_code char(3),
  branch text,
  account_number text,
  account_type text CHECK (account_type IN ('checking', 'savings', 'payment')),
  pix_key_type text CHECK (pix_key_type IN ('cpf', 'cnpj', 'email', 'phone', 'random')),
  pix_key text,
  holder_name text NOT NULL,
  holder_tax_id varchar(14) NOT NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'active', 'rejected', 'inactive')),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (pix_key IS NOT NULL OR (bank_code IS NOT NULL AND branch IS NOT NULL AND account_number IS NOT NULL))
);
CREATE INDEX ON registry.party_bank_accounts (party_id);
SELECT core.enable_tenant_rls('registry.party_bank_accounts');
SELECT core.enable_touch('registry.party_bank_accounts');

-- ---------------------------------------------------------------------
-- Tabelas auxiliares obrigatórias
-- ---------------------------------------------------------------------
-- Plano de contas gerencial (DRE) / categorias financeiras
CREATE TABLE finance.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  parent_id uuid REFERENCES finance.categories(id),
  kind text NOT NULL CHECK (kind IN ('revenue', 'deduction', 'cost', 'expense', 'financial_revenue', 'financial_expense', 'tax_on_profit', 'investment', 'financing', 'transfer')),
  dre_group text NOT NULL,
  ledger_account_id uuid,
  accepts_entries boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('finance.categories');

CREATE TABLE finance.cost_centers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  parent_id uuid REFERENCES finance.cost_centers(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('finance.cost_centers');

CREATE TABLE finance.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('finance.projects');

-- Contas financeiras: bancos, caixas físicos, carteiras digitais, cartões corporativos
CREATE TABLE finance.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid REFERENCES core.establishments(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bank', 'cash', 'wallet', 'corporate_card', 'acquirer', 'investment')),
  bank_code char(3),
  branch text,
  account_number text,
  pix_key text,
  initial_balance numeric(18,2) NOT NULL DEFAULT 0,
  initial_balance_date date NOT NULL DEFAULT current_date,
  ledger_account_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, company_id, code)
);
SELECT core.enable_tenant_rls('finance.accounts');
SELECT core.enable_touch('finance.accounts');

-- Plano de contas contábil (vinculado ao referencial da Receita — RN-CTB-03)
CREATE TABLE accounting.chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  parent_id uuid REFERENCES accounting.chart_of_accounts(id),
  nature text NOT NULL CHECK (nature IN ('asset', 'liability', 'equity', 'revenue', 'expense', 'result')),
  -- Natureza do saldo: D (devedora) ou C (credora)
  balance_side char(1) NOT NULL CHECK (balance_side IN ('D', 'C')),
  is_analytic boolean NOT NULL DEFAULT true,
  -- RN-CTB-05: só contas marcadas aceitam lançamento manual
  accepts_manual boolean NOT NULL DEFAULT false,
  referential_code text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('accounting.chart_of_accounts');

CREATE TABLE registry.payment_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  -- [{"days":30,"percent":"33.3333"}, ...] — percentuais somam 100 com a entrada
  installments jsonb NOT NULL,
  down_payment_percent numeric(9,4) NOT NULL DEFAULT 0,
  interest_percent_month numeric(9,4) NOT NULL DEFAULT 0,
  fixed_due_day smallint CHECK (fixed_due_day BETWEEN 1 AND 31),
  is_cash boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('registry.payment_terms');

CREATE TABLE registry.payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cash', 'pix', 'boleto', 'credit_card', 'debit_card', 'transfer', 'store_credit', 'check', 'other')),
  -- Código tPag da NF-e (01 dinheiro, 03 crédito, 04 débito, 05 crédito loja, 15 boleto, 17 Pix, 18 transferência...)
  nfe_tpag char(2) NOT NULL,
  financial_account_id uuid REFERENCES finance.accounts(id),
  -- Para cartão: título contra a adquirente (RN-FIN-08)
  acquirer_party_id uuid REFERENCES registry.parties(id),
  fee_percent numeric(9,4) NOT NULL DEFAULT 0,
  settlement_days int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('registry.payment_methods');

-- Naturezas / tipos de operação: definem o que movimenta (estoque, financeiro, fiscal)
CREATE TABLE fiscal.operation_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  direction char(1) NOT NULL CHECK (direction IN ('S', 'E')),
  purpose text NOT NULL CHECK (purpose IN ('sale', 'sale_return', 'purchase', 'purchase_return', 'shipment', 'shipment_return', 'bonus', 'transfer',
    'demonstration', 'repair', 'consignment', 'future_delivery', 'future_delivery_shipment', 'third_party_order', 'third_party_shipment',
    'industrialization', 'service', 'loss', 'internal_use', 'adjustment')),
  -- 1 normal, 2 complementar, 3 ajuste, 4 devolução
  nfe_purpose smallint NOT NULL DEFAULT 1 CHECK (nfe_purpose IN (1, 2, 3, 4)),
  moves_stock boolean NOT NULL DEFAULT true,
  stock_target text NOT NULL DEFAULT 'own' CHECK (stock_target IN ('own', 'third_party_with_us', 'ours_with_third_party', 'none')),
  generates_financial boolean NOT NULL DEFAULT true,
  generates_fiscal boolean NOT NULL DEFAULT true,
  generates_commission boolean NOT NULL DEFAULT true,
  fiscal_model varchar(2) NOT NULL DEFAULT '55',
  -- CFOP padrão quando nenhuma regra fiscal específica define (o motor usa a matriz primeiro)
  cfop_internal char(4),
  cfop_interstate char(4),
  cfop_foreign char(4),
  default_ledger_account_id uuid,
  category_id uuid REFERENCES finance.categories(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('fiscal.operation_types');
SELECT core.enable_touch('fiscal.operation_types');

ALTER TABLE registry.parties
  ADD CONSTRAINT parties_payment_term_fk FOREIGN KEY (payment_term_id) REFERENCES registry.payment_terms(id),
  ADD CONSTRAINT parties_payment_method_fk FOREIGN KEY (payment_method_id) REFERENCES registry.payment_methods(id),
  ADD CONSTRAINT parties_cost_center_fk FOREIGN KEY (cost_center_id) REFERENCES finance.cost_centers(id),
  ADD CONSTRAINT parties_ledger_fk FOREIGN KEY (ledger_account_id) REFERENCES accounting.chart_of_accounts(id);
ALTER TABLE core.users ADD CONSTRAINT users_party_fk FOREIGN KEY (party_id) REFERENCES registry.parties(id);

SELECT core.enable_audit(t) FROM unnest(ARRAY[
  'registry.parties', 'registry.party_roles', 'registry.party_addresses', 'registry.party_contacts', 'registry.party_bank_accounts',
  'finance.categories', 'finance.cost_centers', 'finance.projects', 'finance.accounts', 'accounting.chart_of_accounts',
  'registry.payment_terms', 'registry.payment_methods', 'fiscal.operation_types'
]::regclass[]) AS t;

-- RN-CAD-05: cadastro com movimento nunca é excluído; só inativado.
-- Cada módulo que referencia uma pessoa cria FK sem CASCADE, então o DELETE falha
-- se houver vínculo. Exclusão física só é permitida para registro sem vínculo.

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA registry, finance, accounting TO vortex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.operation_types TO vortex_app;

-- Contadores de código por tenant (cadastros compartilhados entre empresas)
CREATE TABLE core.tenant_counters (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  key text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, key)
);
SELECT core.enable_tenant_rls('core.tenant_counters');
GRANT SELECT, INSERT, UPDATE ON core.tenant_counters TO vortex_app;

CREATE OR REPLACE FUNCTION core.next_tenant_counter(p_key text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO core.tenant_counters (tenant_id, key, value) VALUES (core.current_tenant(), p_key, 1)
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = core.tenant_counters.value + 1
  RETURNING value INTO v;
  RETURN v;
END $$;
