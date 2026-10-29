import { D } from '@vortex/money';
import { formatCNPJ, formatCPF } from '@vortex/validators';

/** Valores chegam da API como texto decimal (nunca float); a formatação também não passa por float. */
export function brl(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = D(String(v)).toDecimalPlaces(2);
  const [i, f] = n.abs().toFixed(2).split('.');
  return `${n.isNegative() ? '−' : ''}R$ ${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f}`;
}

export function num(v: string | number | null | undefined, decimals?: number): string {
  if (v === null || v === undefined || v === '') return '';
  const n = D(String(v));
  const fixed = decimals === undefined ? n.toString() : n.toFixed(decimals);
  const [i, f] = fixed.split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${f ? `,${f}` : ''}`;
}

/** Quantidade sem zeros à direita ("24,0000" → "24"). */
export function qty(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  return num(D(String(v)).toString());
}

export function pct(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === '' ? '' : `${num(v, 2)}%`;
}

export function date(v: string | Date | null | undefined): string {
  if (!v) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  // Data-hora vem em UTC: mostra no fuso de Brasília
  if (s.length > 10 && s.includes('T')) {
    const d = new Date(s);
    return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  }
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function dateTime(v: string | null | undefined): string {
  if (!v) return '';
  return new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

export function doc(taxId: string | null | undefined): string {
  if (!taxId) return '';
  return taxId.length === 11 ? formatCPF(taxId) : taxId.length === 14 ? formatCNPJ(taxId) : taxId;
}

export const today = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
export const monthStart = () => `${today().slice(0, 8)}01`;

export const STATUS_LABELS: Record<string, string> = {
  open: 'Aberto', pending_approval: 'Aguardando aprovação', approved: 'Aprovado', separating: 'Em separação', partially_invoiced: 'Faturado parcial', invoiced: 'Faturado',
  cancelled: 'Cancelado', paid: 'Pago', partially_paid: 'Pago parcial', renegotiated: 'Renegociado', written_off: 'Baixado como perda', autorizada: 'Autorizada',
  rejeitada: 'Rejeitada', cancelada: 'Cancelada', denegada: 'Denegada', pendente_envio: 'Pendente de envio', contingencia: 'Contingência', rascunho: 'Rascunho',
  draft: 'Rascunho', received: 'Recebido', completed: 'Concluído', checking: 'Em conferência', pending: 'Pendente', confirmed: 'Confirmado', discarded: 'Descartado',
  active: 'Ativo', blocked: 'Bloqueado', inactive: 'Inativo', in_progress: 'Em andamento', closed: 'Encerrado', resolved: 'Resolvida', dismissed: 'Descartada',
};
export const statusLabel = (s: string | null | undefined) => (s ? STATUS_LABELS[s] ?? s : '');
