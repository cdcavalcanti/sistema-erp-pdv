import { D, roundMoney, sum } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { conflict, notFound, validation } from '../../errors.js';
import type { Services } from '../../services.js';
import { createOutgoingDocument, prepareForTransmission } from '../fiscal-docs/documents.js';
import { createTitles } from '../finance/titles.js';
import { postEvent, reverseEntries } from '../accounting/posting.js';
import { postMovement, reverseMovement } from '../inventory/stock.js';

/**
 * Ordens de serviço (seção 16): abertura, técnico, agenda, peças usadas (baixam
 * estoque), horas, assinatura do cliente e faturamento da OS por NFS-e.
 */
export async function createServiceOrder(tx: Tx, input: { establishmentId: string; partyId: string; contractId?: string | null; serviceProductId: string; technicianId?: string | null;
  description: string; scheduledAt?: string | null; hourlyRate?: string | null; warehouseId?: string | null }) {
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  const svc = await tx.one<{ service_code: string | null }>(`SELECT service_code FROM catalog.products WHERE id = $1`, [input.serviceProductId], 'Serviço');
  if (!svc.service_code) throw validation({ serviceProductId: 'Informe um produto do tipo serviço (com código da LC 116)' });
  const wh = input.warehouseId ?? (await tx.one<{ id: string }>(`SELECT id FROM core.warehouses WHERE establishment_id = $1 AND kind = 'own' AND active ORDER BY (code = 'PRINCIPAL') DESC LIMIT 1`,
    [input.establishmentId], 'Depósito')).id;
  const number = (await tx.one<{ n: string }>(`SELECT core.next_counter($1, 'service_order') AS n`, [est.company_id])).n;
  const so = await tx.one<{ id: string }>(
    `INSERT INTO contracts.service_orders (tenant_id, company_id, establishment_id, warehouse_id, number, party_id, contract_id, service_product_id, technician_id, status, description,
       scheduled_at, hourly_rate, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [tx.tenantId, est.company_id, input.establishmentId, wh, number, input.partyId, input.contractId ?? null, input.serviceProductId, input.technicianId ?? null,
      input.scheduledAt ? 'scheduled' : 'open', input.description, input.scheduledAt ?? null, input.hourlyRate ?? '0', tx.userId]);
  return getServiceOrder(tx, so.id);
}

export async function getServiceOrder(tx: Tx, id: string) {
  const so = await tx.maybeOne(`SELECT so.*, p.legal_name AS party_name, t.legal_name AS technician_name FROM contracts.service_orders so JOIN registry.parties p ON p.id = so.party_id
                                  LEFT JOIN registry.parties t ON t.id = so.technician_id WHERE so.id = $1`, [id]);
  if (!so) throw notFound('Ordem de serviço');
  const parts = await tx.query(`SELECT sp.*, p.sku, p.description FROM contracts.service_order_parts sp JOIN catalog.products p ON p.id = sp.product_id WHERE service_order_id = $1 ORDER BY sp.created_at`, [id]);
  const partsTotal = sum(parts.map((p) => roundMoney(D(p.quantity).times(p.unit_price))));
  return { ...so, parts, partsTotal: partsTotal.toFixed(2), laborTotal: roundMoney(D(so.hours).times(so.hourly_rate)).toFixed(2) };
}

async function editable(tx: Tx, id: string) {
  const so = await tx.one<Record<string, any>>(`SELECT * FROM contracts.service_orders WHERE id = $1 FOR UPDATE`, [id], 'Ordem de serviço');
  if (['invoiced', 'cancelled'].includes(so.status)) throw conflict('INVALID_STATUS', 'OS faturada ou cancelada não se altera');
  return so;
}

export async function updateServiceOrder(tx: Tx, id: string, input: { status?: 'scheduled' | 'in_progress' | 'done'; scheduledAt?: string | null; technicianId?: string | null; hours?: string;
  hourlyRate?: string }) {
  const so = await editable(tx, id);
  if (input.status === 'done' && !so.signed_at) throw validation({ status: 'Colha a assinatura do cliente antes de concluir a OS' });
  await tx.exec(
    `UPDATE contracts.service_orders SET status = coalesce($2, status), scheduled_at = coalesce($3, scheduled_at), technician_id = coalesce($4, technician_id), hours = coalesce($5, hours),
            hourly_rate = coalesce($6, hourly_rate), started_at = CASE WHEN $2 = 'in_progress' THEN coalesce(started_at, now()) ELSE started_at END,
            finished_at = CASE WHEN $2 = 'done' THEN now() ELSE finished_at END WHERE id = $1`,
    [id, input.status ?? null, input.scheduledAt ?? null, input.technicianId ?? null, input.hours ?? null, input.hourlyRate ?? null]);
  return getServiceOrder(tx, id);
}

/** Peça aplicada: baixa o estoque na hora (custo médio vai para o CMV da OS). */
export async function addPart(tx: Tx, id: string, input: { productId: string; quantity: string; unitPrice: string }) {
  const so = await editable(tx, id);
  const part = await tx.one<{ id: string }>(`INSERT INTO contracts.service_order_parts (tenant_id, service_order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tx.tenantId, id, input.productId, input.quantity, input.unitPrice]);
  const mv = await postMovement(tx, { warehouseId: so.warehouse_id, productId: input.productId, type: 'sale_out', quantity: input.quantity, sourceType: 'service_order', sourceId: id,
    sourceItemId: part.id, idempotencyKey: `os-part:${part.id}` });
  if (mv) {
    await tx.exec(`UPDATE contracts.service_order_parts SET movement_id = $2, unit_cost = $3 WHERE id = $1`, [part.id, mv.id, mv.unit_cost]);
    await postEvent(tx, { type: 'consumo_os', companyId: so.company_id, establishmentId: so.establishment_id, date: new Date().toISOString().slice(0, 10), description: `Peças OS ${so.number}`,
      number: String(so.number), originType: 'service_order_part', originId: part.id, amounts: { value: mv.total_cost } });
  }
  return getServiceOrder(tx, id);
}

export async function removePart(tx: Tx, id: string, partId: string) {
  await editable(tx, id);
  const p = await tx.one<{ movement_id: string | null }>(`SELECT movement_id FROM contracts.service_order_parts WHERE id = $1 AND service_order_id = $2`, [partId, id], 'Peça');
  if (p.movement_id) {
    await reverseMovement(tx, p.movement_id, 'Peça devolvida ao estoque', { idempotencyKey: `os-part-undo:${partId}` });
    await reverseEntries(tx, 'service_order_part', partId, new Date().toISOString().slice(0, 10), 'Peça devolvida ao estoque');
  }
  await tx.exec(`DELETE FROM contracts.service_order_parts WHERE id = $1`, [partId]);
  return getServiceOrder(tx, id);
}

/** Assinatura do cliente (nome e imagem da assinatura guardada no armazenamento imutável). */
export async function signServiceOrder(tx: Tx, services: Services, id: string, input: { signedBy: string; signaturePng?: string | null }) {
  await editable(tx, id);
  let key: string | null = null;
  if (input.signaturePng) {
    const buf = Buffer.from(input.signaturePng.replace(/^data:image\/png;base64,/, ''), 'base64');
    key = (await services.storage.putImmutable(`os/${tx.tenantId}/${id}/assinatura.png`, buf, 'image/png')).key;
  }
  await tx.exec(`UPDATE contracts.service_orders SET signed_by = $2, signed_at = now(), signature_key = $3 WHERE id = $1`, [id, input.signedBy, key]);
  return getServiceOrder(tx, id);
}

/** Faturamento da OS: NFS-e (mão de obra + peças aplicadas), título e contabilização. */
export async function invoiceServiceOrder(tx: Tx, id: string, input: { dueDate?: string | null } = {}) {
  const so = await tx.one<Record<string, any>>(`SELECT * FROM contracts.service_orders WHERE id = $1 FOR UPDATE`, [id], 'Ordem de serviço');
  if (so.status !== 'done') throw conflict('INVALID_STATUS', 'Somente OS concluída (com assinatura) é faturada');
  const view = await getServiceOrder(tx, id);
  const items: { id: string; productId: string; quantity: string; unitPrice: string }[] = [];
  if (D(so.hours).greaterThan(0) && D(so.hourly_rate).greaterThan(0)) items.push({ id: 'labor', productId: so.service_product_id, quantity: D(so.hours).toString(), unitPrice: D(so.hourly_rate).toFixed(2) });
  if (D(view.partsTotal).greaterThan(0)) items.push({ id: 'parts', productId: so.service_product_id, quantity: '1', unitPrice: view.partsTotal });
  if (!items.length) throw validation({ hours: 'OS sem horas nem peças para faturar' });
  const date = new Date().toISOString().slice(0, 10);
  const doc = await createOutgoingDocument(tx, {
    establishmentId: so.establishment_id, operationTypeCode: 'SERVICO', model: '99', partyId: so.party_id, date, presence: 9, items, sourceType: 'service_order', sourceId: id,
    additionalInfo: `OS nº ${so.number}: ${so.description}${D(view.partsTotal).greaterThan(0) ? ` (inclui peças aplicadas: R$ ${view.partsTotal})` : ''}`, idempotencyKey: `os:${id}`,
  });
  await prepareForTransmission(tx, doc.id);
  const [title] = await createTitles(tx, { kind: 'receivable', partyId: so.party_id, establishmentId: so.establishment_id, originType: 'service_order', originId: id, fiscalDocumentId: doc.id,
    documentNumber: `OS${so.number}`, issueDate: date, installments: [{ dueDate: input.dueDate ?? date, amount: doc.total_invoice }], idempotencyKey: `os:${id}` });
  const t = doc.totals as Record<string, string>;
  await postEvent(tx, { type: 'venda_faturada', companyId: doc.company_id, establishmentId: doc.establishment_id, date, description: `OS ${so.number}`, number: `OS${so.number}`,
    originType: 'fiscal_document', originId: doc.id, operationTypeCode: 'SERVICO', partyId: so.party_id,
    amounts: { invoice_total: doc.total_invoice, receivable_total: doc.total_invoice, pis: t.pis, cofins: t.cofins, iss: t.iss, icms: '0', cmv: '0' } });
  await tx.exec(`UPDATE contracts.service_orders SET status = 'invoiced', document_id = $2 WHERE id = $1`, [id, doc.id]);
  return { documentId: doc.id, titleId: title!.id, total: doc.total_invoice };
}
