import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { createPdv } from './application/pdv.js';
import { buildServer } from './http/server.js';
import { finishUpdate } from './application/system.js';

/**
 * Agente do terminal: API local para a frente de caixa (127.0.0.1), sincronização com o ERP,
 * heartbeat, backup do banco local e, em produção, a própria interface (apps/pdv-web/dist).
 */
const config = loadConfig();
const pdv = createPdv(config);
const app = await buildServer(pdv);
const update = finishUpdate(pdv.db, config.appVersion);

const ui = process.env.PDV_UI_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'pdv-web', 'dist');
if (existsSync(join(ui, 'index.html'))) {
  await app.register(fastifyStatic, { root: ui, prefix: '/' });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.status(404).send({ code: 'NOT_FOUND', message: 'Rota inexistente' }) : reply.sendFile('index.html')));
}

pdv.sync.start(config.sync.intervalMs);
const timers = [
  setInterval(() => void pdv.sync.heartbeat().catch(() => undefined), config.sync.heartbeatMs),
  setInterval(() => { try { pdv.system.backup(); } catch { /* banco em memória */ } }, 3_600_000),
];

await app.listen({ port: config.port, host: config.host });
app.log.info(`Vortex PDV ${config.appVersion} — terminal ${config.terminalCode} em http://${config.host}:${config.port}`);
if (update) app.log[update.applied ? 'info' : 'warn'](`Atualização para ${update.requested} ${update.applied ? 'aplicada' : 'não aplicada: o agente subiu com a versão ' + config.appVersion}`);

const shutdown = async () => {
  for (const t of timers) clearInterval(t);
  await app.close();
  pdv.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
