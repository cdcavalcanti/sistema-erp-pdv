import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Em desenvolvimento a API roda em :3333; o proxy evita CORS e mantém URLs relativas (/v1/...)
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': process.env.VITE_API_PROXY ?? 'http://localhost:3333', '/health': process.env.VITE_API_PROXY ?? 'http://localhost:3333' } },
  preview: { port: 4173, proxy: { '/v1': process.env.VITE_API_PROXY ?? 'http://localhost:3333' } },
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
});
