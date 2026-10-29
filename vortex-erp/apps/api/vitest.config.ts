import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Os testes de integração compartilham um banco de teste: rodam em série.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['./test/global-setup.ts'],
  },
});
