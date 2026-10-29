-- =====================================================================
-- 0026 — Vortex PDV: trilha de auditoria dos terminais (especificação do PDV, seção 39)
-- Imutável e idempotente pelo id do evento gerado no terminal.
-- =====================================================================
CREATE TABLE integration.pdv_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  terminal_id uuid NOT NULL REFERENCES integration.pdv_terminals(id),
  user_id uuid,
  action text NOT NULL,
  entity text,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON integration.pdv_events (tenant_id, establishment_id, occurred_at);
CREATE INDEX ON integration.pdv_events (tenant_id, action, occurred_at);
SELECT core.enable_tenant_rls('integration.pdv_events');
CREATE TRIGGER trg_pdv_events_immutable BEFORE UPDATE OR DELETE ON integration.pdv_events FOR EACH ROW EXECUTE FUNCTION core.forbid_change();
SELECT core.ensure_tenant_fks();
GRANT SELECT, INSERT ON integration.pdv_events TO vortex_app;
