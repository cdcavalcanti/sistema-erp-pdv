import { describe, expect, it } from 'vitest';
import { nextPreference, readPreference, resolveTheme } from '../src/theme.js';

describe('tema claro/escuro', () => {
  it('alterna sistema → claro → escuro → sistema', () => {
    expect(nextPreference('system')).toBe('light');
    expect(nextPreference('light')).toBe('dark');
    expect(nextPreference('dark')).toBe('system');
  });

  it('"sistema" segue o sistema operacional; escolha explícita prevalece', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('sem armazenamento local (navegação privada, testes) cai em "sistema"', () => {
    expect(readPreference()).toBe('system');
  });
});
