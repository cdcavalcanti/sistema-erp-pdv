import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPdv } from '../application/pdv.js';

/**
 * Pareamento do terminal com o ERP: grava a chave do terminal (gerada no ERP em
 * POST /v1/pdv/terminals) cifrada no banco local e faz a carga completa.
 *
 *   pnpm --filter @vortex/pdv pair --key vx_... --store <id do estabelecimento>
 */
const { values } = parseArgs({ options: { key: { type: 'string' }, store: { type: 'string' } } });
if (!values.key || !values.store) {
  console.error('Uso: pair --key <chave do terminal> --store <id do estabelecimento no ERP>');
  process.exit(1);
}
const pdv = createPdv(loadConfig());
const r = await pdv.pair({ apiKey: values.key, establishmentId: values.store });
const products = pdv.db.get<{ n: number }>(`SELECT count(*) AS n FROM products`)!.n;
const operators = pdv.db.get<{ n: number }>(`SELECT count(*) AS n FROM operators`)!.n;
pdv.close();
if (!r.online) {
  console.error(`✗ Não foi possível falar com o ERP: ${r.errors.join('; ')}`);
  process.exit(1);
}
console.log(`✓ Terminal pareado: ${products} produtos e ${operators} operadores carregados`);
