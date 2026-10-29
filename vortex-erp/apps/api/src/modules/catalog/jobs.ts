import { registerSystemJob, registerTenantJob } from '../../worker/registry.js';
import { fanOut } from '../../worker/runner.js';
import { applyDuePriceChanges } from './pricing.js';

// RN-PRE-04: aplica alterações de preço agendadas
registerTenantJob('precos.aplicar_agendados', async (tx) => ({ applied: await applyDuePriceChanges(tx) }));
registerSystemJob('precos.aplicar_agendados', async (deps) => ({ tenants: await fanOut(deps, 'precos.aplicar_agendados', {}, `precos:${new Date().toISOString().slice(0, 16)}`) }));
