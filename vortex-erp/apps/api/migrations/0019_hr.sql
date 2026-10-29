-- =====================================================================
-- 0019 — RH e integração com a folha (seção 18)
-- =====================================================================

-- Contas trabalhistas para tenants existentes (os novos já nascem com elas)
INSERT INTO accounting.chart_of_accounts (tenant_id, code, name, parent_id, nature, balance_side, is_analytic, accepts_manual, referential_code)
SELECT t.id, '2.1.5', 'Obrigações trabalhistas', (SELECT id FROM accounting.chart_of_accounts p WHERE p.tenant_id = t.id AND p.code = '2.1'), 'liability', 'C', false, false, '2.01.05'
  FROM core.tenants t ON CONFLICT DO NOTHING;
INSERT INTO accounting.chart_of_accounts (tenant_id, code, name, parent_id, nature, balance_side, is_analytic, accepts_manual, referential_code)
SELECT t.id, x.code, x.name, (SELECT id FROM accounting.chart_of_accounts p WHERE p.tenant_id = t.id AND p.code = '2.1.5'), 'liability', 'C', true, false, x.ref
  FROM core.tenants t CROSS JOIN (VALUES ('2.1.5.01', 'Salários a pagar', '2.01.05.01.01'), ('2.1.5.02', 'INSS a recolher', '2.01.05.01.02'),
    ('2.1.5.03', 'FGTS a recolher', '2.01.05.01.03'), ('2.1.5.04', 'IRRF sobre salários a recolher', '2.01.05.01.04')) AS x(code, name, ref)
ON CONFLICT DO NOTHING;
INSERT INTO accounting.chart_of_accounts (tenant_id, code, name, parent_id, nature, balance_side, is_analytic, accepts_manual, referential_code)
SELECT t.id, '4.5', 'Despesas com pessoal', (SELECT id FROM accounting.chart_of_accounts p WHERE p.tenant_id = t.id AND p.code = '4'), 'expense', 'D', true, false, '3.07.01.02.01'
  FROM core.tenants t ON CONFLICT DO NOTHING;

-- Conta contábil de controle do título (salários, INSS, FGTS...): a baixa debita essa conta
ALTER TABLE finance.titles ADD COLUMN ledger_account_id uuid REFERENCES accounting.chart_of_accounts(id);

CREATE SCHEMA IF NOT EXISTS hr;
GRANT USAGE ON SCHEMA hr TO vortex_app, vortex_worker;

CREATE TABLE hr.departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  code text NOT NULL,
  name text NOT NULL,
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  manager_employee_id uuid,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);
SELECT core.enable_tenant_rls('hr.departments');

CREATE TABLE hr.positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  cbo char(6),
  active boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('hr.positions');

-- Colaborador = papel "employee" da Pessoa + vínculo (cargo, departamento, centro de custo, usuário)
CREATE TABLE hr.employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  party_id uuid NOT NULL REFERENCES registry.parties(id),
  user_id uuid REFERENCES core.users(id),
  registration text NOT NULL,
  department_id uuid REFERENCES hr.departments(id),
  position_id uuid REFERENCES hr.positions(id),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  admission_date date NOT NULL,
  termination_date date,
  -- Salário é dado pessoal sensível ao negócio: só aparece com permissão de RH (LGPD: minimização)
  base_salary numeric(18,2),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_leave', 'terminated')),
  payroll_external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, registration),
  UNIQUE (company_id, party_id)
);
SELECT core.enable_tenant_rls('hr.employees');
SELECT core.enable_audit('hr.employees');
ALTER TABLE hr.departments ADD CONSTRAINT departments_manager_fk FOREIGN KEY (manager_employee_id) REFERENCES hr.employees(id);

-- Resumo da folha importado do sistema parceiro (um por competência)
CREATE TABLE hr.payroll_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  competence date NOT NULL CHECK (extract(day FROM competence) = 1),
  payment_date date NOT NULL,
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'csv', 'partner')),
  gross numeric(18,2) NOT NULL,
  net numeric(18,2) NOT NULL,
  inss_employee numeric(18,2) NOT NULL,
  inss_employer numeric(18,2) NOT NULL,
  fgts numeric(18,2) NOT NULL,
  irrf numeric(18,2) NOT NULL,
  other_deductions numeric(18,2) NOT NULL DEFAULT 0,
  title_ids uuid[] NOT NULL DEFAULT '{}',
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, competence)
);
SELECT core.enable_tenant_rls('hr.payroll_imports');
SELECT core.enable_audit('hr.payroll_imports');

CREATE TABLE hr.payroll_import_items (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  import_id uuid NOT NULL REFERENCES hr.payroll_imports(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES hr.employees(id),
  gross numeric(18,2) NOT NULL,
  inss_employee numeric(18,2) NOT NULL DEFAULT 0,
  irrf numeric(18,2) NOT NULL DEFAULT 0,
  other_deductions numeric(18,2) NOT NULL DEFAULT 0,
  net numeric(18,2) NOT NULL,
  title_id uuid,
  PRIMARY KEY (import_id, employee_id)
);
SELECT core.enable_tenant_rls('hr.payroll_import_items');

-- Reembolso de despesas: aprovação e pagamento direto ou pela folha
CREATE TABLE hr.expense_reimbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  employee_id uuid NOT NULL REFERENCES hr.employees(id),
  expense_date date NOT NULL,
  description text NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  category_id uuid NOT NULL REFERENCES finance.categories(id),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  receipt_key text,
  payment_mode text NOT NULL DEFAULT 'direct' CHECK (payment_mode IN ('direct', 'payroll')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid', 'exported')),
  title_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('hr.expense_reimbursements');
SELECT core.enable_audit('hr.expense_reimbursements');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hr TO vortex_app;
