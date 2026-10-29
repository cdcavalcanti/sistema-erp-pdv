const brlFmt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "1234.5" → "1.234,50" (sem símbolo; a tela mostra R$ onde precisa) */
export function brl(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '0,00';
  return brlFmt.format(Number(v));
}

/** Quantidade: inteiros sem casas; pesáveis com até 3 casas */
export function qty(v: string | number): string {
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

/** Entrada do operador ("10,50", "10.5") → "10.50" para a API */
export function parseMoney(input: string): string {
  return input.trim().replace(/\./g, '').replace(',', '.') || '0';
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
