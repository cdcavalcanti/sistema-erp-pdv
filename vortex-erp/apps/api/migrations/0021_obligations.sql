-- =====================================================================
-- 0021 — Obrigações V1 (seção 15): serviços tomados com retenções (EFD-Reinf),
-- EFD-Contribuições e apoio ao PGDAS-D/DEFIS
-- =====================================================================

-- Contas de retenções para tenants existentes (os novos já nascem com elas)
INSERT INTO accounting.chart_of_accounts (tenant_id, code, name, parent_id, nature, balance_side, is_analytic, accepts_manual, referential_code)
SELECT t.id, x.code, x.name, (SELECT id FROM accounting.chart_of_accounts p WHERE p.tenant_id = t.id AND p.code = x.parent), x.nature, x.side, true, false, x.ref
  FROM core.tenants t CROSS JOIN (VALUES
    ('1.1.4.04', 'Tributos retidos por clientes a compensar', '1.1.4', 'asset', 'D', '1.01.04.01.04'),
    ('2.1.2.08', 'IRRF e contribuições retidos a recolher', '2.1.2', 'liability', 'C', '2.01.02.01.08'),
    ('2.1.2.09', 'INSS retido a recolher', '2.1.2', 'liability', 'C', '2.01.02.01.09')) AS x(code, name, parent, nature, side, ref)
ON CONFLICT DO NOTHING;

ALTER TABLE finance.titles DROP CONSTRAINT titles_origin_type_check;
ALTER TABLE finance.titles ADD CONSTRAINT titles_origin_type_check CHECK (origin_type IN ('sales_invoice', 'purchase_invoice', 'purchase_freight', 'contract', 'payroll',
  'tax', 'manual', 'advance', 'renegotiation', 'pdv', 'card', 'service_order', 'sale_return', 'purchase_return', 'commission', 'expense_reimbursement', 'service_invoice'));

-- Serviço tomado (NFS-e de terceiro): base das retenções na fonte e dos eventos R-2010/R-4010/R-4020
CREATE TABLE purchasing.service_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  supplier_id uuid NOT NULL REFERENCES registry.parties(id),
  number text NOT NULL,
  series text,
  nfse_key varchar(50),
  issue_date date NOT NULL,
  -- Item da lista da LC 116 e, para o INSS (R-2010), o tipo de serviço da tabela 06 da Reinf
  service_code text NOT NULL,
  reinf_service_type char(9),
  -- Natureza do rendimento (tabela 01 da Reinf, série R-4000), ex.: 17001 serviços profissionais
  income_nature char(5),
  description text,
  gross_amount numeric(18,2) NOT NULL CHECK (gross_amount > 0),
  -- Materiais/equipamentos destacados reduzem a base do INSS (cessão de mão de obra)
  inss_deductions numeric(18,2) NOT NULL DEFAULT 0,
  labor_assignment boolean NOT NULL DEFAULT false,
  irrf numeric(18,2) NOT NULL DEFAULT 0,
  csll numeric(18,2) NOT NULL DEFAULT 0,
  pis numeric(18,2) NOT NULL DEFAULT 0,
  cofins numeric(18,2) NOT NULL DEFAULT 0,
  inss numeric(18,2) NOT NULL DEFAULT 0,
  iss numeric(18,2) NOT NULL DEFAULT 0,
  net_amount numeric(18,2) NOT NULL,
  due_date date NOT NULL,
  category_id uuid REFERENCES finance.categories(id),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  title_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, supplier_id, number, series)
);
SELECT core.enable_tenant_rls('purchasing.service_invoices');
SELECT core.enable_audit('purchasing.service_invoices');
CREATE TRIGGER trg_period_lock BEFORE INSERT OR UPDATE OR DELETE ON purchasing.service_invoices FOR EACH ROW EXECUTE FUNCTION accounting.block_closed_period('issue_date', 'operational');

GRANT SELECT, INSERT, UPDATE ON purchasing.service_invoices TO vortex_app;
