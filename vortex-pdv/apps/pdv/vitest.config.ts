import { defineConfig } from 'vitest/config';
import { ERP_AVAILABLE, ERP_DIR } from './test/acceptance/erp-dir.js';

if (!ERP_AVAILABLE) console.warn(`[aceite] ERP não encontrado em ${ERP_DIR}: aceite do MVP contra o ERP real pulado (defina ERP_DIR ou ponha vortex-erp ao lado de vortex-pdv)`);

export default defineConfig({
  test: {
    // O teste de aceite sobe o ERP real num banco próprio: arquivos em série
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ERP_AVAILABLE ? ['./test/acceptance/global-setup.ts'] : [],
    exclude: ['**/node_modules/**', '**/dist/**', ...(ERP_AVAILABLE ? [] : ['test/acceptance/**'])],
  },
});
