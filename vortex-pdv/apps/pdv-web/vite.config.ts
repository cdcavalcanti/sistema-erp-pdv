import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em desenvolvimento o agente do terminal roda em 127.0.0.1:4545; em produção ele mesmo serve esta interface
const agent = process.env.VITE_AGENT ?? 'http://127.0.0.1:4545';
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { '/api': agent } },
  preview: { port: 4174, proxy: { '/api': agent } },
  build: { sourcemap: true },
});
