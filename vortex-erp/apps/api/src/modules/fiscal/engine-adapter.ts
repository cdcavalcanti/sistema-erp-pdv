import { z } from 'zod';
import {
  calculate, FiscalConfigError, referenceIbsCbs, transitionFor,
  type FiscalOperationInput, type FiscalResult, type FiscalTables, type ItemInput, type IssuerRegime, type OperationPurpose, type Recipient, type TaxRule,
} from '@vortex/fiscal-engine';
import type { UF } from '@vortex/validators';
import type { Tx } from '../../db/tx.js';
import { AppError, notFound } from '../../errors.js';
import { regimeAt } from '../org/service.js';

const dec = z.union([z.string(), z.number()]).transform((v) => String(v)).refine((s) => /^-?\d+(\.\d+)?$/.test(s), 'Número decimal inválido');

/** Esquema do resultado de uma regra fiscal (seção 22: regra em JSON validado por esquema). */
export const ruleResultSchema = z.object({
  cfop: z.string().regex(/^[1-7]\d{3}$/).optional(),
  icms: z.object({ cst: z.string().regex(/^\d{2}$/).optional(), csosn: z.string().regex(/^\d{3}$/).optional(), rate: dec.optional(), baseReduction: dec.optional(),
    deferral: dec.optional(), fcpRate: dec.optional(), benefitCode: z.string().optional(), exemptionReason: z.string().optional() }).strict().optional(),
  st: z.object({ mva: dec.optional(), rate: dec.optional(), baseReduction: dec.optional(), fcpRate: dec.optional(), pautaUnitValue: dec.optional(), adjustMva: z.boolean().optional() }).strict().optional(),
  difal: z.object({ base: z.enum(['single', 'double']).optional(), destRate: dec.optional(), fcpDestRate: dec.optional(), applyToSimples: z.boolean().optional() }).strict().optional(),
  ipi: z.object({ cst: z.string().regex(/^\d{2}$/), rate: dec.optional(), enqCode: z.string().optional() }).strict().optional(),
  pis: z.object({ cst: z.string().regex(/^\d{2}$/), rate: dec.optional() }).strict().optional(),
  cofins: z.object({ cst: z.string().regex(/^\d{2}$/), rate: dec.optional() }).strict().optional(),
  excludeIcmsFromPisCofinsBase: z.boolean().optional(),
  iss: z.object({ rate: dec, retained: z.boolean().optional(), exigibility: z.number().int().min(1).max(7).optional() }).strict().optional(),
  ibsCbs: z.object({ cst: z.string().regex(/^\d{3}$/).optional(), cclasstrib: z.string().regex(/^\d{6}$/).optional(), reductionIbs: dec.optional(), reductionCbs: dec.optional() }).strict().optional(),
  is: z.object({ rate: dec, cst: z.string().optional(), cclasstrib: z.string().optional() }).strict().optional(),
  retentions: z.object({ irrf: dec.optional(), csll: dec.optional(), pis: dec.optional(), cofins: dec.optional(), inss: dec.optional() }).strict().optional(),
}).strict().refine((r) => Object.keys(r).length > 0, 'A regra precisa definir ao menos um tributo ou CFOP');

export interface TaxRuleRow {
  id: string;
  name: string;
  valid_from: string;
  valid_to: string | null;
  operation_type_code: string | null;
  direction: 'S' | 'E' | null;
  uf_origin: string | null;
  uf_dest: string | null;
  ncm_prefix: string | null;
  cest: string | null;
  tax_group: string | null;
  product_id: string | null;
  recipient_ie_indicator: 1 | 2 | 9 | null;
  recipient_final_consumer: boolean | null;
  recipient_regime: 'simples_nacional' | 'mei' | 'normal' | null;
  issuer_regime: IssuerRegime | null;
  origin: number | null;
  item_kind: 'goods' | 'service' | null;
  result: TaxRule['result'];
  establishment_id: string | null;
}

export function rowToRule(r: TaxRuleRow): TaxRule {
  return {
    id: r.id, name: r.name, validFrom: r.valid_from, validTo: r.valid_to,
    keys: {
      operationCode: r.operation_type_code, direction: r.direction, ufOrigin: r.uf_origin as UF | null, ufDest: r.uf_dest as UF | null, ncmPrefix: r.ncm_prefix,
      cest: r.cest, taxGroup: r.tax_group, productId: r.product_id, recipientIeIndicator: r.recipient_ie_indicator, recipientFinalConsumer: r.recipient_final_consumer,
      recipientRegime: r.recipient_regime, issuerRegime: r.issuer_regime, origin: r.origin, itemKind: r.item_kind,
    },
    result: r.result,
  };
}

export async function loadRules(tx: Tx, establishmentId: string | null): Promise<TaxRule[]> {
  const rows = await tx.query<TaxRuleRow>(
    `SELECT * FROM fiscal.tax_rules WHERE active AND (establishment_id IS NULL OR establishment_id = $1)`, [establishmentId]);
  return rows.map(rowToRule);
}

/** Carrega as tabelas vigentes na data do fato gerador (RN-GER-03). */
export async function loadTables(tx: Tx, date: string, destUf: string | null, destCity: string | null): Promise<FiscalTables> {
  const rates = await tx.query<{ uf: UF; rate: string; fcp_rate: string; difal_base: 'single' | 'double' }>(
    `SELECT DISTINCT ON (uf) uf, rate, fcp_rate, difal_base FROM fiscal.icms_internal_rates
      WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to >= $1) ORDER BY uf, valid_from DESC`, [date]);
  const year = Number(date.slice(0, 4));
  const tr = await tx.maybeOne<{ icms_iss_factor: string; pis_cofins_active: boolean; ipi_active: boolean; ibs_cbs_informative: boolean; is_active: boolean }>(
    `SELECT * FROM fiscal.tax_transition WHERE year = $1`, [Math.min(Math.max(year, 2026), 2033)]);
  const transition = year < 2026 || !tr ? transitionFor(date)
    : { year, icmsIssFactor: tr.icms_iss_factor, pisCofinsActive: tr.pis_cofins_active, ipiActive: tr.ipi_active, ibsCbsInformative: tr.ibs_cbs_informative, isActive: tr.is_active };
  const ibsCbsRates = await ibsCbsRatesFor(tx, date, destUf, destCity);
  const cct = await tx.query<{ code: string; cst: string; reduction_ibs: string; reduction_cbs: string; exempt: boolean; deferral: boolean; presumed_credit: boolean }>(
    `SELECT DISTINCT ON (code) code, cst, reduction_ibs, reduction_cbs, exempt, deferral, presumed_credit FROM fiscal.cclasstrib
      WHERE valid_from <= greatest($1::date, '2026-01-01') AND (valid_to IS NULL OR valid_to >= $1) ORDER BY code, valid_from DESC`, [date]);
  const mono = await tx.query<{ code: string }>(`SELECT DISTINCT code FROM fiscal.ncm WHERE pis_cofins_monofasico AND (valid_to IS NULL OR valid_to >= $1)`, [date]);
  return {
    icmsInternalRates: Object.fromEntries(rates.map((r) => [r.uf, r.rate])),
    fcpRates: Object.fromEntries(rates.filter((r) => Number(r.fcp_rate) > 0).map((r) => [r.uf, r.fcp_rate])),
    difalBase: Object.fromEntries(rates.map((r) => [r.uf, r.difal_base])),
    transition,
    ibsCbsRates,
    cclasstrib: Object.fromEntries(cct.map((c) => [c.code, { code: c.code, cst: c.cst, reductionIbs: c.reduction_ibs, reductionCbs: c.reduction_cbs, exempt: c.exempt, deferral: c.deferral, presumedCredit: c.presumed_credit }])),
    monophasicNcms: mono.map((m) => m.code),
  };
}

export interface OperationItemRequest {
  id: string;
  productId: string;
  quantity: string;
  unitPrice: string;
  discount?: string;
  freight?: string;
  insurance?: string;
  otherExpenses?: string;
  forUseOrConsumption?: boolean;
}

export interface OperationRequest {
  establishmentId: string;
  operationTypeCode: string;
  date: string;
  /** Pessoa do cadastro, ou destinatário avulso (consumidor não identificado) */
  partyId?: string | null;
  recipient?: Recipient;
  presential?: boolean;
  header?: { freight?: string; insurance?: string; otherExpenses?: string; discount?: string };
  items: OperationItemRequest[];
}

export interface BuiltOperation {
  input: FiscalOperationInput;
  establishment: Record<string, any>;
  operationType: Record<string, any>;
  party: Record<string, any> | null;
  products: Map<string, Record<string, any>>;
  regime: string;
}

/** Monta a entrada do motor a partir dos cadastros (estabelecimento, pessoa, produtos, tipo de operação). */
export async function buildOperation(tx: Tx, req: OperationRequest): Promise<BuiltOperation> {
  const est = await tx.maybeOne(`SELECT * FROM core.establishments WHERE id = $1`, [req.establishmentId]);
  if (!est) throw notFound('Estabelecimento');
  const opType = await tx.maybeOne(`SELECT * FROM fiscal.operation_types WHERE code = $1 AND active`, [req.operationTypeCode]);
  if (!opType) throw notFound(`Tipo de operação ${req.operationTypeCode}`);
  const regime = await regimeAt(tx, req.establishmentId, req.date);
  const simplesRate = await tx.maybeOne<{ simples_credit_rate: string | null }>(
    `SELECT simples_credit_rate FROM core.establishment_tax_regimes WHERE establishment_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2)`, [req.establishmentId, req.date]);
  let party: Record<string, any> | null = null;
  let recipient: Recipient;
  if (req.partyId) {
    party = await tx.maybeOne(`SELECT * FROM registry.parties WHERE id = $1`, [req.partyId]);
    if (!party) throw notFound('Destinatário');
    const addr = await tx.maybeOne(`SELECT * FROM registry.party_addresses WHERE party_id = $1 ORDER BY (kind = 'fiscal') DESC, is_default DESC LIMIT 1`, [req.partyId]);
    const foreign = party.kind === 'EX' || (addr && addr.country_code !== '1058');
    recipient = {
      uf: foreign ? 'EX' : (addr?.uf ?? est.uf), cityIbge: addr?.city_ibge ?? null, ieIndicator: party.ie_indicator, finalConsumer: party.final_consumer,
      regime: party.tax_regime ?? null, countryCode: addr?.country_code ?? '1058', suframa: party.suframa,
    };
  } else {
    recipient = req.recipient ?? { uf: est.uf, cityIbge: est.city_ibge, ieIndicator: 9, finalConsumer: true };
  }
  const productIds = [...new Set(req.items.map((i) => i.productId))];
  const prods = await tx.query(`SELECT * FROM catalog.products WHERE id = ANY($1)`, [productIds]);
  const products = new Map(prods.map((p) => [p.id, p]));
  const items: ItemInput[] = req.items.map((i) => {
    const p = products.get(i.productId);
    if (!p) throw notFound(`Produto ${i.productId}`);
    return {
      id: i.id, productId: p.id, kind: p.kind === 'service' ? 'service' : 'goods', ncm: p.ncm, cest: p.cest, origin: p.origin, taxGroup: p.tax_group,
      cclasstrib: p.cclasstrib, serviceCode: p.service_code, ownProduction: p.own_production, quantity: i.quantity, unitPrice: i.unitPrice,
      taxableQuantity: (Number(i.quantity) * Number(p.taxable_factor)).toString(), discount: i.discount, freight: i.freight, insurance: i.insurance,
      otherExpenses: i.otherExpenses, forUseOrConsumption: i.forUseOrConsumption,
    };
  });
  // Princípio do destino: IBS/CBS pela localidade do adquirente; venda presencial usa a do estabelecimento
  const presential = req.presential ?? false;
  const destUf = presential || recipient.uf === 'EX' ? est.uf : recipient.uf;
  const destCity = presential ? est.city_ibge : (recipient.cityIbge ?? null);
  const input: FiscalOperationInput = {
    date: req.date,
    issuer: { uf: est.uf, cityIbge: est.city_ibge, regime: regime as IssuerRegime, simplesCreditRate: simplesRate?.simples_credit_rate ?? null },
    recipient,
    operation: {
      code: opType.code, direction: opType.direction, purpose: opType.purpose as OperationPurpose, presential,
      cfopInternal: opType.cfop_internal, cfopInterstate: opType.cfop_interstate, cfopForeign: opType.cfop_foreign,
    },
    header: req.header,
    items,
    rules: await loadRules(tx, req.establishmentId),
    tables: await loadTables(tx, req.date, destUf, destCity),
  };
  return { input, establishment: est, operationType: opType, party, products, regime };
}

/** Executa o motor e traduz erros de configuração fiscal para a API. */
export function runEngine(input: FiscalOperationInput): FiscalResult {
  try {
    return calculate(input);
  } catch (e) {
    if (e instanceof FiscalConfigError) {
      const rule = (e.details.rule as string | undefined) ?? undefined;
      throw new AppError('FISCAL_CONFIG', e.message, 422, { ...e.details, ...(rule ? { rule } : {}) });
    }
    throw e;
  }
}

export async function calculateOperation(tx: Tx, req: OperationRequest): Promise<{ built: BuiltOperation; result: FiscalResult }> {
  const built = await buildOperation(tx, req);
  return { built, result: runEngine(built.input) };
}

/** RN-REF-02: alíquotas de IBS/CBS em tabela por vigência, UF e município (a mais específica vale). */
export async function ibsCbsRatesFor(tx: Tx, date: string, destUf: string | null, destCity: string | null): Promise<{ cbs: string; ibsUf: string; ibsMun: string } | null> {
  // Alíquota de IBS/CBS: a mais específica (município > UF > nacional) vigente na data
  const rate = await tx.maybeOne<{ cbs_rate: string | null; ibs_uf_rate: string | null; ibs_mun_rate: string | null }>(
    `SELECT
       (SELECT cbs_rate FROM fiscal.ibs_cbs_rates WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to >= $1) AND cbs_rate IS NOT NULL AND (uf IS NULL OR uf = $2) AND (city_ibge IS NULL OR city_ibge = $3) ORDER BY (city_ibge IS NOT NULL) DESC, (uf IS NOT NULL) DESC, valid_from DESC LIMIT 1) AS cbs_rate,
       (SELECT ibs_uf_rate FROM fiscal.ibs_cbs_rates WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to >= $1) AND ibs_uf_rate IS NOT NULL AND (uf IS NULL OR uf = $2) AND city_ibge IS NULL ORDER BY (uf IS NOT NULL) DESC, valid_from DESC LIMIT 1) AS ibs_uf_rate,
       (SELECT ibs_mun_rate FROM fiscal.ibs_cbs_rates WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to >= $1) AND ibs_mun_rate IS NOT NULL AND (city_ibge IS NULL OR city_ibge = $3) ORDER BY (city_ibge IS NOT NULL) DESC, valid_from DESC LIMIT 1) AS ibs_mun_rate`,
    [date, destUf, destCity]);
  return rate?.cbs_rate != null ? { cbs: rate.cbs_rate, ibsUf: rate.ibs_uf_rate ?? '0', ibsMun: rate.ibs_mun_rate ?? '0' } : referenceIbsCbs(date);
}
