import pg from 'pg';
import { ERP_DB, useErpDb } from './erp-db.js';
import { erpModule } from './erp-dir.js';

/** Cria (uma vez) o banco do ERP para o aceite e aplica as migrations do ERP (projeto vortex-erp) do zero. */
export default async function setup() {
  const boot = new pg.Client({ connectionString: ERP_DB.bootstrap });
  await boot.connect();
  const exists = await boot.query(`SELECT 1 FROM pg_database WHERE datname = 'vortex_erp_pdv_test'`);
  if (!exists.rowCount) await boot.query(`CREATE DATABASE vortex_erp_pdv_test OWNER vortex_owner`);
  await boot.end();
  useErpDb();
  const erpSetup = (await import(erpModule('apps/api/test/global-setup.js'))).default;
  await erpSetup();
}
