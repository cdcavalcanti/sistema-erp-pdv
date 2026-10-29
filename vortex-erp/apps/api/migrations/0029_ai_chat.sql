-- =====================================================================
-- 0029 — Chat com a assistente: conversas por usuário e mensagens
-- (a IA só lê; o que ela propõe continua virando rascunho — RN-IA-01)
-- =====================================================================
CREATE TABLE ai.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid REFERENCES core.companies(id),
  user_id uuid NOT NULL REFERENCES core.users(id),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai.conversations (tenant_id, user_id, updated_at DESC);
SELECT core.enable_tenant_rls('ai.conversations');

CREATE TABLE ai.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  conversation_id uuid NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  -- Resposta da assistente: de onde veio (modelo ou regras) e quais consultas fez
  source text CHECK (source IN ('ai', 'rules')),
  tool_calls jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai.messages (tenant_id, conversation_id, created_at);
SELECT core.enable_tenant_rls('ai.messages');

GRANT SELECT, INSERT, UPDATE, DELETE ON ai.conversations, ai.messages TO vortex_app;
SELECT core.ensure_tenant_fks();
