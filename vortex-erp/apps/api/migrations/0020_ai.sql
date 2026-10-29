-- =====================================================================
-- 0020 — IA dentro do ERP (seção 20): registro de uso, rascunhos e anomalias
-- =====================================================================
CREATE SCHEMA IF NOT EXISTS ai;
GRANT USAGE ON SCHEMA ai TO vortex_app, vortex_worker;

-- RN-IA-02: toda chamada registra tenant, usuário, custo e resultado (enviado ao VORTEX Meter)
CREATE TABLE ai.calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  user_id uuid,
  feature text NOT NULL,
  provider text NOT NULL,
  model text,
  status text NOT NULL CHECK (status IN ('ok', 'refused', 'error', 'unavailable')),
  stop_reason text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cache_read_tokens int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  duration_ms int,
  redactions int NOT NULL DEFAULT 0,
  result_summary text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai.calls (tenant_id, created_at DESC);
SELECT core.enable_tenant_rls('ai.calls');

-- RN-IA-01: ação de escrita da IA sempre vira rascunho que um humano confirma
CREATE TABLE ai.drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid REFERENCES core.companies(id),
  kind text NOT NULL CHECK (kind IN ('payable_title', 'ncm_classification', 'renegotiation', 'purchase_suggestion')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'discarded')),
  title text NOT NULL,
  payload jsonb NOT NULL,
  confidence numeric(5,2),
  source text NOT NULL CHECK (source IN ('ai', 'rules')),
  call_id uuid REFERENCES ai.calls(id),
  result_type text,
  result_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  decided_at timestamptz,
  decided_by uuid
);
CREATE INDEX ON ai.drafts (tenant_id, status, created_at DESC);
SELECT core.enable_tenant_rls('ai.drafts');
SELECT core.enable_audit('ai.drafts');

-- Detecção de anomalias (V2): cada achado aparece uma vez
CREATE TABLE ai.anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  key text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'resolved')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
SELECT core.enable_tenant_rls('ai.anomalies');

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ai TO vortex_app;
