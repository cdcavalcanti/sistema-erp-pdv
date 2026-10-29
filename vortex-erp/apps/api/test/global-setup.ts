import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { syncPermissionCatalog } from '../src/core/permissions.js';

/** Recria o banco de teste do zero e aplica todas as migrations. */
export default async function setup() {
  process.env.NODE_ENV = 'test';
  const cfg = loadConfig();
  const client = new pg.Client({ connectionString: cfg.databaseOwnerUrl });
  await client.connect();
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND nspname <> 'public'`);
  for (const r of rows) await client.query(`DROP SCHEMA "${r.nspname}" CASCADE`);
  await client.query(`DROP TABLE IF EXISTS public.schema_migrations`);
  await client.end();
  await runMigrations(cfg.databaseOwnerUrl, () => undefined);
  await syncPermissionCatalog(cfg.databaseOwnerUrl);
}
