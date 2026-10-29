-- =====================================================================
-- 0013 — Compras: frete rateado por item, devolução a fornecedor (RN-COM-05/07)
-- =====================================================================

-- Valor a pagar ao fornecedor pelo item (valor da nota + IBS/CBS "por fora" quando não informativos)
ALTER TABLE purchasing.receipt_items
  ADD COLUMN payable_amount numeric(18,2),
  ADD COLUMN pis_cst text,
  ADD COLUMN cest text,
  -- IBS/CBS creditados separadamente (livro de créditos por tributo)
  ADD COLUMN recoverable_pis numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN recoverable_ibs numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN recoverable_cbs numeric(18,2) NOT NULL DEFAULT 0,
  -- Parcela do CT-e de frete de compra (RN-COM-05) e o crédito de ICMS correspondente
  ADD COLUMN extra_freight numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN extra_freight_icms numeric(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN returned_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0);

ALTER TABLE purchasing.freight_documents
  ADD COLUMN title_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN cfop text;
CREATE UNIQUE INDEX freight_documents_key_uq ON purchasing.freight_documents (tenant_id, access_key) WHERE access_key IS NOT NULL;

-- Título a pagar à transportadora pelo CT-e de frete de compra
ALTER TABLE finance.titles DROP CONSTRAINT titles_origin_type_check;
ALTER TABLE finance.titles ADD CONSTRAINT titles_origin_type_check CHECK (origin_type IN ('sales_invoice', 'purchase_invoice', 'purchase_freight', 'contract', 'payroll',
  'tax', 'manual', 'advance', 'renegotiation', 'pdv', 'card', 'service_order', 'sale_return', 'purchase_return', 'commission', 'expense_reimbursement'));

-- Devolução a fornecedor (RN-COM-07)
CREATE TABLE purchasing.returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  number bigint NOT NULL,
  receipt_id uuid NOT NULL REFERENCES purchasing.receipts(id),
  supplier_id uuid NOT NULL REFERENCES registry.parties(id),
  document_id uuid REFERENCES fiscal.documents(id),
  reason text NOT NULL,
  -- abatimento no título a pagar ou crédito com o fornecedor
  financial_treatment text NOT NULL CHECK (financial_treatment IN ('abatement', 'supplier_credit')),
  total numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
SELECT core.enable_tenant_rls('purchasing.returns');
SELECT core.enable_audit('purchasing.returns');

GRANT SELECT, INSERT, UPDATE, DELETE ON purchasing.returns TO vortex_app;
GRANT SELECT, UPDATE ON fiscal.tax_credits TO vortex_worker;
