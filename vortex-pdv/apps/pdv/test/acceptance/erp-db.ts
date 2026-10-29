/**
 * Banco do ERP usado no teste de aceite do PDV: separado do banco de teste do ERP para as duas
 * suítes poderem rodar em paralelo. Derivado das URLs de teste do ERP (mesmos usuários).
 */
const base = {
  owner: process.env.TEST_DATABASE_OWNER_URL ?? 'postgres://vortex_owner:vortex_owner@localhost:5432/vortex_erp_test',
  app: process.env.TEST_DATABASE_URL ?? 'postgres://vortex_app:vortex_app@localhost:5432/vortex_erp_test',
  worker: process.env.TEST_WORKER_DATABASE_URL ?? 'postgres://vortex_worker:vortex_worker@localhost:5432/vortex_erp_test',
};
const swap = (url: string) => url.replace(/\/[^/?]+(\?|$)/, '/vortex_erp_pdv_test$1');

export const ERP_DB = { owner: swap(base.owner), app: swap(base.app), worker: swap(base.worker), bootstrap: base.owner };

export function useErpDb() {
  process.env.NODE_ENV = 'test';
  process.env.TEST_DATABASE_OWNER_URL = ERP_DB.owner;
  process.env.TEST_DATABASE_URL = ERP_DB.app;
  process.env.TEST_WORKER_DATABASE_URL = ERP_DB.worker;
}
