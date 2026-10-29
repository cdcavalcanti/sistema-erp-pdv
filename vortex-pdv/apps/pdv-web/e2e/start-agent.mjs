// Sobe o agente do PDV para o teste ponta a ponta: tenant "pdv-e2e" no ERP (seed do projeto
// vortex-erp com terminal 03, operadores e chave nova gravada em e2e/.agent.env), banco local
// zerado, porta 4546. O ERP é procurado em ERP_DIR ou na pasta vizinha ../vortex-erp.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERP_DIR } from './erp-dir.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const envFile = join(here, '.agent.env');
if (!existsSync(join(ERP_DIR, 'apps', 'api'))) {
  console.error(`ERP não encontrado em ${ERP_DIR}. Extraia o vortex-erp ao lado do vortex-pdv ou defina ERP_DIR.`);
  process.exit(1);
}
const seed = spawnSync('pnpm', ['--filter', '@vortex/api', 'db:seed'], {
  cwd: ERP_DIR, stdio: 'inherit', env: { ...process.env, SEED_TENANT: 'pdv-e2e', SEED_PDV_ENV: envFile, SEED_HISTORY: '0' },
});
if (seed.status !== 0) process.exit(seed.status ?? 1);
const pdvDir = join(root, 'apps', 'pdv');
for (const f of ['e2e.sqlite', 'e2e.sqlite-wal', 'e2e.sqlite-shm']) rmSync(join(pdvDir, 'data', f), { force: true });
const agent = spawn('pnpm', ['exec', 'tsx', `--env-file=${envFile}`, 'src/main.ts'], {
  cwd: pdvDir, stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test', PDV_DB_PATH: './data/e2e.sqlite', PDV_PORT: '4546', PDV_SYNC_INTERVAL_MS: '2000', PDV_UI_ORIGIN: 'http://localhost:5175',
    PDV_PRINTER_SPOOL: './data/e2e-spool' },
});
const stop = () => agent.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
agent.on('exit', (code) => process.exit(code ?? 0));
