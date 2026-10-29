-- =====================================================================
-- 0025 — Vortex PDV: operadores, terminais, parâmetros da loja, abertura e
-- reabertura de caixa, cancelamento e devolução de vendas do PDV
-- =====================================================================

-- Operador de caixa: login curto e PIN (hash scrypt). O PIN permite login offline no terminal.
ALTER TABLE core.users ADD COLUMN pdv_login text CHECK (pdv_login ~ '^[0-9A-Za-z]{2,12}$');
ALTER TABLE core.users ADD COLUMN pdv_pin_hash text;
ALTER TABLE core.users ADD COLUMN pdv_pin_updated_at timestamptz;
CREATE UNIQUE INDEX users_pdv_login_uq ON core.users (tenant_id, lower(pdv_login)) WHERE pdv_login IS NOT NULL;

-- Terminais (multiterminal e multiloja: loja = estabelecimento, terminal = código na loja)
CREATE TABLE integration.pdv_terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  code text NOT NULL CHECK (code ~ '^[0-9]{2,3}$'),
  name text NOT NULL,
  api_key_id uuid REFERENCES core.api_keys(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  -- Monitoramento (seção 50), atualizado pelo heartbeat do terminal
  app_version text,
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  pending_sales int NOT NULL DEFAULT 0,
  health jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, establishment_id, code)
);
SELECT core.enable_tenant_rls('integration.pdv_terminals');
SELECT core.enable_audit('integration.pdv_terminals');

-- Parâmetros do PDV por loja; o que o gerente pode alterar no terminal fica em "localOverridable"
CREATE TABLE integration.pdv_settings (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  establishment_id uuid PRIMARY KEY REFERENCES core.establishments(id),
  settings jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
SELECT core.enable_tenant_rls('integration.pdv_settings');
SELECT core.enable_audit('integration.pdv_settings');

-- Abertura (fundo de troco) e reabertura de caixa
ALTER TABLE integration.pdv_cash_movements DROP CONSTRAINT pdv_cash_movements_kind_check;
ALTER TABLE integration.pdv_cash_movements ADD CONSTRAINT pdv_cash_movements_kind_check CHECK (kind IN ('opening', 'supply', 'withdrawal', 'closing', 'reopening'));
ALTER TABLE integration.pdv_cash_movements ADD COLUMN session_id text;
ALTER TABLE integration.pdv_cash_movements ADD COLUMN operator_id uuid REFERENCES core.users(id);
ALTER TABLE integration.pdv_cash_movements ADD COLUMN authorized_by uuid REFERENCES core.users(id);
ALTER TABLE integration.pdv_cash_movements ADD COLUMN reason text;
ALTER TABLE integration.pdv_cash_movements ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE integration.pdv_cash_movements ADD COLUMN difference_movement_id uuid;

-- Venda do PDV: identificadores da especificação (seção 32) e situação
ALTER TABLE integration.pdv_sales ADD COLUMN sale_uuid uuid;
ALTER TABLE integration.pdv_sales ADD COLUMN session_id text;
ALTER TABLE integration.pdv_sales ADD COLUMN operator_id uuid REFERENCES core.users(id);
ALTER TABLE integration.pdv_sales ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled'));
ALTER TABLE integration.pdv_sales ADD COLUMN cancelled_at timestamptz;
ALTER TABLE integration.pdv_sales ADD COLUMN cancel_reason text;
CREATE UNIQUE INDEX pdv_sales_uuid_uq ON integration.pdv_sales (tenant_id, sale_uuid) WHERE sale_uuid IS NOT NULL;

-- Devoluções feitas no PDV (idempotentes pela referência do terminal)
CREATE TABLE integration.pdv_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  pdv_id text NOT NULL,
  reference text NOT NULL,
  pdv_sale_id uuid NOT NULL REFERENCES integration.pdv_sales(id),
  sales_return_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES fiscal.documents(id),
  total numeric(18,2) NOT NULL,
  refund_method text NOT NULL,
  authorized_by uuid REFERENCES core.users(id),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, establishment_id, pdv_id, reference)
);
SELECT core.enable_tenant_rls('integration.pdv_returns');


-- Mesmo critério da 0023, como função: toda migration que cria tabela de tenant com FK a chama.
CREATE OR REPLACE FUNCTION core.ensure_tenant_fks() RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  cname text;
  done int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT n.nspname AS nsp, t.relname AS rel, a.attname AS col, rn.nspname AS rnsp, rt.relname AS rrel
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class rt ON rt.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rt.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
      JOIN pg_attribute ra ON ra.attrelid = rt.oid AND ra.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1 AND ra.attname = 'id' AND a.attname <> 'tenant_id'
       AND NOT t.relispartition AND NOT rt.relispartition
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = t.oid AND x.attname = 'tenant_id' AND x.attnotnull)
       AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = rt.oid AND x.attname = 'tenant_id' AND x.attnotnull)
  LOOP
    BEGIN
      EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (tenant_id, id)', left(r.rrel || '_tenant_id_id_uq', 63), r.rnsp, r.rrel);
      cname := left(r.rel || '_' || r.col || '_tenant_fk', 63);
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = cname AND connamespace = r.nsp::regnamespace) THEN
        EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id, %I) REFERENCES %I.%I (tenant_id, id)', r.nsp, r.rel, cname, r.col, r.rnsp, r.rrel);
        done := done + 1;
      END IF;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'FK de tenant não criada para %.%(%): %', r.nsp, r.rel, r.col, SQLERRM;
    END;
  END LOOP;
  RETURN done;
END $$;

SELECT core.ensure_tenant_fks();

GRANT SELECT, INSERT, UPDATE ON integration.pdv_terminals, integration.pdv_settings, integration.pdv_returns TO vortex_app;
