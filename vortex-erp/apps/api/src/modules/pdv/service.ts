import { D, HUNDRED, ZERO, allocate, roundMoney, sum, type Decimal } from '@vortex/money';
import type { z } from 'zod';
import type { pdvCashMovementSchema } from '@vortex/contracts';
import { isValidAccessKey, parseAccessKey } from '@vortex/validators';
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import type { Services } from '../../services.js';
import { createOutgoingDocument, type DocRow } from '../fiscal-docs/documents.js';
import { allocateFefo, explodeKit, postMovement } from '../inventory/stock.js';
import { createTitles, settleTitle, transferBetweenAccounts } from '../finance/titles.js';
import { postEvent } from '../accounting/posting.js';
import { insertAddress } from '../registry/parties.js';
import { findOrCreateConsumer, getSettings, nfceFiscalContext, operatorsFor } from './operation.js';

// ------------------------------------------------------------------ sincronização (ERP → PDV)

/**
 * Carga para o PDV funcionar offline: produtos, preços, promoções, regras fiscais,
 * clientes, formas de pagamento e saldos. Com "since", só o que mudou desde então.
 */
/**
 * Numeração já usada pelo terminal, para o PDV continuar dela: último número de NFC-e da série do
 * terminal (por ambiente) e últimas vendas. Um terminal reinstalado, com banco local novo, não
 * repete número (o ERP recusaria a NFC-e e a venda como duplicadas).
 */
export async function pdvNumbering(tx: Tx, establishmentId: string, terminalCode: string) {
  const nfce = await tx.query<{ environment: number; series: number; last: string }>(
    `SELECT environment, series, max(number)::text AS last FROM fiscal.documents
      WHERE establishment_id = $1 AND model = '65' AND series = $2 AND issuer_kind = 'own' AND number IS NOT NULL GROUP BY environment, series`,
    [establishmentId, Number(terminalCode)]);
  const sales = await tx.query<{ sale_id: string }>(
    `SELECT sale_id FROM integration.pdv_sales WHERE establishment_id = $1 AND pdv_id = $2 ORDER BY occurred_at DESC LIMIT 20`, [establishmentId, terminalCode]);
  return { nfce: nfce.map((n) => ({ environment: Number(n.environment), series: Number(n.series), lastNumber: Number(n.last) })), lastSaleIds: sales.map((s) => s.sale_id) };
}

export async function pdvSync(tx: Tx, establishmentId: string, since: string | null) {
  const serverTime = (await tx.one<{ now: Date }>(`SELECT now() AS now`)).now;
  const est = await tx.one<Record<string, any>>(
    `SELECT id, company_id, cnpj, legal_name, trade_name, ie, im, uf, city_ibge, city_name, street, number, complement, district, zip, phone, sefaz_environment, nfce_csc_id FROM core.establishments WHERE id = $1`, [establishmentId], 'Estabelecimento');
  const s = since ?? '1970-01-01';
  const products = await tx.query(
    `SELECT p.id, p.sku, p.description, p.short_description, p.gtin, p.ncm, p.cest, p.origin, p.kind, p.sale_unit, p.stock_unit, p.controls_lot, p.controls_serial,
            p.controls_expiry, p.controls_stock, p.allow_negative_stock, p.manufacturer_code, p.status, p.category_id, p.kit_explodes_stock, p.updated_at,
            coalesce((SELECT json_agg(json_build_object('unit', c.unit, 'factor', c.factor, 'gtin', c.gtin)) FROM catalog.unit_conversions c WHERE c.product_id = p.id), '[]') AS conversions
       FROM catalog.products p WHERE p.updated_at > $1 AND NOT p.is_variant_parent ORDER BY p.updated_at`, [s]);
  const priceLists = await tx.query(
    `SELECT id, code, name, is_default, valid_from, valid_to, active FROM catalog.price_lists
      WHERE (is_default OR cardinality(establishment_ids) = 0 OR $1 = ANY(establishment_ids))`, [establishmentId]);
  const prices = await tx.query(
    `SELECT i.price_list_id, i.product_id, i.min_qty, i.price, i.updated_at FROM catalog.price_list_items i
      WHERE i.price_list_id = ANY($1) AND i.updated_at > $2 ORDER BY i.updated_at`, [priceLists.map((l) => l.id), s]);
  const promotions = await tx.query(
    `SELECT * FROM catalog.promotions WHERE active AND ends_at > now() AND (cardinality(establishment_ids) = 0 OR $1 = ANY(establishment_ids))`, [establishmentId]);
  const taxRules = await tx.query(
    `SELECT * FROM fiscal.tax_rules WHERE updated_at > $1 AND (establishment_id IS NULL OR establishment_id = $2) ORDER BY updated_at`, [s, establishmentId]);
  const customers = await tx.query(
    `SELECT p.id, p.kind, p.tax_id, p.legal_name, p.trade_name, p.status, p.block_reason, p.credit_limit, p.price_list_id, p.final_consumer, p.updated_at
       FROM registry.parties p JOIN registry.party_roles r ON r.party_id = p.id AND r.role = 'customer' WHERE p.updated_at > $1 ORDER BY p.updated_at`, [s]);
  const paymentMethods = await tx.query(`SELECT id, code, name, kind, nfe_tpag, fee_percent, settlement_days, active FROM registry.payment_methods ORDER BY code`);
  const stock = await tx.query(
    `SELECT b.warehouse_id, b.product_id, b.lot_id, b.quantity, b.reserved, b.blocked, b.updated_at FROM inventory.stock_balances b
      WHERE b.establishment_id = $1 AND b.updated_at > $2`, [establishmentId, s]);
  const series = await tx.query(`SELECT model, series, environment FROM core.fiscal_series WHERE establishment_id = $1 AND model = '65' AND active`, [establishmentId]);
  // Vortex PDV: parâmetros da loja, operadores (PIN para login offline), contexto fiscal da NFC-e e situação de estoque
  const settings = await getSettings(tx, establishmentId);
  const operators = await operatorsFor(tx, establishmentId);
  const today = new Date().toISOString().slice(0, 10);
  const fiscal = await nfceFiscalContext(tx, establishmentId, today);
  const stockParams = await tx.query(
    `SELECT sp.product_id, sp.warehouse_id, sp.min_qty, sp.reorder_point FROM catalog.stock_params sp JOIN core.warehouses w ON w.id = sp.warehouse_id WHERE w.establishment_id = $1`, [establishmentId]);
  return { serverTime, since, establishment: est, nfceSeries: series, products, priceLists, prices, promotions, taxRules, customers, paymentMethods, stock, stockParams,
    settings, operators, fiscal };
}

// ------------------------------------------------------------------ vendas (PDV → ERP)

export interface PdvSaleInput {
  establishmentId: string;
  warehouseId?: string | null;
  pdvId: string;
  saleId: string;
  occurredAt: string;
  operator?: string | null;
  customer?: { partyId?: string | null; taxId?: string | null; name?: string | null } | null;
  items: { productId: string; quantity: string; unitPrice: string; discount?: string; lotId?: string | null }[];
  payments: { methodCode: string; amount: string; change?: string; transactionId?: string | null; card?: { nsu?: string; authorization?: string; brand?: string; installments?: number } | null }[];
  nfce: { accessKey: string; status: 'autorizada' | 'contingencia'; protocol?: string | null; authorizedAt?: string | null; xml?: string | null };
  cashAccountId?: string | null;
  saleUuid?: string;
  sessionId?: string | null;
  operatorId?: string | null;
  /** Itens cancelados no caixa antes da conclusão (auditoria; não entram na NFC-e) */
  cancelledItems?: { productId: string; sku?: string | null; description: string; quantity: string; unit?: string | null; unitPrice: string; reason: string;
    operatorId?: string | null; authorizedBy?: string | null; at?: string | null; partial?: boolean }[];
}

/** Consumidor não identificado: uma pessoa genérica por tenant, para os títulos da venda. */
async function finalConsumer(tx: Tx, establishmentId: string): Promise<string> {
  const ex = await tx.maybeOne<{ id: string }>(`SELECT id FROM registry.parties WHERE kind = 'PF' AND tax_id IS NULL AND legal_name = 'CONSUMIDOR FINAL' AND status = 'active' LIMIT 1`);
  if (ex) return ex.id;
  // Não passa pela validação de CPF: é o "consumidor não identificado" da NFC-e
  const e = await tx.one<Record<string, any>>(`SELECT * FROM core.establishments WHERE id = $1`, [establishmentId]);
  const p = await tx.one<{ id: string }>(
    `INSERT INTO registry.parties (tenant_id, code, kind, legal_name, ie_indicator, final_consumer, lgpd_purpose, notes, created_by)
     VALUES ($1, core.next_tenant_counter('party'), 'PF', 'CONSUMIDOR FINAL', 9, true, 'Obrigações fiscais', 'Consumidor não identificado (vendas de balcão/PDV)', $2) RETURNING id`,
    [tx.tenantId, tx.userId]);
  await tx.exec(`INSERT INTO registry.party_roles (tenant_id, party_id, role) VALUES ($1,$2,'customer')`, [tx.tenantId, p.id]);
  await insertAddress(tx, p.id, { kind: 'fiscal', zip: e.zip, street: e.street, number: e.number, district: e.district, cityIbge: e.city_ibge, cityName: e.city_name, uf: e.uf,
    countryCode: '1058', isDefault: true });
  return p.id;
}

/**
 * Recebe a venda do PDV com a NFC-e já autorizada (ou em contingência offline): grava o
 * documento fiscal calculado pelo mesmo motor, baixa o estoque, gera os recebimentos por
 * forma de pagamento e contabiliza — tudo numa transação e de forma idempotente.
 */
export async function importPdvSale(tx: Tx, services: Services, input: PdvSaleInput) {
  // Idempotência (seção 32 da especificação do PDV): mesma venda nunca entra duas vezes
  const existing = await tx.maybeOne<{ document_id: string; total: string }>(
    `SELECT document_id, total FROM integration.pdv_sales WHERE (establishment_id = $1 AND pdv_id = $2 AND sale_id = $3) OR ($4::uuid IS NOT NULL AND sale_uuid = $4)`,
    [input.establishmentId, input.pdvId, input.saleId, input.saleUuid ?? null]);
  if (existing) return { duplicate: true, documentId: existing.document_id, total: existing.total };
  const est = await tx.one<Record<string, any>>(`SELECT * FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  // A chave precisa ser de NFC-e deste estabelecimento
  if (!isValidAccessKey(input.nfce.accessKey)) throw validation({ 'nfce.accessKey': 'Chave de acesso inválida' });
  const key = parseAccessKey(input.nfce.accessKey);
  if (key.modelo !== '65' || key.cnpj !== est.cnpj) throw validation({ 'nfce.accessKey': 'Chave não é de NFC-e emitida por este estabelecimento' });
  if (input.nfce.status === 'autorizada' && !input.nfce.protocol) throw validation({ 'nfce.protocol': 'Protocolo de autorização obrigatório' });
  // Número já usado por outra NFC-e (PDV reinstalado com numeração atrás do ERP): recusa explicando
  const taken = await tx.maybeOne<{ additional_info: string | null }>(
    `SELECT additional_info FROM fiscal.documents WHERE establishment_id = $1 AND model = '65' AND series = $2 AND number = $3 AND environment = $4 AND issuer_kind = 'own'`,
    [est.id, Number(key.serie), Number(key.numero), Number(est.sefaz_environment ?? 2)]);
  if (taken) {
    throw new AppError('PDV_NUMBER_IN_USE',
      `NFC-e série ${Number(key.serie)} número ${Number(key.numero)} já existe no ERP${taken.additional_info ? ` (${taken.additional_info})` : ''}: a numeração deste terminal está atrás do ERP. Sincronize o PDV para continuar a numeração.`,
      409, { series: Number(key.serie), number: Number(key.numero) });
  }
  const warehouseId = input.warehouseId
    ?? (await tx.one<{ id: string }>(`SELECT id FROM core.warehouses WHERE establishment_id = $1 AND kind IN ('store','own') AND active ORDER BY (kind = 'store') DESC, (code = 'PRINCIPAL') DESC LIMIT 1`,
      [est.id], 'Depósito')).id;
  const date = input.occurredAt.slice(0, 10);
  let partyId = input.customer?.partyId ?? null;
  if (!partyId && input.customer?.taxId) {
    // CPF na nota e cliente ainda não cadastrado no ERP (cadastro do caixa recusado ou não enviado): cadastro mínimo
    partyId = await findOrCreateConsumer(tx, est.id, { taxId: input.customer.taxId, name: input.customer.name || 'Consumidor identificado no PDV' });
  }
  const methods = await tx.query<Record<string, any>>(`SELECT * FROM registry.payment_methods WHERE code = ANY($1)`, [input.payments.map((p) => p.methodCode)]);
  for (const p of input.payments) if (!methods.find((m) => m.code === p.methodCode)) throw validation({ payments: `Forma de pagamento ${p.methodCode} não cadastrada` });

  const doc = await createOutgoingDocument(tx, {
    establishmentId: est.id, operationTypeCode: 'VENDA', model: '65', partyId, date, presence: 1,
    recipient: partyId ? undefined : { uf: est.uf, ieIndicator: 9, finalConsumer: true },
    items: input.items.map((it, i) => ({ id: String(i + 1), productId: it.productId, quantity: it.quantity, unitPrice: it.unitPrice, discount: it.discount ?? '0', warehouseId, lotId: it.lotId ?? null })),
    payments: input.payments.map((p) => ({ tPag: methods.find((m) => m.code === p.methodCode)!.nfe_tpag, value: D(p.amount).minus(p.change ?? 0).toFixed(2) })),
    sourceType: 'pdv', idempotencyKey: `pdv:${est.id}:${input.pdvId}:${input.saleId}`,
  });
  // O PDV usa o mesmo motor e as mesmas regras sincronizadas: total divergente indica PDV desatualizado
  const paid = sum(input.payments.map((p) => D(p.amount).minus(p.change ?? 0)));
  if (paid.minus(doc.total_invoice).abs().greaterThan('0.01')) {
    throw new AppError('PDV_TOTAL_MISMATCH', `Total da venda no PDV (${paid.toFixed(2)}) difere do calculado pelo ERP (${doc.total_invoice}): sincronize regras e preços do PDV`, 422,
      { pdvTotal: paid.toFixed(2), erpTotal: doc.total_invoice });
  }
  // Numeração e autorização vindas do PDV
  const xmlKey = input.nfce.xml ? (await services.storage.putImmutable(`nfce/${tx.tenantId}/${input.nfce.accessKey}.xml`, input.nfce.xml, 'application/xml')).key : null;
  await tx.exec(`UPDATE fiscal.documents SET status = 'validando' WHERE id = $1`, [doc.id]);
  await tx.exec(
    `UPDATE fiscal.documents SET status = 'pendente_envio', series = $2, number = $3, access_key = $4, numeric_code = $5, emission_type = $6, issued_at = $7, exit_at = $7,
            additional_info = coalesce(additional_info || ' | ', '') || $8 WHERE id = $1`,
    [doc.id, key.serie, key.numero, input.nfce.accessKey, key.cNF, Number(key.tpEmis), input.occurredAt, `PDV ${input.pdvId} · venda ${input.saleId}${input.operator ? ` · operador ${input.operator}` : ''}`]);
  if (input.nfce.status === 'autorizada') {
    await tx.exec(`UPDATE fiscal.documents SET status = 'em_processamento' WHERE id = $1`, [doc.id]);
    await tx.exec(`UPDATE fiscal.documents SET status = 'autorizada', protocol = $2, authorized_at = $3, authorized_xml_key = $4, gateway = 'pdv' WHERE id = $1`,
      [doc.id, input.nfce.protocol, input.nfce.authorizedAt ?? input.occurredAt, xmlKey]);
  } else {
    await tx.exec(`UPDATE fiscal.documents SET status = 'contingencia', contingency_at = $2, contingency_reason = 'NFC-e emitida offline pelo PDV', xml_key = $3, gateway = 'pdv' WHERE id = $1`,
      [doc.id, input.occurredAt, xmlKey]);
  }

  // Estoque (kits baixam componentes; lote informado ou FEFO)
  let cmv = ZERO;
  const docItems = await tx.query<Record<string, any>>(`SELECT * FROM fiscal.document_items WHERE document_id = $1 ORDER BY item_number`, [doc.id]);
  for (const di of docItems) {
    let itemCost = ZERO;
    const p = await tx.one<{ sale_unit: string; stock_unit: string }>(`SELECT sale_unit, stock_unit FROM catalog.products WHERE id = $1`, [di.product_id]);
    const conv = p.sale_unit !== p.stock_unit ? await tx.maybeOne<{ factor: string }>(`SELECT factor FROM catalog.unit_conversions WHERE product_id = $1 AND unit = $2`, [di.product_id, p.sale_unit]) : null;
    const stockQty = D(di.quantity).times(conv?.factor ?? 1).toFixed(4);
    for (const comp of await explodeKit(tx, di.product_id, stockQty)) {
      const prod = await tx.one<{ controls_lot: boolean; controls_stock: boolean }>(`SELECT controls_lot, controls_stock FROM catalog.products WHERE id = $1`, [comp.productId]);
      if (!prod.controls_stock) continue;
      const lots = prod.controls_lot ? (di.lot_id && comp.productId === di.product_id ? [{ lotId: di.lot_id, quantity: comp.quantity }] : await allocateFefo(tx, warehouseId, comp.productId, comp.quantity))
        : [{ lotId: null, quantity: comp.quantity }];
      for (const l of lots) {
        const mv = await postMovement(tx, {
          // A NFC-e já foi autorizada: o ERP registra a saída mesmo sem saldo (RN-EST-02 vira pendência de estoque negativo)
          acceptNegative: true,
          warehouseId, productId: comp.productId, lotId: l.lotId, type: 'sale_out', quantity: l.quantity, occurredAt: input.occurredAt, sourceType: 'fiscal_document', sourceId: doc.id,
          sourceItemId: di.id, idempotencyKey: `pdv:${doc.id}:${di.id}:${comp.productId}:${l.lotId ?? '-'}`,
        });
        if (mv) itemCost = itemCost.plus(mv.total_cost);
      }
    }
    cmv = cmv.plus(itemCost);
    await tx.exec(`UPDATE fiscal.document_items SET stock_quantity = $2, unit_cost = $3 WHERE id = $1`, [di.id, stockQty, D(stockQty).isZero() ? '0' : itemCost.dividedBy(stockQty).toFixed(10)]);
  }

  // Recebimentos por forma de pagamento: dinheiro e Pix entram baixados; cartão vira recebível da adquirente
  const consumer = partyId ?? await finalConsumer(tx, est.id);
  const opType = await tx.one<{ category_id: string | null }>(`SELECT category_id FROM fiscal.operation_types WHERE code = 'VENDA'`);
  const parts = allocate(doc.total_invoice, input.payments.map((p) => D(p.amount).minus(p.change ?? 0)));
  const cards: { gross: string; fee: string; net: string }[] = [];
  for (const [i, p] of input.payments.entries()) {
    const pm = methods.find((m) => m.code === p.methodCode)!;
    const value = parts[i]!;
    if (value.lessThanOrEqualTo(0)) continue;
    const base = { kind: 'receivable' as const, establishmentId: est.id, originType: 'pdv', originId: doc.id, fiscalDocumentId: doc.id,
      documentNumber: `NFC-e ${key.serie}/${key.numero}`, issueDate: date, categoryId: opType.category_id, paymentMethodId: pm.id };
    if (['credit_card', 'debit_card'].includes(pm.kind)) {
      const fee = roundMoney(value.times(pm.fee_percent).dividedBy(HUNDRED));
      const n = pm.kind === 'credit_card' ? Math.max(1, p.card?.installments ?? 1) : 1;
      const nets = allocate(value.minus(fee), Array.from({ length: n }, () => '1'));
      const installments = nets.map((amount, k) => {
        const due = new Date(`${date}T12:00:00Z`);
        due.setUTCDate(due.getUTCDate() + Number(pm.settlement_days) + k * 30);
        return { dueDate: due.toISOString().slice(0, 10), amount: amount.toFixed(2) };
      });
      await createTitles(tx, { ...base, partyId: pm.acquirer_party_id ?? consumer, installments, accountId: pm.financial_account_id, card: { grossAmount: value.toFixed(2), feeAmount: fee.toFixed(2) },
        notes: p.card ? `Cartão ${p.card.brand ?? ''} NSU ${p.card.nsu ?? '-'} aut. ${p.card.authorization ?? '-'}`.trim() : null, idempotencyKey: `pdv:${doc.id}:pag${i}` });
      cards.push({ gross: value.toFixed(2), fee: fee.toFixed(2), net: value.minus(fee).toFixed(2) });
    } else {
      const [t] = await createTitles(tx, { ...base, partyId: consumer, installments: [{ dueDate: date, amount: value.toFixed(2) }], accountId: pm.financial_account_id,
        notes: p.transactionId ? `Transação ${p.transactionId}` : null, idempotencyKey: `pdv:${doc.id}:pag${i}` });
      const account = pm.kind === 'cash' ? (input.cashAccountId ?? pm.financial_account_id) : pm.financial_account_id;
      if (account && ['cash', 'pix', 'transfer'].includes(pm.kind)) {
        await settleTitle(tx, t!.id, { date, accountId: account, amount: value.toFixed(2), method: pm.kind, reference: `NFC-e ${key.numero}`, idempotencyKey: `pdv:${doc.id}:baixa${i}` });
      }
    }
  }

  // Contabilização da venda (mesma regra do faturamento) e reclassificação do cartão
  const t = doc.totals as Record<string, string>;
  await postEvent(tx, {
    type: 'venda_faturada', companyId: doc.company_id, establishmentId: est.id, date, description: `Venda PDV ${input.pdvId} NFC-e ${key.numero}`, number: `${key.serie}/${key.numero}`,
    originType: 'fiscal_document', originId: doc.id, operationTypeCode: 'VENDA', partyId: consumer,
    amounts: { invoice_total: doc.total_invoice, receivable_total: doc.total_invoice, st: t.st, fcp_st: t.fcpSt, ipi: t.ipi, icms: t.icms, fcp: t.fcp, difal: t.difal, fcp_dest: t.fcpDest,
      pis: t.pis, cofins: t.cofins, iss: t.iss, cmv },
    idempotencyKey: `pdv:${doc.id}`,
  });
  for (const [k, c] of cards.entries()) {
    await postEvent(tx, { type: 'cartao_venda', companyId: doc.company_id, date, description: 'Venda no cartão (PDV)', number: `${key.numero}-${k + 1}`, originType: 'fiscal_document', originId: doc.id,
      amounts: { gross: c.gross, fee: c.fee, net: c.net }, idempotencyKey: `pdv:${doc.id}:cartao${k}` });
  }
  await tx.exec(
    `INSERT INTO integration.pdv_sales (tenant_id, company_id, establishment_id, pdv_id, sale_id, document_id, total, occurred_at, sale_uuid, session_id, operator_id, operator_name, cancelled_items)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [tx.tenantId, est.company_id, est.id, input.pdvId, input.saleId, doc.id, doc.total_invoice, input.occurredAt, input.saleUuid ?? null, input.sessionId ?? null, input.operatorId ?? null,
      input.operator ?? null, JSON.stringify(input.cancelledItems ?? [])]);
  if (input.nfce.status === 'autorizada') {
    await emit(tx, 'nota.autorizada', { type: 'fiscal_document', id: doc.id }, { id: doc.id, modelo: '65', chave: input.nfce.accessKey, numero: key.numero, total: doc.total_invoice, origem: 'pdv' });
  } else {
    await emit(tx, 'fiscal.contingencia', { type: 'fiscal_document', id: doc.id }, { id: doc.id, modelo: '65', chave: input.nfce.accessKey, origem: 'pdv', alerta: 'NFC-e emitida offline aguardando autorização' });
  }
  return { duplicate: false, documentId: doc.id, total: doc.total_invoice, cmv: cmv.toFixed(2) };
}

/** NFC-e emitida offline: o PDV informa a autorização quando volta a ter conexão. */
export async function authorizePdvContingency(tx: Tx, input: { establishmentId: string; pdvId: string; saleId: string; protocol: string; authorizedAt: string }) {
  const s = await tx.one<{ document_id: string }>(`SELECT document_id FROM integration.pdv_sales WHERE establishment_id = $1 AND pdv_id = $2 AND sale_id = $3`,
    [input.establishmentId, input.pdvId, input.saleId], 'Venda do PDV');
  const doc = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1 FOR UPDATE`, [s.document_id]);
  if (doc.status === 'autorizada') return { documentId: doc.id, status: doc.status };
  if (doc.status !== 'contingencia') throw conflict('INVALID_STATUS', `NFC-e em situação "${doc.status}"`);
  await tx.exec(`UPDATE fiscal.documents SET status = 'autorizada', protocol = $2, authorized_at = $3 WHERE id = $1`, [doc.id, input.protocol, input.authorizedAt]);
  await emit(tx, 'nota.autorizada', { type: 'fiscal_document', id: doc.id }, { id: doc.id, modelo: '65', chave: doc.access_key, numero: doc.number, total: doc.total_invoice, origem: 'pdv' });
  return { documentId: doc.id, status: 'autorizada' };
}

// ------------------------------------------------------------------ caixa do PDV

export type PdvCashInput = z.infer<typeof pdvCashMovementSchema>;

/**
 * Abertura (fundo de troco), suprimento (cofre → caixa), sangria (caixa → cofre/banco),
 * fechamento com a diferença (quebra ou sobra) lançada no financeiro e na contabilidade,
 * e reabertura pelo gerente, que desfaz a diferença lançada no fechamento. Diferenças nunca
 * são apagadas: a reabertura lança o movimento inverso e o novo fechamento lança de novo.
 */
export async function pdvCashMovement(tx: Tx, input: PdvCashInput) {
  const ex = await tx.maybeOne(`SELECT * FROM integration.pdv_cash_movements WHERE establishment_id = $1 AND pdv_id = $2 AND reference = $3`,
    [input.establishmentId, input.pdvId, input.reference]);
  if (ex) return ex;
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  const settings = await getSettings(tx, input.establishmentId);
  const cashAccountId = input.cashAccountId ?? settings.cash.cashAccountId;
  if (!cashAccountId) throw validation({ cashAccountId: 'Defina a conta de caixa do PDV nos parâmetros da loja' });
  const counterpart = input.counterpartAccountId ?? settings.cash.vaultAccountId;
  const cash = await tx.one<{ kind: string; company_id: string; ledger_account_id: string | null }>(`SELECT kind, company_id, ledger_account_id FROM finance.accounts WHERE id = $1`, [cashAccountId], 'Conta do caixa');
  if (cash.kind !== 'cash' || cash.company_id !== est.company_id) throw validation({ cashAccountId: 'Informe uma conta do tipo caixa da mesma empresa' });
  const date = input.occurredAt.slice(0, 10);
  let transferId: string | null = null;
  let expected: string | null = null;
  let difference: string | null = null;
  let differenceMovementId: string | null = null;
  const amount = input.amount ?? '0';
  const postDifference = async (diff: Decimal, label: string) => {
    const mv = await tx.one<{ id: string }>(
      `INSERT INTO finance.account_movements (tenant_id, company_id, account_id, movement_date, direction, amount, description, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8) RETURNING id`,
      [tx.tenantId, est.company_id, cashAccountId, date, diff.isNegative() ? 'D' : 'C', diff.abs().toFixed(2), label, tx.userId]);
    await postEvent(tx, { type: 'movimento_conta', companyId: est.company_id, date, description: label, number: label,
      originType: 'account_movement', originId: mv.id, amounts: { amount: diff.negated().toFixed(2) }, ledgers: { credit_ledger: cash.ledger_account_id } });
    return mv.id;
  };
  if (input.kind === 'opening' || input.kind === 'supply' || input.kind === 'withdrawal') {
    if (input.kind !== 'opening' && D(amount).lessThanOrEqualTo(0)) throw validation({ amount: 'Informe o valor' });
    if (D(amount).greaterThan(0)) {
      if (!counterpart) throw validation({ counterpartAccountId: 'Defina a conta do cofre/banco nos parâmetros da loja' });
      const what = input.kind === 'opening' ? 'Abertura (fundo de troco)' : input.kind === 'supply' ? 'Suprimento' : 'Sangria';
      const label = `${what} PDV ${input.pdvId}${input.reason ? ` — ${input.reason}` : ''}`;
      const r = input.kind === 'withdrawal'
        ? await transferBetweenAccounts(tx, { fromAccountId: cashAccountId, toAccountId: counterpart, amount, date, description: label })
        : await transferBetweenAccounts(tx, { fromAccountId: counterpart, toAccountId: cashAccountId, amount, date, description: label });
      transferId = r.transferId;
    }
  } else if (input.kind === 'closing') {
    if (input.counted === undefined) throw validation({ counted: 'Informe o valor contado no fechamento' });
    // Esperado da sessão calculado pelo terminal; sem ele, o saldo da conta de caixa
    const sessionExpected = (input.details as { expectedCash?: string } | undefined)?.expectedCash;
    if (sessionExpected !== undefined) {
      expected = D(sessionExpected).toFixed(2);
    } else {
      const bal = await tx.one<{ v: string | null }>(
        `SELECT a.initial_balance + coalesce(sum(CASE WHEN m.direction = 'C' THEN m.amount ELSE -m.amount END), 0) AS v
           FROM finance.accounts a LEFT JOIN finance.account_movements m ON m.account_id = a.id AND m.movement_date >= a.initial_balance_date AND m.movement_date <= $2
          WHERE a.id = $1 GROUP BY a.initial_balance`, [cashAccountId, date]);
      expected = D(bal.v ?? 0).toFixed(2);
    }
    const diff = D(input.counted).minus(expected);
    difference = diff.toFixed(2);
    if (!diff.isZero()) differenceMovementId = await postDifference(diff, `${diff.isNegative() ? 'Quebra' : 'Sobra'} de caixa PDV ${input.pdvId}`);
  } else {
    // Reabertura: desfaz a diferença do último fechamento da sessão
    const closing = await tx.maybeOne<{ difference: string | null; reference: string }>(
      `SELECT difference, reference FROM integration.pdv_cash_movements WHERE establishment_id = $1 AND pdv_id = $2 AND session_id = $3 AND kind = 'closing'
        ORDER BY occurred_at DESC LIMIT 1`, [input.establishmentId, input.pdvId, input.sessionId ?? null]);
    if (!closing) throw conflict('INVALID_STATUS', 'Sessão de caixa sem fechamento para reabrir');
    if (!input.reason || input.reason.trim().length < 15) throw validation({ reason: 'Informe o motivo da reabertura (mínimo 15 caracteres)' });
    if (closing.difference && !D(closing.difference).isZero()) {
      differenceMovementId = await postDifference(D(closing.difference).negated(), `Reabertura PDV ${input.pdvId}: estorno da diferença do fechamento ${closing.reference}`);
    }
  }
  return tx.one(
    `INSERT INTO integration.pdv_cash_movements (tenant_id, company_id, establishment_id, pdv_id, reference, kind, amount, expected, counted, difference, cash_account_id, counterpart_account_id,
       transfer_id, occurred_at, session_id, operator_id, authorized_by, reason, details, difference_movement_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [tx.tenantId, est.company_id, input.establishmentId, input.pdvId, input.reference, input.kind, amount, expected, input.counted ?? null, difference,
      cashAccountId, counterpart ?? null, transferId, input.occurredAt, input.sessionId ?? null, input.operatorId ?? null, input.authorizedBy ?? null, input.reason ?? null,
      JSON.stringify(input.details ?? {}), differenceMovementId]);
}

export { ruleViolation };
