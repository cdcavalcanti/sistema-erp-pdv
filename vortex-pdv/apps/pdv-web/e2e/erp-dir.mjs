// Projeto do ERP (vortex-erp) usado pelo ponta a ponta: ERP_DIR ou a pasta vizinha de vortex-pdv.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PDV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ERP_DIR = resolve(process.env.ERP_DIR ?? join(PDV_ROOT, '..', 'vortex-erp'));
