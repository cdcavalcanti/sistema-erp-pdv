import { D, ZERO, roundMoney, sum } from '@vortex/money';
import { UFS, buildAccessKey, cleanDoc, isValidIE, type UF } from '@vortex/validators';
import type { FiscalResult, ItemResult } from '@vortex/fiscal-engine';
import type { Pool } from '../../db/pool.js';
import { Tx, withTenant, type RequestContext } from '../../db/tx.js';
import { AppError, conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { enqueue } from '../../core/jobs.js';
import { auditAction, requireReason } from '../../core/audit.js';
import { randomToken } from '../../core/crypto.js';
import type { Services } from '../../services.js';
import { calculateOperation, type OperationItemRequest } from '../fiscal/engine-adapter.js';
import { buildNfeXml, type XmlItem } from './xml.js';
import { buildDpsXml } from './nfse-xml.js';
import { newNumericCode, type TransmitResult } from './gateway.js';

// ------------------------------------------------------------------ ganchos por origem do documento
export interface DocumentHooks {
  authorized?: (tx: Tx, doc: DocRow) => Promise<void>;
  /** Denegação, inutilização ou cancelamento: desfaz efeitos (estoque, títulos, contábil) */
  undone?: (tx: Tx, doc: DocRow, reason: 'denied' | 'inutilized' | 'cancelled') => Promise<void>;
}
const hooks = new Map<string, DocumentHooks>();
export function registerDocumentHooks(sourceType: string, h: DocumentHooks) {
  hooks.set(sourceType, h);
}

export type DocStatus = 'rascunho' | 'validando' | 'pendente_envio' | 'em_processamento' | 'autorizada' | 'rejeitada' | 'denegada' | 'contingencia' | 'cancelada' | 'inutilizada';
export interface DocRow {
  id: string;
  tenant_id: string;
  company_id: string;
  establishment_id: string;
  model: '55' | '65' | '99';
  status: DocStatus;
  series: number | null;
  number: string | null;
  access_key: string | null;
  numeric_code: string | null;
  environment: 1 | 2;
  emission_type: number;
  source_type: string;
  source_id: string | null;
  party_id: string | null;
  protocol: string | null;
  authorized_at: Date | null;
  total_invoice: string;
  direction: 'S' | 'E';
  [k: string]: any;
}

/** SVC-AN atende estas UFs; as demais usam SVC-RS (contingência — RN-NFE-07). */
const SVC_AN = new Set(['AC', 'AL', 'AP', 'DF', 'ES', 'MG', 'PA', 'PB', 'PI', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO']);

// ------------------------------------------------------------------ criação

export interface CreateDocumentInput {
  establishmentId: string;
  operationTypeCode: string;
  model?: '55' | '65' | '99';
  partyId?: string | null;
  recipient?: { uf: string; cityIbge?: string | null; ieIndicator: 1 | 2 | 9; finalConsumer: boolean };
  date?: string;
  presence?: number;
  header?: { freight?: string; insurance?: string; otherExpenses?: string; discount?: string };
  items: (OperationItemRequest & { unit?: string; warehouseId?: string | null; lotId?: string | null; sourceItemId?: string | null; additionalInfo?: string | null })[];
  payments?: { tPag: string; value: string; indPag?: number }[];
  installments?: { number: string; dueDate: string; amount: string }[];
  freightMode?: number;
  carrierId?: string | null;
  volumes?: unknown[];
  additionalInfo?: string | null;
  sourceType: string;
  sourceId?: string | null;
  idempotencyKey?: string | null;
}

const TAX_ROWS = (it: ItemResult) => {
  const t = it.taxes;
  const rows: { tax: string; cst: string | null; base: string; rate: string; value: string; details: Record<string, unknown> }[] = [];
  if (t.icms.cst || t.icms.csosn) {
    rows.push({ tax: 'ICMS', cst: t.icms.cst ?? t.icms.csosn, base: t.icms.base, rate: t.icms.rate, value: t.icms.value, details: {
      baseReduction: t.icms.baseReduction, operationValue: t.icms.operationValue, deferralRate: t.icms.deferralRate, deferredValue: t.icms.deferredValue,
      exemptValue: t.icms.exemptValue, exemptionReason: t.icms.exemptionReason, benefitCode: t.icms.benefitCode } });
  }
  if (D(t.icms.simplesCreditValue).greaterThan(0)) rows.push({ tax: 'ICMS_SN_CREDIT', cst: t.icms.csosn, base: t.icms.base, rate: t.icms.simplesCreditRate, value: t.icms.simplesCreditValue, details: {} });
  if (D(t.fcp.value).greaterThan(0)) rows.push({ tax: 'FCP', cst: null, ...t.fcp, details: {} });
  if (t.st) {
    rows.push({ tax: 'ICMS_ST', cst: null, base: t.st.base, rate: t.st.rate, value: t.st.value, details: { mva: t.st.mva, adjustedMva: t.st.adjustedMva, baseReduction: t.st.baseReduction, ownIcmsDeducted: t.st.ownIcmsDeducted } });
    if (D(t.st.fcp.value).greaterThan(0)) rows.push({ tax: 'FCP_ST', cst: null, ...t.st.fcp, details: {} });
  }
  if (t.difal) {
    rows.push({ tax: 'DIFAL', cst: null, base: t.difal.base, rate: t.difal.destRate, value: t.difal.value, details: { destRate: t.difal.destRate, interstateRate: t.difal.interstateRate } });
    if (D(t.difal.fcpValue).greaterThan(0)) rows.push({ tax: 'FCP_DEST', cst: null, base: t.difal.fcpBase, rate: t.difal.fcpRate, value: t.difal.fcpValue, details: {} });
  }
  if (t.ipi) rows.push({ tax: 'IPI', cst: t.ipi.cst, base: t.ipi.base, rate: t.ipi.rate, value: t.ipi.value, details: { enqCode: t.ipi.enqCode } });
  rows.push({ tax: 'PIS', cst: t.pis.cst, base: t.pis.base, rate: t.pis.rate, value: t.pis.value, details: {} });
  rows.push({ tax: 'COFINS', cst: t.cofins.cst, base: t.cofins.base, rate: t.cofins.rate, value: t.cofins.value, details: {} });
  if (t.iss) rows.push({ tax: 'ISS', cst: null, base: t.iss.base, rate: t.iss.rate, value: t.iss.value, details: { retained: t.iss.retained, exigibility: t.iss.exigibility } });
  if (t.ibsCbs) {
    const g = t.ibsCbs;
    const det = (x: { rate: string; reduction: string; effectiveRate: string }) => ({ cclasstrib: g.cclasstrib, nominalRate: x.rate, reduction: x.reduction, effectiveRate: x.effectiveRate, informative: g.informative });
    rows.push({ tax: 'IBS_UF', cst: g.cst, base: g.base, rate: g.ibsUf.effectiveRate, value: g.ibsUf.value, details: det(g.ibsUf) });
    rows.push({ tax: 'IBS_MUN', cst: g.cst, base: g.base, rate: g.ibsMun.effectiveRate, value: g.ibsMun.value, details: det(g.ibsMun) });
    rows.push({ tax: 'CBS', cst: g.cst, base: g.base, rate: g.cbs.effectiveRate, value: g.cbs.value, details: det(g.cbs) });
  }
  if (t.is) rows.push({ tax: 'IS', cst: t.is.cst, base: t.is.base, rate: t.is.rate, value: t.is.value, details: { cclasstrib: t.is.cclasstrib } });
  for (const [k, tax] of [['irrf', 'RET_IRRF'], ['csll', 'RET_CSLL'], ['pis', 'RET_PIS'], ['cofins', 'RET_COFINS'], ['inss', 'RET_INSS'], ['iss', 'RET_ISS']] as const) {
    if (D(t.retentions[k]).greaterThan(0)) rows.push({ tax, cst: null, base: it.values.product, rate: '0', value: t.retentions[k], details: {} });
  }
  return rows;
};

async function insertTaxes(tx: Tx, itemId: string, rows: ReturnType<typeof TAX_ROWS>, applied: ItemResult['appliedRules']) {
  for (const r of rows) {
    const group = r.tax === 'ICMS' || r.tax === 'FCP' ? 'icms' : r.tax === 'ICMS_ST' || r.tax === 'FCP_ST' ? 'st' : r.tax.startsWith('IBS') || r.tax === 'CBS' ? 'ibsCbs'
      : r.tax.startsWith('RET_') ? 'retentions' : r.tax.toLowerCase();
    const rule = applied.find((a) => a.group === group);
    await tx.exec(
      `INSERT INTO fiscal.document_item_taxes (tenant_id, document_item_id, tax, cst, base, rate, value, details, rule_id, rule_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tx.tenantId, itemId, r.tax, r.cst, r.base, r.rate, r.value, JSON.stringify(r.details), rule?.ruleId ?? null, rule?.ruleName ?? null]);
  }
}

function totalsColumns(t: FiscalResult['totals']) {
  return [t.product, t.discount, t.freight, t.icms, t.st, t.ipi, t.pis, t.cofins, t.ibs, t.cbs, t.invoice];
}

/** Cria o documento em rascunho com os tributos calculados pelo motor e gravados no item (RN-FIS-02). */
export async function createOutgoingDocument(tx: Tx, input: CreateDocumentInput): Promise<DocRow> {
  if (input.idempotencyKey) {
    const ex = await tx.maybeOne<DocRow>(`SELECT * FROM fiscal.documents WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (ex) return ex;
  }
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const { built, result } = await calculateOperation(tx, {
    establishmentId: input.establishmentId, operationTypeCode: input.operationTypeCode, date, partyId: input.partyId, recipient: input.recipient as never,
    presential: (input.presence ?? 1) === 1 && input.model === '65', header: input.header, items: input.items,
  });
  const est = built.establishment;
  const op = built.operationType;
  const party = built.party;
  const addr = party ? await tx.maybeOne(`SELECT * FROM registry.party_addresses WHERE party_id = $1 ORDER BY (kind = 'fiscal') DESC, is_default DESC LIMIT 1`, [party.id]) : null;
  const model = input.model ?? (['65', '99'].includes(op.fiscal_model) ? op.fiscal_model : '55');
  let series = await tx.maybeOne<{ series: number }>(
    `SELECT series FROM core.fiscal_series WHERE establishment_id = $1 AND model = $2 AND environment = $3 AND active ORDER BY series LIMIT 1`,
    [est.id, model, est.sefaz_environment]);
  if (!series && model === '99') {
    // Série da DPS (NFS-e nacional) criada no primeiro uso
    series = await tx.one<{ series: number }>(`INSERT INTO core.fiscal_series (tenant_id, company_id, establishment_id, model, series, environment) VALUES ($1,$2,$3,'99',1,$4) RETURNING series`,
      [tx.tenantId, est.company_id, est.id, est.sefaz_environment]);
  }
  if (!series) throw validation({ model: `Estabelecimento sem série ativa para o modelo ${model}` });
  const t = result.totals;
  const doc = await tx.one<DocRow>(
    `INSERT INTO fiscal.documents (tenant_id, company_id, establishment_id, model, direction, series, environment, operation_type_id, operation_code, operation_nature, purpose, presence,
       final_consumer, tax_date, regime, issuer_tax_id, issuer_name, issuer_ie, issuer_uf, party_id, recipient_tax_id, recipient_name, recipient_ie, recipient_ie_indicator, recipient_uf,
       recipient_address, recipient_email, freight_mode, carrier_id, volumes, payments, installments, additional_info, totals,
       total_products, total_discount, total_freight, total_icms, total_st, total_ipi, total_pis, total_cofins, total_ibs, total_cbs, total_invoice,
       source_type, source_id, engine_version, idempotency_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,
       $35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50) RETURNING *`,
    [tx.tenantId, est.company_id, est.id, model, op.direction, series.series, est.sefaz_environment, op.id, op.code, op.name, op.nfe_purpose, input.presence ?? (model === '65' ? 1 : 9),
      built.input.recipient.finalConsumer, date, built.regime, est.cnpj, est.legal_name, est.ie, est.uf, party?.id ?? null, party?.tax_id ?? null,
      party?.legal_name ?? null, party?.ie ?? null, built.input.recipient.ieIndicator, built.input.recipient.uf === 'EX' ? 'EX' : (party ? built.input.recipient.uf : null),
      addr ? JSON.stringify({ street: addr.street, number: addr.number, complement: addr.complement, district: addr.district, cityIbge: addr.city_ibge, cityName: addr.city_name, zip: addr.zip, countryCode: addr.country_code, foreignId: party?.foreign_id })
        : null,
      party?.xml_email ?? null, input.freightMode ?? 9, input.carrierId ?? null, JSON.stringify(input.volumes ?? []), JSON.stringify(input.payments ?? []),
      JSON.stringify(input.installments ?? []), input.additionalInfo ?? null, JSON.stringify(t), ...totalsColumns(t),
      input.sourceType, input.sourceId ?? null, '1.0.0', input.idempotencyKey ?? null, tx.userId]);
  for (const [idx, it] of result.items.entries()) {
    const req = input.items[idx]!;
    const p = built.products.get(req.productId)!;
    const taxableQty = D(req.quantity).times(p.taxable_factor).toFixed(4);
    const row = await tx.one<{ id: string }>(
      `INSERT INTO fiscal.document_items (tenant_id, document_id, item_number, product_id, sku, description, gtin, ncm, cest, origin, cfop, unit, quantity, unit_price,
         taxable_unit, taxable_quantity, taxable_unit_price, total, discount, freight, insurance, other_expenses, item_total, warehouse_id, lot_id, source_item_id,
         service_code, cclasstrib, additional_info, tax_memory, applied_rules)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) RETURNING id`,
      [tx.tenantId, doc.id, idx + 1, p.id, p.sku, p.description, p.gtin, p.ncm, p.cest, p.origin, it.cfop, req.unit ?? p.sale_unit, req.quantity, req.unitPrice,
        p.taxable_unit ?? req.unit ?? p.sale_unit, taxableQty, D(it.values.product).dividedBy(taxableQty).toFixed(10), it.values.product, it.values.discount, it.values.freight,
        it.values.insurance, it.values.otherExpenses, it.values.total, req.warehouseId ?? null, req.lotId ?? null, req.sourceItemId ?? null, p.service_code,
        built.input.items[idx]!.cclasstrib ?? null, req.additionalInfo ?? null, JSON.stringify(it.memory), JSON.stringify(it.appliedRules)]);
    await insertTaxes(tx, row.id, TAX_ROWS(it), it.appliedRules);
  }
  return doc;
}

// ------------------------------------------------------------------ validação interna e numeração

export interface ValidationIssue {
  field: string;
  message: string;
}

/** RN-NFE-02: erro previsível nunca deve chegar à SEFAZ. */
export async function validateDocument(tx: Tx, doc: DocRow): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const items = await tx.query(`SELECT * FROM fiscal.document_items WHERE document_id = $1 ORDER BY item_number`, [doc.id]);
  if (!items.length) issues.push({ field: 'items', message: 'Documento sem itens' });
  const est = await tx.one(`SELECT * FROM core.establishments WHERE id = $1`, [doc.establishment_id]);
  // Totais fechando
  const sumProd = sum(items.map((i) => i.total));
  if (!sumProd.equals(doc.total_products)) issues.push({ field: 'totals.product', message: 'Soma dos itens difere do total dos produtos' });
  const sumItems = sum(items.map((i) => i.item_total));
  if (!sumItems.equals(doc.total_invoice)) issues.push({ field: 'totals.invoice', message: 'Soma dos itens difere do total da nota' });
  for (const it of items) {
    if (!roundMoney(D(it.quantity).times(it.unit_price)).equals(it.total)) issues.push({ field: `items.${it.item_number}.total`, message: 'Quantidade × valor unitário difere do valor do item' });
    // CFOP compatível com a UF de destino
    const expected = doc.direction === 'S' ? (doc.recipient_uf === 'EX' ? '7' : !doc.recipient_uf || doc.recipient_uf === doc.issuer_uf ? '5' : '6')
      : (doc.recipient_uf === 'EX' ? '3' : !doc.recipient_uf || doc.recipient_uf === doc.issuer_uf ? '1' : '2');
    if (it.cfop[0] !== expected) issues.push({ field: `items.${it.item_number}.cfop`, message: `CFOP ${it.cfop} incompatível com a UF de destino` });
    // NCM vigente
    if (it.ncm) {
      const ok = await tx.maybeOne(`SELECT 1 FROM fiscal.ncm WHERE code = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2)`, [it.ncm, doc.tax_date]);
      if (!ok) issues.push({ field: `items.${it.item_number}.ncm`, message: `NCM ${it.ncm} não vigente na data` });
    } else if (!it.service_code) {
      issues.push({ field: `items.${it.item_number}.ncm`, message: 'NCM obrigatório' });
    }
    // CST coerente com o regime
    const icms = await tx.maybeOne<{ cst: string }>(`SELECT cst FROM fiscal.document_item_taxes WHERE document_item_id = $1 AND tax = 'ICMS'`, [it.id]);
    const simples = ['simples_nacional', 'mei', 'simples_excesso_sublimite'].includes(doc.regime);
    if (icms && simples !== (icms.cst.length === 3)) issues.push({ field: `items.${it.item_number}.icms`, message: simples ? 'Emitente do Simples deve usar CSOSN' : 'Regime normal deve usar CST' });
  }
  // IE do destinatário contribuinte
  if (doc.recipient_ie_indicator === 1) {
    if (!doc.recipient_ie || !doc.recipient_uf || doc.recipient_uf === 'EX' || !isValidIE(doc.recipient_ie, doc.recipient_uf as UF)) {
      issues.push({ field: 'recipient.ie', message: 'IE do destinatário inválida para a UF' });
    }
  }
  if (doc.model === '55' && !doc.recipient_tax_id && doc.recipient_uf !== 'EX') issues.push({ field: 'recipient', message: 'NF-e exige destinatário identificado' });
  // Ajuste SINIEF 11/2025: venda presencial a pessoa jurídica em NF-e, não em NFC-e
  if (doc.model === '65' && doc.recipient_tax_id && cleanDoc(doc.recipient_tax_id).length === 14) issues.push({ field: 'model', message: 'Venda a pessoa jurídica deve ser feita em NF-e (modelo 55), não em NFC-e' });
  if (est.sefaz_environment !== doc.environment) issues.push({ field: 'environment', message: 'Ambiente do documento difere do estabelecimento' });
  // Pagamentos (detPag) fecham com o total
  const pays = (doc.payments ?? []) as { value: string; tPag: string }[];
  if (pays.length && pays.every((p) => p.tPag !== '90') && sum(pays.map((p) => p.value)).lessThan(doc.total_invoice)) {
    issues.push({ field: 'payments', message: 'Pagamentos não cobrem o total da nota' });
  }
  return issues;
}

/**
 * RN-NFE-01: numeração sequencial por estabelecimento, modelo e série, reservada com
 * bloqueio de linha. O número nunca é reaproveitado.
 */
async function reserveNumber(tx: Tx, doc: DocRow): Promise<number> {
  const r = await tx.one<{ n: string }>(
    `UPDATE core.fiscal_series SET next_number = next_number + 1
      WHERE establishment_id = $1 AND model = $2 AND series = $3 AND environment = $4 AND active
      RETURNING next_number - 1 AS n`,
    [doc.establishment_id, doc.model, doc.series, doc.environment]);
  return Number(r.n);
}

function emissionTypeForContingency(uf: string, model: string): number {
  if (model === '65') return 9;
  return SVC_AN.has(uf) ? 6 : 7;
}

async function setKey(_tx: Tx, doc: DocRow, emissionType: number) {
  const issuedAt = new Date();
  const cNF = doc.numeric_code ?? newNumericCode();
  const key = buildAccessKey({
    cUF: UFS[doc.issuer_uf as UF],
    aamm: `${String(issuedAt.getFullYear()).slice(2)}${String(issuedAt.getMonth() + 1).padStart(2, '0')}`,
    cnpj: doc.issuer_tax_id, modelo: doc.model, serie: doc.series!, numero: Number(doc.number), tpEmis: String(emissionType), cNF,
  });
  return { key, cNF, issuedAt };
}

/** Rascunho → validando → pendente_envio (com número e chave). */
export async function prepareForTransmission(tx: Tx, docId: string): Promise<DocRow> {
  let doc = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1 FOR UPDATE`, [docId], 'Documento fiscal');
  if (doc.status === 'pendente_envio' || doc.status === 'contingencia') return doc;
  if (doc.status === 'rejeitada') doc = await tx.one<DocRow>(`UPDATE fiscal.documents SET status = 'rascunho' WHERE id = $1 RETURNING *`, [docId]);
  if (doc.status !== 'rascunho') throw conflict('INVALID_STATUS', `Documento em situação "${doc.status}" não pode ser enviado`);
  await tx.exec(`UPDATE fiscal.documents SET status = 'validando' WHERE id = $1`, [docId]);
  const issues = await validateDocument(tx, doc);
  if (issues.length) {
    // A validação falhou: o documento volta a rascunho dentro do mesmo SAVEPOINT do chamador
    throw new AppError('DOCUMENT_INVALID', 'O documento tem pendências e não foi enviado à SEFAZ', 422, { rule: 'RN-NFE-02', issues });
  }
  const number = doc.number ? Number(doc.number) : await reserveNumber(tx, doc);
  if (doc.model === '99') {
    // NFS-e nacional: a DPS tem série/número próprios; a chave de 50 dígitos vem do Sefin Nacional
    return tx.one<DocRow>(`UPDATE fiscal.documents SET status = 'pendente_envio', number = $2, issued_at = coalesce(issued_at, now()), public_token = coalesce(public_token, $3) WHERE id = $1 RETURNING *`,
      [docId, number, randomToken(18)]);
  }
  const withNumber = { ...doc, number: String(number) };
  const { key, cNF, issuedAt } = doc.access_key ? { key: doc.access_key, cNF: doc.numeric_code!, issuedAt: new Date() } : await setKey(tx, withNumber, doc.emission_type);
  return tx.one<DocRow>(
    `UPDATE fiscal.documents SET status = 'pendente_envio', number = $2, access_key = $3, numeric_code = $4, issued_at = coalesce(issued_at, $5), exit_at = coalesce(exit_at, $5),
            public_token = coalesce(public_token, $6) WHERE id = $1 RETURNING *`,
    [docId, number, key, cNF, issuedAt, randomToken(18)]);
}

// ------------------------------------------------------------------ transmissão (fora da transação de negócio)

async function loadXmlData(tx: Tx, doc: DocRow) {
  const issuer = await tx.one(`SELECT * FROM core.establishments WHERE id = $1`, [doc.establishment_id]);
  const items = await tx.query(`SELECT i.*, o.item_number AS original_item_number, od.access_key AS original_access_key
                                  FROM fiscal.document_items i LEFT JOIN fiscal.document_items o ON o.id = i.original_item_id LEFT JOIN fiscal.documents od ON od.id = o.document_id
                                 WHERE i.document_id = $1 ORDER BY i.item_number`, [doc.id]);
  const taxes = await tx.query(`SELECT * FROM fiscal.document_item_taxes WHERE document_item_id = ANY($1)`, [items.map((i) => i.id)]);
  const refs = await tx.query<{ referenced_access_key: string }>(`SELECT referenced_access_key FROM fiscal.document_references WHERE document_id = $1`, [doc.id]);
  const xmlItems: XmlItem[] = items.map((i) => ({ ...i, taxes: taxes.filter((t) => t.document_item_id === i.id) }));
  return { issuer, items: xmlItems, refs: refs.map((r) => r.referenced_access_key) };
}

function renderXml(doc: DocRow, data: Awaited<ReturnType<typeof loadXmlData>>): string {
  return buildNfeXml({
    access_key: doc.access_key!, numeric_code: doc.numeric_code!, model: doc.model, series: doc.series!, number: Number(doc.number), operation_nature: doc.operation_nature,
    issued_at: new Date(doc.issued_at).toISOString().replace(/\.\d{3}Z$/, '-00:00'), exit_at: doc.exit_at ? new Date(doc.exit_at).toISOString().replace(/\.\d{3}Z$/, '-00:00') : null,
    direction: doc.direction, purpose: doc.purpose, presence: doc.presence, final_consumer: doc.final_consumer, environment: doc.environment, emission_type: doc.emission_type,
    contingency_reason: doc.contingency_reason, contingency_at: doc.contingency_at ? new Date(doc.contingency_at).toISOString().replace(/\.\d{3}Z$/, '-00:00') : null, regime: doc.regime,
    recipient_tax_id: doc.recipient_tax_id, recipient_name: doc.recipient_name, recipient_ie: doc.recipient_ie, recipient_ie_indicator: doc.recipient_ie_indicator,
    recipient_uf: doc.recipient_uf, recipient_address: doc.recipient_address, recipient_email: doc.recipient_email, freight_mode: doc.freight_mode, volumes: doc.volumes,
    payments: doc.payments, installments: doc.installments, additional_info: doc.additional_info, totals: doc.totals, references: data.refs,
  }, data.issuer, data.items);
}

export interface TransmitOutcome {
  status: DocStatus;
  sefazCode: string | null;
  message: string | null;
  explanation?: string | null;
  protocol?: string | null;
}

/**
 * Envia à SEFAZ (via FiscalGateway). Fail-safe (RN-GER-10): sem protocolo, nunca
 * marca como autorizada; com a SEFAZ fora, entra em contingência e o job reenvia.
 */
export async function transmitDocument(pool: Pool, ctx: RequestContext, services: Services, docId: string): Promise<TransmitOutcome> {
  const gw = services.fiscalGateway;
  const model = await withTenant(pool, ctx, (tx) => tx.one<{ model: string }>(`SELECT model FROM fiscal.documents WHERE id = $1`, [docId], 'Documento fiscal'), { readOnly: true });
  if (model.model === '99') return transmitNfse(pool, ctx, services, docId);
  const prepared = await withTenant(pool, ctx, async (tx) => {
    const doc = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1 FOR UPDATE`, [docId], 'Documento fiscal');
    if (doc.status === 'autorizada') return { doc, xml: null, already: true };
    if (doc.status === 'em_processamento') {
      // Consulta pela chave em vez de reenviar (evita duplicidade)
      return { doc, xml: null, already: false, query: true };
    }
    if (!['pendente_envio', 'contingencia'].includes(doc.status)) throw conflict('INVALID_STATUS', `Documento em situação "${doc.status}" não pode ser transmitido`);
    const data = await loadXmlData(tx, doc);
    const xml = renderXml(doc, data);
    const stored = await services.storage.putImmutable(`nfe/${doc.tenant_id}/${doc.access_key}/envio-${doc.attempts + 1}.xml`, xml, 'application/xml');
    await tx.exec(`UPDATE fiscal.documents SET status = 'em_processamento', attempts = attempts + 1, xml_key = $2, xml_sha256 = $3, gateway = $4 WHERE id = $1`,
      [docId, stored.key, stored.sha256, gw.name]);
    await tx.exec(`INSERT INTO fiscal.document_events (tenant_id, document_id, kind, status, payload, xml_key, created_by) VALUES ($1,$2,'transmission','sent',$3,$4,$5)`,
      [tx.tenantId, docId, JSON.stringify({ attempt: doc.attempts + 1, emissionType: doc.emission_type }), stored.key, tx.userId]);
    return { doc, xml, already: false, data };
  });
  if (prepared.already) return { status: 'autorizada', sefazCode: '100', message: 'Já autorizada', protocol: prepared.doc.protocol };
  const doc = prepared.doc;
  let result: TransmitResult;
  if ('query' in prepared && prepared.query) {
    result = await gw.query(doc.access_key!, doc.environment);
    if (result.status === 'rejected' && result.code === '217') {
      // Não chegou à SEFAZ: volta para envio
      await withTenant(pool, ctx, (tx) => tx.exec(`UPDATE fiscal.documents SET status = 'contingencia', contingency_reason = 'Reenvio após falha de comunicação', contingency_at = now() WHERE id = $1 AND status = 'em_processamento'`, [docId]));
      return transmitDocument(pool, ctx, services, docId);
    }
  } else {
    result = await gw.transmit({
      documentId: doc.id, accessKey: doc.access_key!, model: doc.model as '55' | '65', environment: doc.environment, uf: doc.issuer_uf, issuerCnpj: doc.issuer_tax_id,
      emissionType: doc.emission_type, xml: prepared.xml!, payload: { xml: prepared.xml },
    });
    if (result.status === 'rejected' && result.code === '204') result = await gw.query(doc.access_key!, doc.environment);
  }
  const outcome = await withTenant(pool, ctx, (tx) => applyTransmitResult(tx, services, docId, result));
  // SEFAZ autorizadora fora: tenta imediatamente a SVC; se também falhar, o job reenvia
  if (outcome.status === 'contingencia' && doc.emission_type === 1) {
    return transmitDocument(pool, ctx, services, docId);
  }
  return outcome;
}

/** NFS-e padrão nacional: DPS → Sefin Nacional; a resposta segue o mesmo tratamento da NF-e. */
async function transmitNfse(pool: Pool, ctx: RequestContext, services: Services, docId: string): Promise<TransmitOutcome> {
  const prepared = await withTenant(pool, ctx, async (tx) => {
    let doc = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1 FOR UPDATE`, [docId], 'Documento fiscal');
    if (doc.status === 'autorizada') return { doc, xml: null as string | null, issuer: null as Record<string, any> | null };
    if (doc.status === 'rascunho' || doc.status === 'rejeitada') doc = await prepareForTransmission(tx, docId);
    if (!['pendente_envio', 'contingencia', 'em_processamento'].includes(doc.status)) throw conflict('INVALID_STATUS', `Documento em situação "${doc.status}" não pode ser transmitido`);
    const data = await loadXmlData(tx, doc);
    let xml: string;
    try {
      xml = buildDpsXml(doc, data.issuer, data.items as never);
    } catch (e) {
      throw validation({ items: (e as Error).message });
    }
    const stored = await services.storage.putImmutable(`nfse/${doc.tenant_id}/${doc.id}/dps-${doc.attempts + 1}.xml`, xml, 'application/xml');
    await tx.exec(`UPDATE fiscal.documents SET status = 'em_processamento', attempts = attempts + 1, xml_key = $2, xml_sha256 = $3, gateway = $4 WHERE id = $1`,
      [docId, stored.key, stored.sha256, services.fiscalGateway.name]);
    await tx.exec(`INSERT INTO fiscal.document_events (tenant_id, document_id, kind, status, payload, xml_key, created_by) VALUES ($1,$2,'transmission','sent',$3,$4,$5)`,
      [tx.tenantId, docId, JSON.stringify({ attempt: doc.attempts + 1, dps: true }), stored.key, tx.userId]);
    return { doc, xml, issuer: data.issuer };
  });
  if (!prepared.xml) return { status: 'autorizada', sefazCode: '100', message: 'Já autorizada', protocol: prepared.doc.protocol };
  const doc = prepared.doc;
  const r = await services.fiscalGateway.transmitNfse({ documentId: doc.id, environment: doc.environment, issuerCnpj: doc.issuer_tax_id, cityIbge: prepared.issuer!.city_ibge,
    series: doc.series!, number: Number(doc.number), xml: prepared.xml, payload: { dps: prepared.xml } });
  return withTenant(pool, ctx, async (tx) => {
    if (r.status === 'authorized') {
      await tx.exec(`UPDATE fiscal.documents SET nfse_key = $2, nfse_number = $3, nfse_verification_code = $4 WHERE id = $1`, [docId, r.nfseKey ?? null, r.nfseNumber ?? null, r.verificationCode ?? null]);
    }
    return applyTransmitResult(tx, services, docId, r);
  });
}

export async function applyTransmitResult(tx: Tx, services: Services, docId: string, r: TransmitResult): Promise<TransmitOutcome> {
  const doc = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1 FOR UPDATE`, [docId]);
  const explain = async (code: string) => (await tx.maybeOne<{ explanation: string; action: string }>(`SELECT explanation, action FROM fiscal.rejection_catalog WHERE code = $1`, [code]))
    ?? (await tx.one<{ explanation: string; action: string }>(`SELECT explanation, action FROM fiscal.rejection_catalog WHERE code = '999'`));
  const event = (kind: string, status: string, extra: Record<string, unknown> = {}, xmlKey: string | null = null) =>
    tx.exec(`INSERT INTO fiscal.document_events (tenant_id, document_id, kind, status, protocol, sefaz_code, message, payload, xml_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tx.tenantId, docId, kind, status, r.protocol ?? null, r.code, r.message, JSON.stringify(extra), xmlKey, tx.userId]);
  switch (r.status) {
    case 'authorized': {
      const ref = doc.access_key ?? doc.nfse_key ?? doc.id;
      const stored = await services.storage.putImmutable(doc.model === '99' ? `nfse/${doc.tenant_id}/${doc.id}/${ref}-NFSe.xml` : `nfe/${doc.tenant_id}/${ref}/${ref}-procNFe.xml`,
        r.authorizedXml ?? '', 'application/xml');
      await tx.exec(
        `UPDATE fiscal.documents SET status = 'autorizada', protocol = $2, authorized_at = coalesce($3::timestamptz, now()), sefaz_code = $4, sefaz_message = $5,
                authorized_xml_key = $6, xml_sha256 = $7, rejection_explanation = NULL WHERE id = $1`,
        [docId, r.protocol, r.authorizedAt ?? null, r.code, r.message, stored.key, stored.sha256]);
      await event('authorization', 'authorized', {}, stored.key);
      const updated = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [docId]);
      await emit(tx, 'nota.autorizada', { type: 'fiscal_document', id: docId }, { id: docId, chave: doc.access_key ?? doc.nfse_key, numero: doc.nfse_number ?? doc.number, serie: doc.series, modelo: doc.model, total: doc.total_invoice, origem: doc.source_type, origemId: doc.source_id });
      await enqueue(tx, 'nota.enviar_destinatario', { documentId: docId }, { dedupeKey: docId });
      await hooks.get(doc.source_type)?.authorized?.(tx, updated);
      return { status: 'autorizada', sefazCode: r.code, message: r.message, protocol: r.protocol };
    }
    case 'rejected': {
      // RN-NFE-03: volta ao usuário com código, mensagem e explicação em português; mantém o número
      const ex = await explain(r.code);
      await tx.exec(`UPDATE fiscal.documents SET status = 'rejeitada', sefaz_code = $2, sefaz_message = $3, rejection_explanation = $4 WHERE id = $1`,
        [docId, r.code, r.message, `${ex.explanation} ${ex.action}`]);
      await event('rejection', 'rejected');
      await emit(tx, 'nota.rejeitada', { type: 'fiscal_document', id: docId }, { id: docId, codigo: r.code, mensagem: r.message });
      return { status: 'rejeitada', sefazCode: r.code, message: r.message, explanation: `${ex.explanation} ${ex.action}` };
    }
    case 'denied': {
      // RN-NFE-04: denegação encerra a numeração; os itens voltam ao pedido
      const ex = await explain(r.code);
      const stored = r.authorizedXml ? await services.storage.putImmutable(`nfe/${doc.tenant_id}/${doc.access_key}/${doc.access_key}-denegada.xml`, r.authorizedXml, 'application/xml') : null;
      await tx.exec(`UPDATE fiscal.documents SET status = 'denegada', protocol = $2, sefaz_code = $3, sefaz_message = $4, rejection_explanation = $5, authorized_xml_key = $6 WHERE id = $1`,
        [docId, r.protocol ?? null, r.code, r.message, `${ex.explanation} ${ex.action}`, stored?.key ?? null]);
      await event('denial', 'denied', {}, stored?.key ?? null);
      await emit(tx, 'nota.denegada', { type: 'fiscal_document', id: docId }, { id: docId, codigo: r.code });
      await undoDocumentEffects(tx, await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [docId]), 'denied');
      return { status: 'denegada', sefazCode: r.code, message: r.message, explanation: ex.explanation };
    }
    case 'processing':
      await enqueue(tx, 'nota.consultar', { documentId: docId }, { runAt: new Date(Date.now() + 30_000), dedupeKey: `q:${docId}`, queue: 'fiscal' });
      return { status: 'em_processamento', sefazCode: r.code, message: r.message };
    case 'unavailable': {
      // RN-NFE-07 / RN-GER-10: contingência (SVC para NF-e, offline para NFC-e)
      if (doc.emission_type === 1 && doc.model !== '99') {
        const tpEmis = emissionTypeForContingency(doc.issuer_uf, doc.model);
        const { key } = await setKey(tx, { ...doc, emission_type: tpEmis }, tpEmis);
        await tx.exec(`UPDATE fiscal.documents SET status = 'contingencia', emission_type = $2, access_key = $3, contingency_reason = $4, contingency_at = now() WHERE id = $1`,
          [docId, tpEmis, key, `SEFAZ autorizadora indisponível: ${r.message}`.slice(0, 256)]);
        await emit(tx, 'fiscal.contingencia', { type: 'fiscal_document', id: docId }, { id: docId, tpEmis, motivo: r.message });
      } else {
        await tx.exec(`UPDATE fiscal.documents SET status = 'contingencia' WHERE id = $1`, [docId]);
      }
      await event('contingency', 'pending', { message: r.message });
      await enqueue(tx, 'nota.transmitir', { documentId: docId }, { runAt: new Date(Date.now() + 120_000), dedupeKey: `t:${docId}`, queue: 'fiscal' });
      return { status: 'contingencia', sefazCode: r.code, message: 'SEFAZ indisponível: documento em contingência, será transmitido automaticamente' };
    }
  }
}

export async function undoDocumentEffects(tx: Tx, doc: DocRow, reason: 'denied' | 'inutilized' | 'cancelled') {
  // Devolução: libera o saldo devolvido do documento original
  const items = await tx.query<{ original_item_id: string | null; quantity: string }>(`SELECT original_item_id, quantity FROM fiscal.document_items WHERE document_id = $1`, [doc.id]);
  for (const it of items) {
    if (it.original_item_id) await tx.exec(`UPDATE fiscal.document_items SET returned_quantity = returned_quantity - $2 WHERE id = $1`, [it.original_item_id, it.quantity]);
  }
  await hooks.get(doc.source_type)?.undone?.(tx, doc, reason);
}

// ------------------------------------------------------------------ cancelamento (RN-NFE-05)

export async function cancelDocument(pool: Pool, ctx: RequestContext, services: Services, docId: string, input: { reason: string; goodsDidNotCirculate: boolean; extemporaneous?: boolean }) {
  const doc = await withTenant(pool, ctx, async (tx) => {
    const d = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [docId], 'Documento fiscal');
    if (d.status !== 'autorizada') throw conflict('INVALID_STATUS', 'Somente documento autorizado pode ser cancelado');
    if (input.reason.trim().length < 15 || input.reason.length > 255) throw validation({ reason: 'Justificativa entre 15 e 255 caracteres' });
    const settings = (await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [d.company_id])).settings;
    const hours = Number(settings?.fiscal?.cancelHours ?? 24);
    const within = d.authorized_at && Date.now() - new Date(d.authorized_at).getTime() <= hours * 3_600_000;
    if (!input.goodsDidNotCirculate && d.model !== '99') throw ruleViolation('RN-NFE-05', 'Cancelamento só é permitido se a mercadoria não circulou; use nota de devolução/entrada');
    if (!within) {
      const ufs: string[] = settings?.fiscal?.extemporaneousCancelUfs ?? [];
      if (!(input.extemporaneous && ufs.includes(d.issuer_uf))) {
        throw ruleViolation('RN-NFE-05', `Prazo de cancelamento (${hours} h) encerrado; emita nota de entrada/devolução ou use o cancelamento extemporâneo conforme a UF`);
      }
    }
    return d;
  });
  const r = doc.model === '99'
    ? await services.fiscalGateway.cancelNfse({ nfseKey: doc.nfse_key!, reason: input.reason, environment: doc.environment, issuerCnpj: doc.issuer_tax_id })
    : await services.fiscalGateway.cancel({ accessKey: doc.access_key!, protocol: doc.protocol!, reason: input.reason, environment: doc.environment, issuerCnpj: doc.issuer_tax_id });
  return withTenant(pool, ctx, async (tx) => {
    if (r.status !== 'registered') {
      await tx.exec(`INSERT INTO fiscal.document_events (tenant_id, document_id, kind, status, sefaz_code, message, created_by) VALUES ($1,$2,'cancellation','rejected',$3,$4,$5)`,
        [tx.tenantId, docId, r.code, r.message, tx.userId]);
      throw new AppError('SEFAZ_REJECTED', `SEFAZ recusou o cancelamento: ${r.message}`, 422, { sefazCode: r.code });
    }
    await requireReason(tx, input.reason, 'fiscal.nota.cancelar');
    await tx.exec(`UPDATE fiscal.documents SET status = 'cancelada', cancelled_at = now(), cancel_protocol = $2, cancel_reason = $3 WHERE id = $1`, [docId, r.protocol, input.reason]);
    await tx.exec(`INSERT INTO fiscal.document_events (tenant_id, document_id, kind, status, protocol, sefaz_code, message, payload, created_by) VALUES ($1,$2,'cancellation','registered',$3,$4,$5,$6,$7)`,
      [tx.tenantId, docId, r.protocol, r.code, r.message, JSON.stringify({ reason: input.reason, extemporaneous: Boolean(input.extemporaneous) }), tx.userId]);
    await emit(tx, 'nota.cancelada', { type: 'fiscal_document', id: docId }, { id: docId, chave: doc.access_key, motivo: input.reason });
    // Estorna estoque, título e lançamento contábil automaticamente
    await undoDocumentEffects(tx, await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [docId]), 'cancelled');
    return { status: 'cancelada', protocol: r.protocol };
  });
}

// ------------------------------------------------------------------ carta de correção (RN-NFE-06)

/** Campos que a CC-e pode corrigir. Valores, impostos, quantidades, remetente/destinatário e datas não. */
export const CCE_ALLOWED_FIELDS: Record<string, string> = {
  transportadora: 'Dados da transportadora',
  volumes: 'Quantidade, espécie e peso dos volumes',
  dados_adicionais: 'Informações complementares',
  endereco_entrega: 'Endereço de entrega (sem mudar o destinatário)',
  cfop: 'CFOP (sem alteração de imposto)',
  descricao_produto: 'Descrição do produto',
  codigo_produto: 'Código do produto',
  pedido_cliente: 'Número do pedido do cliente',
  natureza_operacao: 'Natureza da operação (sem alteração de imposto)',
};
export const CCE_FORBIDDEN = ['valor', 'preco', 'quantidade', 'imposto', 'aliquota', 'base', 'cnpj', 'cpf', 'destinatario', 'remetente', 'data_emissao', 'data_saida', 'ie'];

export async function correctionLetter(pool: Pool, ctx: RequestContext, services: Services, docId: string, corrections: { field: string; text: string }[]) {
  const prep = await withTenant(pool, ctx, async (tx) => {
    const d = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [docId], 'Documento fiscal');
    if (d.status !== 'autorizada') throw conflict('INVALID_STATUS', 'CC-e só para documento autorizado');
    if (d.model !== '55') throw validation({ model: 'CC-e não se aplica a NFC-e' });
    if (d.correction_count >= 20) throw ruleViolation('RN-NFE-06', 'Limite de 20 cartas de correção atingido');
    for (const c of corrections) {
      if (!CCE_ALLOWED_FIELDS[c.field] || CCE_FORBIDDEN.some((f) => c.field.includes(f))) {
        throw ruleViolation('RN-NFE-06', `Campo "${c.field}" não pode ser corrigido por CC-e (valores, impostos, quantidades, remetente/destinatário e datas são vedados)`);
      }
    }
    // Cada nova CC-e substitui a anterior: consolida as correções anteriores com as novas
    const prev = await tx.query<{ payload: { corrections: { field: string; text: string }[] } }>(
      `SELECT payload FROM fiscal.document_events WHERE document_id = $1 AND kind = 'correction_letter' AND status = 'registered' ORDER BY sequence DESC LIMIT 1`, [docId]);
    const merged = new Map<string, string>((prev[0]?.payload.corrections ?? []).map((c) => [c.field, c.text]));
    for (const c of corrections) merged.set(c.field, c.text);
    const all = [...merged.entries()].map(([field, text]) => ({ field, text }));
    const text = all.map((c) => `${CCE_ALLOWED_FIELDS[c.field]}: ${c.text}`).join('; ');
    if (text.length < 15 || text.length > 1000) throw validation({ corrections: 'Texto da correção deve ter entre 15 e 1000 caracteres' });
    return { d, all, text, sequence: d.correction_count + 1 };
  });
  const r = await services.fiscalGateway.correctionLetter({ accessKey: prep.d.access_key!, sequence: prep.sequence, text: prep.text, environment: prep.d.environment, issuerCnpj: prep.d.issuer_tax_id });
  return withTenant(pool, ctx, async (tx) => {
    await tx.exec(`INSERT INTO fiscal.document_events (tenant_id, document_id, kind, sequence, status, protocol, sefaz_code, message, payload, created_by) VALUES ($1,$2,'correction_letter',$3,$4,$5,$6,$7,$8,$9)`,
      [tx.tenantId, docId, prep.sequence, r.status === 'registered' ? 'registered' : 'rejected', r.protocol ?? null, r.code, r.message, JSON.stringify({ corrections: prep.all, text: prep.text }), tx.userId]);
    if (r.status !== 'registered') throw new AppError('SEFAZ_REJECTED', `SEFAZ recusou a CC-e: ${r.message}`, 422, { sefazCode: r.code });
    await tx.exec(`UPDATE fiscal.documents SET correction_count = $2 WHERE id = $1`, [docId, prep.sequence]);
    return { sequence: prep.sequence, text: prep.text, protocol: r.protocol };
  });
}

// ------------------------------------------------------------------ inutilização (RN-NFE-01)

export async function inutilizeNumbers(pool: Pool, ctx: RequestContext, services: Services, input: { establishmentId: string; model: '55' | '65'; series: number; from: number; to: number; reason: string }) {
  const prep = await withTenant(pool, ctx, async (tx) => {
    const est = await tx.one(`SELECT * FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
    if (input.reason.trim().length < 15) throw validation({ reason: 'Justificativa com no mínimo 15 caracteres' });
    const serie = await tx.one<{ next_number: string }>(`SELECT next_number FROM core.fiscal_series WHERE establishment_id = $1 AND model = $2 AND series = $3 AND environment = $4`,
      [input.establishmentId, input.model, input.series, est.sefaz_environment], 'Série');
    if (input.to >= Number(serie.next_number)) throw validation({ to: 'Só é possível inutilizar números já reservados (menores que o próximo número da série)' });
    const used = await tx.query(`SELECT number, status FROM fiscal.documents WHERE establishment_id = $1 AND model = $2 AND series = $3 AND number BETWEEN $4 AND $5 AND environment = $6
                                   AND status NOT IN ('rascunho', 'rejeitada')`, [input.establishmentId, input.model, input.series, input.from, input.to, est.sefaz_environment]);
    if (used.length) throw conflict('NUMBER_IN_USE', `Números já usados por documentos ${used.map((u) => `${u.number} (${u.status})`).join(', ')}`);
    return est;
  });
  const r = await services.fiscalGateway.inutilize({ issuerCnpj: prep.cnpj, uf: prep.uf, model: input.model, series: input.series, from: input.from, to: input.to,
    year: new Date().getFullYear() % 100, reason: input.reason, environment: prep.sefaz_environment });
  return withTenant(pool, ctx, async (tx) => {
    const row = await tx.one(
      `INSERT INTO fiscal.inutilizations (tenant_id, establishment_id, model, series, number_from, number_to, year, reason, status, protocol, sefaz_message, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tx.tenantId, input.establishmentId, input.model, input.series, input.from, input.to, new Date().getFullYear(), input.reason, r.status === 'registered' ? 'done' : 'rejected', r.protocol ?? null, r.message, tx.userId]);
    if (r.status !== 'registered') throw new AppError('SEFAZ_REJECTED', `SEFAZ recusou a inutilização: ${r.message}`, 422, { sefazCode: r.code });
    const docs = await tx.query<DocRow>(`UPDATE fiscal.documents SET status = 'inutilizada' WHERE establishment_id = $1 AND model = $2 AND series = $3 AND number BETWEEN $4 AND $5
                                           AND status IN ('rascunho','rejeitada') RETURNING *`, [input.establishmentId, input.model, input.series, input.from, input.to]);
    for (const d of docs) {
      await tx.exec(`INSERT INTO fiscal.document_events (tenant_id, document_id, kind, status, protocol, message, created_by) VALUES ($1,$2,'inutilization','registered',$3,$4,$5)`,
        [tx.tenantId, d.id, r.protocol, input.reason, tx.userId]);
      await undoDocumentEffects(tx, d, 'inutilized');
    }
    await auditAction(tx, { action: 'fiscal.numeracao.inutilizada', table: 'fiscal.inutilizations', recordId: row.id, reason: input.reason, sensitive: true });
    return row;
  });
}

// ------------------------------------------------------------------ devolução (RN-NFE-09)

/** CFOP de devolução a partir do CFOP original (venda → entrada de devolução; compra → saída de devolução). */
export function returnCfop(original: string): string {
  const map: Record<string, string> = {
    '5101': '1201', '5102': '1202', '6101': '2201', '6102': '2202', '6107': '2201', '6108': '2202', '5405': '1411', '6404': '2411', '5403': '1411', '6403': '2411',
    '5401': '1410', '6401': '2410', '1101': '5201', '1102': '5202', '2101': '6201', '2102': '6202', '1403': '5411', '2403': '6411', '1556': '5556', '2556': '6556',
  };
  const r = map[original];
  if (!r) throw ruleViolation('RN-NFE-09', `Sem CFOP de devolução mapeado para ${original}`);
  return r;
}

/**
 * Nasce do documento original, item a item, limitado ao saldo ainda não devolvido;
 * tributos espelhados proporcionalmente (não recalculados) e referência por item.
 */
export async function createReturnDocument(tx: Tx, input: { originalDocumentId: string; items: { originalItemId: string; quantity: string; warehouseId?: string | null }[];
  reason: string; sourceType: string; sourceId?: string | null; operationTypeCode?: string; idempotencyKey?: string | null }): Promise<DocRow> {
  if (input.idempotencyKey) {
    const ex = await tx.maybeOne<DocRow>(`SELECT * FROM fiscal.documents WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (ex) return ex;
  }
  const orig = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [input.originalDocumentId], 'Documento original');
  if (orig.status !== 'autorizada') throw ruleViolation('RN-NFE-09', 'Devolução só a partir de documento autorizado');
  const isSaleReturn = orig.direction === 'S';
  const opCode = input.operationTypeCode ?? (isSaleReturn ? 'DEV_VENDA' : 'DEV_COMPRA');
  const op = await tx.one(`SELECT * FROM fiscal.operation_types WHERE code = $1`, [opCode], 'Tipo de operação de devolução');
  const est = await tx.one(`SELECT * FROM core.establishments WHERE id = $1`, [orig.establishment_id]);
  const regime = (await tx.one<{ regime: string }>(`SELECT regime FROM core.establishment_tax_regimes WHERE establishment_id = $1 AND valid_from <= current_date AND (valid_to IS NULL OR valid_to >= current_date)`, [est.id])).regime;
  const series = await tx.one<{ series: number }>(`SELECT series FROM core.fiscal_series WHERE establishment_id = $1 AND model = '55' AND environment = $2 AND active ORDER BY series LIMIT 1`,
    [est.id, est.sefaz_environment], 'Série de NF-e');
  // Nota de terceiro (compra): a contraparte da devolução é o emitente original (fornecedor)
  let counterparty = { taxId: orig.recipient_tax_id, name: orig.recipient_name, ie: orig.recipient_ie, ieIndicator: orig.recipient_ie_indicator, uf: orig.recipient_uf,
    address: orig.recipient_address as unknown, email: orig.recipient_email as string | null };
  if (orig.issuer_kind === 'third_party') {
    const addr = orig.party_id ? await tx.maybeOne(`SELECT * FROM registry.party_addresses WHERE party_id = $1 ORDER BY (kind = 'fiscal') DESC, is_default DESC LIMIT 1`, [orig.party_id]) : null;
    const party = orig.party_id ? await tx.maybeOne<{ xml_email: string | null }>(`SELECT xml_email FROM registry.parties WHERE id = $1`, [orig.party_id]) : null;
    counterparty = { taxId: orig.issuer_tax_id, name: orig.issuer_name, ie: orig.issuer_ie, ieIndicator: orig.issuer_ie ? 1 : 9, uf: orig.issuer_uf,
      address: addr ? { street: addr.street, number: addr.number, complement: addr.complement, district: addr.district, cityIbge: addr.city_ibge, cityName: addr.city_name, zip: addr.zip, countryCode: addr.country_code } : null,
      email: party?.xml_email ?? null };
  }
  const doc = await tx.one<DocRow>(
    `INSERT INTO fiscal.documents (tenant_id, company_id, establishment_id, model, direction, series, environment, operation_type_id, operation_code, operation_nature, purpose, presence,
       final_consumer, tax_date, regime, issuer_tax_id, issuer_name, issuer_ie, issuer_uf, party_id, recipient_tax_id, recipient_name, recipient_ie, recipient_ie_indicator,
       recipient_uf, recipient_address, recipient_email, payments, additional_info, source_type, source_id, idempotency_key, created_by)
     VALUES ($1,$2,$3,'55',$4,$5,$6,$7,$8,$9,4,9,$10,current_date,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'[{"tPag":"90","value":"0.00"}]',$24,$25,$26,$27,$28) RETURNING *`,
    [tx.tenantId, orig.company_id, est.id, isSaleReturn ? 'E' : 'S', series.series, est.sefaz_environment, op.id, op.code, op.name, orig.final_consumer, regime, est.cnpj,
      est.legal_name, est.ie, est.uf, orig.party_id, counterparty.taxId, counterparty.name, counterparty.ie, counterparty.ieIndicator, counterparty.uf,
      counterparty.address ? JSON.stringify(counterparty.address) : null, counterparty.email,
      `Devolução referente à NF-e ${orig.number}/${orig.series}, chave ${orig.access_key}. Motivo: ${input.reason}`, input.sourceType, input.sourceId ?? null, input.idempotencyKey ?? null, tx.userId]);
  await tx.exec(`INSERT INTO fiscal.document_references (tenant_id, document_id, referenced_document_id, referenced_access_key, kind) VALUES ($1,$2,$3,$4,'return')`,
    [tx.tenantId, doc.id, orig.id, orig.access_key]);
  const totals: Record<string, any> = { product: ZERO, discount: ZERO, freight: ZERO, insurance: ZERO, otherExpenses: ZERO, icmsBase: ZERO, icms: ZERO, icmsExempt: ZERO, fcp: ZERO,
    stBase: ZERO, st: ZERO, fcpSt: ZERO, difal: ZERO, fcpDest: ZERO, ipi: ZERO, pis: ZERO, cofins: ZERO, issBase: ZERO, iss: ZERO, ibsCbsBase: ZERO, ibsUf: ZERO, ibsMun: ZERO, ibs: ZERO, cbs: ZERO, is: ZERO, invoice: ZERO };
  let n = 0;
  for (const req of input.items) {
    const it = await tx.one<Record<string, any>>(`SELECT * FROM fiscal.document_items WHERE id = $1 AND document_id = $2 FOR UPDATE`, [req.originalItemId, orig.id], 'Item original');
    const available = D(it.quantity).minus(it.returned_quantity);
    if (D(req.quantity).greaterThan(available)) throw ruleViolation('RN-NFE-09', `Item ${it.item_number}: quantidade a devolver (${req.quantity}) maior que o saldo não devolvido (${available.toFixed(4)})`);
    const ratio = D(req.quantity).dividedBy(it.quantity);
    const prop = (v: string) => roundMoney(D(v).times(ratio));
    const total = prop(it.total);
    const row = await tx.one<{ id: string }>(
      `INSERT INTO fiscal.document_items (tenant_id, document_id, item_number, product_id, sku, description, gtin, ncm, cest, origin, cfop, unit, quantity, unit_price, taxable_unit,
         taxable_quantity, taxable_unit_price, total, discount, freight, insurance, other_expenses, item_total, warehouse_id, lot_id, unit_cost, original_item_id, cclasstrib, service_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
      [tx.tenantId, doc.id, ++n, it.product_id, it.sku, it.description, it.gtin, it.ncm, it.cest, it.origin, returnCfop(it.cfop), it.unit, req.quantity, it.unit_price,
        it.taxable_unit, D(it.taxable_quantity).times(ratio).toFixed(4), it.taxable_unit_price, total.toFixed(2), prop(it.discount).toFixed(2), prop(it.freight).toFixed(2),
        prop(it.insurance).toFixed(2), prop(it.other_expenses).toFixed(2), prop(it.item_total).toFixed(2), req.warehouseId ?? it.warehouse_id, it.lot_id, it.unit_cost, it.id,
        it.cclasstrib, it.service_code]);
    const taxes = await tx.query(`SELECT * FROM fiscal.document_item_taxes WHERE document_item_id = $1`, [it.id]);
    for (const t of taxes) {
      const base = prop(t.base);
      const value = prop(t.value);
      // Nota de terceiro: o CST do ICMS segue o regime de quem devolve (Simples → CSOSN 900; normal → CST 90)
      let cst = t.cst as string | null;
      if (t.tax === 'ICMS' && orig.issuer_kind === 'third_party' && cst) {
        const simples = ['simples_nacional', 'mei', 'simples_excesso_sublimite'].includes(regime);
        if (simples && cst.length === 2) cst = '900';
        else if (!simples && cst.length === 3) cst = '90';
      }
      await tx.exec(`INSERT INTO fiscal.document_item_taxes (tenant_id, document_item_id, tax, cst, base, rate, value, details, rule_id, rule_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tx.tenantId, row.id, t.tax, cst, base.toFixed(2), t.rate, value.toFixed(2), JSON.stringify({ ...t.details, mirroredFrom: t.id }), t.rule_id, t.rule_name]);
      const key = ({ ICMS: 'icms', ICMS_ST: 'st', FCP: 'fcp', FCP_ST: 'fcpSt', DIFAL: 'difal', FCP_DEST: 'fcpDest', IPI: 'ipi', PIS: 'pis', COFINS: 'cofins', ISS: 'iss', IBS_UF: 'ibsUf', IBS_MUN: 'ibsMun', CBS: 'cbs', IS: 'is' } as Record<string, string>)[t.tax];
      if (key) totals[key] = (totals[key] as typeof ZERO).plus(value);
      if (t.tax === 'ICMS') totals.icmsBase = totals.icmsBase.plus(base);
      if (t.tax === 'ICMS_ST') totals.stBase = totals.stBase.plus(base);
      if (t.tax === 'CBS') totals.ibsCbsBase = totals.ibsCbsBase.plus(base);
    }
    await tx.exec(`UPDATE fiscal.document_items SET returned_quantity = returned_quantity + $2 WHERE id = $1`, [it.id, req.quantity]);
    totals.product = totals.product.plus(total);
    totals.discount = totals.discount.plus(prop(it.discount));
    totals.freight = totals.freight.plus(prop(it.freight));
    totals.insurance = totals.insurance.plus(prop(it.insurance));
    totals.otherExpenses = totals.otherExpenses.plus(prop(it.other_expenses));
    totals.invoice = totals.invoice.plus(prop(it.item_total));
  }
  totals.ibs = totals.ibsUf.plus(totals.ibsMun);
  const informative = (orig.totals?.invoiceWithNewTaxes ?? orig.totals?.invoice) === orig.totals?.invoice;
  const out = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, (v as typeof ZERO).toFixed(2)]));
  out.invoiceWithNewTaxes = informative ? out.invoice! : D(out.invoice!).plus(out.ibs!).plus(out.cbs!).plus(out.is!).toFixed(2);
  return tx.one<DocRow>(
    `UPDATE fiscal.documents SET totals = $2, total_products = $3, total_discount = $4, total_freight = $5, total_icms = $6, total_st = $7, total_ipi = $8, total_pis = $9,
            total_cofins = $10, total_ibs = $11, total_cbs = $12, total_invoice = $13 WHERE id = $1 RETURNING *`,
    [doc.id, JSON.stringify(out), out.product, out.discount, out.freight, out.icms, out.st, out.ipi, out.pis, out.cofins, out.ibs, out.cbs, out.invoice]);
}

export async function getDocument(tx: Tx, id: string) {
  const doc = await tx.maybeOne(`SELECT * FROM fiscal.documents WHERE id = $1`, [id]);
  if (!doc) throw notFound('Documento fiscal');
  const items = await tx.query(`SELECT * FROM fiscal.document_items WHERE document_id = $1 ORDER BY item_number`, [id]);
  const taxes = await tx.query(`SELECT * FROM fiscal.document_item_taxes WHERE document_item_id = ANY($1) ORDER BY tax`, [items.map((i) => i.id)]);
  const events = await tx.query(`SELECT * FROM fiscal.document_events WHERE document_id = $1 ORDER BY created_at`, [id]);
  const refs = await tx.query(`SELECT * FROM fiscal.document_references WHERE document_id = $1`, [id]);
  return { ...doc, items: items.map((i) => ({ ...i, taxes: taxes.filter((t) => t.document_item_id === i.id) })), events, references: refs };
}
