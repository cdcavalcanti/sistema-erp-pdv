import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Sem "globals" no Vitest a Testing Library não desmonta sozinha entre os testes
afterEach(() => {
  cleanup();
  try {
    sessionStorage.clear();
  } catch {
    /* sem armazenamento */
  }
});
