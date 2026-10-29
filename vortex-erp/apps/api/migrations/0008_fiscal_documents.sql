-- =====================================================================
-- 0008 — Documentos fiscais eletrônicos (seção 09)
-- =====================================================================

CREATE TABLE fiscal.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  -- 55 NF-e, 65 NFC-e, 57 CT-e, 58 MDF-e, 99 NFS-e (padrão nacional)
  model varchar(2) NOT NULL CHECK (model IN ('55', '65', '57', '58', '99')),
  -- own: emitida pelo estabelecimento; third_party: recebida de fornecedor (DF-e)
  issuer_kind text NOT NULL DEFAULT 'own' CHECK (issuer_kind IN ('own', 'third_party')),
  direction char(1) NOT NULL CHECK (direction IN ('S', 'E')),
  series int,
  number bigint,
  access_key char(44) CHECK (access_key ~ '^[0-9A-Z]{43}\d$'),
  numeric_code char(8),
  environment smallint NOT NULL DEFAULT 2 CHECK (environment IN (1, 2)),
  -- tpEmis: 1 normal, 4 EPEC, 6 SVC-AN, 7 SVC-RS, 9 contingência offline NFC-e
  emission_type smallint NOT NULL DEFAULT 1 CHECK (emission_type IN (1, 2, 3, 4, 5, 6, 7, 9)),
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'validando', 'pendente_envio', 'em_processamento', 'autorizada', 'rejeitada',
    'denegada', 'contingencia', 'cancelada', 'inutilizada')),
  operation_type_id uuid REFERENCES fiscal.operation_types(id),
  operation_code text NOT NULL,
  operation_nature text NOT NULL,
  -- finNFe: 1 normal, 2 complementar, 3 ajuste, 4 devolução
  purpose smallint NOT NULL DEFAULT 1,
  -- indPres: 0 não se aplica, 1 presencial, 2 internet, 3 teleatendimento, 4 entrega a domicílio, 9 outros
  presence smallint NOT NULL DEFAULT 1,
  final_consumer boolean NOT NULL DEFAULT false,
  issued_at timestamptz,
  exit_at timestamptz,
  -- Data do fato gerador (regras e tabelas fiscais vigentes)
  tax_date date NOT NULL,
  regime text NOT NULL,
  -- Emitente (snapshot)
  issuer_tax_id varchar(14) NOT NULL,
  issuer_name text NOT NULL,
  issuer_ie text,
  issuer_uf char(2) NOT NULL,
  -- Destinatário (snapshot: o documento emitido não muda se o cadastro mudar)
  party_id uuid REFERENCES registry.parties(id),
  recipient_tax_id varchar(14),
  recipient_name text,
  recipient_ie text,
  recipient_ie_indicator smallint,
  recipient_uf char(2),
  recipient_address jsonb,
  recipient_email text,
  -- Transporte e pagamento
  freight_mode smallint NOT NULL DEFAULT 9 CHECK (freight_mode IN (0, 1, 2, 3, 4, 9)),
  carrier_id uuid REFERENCES registry.parties(id),
  volumes jsonb NOT NULL DEFAULT '[]',
  payments jsonb NOT NULL DEFAULT '[]',
  installments jsonb NOT NULL DEFAULT '[]',
  additional_info text,
  fisco_info text,
  -- Totais (gravados; relatórios e SPED leem o que foi gravado — RN-FIS-02)
  totals jsonb NOT NULL DEFAULT '{}',
  total_products numeric(18,2) NOT NULL DEFAULT 0,
  total_discount numeric(18,2) NOT NULL DEFAULT 0,
  total_freight numeric(18,2) NOT NULL DEFAULT 0,
  total_icms numeric(18,2) NOT NULL DEFAULT 0,
  total_st numeric(18,2) NOT NULL DEFAULT 0,
  total_ipi numeric(18,2) NOT NULL DEFAULT 0,
  total_pis numeric(18,2) NOT NULL DEFAULT 0,
  total_cofins numeric(18,2) NOT NULL DEFAULT 0,
  total_ibs numeric(18,2) NOT NULL DEFAULT 0,
  total_cbs numeric(18,2) NOT NULL DEFAULT 0,
  total_invoice numeric(18,2) NOT NULL DEFAULT 0,
  -- SEFAZ
  protocol text,
  authorized_at timestamptz,
  receipt_number text,
  sefaz_code text,
  sefaz_message text,
  rejection_explanation text,
  contingency_reason text,
  contingency_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  gateway text,
  -- Guarda (RN-NFE-08): referências ao armazenamento imutável
  xml_key text,
  xml_sha256 text,
  authorized_xml_key text,
  danfe_key text,
  public_token text,
  -- Cancelamento
  cancelled_at timestamptz,
  cancel_protocol text,
  cancel_reason text,
  correction_count int NOT NULL DEFAULT 0,
  -- Origem
  source_type text NOT NULL,
  source_id uuid,
  -- Saldo para devolução por item controlado nos itens
  sent_to_recipient_at timestamptz,
  engine_version text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX documents_number_uq ON fiscal.documents (establishment_id, model, series, number, environment) WHERE issuer_kind = 'own' AND number IS NOT NULL;
CREATE UNIQUE INDEX documents_key_uq ON fiscal.documents (tenant_id, access_key, issuer_kind) WHERE access_key IS NOT NULL;
CREATE UNIQUE INDEX documents_idem_uq ON fiscal.documents (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ON fiscal.documents (tenant_id, status);
CREATE INDEX ON fiscal.documents (tenant_id, source_type, source_id);
CREATE INDEX ON fiscal.documents (tenant_id, party_id, issued_at DESC);
CREATE INDEX ON fiscal.documents (tenant_id, company_id, tax_date);
SELECT core.enable_tenant_rls('fiscal.documents');
SELECT core.enable_touch('fiscal.documents');
SELECT core.enable_audit('fiscal.documents');

-- Máquina de estados (seção 09): transições fora dela são bloqueadas no banco.
-- RN-GER-02: documento autorizado não se edita; só muda por eventos (cancelamento, CC-e).
CREATE OR REPLACE FUNCTION fiscal.document_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed boolean;
  frozen_cols text[] := ARRAY['model','series','number','access_key','establishment_id','direction','issuer_tax_id','recipient_tax_id','recipient_name',
    'total_invoice','total_products','total_icms','total_st','total_ipi','total_pis','total_cofins','total_ibs','total_cbs','totals','tax_date','issued_at','party_id','payments'];
  c text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := (OLD.status, NEW.status) IN (
      ('rascunho','validando'), ('validando','rascunho'), ('validando','pendente_envio'),
      ('pendente_envio','em_processamento'), ('pendente_envio','contingencia'), ('pendente_envio','rascunho'),
      ('em_processamento','autorizada'), ('em_processamento','rejeitada'), ('em_processamento','denegada'), ('em_processamento','contingencia'),
      ('contingencia','em_processamento'), ('contingencia','autorizada'), ('contingencia','rejeitada'),
      ('rejeitada','rascunho'), ('rejeitada','inutilizada'), ('rascunho','inutilizada'),
      ('autorizada','cancelada'))
      -- Documento de terceiro (ex.: NF-e de devolução emitida pelo cliente) já chega autorizado
      OR (NEW.issuer_kind = 'third_party' AND (OLD.status, NEW.status) IN (('rascunho','autorizada'), ('validando','autorizada')));
    IF NOT allowed THEN
      RAISE EXCEPTION 'RN-NFE-STATUS: transição de % para % não permitida', OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF OLD.status IN ('autorizada', 'cancelada', 'denegada', 'inutilizada') THEN
    FOREACH c IN ARRAY frozen_cols LOOP
      IF (to_jsonb(NEW) -> c) IS DISTINCT FROM (to_jsonb(OLD) -> c) THEN
        RAISE EXCEPTION 'Documento fiscal % não pode ser alterado (campo %)', OLD.status, c USING ERRCODE = 'P0001', HINT = 'IMMUTABLE';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_document_guard BEFORE UPDATE ON fiscal.documents FOR EACH ROW EXECUTE FUNCTION fiscal.document_guard();
CREATE TRIGGER trg_document_nodelete BEFORE DELETE ON fiscal.documents FOR EACH ROW WHEN (OLD.status <> 'rascunho' OR OLD.number IS NOT NULL) EXECUTE FUNCTION core.forbid_change();
SELECT accounting.enable_period_lock('fiscal.documents', 'tax_date');

CREATE TABLE fiscal.document_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  document_id uuid NOT NULL REFERENCES fiscal.documents(id) ON DELETE CASCADE,
  item_number int NOT NULL,
  product_id uuid REFERENCES catalog.products(id),
  sku text NOT NULL,
  description text NOT NULL,
  gtin text,
  ncm char(8),
  cest char(7),
  origin smallint NOT NULL DEFAULT 0,
  cfop char(4) NOT NULL,
  unit text NOT NULL,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(20,10) NOT NULL,
  taxable_unit text NOT NULL,
  taxable_quantity numeric(18,4) NOT NULL,
  taxable_unit_price numeric(20,10) NOT NULL,
  total numeric(18,2) NOT NULL,
  discount numeric(18,2) NOT NULL DEFAULT 0,
  freight numeric(18,2) NOT NULL DEFAULT 0,
  insurance numeric(18,2) NOT NULL DEFAULT 0,
  other_expenses numeric(18,2) NOT NULL DEFAULT 0,
  item_total numeric(18,2) NOT NULL,
  -- Estoque/custo (CMV) e vínculos
  stock_quantity numeric(18,4),
  warehouse_id uuid REFERENCES core.warehouses(id),
  lot_id uuid REFERENCES inventory.lots(id),
  unit_cost numeric(20,10),
  source_item_id uuid,
  original_item_id uuid REFERENCES fiscal.document_items(id),
  returned_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  service_code text,
  cclasstrib char(6),
  additional_info text,
  -- Memória de cálculo (RN-FIS-04) e regras aplicadas
  tax_memory jsonb NOT NULL DEFAULT '[]',
  applied_rules jsonb NOT NULL DEFAULT '[]',
  UNIQUE (document_id, item_number),
  CHECK (returned_quantity <= quantity)
);
CREATE INDEX ON fiscal.document_items (tenant_id, product_id);
CREATE INDEX ON fiscal.document_items (original_item_id);
SELECT core.enable_tenant_rls('fiscal.document_items');

-- RN-FIS-02: o resultado do cálculo é gravado no item; relatórios e SPED nunca recalculam.
CREATE TABLE fiscal.document_item_taxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  document_item_id uuid NOT NULL REFERENCES fiscal.document_items(id) ON DELETE CASCADE,
  tax text NOT NULL CHECK (tax IN ('ICMS', 'ICMS_ST', 'FCP', 'FCP_ST', 'DIFAL', 'FCP_DEST', 'IPI', 'PIS', 'COFINS', 'ISS', 'IBS_UF', 'IBS_MUN', 'CBS', 'IS',
    'RET_IRRF', 'RET_CSLL', 'RET_PIS', 'RET_COFINS', 'RET_INSS', 'RET_ISS', 'ICMS_SN_CREDIT')),
  cst text,
  base numeric(18,2) NOT NULL DEFAULT 0,
  rate numeric(9,4) NOT NULL DEFAULT 0,
  value numeric(18,2) NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}',
  rule_id uuid,
  rule_name text,
  UNIQUE (document_item_id, tax)
);
SELECT core.enable_tenant_rls('fiscal.document_item_taxes');

-- Documentos referenciados (devolução, complementar, remessa vinculada ao faturamento)
CREATE TABLE fiscal.document_references (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  document_id uuid NOT NULL REFERENCES fiscal.documents(id) ON DELETE CASCADE,
  referenced_document_id uuid REFERENCES fiscal.documents(id),
  referenced_access_key char(44) NOT NULL,
  kind text NOT NULL CHECK (kind IN ('return', 'complement', 'future_delivery', 'third_party_order', 'adjustment')),
  PRIMARY KEY (document_id, referenced_access_key)
);
SELECT core.enable_tenant_rls('fiscal.document_references');

CREATE TABLE fiscal.document_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  document_id uuid REFERENCES fiscal.documents(id),
  kind text NOT NULL CHECK (kind IN ('transmission', 'authorization', 'rejection', 'denial', 'cancellation', 'correction_letter', 'contingency', 'epec',
    'inutilization', 'manifestation', 'status_query', 'email_sent')),
  sequence int,
  status text NOT NULL,
  protocol text,
  sefaz_code text,
  message text,
  payload jsonb NOT NULL DEFAULT '{}',
  xml_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON fiscal.document_events (tenant_id, document_id, created_at);
SELECT core.enable_tenant_rls('fiscal.document_events');
CREATE TRIGGER trg_events_immutable BEFORE UPDATE OR DELETE ON fiscal.document_events FOR EACH ROW EXECUTE FUNCTION core.forbid_change();

-- Inutilização de numeração (RN-NFE-01)
CREATE TABLE fiscal.inutilizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  model varchar(2) NOT NULL,
  series int NOT NULL,
  number_from bigint NOT NULL,
  number_to bigint NOT NULL,
  year int NOT NULL,
  reason text NOT NULL CHECK (length(reason) >= 15),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'rejected')),
  protocol text,
  sefaz_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CHECK (number_to >= number_from)
);
SELECT core.enable_tenant_rls('fiscal.inutilizations');

-- Catálogo de rejeições mantido pela VORTEX (explicação em português simples)
CREATE TABLE fiscal.rejection_catalog (
  code text PRIMARY KEY,
  sefaz_message text NOT NULL,
  explanation text NOT NULL,
  action text NOT NULL
);
GRANT SELECT ON fiscal.rejection_catalog TO vortex_app;

INSERT INTO fiscal.rejection_catalog (code, sefaz_message, explanation, action) VALUES
  ('204', 'Duplicidade de NF-e', 'Esta nota já foi enviada e autorizada antes com a mesma numeração.', 'Consulte a situação da nota pela chave em vez de reenviar.'),
  ('215', 'Falha no schema XML', 'O arquivo da nota tem algum campo fora do formato exigido pela SEFAZ.', 'Revise os campos destacados e reenvie; se persistir, acione o suporte VORTEX.'),
  ('225', 'Falha no Schema XML da NFe', 'Algum campo da nota está com formato ou tamanho inválido.', 'Revise os campos destacados e reenvie.'),
  ('228', 'Data de Emissão muito atrasada', 'A data de emissão está antiga demais para a SEFAZ aceitar.', 'Atualize a data de emissão para hoje e reenvie.'),
  ('233', 'IE do destinatário não cadastrada', 'A inscrição estadual do cliente não existe no cadastro da SEFAZ.', 'Confira a IE no cadastro do cliente (ou marque como não contribuinte) e reenvie.'),
  ('234', 'IE do destinatário não vinculada ao CNPJ', 'A inscrição estadual informada pertence a outro CNPJ.', 'Corrija a IE do cliente no cadastro e reenvie.'),
  ('301', 'Uso Denegado: Irregularidade fiscal do emitente', 'A SEFAZ negou a nota por pendência cadastral da sua empresa.', 'Procure o contador: a numeração foi encerrada e não pode ser reutilizada.'),
  ('302', 'Uso Denegado: Irregularidade fiscal do destinatário', 'A SEFAZ negou a nota por pendência cadastral do cliente.', 'A numeração foi encerrada. Os itens voltaram ao pedido; avalie vender com outro documento.'),
  ('539', 'Duplicidade de NF-e com diferença na Chave de Acesso', 'Já existe nota com este número, mas com outra chave.', 'Consulte a nota existente; não reenvie com a mesma numeração.'),
  ('610', 'Total da NF difere do somatório dos Valores compõe o valor Total da NF', 'O total da nota não bate com a soma dos itens.', 'Erro de cálculo: acione o suporte VORTEX (não deveria chegar à SEFAZ).'),
  ('629', 'Valor do Produto difere do produto Valor Unitário de Comercialização e Quantidade Comercial', 'Quantidade × preço unitário não bate com o valor do item.', 'Revise quantidade e preço do item.'),
  ('694', 'Não informado o grupo de ICMS para a UF de destino', 'Venda interestadual a consumidor final exige o DIFAL na nota.', 'Revise as regras fiscais de DIFAL para a UF de destino.'),
  ('778', 'Informado NCM inexistente', 'O NCM do produto não existe na tabela vigente.', 'Corrija o NCM no cadastro do produto.'),
  ('1115', 'Grupo IBS/CBS não informado (UB12-10)', 'A nota não trouxe os campos da reforma tributária (IBS/CBS).', 'O ERP sempre preenche esses campos: acione o suporte VORTEX.'),
  ('999', 'Rejeição não catalogada', 'A SEFAZ recusou a nota por um motivo ainda não catalogado.', 'Leia a mensagem da SEFAZ e acione o suporte VORTEX se precisar.');

-- ---------------------------------------------------------------------
-- NF-e de entrada: distribuição de DF-e e manifestação do destinatário
-- ---------------------------------------------------------------------
CREATE TABLE fiscal.dfe_cursors (
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  establishment_id uuid PRIMARY KEY REFERENCES core.establishments(id),
  last_nsu bigint NOT NULL DEFAULT 0,
  max_nsu bigint NOT NULL DEFAULT 0,
  last_query_at timestamptz,
  -- Sem documentos novos (cStat 137): aguardar 1 hora antes da próxima consulta
  next_query_at timestamptz NOT NULL DEFAULT now()
);
SELECT core.enable_tenant_rls('fiscal.dfe_cursors');

CREATE TABLE fiscal.inbound_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  company_id uuid NOT NULL REFERENCES core.companies(id),
  establishment_id uuid NOT NULL REFERENCES core.establishments(id),
  nsu bigint,
  access_key char(44) NOT NULL,
  issuer_tax_id varchar(14) NOT NULL,
  issuer_name text NOT NULL,
  issuer_ie text,
  issued_at timestamptz,
  total numeric(18,2),
  -- resumo (resNFe) ou completa (procNFe)
  content text NOT NULL DEFAULT 'summary' CHECK (content IN ('summary', 'full')),
  sefaz_situation text NOT NULL DEFAULT 'autorizada' CHECK (sefaz_situation IN ('autorizada', 'cancelada', 'denegada')),
  xml_key text,
  manifestation text NOT NULL DEFAULT 'none' CHECK (manifestation IN ('none', 'ciencia', 'confirmada', 'desconhecida', 'nao_realizada')),
  manifested_at timestamptz,
  manifestation_reason text,
  -- Nota que a empresa não sabia que existia (alerta de fraude)
  unexpected boolean NOT NULL DEFAULT false,
  receipt_id uuid,
  supplier_id uuid REFERENCES registry.parties(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, access_key)
);
SELECT core.enable_tenant_rls('fiscal.inbound_documents');
SELECT core.enable_audit('fiscal.inbound_documents');

GRANT SELECT, INSERT, UPDATE ON fiscal.documents, fiscal.document_items, fiscal.document_item_taxes, fiscal.document_references, fiscal.inutilizations,
  fiscal.dfe_cursors, fiscal.inbound_documents TO vortex_app;
GRANT DELETE ON fiscal.documents, fiscal.document_items, fiscal.document_item_taxes, fiscal.document_references TO vortex_app;
GRANT SELECT, INSERT ON fiscal.document_events TO vortex_app;
