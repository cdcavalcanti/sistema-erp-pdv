import { defineConfig, devices } from '@playwright/test';
import { ERP_DIR } from './e2e/erp-dir.mjs';

/**
 * Ponta a ponta da frente de caixa contra o agente e o ERP reais (gateways simulados de
 * homologação). Sobe o ERP do projeto vortex-erp (ERP_DIR ou ../vortex-erp; reaproveita se já
 * estiver no ar em :3333), o agente do terminal e a interface.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5175', trace: 'retain-on-failure', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
  projects: [
    { name: 'caixa', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 800 } }, grepInvert: /@tablet/ },
    { name: 'tablet', use: { ...devices['Galaxy Tab S4'] }, grep: /@tablet/ },
  ],
  webServer: [
    { command: 'pnpm --filter @vortex/api exec tsx --env-file-if-exists=../../.env src/server.ts', cwd: ERP_DIR, url: 'http://localhost:3333/health', reuseExistingServer: true, timeout: 60_000 },
    { command: 'node e2e/start-agent.mjs', url: 'http://127.0.0.1:4546/api/health', reuseExistingServer: false, timeout: 120_000 },
    { command: 'pnpm exec vite --port 5175 --strictPort', url: 'http://localhost:5175', reuseExistingServer: false, timeout: 60_000, env: { VITE_AGENT: 'http://127.0.0.1:4546' } },
  ],
});
