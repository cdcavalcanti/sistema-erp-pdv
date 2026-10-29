import { useEffect, useRef } from 'react';

/**
 * Atalhos de teclado (seção 41): F2 Cliente, F3 Desconto, F4 Cancelar item, F5 Consultar
 * produto, F6 Quantidade, F7 Sangria, F8 Suprimento, F9 Finalizar, F10 Cancelar venda,
 * F11 Reimprimir, F12 Menu, ESC Voltar. As teclas F do navegador são bloqueadas no PDV.
 */
export type HotkeyMap = Partial<Record<'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12' | 'Escape', () => void>>;

export function useHotkeys(map: HotkeyMap, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const h = ref.current[e.key as keyof HotkeyMap];
      if (/^F\d+$/.test(e.key)) e.preventDefault();
      if (h) {
        e.preventDefault();
        h();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export const SHORTCUTS: [string, string][] = [
  ['F2', 'Cliente'], ['F3', 'Desconto'], ['F4', 'Cancelar item'], ['F5', 'Consultar'], ['F6', 'Quantidade'], ['F7', 'Sangria'],
  ['F8', 'Suprimento'], ['F9', 'Finalizar'], ['F10', 'Cancelar venda'], ['F11', 'Reimprimir'], ['F12', 'Menu'], ['ESC', 'Voltar'],
];
