-- Cancelamento parcial de item (N unidades de uma linha): a parte cancelada vira uma linha
-- própria com status 'cancelled' apontando para a linha de origem.
ALTER TABLE sale_items ADD COLUMN cancelled_from_seq INTEGER;
ALTER TABLE sale_items ADD COLUMN cancelled_at TEXT;
