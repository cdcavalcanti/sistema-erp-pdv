import { loadConfig, type Config } from './config.js';
import { createPool } from './db/pool.js';
import { buildApp, type App } from './http/app.js';
import { Vault } from './core/vault.js';
import { createServices, type Services } from './services.js';
import { registerModules } from './modules/index.js';

export async function createApp(opts: { config?: Partial<Config>; services?: Partial<Services> } = {}): Promise<App> {
  const config = loadConfig(opts.config);
  const pool = createPool(config.databaseUrl, 20);
  const app = await buildApp({ config, pool, vault: new Vault(config.secretsMasterKey), services: createServices(config, opts.services) }, registerModules);
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return app;
}
