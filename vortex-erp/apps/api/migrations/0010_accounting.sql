-- =====================================================================
-- 0010 — Contabilidade (seção 14)
-- =====================================================================
CREATE TABLE accounting.journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid REFERENCES core.establishments(id),
  number bigint NOT NULL,
  entry_date date NOT NULL,
  description text NOT NULL,
  -- Evento de origem (RN-CTB-02): venda_faturada, recebimento, compra_recebida, pagamento, baixa_estoque, folha...
  event_type text NOT NULL,
  origin_type text,
  origin_id uuid,
  manual boolean NOT NULL DEFAULT false,
  reversal_of uuid REFERENCES accounting.journal_entries(id),
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, number)
);
CREATE INDEX ON accounting.journal_entries (tenant_id, company_id, entry_date);
CREATE INDEX ON accounting.journal_entries (tenant_id, origin_type, origin_id);
CREATE UNIQUE INDEX journal_idem_uq ON accounting.journal_entries (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
SELECT core.enable_tenant_rls('accounting.journal_entries');
SELECT core.enable_audit('accounting.journal_entries');
SELECT accounting.enable_period_lock('accounting.journal_entries', 'entry_date');
CREATE TRIGGER trg_journal_immutable BEFORE UPDATE OR DELETE ON accounting.journal_entries FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

CREATE TABLE accounting.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  entry_id uuid NOT NULL REFERENCES accounting.journal_entries(id),
  account_id uuid NOT NULL REFERENCES accounting.chart_of_accounts(id),
  debit numeric(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  cost_center_id uuid REFERENCES finance.cost_centers(id),
  party_id uuid REFERENCES registry.parties(id),
  history text NOT NULL,
  CHECK ((debit > 0) <> (credit > 0))
);
CREATE INDEX ON accounting.journal_lines (tenant_id, account_id);
CREATE INDEX ON accounting.journal_lines (entry_id);
SELECT core.enable_tenant_rls('accounting.journal_lines');
CREATE TRIGGER trg_journal_lines_immutable BEFORE UPDATE OR DELETE ON accounting.journal_lines FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

-- RN-CTB-01: partidas dobradas verificadas NO BANCO, no fim da transação.
CREATE OR REPLACE FUNCTION accounting.check_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d numeric;
  c numeric;
  n int;
BEGIN
  SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*) INTO d, c, n FROM accounting.journal_lines WHERE entry_id = NEW.entry_id;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'RN-CTB-01: lançamento desbalanceado (débitos % ≠ créditos %)', d, c USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_journal_balanced AFTER INSERT ON accounting.journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION accounting.check_balanced();

-- Lançamento manual só em conta marcada e analítica (RN-CTB-05)
CREATE OR REPLACE FUNCTION accounting.check_line_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acc record;
  is_manual boolean;
BEGIN
  SELECT is_analytic, accepts_manual, active, code INTO acc FROM accounting.chart_of_accounts WHERE id = NEW.account_id;
  IF NOT acc.is_analytic THEN
    RAISE EXCEPTION 'Conta % é sintética e não recebe lançamentos', acc.code USING ERRCODE = 'P0001';
  END IF;
  SELECT manual INTO is_manual FROM accounting.journal_entries WHERE id = NEW.entry_id;
  IF is_manual AND NOT acc.accepts_manual THEN
    RAISE EXCEPTION 'RN-CTB-05: conta % não aceita lançamento manual', acc.code USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_journal_line_account BEFORE INSERT ON accounting.journal_lines FOR EACH ROW EXECUTE FUNCTION accounting.check_line_account();

-- RN-CTB-02: regras de contabilização por evento, parametrizáveis por tipo de operação, filial e categoria
CREATE TABLE accounting.posting_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  event_type text NOT NULL,
  operation_type_code text,
  establishment_id uuid REFERENCES core.establishments(id),
  category_id uuid REFERENCES finance.categories(id),
  -- [{"side":"D","account":"1.1.2.01","amount":["invoice_total"],"history":"Venda NF {number}"}, ...]
  -- account pode ser código do plano ou "@chave" resolvida pelo contexto (ex.: @settlement_account)
  lines jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE NULLS NOT DISTINCT (tenant_id, event_type, operation_type_code, establishment_id, category_id)
);
SELECT core.enable_tenant_rls('accounting.posting_rules');
SELECT core.enable_audit('accounting.posting_rules');

-- Contas que faltavam no plano padrão para IPI e ST
-- (tenants novos recebem pela rotina de implantação; esta migration completa os existentes)
INSERT INTO accounting.chart_of_accounts (tenant_id, code, name, parent_id, nature, balance_side, is_analytic, accepts_manual, referential_code)
SELECT t.id, x.code, x.name, (SELECT id FROM accounting.chart_of_accounts p WHERE p.tenant_id = t.id AND p.code = '2.1.2'), 'liability', 'C', true, false, x.ref
  FROM core.tenants t CROSS JOIN (VALUES ('2.1.2.06', 'IPI a recolher', '2.01.02.01.06'), ('2.1.2.07', 'ICMS-ST a recolher', '2.01.02.01.07')) AS x(code, name, ref)
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT ON accounting.journal_entries, accounting.journal_lines TO vortex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON accounting.posting_rules TO vortex_app;
