import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * O aceite do MVP roda o PDV contra o ERP real, que é outro projeto (vortex-erp). Ele é
 * procurado em ERP_DIR ou na pasta vizinha (../vortex-erp, ao lado de vortex-pdv) e precisa
 * de `pnpm install` e dos pacotes compilados lá. Sem o ERP, o aceite é pulado.
 */
const PDV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const ERP_DIR = resolve(process.env.ERP_DIR ?? join(PDV_ROOT, '..', 'vortex-erp'));
export const ERP_AVAILABLE = existsSync(join(ERP_DIR, 'apps', 'api', 'test', 'helpers.ts'));

/** URL de um módulo do ERP para import() (ex.: erpModule('apps/api/src/db/tx.js')). */
export const erpModule = (path: string) => pathToFileURL(join(ERP_DIR, path)).href;
