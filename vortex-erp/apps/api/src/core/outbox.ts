import type { Tx } from '../db/tx.js';

/**
 * Catálogo inicial de eventos (seção 23). O evento é gravado na MESMA transação
 * do fato de negócio (padrão outbox, RN-GER-08) e publicado depois pelo worker.
 */
export const EVENT_TYPES = [
  'pedido.criado', 'pedido.aprovado', 'pedido.cancelado', 'pedido.faturado', 'pedido.despachado', 'pedido.entregue',
  'nota.autorizada', 'nota.rejeitada', 'nota.cancelada', 'nota.denegada', 'nota.entrada.recebida',
  'estoque.abaixo_minimo', 'estoque.lote_vencendo',
  'titulo.criado', 'titulo.vencendo', 'titulo.vencido', 'titulo.pago',
  'cliente.criado', 'cliente.bloqueado',
  'certificado.vencendo', 'fiscal.contingencia', 'fornecedor.conta_bancaria_alterada',
  'produto.alterado', 'preco.alterado', 'compra.recebida', 'compra.pedido_aprovado', 'compra.divergencia', 'cartao.divergencia', 'orcamento.excedido', 'contrato.faturado', 'contrato.cancelado', 'contrato.renovado', 'contrato.falha_faturamento',
  'ia.consumo', 'ia.anomalia',
  // Vortex PDV (especificação do PDV, seção 34): o terminal atualiza o cache local ao receber
  'cliente.alterado', 'promocao.alterada', 'estoque.alterado', 'pdv.configuracao_alterada', 'pdv.operador_alterado',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export async function emit(
  tx: Tx,
  type: EventType,
  aggregate: { type: string; id: string | null },
  payload: Record<string, unknown>,
): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `INSERT INTO integration.outbox_events (tenant_id, company_id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tx.tenantId, tx.ctx.companyId, type, aggregate.type, aggregate.id, JSON.stringify(payload)],
  );
  return row.id;
}
