/** Minúsculas e sem acento, para busca por nome, descrição e referência. */
export function normalize(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** CPF/CNPJ mascarado para exibição e comprovante (LGPD). */
export function maskTaxId(taxId: string): string {
  const d = taxId.replace(/\D/g, '');
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.***/****-${d.slice(12)}`;
  return '***';
}
