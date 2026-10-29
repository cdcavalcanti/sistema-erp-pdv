import { registerSystemJob, registerTenantJob } from '../../worker/registry.js';
import { fanOut } from '../../worker/runner.js';
import { runRecurringBilling } from './service.js';

// Faturamento recorrente (seção 16): job diário gera títulos, NFS-e/NF-e e cobranças do dia
registerTenantJob('contratos.faturar', async (tx, _p, deps) => runRecurringBilling(tx, deps.services));
registerSystemJob('contratos.faturar', async (deps) => ({ tenants: await fanOut(deps, 'contratos.faturar', {}, `fat:${new Date().toISOString().slice(0, 10)}`) }));
