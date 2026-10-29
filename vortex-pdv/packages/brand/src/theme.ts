import { useCallback, useEffect, useState } from 'react';

/**
 * Tema claro/escuro. A preferência fica no navegador ("system" segue o sistema operacional)
 * e vira `data-theme` no <html>, que os tokens de cor de cada aplicação leem.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'vx.theme';
const ORDER: ThemePreference[] = ['system', 'light', 'dark'];

export const THEME_LABEL: Record<ThemePreference, string> = { system: 'Tema do sistema', light: 'Tema claro', dark: 'Tema escuro' };

export function nextPreference(p: ThemePreference): ThemePreference {
  return ORDER[(ORDER.indexOf(p) + 1) % ORDER.length]!;
}

export function resolveTheme(p: ThemePreference, systemDark: boolean): Theme {
  return p === 'system' ? (systemDark ? 'dark' : 'light') : p;
}

export function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Aplica no <html>: `data-theme` só quando há escolha explícita; sem ela o CSS segue o sistema. */
export function applyPreference(p: ThemePreference): void {
  const root = document.documentElement;
  if (p === 'system') delete root.dataset.theme;
  else root.dataset.theme = p;
  try {
    if (p === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, p);
  } catch {
    /* sem armazenamento: vale só nesta aba */
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = resolveTheme(p, systemDark()) === 'dark' ? '#0a0a0c' : '#f4f2ed';
}

/** Preferência atual, tema efetivo e a troca cíclica sistema → claro → escuro. */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);
  const [dark, setDark] = useState(systemDark);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => applyPreference(preference), [preference, dark]);
  const cycle = useCallback(() => setPreference((p) => nextPreference(p)), []);
  return { preference, theme: resolveTheme(preference, dark), setPreference, cycle };
}
