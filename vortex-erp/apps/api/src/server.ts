import { createApp } from './main.js';

const app = await createApp();
const port = app.deps.config.port;
await app.listen({ port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
