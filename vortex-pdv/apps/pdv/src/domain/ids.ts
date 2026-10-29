import { randomUUID } from 'node:crypto';

export const uuid = (): string => randomUUID();

/** Dia local da loja (AAAAMMDD), usado no número da venda. */
export function storeDay(at: Date, timeZone = 'America/Sao_Paulo'): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get('year')}${get('month')}${get('day')}`;
}

/** Número da venda (seção 32): PDV-03-20261027-000124 — terminal, dia e sequência do dia. */
export function saleNumber(terminalCode: string, day: string, seq: number): string {
  return `PDV-${terminalCode}-${day}-${String(seq).padStart(6, '0')}`;
}
