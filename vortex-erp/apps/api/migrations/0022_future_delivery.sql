-- =====================================================================
-- 0022 — RN-VEN-05: venda para entrega futura (faturamento e remessas vinculadas)
-- =====================================================================
ALTER TABLE sales.order_items ADD COLUMN quantity_shipped numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity_shipped >= 0);

-- RN-REF-06: previsão para o split payment (parcela de IBS/CBS retida pelo meio de pagamento)
ALTER TABLE finance.titles ADD COLUMN split_tax_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK (split_tax_amount >= 0);
ALTER TABLE finance.settlements ADD COLUMN split_tax numeric(18,2) NOT NULL DEFAULT 0 CHECK (split_tax >= 0);
-- A baixa com split debita o tributo recolhido na fonte (a compensar com o IBS/CBS devido)
UPDATE accounting.posting_rules
   SET lines = lines || '[{"side":"D","account":"1.1.4.03","amount":["split_tax"],"history":"IBS/CBS recolhidos no split payment {number}"}]'::jsonb
 WHERE event_type = 'recebimento' AND lines::text NOT LIKE '%split_tax%';

-- RN-GER-01: o saldo de estoque só muda por movimento. A quantidade do saldo só aceita a variação
-- declarada pela gravação do movimento na mesma transação; edição direta é recusada pelo banco.
CREATE OR REPLACE FUNCTION inventory.guard_stock_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity <> 0 THEN
      RAISE EXCEPTION 'RN-GER-01: saldo de estoque nasce zerado e só muda por movimento' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.quantity IS DISTINCT FROM OLD.quantity THEN
    expected := current_setting('vortex.stock_delta', true);
    IF expected IS NULL OR expected <> concat(NEW.warehouse_id, '|', NEW.product_id, '|', coalesce(NEW.lot_id::text, ''), '|', (NEW.quantity - OLD.quantity)::numeric(18,4)) THEN
      RAISE EXCEPTION 'RN-GER-01: saldo de estoque só muda por movimento de estoque' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM set_config('vortex.stock_delta', '', true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_guard_stock_balance BEFORE INSERT OR UPDATE ON inventory.stock_balances FOR EACH ROW EXECUTE FUNCTION inventory.guard_stock_balance();
