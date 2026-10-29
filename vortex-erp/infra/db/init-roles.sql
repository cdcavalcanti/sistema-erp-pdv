-- Executado UMA vez por superusuário ao provisionar o cluster.
-- vortex_owner : dono do schema, roda migrations.
-- vortex_app   : usado pela API; sujeito a RLS (nunca BYPASSRLS).
-- vortex_worker: workers de fila/outbox; BYPASSRLS apenas para varrer filas entre tenants.
--                Ao executar regra de negócio de um tenant, o worker usa vortex_app + contexto do tenant.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vortex_owner') THEN
    CREATE ROLE vortex_owner LOGIN PASSWORD 'vortex_owner' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vortex_app') THEN
    CREATE ROLE vortex_app LOGIN PASSWORD 'vortex_app' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vortex_worker') THEN
    CREATE ROLE vortex_worker LOGIN PASSWORD 'vortex_worker' BYPASSRLS;
  END IF;
END $$;
-- O dono do schema precisa enxergar todos os tenants para migrations e para as
-- poucas funções SECURITY DEFINER de bootstrap (resolver tenant pelo slug / chave de API).
ALTER ROLE vortex_owner BYPASSRLS;
