-- =====================================================================
-- 0015 — Integração com o PDV VORTEX (seção 21): vendas com NFC-e e movimentos de caixa
-- =====================================================================

-- Venda recebida do PDV: idempotente por terminal + identificador da venda no PDV
CREATE TABLE integration.pdv_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  pdv_id text NOT NULL,
  sale_id text NOT NULL,
  document_id uuid NOT NULL REFERENCES fiscal.documents(id),
  total numeric(18,2) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, establishment_id, pdv_id, sale_id)
);
SELECT core.enable_tenant_rls('integration.pdv_sales');

-- Suprimento, sangria e fechamento de caixa do PDV
CREATE TABLE integration.pdv_cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  pdv_id text NOT NULL,
  reference text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('supply', 'withdrawal', 'closing')),
  amount numeric(18,2) NOT NULL DEFAULT 0,
  expected numeric(18,2),
  counted numeric(18,2),
  difference numeric(18,2),
  cash_account_id uuid NOT NULL REFERENCES finance.accounts(id),
  counterpart_account_id uuid REFERENCES finance.accounts(id),
  transfer_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, establishment_id, pdv_id, reference)
);
SELECT core.enable_tenant_rls('integration.pdv_cash_movements');

GRANT SELECT, INSERT, UPDATE ON integration.pdv_sales, integration.pdv_cash_movements TO vortex_app;
