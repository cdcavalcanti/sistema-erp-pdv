import pg from 'pg';
import { loadConfig } from '../config.js';
import { runMigrations } from './migrate.js';
import { syncPermissionCatalog } from '../core/permissions.js';

/** Apaga e recria o schema do banco de desenvolvimento. Bloqueado em produção. */
const cfg = loadConfig();
if (cfg.env === 'production') throw new Error('db:reset é proibido em produção');
const c = new pg.Client({ connectionString: cfg.databaseOwnerUrl });
await c.connect();
const { rows } = await c.query<{ nspname: string }>(
  `SELECT nspname FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND nspname <> 'public'`);
for (const r of rows) await c.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
await c.query(`DROP TABLE IF EXISTS public.schema_migrations`);
await c.end();
await runMigrations(cfg.databaseOwnerUrl);
await syncPermissionCatalog(cfg.databaseOwnerUrl);
console.log('✓ banco recriado');
