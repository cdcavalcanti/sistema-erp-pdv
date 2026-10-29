import { D, sum } from '@vortex/money';
import { pdvSettingsSchema, type PdvSettings } from '@vortex/contracts';
import type { z } from 'zod';
import type { pdvCashMovementSchema, pdvHeartbeatSchema, pdvReturnSchema, pdvSaleCancelSchema } from '@vortex/contracts';
import type { Tx } from '../../db/tx.js';
import type { RequestContext } from '../../db/tx.js';
import { conflict, forbidden, notFound, ruleViolation, validation } from '../../errors.js';
import { hashPassword, randomToken, sha256 } from '../../core/crypto.js';
import { emit } from '../../core/outbox.js';
import { requireReason } from '../../core/audit.js';
import { registerDocumentHooks, undoDocumentEffects, type DocRow } from '../fiscal-docs/documents.js';
import { reverseMovement } from '../inventory/stock.js';
import { reverseSettlement } from '../finance/titles.js';
import { reverseEntries } from '../accounting/posting.js';
import { buildOperation } from '../fiscal/engine-adapter.js';
import { createSaleReturn } from '../sales/invoicing.js';
import { createParty } from '../registry/parties.js';
import { isValidCNPJ, isValidCPF } from '@vortex/validators';

/**
 * Operação do Vortex PDV no ERP: terminais, parâmetros da loja, operadores com PIN,
 * carga do contexto fiscal da NFC-e, cancelamento e devolução de vendas do PDV e
 * monitoramento. O ERP continua a autoridade de estoque, financeiro e contábil.
 */

/** Permissões que viajam para o terminal (o PDV decide offline com elas). */
const PDV_PERMISSION_PREFIX = 'pdv.';
/** Escopos da chave de API de um terminal: sincronizar e identificar/cadastrar clientes. */
export const TERMINAL_SCOPES = ['pdv.sincronizacao.executar', 'cadastros.pessoa.ler', 'cadastros.pessoa.criar'];
/** Terminal sem heartbeat há mais que isso é mostrado como offline. */
const ONLINE_WINDOW_SECONDS = 120;

// ------------------------------------------------------------------ terminais

export async function createTerminal(tx: Tx, input: { establishmentId: string; code: string; name: string }) {
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [input.establishmentId], 'Estabelecimento');
  const dup = await tx.maybeOne(`SELECT 1 FROM integration.pdv_terminals WHERE establishment_id = $1 AND code = $2`, [input.establishmentId, input.code]);
  if (dup) throw conflict('DUPLICATE', `Já existe o terminal ${input.code} nesta loja`);
  const prefix = randomToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).padEnd(10, '0');
  const secret = randomToken(32);
  const key = await tx.one<{ id: string }>(
    `INSERT INTO core.api_keys (tenant_id, name, prefix, key_hash, scopes, company_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tx.tenantId, `PDV ${input.code} — ${input.name}`, prefix, sha256(secret), TERMINAL_SCOPES, est.company_id, tx.userId]);
  const terminal = await tx.one(
    `INSERT INTO integration.pdv_terminals (tenant_id, company_id, establishment_id, code, name, api_key_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tx.tenantId, est.company_id, input.establishmentId, input.code, input.name, key.id, tx.userId]);
  // A chave só é mostrada agora: o instalador a grava no cofre local do terminal
  return { terminal, apiKey: `vx_${prefix}_${secret}` };
}

/** Nova chave para o terminal (troca do computador do caixa, chave exposta): a anterior é revogada. */
export async function rotateTerminalKey(tx: Tx, terminalId: string) {
  const t = await tx.one<{ id: string; code: string; name: string; company_id: string; api_key_id: string | null; status: string }>(
    `SELECT id, code, name, company_id, api_key_id, status FROM integration.pdv_terminals WHERE id = $1 FOR UPDATE`, [terminalId], 'Terminal');
  if (t.status !== 'active') throw conflict('INVALID_STATUS', 'Terminal bloqueado: cadastre um terminal novo');
  if (t.api_key_id) await tx.exec(`UPDATE core.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [t.api_key_id]);
  const prefix = randomToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 10).padEnd(10, '0');
  const secret = randomToken(32);
  const key = await tx.one<{ id: string }>(
    `INSERT INTO core.api_keys (tenant_id, name, prefix, key_hash, scopes, company_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tx.tenantId, `PDV ${t.code} — ${t.name}`, prefix, sha256(secret), TERMINAL_SCOPES, t.company_id, tx.userId]);
  await tx.exec(`UPDATE integration.pdv_terminals SET api_key_id = $2 WHERE id = $1`, [t.id, key.id]);
  return { terminalId: t.id, apiKey: `vx_${prefix}_${secret}` };
}

export async function setTerminalStatus(tx: Tx, id: string, status: 'active' | 'blocked') {
  const t = await tx.one<{ api_key_id: string | null }>(`UPDATE integration.pdv_terminals SET status = $2 WHERE id = $1 RETURNING api_key_id`, [id, status], 'Terminal');
  // Bloquear revoga a chave; desbloquear exige gerar terminal novo (chave nova)
  if (status === 'blocked' && t.api_key_id) await tx.exec(`UPDATE core.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [t.api_key_id]);
  return tx.one(`SELECT * FROM integration.pdv_terminals WHERE id = $1`, [id]);
}

/** Terminal que está chamando (pela chave de API). Usuários do ERP não são terminais. */
export async function callingTerminal(tx: Tx, ctx: RequestContext, establishmentId?: string) {
  if (!ctx.apiKeyId) throw forbidden('Operação exclusiva de terminal de PDV (chave de API do terminal)');
  const t = await tx.maybeOne<Record<string, any>>(`SELECT * FROM integration.pdv_terminals WHERE api_key_id = $1`, [ctx.apiKeyId]);
  if (!t) throw forbidden('Chave de API não pertence a um terminal de PDV cadastrado');
  if (t.status !== 'active') throw forbidden('Terminal bloqueado no ERP');
  if (establishmentId && t.establishment_id !== establishmentId) throw forbidden('Terminal de outra loja');
  return t;
}

export async function listTerminals(tx: Tx, establishmentId: string | null) {
  return tx.query(
    `SELECT t.id, t.establishment_id, e.trade_name AS store, t.code, t.name, t.status, t.app_version, t.last_seen_at, t.last_sync_at, t.pending_sales, t.health,
            (t.last_seen_at > now() - make_interval(secs => $2)) AS online
       FROM integration.pdv_terminals t JOIN core.establishments e ON e.id = t.establishment_id
      WHERE ($1::uuid IS NULL OR t.establishment_id = $1) ORDER BY e.trade_name, t.code`, [establishmentId, ONLINE_WINDOW_SECONDS]);
}

export async function heartbeat(tx: Tx, terminalId: string, hb: z.infer<typeof pdvHeartbeatSchema>) {
  return tx.one(
    `UPDATE integration.pdv_terminals SET app_version = $2, last_seen_at = now(), last_sync_at = coalesce($3, last_sync_at), pending_sales = $4, health = $5
      WHERE id = $1 RETURNING id, code, status, last_seen_at`,
    [terminalId, hb.appVersion, hb.lastSyncAt ?? null, hb.pendingSales, JSON.stringify(hb.health)]);
}

// ------------------------------------------------------------------ parâmetros da loja

export async function getSettings(tx: Tx, establishmentId: string): Promise<PdvSettings> {
  const row = await tx.maybeOne<{ settings: unknown }>(`SELECT settings FROM integration.pdv_settings WHERE establishment_id = $1`, [establishmentId]);
  const s = pdvSettingsSchema.parse(row?.settings ?? {});
  // Contas padrão da empresa quando a loja não definiu: CAIXA e BANCO
  if (!s.cash.cashAccountId || !s.cash.vaultAccountId) {
    const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [establishmentId], 'Estabelecimento');
    const acc = await tx.query<{ id: string; code: string }>(`SELECT id, code FROM finance.accounts WHERE company_id = $1 AND code IN ('CAIXA', 'BANCO') AND active`, [est.company_id]);
    s.cash.cashAccountId ??= acc.find((a) => a.code === 'CAIXA')?.id ?? null;
    s.cash.vaultAccountId ??= acc.find((a) => a.code === 'BANCO')?.id ?? null;
  }
  return s;
}

export async function putSettings(tx: Tx, establishmentId: string, raw: unknown) {
  const settings = pdvSettingsSchema.parse(raw);
  const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [establishmentId], 'Estabelecimento');
  for (const accId of [settings.cash.cashAccountId, settings.cash.vaultAccountId]) {
    if (!accId) continue;
    const a = await tx.maybeOne<{ company_id: string }>(`SELECT company_id FROM finance.accounts WHERE id = $1`, [accId]);
    if (!a || a.company_id !== est.company_id) throw validation({ 'cash.cashAccountId': 'Conta financeira não encontrada nesta empresa' });
  }
  const methods = await tx.query<{ code: string }>(`SELECT code FROM registry.payment_methods WHERE code = ANY($1) AND active`,
    [[settings.payments.cash, settings.payments.pix, settings.payments.debit, settings.payments.credit]]);
  for (const c of [settings.payments.cash, settings.payments.pix, settings.payments.debit, settings.payments.credit]) {
    if (!methods.some((m) => m.code === c)) throw validation({ payments: `Forma de pagamento ${c} não cadastrada no ERP` });
  }
  await tx.exec(
    `INSERT INTO integration.pdv_settings (tenant_id, establishment_id, settings, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (establishment_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [tx.tenantId, establishmentId, JSON.stringify(settings), tx.userId]);
  await emit(tx, 'pdv.configuracao_alterada', { type: 'establishment', id: establishmentId }, { establishmentId });
  return getSettings(tx, establishmentId);
}

// ------------------------------------------------------------------ operadores

export async function setOperator(tx: Tx, userId: string, input: { pdvLogin: string; pin: string }) {
  const u = await tx.one<{ id: string }>(`SELECT id FROM core.users WHERE id = $1 AND status = 'active'`, [userId], 'Usuário');
  const dup = await tx.maybeOne(`SELECT 1 FROM core.users WHERE lower(pdv_login) = lower($1) AND id <> $2`, [input.pdvLogin, userId]);
  if (dup) throw conflict('DUPLICATE', `Login de PDV ${input.pdvLogin} já usado por outro operador`);
  if (/^(\d)\1{5}$/.test(input.pin) || '0123456789'.includes(input.pin) || '9876543210'.includes(input.pin)) {
    throw validation({ pin: 'PIN fraco: evite sequências e dígitos repetidos' });
  }
  await tx.exec(`UPDATE core.users SET pdv_login = $2, pdv_pin_hash = $3, pdv_pin_updated_at = now() WHERE id = $1`, [u.id, input.pdvLogin, await hashPassword(input.pin)]);
  await emit(tx, 'pdv.operador_alterado', { type: 'user', id: u.id }, { userId: u.id });
  return { userId: u.id, pdvLogin: input.pdvLogin };
}

/** Operadores habilitados no terminal: login, hash do PIN, permissões do PDV e alçada de desconto. */
export async function operatorsFor(tx: Tx, establishmentId: string) {
  return tx.query(
    `SELECT u.id, u.name, u.pdv_login AS login, u.pdv_pin_hash AS pin_hash, u.status, u.pdv_pin_updated_at AS updated_at,
            array(SELECT DISTINCT rp.permission FROM core.user_roles ur JOIN core.role_permissions rp ON rp.role_id = ur.role_id
                   WHERE ur.user_id = u.id AND rp.permission LIKE $2 ORDER BY 1) AS permissions,
            array(SELECT r.code FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY 1) AS roles,
            (SELECT max(l.max_percent) FROM core.user_roles ur JOIN core.approval_limits l ON l.role_id = ur.role_id WHERE ur.user_id = u.id AND l.action = 'pdv.desconto') AS discount_limit_percent
       FROM core.users u
      WHERE u.pdv_login IS NOT NULL AND u.pdv_pin_hash IS NOT NULL
        AND (NOT EXISTS (SELECT 1 FROM core.user_establishments ue WHERE ue.user_id = u.id)
             OR EXISTS (SELECT 1 FROM core.user_establishments ue WHERE ue.user_id = u.id AND ue.establishment_id = $1))
        AND EXISTS (SELECT 1 FROM core.user_roles ur JOIN core.role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission = 'pdv.venda.operar')
      ORDER BY u.name`, [establishmentId, `${PDV_PERMISSION_PREFIX}%`]);
}

// ------------------------------------------------------------------ contexto fiscal da NFC-e

/**
 * O PDV calcula a NFC-e com o mesmo motor fiscal do ERP (@vortex/fiscal-engine). Esta
 * carga traz a entrada do motor já resolvida para venda presencial a consumidor final
 * nesta loja (emitente, regime, regras e alíquotas vigentes na data) e os atributos
 * fiscais de cada produto. O ERP recalcula ao receber a venda e recusa total divergente.
 */
export async function nfceFiscalContext(tx: Tx, establishmentId: string, date: string) {
  const built = await buildOperation(tx, { establishmentId, operationTypeCode: 'VENDA', date, presential: true, items: [] });
  const { items: _items, ...template } = built.input;
  const products = await tx.query(
    `SELECT id AS "productId", CASE WHEN kind = 'service' THEN 'service' ELSE 'goods' END AS kind, ncm, cest, origin, tax_group AS "taxGroup", cclasstrib,
            service_code AS "serviceCode", own_production AS "ownProduction", taxable_factor AS "taxableFactor"
       FROM catalog.products WHERE status = 'active' AND NOT is_variant_parent`);
  return { date, regime: built.regime, template, products };
}

// ------------------------------------------------------------------ cancelamento (PDV → ERP)

/** NFC-e do PDV cancelada ou denegada: estorna estoque, recebimentos e contabilidade. */
registerDocumentHooks('pdv', {
  undone: async (tx, doc, reason) => {
    const today = new Date().toISOString().slice(0, 10);
    const label = reason === 'cancelled' ? 'NFC-e cancelada no PDV' : `NFC-e ${reason}`;
    const moves = await tx.query<{ id: string }>(`SELECT id FROM inventory.stock_movements WHERE source_type = 'fiscal_document' AND source_id = $1 AND reversal_of IS NULL`, [doc.id]);
    for (const m of moves) await reverseMovement(tx, m.id, label, { idempotencyKey: `undo:${m.id}` });
    // Dinheiro e Pix foram devolvidos ao cliente no caixa: estorna a baixa; cartão é estornado na adquirente
    const titles = await tx.query<{ id: string }>(`SELECT id FROM finance.titles WHERE origin_type = 'pdv' AND origin_id = $1 AND status <> 'cancelled' FOR UPDATE`, [doc.id]);
    for (const t of titles) {
      const sts = await tx.query<{ id: string }>(`SELECT id FROM finance.settlements WHERE title_id = $1 AND kind <> 'reversal' AND NOT reversed`, [t.id]);
      for (const s of sts) await reverseSettlement(tx, s.id, `${label}: estorno do recebimento`);
      await tx.exec(`UPDATE finance.titles SET status = 'cancelled', notes = coalesce(notes || ' | ', '') || $2 WHERE id = $1`, [t.id, `Cancelado: ${label}`]);
    }
    await reverseEntries(tx, 'fiscal_document', doc.id, today, label);
  },
});

export async function cancelPdvSale(tx: Tx, terminal: Record<string, any>, input: z.infer<typeof pdvSaleCancelSchema>) {
  const sale = await tx.maybeOne<Record<string, any>>(
    `SELECT * FROM integration.pdv_sales WHERE establishment_id = $1 AND pdv_id = $2 AND sale_id = $3 FOR UPDATE`, [input.establishmentId, input.pdvId, input.saleId]);
  if (!sale) throw notFound('Venda do PDV');
  if (sale.status === 'cancelled') return { duplicate: true, saleId: input.saleId, documentId: sale.document_id, status: 'cancelled' };
  const doc = await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1 FOR UPDATE`, [sale.document_id]);
  if (!['autorizada', 'contingencia'].includes(doc.status)) throw conflict('INVALID_STATUS', `NFC-e em situação "${doc.status}" não pode ser cancelada`);
  const reason = await requireReason(tx, input.reason, 'pdv.venda.cancelar');
  await tx.exec(`UPDATE fiscal.documents SET status = 'cancelada', cancelled_at = $2, cancel_protocol = $3, cancel_reason = $4 WHERE id = $1`,
    [doc.id, input.cancelledAt, input.protocol, reason]);
  await tx.exec(
    `INSERT INTO fiscal.document_events (tenant_id, document_id, kind, status, protocol, message, payload, created_by) VALUES ($1,$2,'cancellation','registered',$3,$4,$5,$6)`,
    [tx.tenantId, doc.id, input.protocol, 'Cancelamento registrado pelo PDV', JSON.stringify({ terminal: terminal.code, operatorId: input.operatorId, authorizedBy: input.authorizedBy }), tx.userId]);
  await tx.exec(`UPDATE integration.pdv_sales SET status = 'cancelled', cancelled_at = $2, cancel_reason = $3 WHERE id = $1`, [sale.id, input.cancelledAt, reason]);
  await emit(tx, 'nota.cancelada', { type: 'fiscal_document', id: doc.id }, { id: doc.id, chave: doc.access_key, motivo: reason, origem: 'pdv' });
  await undoDocumentEffects(tx, await tx.one<DocRow>(`SELECT * FROM fiscal.documents WHERE id = $1`, [doc.id]), 'cancelled');
  return { duplicate: false, saleId: input.saleId, documentId: doc.id, status: 'cancelled' };
}

// ------------------------------------------------------------------ devolução (PDV → ERP)

const REFUND: Record<string, 'cash_refund' | 'pix_refund' | 'card_refund' | 'store_credit'> = { cash: 'cash_refund', pix: 'pix_refund', card: 'card_refund', store_credit: 'store_credit' };

/** Pessoa física pelo CPF; se não existir, cadastro mínimo com o endereço da loja (LGPD: finalidade fiscal). */
export async function findOrCreateConsumer(tx: Tx, establishmentId: string, c: { taxId: string; name: string }): Promise<string> {
  const taxId = c.taxId.replace(/\D/g, '');
  if (!isValidCPF(taxId) && !isValidCNPJ(taxId)) throw validation({ 'customer.taxId': 'CPF/CNPJ inválido' });
  const ex = await tx.maybeOne<{ id: string }>(`SELECT id FROM registry.parties WHERE tax_id = $1 AND status <> 'inactive'`, [taxId]);
  if (ex) return ex.id;
  const e = await tx.one<Record<string, any>>(`SELECT * FROM core.establishments WHERE id = $1`, [establishmentId]);
  const party = await createParty(tx, {
    kind: taxId.length === 11 ? 'PF' : 'PJ', taxId, legalName: c.name, roles: ['customer'], ieIndicator: 9, finalConsumer: true, creditLimit: '0', lgpdPurpose: 'Obrigações fiscais (devolução no PDV)',
    addresses: [{ kind: 'fiscal', zip: e.zip, street: e.street, number: e.number, district: e.district, cityIbge: e.city_ibge, cityName: e.city_name, uf: e.uf, countryCode: '1058', isDefault: true }],
    contacts: [],
  } as never);
  return party.id as string;
}

export async function pdvReturn(tx: Tx, input: z.infer<typeof pdvReturnSchema>) {
  const ex = await tx.maybeOne(`SELECT * FROM integration.pdv_returns WHERE establishment_id = $1 AND pdv_id = $2 AND reference = $3`, [input.establishmentId, input.pdvId, input.reference]);
  if (ex) return { duplicate: true, ...ex };
  const sale = await tx.maybeOne<Record<string, any>>(`SELECT * FROM integration.pdv_sales WHERE establishment_id = $1 AND sale_id = $2`, [input.establishmentId, input.saleId]);
  if (!sale) throw notFound('Venda do PDV');
  if (sale.status === 'cancelled') throw ruleViolation('RN-NFE-09', 'Venda cancelada não admite devolução');
  const orig = await tx.one<DocRow & { party_id: string | null }>(`SELECT * FROM fiscal.documents WHERE id = $1`, [sale.document_id]);
  // Consumidor não identificado na venda: a devolução identifica quem devolve (nome e CPF)
  let consumer: string | null = null;
  if (!orig.party_id) {
    if (!input.customer) throw validation({ customer: 'Venda sem cliente identificado: informe nome e CPF de quem está devolvendo' });
    consumer = await findOrCreateConsumer(tx, input.establishmentId, input.customer);
  }
  const items = await tx.query<{ id: string; item_number: number; quantity: string; returned_quantity: string }>(
    `SELECT id, item_number, quantity, returned_quantity FROM fiscal.document_items WHERE document_id = $1`, [orig.id]);
  const lines = input.items.map((i) => {
    const it = items.find((x) => x.item_number === i.itemNumber);
    if (!it) throw validation({ items: `Item ${i.itemNumber} não existe na venda` });
    if (D(i.quantity).greaterThan(D(it.quantity).minus(it.returned_quantity))) throw ruleViolation('RN-NFE-09', `Item ${i.itemNumber}: quantidade maior que a vendida e ainda não devolvida`);
    return { originalItemId: it.id, quantity: i.quantity };
  });
  const settings = await getSettings(tx, input.establishmentId);
  const refundAccount = input.refundMethod === 'cash' ? settings.cash.cashAccountId
    : input.refundMethod === 'pix' ? (await tx.maybeOne<{ financial_account_id: string }>(`SELECT financial_account_id FROM registry.payment_methods WHERE code = $1`, [settings.payments.pix]))?.financial_account_id ?? null
      : null;
  const r = await createSaleReturn(tx, {
    originalDocumentId: orig.id, items: lines, reason: input.reason, destination: input.destination, financialTreatment: REFUND[input.refundMethod]!,
    refundAccountId: refundAccount, issuer: 'own', partyId: consumer, idempotencyKey: `pdv:${input.establishmentId}:${input.pdvId}:${input.reference}`,
  });
  return { duplicate: false, ...(await tx.one(
    `INSERT INTO integration.pdv_returns (tenant_id, establishment_id, pdv_id, reference, pdv_sale_id, sales_return_id, document_id, total, refund_method, authorized_by, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [tx.tenantId, input.establishmentId, input.pdvId, input.reference, sale.id, r.returnId, r.documentId, r.total, input.refundMethod, input.authorizedBy ?? null, input.occurredAt])) };
}

// ------------------------------------------------------------------ consulta e painel

export async function getPdvSale(tx: Tx, establishmentId: string, saleId: string) {
  const s = await tx.maybeOne<Record<string, any>>(
    `SELECT s.sale_id, s.sale_uuid, s.pdv_id, s.status, s.total, s.occurred_at, s.received_at, s.cancelled_at, s.cancel_reason,
            d.id AS document_id, d.status AS fiscal_status, d.access_key, d.number, d.series, d.protocol
       FROM integration.pdv_sales s JOIN fiscal.documents d ON d.id = s.document_id WHERE s.establishment_id = $1 AND s.sale_id = $2`, [establishmentId, saleId]);
  if (!s) throw notFound('Venda do PDV');
  const items = await tx.query(
    `SELECT i.item_number, i.product_id, p.sku, i.description, i.quantity, i.returned_quantity, i.unit_price, i.total
       FROM fiscal.document_items i JOIN catalog.products p ON p.id = i.product_id WHERE i.document_id = $1 ORDER BY i.item_number`, [s.document_id]);
  const returns = await tx.query(`SELECT reference, total, refund_method, occurred_at FROM integration.pdv_returns WHERE pdv_sale_id = (SELECT id FROM integration.pdv_sales WHERE establishment_id = $1 AND sale_id = $2)`,
    [establishmentId, saleId]);
  return { ...s, items, returns };
}

/** O que o ERP já recebeu deste terminal (GET /sync/status da especificação). */
export async function syncStatus(tx: Tx, terminal: Record<string, any>) {
  const r = await tx.one<Record<string, any>>(
    `SELECT count(*) FILTER (WHERE received_at::date = current_date)::int AS sales_received_today,
            coalesce(sum(total) FILTER (WHERE received_at::date = current_date AND status = 'active'), 0) AS total_today,
            max(received_at) AS last_sale_received_at, max(sale_id) FILTER (WHERE received_at = (SELECT max(received_at) FROM integration.pdv_sales x WHERE x.establishment_id = $1 AND x.pdv_id = $2)) AS last_sale_id
       FROM integration.pdv_sales WHERE establishment_id = $1 AND pdv_id = $2`, [terminal.establishment_id, terminal.code]);
  const contingency = await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM integration.pdv_sales s JOIN fiscal.documents d ON d.id = s.document_id WHERE s.establishment_id = $1 AND s.pdv_id = $2 AND d.status = 'contingencia'`,
    [terminal.establishment_id, terminal.code]);
  return { terminal: { id: terminal.id, code: terminal.code, name: terminal.name, status: terminal.status }, serverTime: new Date().toISOString(), ...r, pendingAuthorization: contingency.n };
}

/** Painel operacional da loja (seção 47): o gerente vê todos os terminais. */
export async function storeDashboard(tx: Tx, establishmentId: string, date: string) {
  const sales = await tx.one<{ n: number; total: string }>(
    `SELECT count(*)::int AS n, coalesce(sum(total), 0) AS total FROM integration.pdv_sales WHERE establishment_id = $1 AND status = 'active'
        AND (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date = $2`, [establishmentId, date]);
  const byTerminal = await tx.query(
    `SELECT pdv_id AS terminal, count(*)::int AS sales, coalesce(sum(total), 0) AS total FROM integration.pdv_sales
      WHERE establishment_id = $1 AND status = 'active' AND (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date = $2 GROUP BY pdv_id ORDER BY pdv_id`, [establishmentId, date]);
  // Caixa aberto: abertura (ou reabertura) sem fechamento posterior na mesma sessão
  const openCash = await tx.query(
    `SELECT DISTINCT ON (m.pdv_id) m.pdv_id AS terminal, m.session_id, m.occurred_at AS opened_at, u.name AS operator
       FROM integration.pdv_cash_movements m LEFT JOIN core.users u ON u.id = m.operator_id
      WHERE m.establishment_id = $1 AND m.kind IN ('opening', 'reopening')
        AND NOT EXISTS (SELECT 1 FROM integration.pdv_cash_movements c WHERE c.establishment_id = m.establishment_id AND c.pdv_id = m.pdv_id AND c.session_id = m.session_id
                          AND c.kind = 'closing' AND c.occurred_at > m.occurred_at)
      ORDER BY m.pdv_id, m.occurred_at DESC`, [establishmentId]);
  const terminals = await listTerminals(tx, establishmentId);
  return {
    date, salesCount: sales.n, salesTotal: D(sales.total).toFixed(2), averageTicket: sales.n ? D(sales.total).dividedBy(sales.n).toFixed(2) : '0.00',
    byTerminal, openCash, operators: [...new Set(openCash.map((c) => c.operator).filter(Boolean))],
    pendingSync: sum(terminals.map((t) => D(t.pending_sales))).toNumber(), terminals,
  };
}

export type PdvCashInput = z.infer<typeof pdvCashMovementSchema>;

// ------------------------------------------------------------------ auditoria do terminal

export const PDV_AUDIT_ACTIONS = ['LOGIN', 'LOGOUT', 'LOGIN_FALHOU', 'ABERTURA_CAIXA', 'VENDA', 'CANCELAMENTO_ITEM', 'CANCELAMENTO_VENDA', 'DESCONTO', 'AUTORIZACAO', 'SANGRIA',
  'SUPRIMENTO', 'FECHAMENTO_CAIXA', 'REABERTURA_CAIXA', 'DEVOLUCAO', 'REIMPRESSAO', 'SYNC', 'ERRO_FISCAL', 'ERRO_PAGAMENTO'] as const;

/** Recebe a auditoria do terminal em lote (reenvio do mesmo evento é ignorado). */
export async function receiveEvents(tx: Tx, terminal: Record<string, any>, events: { id: string; userId: string | null; action: string; entity: string | null;
  entityId: string | null; metadata: Record<string, unknown>; timestamp: string }[]) {
  let accepted = 0;
  for (const e of events) {
    const r = await tx.maybeOne(
      `INSERT INTO integration.pdv_events (id, tenant_id, establishment_id, terminal_id, user_id, action, entity, entity_id, metadata, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [e.id, tx.tenantId, terminal.establishment_id, terminal.id, e.userId, e.action, e.entity, e.entityId, JSON.stringify(e.metadata), e.timestamp]);
    if (r) accepted++;
  }
  return { accepted, received: events.length };
}

export async function listEvents(tx: Tx, f: { establishmentId: string | null; action: string | null; from: string | null; limit: number }) {
  return tx.query(
    `SELECT e.id, e.action, e.entity, e.entity_id, e.metadata, e.occurred_at, t.code AS terminal, u.name AS user_name
       FROM integration.pdv_events e JOIN integration.pdv_terminals t ON t.id = e.terminal_id LEFT JOIN core.users u ON u.id = e.user_id
      WHERE ($1::uuid IS NULL OR e.establishment_id = $1) AND ($2::text IS NULL OR e.action = $2) AND ($3::timestamptz IS NULL OR e.occurred_at >= $3)
      ORDER BY e.occurred_at DESC LIMIT $4`, [f.establishmentId, f.action, f.from, f.limit]);
}

// ---------------------------------------------------------------- vendas do PDV no ERP (backoffice)
export interface PdvSalesFilter { establishmentId: string | null; pdvId: string | null; from: string | null; to: string | null; status: string | null; q: string | null }

const salesWhere = `($1::uuid IS NULL OR s.establishment_id = $1) AND ($2::text IS NULL OR s.pdv_id = $2) AND ($3::date IS NULL OR s.occurred_at >= $3::date)
  AND ($4::date IS NULL OR s.occurred_at < $4::date + 1) AND ($5::text IS NULL OR s.status = $5 OR ($5 = 'with_cancelled_items' AND jsonb_array_length(s.cancelled_items) > 0))
  AND ($6::text IS NULL OR s.sale_id ILIKE '%' || $6 || '%' OR d.recipient_name ILIKE '%' || $6 || '%' OR s.operator_name ILIKE '%' || $6 || '%' OR d.number::text = $6)`;
const salesArgs = (f: PdvSalesFilter) => [f.establishmentId, f.pdvId, f.from, f.to, f.status, f.q || null];

/** Vendas recebidas dos terminais, mais recentes primeiro (cursor por data da venda). */
export async function listPdvSales(tx: Tx, f: PdvSalesFilter, limit: number, cursor: { at: string; id: string } | null) {
  return tx.query<Record<string, any> & { created_at: string; id: string }>(
    `SELECT s.id, s.occurred_at AS created_at, s.sale_id, s.pdv_id, s.status, s.total, s.occurred_at, s.received_at, s.operator_name,
            jsonb_array_length(s.cancelled_items)::int AS cancelled_items_count, d.id AS document_id, d.status AS fiscal_status, d.series, d.number, d.emission_type,
            d.recipient_name, d.payments, e.trade_name AS store_name,
            (SELECT count(*) FROM fiscal.document_items i WHERE i.document_id = d.id)::int AS items_count,
            (SELECT count(*) FROM integration.pdv_returns r WHERE r.pdv_sale_id = s.id)::int AS returns_count
       FROM integration.pdv_sales s JOIN fiscal.documents d ON d.id = s.document_id JOIN core.establishments e ON e.id = s.establishment_id
      WHERE ${salesWhere} AND ($7::timestamptz IS NULL OR (s.occurred_at, s.id) < ($7, $8::uuid))
      ORDER BY s.occurred_at DESC, s.id DESC LIMIT $9`,
    [...salesArgs(f), cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
}

/** Totais do período (mesmos filtros da lista): vendas, ticket, cancelamentos e por terminal/operador. */
export async function pdvSalesSummary(tx: Tx, f: PdvSalesFilter) {
  const base = `FROM integration.pdv_sales s JOIN fiscal.documents d ON d.id = s.document_id WHERE ${salesWhere}`;
  const t = await tx.one<Record<string, any>>(
    `SELECT count(*) FILTER (WHERE s.status = 'active')::int AS sales, coalesce(sum(s.total) FILTER (WHERE s.status = 'active'), 0) AS total,
            count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled_sales, coalesce(sum(s.total) FILTER (WHERE s.status = 'cancelled'), 0) AS cancelled_total,
            count(*) FILTER (WHERE d.status = 'contingencia')::int AS pending_authorization,
            coalesce(sum((SELECT sum((c->>'quantity')::numeric * (c->>'unitPrice')::numeric) FROM jsonb_array_elements(s.cancelled_items) c)), 0) AS cancelled_items_value,
            coalesce(sum(jsonb_array_length(s.cancelled_items)), 0)::int AS cancelled_items ${base}`, salesArgs(f));
  const byTerminal = await tx.query(
    `SELECT s.pdv_id, count(*)::int AS sales, coalesce(sum(s.total), 0) AS total ${base} AND s.status = 'active' GROUP BY s.pdv_id ORDER BY s.pdv_id`, salesArgs(f));
  const byOperator = await tx.query(
    `SELECT coalesce(s.operator_name, 'Sem operador') AS operator, count(*)::int AS sales, coalesce(sum(s.total), 0) AS total,
            coalesce(sum(jsonb_array_length(s.cancelled_items)), 0)::int AS cancelled_items ${base} AND s.status = 'active' GROUP BY 1 ORDER BY 3 DESC`, salesArgs(f));
  const sales = Number(t.sales);
  return { ...t, averageTicket: sales ? D(t.total).dividedBy(sales).toFixed(2) : '0.00', byTerminal, byOperator };
}

/** Venda do PDV pelo id interno (tela do ERP): itens, cancelados no caixa, pagamentos, devoluções e auditoria. */
export async function getPdvSaleById(tx: Tx, id: string) {
  const s = await tx.maybeOne<Record<string, any>>(
    `SELECT s.*, d.status AS fiscal_status, d.access_key, d.number, d.series, d.protocol, d.emission_type, d.recipient_name, d.recipient_tax_id, d.payments,
            d.total_products, d.total_discount, d.total_invoice, e.trade_name AS store_name
       FROM integration.pdv_sales s JOIN fiscal.documents d ON d.id = s.document_id JOIN core.establishments e ON e.id = s.establishment_id WHERE s.id = $1`, [id]);
  if (!s) throw notFound('Venda do PDV');
  const items = await tx.query(
    `SELECT i.item_number, i.product_id, p.sku, i.description, i.quantity, i.returned_quantity, i.unit_price, i.discount, i.total
       FROM fiscal.document_items i JOIN catalog.products p ON p.id = i.product_id WHERE i.document_id = $1 ORDER BY i.item_number`, [s.document_id]);
  const returns = await tx.query(`SELECT reference, total, refund_method, occurred_at FROM integration.pdv_returns WHERE pdv_sale_id = $1 ORDER BY occurred_at`, [id]);
  const events = await tx.query(
    `SELECT e.action, e.metadata, e.occurred_at, u.name AS user_name FROM integration.pdv_events e LEFT JOIN core.users u ON u.id = e.user_id
      WHERE e.entity_id = $1 ORDER BY e.occurred_at`, [s.sale_uuid ?? s.sale_id]);
  const people = await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM core.users WHERE id = ANY($1::uuid[])`,
    [[...new Set((s.cancelled_items as any[]).flatMap((c) => [c.operatorId, c.authorizedBy]).filter(Boolean))]]);
  const name = (uid: string | null) => people.find((p) => p.id === uid)?.name ?? null;
  const cancelledItems = (s.cancelled_items as any[]).map((c) => ({ ...c, operatorName: name(c.operatorId), authorizedByName: name(c.authorizedBy) }));
  return { ...s, cancelled_items: cancelledItems, items, returns, events };
}

/** Movimentos de caixa dos terminais (abertura, suprimento, sangria, fechamento com diferença, reabertura). */
export async function listPdvCash(tx: Tx, f: { establishmentId: string | null; pdvId: string | null; from: string | null; to: string | null; limit: number }) {
  return tx.query(
    `SELECT m.id, m.pdv_id, m.kind, m.amount, m.expected, m.counted, m.difference, m.reason, m.details, m.session_id, m.occurred_at,
            u.name AS operator_name, a.name AS authorized_by_name, e.trade_name AS store_name
       FROM integration.pdv_cash_movements m JOIN core.establishments e ON e.id = m.establishment_id
       LEFT JOIN core.users u ON u.id = m.operator_id LEFT JOIN core.users a ON a.id = m.authorized_by
      WHERE ($1::uuid IS NULL OR m.establishment_id = $1) AND ($2::text IS NULL OR m.pdv_id = $2) AND ($3::date IS NULL OR m.occurred_at >= $3::date)
        AND ($4::date IS NULL OR m.occurred_at < $4::date + 1)
      ORDER BY m.occurred_at DESC LIMIT $5`, [f.establishmentId, f.pdvId, f.from, f.to, f.limit]);
}
