-- =====================================================================
-- 0006 — Regras fiscais e tabelas de alíquotas com vigência (seções 07/08)
-- RN-GER-03: regra fiscal é dado, não código.
-- =====================================================================

-- Alíquota interna modal, FCP e base do DIFAL por UF (globais, com vigência)
CREATE TABLE fiscal.icms_internal_rates (
  uf char(2) NOT NULL,
  rate numeric(9,4) NOT NULL,
  fcp_rate numeric(9,4) NOT NULL DEFAULT 0,
  difal_base text NOT NULL DEFAULT 'single' CHECK (difal_base IN ('single', 'double')),
  valid_from date NOT NULL,
  valid_to date,
  source text,
  PRIMARY KEY (uf, valid_from)
);

-- Alíquotas de IBS/CBS por ano, UF e município (RN-REF-02)
CREATE TABLE fiscal.ibs_cbs_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  valid_from date NOT NULL,
  valid_to date,
  uf char(2),
  city_ibge char(7),
  cbs_rate numeric(9,4),
  ibs_uf_rate numeric(9,4),
  ibs_mun_rate numeric(9,4),
  source text,
  UNIQUE NULLS NOT DISTINCT (valid_from, uf, city_ibge)
);

-- Cronograma da transição (RN-REF-03)
CREATE TABLE fiscal.tax_transition (
  year int PRIMARY KEY,
  icms_iss_factor numeric(9,4) NOT NULL,
  pis_cofins_active boolean NOT NULL,
  ipi_active boolean NOT NULL,
  ibs_cbs_informative boolean NOT NULL,
  is_active boolean NOT NULL
);

GRANT SELECT ON fiscal.icms_internal_rates, fiscal.ibs_cbs_rates, fiscal.tax_transition TO vortex_app, vortex_worker;

INSERT INTO fiscal.tax_transition VALUES
  (2026, 1, true, true, true, false),
  (2027, 1, false, false, false, true),
  (2028, 1, false, false, false, true),
  (2029, 0.9, false, false, false, true),
  (2030, 0.8, false, false, false, true),
  (2031, 0.7, false, false, false, true),
  (2032, 0.6, false, false, false, true),
  (2033, 0, false, false, false, true);

-- Valores de referência (SEED): confirmar com o contador antes de produção.
INSERT INTO fiscal.icms_internal_rates (uf, rate, fcp_rate, valid_from, source)
SELECT uf, rate::numeric, 0, '2025-01-01', 'SEED-REFERENCIA' FROM (VALUES
  ('AC','19'),('AL','20'),('AM','20'),('AP','18'),('BA','20.5'),('CE','20'),('DF','20'),('ES','17'),('GO','19'),('MA','23'),('MG','18'),('MS','17'),
  ('MT','17'),('PA','19'),('PB','20'),('PE','20.5'),('PI','22.5'),('PR','19.5'),('RJ','20'),('RN','20'),('RO','19.5'),('RR','20'),('RS','17'),('SC','17'),
  ('SE','20'),('SP','18'),('TO','20')) AS t(uf, rate);
UPDATE fiscal.icms_internal_rates SET fcp_rate = 2 WHERE uf = 'RJ';

-- 2026: CBS 0,9% e IBS 0,1% (ano de teste). 2027+: placeholders até a fixação das alíquotas de referência.
INSERT INTO fiscal.ibs_cbs_rates (valid_from, valid_to, uf, city_ibge, cbs_rate, ibs_uf_rate, ibs_mun_rate, source) VALUES
  ('2026-01-01', '2026-12-31', NULL, NULL, 0.9, 0.1, 0, 'LC 214/2025 art. 343-344'),
  ('2027-01-01', '2028-12-31', NULL, NULL, 8.8, 0.05, 0.05, 'SEED-PLACEHOLDER'),
  ('2029-01-01', '2029-12-31', NULL, NULL, 8.8, 1.0, 0.8, 'SEED-PLACEHOLDER'),
  ('2030-01-01', '2030-12-31', NULL, NULL, 8.8, 2.0, 1.6, 'SEED-PLACEHOLDER'),
  ('2031-01-01', '2031-12-31', NULL, NULL, 8.8, 3.0, 2.4, 'SEED-PLACEHOLDER'),
  ('2032-01-01', '2032-12-31', NULL, NULL, 8.8, 4.0, 3.2, 'SEED-PLACEHOLDER'),
  ('2033-01-01', NULL, NULL, NULL, 8.8, 10.0, 8.0, 'SEED-PLACEHOLDER');

-- ---------------------------------------------------------------------
-- Matriz de regras fiscais por tenant (RN-FIS-01)
-- ---------------------------------------------------------------------
CREATE TABLE fiscal.tax_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES core.tenants(id),
  -- Regra de um estabelecimento específico (NULL = todos)
  establishment_id uuid REFERENCES core.establishments(id),
  name text NOT NULL,
  notes text,
  valid_from date NOT NULL,
  valid_to date,
  -- Chaves (NULL = curinga)
  operation_type_code text,
  direction char(1) CHECK (direction IN ('S', 'E')),
  uf_origin char(2),
  uf_dest char(2),
  ncm_prefix text CHECK (ncm_prefix ~ '^\d{2,8}$'),
  cest char(7),
  tax_group text,
  product_id uuid REFERENCES catalog.products(id),
  recipient_ie_indicator smallint CHECK (recipient_ie_indicator IN (1, 2, 9)),
  recipient_final_consumer boolean,
  recipient_regime text CHECK (recipient_regime IN ('simples_nacional', 'mei', 'normal')),
  issuer_regime text CHECK (issuer_regime IN ('simples_nacional', 'simples_excesso_sublimite', 'mei', 'lucro_presumido', 'lucro_real')),
  origin smallint CHECK (origin BETWEEN 0 AND 8),
  item_kind text CHECK (item_kind IN ('goods', 'service')),
  -- Resultado (validado por esquema na API): {cfop, icms{}, st{}, difal{}, ipi{}, pis{}, cofins{}, iss{}, ibsCbs{}, is{}, retentions{}}
  result jsonb NOT NULL,
  -- Aprovação do contador (seção 07: a parametrização inicial deve ser validada pelo contador)
  validated_by_accountant boolean NOT NULL DEFAULT false,
  validated_by uuid,
  validated_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version int NOT NULL DEFAULT 1,
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX ON fiscal.tax_rules (tenant_id, active);
SELECT core.enable_tenant_rls('fiscal.tax_rules');
SELECT core.enable_touch('fiscal.tax_rules');
SELECT core.enable_audit('fiscal.tax_rules');

GRANT SELECT, INSERT, UPDATE ON fiscal.tax_rules TO vortex_app;
