import { defineConfig, devices } from '@playwright/test';

/**
 * Ponta a ponta contra a API real (Postgres + gateways simulados). Sobe a API e o Vite se não
 * estiverem rodando; o global-setup cria o tenant "e2e" com dados de demonstração.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 860 } }, grepInvert: /@celular/ },
    { name: 'celular', use: { ...devices['Pixel 7'] }, grep: /@celular/ },
  ],
  webServer: [
    { command: 'pnpm --filter @vortex/api exec tsx --env-file-if-exists=../../.env src/server.ts', url: 'http://localhost:3333/health', reuseExistingServer: true, timeout: 60_000 },
    { command: 'pnpm exec vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
  ],
});
