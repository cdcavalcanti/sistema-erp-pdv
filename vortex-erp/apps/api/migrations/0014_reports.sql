-- =====================================================================
-- 0014 — Relatórios (seção 19): filtros salvos, execução em fila, agendamento
--        + controle dos avisos de vencimento (eventos titulo.vencendo/vencido, lote vencendo)
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS reports;
GRANT USAGE ON SCHEMA reports TO vortex_app, vortex_worker;

-- RN-REL-01: filtros salvos (pessoais ou compartilhados com a empresa)
CREATE TABLE reports.saved_filters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  user_id uuid NOT NULL REFERENCES core.users(id),
  report_code text NOT NULL,
  name text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, report_code, name)
);
SELECT core.enable_tenant_rls('reports.saved_filters');

-- RN-REL-02: execução em fila; o arquivo fica no armazenamento e o usuário é avisado
CREATE TABLE reports.runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid REFERENCES core.companies(id),
  user_id uuid NOT NULL REFERENCES core.users(id),
  report_code text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  format text NOT NULL CHECK (format IN ('json', 'csv', 'xlsx', 'pdf')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  schedule_id uuid,
  row_count int,
  file_key text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reports.runs (tenant_id, user_id, created_at DESC);
SELECT core.enable_tenant_rls('reports.runs');

-- RN-REL-01: agendamento por e-mail/WhatsApp; roda com as permissões de quem agendou
CREATE TABLE reports.schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid REFERENCES core.companies(id),
  user_id uuid NOT NULL REFERENCES core.users(id),
  report_code text NOT NULL,
  name text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}',
  -- Datas relativas: período = "ontem", "mês atual", "mês anterior", "últimos 7 dias"…
  relative_period text CHECK (relative_period IN ('yesterday', 'last_7_days', 'current_month', 'previous_month')),
  format text NOT NULL DEFAULT 'xlsx' CHECK (format IN ('csv', 'xlsx', 'pdf')),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  -- hora local (America/Sao_Paulo) e dia da semana (0 = domingo) ou do mês
  hour smallint NOT NULL DEFAULT 7 CHECK (hour BETWEEN 0 AND 23),
  weekday smallint CHECK (weekday BETWEEN 0 AND 6),
  month_day smallint CHECK (month_day BETWEEN 1 AND 28),
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp')),
  recipients text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reports.schedules (next_run_at) WHERE active;
SELECT core.enable_tenant_rls('reports.schedules');

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA reports TO vortex_app;
GRANT SELECT, UPDATE ON reports.schedules TO vortex_worker;
GRANT SELECT, UPDATE ON reports.runs TO vortex_worker;

-- Eventos de ciclo do título (alimentam a régua de cobrança) e de lote vencendo: avisar uma vez só
ALTER TABLE finance.titles ADD COLUMN due_notified_at timestamptz, ADD COLUMN overdue_notified_at timestamptz;
ALTER TABLE inventory.lots ADD COLUMN expiry_notified_at timestamptz;

-- ---------------------------------------------------------------------
-- RN-CTB-04 (ajuste): em títulos e movimentos de conta, o fechamento bloqueia criar,
-- excluir ou mudar a data para/de um período fechado — mas não a baixa posterior de um
-- título cuja competência já fechou (a baixa em si é um registro novo, com a data dela).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.block_closed_period() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_company uuid;
  v_date date;
  v_old date;
  r jsonb;
  is_strict boolean := coalesce(TG_ARGV[1], 'strict') = 'strict';
BEGIN
  r := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  v_company := (r ->> 'company_id')::uuid;
  v_date := (r ->> TG_ARGV[0])::date;
  IF TG_OP = 'UPDATE' THEN
    v_old := (to_jsonb(OLD) ->> TG_ARGV[0])::date;
    IF NOT is_strict AND v_old IS NOT DISTINCT FROM v_date THEN
      RETURN NEW;
    END IF;
  END IF;
  IF v_company IS NOT NULL AND v_date IS NOT NULL AND accounting.is_period_closed(v_company, v_date) THEN
    RAISE EXCEPTION 'RN-CTB-04: período %/% está fechado; não é possível lançar, alterar ou estornar com esta data',
      extract(month FROM v_date), extract(year FROM v_date) USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND v_old IS NOT NULL AND accounting.is_period_closed(v_company, v_old) THEN
    RAISE EXCEPTION 'RN-CTB-04: registro pertence a período fechado' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS trg_period_lock ON finance.titles;
CREATE TRIGGER trg_period_lock BEFORE INSERT OR UPDATE OR DELETE ON finance.titles FOR EACH ROW EXECUTE FUNCTION accounting.block_closed_period('competence_date', 'operational');
DROP TRIGGER IF EXISTS trg_period_lock ON finance.account_movements;
CREATE TRIGGER trg_period_lock BEFORE INSERT OR UPDATE OR DELETE ON finance.account_movements FOR EACH ROW EXECUTE FUNCTION accounting.block_closed_period('movement_date', 'operational');
