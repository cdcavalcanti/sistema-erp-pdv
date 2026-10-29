-- =====================================================================
-- 0016 — Financeiro V1: conciliação inteligente, extrato da adquirente, régua e orçamento
-- =====================================================================

-- Conciliação que aprende com as escolhas do usuário: palavra do extrato → pessoa/categoria
CREATE TABLE finance.reconciliation_memory (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  token text NOT NULL,
  party_id uuid REFERENCES registry.parties(id),
  category_id uuid REFERENCES finance.categories(id),
  hits int NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, account_id, token, party_id, category_id)
);
SELECT core.enable_tenant_rls('finance.reconciliation_memory');

-- RN-FIN-08: o que a adquirente pagou × o previsto no título do cartão
CREATE TABLE finance.acquirer_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  account_id uuid NOT NULL REFERENCES finance.accounts(id),
  title_id uuid REFERENCES finance.titles(id),
  kind text NOT NULL CHECK (kind IN ('sale', 'chargeback', 'anticipation', 'adjustment')),
  sale_date date,
  payment_date date NOT NULL,
  nsu text,
  authorization_code text,
  gross numeric(18,2) NOT NULL,
  fee numeric(18,2) NOT NULL DEFAULT 0,
  net numeric(18,2) NOT NULL,
  expected_net numeric(18,2),
  divergence numeric(18,2),
  status text NOT NULL CHECK (status IN ('settled', 'divergent', 'unmatched')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, account_id, nsu, payment_date, kind)
);
SELECT core.enable_tenant_rls('finance.acquirer_settlements');

-- Orçado × realizado: alerta uma vez por mês e categoria
ALTER TABLE finance.budgets ADD COLUMN alerted_at timestamptz;

-- Régua: uma por empresa marcada como padrão
ALTER TABLE finance.collection_rules ADD COLUMN is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX collection_rules_default_uq ON finance.collection_rules (company_id) WHERE is_default AND active;

GRANT SELECT, INSERT, UPDATE, DELETE ON finance.reconciliation_memory TO vortex_app;
GRANT SELECT, INSERT, UPDATE ON finance.acquirer_settlements TO vortex_app;
