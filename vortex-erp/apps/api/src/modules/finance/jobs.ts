import { registerSystemJob, registerTenantJob } from '../../worker/registry.js';
import { fanOut } from '../../worker/runner.js';
import { budgetAlerts, runCollection } from './collection.js';

// RN-FIN-09: régua de cobrança diária
registerTenantJob('financeiro.regua', async (tx, _p, deps) => runCollection(tx, deps.services));
registerSystemJob('financeiro.regua', async (deps) => ({ tenants: await fanOut(deps, 'financeiro.regua', {}, `regua:${new Date().toISOString().slice(0, 10)}`) }));

// Orçado × realizado (seção 13)
registerTenantJob('financeiro.orcamento', async (tx) => budgetAlerts(tx));
registerSystemJob('financeiro.orcamento', async (deps) => ({ tenants: await fanOut(deps, 'financeiro.orcamento', {}, `orc:${new Date().toISOString().slice(0, 10)}`) }));
