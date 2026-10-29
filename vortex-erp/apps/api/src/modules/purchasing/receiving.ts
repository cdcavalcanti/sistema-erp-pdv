import { D, ZERO, HUNDRED, allocate, min, roundMoney, round, sum, type Decimal } from '@vortex/money';
import { cleanDoc } from '@vortex/validators';
import { transitionFor } from '@vortex/fiscal-engine';
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { has } from '../../core/access.js';
import { requestApproval } from '../../core/approvals.js';
import type { Services } from '../../services.js';
import { subscribe } from '../../worker/registry.js';
import { parseNfeXml, type ParsedNfe } from '../fiscal-docs/inbound.js';
import { createReturnDocument, prepareForTransmission, registerDocumentHooks, type DocRow } from '../fiscal-docs/documents.js';
import { getOrCreateLot, postMovement, reverseMovement } from '../inventory/stock.js';
import { abateTitle, cancelTitlesOfOrigin, createTitles, installmentsFromTerm, reverseSettlement } from '../finance/titles.js';
import { postEvent, reverseEntries } from '../accounting/posting.js';
import { regimeAt } from '../org/service.js';
import { createParty } from '../registry/parties.js';
import { refreshPurchaseOrderStatus } from './orders.js';

const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------ importação do XML (pré-recebimento)

export interface ImportReceiptInput {
  establishmentId: string;
  warehouseId?: string | null;
  xml: string;
  orderId?: string | null;
  /** RN-COM-02: conferência cega (o conferente não vê a quantidade da nota) */
  blindCount?: boolean;
  operationTypeCode?: string | null;
}

/**
 * Recebimento a partir do XML (importado ou baixado pela distribuição DF-e): vincula ao
 * pedido, faz o de-para de produtos e unidades e deixa a nota em pré-recebimento para
 * conferência. Nada entra no estoque ou no financeiro até a conclusão.
 */
export async function importReceipt(tx: Tx, services: Services, input: ImportReceiptInput) {
  const nfe = parseNfeXml(input.xml);
  if (nfe.model !== '55') throw validation({ xml: 'Recebimento de compra aceita NF-e modelo 55' });
  const est = await tx.one<{ id: string; company_id: string; cnpj: string; uf: string }>(`SELECT id, company_id, cnpj, uf FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  if (nfe.recipient.taxId !== est.cnpj) throw validation({ xml: `NF-e destinada a outro CNPJ (${nfe.recipient.taxId ?? 'sem destinatário'}), não a este estabelecimento` });
  if (await tx.maybeOne(`SELECT 1 FROM purchasing.receipts WHERE access_key = $1 AND status <> 'cancelled'`, [nfe.accessKey])) {
    throw conflict('DUPLICATE_RECEIPT', `NF-e ${nfe.number} (chave ${nfe.accessKey}) já foi recebida`);
  }
  // Fornecedor: pelo CNPJ do emitente; se não existe, nasce com o papel de fornecedor
  let supplier = await tx.maybeOne<{ id: string; status: string }>(`SELECT id, status FROM registry.parties WHERE tax_id = $1 AND status <> 'inactive'`, [nfe.issuer.taxId]);
  if (!supplier) {
    const a = nfe.issuer.address;
    if (!a) throw validation({ xml: `Fornecedor ${nfe.issuer.name} não cadastrado e o XML não traz o endereço do emitente: cadastre o fornecedor` });
    const p = await createParty(tx, { kind: nfe.issuer.taxId.length === 11 ? 'PF' : 'PJ', taxId: nfe.issuer.taxId, legalName: nfe.issuer.name, roles: ['supplier'], ieIndicator: 9,
      creditLimit: '0', contacts: [], notes: `Cadastrado automaticamente pela NF-e ${nfe.number}`,
      addresses: [{ kind: 'fiscal', zip: a.zip, street: a.street, number: a.number, district: a.district, cityIbge: /^\d{7}$/.test(a.cityIbge) ? a.cityIbge : null, cityName: a.cityName,
        uf: a.uf, countryCode: '1058', isDefault: true }] });
    supplier = { id: p.id, status: 'active' };
  } else {
    await tx.exec(`INSERT INTO registry.party_roles (tenant_id, party_id, role) VALUES ($1,$2,'supplier') ON CONFLICT DO NOTHING`, [tx.tenantId, supplier.id]);
  }
  // Pedido: o informado ou, se houver um único pedido aprovado em aberto do fornecedor, esse
  let orderId = input.orderId ?? null;
  if (orderId) {
    const o = await tx.one<{ supplier_id: string; status: string; establishment_id: string }>(`SELECT supplier_id, status, establishment_id FROM purchasing.orders WHERE id = $1`, [orderId], 'Pedido de compra');
    if (o.supplier_id !== supplier.id) throw validation({ orderId: 'Pedido é de outro fornecedor' });
    if (!['approved', 'partially_received'].includes(o.status)) throw ruleViolation('RN-COM-01', 'Pedido de compra não está aprovado ou já foi recebido');
    if (o.establishment_id !== est.id) throw validation({ orderId: 'Pedido é de outro estabelecimento' });
  } else {
    const open = await tx.query<{ id: string; number: string }>(
      `SELECT id, number FROM purchasing.orders WHERE supplier_id = $1 AND establishment_id = $2 AND status IN ('approved','partially_received')`, [supplier.id, est.id]);
    // xPed: o fornecedor informa o número do nosso pedido no item da NF-e
    const refs = new Set(nfe.items.map((i) => i.orderRef?.replace(/\D/g, '').replace(/^0+/, '')).filter(Boolean));
    const byRef = open.filter((o) => refs.has(String(o.number)));
    if (byRef.length === 1) orderId = byRef[0]!.id;
    else if (open.length === 1) orderId = open[0]!.id;
  }
  const order = orderId ? await tx.one<{ warehouse_id: string }>(`SELECT warehouse_id FROM purchasing.orders WHERE id = $1`, [orderId]) : null;
  const warehouseId = input.warehouseId ?? order?.warehouse_id
    ?? (await tx.one<{ id: string }>(`SELECT id FROM core.warehouses WHERE establishment_id = $1 AND kind = 'own' AND active ORDER BY (code = 'PRINCIPAL') DESC, code LIMIT 1`, [est.id], 'Depósito')).id;
  const hasSt = nfe.items.some((i) => D(i.st.value).greaterThan(0));
  const opCode = input.operationTypeCode ?? (hasSt ? 'COMPRA_ST' : 'COMPRA');
  await tx.one(`SELECT 1 FROM fiscal.operation_types WHERE code = $1 AND direction = 'E'`, [opCode], 'Tipo de operação de entrada');
  const stored = await services.storage.putImmutable(`nfe-entrada/${tx.tenantId}/${nfe.accessKey}.xml`, input.xml, 'application/xml');
  const informative = transitionFor(nfe.issuedAt.slice(0, 10)).ibsCbsInformative;
  const receipt = await tx.one<{ id: string }>(
    `INSERT INTO purchasing.receipts (tenant_id, company_id, establishment_id, warehouse_id, supplier_id, order_id, access_key, number, series, issue_date, operation_type_code,
       xml_key, parsed, blind_count, without_order, total_invoice, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [tx.tenantId, est.company_id, est.id, warehouseId, supplier.id, orderId, nfe.accessKey, nfe.number, nfe.series, nfe.issuedAt.slice(0, 10), opCode, stored.key,
      JSON.stringify({ issuer: nfe.issuer, totals: nfe.totals, installments: nfe.installments, protocol: nfe.protocol, issuedAt: nfe.issuedAt }), input.blindCount ?? false, !orderId,
      nfe.totals.invoice, tx.userId]);
  for (const it of nfe.items) {
    const csosnCredit = ['101', '201', '900'].includes(it.icms.cst ?? '') && D(it.icms.snCredit).greaterThan(0);
    const gross = D(it.total).minus(it.discount).plus(it.freight).plus(it.insurance).plus(it.other).plus(it.ipi.value).plus(it.st.value);
    const payable = informative ? gross : gross.plus(it.ibs).plus(it.cbs);
    await tx.exec(
      `INSERT INTO purchasing.receipt_items (tenant_id, receipt_id, xml_item_number, supplier_code, description, ean, ncm, cest, cfop, supplier_unit, supplier_quantity, supplier_unit_price,
         total, discount, freight, insurance, other_expenses, ipi, st, icms, icms_cst, pis, pis_cst, cofins, ibs, cbs, lot_number, lot_manufactured_at, lot_expires_at, payable_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
      [tx.tenantId, receipt.id, it.number, it.code, it.description, it.ean, it.ncm, it.cest, it.cfop, it.unit, it.quantity, it.unitPrice, it.total, it.discount, it.freight,
        it.insurance, it.other, it.ipi.value, it.st.value, csosnCredit ? it.icms.snCredit : it.icms.value, it.icms.cst, it.pis.value, it.pis.cst, it.cofins.value, it.ibs, it.cbs,
        it.lot?.number ?? null, it.lot?.manufacturedAt ?? null, it.lot?.expiresAt ?? null, payable.toFixed(2)]);
  }
  // Liga a nota da distribuição DF-e (ou registra a entrada manual do XML)
  await tx.exec(
    `INSERT INTO fiscal.inbound_documents (tenant_id, company_id, establishment_id, access_key, issuer_tax_id, issuer_name, issuer_ie, issued_at, total, content, xml_key, receipt_id, supplier_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'full',$10,$11,$12)
     ON CONFLICT (tenant_id, access_key) DO UPDATE SET receipt_id = EXCLUDED.receipt_id, content = 'full', xml_key = coalesce(fiscal.inbound_documents.xml_key, EXCLUDED.xml_key),
       supplier_id = EXCLUDED.supplier_id`,
    [tx.tenantId, est.company_id, est.id, nfe.accessKey, nfe.issuer.taxId, nfe.issuer.name, nfe.issuer.ie, nfe.issuedAt, nfe.totals.invoice, stored.key, receipt.id, supplier.id]);
  await matchItems(tx, receipt.id);
  if (!orderId) await autoLinkOrder(tx, receipt.id);
  return getReceipt(tx, receipt.id);
}

/** Vários pedidos em aberto do fornecedor: vincula ao que cobre mais produtos da nota (se for único). */
async function autoLinkOrder(tx: Tx, receiptId: string) {
  const best = await tx.query<{ id: string; hits: number }>(
    `SELECT o.id, count(DISTINCT oi.product_id)::int AS hits FROM purchasing.receipts r
       JOIN purchasing.orders o ON o.supplier_id = r.supplier_id AND o.establishment_id = r.establishment_id AND o.status IN ('approved','partially_received')
       JOIN purchasing.order_items oi ON oi.order_id = o.id AND oi.quantity - oi.quantity_received - oi.quantity_cancelled > 0
       JOIN purchasing.receipt_items ri ON ri.receipt_id = r.id AND ri.product_id = oi.product_id AND ri.match_source <> 'suggestion'
      WHERE r.id = $1 GROUP BY o.id ORDER BY hits DESC, o.number LIMIT 2`, [receiptId]);
  if (best.length && (best.length === 1 || best[0]!.hits > best[1]!.hits)) await linkOrder(tx, receiptId, best[0]!.id);
}

// ------------------------------------------------------------------ de-para (RN-COM-03)

const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'em', 'e', 'a', 'o', 'un', 'und', 'pc', 'cx', 'kg', 'ml', 'lt']);
export function tokens(s: string): Set<string> {
  return new Set(s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t)));
}
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Vínculo automático: código do fornecedor gravado em recebimentos anteriores, depois
 * GTIN (do produto ou da embalagem). Sem vínculo, sugere o produto mais parecido
 * (descrição + NCM + itens do pedido) — a sugestão precisa ser confirmada na primeira vez.
 */
export async function matchItems(tx: Tx, receiptId: string) {
  const r = await tx.one<{ supplier_id: string; order_id: string | null }>(`SELECT supplier_id, order_id FROM purchasing.receipts WHERE id = $1`, [receiptId]);
  const items = await tx.query<Record<string, any>>(`SELECT * FROM purchasing.receipt_items WHERE receipt_id = $1 ORDER BY xml_item_number`, [receiptId]);
  const orderProducts = r.order_id ? new Set((await tx.query<{ product_id: string }>(`SELECT product_id FROM purchasing.order_items WHERE order_id = $1`, [r.order_id])).map((x) => x.product_id)) : new Set<string>();
  for (const it of items) {
    if (it.product_id && it.match_source !== 'suggestion') continue;
    let match: { productId: string; factor: string; source: string; confidence: string } | null = null;
    const ps = await tx.maybeOne<{ product_id: string; factor: string }>(`SELECT product_id, factor FROM catalog.product_suppliers WHERE supplier_id = $1 AND supplier_code = $2`, [r.supplier_id, it.supplier_code]);
    if (ps) match = { productId: ps.product_id, factor: ps.factor, source: 'supplier_code', confidence: '100' };
    if (!match && it.ean) {
      const byGtin = await tx.maybeOne<{ id: string }>(`SELECT id FROM catalog.products WHERE gtin = $1 AND status = 'active'`, [it.ean]);
      if (byGtin) match = { productId: byGtin.id, factor: '1', source: 'gtin', confidence: '100' };
      else {
        const conv = await tx.maybeOne<{ product_id: string; factor: string }>(`SELECT product_id, factor FROM catalog.unit_conversions WHERE gtin = $1`, [it.ean]);
        if (conv) match = { productId: conv.product_id, factor: conv.factor, source: 'gtin', confidence: '100' };
      }
    }
    if (!match) {
      const tk = tokens(it.description);
      const query = [...tk].filter((t) => /^[a-z0-9]+$/.test(t)).join(' | ');
      const candidates = await tx.query<{ id: string; description: string; ncm: string | null }>(
        `SELECT id, description, ncm FROM catalog.products WHERE status = 'active' AND NOT is_variant_parent
            AND (ncm = $1 OR ($2 <> '' AND to_tsvector('simple', translate(lower(description), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')) @@ to_tsquery('simple', $2)) OR id = ANY($3)) LIMIT 300`,
        [it.ncm, query, [...orderProducts]]);
      let best: { id: string; score: number } | null = null;
      for (const c of candidates) {
        const score = similarity(tk, tokens(c.description)) + (c.ncm && c.ncm === it.ncm ? 0.2 : 0) + (orderProducts.has(c.id) ? 0.2 : 0);
        if (!best || score > best.score) best = { id: c.id, score };
      }
      if (best && best.score >= 0.35) match = { productId: best.id, factor: '1', source: 'suggestion', confidence: Math.min(99, best.score * 100).toFixed(2) };
    }
    if (match) await applyMatch(tx, receiptId, it, match);
  }
}

async function applyMatch(tx: Tx, receiptId: string, it: Record<string, any>, m: { productId: string; factor: string; source: string; confidence: string }) {
  const r = await tx.one<{ order_id: string | null }>(`SELECT order_id FROM purchasing.receipts WHERE id = $1`, [receiptId]);
  const stockQty = D(it.supplier_quantity).times(m.factor);
  const orderItem = r.order_id ? await tx.maybeOne<{ id: string }>(
    `SELECT id FROM purchasing.order_items WHERE order_id = $1 AND product_id = $2 ORDER BY (quantity - quantity_received - quantity_cancelled > 0) DESC, item_number LIMIT 1`, [r.order_id, m.productId]) : null;
  await tx.exec(`UPDATE purchasing.receipt_items SET product_id = $2, factor = $3, match_source = $4, match_confidence = $5, stock_quantity = $6, order_item_id = $7 WHERE id = $1`,
    [it.id, m.productId, m.factor, m.source, m.confidence, stockQty.toFixed(4), orderItem?.id ?? null]);
}

async function assertEditable(tx: Tx, receiptId: string) {
  const r = await tx.one<Record<string, any>>(`SELECT * FROM purchasing.receipts WHERE id = $1 FOR UPDATE`, [receiptId], 'Recebimento');
  if (['completed', 'cancelled'].includes(r.status)) throw conflict('INVALID_STATUS', 'Recebimento já concluído ou cancelado');
  return r;
}

/** Vínculo manual (ou confirmação da sugestão) com fator de conversão da unidade do fornecedor. */
export async function mapReceiptItem(tx: Tx, receiptId: string, itemId: string, input: { productId: string; factor?: string | null }) {
  await assertEditable(tx, receiptId);
  const it = await tx.one<Record<string, any>>(`SELECT * FROM purchasing.receipt_items WHERE id = $1 AND receipt_id = $2`, [itemId, receiptId], 'Item do recebimento');
  const p = await tx.one<{ is_variant_parent: boolean }>(`SELECT is_variant_parent FROM catalog.products WHERE id = $1`, [input.productId], 'Produto');
  if (p.is_variant_parent) throw validation({ productId: 'Vincule a variação (SKU), não o produto pai da grade' });
  let factor = input.factor ?? null;
  if (!factor) {
    const conv = await tx.maybeOne<{ factor: string }>(`SELECT factor FROM catalog.unit_conversions WHERE product_id = $1 AND upper(unit) = upper($2)`, [input.productId, it.supplier_unit]);
    factor = conv?.factor ?? (it.product_id === input.productId ? it.factor : '1');
  }
  if (D(factor!).lessThanOrEqualTo(0)) throw validation({ factor: 'Fator de conversão deve ser maior que zero' });
  await applyMatch(tx, receiptId, it, { productId: input.productId, factor: factor!, source: 'manual', confidence: '100' });
  return getReceipt(tx, receiptId);
}

export async function linkOrder(tx: Tx, receiptId: string, orderId: string) {
  const r = await assertEditable(tx, receiptId);
  const o = await tx.one<{ supplier_id: string; status: string }>(`SELECT supplier_id, status FROM purchasing.orders WHERE id = $1`, [orderId], 'Pedido de compra');
  if (o.supplier_id !== r.supplier_id) throw validation({ orderId: 'Pedido é de outro fornecedor' });
  if (!['approved', 'partially_received'].includes(o.status)) throw ruleViolation('RN-COM-01', 'Pedido de compra não está aprovado ou já foi recebido');
  await tx.exec(`UPDATE purchasing.receipts SET order_id = $2, without_order = false WHERE id = $1`, [receiptId, orderId]);
  const items = await tx.query<Record<string, any>>(`SELECT * FROM purchasing.receipt_items WHERE receipt_id = $1 AND product_id IS NOT NULL`, [receiptId]);
  for (const it of items) await applyMatch(tx, receiptId, it, { productId: it.product_id, factor: it.factor, source: it.match_source, confidence: it.match_confidence });
  return getReceipt(tx, receiptId);
}

/** Conferência física (em unidade de estoque). Na conferência cega o conferente não vê a nota (RN-COM-02). */
export async function countReceipt(tx: Tx, receiptId: string, counts: { itemId: string; quantity: string; lotNumber?: string | null; expiresAt?: string | null }[]) {
  await assertEditable(tx, receiptId);
  for (const c of counts) {
    const ok = await tx.maybeOne(
      `UPDATE purchasing.receipt_items SET counted_quantity = $3, lot_number = coalesce($4, lot_number), lot_expires_at = coalesce($5::date, lot_expires_at) WHERE id = $1 AND receipt_id = $2 RETURNING id`,
      [c.itemId, receiptId, c.quantity, c.lotNumber ?? null, c.expiresAt ?? null]);
    if (!ok) throw notFound('Item do recebimento');
  }
  await tx.exec(`UPDATE purchasing.receipts SET status = 'checking' WHERE id = $1 AND status = 'pre_receipt'`, [receiptId]);
  return getReceipt(tx, receiptId, { blind: true });
}

// ------------------------------------------------------------------ conferência de três vias (RN-COM-01)

export interface Divergence {
  code: string;
  kind: 'mapping' | 'not_counted' | 'price' | 'quantity_over_order' | 'not_in_order' | 'count' | 'total' | 'without_order';
  itemNumber: number | null;
  message: string;
  /** Liberável pelo comprador (aprovação); as demais exigem correção */
  approvable: boolean;
}

async function settingsOf(tx: Tx, companyId: string) {
  const s = (await tx.one<{ settings: any }>(`SELECT settings FROM core.companies WHERE id = $1`, [companyId])).settings?.purchasing ?? {};
  return { priceTolerance: D(s.priceTolerancePercent ?? '2'), quantityTolerance: D(s.quantityTolerancePercent ?? '0'), requireCount: !!s.requireCount };
}

/** Pedido × nota × quantidade física. Divergência acima da tolerância bloqueia a entrada até a aprovação do comprador. */
export async function evaluateDivergences(tx: Tx, receiptId: string): Promise<Divergence[]> {
  const r = await tx.one<Record<string, any>>(`SELECT * FROM purchasing.receipts WHERE id = $1`, [receiptId], 'Recebimento');
  const cfg = await settingsOf(tx, r.company_id);
  const items = await tx.query<Record<string, any>>(
    `SELECT ri.*, oi.unit_price AS order_price, oi.quantity - oi.quantity_received - oi.quantity_cancelled AS order_pending, p.sku
       FROM purchasing.receipt_items ri LEFT JOIN purchasing.order_items oi ON oi.id = ri.order_item_id LEFT JOIN catalog.products p ON p.id = ri.product_id
      WHERE ri.receipt_id = $1 ORDER BY ri.xml_item_number`, [receiptId]);
  const out: Divergence[] = [];
  if (!r.order_id) out.push({ code: 'without_order', kind: 'without_order', itemNumber: null, approvable: false, message: 'Nota sem pedido de compra (RN-COM-06): aceite exige permissão específica' });
  // O mesmo item do pedido pode aparecer em mais de uma linha da nota
  const perOrderItem = new Map<string, Decimal>();
  for (const it of items) {
    const n = it.xml_item_number as number;
    if (!it.product_id || it.match_source === 'suggestion') {
      out.push({ code: `mapping:${n}`, kind: 'mapping', itemNumber: n, approvable: false,
        message: it.product_id ? `Item ${n} (${it.supplier_code}): confirme o produto sugerido` : `Item ${n} (${it.supplier_code} — ${it.description}): vincule a um produto` });
      continue;
    }
    const stockQty = D(it.stock_quantity);
    if (it.counted_quantity === null && (r.blind_count || cfg.requireCount)) {
      out.push({ code: `not_counted:${n}`, kind: 'not_counted', itemNumber: n, approvable: false, message: `Item ${n} (${it.sku}): conferência física pendente` });
    } else if (it.counted_quantity !== null && !D(it.counted_quantity).equals(stockQty)) {
      out.push({ code: `count:${n}`, kind: 'count', itemNumber: n, approvable: true,
        message: `Item ${n} (${it.sku}): contado ${D(it.counted_quantity).toString()}, nota ${stockQty.toString()}` });
    }
    if (r.order_id) {
      if (!it.order_item_id) {
        out.push({ code: `not_in_order:${n}`, kind: 'not_in_order', itemNumber: n, approvable: true, message: `Item ${n} (${it.sku}) não consta no pedido de compra` });
        continue;
      }
      // Preço na unidade de estoque: preço do fornecedor ÷ fator
      const unitPrice = D(it.supplier_unit_price).dividedBy(it.factor);
      const diffPct = D(it.order_price).isZero() ? HUNDRED : unitPrice.minus(it.order_price).dividedBy(it.order_price).times(HUNDRED);
      if (diffPct.greaterThan(cfg.priceTolerance)) {
        out.push({ code: `price:${n}`, kind: 'price', itemNumber: n, approvable: true,
          message: `Item ${n} (${it.sku}): preço ${round(unitPrice, 'unitPrice').toString()} acima do pedido ${D(it.order_price).toString()} (+${diffPct.toFixed(2)}%, tolerância ${cfg.priceTolerance.toString()}%)` });
      }
      const acc = (perOrderItem.get(it.order_item_id) ?? ZERO).plus(stockQty);
      perOrderItem.set(it.order_item_id, acc);
      const limit = D(it.order_pending).times(HUNDRED.plus(cfg.quantityTolerance)).dividedBy(HUNDRED);
      if (acc.greaterThan(limit)) {
        out.push({ code: `quantity_over_order:${n}`, kind: 'quantity_over_order', itemNumber: n, approvable: true,
          message: `Item ${n} (${it.sku}): quantidade ${acc.toString()} acima do saldo do pedido ${D(it.order_pending).toString()}` });
      }
    }
  }
  const itemsGross = sum(items.map((i) => D(i.total).minus(i.discount).plus(i.freight).plus(i.insurance).plus(i.other_expenses).plus(i.ipi).plus(i.st)));
  if (itemsGross.minus(r.total_invoice).abs().greaterThan('0.05')) {
    out.push({ code: 'total', kind: 'total', itemNumber: null, approvable: true, message: `Soma dos itens (${itemsGross.toFixed(2)}) difere do total da nota (${D(r.total_invoice).toFixed(2)})` });
  }
  return out;
}

/** Roda a conferência: divergências liberáveis viram pedidos de aprovação ao comprador. */
export async function checkReceipt(tx: Tx, receiptId: string) {
  const r = await assertEditable(tx, receiptId);
  const divergences = await evaluateDivergences(tx, receiptId);
  const approved = new Set((await tx.query<{ reason_code: string }>(
    `SELECT reason_code FROM core.approval_requests WHERE entity_type = 'purchase_receipt' AND entity_id = $1 AND status = 'approved'`, [receiptId])).map((x) => x.reason_code));
  const pendingApproval = divergences.filter((d) => d.approvable && !approved.has(d.code));
  for (const d of pendingApproval) {
    await requestApproval(tx, { entityType: 'purchase_receipt', entityId: receiptId, action: 'compras.recebimento', reasonCode: d.code, reason: d.message, approverPermission: 'compras.recebimento.aprovar' });
  }
  const blocking = divergences.filter((d) => !d.approvable && d.kind !== 'without_order');
  const status = pendingApproval.length ? 'divergent' : 'checking';
  await tx.exec(`UPDATE purchasing.receipts SET status = $2 WHERE id = $1`, [receiptId, status]);
  if (pendingApproval.length && r.status !== 'divergent') {
    await emit(tx, 'compra.divergencia', { type: 'purchase_receipt', id: receiptId }, { id: receiptId, nota: r.number, divergencias: pendingApproval.map((d) => d.message) });
  }
  return { status, divergences, pendingApproval: pendingApproval.map((d) => d.code), blocking: blocking.map((d) => d.code), readyToComplete: !pendingApproval.length && !blocking.length };
}

// ------------------------------------------------------------------ custo de entrada (RN-COM-04)

interface CostInput {
  total: string; discount: string; freight: string; insurance: string; other_expenses: string; ipi: string; st: string; icms: string; icms_cst: string | null;
  pis_cst: string | null; ibs: string; cbs: string; extra_freight: string; extra_freight_icms: string; payable_amount: string;
}

export interface EntryCost {
  gross: Decimal;
  icmsCredit: Decimal;
  freightIcmsCredit: Decimal;
  pisCredit: Decimal;
  cofinsCredit: Decimal;
  ibsCredit: Decimal;
  cbsCredit: Decimal;
  total: Decimal;
}

const ICMS_CREDITABLE_CST = new Set(['00', '20', '51', '90']);
const ICMS_CREDITABLE_CSOSN = new Set(['101', '201', '900']);
const PIS_NO_CREDIT_CST = new Set(['04', '05', '06', '07', '08', '09']);

/**
 * Custo de entrada = produto + frete + seguro + outras despesas + IPI não recuperável +
 * ICMS-ST − descontos − impostos recuperáveis (ICMS, PIS/Cofins, IBS/CBS conforme o regime).
 * O frete do CT-e rateado (RN-COM-05) entra no custo, menos o seu crédito de ICMS.
 */
export function entryCost(it: CostInput, ctx: { regime: string; forResale: boolean; ibsCbsInformative: boolean; pisCofinsActive: boolean }): EntryCost {
  const simples = ctx.regime === 'simples_nacional' || ctx.regime === 'mei';
  const gross = D(it.payable_amount).plus(it.extra_freight);
  let icmsCredit = ZERO;
  let pisCredit = ZERO;
  let cofinsCredit = ZERO;
  let ibsCredit = ZERO;
  let cbsCredit = ZERO;
  const freightIcmsCredit = simples ? ZERO : D(it.extra_freight_icms);
  if (!simples && ctx.forResale && D(it.st).isZero()) {
    const cst = it.icms_cst ?? '';
    if (cst.length === 3 ? ICMS_CREDITABLE_CSOSN.has(cst) : ICMS_CREDITABLE_CST.has(cst.slice(-2))) icmsCredit = D(it.icms);
  }
  // Lucro real (não cumulativo): 1,65% + 7,6% sobre o valor de aquisição, sem o ICMS destacado
  if (ctx.regime === 'lucro_real' && ctx.forResale && ctx.pisCofinsActive && !PIS_NO_CREDIT_CST.has(it.pis_cst ?? '')) {
    const base = D(it.total).minus(it.discount).plus(it.freight).plus(it.insurance).plus(it.other_expenses).plus(it.ipi).minus(it.icms);
    pisCredit = roundMoney(base.times('1.65').dividedBy(HUNDRED));
    cofinsCredit = roundMoney(base.times('7.6').dividedBy(HUNDRED));
  }
  // IBS/CBS: crédito amplo (não cumulatividade plena) fora do Simples, a partir de 2027
  if (!simples && !ctx.ibsCbsInformative) {
    ibsCredit = D(it.ibs);
    cbsCredit = D(it.cbs);
  }
  const total = gross.minus(icmsCredit).minus(freightIcmsCredit).minus(pisCredit).minus(cofinsCredit).minus(ibsCredit).minus(cbsCredit);
  return { gross, icmsCredit, freightIcmsCredit, pisCredit, cofinsCredit, ibsCredit, cbsCredit, total };
}

// ------------------------------------------------------------------ conclusão do recebimento

/**
 * Lança tudo numa transação: documento fiscal de entrada, estoque com custo de entrada,
 * de-para gravado, saldo do pedido, títulos a pagar pelas duplicatas, livro de créditos
 * e contabilização. Bloqueia se houver divergência não liberada.
 */
export async function completeReceipt(tx: Tx, receiptId: string) {
  const r = await assertEditable(tx, receiptId);
  const check = await checkReceipt(tx, receiptId);
  const blocking = check.divergences.filter((d) => check.blocking.includes(d.code));
  if (blocking.length) {
    const rule = blocking.some((d) => d.kind === 'not_counted') ? 'RN-COM-02' : 'RN-COM-03';
    throw ruleViolation(rule, blocking.map((d) => d.message).join('; '), { divergences: blocking });
  }
  if (check.pendingApproval.length) {
    throw ruleViolation('RN-COM-01', 'Divergência acima da tolerância aguardando liberação do comprador', { divergences: check.divergences.filter((d) => check.pendingApproval.includes(d.code)) });
  }
  if (!r.order_id && !has(tx.ctx, 'compras.recebimento.sem_pedido')) {
    throw ruleViolation('RN-COM-06', 'Nota sem pedido de compra só pode ser aceita por usuário com permissão "compras.recebimento.sem_pedido"');
  }
  const est = await tx.one<Record<string, any>>(`SELECT * FROM core.establishments WHERE id = $1`, [r.establishment_id]);
  const op = await tx.one<Record<string, any>>(`SELECT * FROM fiscal.operation_types WHERE code = $1`, [r.operation_type_code]);
  const order = r.order_id ? await tx.one<Record<string, any>>(`SELECT * FROM purchasing.orders WHERE id = $1 FOR UPDATE`, [r.order_id]) : null;
  const regime = await regimeAt(tx, est.id, r.issue_date);
  const trans = transitionFor(r.issue_date);
  const ctxCost = { regime, forResale: op.moves_stock, ibsCbsInformative: trans.ibsCbsInformative, pisCofinsActive: trans.pisCofinsActive };
  const parsed = r.parsed as { issuer: ParsedNfe['issuer']; totals: ParsedNfe['totals']; installments: ParsedNfe['installments']; protocol: string | null; issuedAt: string };
  const items = await tx.query<Record<string, any>>(
    `SELECT ri.*, p.sku, p.description AS product_description, p.ncm AS product_ncm, p.origin, p.controls_stock, p.controls_lot
       FROM purchasing.receipt_items ri JOIN catalog.products p ON p.id = ri.product_id WHERE ri.receipt_id = $1 ORDER BY ri.xml_item_number`, [receiptId]);

  // Documento fiscal de entrada (nota do fornecedor): escrituração e base das devoluções
  const interstate = parsed.issuer.uf !== est.uf;
  const cfop = interstate ? op.cfop_interstate : op.cfop_internal;
  const t = parsed.totals;
  const docTotals = { product: t.products, discount: t.discount, freight: t.freight, insurance: t.insurance, otherExpenses: t.other, icms: t.icms, st: t.st, ipi: t.ipi,
    pis: t.pis, cofins: t.cofins, ibs: t.ibs, cbs: t.cbs, invoice: t.invoice };
  const doc = await tx.one<DocRow>(
    `INSERT INTO fiscal.documents (tenant_id, company_id, establishment_id, model, issuer_kind, direction, series, number, access_key, environment, status, operation_type_id, operation_code,
       operation_nature, purpose, presence, final_consumer, issued_at, tax_date, regime, issuer_tax_id, issuer_name, issuer_ie, issuer_uf, party_id, recipient_tax_id, recipient_name,
       recipient_ie, recipient_ie_indicator, recipient_uf, installments, totals, total_products, total_discount, total_freight, total_icms, total_st, total_ipi, total_pis, total_cofins,
       total_ibs, total_cbs, total_invoice, protocol, authorized_at, xml_key, source_type, source_id, created_by)
     VALUES ($1,$2,$3,'55','third_party','E',$4,$5,$6,$7,'autorizada',$8,$9,$10,1,9,false,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,1,$22,$23,$24,
       $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$11,$37,'purchase_receipt',$38,$39) RETURNING *`,
    [tx.tenantId, r.company_id, est.id, Number(r.series), Number(r.number), r.access_key, est.sefaz_environment, op.id, op.code, op.name, parsed.issuedAt, r.issue_date, regime,
      parsed.issuer.taxId, parsed.issuer.name, parsed.issuer.ie, parsed.issuer.uf, r.supplier_id, est.cnpj, est.legal_name, est.ie, est.uf, JSON.stringify(parsed.installments),
      JSON.stringify(docTotals), t.products, t.discount, t.freight, t.icms, t.st, t.ipi, t.pis, t.cofins, t.ibs, t.cbs, t.invoice, parsed.protocol, r.xml_key, receiptId, tx.userId]);

  const acc = { stock: ZERO, expense: ZERO, icms: ZERO, pis: ZERO, cofins: ZERO, ibs: ZERO, cbs: ZERO, payable: ZERO, freight: ZERO };
  for (const it of items) {
    const c = entryCost(it as unknown as CostInput, ctxCost);
    const stockQty = D(it.stock_quantity);
    const unitCost = round(c.total.dividedBy(stockQty), 'cost');
    await tx.exec(
      `UPDATE purchasing.receipt_items SET entry_unit_cost = $2, entry_total_cost = $3, recoverable_icms = $4, recoverable_pis_cofins = $5, recoverable_pis = $6,
              recoverable_ibs_cbs = $7, recoverable_ibs = $8, recoverable_cbs = $9 WHERE id = $1`,
      [it.id, unitCost.toFixed(10), c.total.toFixed(2), c.icmsCredit.toFixed(2), c.pisCredit.plus(c.cofinsCredit).toFixed(2), c.pisCredit.toFixed(2),
        c.ibsCredit.plus(c.cbsCredit).toFixed(2), c.ibsCredit.toFixed(2), c.cbsCredit.toFixed(2)]);
    if (it.controls_lot && !it.lot_number) throw validation({ lot: `Item ${it.xml_item_number} (${it.sku}) controla lote: informe o lote na conferência` });
    const lotId = it.lot_number && it.controls_lot
      ? await getOrCreateLot(tx, it.product_id, it.lot_number, { manufacturedAt: it.lot_manufactured_at, expiresAt: it.lot_expires_at, supplierId: r.supplier_id }) : null;
    const di = await tx.one<{ id: string }>(
      `INSERT INTO fiscal.document_items (tenant_id, document_id, item_number, product_id, sku, description, gtin, ncm, cest, origin, cfop, unit, quantity, unit_price, taxable_unit,
         taxable_quantity, taxable_unit_price, total, discount, freight, insurance, other_expenses, item_total, stock_quantity, warehouse_id, lot_id, unit_cost, source_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) RETURNING id`,
      [tx.tenantId, doc.id, it.xml_item_number, it.product_id, it.sku, it.description, it.ean, /^\d{8}$/.test(it.ncm ?? '') ? it.ncm : it.product_ncm, /^\d{7}$/.test(it.cest ?? '') ? it.cest : null,
        it.origin ?? 0, cfop, it.supplier_unit, it.supplier_quantity, it.supplier_unit_price, it.total, it.discount, it.freight, it.insurance, it.other_expenses,
        D(it.total).minus(it.discount).plus(it.freight).plus(it.insurance).plus(it.other_expenses).plus(it.ipi).plus(it.st).toFixed(2), it.stock_quantity, r.warehouse_id, lotId,
        unitCost.toFixed(10), it.id]);
    const taxRows: [string, string | null, string, Record<string, unknown>][] = [
      ['ICMS', it.icms_cst, it.icms, { credit: c.icmsCredit.toFixed(2) }], ['ICMS_ST', null, it.st, {}], ['IPI', null, it.ipi, { recoverable: false }],
      ['PIS', it.pis_cst, it.pis, { credit: c.pisCredit.toFixed(2) }], ['COFINS', it.pis_cst, it.cofins, { credit: c.cofinsCredit.toFixed(2) }],
      ['IBS_UF', null, it.ibs, { credit: c.ibsCredit.toFixed(2), informative: trans.ibsCbsInformative }], ['CBS', null, it.cbs, { credit: c.cbsCredit.toFixed(2), informative: trans.ibsCbsInformative }],
    ];
    for (const [tax, cst, value, details] of taxRows) {
      if (D(value).isZero() && !cst) continue;
      await tx.exec(`INSERT INTO fiscal.document_item_taxes (tenant_id, document_item_id, tax, cst, base, rate, value, details) VALUES ($1,$2,$3,$4,0,0,$5,$6)`,
        [tx.tenantId, di.id, tax, cst, value, JSON.stringify(details)]);
    }
    // Estoque pelo custo de entrada (alimenta o custo médio — seção 12)
    let stocked = false;
    if (op.moves_stock && it.controls_stock) {
      const mv = await postMovement(tx, {
        warehouseId: r.warehouse_id, productId: it.product_id, lotId, type: 'purchase_in', quantity: stockQty.toFixed(4), unitCost: unitCost.toFixed(10),
        sourceType: 'fiscal_document', sourceId: doc.id, sourceItemId: di.id, idempotencyKey: `receipt:${it.id}`,
      });
      if (mv) {
        stocked = true;
        acc.stock = acc.stock.plus(mv.total_cost);
        // Centavos de arredondamento entre o custo unitário e o total vão para despesa
        acc.expense = acc.expense.plus(c.total.minus(mv.total_cost));
      }
    }
    if (!stocked) acc.expense = acc.expense.plus(c.total);
    acc.icms = acc.icms.plus(c.icmsCredit).plus(c.freightIcmsCredit);
    acc.pis = acc.pis.plus(c.pisCredit);
    acc.cofins = acc.cofins.plus(c.cofinsCredit);
    acc.ibs = acc.ibs.plus(c.ibsCredit);
    acc.cbs = acc.cbs.plus(c.cbsCredit);
    acc.payable = acc.payable.plus(it.payable_amount);
    acc.freight = acc.freight.plus(it.extra_freight);
    // De-para gravado após o primeiro recebimento (RN-COM-03) e último preço do fornecedor
    await tx.exec(
      `INSERT INTO catalog.product_suppliers (tenant_id, product_id, supplier_id, supplier_code, supplier_unit, factor, supplier_gtin, last_price, last_purchase_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)
       ON CONFLICT (tenant_id, supplier_id, supplier_code) DO UPDATE SET product_id = EXCLUDED.product_id, supplier_unit = EXCLUDED.supplier_unit, factor = EXCLUDED.factor,
         supplier_gtin = coalesce(EXCLUDED.supplier_gtin, catalog.product_suppliers.supplier_gtin), last_price = EXCLUDED.last_price, last_purchase_at = now()`,
      [tx.tenantId, it.product_id, r.supplier_id, it.supplier_code, it.supplier_unit, it.factor, it.ean && it.ean.length <= 14 ? it.ean : null,
        D(it.supplier_unit_price).dividedBy(it.factor).toFixed(10), tx.userId]);
    if (it.order_item_id) await tx.exec(`UPDATE purchasing.order_items SET quantity_received = quantity_received + $2 WHERE id = $1`, [it.order_item_id, it.stock_quantity]);
  }
  if (order) await refreshPurchaseOrderStatus(tx, order.id);

  // Títulos a pagar conforme as duplicatas do XML (ou a condição do pedido)
  const payable = roundMoney(acc.payable);
  let installments = parsed.installments.length
    ? (() => {
        const parts = allocate(payable, parsed.installments.map((d) => d.amount));
        return parsed.installments.map((d, i) => ({ dueDate: d.dueDate, amount: parts[i]!.toFixed(2) }));
      })()
    : await installmentsFromTerm(tx, order?.payment_term_id ?? null, payable.toFixed(2), r.issue_date);
  installments = installments.filter((i) => D(i.amount).greaterThan(0));
  const titles = await createTitles(tx, {
    kind: 'payable', partyId: r.supplier_id, establishmentId: est.id, originType: 'purchase_invoice', originId: receiptId, fiscalDocumentId: doc.id,
    documentNumber: `NF ${r.number}`, issueDate: r.issue_date, installments, categoryId: order?.category_id ?? op.category_id, costCenterId: order?.cost_center_id ?? null,
    idempotencyKey: `receipt:${receiptId}`,
  });

  // Livro de créditos (RN-REF-04): IBS/CBS condicionados ao pagamento ao fornecedor
  const credits: [string, Decimal, string][] = [['ICMS', acc.icms, 'appropriated'], ['PIS', acc.pis, 'appropriated'], ['COFINS', acc.cofins, 'appropriated'],
    ['IBS', acc.ibs, 'conditional'], ['CBS', acc.cbs, 'conditional']];
  for (const [tax, amount, status] of credits) {
    if (amount.lessThanOrEqualTo(0)) continue;
    await tx.exec(`INSERT INTO fiscal.tax_credits (tenant_id, company_id, establishment_id, document_id, tax, amount, status, competence, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tx.tenantId, r.company_id, est.id, doc.id, tax, amount.toFixed(2), status, r.issue_date, `Entrada NF ${r.number}`]);
  }

  await postEvent(tx, {
    type: 'compra_recebida', companyId: r.company_id, establishmentId: est.id, date: today(), description: `Compra NF ${r.number}`, number: String(r.number),
    originType: 'fiscal_document', originId: doc.id, partyId: r.supplier_id, operationTypeCode: op.code, costCenterId: order?.cost_center_id ?? null,
    amounts: { stock_cost: acc.stock, expense: acc.expense, icms_credit: acc.icms, pis_credit: acc.pis, cofins_credit: acc.cofins, ibs_cbs_credit: acc.ibs.plus(acc.cbs),
      invoice_total: payable, freight_payable: acc.freight },
    idempotencyKey: `receipt:${receiptId}`,
  });
  await tx.exec(`UPDATE purchasing.receipts SET status = 'completed', fiscal_document_id = $2, completed_at = now(), completed_by = $3 WHERE id = $1`, [receiptId, doc.id, tx.userId]);
  await emit(tx, 'compra.recebida', { type: 'purchase_receipt', id: receiptId }, {
    id: receiptId, nota: r.number, chave: r.access_key, fornecedor: r.supplier_id, valor: payable.toFixed(2), foraDoProcesso: !r.order_id, pedido: r.order_id,
  });
  return { ...(await getReceipt(tx, receiptId)), titles: titles.map((x) => x.id), documentId: doc.id };
}

export async function cancelReceipt(tx: Tx, receiptId: string, reason: string) {
  await assertEditable(tx, receiptId);
  await tx.exec(`UPDATE purchasing.receipts SET status = 'cancelled' WHERE id = $1`, [receiptId]);
  await tx.exec(`UPDATE fiscal.inbound_documents SET receipt_id = NULL WHERE receipt_id = $1`, [receiptId]);
  await tx.exec(`UPDATE core.approval_requests SET status = 'cancelled' WHERE entity_type = 'purchase_receipt' AND entity_id = $1 AND status = 'pending'`, [receiptId]);
  return { id: receiptId, status: 'cancelled', reason };
}

/** Na conferência cega, quem confere não vê quantidades e valores da nota até concluir. */
export async function getReceipt(tx: Tx, id: string, opts: { blind?: boolean } = {}) {
  const r = await tx.maybeOne<Record<string, any>>(
    `SELECT r.*, p.legal_name AS supplier_name, o.number AS order_number FROM purchasing.receipts r JOIN registry.parties p ON p.id = r.supplier_id
       LEFT JOIN purchasing.orders o ON o.id = r.order_id WHERE r.id = $1`, [id]);
  if (!r) throw notFound('Recebimento');
  let items = await tx.query<Record<string, any>>(
    `SELECT ri.*, p.sku, p.description AS product_description, p.stock_unit FROM purchasing.receipt_items ri LEFT JOIN catalog.products p ON p.id = ri.product_id
      WHERE ri.receipt_id = $1 ORDER BY ri.xml_item_number`, [id]);
  const hide = opts.blind && r.blind_count && !['completed', 'cancelled'].includes(r.status);
  if (hide) {
    items = items.map((i) => ({ id: i.id, xml_item_number: i.xml_item_number, supplier_code: i.supplier_code, description: i.description, ean: i.ean, product_id: i.product_id,
      sku: i.sku, product_description: i.product_description, stock_unit: i.stock_unit, counted_quantity: i.counted_quantity, lot_number: i.lot_number, lot_expires_at: i.lot_expires_at }));
  }
  const approvals = await tx.query(`SELECT * FROM core.approval_requests WHERE entity_type = 'purchase_receipt' AND entity_id = $1 ORDER BY created_at`, [id]);
  const { parsed, ...rest } = r;
  return hide ? { ...rest, total_invoice: undefined, items, approvals, blind: true } : { ...rest, issuer: parsed.issuer, installments: parsed.installments, items, approvals };
}

// ------------------------------------------------------------------ frete de compra com CT-e (RN-COM-05)

export interface FreightInput {
  carrierId: string;
  accessKey?: string | null;
  number: string;
  issueDate: string;
  total: string;
  icmsCredit?: string | null;
  method?: 'value' | 'weight';
  receiptIds: string[];
  dueDate?: string | null;
  cfop?: string | null;
}

/**
 * Rateia o CT-e entre as notas e itens que ele transportou, por valor ou por peso. O
 * rateio entra no custo de entrada; por isso o CT-e é lançado antes da conclusão dos
 * recebimentos. Gera o título a pagar à transportadora.
 */
export async function registerFreight(tx: Tx, input: FreightInput) {
  if (!input.receiptIds.length) throw validation({ receiptIds: 'Informe as notas transportadas' });
  const carrier = await tx.maybeOne(`SELECT 1 FROM registry.party_roles WHERE party_id = $1 AND role IN ('carrier','supplier')`, [input.carrierId]);
  if (!carrier) throw validation({ carrierId: 'Transportadora não cadastrada com o papel de transportadora' });
  const receipts = await tx.query<Record<string, any>>(`SELECT * FROM purchasing.receipts WHERE id = ANY($1) FOR UPDATE`, [input.receiptIds]);
  if (receipts.length !== new Set(input.receiptIds).size) throw notFound('Recebimento');
  if (receipts.some((r) => ['completed', 'cancelled'].includes(r.status))) {
    throw ruleViolation('RN-COM-05', 'Lance o CT-e antes de concluir o recebimento das notas que ele transportou (o frete compõe o custo de entrada)');
  }
  const companyId = receipts[0]!.company_id as string;
  if (receipts.some((r) => r.company_id !== companyId)) throw validation({ receiptIds: 'Notas de empresas diferentes' });
  const regime = await regimeAt(tx, receipts[0]!.establishment_id, input.issueDate);
  const creditable = !['simples_nacional', 'mei'].includes(regime) ? D(input.icmsCredit ?? '0') : ZERO;
  const items = await tx.query<Record<string, any>>(
    `SELECT ri.id, ri.receipt_id, ri.payable_amount, ri.stock_quantity, p.gross_weight, p.sku FROM purchasing.receipt_items ri LEFT JOIN catalog.products p ON p.id = ri.product_id
      WHERE ri.receipt_id = ANY($1) ORDER BY array_position($1::uuid[], ri.receipt_id), ri.xml_item_number`, [input.receiptIds]);
  const method = input.method ?? 'value';
  const weights = items.map((i) => {
    if (method === 'value') return D(i.payable_amount);
    if (!i.gross_weight || !i.stock_quantity) throw validation({ method: `Rateio por peso: item ${i.sku ?? i.id} sem produto vinculado ou sem peso bruto cadastrado` });
    return D(i.gross_weight).times(i.stock_quantity);
  });
  const shares = allocate(input.total, weights);
  const icmsShares = allocate(creditable, weights);
  const allocations = items.map((i, k) => ({ receiptItemId: i.id, receiptId: i.receipt_id, freight: shares[k]!.toFixed(2), icmsCredit: icmsShares[k]!.toFixed(2) }));
  for (const a of allocations) {
    await tx.exec(`UPDATE purchasing.receipt_items SET extra_freight = extra_freight + $2, extra_freight_icms = extra_freight_icms + $3 WHERE id = $1`, [a.receiptItemId, a.freight, a.icmsCredit]);
  }
  for (const r of receipts) {
    const v = sum(allocations.filter((a) => a.receiptId === r.id).map((a) => a.freight));
    await tx.exec(`UPDATE purchasing.receipts SET extra_freight = extra_freight + $2 WHERE id = $1`, [r.id, v.toFixed(2)]);
  }
  const fd = await tx.one<{ id: string }>(
    `INSERT INTO purchasing.freight_documents (tenant_id, company_id, carrier_id, access_key, number, issue_date, total, icms_credit, allocation_method, receipt_ids, allocations, cfop, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [tx.tenantId, companyId, input.carrierId, input.accessKey ?? null, input.number, input.issueDate, input.total, creditable.toFixed(2), method, input.receiptIds,
      JSON.stringify(allocations), input.cfop ?? null, tx.userId]);
  const titles = await createTitles(tx, {
    kind: 'payable', partyId: input.carrierId, establishmentId: receipts[0]!.establishment_id, originType: 'purchase_freight', originId: fd.id, documentNumber: `CT-e ${input.number}`,
    issueDate: input.issueDate, installments: [{ dueDate: input.dueDate ?? input.issueDate, amount: D(input.total).toFixed(2) }],
  });
  await tx.exec(`UPDATE purchasing.freight_documents SET title_ids = $2 WHERE id = $1`, [fd.id, titles.map((x) => x.id)]);
  return { id: fd.id, allocations, titles: titles.map((x) => x.id) };
}

// ------------------------------------------------------------------ devolução a fornecedor (RN-COM-07)

export interface PurchaseReturnInput {
  receiptId: string;
  items: { receiptItemId: string; quantity: string }[];
  reason: string;
  financialTreatment: 'abatement' | 'supplier_credit';
  idempotencyKey?: string | null;
}

/**
 * Gera a NF-e de devolução de compra (tributos espelhados da nota de entrada), baixa o
 * estoque pelo custo de entrada, estorna os créditos e abate o título a pagar ou gera
 * crédito com o fornecedor.
 */
export async function createPurchaseReturn(tx: Tx, input: PurchaseReturnInput) {
  if (input.idempotencyKey) {
    const ex = await tx.maybeOne<{ return_id: string }>(`SELECT source_id AS return_id FROM fiscal.documents WHERE idempotency_key = $1`, [`pret:${input.idempotencyKey}`]);
    if (ex) return tx.one(`SELECT * FROM purchasing.returns WHERE id = $1`, [ex.return_id]);
  }
  const r = await tx.one<Record<string, any>>(`SELECT * FROM purchasing.receipts WHERE id = $1 FOR UPDATE`, [input.receiptId], 'Recebimento');
  if (r.status !== 'completed' || !r.fiscal_document_id) throw ruleViolation('RN-COM-07', 'Devolução parte de um recebimento concluído');
  if (input.reason.trim().length < 5) throw validation({ reason: 'Informe o motivo da devolução' });
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'purchase_return') AS n`, [r.company_id])).n;
  const ret = await tx.one<{ id: string }>(
    `INSERT INTO purchasing.returns (tenant_id, company_id, number, receipt_id, supplier_id, reason, financial_treatment, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [tx.tenantId, r.company_id, number, r.id, r.supplier_id, input.reason, input.financialTreatment, tx.userId]);
  const reqs = [];
  for (const it of input.items) {
    const di = await tx.one<{ id: string }>(`SELECT id FROM fiscal.document_items WHERE document_id = $1 AND source_item_id = $2`, [r.fiscal_document_id, it.receiptItemId], 'Item da nota de entrada');
    reqs.push({ originalItemId: di.id, quantity: it.quantity, warehouseId: r.warehouse_id });
  }
  const retDoc = await createReturnDocument(tx, {
    originalDocumentId: r.fiscal_document_id, items: reqs, reason: input.reason, sourceType: 'purchase_return', sourceId: ret.id, operationTypeCode: 'DEV_COMPRA',
    idempotencyKey: input.idempotencyKey ? `pret:${input.idempotencyKey}` : null,
  });
  const op = await tx.one<{ moves_stock: boolean }>(`SELECT moves_stock FROM fiscal.operation_types WHERE code = $1`, [r.operation_type_code]);
  const retItems = await tx.query<Record<string, any>>(
    `SELECT d.id, d.quantity, d.lot_id, o.source_item_id AS receipt_item_id FROM fiscal.document_items d JOIN fiscal.document_items o ON o.id = d.original_item_id WHERE d.document_id = $1`, [retDoc.id]);
  const acc = { payable: ZERO, stock: ZERO, expense: ZERO, icms: ZERO, pis: ZERO, cofins: ZERO, ibs: ZERO, cbs: ZERO };
  for (const ri of retItems) {
    const it = await tx.one<Record<string, any>>(
      `SELECT ri.*, p.controls_stock FROM purchasing.receipt_items ri JOIN catalog.products p ON p.id = ri.product_id WHERE ri.id = $1 FOR UPDATE`, [ri.receipt_item_id]);
    const ratio = D(ri.quantity).dividedBy(it.supplier_quantity);
    const part = (v: string) => roundMoney(D(v).times(ratio));
    const stockQty = D(ri.quantity).times(it.factor);
    let stocked = false;
    if (op.moves_stock && it.controls_stock) {
      const mv = await postMovement(tx, {
        warehouseId: r.warehouse_id, productId: it.product_id, lotId: ri.lot_id, type: 'purchase_return_out', quantity: stockQty.toFixed(4), unitCost: it.entry_unit_cost,
        sourceType: 'fiscal_document', sourceId: retDoc.id, sourceItemId: ri.id, idempotencyKey: `preturn:${ri.id}`,
      });
      if (mv) {
        stocked = true;
        acc.stock = acc.stock.plus(mv.total_cost);
      }
    }
    if (!stocked) acc.expense = acc.expense.plus(part(it.entry_total_cost));
    acc.payable = acc.payable.plus(part(it.payable_amount));
    acc.icms = acc.icms.plus(part(it.recoverable_icms));
    acc.pis = acc.pis.plus(part(it.recoverable_pis));
    acc.cofins = acc.cofins.plus(part(D(it.recoverable_pis_cofins).minus(it.recoverable_pis).toFixed(2)));
    acc.ibs = acc.ibs.plus(part(it.recoverable_ibs));
    acc.cbs = acc.cbs.plus(part(it.recoverable_cbs));
    await tx.exec(`UPDATE purchasing.receipt_items SET returned_quantity = returned_quantity + $2 WHERE id = $1`, [it.id, ri.quantity]);
  }
  const credits = acc.icms.plus(acc.pis).plus(acc.cofins).plus(acc.ibs).plus(acc.cbs);
  // Diferença = frete do CT-e incorporado ao custo (não devolvido pelo fornecedor) e arredondamentos
  const freightLoss = acc.stock.plus(acc.expense).plus(credits).minus(acc.payable);
  const date = today();
  // Financeiro: abate os títulos em aberto da nota; o que sobrar vira crédito com o fornecedor
  let remaining = acc.payable;
  if (input.financialTreatment === 'abatement') {
    const open = await tx.query<{ id: string; balance: string }>(
      `SELECT id, balance FROM finance.titles WHERE origin_type = 'purchase_invoice' AND origin_id = $1 AND status IN ('open','partially_paid') ORDER BY due_date DESC`, [r.id]);
    for (const t of open) {
      if (remaining.lessThanOrEqualTo(0)) break;
      const a = min(remaining, D(t.balance));
      await abateTitle(tx, t.id, a.toFixed(2), `Devolução de compra ${number}`, { type: 'purchase_return', id: ret.id });
      remaining = remaining.minus(a);
    }
  }
  if (remaining.greaterThan(0)) {
    await createTitles(tx, { kind: 'receivable', partyId: r.supplier_id, establishmentId: r.establishment_id, originType: 'purchase_return', originId: ret.id,
      documentNumber: `DEV-COMPRA-${number}`, issueDate: date, installments: [{ dueDate: date, amount: remaining.toFixed(2) }], notes: `Crédito com o fornecedor: devolução ${number}` });
  }
  for (const [tax, amount] of [['ICMS', acc.icms], ['PIS', acc.pis], ['COFINS', acc.cofins], ['IBS', acc.ibs], ['CBS', acc.cbs]] as const) {
    if (amount.lessThanOrEqualTo(0)) continue;
    await tx.exec(`INSERT INTO fiscal.tax_credits (tenant_id, company_id, establishment_id, document_id, tax, amount, status, competence, reason) VALUES ($1,$2,$3,$4,$5,$6,'reversed',$7,$8)`,
      [tx.tenantId, r.company_id, r.establishment_id, retDoc.id, tax, amount.toFixed(2), date, `Estorno por devolução de compra ${number} (NF ${r.number})`]);
  }
  await postEvent(tx, {
    type: 'devolucao_compra', companyId: r.company_id, establishmentId: r.establishment_id, date, description: `Devolução de compra ${number}`, number: String(number),
    originType: 'fiscal_document', originId: retDoc.id, partyId: r.supplier_id,
    amounts: { invoice_total: acc.payable, stock_cost: acc.stock, expense: acc.expense, icms_credit: acc.icms, pis_credit: acc.pis, cofins_credit: acc.cofins,
      ibs_cbs_credit: acc.ibs.plus(acc.cbs), freight_loss: freightLoss },
  });
  await prepareForTransmission(tx, retDoc.id);
  return tx.one(`UPDATE purchasing.returns SET document_id = $2, total = $3, status = 'completed' WHERE id = $1 RETURNING *`, [ret.id, retDoc.id, acc.payable.toFixed(2)]);
}

registerDocumentHooks('purchase_return', {
  undone: async (tx, doc) => {
    const reason = 'Devolução de compra desfeita: NF-e de devolução não autorizada ou cancelada';
    const moves = await tx.query<{ id: string }>(`SELECT id FROM inventory.stock_movements WHERE source_type = 'fiscal_document' AND source_id = $1 AND reversal_of IS NULL`, [doc.id]);
    for (const m of moves) await reverseMovement(tx, m.id, reason, { idempotencyKey: `undo:${m.id}` });
    await reverseEntries(tx, 'fiscal_document', doc.id, today(), reason);
    if (!doc.source_id) return;
    const abatements = await tx.query<{ id: string }>(`SELECT id FROM finance.settlements WHERE reference = $1 AND kind = 'abatement' AND NOT reversed`, [`purchase_return:${doc.source_id}`]);
    for (const s of abatements) await reverseSettlement(tx, s.id, reason);
    await cancelTitlesOfOrigin(tx, 'purchase_return', doc.source_id, reason);
    await tx.exec(`UPDATE fiscal.tax_credits SET status = 'appropriated', reason = reason || ' (devolução desfeita)' WHERE document_id = $1 AND status = 'reversed'`, [doc.id]);
    const items = await tx.query<{ quantity: string; receipt_item_id: string }>(
      `SELECT d.quantity, o.source_item_id AS receipt_item_id FROM fiscal.document_items d JOIN fiscal.document_items o ON o.id = d.original_item_id WHERE d.document_id = $1`, [doc.id]);
    for (const it of items) await tx.exec(`UPDATE purchasing.receipt_items SET returned_quantity = returned_quantity - $2 WHERE id = $1`, [it.receipt_item_id, it.quantity]);
    await tx.exec(`UPDATE purchasing.returns SET status = 'cancelled' WHERE id = $1`, [doc.source_id]);
  },
});

// RN-REF-04: crédito de IBS/CBS condicionado — apropriado quando a nota está totalmente paga
subscribe('titulo.pago', async (tx, ev) => {
  const t = await tx.maybeOne<{ fiscal_document_id: string | null; origin_type: string }>(`SELECT fiscal_document_id, origin_type FROM finance.titles WHERE id = $1`, [ev.payload.id]);
  if (!t?.fiscal_document_id || t.origin_type !== 'purchase_invoice') return;
  const open = await tx.maybeOne(`SELECT 1 FROM finance.titles WHERE fiscal_document_id = $1 AND kind = 'payable' AND status IN ('open','partially_paid') LIMIT 1`, [t.fiscal_document_id]);
  if (open) return;
  await tx.exec(`UPDATE fiscal.tax_credits SET status = 'appropriated', reason = coalesce(reason, '') || ' · pagamento ao fornecedor concluído' WHERE document_id = $1 AND status = 'conditional'`,
    [t.fiscal_document_id]);
});

export async function taxCreditBook(tx: Tx, establishmentId: string | null, from: string, to: string) {
  const rows = await tx.query<{ tax: string; status: string; amount: string }>(
    `SELECT tax, status, sum(amount) AS amount FROM fiscal.tax_credits WHERE ($1::uuid IS NULL OR establishment_id = $1) AND competence BETWEEN $2 AND $3 GROUP BY tax, status ORDER BY tax, status`,
    [establishmentId, from, to]);
  const byTax = new Map<string, Record<string, string>>();
  for (const r of rows) byTax.set(r.tax, { ...(byTax.get(r.tax) ?? {}), [r.status]: D(r.amount).toFixed(2) });
  return [...byTax.entries()].map(([tax, s]) => ({
    tax, appropriated: s.appropriated ?? '0.00', conditional: s.conditional ?? '0.00', reversed: s.reversed ?? '0.00', used: s.used ?? '0.00',
    available: D(s.appropriated ?? 0).minus(s.reversed ?? 0).minus(s.used ?? 0).toFixed(2),
  }));
}

export { AppError, cleanDoc };
