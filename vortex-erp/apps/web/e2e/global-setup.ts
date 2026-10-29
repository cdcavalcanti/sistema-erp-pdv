import { execSync } from 'node:child_process';

/** Tenant "e2e" com usuários, produtos, clientes e notas (idempotente; sem o histórico de 90 dias, para ser rápido). */
export default function globalSetup() {
  execSync('pnpm --filter @vortex/api db:seed', { stdio: 'inherit', env: { ...process.env, SEED_TENANT: 'e2e', SEED_HISTORY: '0' } });
}
