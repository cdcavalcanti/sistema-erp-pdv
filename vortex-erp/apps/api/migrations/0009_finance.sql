-- =====================================================================
-- 0009 — Financeiro e tesouraria (seção 13)
-- Título é a promessa; a baixa é o dinheiro entrando/saindo de uma conta.
-- =====================================================================

-- Parâmetros por empresa (multa/juros, ordem de abatimento, bloqueios de crédito...)
ALTER TABLE core.companies ADD COLUMN settings jsonb NOT NULL DEFAULT '{
  "finance": {"finePercent": "2", "interestMonthPercent": "1", "abatementOrder": "charges_first", "overdueBlockDays": 5},
  "sales": {"reservationHours": 72, "commissionBasis": "invoice", "requireApprovalBelowCost": true},
  "purchasing": {"priceTolerancePercent": "2", "quantityTolerance": "0", "blindReceiving": false},
  "fiscal": {"cancelHours": 24, "extemporaneousCancelUfs": []}
}';

CREATE TABLE finance.titles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid REFERENCES core.establishments(id),
  kind text NOT NULL CHECK (kind IN ('receivable', 'payable')),
  document_number text NOT NULL,
  installment int NOT NULL DEFAULT 1,
  installments_total int NOT NULL DEFAULT 1,
  party_id uuid NOT NULL REFERENCES registry.parties(id),
  -- Origem: nota de venda/compra, contrato, folha, imposto, manual (com permissão), adiantamento, renegociação, PDV, cartão
  origin_type text NOT NULL CHECK (origin_type IN ('sales_invoice', 'purchase_invoice', 'contract', 'payroll', 'tax', 'manual', 'advance', 'renegotiation',
    'pdv', 'card', 'service_order', 'sale_return', 'purchase_return', 'commission', 'expense_reimbursement')),
  origin_id uuid,
  fiscal_document_id uuid REFERENCES fiscal.documents(id),
  issue_date date NOT NULL,
  competence_date date NOT NULL,
  due_date_original date NOT NULL,
  due_date date NOT NULL,
  -- Valores
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  abatements numeric(18,2) NOT NULL DEFAULT 0 CHECK (abatements >= 0),
  discount_given numeric(18,2) NOT NULL DEFAULT 0 CHECK (discount_given >= 0),
  paid_principal numeric(18,2) NOT NULL DEFAULT 0 CHECK (paid_principal >= 0),
  paid_interest numeric(18,2) NOT NULL DEFAULT 0,
  paid_fine numeric(18,2) NOT NULL DEFAULT 0,
  balance numeric(18,2) NOT NULL,
  early_discount_amount numeric(18,2) NOT NULL DEFAULT 0,
  early_discount_until date,
  fine_percent numeric(9,4) NOT NULL DEFAULT 0,
  interest_month_percent numeric(9,4) NOT NULL DEFAULT 0,
  -- Cartão: título contra a adquirente (RN-FIN-08)
  gross_amount numeric(18,2),
  fee_amount numeric(18,2),
  -- Split payment (RN-REF-06): parcela do tributo retida pelo meio de pagamento
  tax_withheld_amount numeric(18,2) NOT NULL DEFAULT 0,
  -- Classificação
  category_id uuid REFERENCES finance.categories(id),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  project_id uuid REFERENCES finance.projects(id),
  -- Cobrança
  payment_method_id uuid REFERENCES registry.payment_methods(id),
  account_id uuid REFERENCES finance.accounts(id),
  bank_account_id uuid REFERENCES registry.party_bank_accounts(id),
  our_number text,
  digitable_line text,
  barcode text,
  pix_txid text,
  pix_qr_code text,
  bank_status text,
  -- Status: em atraso é derivado (due_date < hoje e saldo > 0)
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partially_paid', 'paid', 'renegotiated', 'cancelled', 'lost')),
  renegotiation_id uuid,
  -- Aprovação de pagamento (contas a pagar) com segregação de funções (RN-ACE-01)
  approved_at timestamptz,
  approved_by uuid,
  notes text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (balance >= 0),
  CHECK (balance = amount - abatements - discount_given - paid_principal)
);
CREATE INDEX ON finance.titles (tenant_id, kind, status, due_date);
CREATE INDEX ON finance.titles (tenant_id, party_id);
CREATE INDEX ON finance.titles (tenant_id, origin_type, origin_id);
CREATE UNIQUE INDEX titles_pix_txid_uq ON finance.titles (pix_txid) WHERE pix_txid IS NOT NULL;
CREATE UNIQUE INDEX titles_idem_uq ON finance.titles (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
SELECT core.enable_tenant_rls('finance.titles');
SELECT core.enable_touch('finance.titles');
SELECT core.enable_audit('finance.titles');
SELECT accounting.enable_period_lock('finance.titles', 'competence_date');

-- RN-FIN-01: título gerado por documento fiscal não tem valor alterado manualmente
CREATE OR REPLACE FUNCTION finance.title_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.fiscal_document_id IS NOT NULL AND NEW.amount IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'RN-FIN-01: título gerado por documento fiscal não pode ter o valor alterado; use devolução, abatimento ou renegociação' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('paid', 'renegotiated', 'cancelled', 'lost') AND NEW.status = OLD.status
     AND (NEW.amount, NEW.due_date, NEW.party_id) IS DISTINCT FROM (OLD.amount, OLD.due_date, OLD.party_id) THEN
    RAISE EXCEPTION 'RN-GER-02: título % não pode ser alterado', OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_title_guard BEFORE UPDATE ON finance.titles FOR EACH ROW EXECUTE FUNCTION finance.title_guard();

-- Rateio por centro de custo (percentual)
CREATE TABLE finance.title_allocations (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  title_id uuid NOT NULL REFERENCES finance.titles(id) ON DELETE CASCADE,
  cost_center_id uuid NOT NULL REFERENCES finance.cost_centers(id),
  percent numeric(9,4) NOT NULL CHECK (percent > 0 AND percent <= 100),
  PRIMARY KEY (title_id, cost_center_id)
);
SELECT core.enable_tenant_rls('finance.title_allocations');

-- Renegociação (RN-FIN-04)
CREATE TABLE finance.renegotiations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  party_id uuid NOT NULL REFERENCES registry.parties(id),
  original_balance numeric(18,2) NOT NULL,
  charges_negotiated numeric(18,2) NOT NULL DEFAULT 0,
  discount_granted numeric(18,2) NOT NULL DEFAULT 0,
  new_total numeric(18,2) NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('finance.renegotiations');
ALTER TABLE finance.titles ADD CONSTRAINT titles_reneg_fk FOREIGN KEY (renegotiation_id) REFERENCES finance.renegotiations(id);

-- Movimentos de conta (o saldo financeiro só muda por lançamento — RN-GER-01)
CREATE TABLE finance.account_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  movement_date date NOT NULL,
  direction char(1) NOT NULL CHECK (direction IN ('C', 'D')),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  description text NOT NULL,
  category_id uuid REFERENCES finance.categories(id),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  party_id uuid REFERENCES registry.parties(id),
  settlement_id uuid,
  transfer_id uuid,
  reversal_of uuid REFERENCES finance.account_movements(id),
  reconciled boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'settlement',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON finance.account_movements (tenant_id, account_id, movement_date);
SELECT core.enable_tenant_rls('finance.account_movements');
SELECT core.enable_audit('finance.account_movements');
SELECT accounting.enable_period_lock('finance.account_movements', 'movement_date');
CREATE OR REPLACE FUNCTION finance.movement_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Movimento financeiro não pode ser excluído; faça o estorno' USING ERRCODE = 'P0001', HINT = 'IMMUTABLE'; END IF;
  IF (NEW.amount, NEW.direction, NEW.account_id, NEW.movement_date) IS DISTINCT FROM (OLD.amount, OLD.direction, OLD.account_id, OLD.movement_date) THEN
    RAISE EXCEPTION 'Movimento financeiro é imutável; faça o estorno' USING ERRCODE = 'P0001', HINT = 'IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_movement_guard BEFORE UPDATE OR DELETE ON finance.account_movements FOR EACH ROW EXECUTE FUNCTION finance.movement_guard();

-- Baixas (título × baixas 1:N; movimento de conta ligado à baixa)
CREATE TABLE finance.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  title_id uuid NOT NULL REFERENCES finance.titles(id),
  settlement_date date NOT NULL,
  account_id uuid REFERENCES finance.accounts(id),
  principal numeric(18,2) NOT NULL DEFAULT 0,
  interest numeric(18,2) NOT NULL DEFAULT 0,
  fine numeric(18,2) NOT NULL DEFAULT 0,
  discount numeric(18,2) NOT NULL DEFAULT 0,
  abatement numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL,
  kind text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'abatement', 'advance_compensation', 'renegotiation', 'loss', 'reversal')),
  method text,
  reference text,
  account_movement_id uuid REFERENCES finance.account_movements(id),
  batch_id uuid,
  advance_title_id uuid REFERENCES finance.titles(id),
  reversal_of uuid REFERENCES finance.settlements(id),
  reversed boolean NOT NULL DEFAULT false,
  reason text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON finance.settlements (tenant_id, title_id);
CREATE UNIQUE INDEX settlements_idem_uq ON finance.settlements (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
SELECT core.enable_tenant_rls('finance.settlements');
SELECT core.enable_audit('finance.settlements');
SELECT accounting.enable_period_lock('finance.settlements', 'settlement_date');
ALTER TABLE finance.account_movements ADD CONSTRAINT movements_settlement_fk FOREIGN KEY (settlement_id) REFERENCES finance.settlements(id);

-- Cobranças registradas no banco: boleto (híbrido com Pix) e Pix cob/cobv
CREATE TABLE finance.charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  title_id uuid NOT NULL REFERENCES finance.titles(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  kind text NOT NULL CHECK (kind IN ('boleto', 'pix_cob', 'pix_cobv', 'pix_automatico')),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('pending', 'registered', 'paid', 'cancelled', 'expired', 'failed')),
  amount numeric(18,2) NOT NULL,
  due_date date NOT NULL,
  txid text,
  our_number text,
  digitable_line text,
  barcode text,
  qr_code text,
  gateway text NOT NULL,
  gateway_id text,
  paid_at timestamptz,
  paid_amount numeric(18,2),
  fee_amount numeric(18,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE UNIQUE INDEX charges_txid_uq ON finance.charges (txid) WHERE txid IS NOT NULL;
SELECT core.enable_tenant_rls('finance.charges');

-- Borderô de pagamento (RN-FIN-07)
CREATE TABLE finance.payment_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  number bigint NOT NULL,
  payment_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent', 'confirmed', 'partially_confirmed', 'cancelled')),
  total numeric(18,2) NOT NULL DEFAULT 0,
  file_key text,
  approved_by uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('finance.payment_batches');
SELECT core.enable_audit('finance.payment_batches');

CREATE TABLE finance.payment_batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  batch_id uuid NOT NULL REFERENCES finance.payment_batches(id) ON DELETE CASCADE,
  title_id uuid NOT NULL REFERENCES finance.titles(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('pix', 'ted', 'boleto', 'internal')),
  bank_account_id uuid REFERENCES registry.party_bank_accounts(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  bank_reference text,
  failure_reason text,
  UNIQUE (batch_id, title_id)
);
SELECT core.enable_tenant_rls('finance.payment_batch_items');

-- Extratos e conciliação bancária (linha de extrato × movimentos N:N)
CREATE TABLE finance.bank_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  source text NOT NULL CHECK (source IN ('ofx', 'api', 'open_finance', 'csv', 'manual')),
  file_name text,
  period_start date,
  period_end date,
  closing_balance numeric(18,2),
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by uuid
);
SELECT core.enable_tenant_rls('finance.bank_statements');

CREATE TABLE finance.statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  statement_id uuid NOT NULL REFERENCES finance.bank_statements(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  line_date date NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount <> 0),
  description text NOT NULL,
  fitid text,
  pix_txid text,
  our_number text,
  counterpart_name text,
  counterpart_tax_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reconciled', 'ignored')),
  reconciliation_id uuid,
  UNIQUE (account_id, fitid)
);
CREATE INDEX ON finance.statement_lines (tenant_id, account_id, status, line_date);
SELECT core.enable_tenant_rls('finance.statement_lines');

CREATE TABLE finance.reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  method text NOT NULL CHECK (method IN ('manual', 'rule', 'txid', 'our_number', 'suggestion')),
  undone_at timestamptz,
  undone_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('finance.reconciliations');
SELECT core.enable_audit('finance.reconciliations');

CREATE TABLE finance.reconciliation_items (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  reconciliation_id uuid NOT NULL REFERENCES finance.reconciliations(id),
  statement_line_id uuid REFERENCES finance.statement_lines(id),
  account_movement_id uuid REFERENCES finance.account_movements(id),
  CHECK ((statement_line_id IS NULL) <> (account_movement_id IS NULL))
);
CREATE INDEX ON finance.reconciliation_items (reconciliation_id);
SELECT core.enable_tenant_rls('finance.reconciliation_items');

-- Regras salvas pelo usuário (ex.: "tarifa bancária" sempre na categoria X)
CREATE TABLE finance.reconciliation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  account_id uuid REFERENCES finance.accounts(id),
  description_pattern text NOT NULL,
  direction char(1) CHECK (direction IN ('C', 'D')),
  category_id uuid NOT NULL REFERENCES finance.categories(id),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  hits int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('finance.reconciliation_rules');

-- Orçamento anual por categoria e centro de custo
CREATE TABLE finance.budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  category_id uuid NOT NULL REFERENCES finance.categories(id),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  amount numeric(18,2) NOT NULL,
  UNIQUE NULLS NOT DISTINCT (company_id, year, month, category_id, cost_center_id)
);
SELECT core.enable_tenant_rls('finance.budgets');

-- Previsões manuais do fluxo de caixa projetado
CREATE TABLE finance.cash_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  forecast_date date NOT NULL,
  direction char(1) NOT NULL CHECK (direction IN ('C', 'D')),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  description text NOT NULL,
  category_id uuid REFERENCES finance.categories(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('finance.cash_forecasts');

-- Régua de cobrança (RN-FIN-09)
CREATE TABLE finance.collection_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  name text NOT NULL,
  -- [{"offsetDays": -3, "channels": ["email","whatsapp"], "template": "lembrete"}, {"offsetDays": 0, ...}, {"offsetDays": 3, ...}]
  steps jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('finance.collection_rules');

CREATE TABLE finance.collection_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  title_id uuid NOT NULL REFERENCES finance.titles(id),
  rule_id uuid REFERENCES finance.collection_rules(id),
  offset_days int NOT NULL,
  channel text NOT NULL,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'skipped')),
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (title_id, offset_days, channel)
);
SELECT core.enable_tenant_rls('finance.collection_actions');

SELECT core.enable_audit(t) FROM unnest(ARRAY['finance.charges', 'finance.payment_batch_items', 'finance.budgets', 'finance.collection_rules']::regclass[]) AS t;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA finance TO vortex_app;
GRANT DELETE ON finance.title_allocations, finance.payment_batch_items, finance.budgets, finance.cash_forecasts, finance.reconciliation_rules TO vortex_app;
