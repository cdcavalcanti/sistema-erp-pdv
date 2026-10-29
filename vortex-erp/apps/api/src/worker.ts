import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { Vault } from './core/vault.js';
import { createServices } from './services.js';
import { drain, tickScheduler } from './worker/runner.js';
import './worker/jobs.js';

const config = loadConfig();
const deps = {
  config,
  appPool: createPool(config.databaseUrl, 10),
  workerPool: createPool(config.workerDatabaseUrl, 5),
  vault: new Vault(config.secretsMasterKey),
  services: createServices(config),
};

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));

console.log('[worker] iniciado');
while (!stopping) {
  try {
    await tickScheduler(deps);
    const n = await drain(deps, { max: 200 });
    if (n === 0) await new Promise((r) => setTimeout(r, 1000));
  } catch (err) {
    console.error('[worker] erro no ciclo', err);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
await deps.appPool.end();
await deps.workerPool.end();
console.log('[worker] encerrado');
