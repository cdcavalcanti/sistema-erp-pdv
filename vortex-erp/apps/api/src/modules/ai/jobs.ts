import { registerSystemJob, registerTenantJob } from '../../worker/registry.js';
import { fanOut } from '../../worker/runner.js';
import { detectAnomalies } from './anomalies.js';

// Detecção de anomalias (seção 20, V2): diária, por tenant
registerTenantJob('ia.anomalias', async (tx) => ({ found: (await detectAnomalies(tx)).length }));
registerSystemJob('ia.anomalias', async (deps) => ({ tenants: await fanOut(deps, 'ia.anomalias', {}, `ia-anomalias:${new Date().toISOString().slice(0, 10)}`) }));
