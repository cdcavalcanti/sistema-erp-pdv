/** Etapas do pedido de venda na ordem do fluxo (a etapa vem calculada da API). */
export const STAGES = [
  { key: 'open', label: 'Pedido criado', short: 'Criado', hint: 'Aguardando envio para aprovação' },
  { key: 'pending_approval', label: 'Em aprovação', short: 'Em aprovação', hint: 'Bloqueio de crédito, margem ou desconto' },
  { key: 'approved', label: 'Aprovado', short: 'Aprovado', hint: 'Estoque reservado; pronto para separar' },
  { key: 'to_pick', label: 'Enviado para separação', short: 'P/ separar', hint: 'Lista de separação gerada' },
  { key: 'picking', label: 'Em separação', short: 'Separando', hint: 'Separador trabalhando no pedido' },
  { key: 'checked', label: 'Separado e conferido', short: 'Conferido', hint: 'Pronto para faturar' },
  { key: 'invoiced', label: 'Faturado (NF-e)', short: 'Faturado', hint: 'Nota emitida; pronto para despachar' },
  { key: 'shipped', label: 'Despachado', short: 'Despachado', hint: 'Em transporte' },
  { key: 'delivered', label: 'Entregue', short: 'Entregue', hint: 'Recebido pelo cliente' },
  { key: 'cancelled', label: 'Cancelado', short: 'Cancelado', hint: '' },
] as const;
export type Stage = (typeof STAGES)[number]['key'];
export const stageLabel = (s: string) => STAGES.find((x) => x.key === s)?.label ?? s;
export const stageTone = (s: string) => (s === 'cancelled' ? 'bad' : s === 'delivered' ? 'ok' : s === 'pending_approval' ? 'warn' : ['open', 'approved'].includes(s) ? 'info' : '');
