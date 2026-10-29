-- Observabilidade (seção 24): números agregados de todas as empresas para o /metrics.
-- SECURITY DEFINER porque atravessa tenants; devolve só contagens, nunca dados de cliente.
CREATE OR REPLACE FUNCTION core.metrics_snapshot()
RETURNS TABLE (metric text, labels jsonb, value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, integration, fiscal, pg_temp AS $$
  SELECT 'vortex_jobs', jsonb_build_object('queue', queue, 'status', status), count(*)::numeric
    FROM integration.jobs WHERE status IN ('queued', 'running', 'failed', 'dead') GROUP BY queue, status
  UNION ALL
  SELECT 'vortex_jobs_oldest_ready_seconds', jsonb_build_object('queue', queue), coalesce(extract(epoch FROM now() - min(run_at)), 0)::numeric
    FROM integration.jobs WHERE status IN ('queued', 'failed') AND run_at <= now() GROUP BY queue
  UNION ALL
  SELECT 'vortex_outbox_pending', '{}'::jsonb, count(*)::numeric FROM integration.outbox_events WHERE published_at IS NULL
  UNION ALL
  SELECT 'vortex_fiscal_documents_24h', jsonb_build_object('model', model, 'status', status), count(*)::numeric
    FROM fiscal.documents WHERE updated_at > now() - interval '24 hours' GROUP BY model, status
  UNION ALL
  SELECT 'vortex_webhook_deliveries_failed', '{}'::jsonb, count(*)::numeric
    FROM integration.webhook_deliveries WHERE status = 'failed'
  UNION ALL
  SELECT 'vortex_tenants_active', '{}'::jsonb, count(*)::numeric FROM core.tenants WHERE status = 'active'
$$;
REVOKE ALL ON FUNCTION core.metrics_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.metrics_snapshot() TO vortex_app;
