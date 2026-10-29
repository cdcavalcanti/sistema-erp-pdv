/**
 * Tipos do motor fiscal VORTEX (seções 07 e 08).
 *
 * O motor recebe a OPERAÇÃO (quem vende, quem compra, o quê, de onde para onde,
 * para quê, quando) e devolve, por item, CFOP, CSTs e valores de cada tributo,
 * com a memória de cálculo. Não acessa banco nem rede e não fala com a SEFAZ.
 * Todos os valores são texto decimal (RN-GER-06).
 */
import type { UF } from '@vortex/validators';

export type Dec = string;

export type IssuerRegime = 'simples_nacional' | 'simples_excesso_sublimite' | 'mei' | 'lucro_presumido' | 'lucro_real';
export type PartyRegime = 'simples_nacional' | 'mei' | 'normal';
export type ItemKind = 'goods' | 'service';
export type Direction = 'S' | 'E';

export type OperationPurpose =
  | 'sale' | 'sale_return' | 'purchase' | 'purchase_return' | 'shipment' | 'shipment_return' | 'bonus' | 'transfer'
  | 'demonstration' | 'repair' | 'consignment' | 'future_delivery' | 'future_delivery_shipment' | 'third_party_order'
  | 'third_party_shipment' | 'industrialization' | 'service' | 'loss' | 'internal_use' | 'adjustment';

export interface Issuer {
  uf: UF;
  cityIbge: string;
  regime: IssuerRegime;
  /** pCredSN: percentual de crédito de ICMS do Simples (alíquota efetiva × parcela do ICMS) */
  simplesCreditRate?: Dec | null;
}

export interface Recipient {
  uf: UF | 'EX';
  cityIbge?: string | null;
  /** 1 contribuinte, 2 isento, 9 não contribuinte */
  ieIndicator: 1 | 2 | 9;
  finalConsumer: boolean;
  regime?: PartyRegime | null;
  countryCode?: string;
  suframa?: string | null;
}

export interface OperationInfo {
  code: string;
  direction: Direction;
  purpose: OperationPurpose;
  /** Venda presencial (indPres = 1): o IBS/CBS segue o local do estabelecimento */
  presential?: boolean;
  cfopInternal?: string | null;
  cfopInterstate?: string | null;
  cfopForeign?: string | null;
}

export interface ItemInput {
  id: string;
  productId?: string | null;
  kind: ItemKind;
  ncm?: string | null;
  cest?: string | null;
  /** Origem da mercadoria (0 a 8) */
  origin: number;
  taxGroup?: string | null;
  cclasstrib?: string | null;
  serviceCode?: string | null;
  ownProduction?: boolean;
  quantity: Dec;
  unitPrice: Dec;
  /** Quantidade na unidade tributável (para pauta fiscal); padrão = quantity */
  taxableQuantity?: Dec | null;
  /** Desconto do item (além do rateio do desconto do cabeçalho) */
  discount?: Dec;
  freight?: Dec;
  insurance?: Dec;
  otherExpenses?: Dec;
  /** Mercadoria destinada a uso/consumo ou ativo do destinatário (IPI entra na base do ICMS) */
  forUseOrConsumption?: boolean;
}

export interface HeaderValues {
  freight?: Dec;
  insurance?: Dec;
  otherExpenses?: Dec;
  discount?: Dec;
}

// ------------------------------------------------------------------ regras fiscais (RN-GER-03, RN-FIS-01)

/** Chaves da matriz de prioridade. Campo ausente/nulo = curinga. */
export interface RuleKeys {
  operationCode?: string | null;
  direction?: Direction | null;
  ufOrigin?: UF | null;
  ufDest?: UF | 'EX' | null;
  /** Prefixo de NCM (2 a 8 dígitos); quanto mais longo, mais específico */
  ncmPrefix?: string | null;
  cest?: string | null;
  taxGroup?: string | null;
  productId?: string | null;
  recipientIeIndicator?: 1 | 2 | 9 | null;
  recipientFinalConsumer?: boolean | null;
  recipientRegime?: PartyRegime | null;
  issuerRegime?: IssuerRegime | null;
  origin?: number | null;
  itemKind?: ItemKind | null;
}

export interface IcmsRuleResult {
  /** CST (regime normal) ou CSOSN (Simples) */
  cst?: string;
  csosn?: string;
  rate?: Dec;
  /** Percentual de redução da base (pRedBC) */
  baseReduction?: Dec;
  /** Percentual do diferimento (pDif) */
  deferral?: Dec;
  fcpRate?: Dec;
  /** Código de benefício fiscal (cBenef) */
  benefitCode?: string;
  /** Motivo da desoneração (motDesICMS) e se deduz do total */
  exemptionReason?: string;
}

export interface StRuleResult {
  mva?: Dec;
  /** Alíquota interna do destino para a ST */
  rate?: Dec;
  baseReduction?: Dec;
  fcpRate?: Dec;
  /** Pauta fiscal por unidade tributável (substitui o MVA) */
  pautaUnitValue?: Dec;
  /** Ajustar MVA em operação interestadual (padrão: sim) */
  adjustMva?: boolean;
}

export interface IpiRuleResult {
  cst: string;
  rate?: Dec;
  enqCode?: string;
}

export interface PisCofinsRuleResult {
  cst: string;
  rate?: Dec;
}

export interface IssRuleResult {
  rate: Dec;
  retained?: boolean;
  /** Exigibilidade do ISS (1 exigível, 2 não incidência, 3 isenção, 4 exportação, 5 imunidade, 6/7 suspensa) */
  exigibility?: number;
}

export interface IbsCbsRuleResult {
  cst?: string;
  cclasstrib?: string;
  /** Percentual de redução de alíquota (pRedAliq) quando não vier do cClassTrib */
  reductionIbs?: Dec;
  reductionCbs?: Dec;
}

export interface IsRuleResult {
  rate: Dec;
  cst?: string;
  cclasstrib?: string;
}

export interface RetentionRuleResult {
  irrf?: Dec;
  csll?: Dec;
  pis?: Dec;
  cofins?: Dec;
  inss?: Dec;
}

export interface DifalRuleResult {
  /** Base única ("por fora") ou dupla ("por dentro") conforme legislação da UF de destino */
  base?: 'single' | 'double';
  /** Alíquota interna do destino */
  destRate?: Dec;
  fcpDestRate?: Dec;
  /** Calcular DIFAL para emitente do Simples (padrão: não — cláusula nona do Conv. 93/2015 suspensa) */
  applyToSimples?: boolean;
}

export interface RuleResult {
  cfop?: string;
  icms?: IcmsRuleResult;
  st?: StRuleResult;
  difal?: DifalRuleResult;
  ipi?: IpiRuleResult;
  pis?: PisCofinsRuleResult;
  cofins?: PisCofinsRuleResult;
  /** Exclui o ICMS destacado da base do PIS/Cofins (RE 574.706). Padrão: true */
  excludeIcmsFromPisCofinsBase?: boolean;
  iss?: IssRuleResult;
  ibsCbs?: IbsCbsRuleResult;
  is?: IsRuleResult;
  retentions?: RetentionRuleResult;
}

export type RuleGroup = keyof RuleResult;

export interface TaxRule {
  id: string;
  name: string;
  validFrom: string;
  validTo?: string | null;
  keys: RuleKeys;
  result: RuleResult;
}

// ------------------------------------------------------------------ tabelas de referência (dados, não código)

export interface IbsCbsRates {
  /** Alíquota da CBS no ano (ex.: 0.9 em 2026) */
  cbs: Dec;
  /** Alíquota do IBS estadual da UF de destino */
  ibsUf: Dec;
  /** Alíquota do IBS municipal do município de destino */
  ibsMun: Dec;
}

export interface TransitionYear {
  year: number;
  /** Fator sobre as alíquotas de ICMS e ISS (1; 0.9; 0.8; 0.7; 0.6; 0 em 2033) — RN-REF-03 */
  icmsIssFactor: Dec;
  pisCofinsActive: boolean;
  /** IPI vigente (a partir de 2027 só para produtos com industrialização incentivada na ZFM) */
  ipiActive: boolean;
  /** IBS/CBS calculados mas fora do total da nota (2026) */
  ibsCbsInformative: boolean;
  /** Imposto Seletivo vigente (a partir de 2027) */
  isActive: boolean;
}

export interface CClassTribInfo {
  code: string;
  cst: string;
  reductionIbs: Dec;
  reductionCbs: Dec;
  exempt: boolean;
  deferral: boolean;
  presumedCredit: boolean;
}

export interface FiscalTables {
  /** Alíquota interna (modal) de ICMS por UF, usada quando nenhuma regra define */
  icmsInternalRates: Partial<Record<UF, Dec>>;
  /** FCP padrão por UF (quando a regra não define) */
  fcpRates?: Partial<Record<UF, Dec>>;
  /** Base do DIFAL por UF de destino */
  difalBase?: Partial<Record<UF, 'single' | 'double'>>;
  transition: TransitionYear;
  ibsCbsRates: IbsCbsRates | null;
  cclasstrib: Record<string, CClassTribInfo>;
  /** NCMs com PIS/Cofins monofásico (revenda com alíquota zero, CST 04) */
  monophasicNcms?: string[];
}

export interface FiscalOperationInput {
  /** Data do fato gerador (AAAA-MM-DD): define as regras e tabelas vigentes (RN-GER-03) */
  date: string;
  issuer: Issuer;
  recipient: Recipient;
  operation: OperationInfo;
  header?: HeaderValues;
  items: ItemInput[];
  rules: TaxRule[];
  tables: FiscalTables;
}

// ------------------------------------------------------------------ resultado

export interface MemoryLine {
  tax: string;
  description: string;
  formula?: string;
  ruleId?: string | null;
  ruleName?: string | null;
}

export interface TaxValue {
  base: Dec;
  rate: Dec;
  value: Dec;
}

export interface ItemTaxes {
  icms: {
    cst: string | null;
    csosn: string | null;
    modBC: number;
    base: Dec;
    rate: Dec;
    baseReduction: Dec;
    value: Dec;
    /** ICMS da operação antes do diferimento */
    operationValue: Dec;
    deferralRate: Dec;
    deferredValue: Dec;
    simplesCreditRate: Dec;
    simplesCreditValue: Dec;
    exemptValue: Dec;
    benefitCode: string | null;
    exemptionReason: string | null;
  };
  fcp: TaxValue;
  st: { mva: Dec; adjustedMva: Dec; base: Dec; rate: Dec; value: Dec; baseReduction: Dec; fcp: TaxValue; ownIcmsDeducted: Dec } | null;
  difal: { base: Dec; destRate: Dec; interstateRate: Dec; value: Dec; fcpBase: Dec; fcpRate: Dec; fcpValue: Dec } | null;
  ipi: { cst: string; base: Dec; rate: Dec; value: Dec; enqCode: string } | null;
  pis: { cst: string; base: Dec; rate: Dec; value: Dec };
  cofins: { cst: string; base: Dec; rate: Dec; value: Dec };
  iss: { base: Dec; rate: Dec; value: Dec; retained: boolean; serviceCode: string | null; exigibility: number } | null;
  ibsCbs: {
    cst: string;
    cclasstrib: string;
    base: Dec;
    ibsUf: { rate: Dec; reduction: Dec; effectiveRate: Dec; value: Dec };
    ibsMun: { rate: Dec; reduction: Dec; effectiveRate: Dec; value: Dec };
    ibsValue: Dec;
    cbs: { rate: Dec; reduction: Dec; effectiveRate: Dec; value: Dec };
    informative: boolean;
  } | null;
  is: { cst: string; cclasstrib: string | null; base: Dec; rate: Dec; value: Dec } | null;
  retentions: { irrf: Dec; csll: Dec; pis: Dec; cofins: Dec; inss: Dec; iss: Dec };
}

export interface ItemResult {
  id: string;
  cfop: string;
  values: {
    product: Dec;
    discount: Dec;
    freight: Dec;
    insurance: Dec;
    otherExpenses: Dec;
    /** Valor do item que compõe o total da nota (vProd − vDesc + frete + seguro + outras + IPI + ST + FCP-ST) */
    total: Dec;
  };
  taxes: ItemTaxes;
  appliedRules: { group: RuleGroup; ruleId: string; ruleName: string }[];
  memory: MemoryLine[];
  warnings: string[];
}

export interface Totals {
  product: Dec;
  discount: Dec;
  freight: Dec;
  insurance: Dec;
  otherExpenses: Dec;
  icmsBase: Dec;
  icms: Dec;
  icmsExempt: Dec;
  fcp: Dec;
  stBase: Dec;
  st: Dec;
  fcpSt: Dec;
  difal: Dec;
  fcpDest: Dec;
  ipi: Dec;
  pis: Dec;
  cofins: Dec;
  issBase: Dec;
  iss: Dec;
  ibsCbsBase: Dec;
  ibsUf: Dec;
  ibsMun: Dec;
  ibs: Dec;
  cbs: Dec;
  is: Dec;
  simplesCredit: Dec;
  retentions: { irrf: Dec; csll: Dec; pis: Dec; cofins: Dec; inss: Dec; iss: Dec };
  /** vNF (leiaute 4.00): sem IBS/CBS */
  invoice: Dec;
  /** vNFTot (NT 2025.002): total com IBS/CBS/IS quando cobrados por fora (a partir de 2027) */
  invoiceWithNewTaxes: Dec;
}

export interface FiscalResult {
  date: string;
  interstate: boolean;
  items: ItemResult[];
  totals: Totals;
  warnings: string[];
}
