-- =====================================================================
-- 0028 — Fluxo completo do pedido: etapa calculada e data de cada etapa
-- Pedido → Aprovado → Enviado para separação → Em separação → Separado/conferido
--        → Faturado (NF-e) → Despachado → Entregue   (ou Cancelado)
-- =====================================================================
ALTER TABLE sales.orders ADD COLUMN approved_at timestamptz;
ALTER TABLE sales.orders ADD COLUMN cancelled_at timestamptz;
ALTER TABLE sales.shipments ADD COLUMN picking_started_at timestamptz;
ALTER TABLE sales.shipments ADD COLUMN checked_at timestamptz;

-- Pedidos antigos: a melhor estimativa disponível
UPDATE sales.orders SET approved_at = created_at WHERE status IN ('approved', 'separating', 'partially_invoiced', 'invoiced') AND approved_at IS NULL;
UPDATE sales.orders SET cancelled_at = updated_at WHERE status = 'cancelled' AND cancelled_at IS NULL;

-- Etapa do pedido para a tela, a partir da situação do pedido e da última expedição
CREATE FUNCTION sales.order_stage(order_status text, shipment_status text, picking_started boolean) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN order_status = 'cancelled' THEN 'cancelled'
    WHEN shipment_status = 'delivered' THEN 'delivered'
    WHEN shipment_status = 'shipped' THEN 'shipped'
    WHEN order_status IN ('invoiced', 'partially_invoiced') THEN 'invoiced'
    WHEN shipment_status = 'checked' THEN 'checked'
    WHEN shipment_status = 'picking' AND picking_started THEN 'picking'
    WHEN shipment_status = 'picking' THEN 'to_pick'
    WHEN order_status IN ('approved', 'separating') THEN 'approved'
    WHEN order_status = 'pending_approval' THEN 'pending_approval'
    ELSE 'open'
  END
$$;
