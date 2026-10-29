import { D } from '@vortex/money';
import type { RequestContext, Tx } from '../../db/tx.js';
import { requirePerm } from '../../core/access.js';
import { conflict, notFound, validation } from '../../errors.js';
import { updateProduct } from '../catalog/products.js';
import { createTitles, renegotiate } from '../finance/titles.js';
import { createPurchaseOrder } from '../purchasing/orders.js';

/** Quem pode confirmar cada tipo de rascunho: a mesma permissão da ação feita à mão. */
export const CONFIRM_PERMISSION: Record<string, string> = {
  ncm_classification: 'fiscal.regra.editar',
  payable_title: 'financeiro.titulo.criar',
  renegotiation: 'financeiro.titulo.renegociar',
  purchase_suggestion: 'compras.pedido.criar',
};

export async function listDrafts(tx: Tx, q: { status?: string; kind?: string }) {
  return tx.query(
    `SELECT * FROM ai.drafts WHERE ($1::uuid IS NULL OR company_id = $1 OR company_id IS NULL) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR kind = $3)
      ORDER BY created_at DESC LIMIT 200`, [tx.companyId, q.status ?? null, q.kind ?? null]);
}

async function lockPending(tx: Tx, id: string) {
  const d = await tx.maybeOne<Record<string, any>>(`SELECT * FROM ai.drafts WHERE id = $1 FOR UPDATE`, [id]);
  if (!d) throw notFound('Rascunho');
  if (d.status !== 'pending') throw conflict('INVALID_STATUS', 'Rascunho já confirmado ou descartado');
  return d;
}

/**
 * RN-IA-01: o humano confirma (podendo ajustar os campos) e só então a ação acontece, com as
 * mesmas validações e permissões do caminho manual.
 */
export async function confirmDraft(tx: Tx, ctx: RequestContext, id: string, overrides: Record<string, any> = {}) {
  const d = await lockPending(tx, id);
  requirePerm(ctx, CONFIRM_PERMISSION[d.kind]!);
  const p = { ...d.payload, ...overrides };
  let result: { type: string; id: string | null; data: unknown };
  if (d.kind === 'ncm_classification') {
    const s = { ...d.payload.suggestion, ...(overrides.suggestion ?? {}) };
    if (!p.productId) {
      result = { type: 'classification', id: null, data: s };
    } else {
      const cur = await tx.one<{ version: number }>(`SELECT version FROM catalog.products WHERE id = $1`, [p.productId], 'Produto');
      const row = await updateProduct(tx, p.productId, { version: cur.version, ncm: s.ncm, cest: s.cest ?? null, ...(s.cclasstrib ? { cclasstrib: s.cclasstrib } : {}) } as never);
      result = { type: 'product', id: p.productId, data: { ncm: row.ncm, cest: row.cest, cclasstrib: row.cclasstrib } };
    }
  } else if (d.kind === 'payable_title') {
    const errs: Record<string, string> = {};
    if (!p.partyId) errs.partyId = 'Informe o fornecedor (cadastre-o se for novo)';
    if (!p.amount || D(p.amount).lessThanOrEqualTo(0)) errs.amount = 'Informe o valor';
    if (!p.dueDate) errs.dueDate = 'Informe o vencimento';
    if (Object.keys(errs).length) throw validation(errs);
    const [t] = await createTitles(tx, {
      kind: 'payable', partyId: p.partyId, originType: 'manual', documentNumber: p.documentNumber ?? `DOC-${id.slice(0, 8)}`, issueDate: p.issueDate ?? new Date().toISOString().slice(0, 10),
      installments: [{ dueDate: p.dueDate, amount: D(p.amount).toFixed(2) }], categoryId: p.categoryId ?? null, costCenterId: p.costCenterId ?? null,
      notes: [p.description, p.fileName && `Documento: ${p.fileName}`].filter(Boolean).join(' · ') || null, idempotencyKey: `ai-draft:${id}`,
    });
    if (p.digitableLine) await tx.exec(`UPDATE finance.titles SET digitable_line = $2 WHERE id = $1`, [t!.id, p.digitableLine]);
    result = { type: 'title', id: t!.id, data: t };
  } else if (d.kind === 'renegotiation') {
    const r = await renegotiate(tx, {
      titleIds: p.titleIds, installments: p.installments, chargesNegotiated: p.charges, discountGranted: p.discount,
      reason: overrides.reason ?? `Acordo de cobrança ${id.slice(0, 8)} aprovado (${p.installments.length} parcela(s))`, date: p.date,
    });
    if (p.pix && r.titles[0]) {
      await tx.exec(`UPDATE finance.titles SET pix_txid = $2, pix_qr_code = $3, account_id = coalesce(account_id, $4) WHERE id = $1`, [r.titles[0].id, p.pix.txid, p.pix.qrCode, p.pix.accountId]);
    }
    result = { type: 'renegotiation', id: r.renegotiationId, data: r };
  } else {
    // Sugestão de compra: um pedido em rascunho por fornecedor (o comprador ainda revisa e envia)
    const chosen: string[] | null = overrides.productIds ?? null;
    const items = (p.items as any[]).filter((i) => !chosen || chosen.includes(i.productId));
    const bySupplier = new Map<string, any[]>();
    for (const i of items) {
      if (!i.supplierId) continue;
      bySupplier.set(i.supplierId, [...(bySupplier.get(i.supplierId) ?? []), i]);
    }
    if (!bySupplier.size) throw validation({ items: 'Nenhum item com fornecedor definido' });
    const orders = [];
    for (const [supplierId, list] of bySupplier) {
      orders.push(await createPurchaseOrder(tx, {
        establishmentId: p.establishmentId, warehouseId: p.warehouseId, supplierId, notes: `Gerado da sugestão de compra ${id.slice(0, 8)}`,
        items: list.map((i) => ({ productId: i.productId, quantity: i.suggestedQuantity, unitPrice: i.lastPrice ?? '0' })), idempotencyKey: `ai-draft:${id}:${supplierId}`,
      }));
    }
    result = { type: 'purchase_orders', id: null, data: orders };
  }
  await tx.exec(`UPDATE ai.drafts SET status = 'confirmed', decided_at = now(), decided_by = $2, result_type = $3, result_id = $4, payload = $5 WHERE id = $1`,
    [id, tx.userId, result.type, result.id, JSON.stringify(p)]);
  return { draftId: id, status: 'confirmed', result };
}

export async function discardDraft(tx: Tx, id: string) {
  await lockPending(tx, id);
  return tx.one(`UPDATE ai.drafts SET status = 'discarded', decided_at = now(), decided_by = $2 WHERE id = $1 RETURNING *`, [id, tx.userId]);
}
