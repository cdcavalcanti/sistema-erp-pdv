import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Row = Record<string, unknown>;
type Params = SQLInputValue[] | Record<string, SQLInputValue>;

/**
 * Banco local do terminal (seção 30 da especificação do PDV). SQLite embutido no Node,
 * em WAL com sincronização completa: uma venda gravada sobrevive a queda de energia.
 */
export class LocalDb {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`);
  }

  run(sql: string, params: Params = []): { changes: number } {
    const r = Array.isArray(params) ? this.raw.prepare(sql).run(...params) : this.raw.prepare(sql).run(params);
    return { changes: Number(r.changes) };
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    return (Array.isArray(params) ? this.raw.prepare(sql).get(...params) : this.raw.prepare(sql).get(params)) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    return (Array.isArray(params) ? this.raw.prepare(sql).all(...params) : this.raw.prepare(sql).all(params)) as T[];
  }

  /** Transação (aninhável por savepoint). Tudo ou nada: a venda nunca fica pela metade. */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error('Transação do banco local deve ser síncrona');
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  // ---------------------------------------------------------------- chave-valor (parâmetros, cursores)
  meta<T = unknown>(key: string): T | null {
    const r = this.get<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key]);
    return r ? (JSON.parse(r.value) as T) : null;
  }

  setMeta(key: string, value: unknown): void {
    this.run(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(value)]);
  }

  /** Contador persistente (sequência da venda no dia, número da NFC-e). */
  next(counter: string): number {
    return this.tx(() => {
      this.run(`INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET value = value + 1`, [counter]);
      return Number(this.get<{ value: number }>(`SELECT value FROM counters WHERE name = ?`, [counter])!.value);
    });
  }

  /** Garante que o contador já esteja pelo menos em `value` (nunca volta). */
  bumpCounter(counter: string, value: number): void {
    this.run(`INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = max(value, excluded.value)`, [counter, value]);
  }

  close(): void {
    this.raw.close();
  }
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Migrations versionadas, aplicadas uma vez e em ordem. */
export function migrate(db: LocalDb, dir = MIGRATIONS): string[] {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const done = new Set(db.all<{ name: string }>(`SELECT name FROM schema_migrations`).map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    db.tx(() => {
      db.raw.exec(readFileSync(join(dir, f), 'utf8'));
      db.run(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`, [f, new Date().toISOString()]);
    });
    applied.push(f);
  }
  return applied;
}

export function openDb(path: string): LocalDb {
  const db = new LocalDb(path);
  migrate(db);
  return db;
}
