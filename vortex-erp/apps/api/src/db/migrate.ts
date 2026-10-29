import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
// src/db -> ../../migrations; dist/src/db -> ../../../migrations
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? [join(here, '..', '..', 'migrations'), join(here, '..', '..', '..', 'migrations')].find((d) => existsSync(d))!;

export async function runMigrations(ownerUrl: string, log: (m: string) => void = console.log): Promise<string[]> {
  const dir = MIGRATIONS_DIR;
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Evita duas instâncias migrando ao mesmo tempo.
    await client.query(`SELECT pg_advisory_lock(727272)`);
    const done = new Map((await client.query<{ version: string; checksum: string }>(`SELECT version, checksum FROM public.schema_migrations`)).rows.map((r) => [r.version, r.checksum]));
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`Migration ${file} foi alterada depois de aplicada (checksum diferente). Crie uma nova migration.`);
        continue;
      }
      log(`→ aplicando ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)`, [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`);
      }
    }
    await client.query(`SELECT pg_advisory_unlock(727272)`);
  } finally {
    await client.end();
  }
  return applied;
}
