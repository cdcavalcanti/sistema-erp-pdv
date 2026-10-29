-- Envio que o ERP nunca vai aceitar (ex.: venda feita quando o terminal estava ligado a outra
-- loja/ERP): o gerente arquiva com motivo; sai da fila e dos alertas, fica no histórico.
ALTER TABLE sync_queue ADD COLUMN archived_at TEXT;
ALTER TABLE sync_queue ADD COLUMN archived_by TEXT;
ALTER TABLE sync_queue ADD COLUMN archived_reason TEXT;

-- Próxima carga é completa: inativa produtos que vieram de um ERP anterior (banco local antigo
-- ligado a um ERP recriado vendia o produto velho e o ERP recusava a venda)
DELETE FROM meta WHERE key = 'sync.cursor';
