-- =====================================================================
-- 0001 — Núcleo: organização, acesso, auditoria, integração (seção 04/22/23)
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS integration;

GRANT USAGE ON SCHEMA core, integration TO vortex_app, vortex_worker;

-- ---------------------------------------------------------------------
-- Contexto da sessão (definido com SET LOCAL a cada transação da API)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION core.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION core.current_company() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------
-- RN-ORG-01: helper que liga RLS por tenant em qualquer tabela de negócio.
-- FORCE garante que nem o dono da tabela escape da política.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant())',
    tbl);
END $$;

-- updated_at / updated_by / version (concorrência otimista)
CREATE OR REPLACE FUNCTION core.touch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := core.current_user_id();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION core.enable_touch(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_touch ON %s', tbl);
  EXECUTE format('CREATE TRIGGER trg_touch BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.touch()', tbl);
END $$;

-- Bloqueio genérico de alteração (documentos imutáveis, logs)
CREATE OR REPLACE FUNCTION core.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registro imutável em %: % não permitido', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001', HINT = 'IMMUTABLE';
END $$;

-- ---------------------------------------------------------------------
-- Organização: tenant → grupo econômico → empresa → estabelecimento → depósito
-- ---------------------------------------------------------------------
CREATE TABLE core.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid GENERATED ALWAYS AS (id) STORED,
  name text NOT NULL,
  slug citext NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'start',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
  -- RN-ORG-02: compartilhamento por tipo de cadastro: {"parties":"shared","products":"shared"}
  settings jsonb NOT NULL DEFAULT '{"sharing":{"parties":"shared","products":"shared"}}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
SELECT core.enable_tenant_rls('core.tenants');
SELECT core.enable_touch('core.tenants');

CREATE TABLE core.economic_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('core.economic_groups');

CREATE TABLE core.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  economic_group_id uuid REFERENCES core.economic_groups(id),
  -- Raiz do CNPJ (8 posições, pode ser alfanumérica — RN-CAD-01)
  cnpj_root varchar(8) NOT NULL CHECK (cnpj_root ~ '^[0-9A-Z]{8}$'),
  legal_name text NOT NULL,
  trade_name text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, cnpj_root)
);
SELECT core.enable_tenant_rls('core.companies');
SELECT core.enable_touch('core.companies');

CREATE TABLE core.establishments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  code text NOT NULL,
  -- CNPJ completo como TEXTO de 14 posições (nunca número)
  cnpj varchar(14) NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  legal_name text NOT NULL,
  trade_name text,
  ie text,
  im text,
  cnae text,
  uf char(2) NOT NULL,
  city_ibge char(7) NOT NULL,
  city_name text NOT NULL,
  street text NOT NULL,
  number text NOT NULL,
  complement text,
  district text NOT NULL,
  zip char(8) NOT NULL,
  phone text,
  email text,
  -- Ambiente SEFAZ: 1 produção, 2 homologação
  sefaz_environment smallint NOT NULL DEFAULT 2 CHECK (sefaz_environment IN (1, 2)),
  certificate_secret_id uuid,
  certificate_expires_at timestamptz,
  nfce_csc_id text,
  nfce_csc_secret_id uuid,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, cnpj),
  UNIQUE (tenant_id, company_id, code)
);
SELECT core.enable_tenant_rls('core.establishments');
SELECT core.enable_touch('core.establishments');

-- RN-ORG-03: regime tributário pertence ao estabelecimento e tem vigência
CREATE TABLE core.establishment_tax_regimes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  regime text NOT NULL CHECK (regime IN ('simples_nacional', 'simples_excesso_sublimite', 'mei', 'lucro_presumido', 'lucro_real')),
  valid_from date NOT NULL,
  valid_to date,
  -- Receita bruta 12 meses e alíquota efetiva do Simples (crédito de ICMS informado)
  simples_annex text,
  simples_credit_rate numeric(9,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  EXCLUDE USING gist (establishment_id WITH =, daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') WITH &&)
);
SELECT core.enable_tenant_rls('core.establishment_tax_regimes');

-- Séries e numeração fiscal (RN-NFE-01): sequencial por estabelecimento, modelo e série
CREATE TABLE core.fiscal_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  model varchar(2) NOT NULL CHECK (model IN ('55', '65', '57', '58', '99')),
  series int NOT NULL CHECK (series BETWEEN 0 AND 999),
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number BETWEEN 1 AND 1000000000),
  environment smallint NOT NULL DEFAULT 2,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (establishment_id, model, series, environment)
);
SELECT core.enable_tenant_rls('core.fiscal_series');
SELECT core.enable_touch('core.fiscal_series');

CREATE TABLE core.warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'own' CHECK (kind IN ('own', 'store', 'central', 'in_transit', 'consigned', 'damaged', 'third_party')),
  allow_negative boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (establishment_id, code)
);
SELECT core.enable_tenant_rls('core.warehouses');
SELECT core.enable_touch('core.warehouses');

-- ---------------------------------------------------------------------
-- Acesso: usuários, papéis, permissões, escopo, alçadas
-- ---------------------------------------------------------------------
CREATE TABLE core.permissions (
  code text PRIMARY KEY CHECK (code ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$'),
  description text NOT NULL
);

CREATE TABLE core.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  email citext NOT NULL,
  name text NOT NULL,
  password_hash text,
  mfa_secret_id uuid,
  mfa_enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'inactive')),
  -- Escopo: vendedor vê só a própria carteira
  own_portfolio_only boolean NOT NULL DEFAULT false,
  party_id uuid,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, email)
);
SELECT core.enable_tenant_rls('core.users');
SELECT core.enable_touch('core.users');

CREATE TABLE core.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  -- MFA obrigatório para administradores e financeiro
  requires_mfa boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);
SELECT core.enable_tenant_rls('core.roles');

CREATE TABLE core.role_permissions (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  role_id uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  permission text NOT NULL REFERENCES core.permissions(code),
  PRIMARY KEY (role_id, permission)
);
SELECT core.enable_tenant_rls('core.role_permissions');

CREATE TABLE core.user_roles (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
SELECT core.enable_tenant_rls('core.user_roles');

-- Escopo: sem linhas = acesso a todos os estabelecimentos/depósitos do tenant
CREATE TABLE core.user_establishments (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  establishment_id uuid NOT NULL REFERENCES core.establishments(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, establishment_id)
);
SELECT core.enable_tenant_rls('core.user_establishments');

CREATE TABLE core.user_warehouses (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  warehouse_id uuid NOT NULL REFERENCES core.warehouses(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, warehouse_id)
);
SELECT core.enable_tenant_rls('core.user_warehouses');

-- Alçadas: limite por papel e ação (ex.: vendas.desconto até 5% para vendedor)
CREATE TABLE core.approval_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  role_id uuid NOT NULL REFERENCES core.roles(id) ON DELETE CASCADE,
  action text NOT NULL,
  max_percent numeric(9,4),
  max_value numeric(18,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (role_id, action)
);
SELECT core.enable_tenant_rls('core.approval_limits');

-- Políticas de aprovação múltipla (ex.: compras acima de R$ 10 mil exigem 2 aprovações)
CREATE TABLE core.approval_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  action text NOT NULL,
  min_value numeric(18,2) NOT NULL DEFAULT 0,
  required_approvals int NOT NULL DEFAULT 1 CHECK (required_approvals >= 1),
  approver_permission text NOT NULL REFERENCES core.permissions(code),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, action, min_value)
);
SELECT core.enable_tenant_rls('core.approval_policies');

CREATE TABLE core.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid REFERENCES core.companies(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL,
  value numeric(18,2),
  required_approvals int NOT NULL DEFAULT 1,
  approver_permission text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON core.approval_requests (tenant_id, entity_type, entity_id);
CREATE INDEX ON core.approval_requests (tenant_id, status);
SELECT core.enable_tenant_rls('core.approval_requests');

CREATE TABLE core.approval_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  request_id uuid NOT NULL REFERENCES core.approval_requests(id),
  user_id uuid NOT NULL REFERENCES core.users(id),
  decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, user_id)
);
SELECT core.enable_tenant_rls('core.approval_votes');

CREATE TABLE core.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  company_id uuid REFERENCES core.companies(id),
  rate_limit_per_minute int NOT NULL DEFAULT 600,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('core.api_keys');

-- ---------------------------------------------------------------------
-- RN-ORG-04: cofre de segredos (certificado A1, segredo MFA, CSC, tokens)
-- Conteúdo cifrado na aplicação com AES-256-GCM (chave mestra/KMS fora do banco).
-- ---------------------------------------------------------------------
CREATE TABLE core.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  kind text NOT NULL CHECK (kind IN ('certificate_a1', 'certificate_password', 'mfa_totp', 'nfce_csc', 'integration_token', 'bank_credentials')),
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version int NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('core.secrets');

-- Contadores de numeração interna (pedidos, orçamentos...) por empresa
CREATE TABLE core.counters (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  key text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, company_id, key)
);
SELECT core.enable_tenant_rls('core.counters');

CREATE OR REPLACE FUNCTION core.next_counter(p_company uuid, p_key text) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO core.counters (tenant_id, company_id, key, value)
  VALUES (core.current_tenant(), p_company, p_key, 1)
  ON CONFLICT (tenant_id, company_id, key) DO UPDATE SET value = core.counters.value + 1
  RETURNING value INTO v;
  RETURN v;
END $$;

-- ---------------------------------------------------------------------
-- RN-GER-05: auditoria completa, somente inserção, particionada por mês
-- ---------------------------------------------------------------------
CREATE TABLE core.audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  user_id uuid,
  ip inet,
  device text,
  request_id text,
  table_name text NOT NULL,
  record_id uuid,
  operation text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE', 'ACTION')),
  action text,
  reason text,
  sensitive boolean NOT NULL DEFAULT false,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE core.audit_log_default PARTITION OF core.audit_log DEFAULT;
CREATE INDEX ON core.audit_log (tenant_id, table_name, record_id);
CREATE INDEX ON core.audit_log (tenant_id, created_at DESC);
SELECT core.enable_tenant_rls('core.audit_log');

-- Bloqueia UPDATE/DELETE no log (inclusive para o dono)
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON core.audit_log
  FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

CREATE OR REPLACE FUNCTION core.audit_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_tenant uuid;
  v_company uuid;
  v_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN v_new := to_jsonb(NEW); END IF;
  -- Remove campos sensíveis do log
  v_old := v_old - 'password_hash' - 'ciphertext' - 'key_hash';
  v_new := v_new - 'password_hash' - 'ciphertext' - 'key_hash';
  IF TG_OP = 'UPDATE' AND v_old - 'updated_at' - 'version' - 'updated_by' = v_new - 'updated_at' - 'version' - 'updated_by' THEN
    RETURN NULL;
  END IF;
  v_tenant := coalesce((coalesce(v_new, v_old) ->> 'tenant_id')::uuid, core.current_tenant());
  v_company := coalesce(nullif(coalesce(v_new, v_old) ->> 'company_id', '')::uuid, core.current_company());
  v_id := nullif(coalesce(v_new, v_old) ->> 'id', '')::uuid;
  INSERT INTO core.audit_log (tenant_id, company_id, user_id, ip, device, request_id, table_name, record_id, operation, reason, sensitive, old_data, new_data)
  VALUES (
    v_tenant, v_company, core.current_user_id(),
    nullif(current_setting('app.ip', true), '')::inet,
    nullif(current_setting('app.device', true), ''),
    nullif(current_setting('app.request_id', true), ''),
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_id, TG_OP,
    nullif(current_setting('app.reason', true), ''),
    coalesce(nullif(current_setting('app.sensitive', true), ''), 'false')::boolean,
    v_old, v_new);
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION core.enable_audit(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_audit ON %s', tbl);
  EXECUTE format('CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.audit_trigger()', tbl);
END $$;

SELECT core.enable_audit(t) FROM unnest(ARRAY[
  'core.tenants', 'core.companies', 'core.establishments', 'core.establishment_tax_regimes', 'core.fiscal_series',
  'core.warehouses', 'core.users', 'core.roles', 'core.role_permissions', 'core.user_roles', 'core.user_establishments',
  'core.approval_limits', 'core.approval_policies', 'core.approval_requests', 'core.approval_votes', 'core.api_keys', 'core.secrets'
]::regclass[]) AS t;

-- Cria partições mensais do log de auditoria à frente (job agendado chama esta função)
CREATE OR REPLACE FUNCTION core.ensure_monthly_partitions(parent regclass, months_ahead int DEFAULT 3) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', now())::date;
  i int;
  part text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    part := format('%s_%s', parent::text, to_char(m + (i || ' month')::interval, 'YYYYMM'));
    IF to_regclass(part) IS NULL THEN
      -- Linhas já gravadas na partição default para este mês impedem a criação; nesse caso, ignora.
      BEGIN
        EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
          part, parent, m + (i || ' month')::interval, m + ((i + 1) || ' month')::interval);
      EXCEPTION WHEN check_violation THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Integração: outbox, webhooks, idempotência, logs, fila de jobs (seção 23)
-- ---------------------------------------------------------------------
CREATE TABLE integration.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX outbox_pending_idx ON integration.outbox_events (occurred_at) WHERE published_at IS NULL;
CREATE INDEX ON integration.outbox_events (tenant_id, event_type, occurred_at DESC);
SELECT core.enable_tenant_rls('integration.outbox_events');

CREATE TABLE integration.webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  url text NOT NULL CHECK (url ~ '^https?://'),
  events text[] NOT NULL,
  secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
SELECT core.enable_tenant_rls('integration.webhooks');

CREATE TABLE integration.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  webhook_id uuid NOT NULL REFERENCES integration.webhooks(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES integration.outbox_events(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status int,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX ON integration.webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'failed');
SELECT core.enable_tenant_rls('integration.webhook_deliveries');

-- RN-GER-07: chave de idempotência com resposta gravada
CREATE TABLE integration.idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  key text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  request_hash text NOT NULL,
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
SELECT core.enable_tenant_rls('integration.idempotency_keys');

CREATE TABLE integration.integration_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  system text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  operation text NOT NULL,
  reference_id uuid,
  request jsonb,
  response jsonb,
  status text NOT NULL,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON integration.integration_logs (tenant_id, system, created_at DESC);
SELECT core.enable_tenant_rls('integration.integration_logs');

-- Fila de jobs no próprio Postgres (FOR UPDATE SKIP LOCKED)
CREATE TABLE integration.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES core.tenants(id),
  queue text NOT NULL DEFAULT 'default',
  name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready_idx ON integration.jobs (queue, run_at) WHERE status IN ('queued', 'failed');
CREATE UNIQUE INDEX jobs_dedupe_idx ON integration.jobs (tenant_id, name, dedupe_key) NULLS NOT DISTINCT WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running', 'failed');
ALTER TABLE integration.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.jobs FORCE ROW LEVEL SECURITY;
-- Jobs de sistema (tenant_id nulo) só são visíveis ao worker (BYPASSRLS)
CREATE POLICY tenant_isolation ON integration.jobs USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());

CREATE TABLE integration.job_schedules (
  name text PRIMARY KEY,
  interval_seconds int NOT NULL,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------
-- Permissões de acesso aos objetos
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO vortex_app;
GRANT SELECT ON core.permissions TO vortex_app;
REVOKE INSERT, UPDATE, DELETE ON core.permissions FROM vortex_app;
-- Log de auditoria: só inserção e leitura
REVOKE UPDATE, DELETE ON core.audit_log FROM vortex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA integration TO vortex_app;
REVOKE ALL ON integration.job_schedules FROM vortex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA integration TO vortex_worker;
GRANT SELECT ON core.tenants TO vortex_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO vortex_app, vortex_worker;
-- Partições não podem ser acessadas diretamente (a política RLS fica no pai)
REVOKE ALL ON core.audit_log_default FROM vortex_app;

-- ---------------------------------------------------------------------
-- Funções de bootstrap (SECURITY DEFINER): únicas portas para descobrir o
-- tenant antes de existir contexto. Devolvem o mínimo necessário.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.resolve_tenant_by_slug(p_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT id FROM core.tenants WHERE slug = p_slug::public.citext AND status = 'active'
$$;

CREATE OR REPLACE FUNCTION core.resolve_api_key(p_prefix text)
RETURNS TABLE (id uuid, tenant_id uuid, key_hash text, scopes text[], company_id uuid, revoked_at timestamptz, rate_limit_per_minute int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  SELECT k.id, k.tenant_id, k.key_hash, k.scopes, k.company_id, k.revoked_at, k.rate_limit_per_minute
  FROM core.api_keys k JOIN core.tenants t ON t.id = k.tenant_id AND t.status = 'active'
  WHERE k.prefix = p_prefix
$$;
REVOKE ALL ON FUNCTION core.resolve_tenant_by_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_tenant_by_slug(text) TO vortex_app;
GRANT EXECUTE ON FUNCTION core.resolve_api_key(text) TO vortex_app;
