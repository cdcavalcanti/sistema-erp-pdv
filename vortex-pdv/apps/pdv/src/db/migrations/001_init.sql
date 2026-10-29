-- =====================================================================
-- Vortex PDV — banco local do terminal (especificação do PDV, seção 30)
-- Valores monetários e quantidades em TEXT decimal (nunca ponto flutuante).
-- Datas em ISO 8601 UTC.
-- =====================================================================

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- ------------------------------------------------------------------ cache do ERP (somente leitura no PDV)
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  short_description TEXT,
  gtin TEXT,
  manufacturer_code TEXT,
  ncm TEXT,
  kind TEXT NOT NULL,
  sale_unit TEXT NOT NULL,
  stock_unit TEXT NOT NULL,
  controls_stock INTEGER NOT NULL DEFAULT 1,
  allow_negative_stock INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  category_id TEXT,
  -- Texto normalizado (minúsculo, sem acento) para busca por nome/descrição/referência
  search TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX products_sku ON products (sku);
CREATE INDEX products_ref ON products (manufacturer_code);

-- Códigos de barras: GTIN do produto e das embalagens (fator de conversão)
CREATE TABLE barcodes (
  code TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  unit TEXT NOT NULL,
  factor TEXT NOT NULL DEFAULT '1'
);

CREATE TABLE price_lists (
  id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, is_default INTEGER NOT NULL, valid_from TEXT, valid_to TEXT, active INTEGER NOT NULL
);
CREATE TABLE prices (
  price_list_id TEXT NOT NULL, product_id TEXT NOT NULL, min_qty TEXT NOT NULL, price TEXT NOT NULL,
  PRIMARY KEY (price_list_id, product_id, min_qty)
);
CREATE TABLE promotions (id TEXT PRIMARY KEY, data TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL);

-- Clientes necessários (identificação na venda). Documento cifrado; busca por hash.
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  trade_name TEXT,
  tax_id_hash TEXT,
  tax_id_enc TEXT,
  tax_id_masked TEXT,
  status TEXT NOT NULL,
  block_reason TEXT,
  price_list_id TEXT,
  search TEXT NOT NULL,
  -- 1 = cadastrado no PDV e ainda não confirmado pelo ERP
  pending INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX customers_tax ON customers (tax_id_hash) WHERE tax_id_hash IS NOT NULL;

CREATE TABLE payment_methods (code TEXT PRIMARY KEY, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, nfe_tpag TEXT NOT NULL, active INTEGER NOT NULL);

-- Usuários autorizados no terminal (operadores com PIN e permissões vindas do ERP)
CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pin_hash TEXT NOT NULL,
  permissions TEXT NOT NULL,
  roles TEXT NOT NULL,
  discount_limit_percent TEXT NOT NULL DEFAULT '0',
  updated_at TEXT
);

-- Visão local do estoque (o ERP é a autoridade); o disponível desconta vendas ainda não sincronizadas
CREATE TABLE stock (
  product_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, lot_id TEXT NOT NULL DEFAULT '', quantity TEXT NOT NULL, reserved TEXT NOT NULL, blocked TEXT NOT NULL,
  PRIMARY KEY (product_id, warehouse_id, lot_id)
);
CREATE TABLE stock_params (product_id TEXT NOT NULL, warehouse_id TEXT NOT NULL, reorder_point TEXT NOT NULL, PRIMARY KEY (product_id, warehouse_id));

-- ------------------------------------------------------------------ segurança
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE TABLE login_attempts (login TEXT PRIMARY KEY COLLATE NOCASE, failures INTEGER NOT NULL, locked_until TEXT);

-- ------------------------------------------------------------------ caixa
CREATE TABLE cash_sessions (
  id TEXT PRIMARY KEY,
  terminal_code TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  opening_amount TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  closed_at TEXT,
  closed_by TEXT,
  -- Fechamento: esperado, informado e diferença por forma de pagamento (nunca apagados)
  closing TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX cash_sessions_open ON cash_sessions (terminal_code) WHERE status = 'open';

CREATE TABLE cash_movements (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES cash_sessions (id),
  kind TEXT NOT NULL CHECK (kind IN ('opening', 'supply', 'withdrawal', 'closing', 'reopening')),
  amount TEXT NOT NULL,
  reason TEXT,
  note TEXT,
  operator_id TEXT NOT NULL,
  authorized_by TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX cash_movements_session ON cash_movements (session_id);

-- ------------------------------------------------------------------ vendas
CREATE TABLE sales (
  id TEXT PRIMARY KEY,                       -- sale_uuid
  number TEXT NOT NULL UNIQUE,               -- PDV-03-20261027-000124
  idempotency_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES cash_sessions (id),
  operator_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'payment', 'completed', 'cancelled', 'discarded')),
  customer TEXT,                             -- JSON: {id, name, taxIdMasked} (documento cifrado em customer_tax_enc)
  customer_tax_enc TEXT,
  sale_discount TEXT,                        -- JSON: {kind, value, amount, authorizedBy}
  subtotal TEXT NOT NULL DEFAULT '0',
  discount_total TEXT NOT NULL DEFAULT '0',
  total TEXT NOT NULL DEFAULT '0',
  paid_total TEXT NOT NULL DEFAULT '0',
  change_total TEXT NOT NULL DEFAULT '0',
  fiscal_status TEXT,
  sync_status TEXT NOT NULL DEFAULT 'local' CHECK (sync_status IN ('local', 'pending', 'synced', 'failed')),
  synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  cancelled_by TEXT,
  cancel_authorized_by TEXT
);
CREATE INDEX sales_session ON sales (session_id, status);

CREATE TABLE sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales (id),
  seq INTEGER NOT NULL,
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  description TEXT NOT NULL,
  barcode TEXT,
  unit TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit_price TEXT NOT NULL,                  -- preço efetivo (lista + promoção)
  base_price TEXT NOT NULL,                  -- preço de lista
  promotions TEXT,                           -- JSON das promoções aplicadas
  weighed INTEGER NOT NULL DEFAULT 0,
  manual_discount TEXT,                      -- JSON: {kind, value, amount, authorizedBy}
  gross TEXT NOT NULL,
  discount TEXT NOT NULL,                    -- desconto do item + parte do desconto da venda
  total TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  cancel_reason TEXT,
  cancelled_by TEXT,
  cancel_authorized_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (sale_id, seq)
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales (id),
  method TEXT NOT NULL CHECK (method IN ('cash', 'pix', 'debit', 'credit', 'pos_debit', 'pos_credit')),
  method_code TEXT NOT NULL,                 -- forma de pagamento no ERP
  amount TEXT NOT NULL,                      -- valor aplicado à venda
  tendered TEXT,                             -- dinheiro recebido
  change TEXT NOT NULL DEFAULT '0',
  installments INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'cancelled', 'timeout', 'refunded')),
  provider TEXT NOT NULL,
  transaction_id TEXT,                       -- txid do Pix, NSU do TEF (nunca dados do cartão)
  nsu TEXT,
  authorization TEXT,
  brand TEXT,
  qr_code TEXT,
  message TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX payments_sale ON payments (sale_id);
-- Duplicidade (seção 44): no máximo um pagamento eletrônico pendente por venda
CREATE UNIQUE INDEX payments_one_pending ON payments (sale_id) WHERE status = 'pending';

-- Documento fiscal da venda (NFC-e)
CREATE TABLE fiscal_documents (
  sale_id TEXT PRIMARY KEY REFERENCES sales (id),
  model TEXT NOT NULL DEFAULT '65',
  series INTEGER NOT NULL,
  number INTEGER NOT NULL,
  access_key TEXT NOT NULL UNIQUE,
  emission_type INTEGER NOT NULL,            -- 1 normal, 9 contingência offline
  status TEXT NOT NULL CHECK (status IN ('pending', 'authorized', 'contingency', 'rejected', 'cancelled')),
  protocol TEXT,
  authorized_at TEXT,
  xml TEXT NOT NULL,
  qr_url TEXT NOT NULL,
  taxes TEXT,                                -- JSON: tributos aproximados (Lei 12.741)
  rejection_code TEXT,
  rejection_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  cancel_protocol TEXT,
  cancelled_at TEXT,
  issued_at TEXT NOT NULL,
  total TEXT NOT NULL,
  -- Contingência após envio sem resposta: a chave normal fica guardada para conferir na SEFAZ
  original_key TEXT,
  original_xml TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (series, number)
);

CREATE TABLE returns (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  -- Venda deste terminal (sale_id) ou de outro terminal da loja (só o número)
  sale_id TEXT REFERENCES sales (id),
  sale_number TEXT NOT NULL,
  items TEXT NOT NULL,
  reason TEXT NOT NULL,
  refund_method TEXT NOT NULL,
  total TEXT NOT NULL,
  customer TEXT,
  session_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  authorized_by TEXT,
  created_at TEXT NOT NULL
);

-- ------------------------------------------------------------------ auditoria (seção 39)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  terminal_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('LOGIN', 'LOGOUT', 'ABERTURA_CAIXA', 'VENDA', 'CANCELAMENTO_ITEM', 'CANCELAMENTO_VENDA', 'DESCONTO', 'AUTORIZACAO',
    'SANGRIA', 'SUPRIMENTO', 'FECHAMENTO_CAIXA', 'DEVOLUCAO', 'REIMPRESSAO', 'SYNC', 'ERRO_FISCAL', 'ERRO_PAGAMENTO', 'REABERTURA_CAIXA', 'LOGIN_FALHOU')),
  entity TEXT,
  entity_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);
CREATE INDEX events_ts ON events (timestamp);
-- Auditoria não se altera nem se apaga
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Auditoria não pode ser alterada'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Auditoria não pode ser apagada'); END;

-- ------------------------------------------------------------------ fila de sincronização (seção 31)
CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                        -- sale, sale_cancel, return, cash_movement, customer, nfce_authorization, events
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SYNCED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- 1 = falhou por indisponibilidade (reenvia ao reconectar); 0 = recusado pelo ERP
  retryable INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT,
  next_attempt_at TEXT NOT NULL,
  -- Ordem de envio: cliente antes da venda, venda antes do cancelamento/devolução
  priority INTEGER NOT NULL,
  UNIQUE (type, entity_id)
);
CREATE INDEX sync_queue_ready ON sync_queue (status, next_attempt_at, priority);
