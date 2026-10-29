import { loadConfig } from '../config.js';
import { runMigrations } from './migrate.js';
import { syncPermissionCatalog } from '../core/permissions.js';

const cfg = loadConfig();
const applied = await runMigrations(cfg.databaseOwnerUrl);
await syncPermissionCatalog(cfg.databaseOwnerUrl);
console.log(applied.length ? `✓ ${applied.length} migration(s) aplicada(s)` : '✓ banco já atualizado');
