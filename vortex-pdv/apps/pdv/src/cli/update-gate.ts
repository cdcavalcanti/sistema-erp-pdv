import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { LocalDb, migrate } from '../db/sqlite.js';
import { systemClock } from '../clock.js';
import { finishUpdate, requestUpdate, updateState } from '../application/system.js';

/**
 * Portão da atualização (seção 51), usado pelo instalador antes de trocar a versão:
 * pede a atualização e espera não haver venda, pagamento nem NFC-e em andamento. Daí em
 * diante o agente não deixa começar venda nova; o instalador para o serviço e troca a versão.
 *
 *   node dist/src/cli/update-gate.js --version 1.1.0 [--wait 600]
 * Sai com 0 quando é seguro atualizar e 2 se o tempo de espera acabar (nada é trocado).
 */
const { values } = parseArgs({ options: { version: { type: 'string' }, wait: { type: 'string', default: '600' } } });
if (!values.version) {
  console.error('Uso: update-gate --version <nova versão> [--wait <segundos>]');
  process.exit(1);
}
const db = new LocalDb(loadConfig().dbPath);
migrate(db);
let st = requestUpdate(db, systemClock, values.version);
const deadline = Date.now() + Number(values.wait) * 1000;
while (!st.safe && Date.now() < deadline) {
  console.log(`Aguardando: ${st.reason}`);
  await new Promise((r) => setTimeout(r, 5000));
  st = updateState(db);
}
// Sem janela segura: retira o pedido para o caixa não ficar travado
if (!st.safe) finishUpdate(db, '');
db.close();
if (!st.safe) {
  console.error(`✗ Não é seguro atualizar agora (${st.reason}). Nada foi trocado; tente de novo após a venda.`);
  process.exit(2);
}
console.log(`✓ Liberado para atualizar para ${values.version}: nenhuma venda nova começa até o reinício`);
