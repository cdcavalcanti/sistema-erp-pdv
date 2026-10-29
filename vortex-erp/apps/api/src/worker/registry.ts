import type { Tx } from '../db/tx.js';
import type { Pool } from '../db/pool.js';
import type { Config } from '../config.js';
import type { Vault } from '../core/vault.js';
import type { Services } from '../services.js';

export interface WorkerDeps {
  config: Config;
  appPool: Pool;
  workerPool: Pool;
  vault: Vault;
  services: Services;
}

export interface JobRow {
  id: string;
  tenant_id: string | null;
  name: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** Handler de job de tenant: roda em transação com o contexto (RLS) do tenant do job. */
export type TenantJobHandler = (tx: Tx, payload: any, deps: WorkerDeps, job: JobRow) => Promise<unknown>;
/** Handler de job de sistema (sem tenant): varre filas, agenda, faz fan-out por tenant. */
export type SystemJobHandler = (deps: WorkerDeps, payload: any, job: JobRow) => Promise<unknown>;
/** Assinante interno do outbox (módulos VORTEX internos ao ERP). */
export type EventSubscriber = (tx: Tx, event: { id: string; event_type: string; payload: any; aggregate_id: string | null }, deps: WorkerDeps) => Promise<void>;

export const tenantJobs = new Map<string, TenantJobHandler>();
export const systemJobs = new Map<string, SystemJobHandler>();
export const subscribers = new Map<string, EventSubscriber[]>();

export function registerTenantJob(name: string, h: TenantJobHandler): void {
  tenantJobs.set(name, h);
}
export function registerSystemJob(name: string, h: SystemJobHandler): void {
  systemJobs.set(name, h);
}
export function subscribe(eventType: string, h: EventSubscriber): void {
  subscribers.set(eventType, [...(subscribers.get(eventType) ?? []), h]);
}

/**
 * Jobs agendados (seção 23). O intervalo é em segundos; cada execução de um job de
 * sistema pode fazer fan-out para todos os tenants ativos.
 */
export const SCHEDULES: { name: string; intervalSeconds: number }[] = [
  { name: 'outbox.dispatch', intervalSeconds: 5 },
  { name: 'webhooks.deliver', intervalSeconds: 10 },
  { name: 'partitions.ensure', intervalSeconds: 86_400 },
  { name: 'jobs.recover_stale', intervalSeconds: 300 },
  { name: 'cleanup.idempotency', intervalSeconds: 86_400 },
  { name: 'tabelas_oficiais.atualizar', intervalSeconds: 7 * 86_400 },
  { name: 'precos.aplicar_agendados', intervalSeconds: 300 },
  { name: 'estoque.expirar_reservas', intervalSeconds: 3600 },
  { name: 'dfe.distribuicao', intervalSeconds: 3600 },
  { name: 'fiscal.alertas', intervalSeconds: 86_400 },
  { name: 'relatorios.agendados', intervalSeconds: 300 },
  { name: 'financeiro.vencimentos', intervalSeconds: 86_400 },
  { name: 'estoque.lotes_vencendo', intervalSeconds: 86_400 },
  { name: 'financeiro.regua', intervalSeconds: 86_400 },
  { name: 'financeiro.orcamento', intervalSeconds: 86_400 },
  { name: 'contratos.faturar', intervalSeconds: 86_400 },
  { name: 'ia.anomalias', intervalSeconds: 86_400 },
];
