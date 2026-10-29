import { z } from 'zod';
import { D } from '@vortex/money';
import { route, type App } from '../../http/app.js';
import { decimal, decodeCursor, idParams, isoDate, page } from '../../http/schemas.js';
import { AppError, validation } from '../../errors.js';
import { systemContext, withTenant } from '../../db/tx.js';
import { hmacSha256, safeEqual } from '../../core/crypto.js';
import { requirePerm } from '../../core/access.js';
import { postEvent } from '../accounting/posting.js';
import {
  approvePayable, compensateAdvance, createAdvance, createTitles, getTitle, renegotiate, reverseSettlement, settleTitle, transferBetweenAccounts,
} from './titles.js';
import { approvePaymentBatch, confirmPaymentBatchItem, createPaymentBatch, processBankNotification, registerCharge, sendPaymentBatch } from './charges.js';
import { accountBalances, aging, cashFlow, managementDre } from './reports.js';

export function registerFinanceRoutes(app: App) {
  route(app, {
    method: 'GET', url: '/v1/finance/titles', summary: 'Contas a receber e a pagar', tags: ['Financeiro'], permission: 'financeiro.titulo.ler',
    query: z.object({ kind: z.enum(['receivable', 'payable']).optional(), status: z.string().optional(), partyId: z.string().uuid().optional(), overdue: z.coerce.boolean().optional(),
      dueFrom: isoDate.optional(), dueTo: isoDate.optional(), limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().optional() }),
  }, async ({ tx, ctx, query }) => {
    const c = decodeCursor(query.cursor);
    const rows = await tx.query(
      `SELECT t.*, p.legal_name AS party_name, (t.due_date < current_date AND t.status IN ('open','partially_paid')) AS overdue
         FROM finance.titles t JOIN registry.parties p ON p.id = t.party_id
        WHERE ($1::uuid IS NULL OR t.company_id = $1) AND ($2::text IS NULL OR t.kind = $2) AND ($3::text IS NULL OR t.status = $3) AND ($4::uuid IS NULL OR t.party_id = $4)
          AND ($5::boolean IS NULL OR (t.due_date < current_date AND t.status IN ('open','partially_paid')) = $5) AND ($6::date IS NULL OR t.due_date >= $6) AND ($7::date IS NULL OR t.due_date <= $7)
          AND ($8::timestamptz IS NULL OR (t.created_at, t.id) < ($8, $9::uuid))
        ORDER BY t.created_at DESC, t.id DESC LIMIT $10`,
      [ctx.companyId, query.kind ?? null, query.status ?? null, query.partyId ?? null, query.overdue ?? null, query.dueFrom ?? null, query.dueTo ?? null, c?.at ?? null, c?.id ?? null, query.limit + 1]);
    return page(rows, query.limit);
  });

  route(app, { method: 'GET', url: '/v1/finance/titles/:id', summary: 'Título com baixas, cobranças e encargos do dia', tags: ['Financeiro'], permission: 'financeiro.titulo.ler', params: idParams },
    async ({ tx, params }) => getTitle(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/finance/titles', summary: 'Lançamento manual de título (com permissão), com rateio por centro de custo', tags: ['Financeiro'], permission: 'financeiro.titulo.criar', status: 201, company: true,
    body: z.object({
      kind: z.enum(['receivable', 'payable']), partyId: z.string().uuid(), documentNumber: z.string().min(1), issueDate: isoDate, competenceDate: isoDate.optional(),
      installments: z.array(z.object({ dueDate: isoDate, amount: decimal({ positive: true }) })).min(1), categoryId: z.string().uuid(), costCenterId: z.string().uuid().nullish(),
      projectId: z.string().uuid().nullish(), establishmentId: z.string().uuid().nullish(), paymentMethodId: z.string().uuid().nullish(), accountId: z.string().uuid().nullish(),
      allocations: z.array(z.object({ costCenterId: z.string().uuid(), percent: decimal({ positive: true }) })).optional(), notes: z.string().nullish(),
    }),
  }, async ({ tx, body, req }) => {
    if (body.allocations?.length && !body.allocations.reduce((a, x) => a.plus(x.percent), D(0)).equals(100)) throw validation({ allocations: 'Rateio por centro de custo deve somar 100%' });
    const titles = await createTitles(tx, { ...body, originType: 'manual', idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null });
    const cat = await tx.one<{ ledger_account_id: string | null }>(`SELECT ledger_account_id FROM finance.categories WHERE id = $1`, [body.categoryId], 'Categoria');
    for (const t of titles) {
      for (const a of body.allocations ?? []) await tx.exec(`INSERT INTO finance.title_allocations (tenant_id, title_id, cost_center_id, percent) VALUES ($1,$2,$3,$4)`, [tx.tenantId, t.id, a.costCenterId, a.percent]);
      await postEvent(tx, { type: body.kind === 'payable' ? 'titulo_manual_pagar' : 'titulo_manual_receber', companyId: t.company_id, establishmentId: t.establishment_id, date: body.competenceDate ?? body.issueDate,
        description: `Título ${t.document_number}/${t.installment}`, number: `${t.document_number}/${t.installment}`, originType: 'title', originId: t.id, partyId: t.party_id, categoryId: body.categoryId,
        costCenterId: body.costCenterId ?? null, amounts: { amount: t.amount }, ledgers: { category_ledger: cat.ledger_account_id } });
    }
    return titles;
  });

  route(app, {
    method: 'POST', url: '/v1/finance/titles/:id/settle', summary: 'Baixa total ou parcial com encargos (RN-FIN-02/03)', tags: ['Financeiro'], permission: 'financeiro.titulo.baixar', params: idParams,
    body: z.object({ date: isoDate, accountId: z.string().uuid(), amount: decimal({ min: 0 }), interest: decimal({ min: 0 }).optional(), fine: decimal({ min: 0 }).optional(),
      discount: decimal({ min: 0 }).optional(), method: z.string().optional(), reference: z.string().optional(), waiveCharges: z.boolean().optional() }),
  }, async ({ tx, ctx, params, body, req }) => {
    if ((body.discount && D(body.discount).greaterThan(0)) || body.waiveCharges) requirePerm(ctx, 'financeiro.titulo.renegociar');
    return settleTitle(tx, params.id, { ...body, idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null });
  });

  route(app, {
    method: 'POST', url: '/v1/finance/settlements/:id/reverse', summary: 'Estorno de baixa (caminho inverso, com motivo — RN-FIN-06)', tags: ['Financeiro'], permission: 'financeiro.titulo.estornar', params: idParams,
    body: z.object({ reason: z.string() }),
  }, async ({ tx, params, body }) => reverseSettlement(tx, params.id, body.reason));

  route(app, {
    method: 'POST', url: '/v1/finance/titles/:id/approve', summary: 'Aprova pagamento (segregação de funções — RN-ACE-01)', tags: ['Financeiro'], permission: 'financeiro.titulo.aprovar', params: idParams,
  }, async ({ tx, params }) => approvePayable(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/finance/renegotiations', summary: 'Renegociação (RN-FIN-04)', tags: ['Financeiro'], permission: 'financeiro.titulo.renegociar', status: 201,
    body: z.object({ titleIds: z.array(z.string().uuid()).min(1), installments: z.array(z.object({ dueDate: isoDate, amount: decimal({ positive: true }) })).min(1),
      chargesNegotiated: decimal({ min: 0 }).default('0'), discountGranted: decimal({ min: 0 }).default('0'), reason: z.string() }),
  }, async ({ tx, body }) => renegotiate(tx, body));

  route(app, {
    method: 'POST', url: '/v1/finance/advances', summary: 'Adiantamento de cliente ou a fornecedor (RN-FIN-05)', tags: ['Financeiro'], permission: 'financeiro.titulo.baixar', status: 201, company: true,
    body: z.object({ partyId: z.string().uuid(), from: z.enum(['customer', 'supplier']), amount: decimal({ positive: true }), accountId: z.string().uuid(), date: isoDate, reference: z.string().optional() }),
  }, async ({ tx, body }) => createAdvance(tx, body));

  route(app, {
    method: 'POST', url: '/v1/finance/advances/:id/compensate', summary: 'Compensa adiantamento com título futuro', tags: ['Financeiro'], permission: 'financeiro.titulo.baixar', params: idParams,
    body: z.object({ titleId: z.string().uuid(), amount: decimal({ positive: true }).optional() }),
  }, async ({ tx, params, body }) => compensateAdvance(tx, params.id, body.titleId, body.amount));

  route(app, {
    method: 'POST', url: '/v1/finance/titles/:id/write-off', summary: 'Baixa por perda (incobrável)', tags: ['Financeiro'], permission: 'financeiro.titulo.renegociar', params: idParams,
    body: z.object({ reason: z.string() }),
  }, async ({ tx, params, body }) => {
    const { requireReason } = await import('../../core/audit.js');
    await requireReason(tx, body.reason, 'financeiro.titulo.perda');
    const t = await tx.one<Record<string, any>>(`SELECT * FROM finance.titles WHERE id = $1 FOR UPDATE`, [params.id], 'Título');
    if (t.kind !== 'receivable' || !['open', 'partially_paid'].includes(t.status)) throw validation({ id: 'Somente título a receber em aberto' });
    await tx.exec(`INSERT INTO finance.settlements (tenant_id, company_id, title_id, settlement_date, principal, total, kind, reason, created_by) VALUES ($1,$2,$3,current_date,$4,0,'loss',$5,$6)`,
      [tx.tenantId, t.company_id, t.id, t.balance, body.reason, tx.userId]);
    await tx.exec(`UPDATE finance.titles SET status = 'lost', paid_principal = paid_principal + balance, balance = 0 WHERE id = $1`, [t.id]);
    await postEvent(tx, { type: 'perda_titulo', companyId: t.company_id, date: new Date().toISOString().slice(0, 10), description: 'Perda com cliente', number: t.document_number, originType: 'title_loss',
      originId: t.id, partyId: t.party_id, amounts: { amount: t.balance } });
    return { lost: t.balance };
  });

  // ---------------------------------------------------------------- cobrança: boleto e Pix
  route(app, {
    method: 'POST', url: '/v1/finance/titles/:id/charge', summary: 'Registra boleto (híbrido) ou Pix cob/cobv com txid único', tags: ['Cobrança'], permission: 'financeiro.titulo.criar', status: 201, params: idParams,
    body: z.object({ kind: z.enum(['boleto', 'pix_cob', 'pix_cobv']), accountId: z.string().uuid().nullish() }),
  }, async ({ tx, params, body, deps }) => registerCharge(tx, deps.services, params.id, body.kind, body.accountId));

  // Webhook do banco (assinado com HMAC): baixa automática
  app.post('/v1/public/bank-webhooks/:tenantId/:accountId', { schema: { hide: true } }, async (req) => {
    const { tenantId, accountId } = z.object({ tenantId: z.string().uuid(), accountId: z.string().uuid() }).parse(req.params);
    const sig = String(req.headers['x-signature'] ?? '');
    const expected = hmacSha256(`${app.deps.config.webhookSigningSecret}:${accountId}`, JSON.stringify(req.body));
    if (!safeEqual(sig, expected)) throw new AppError('UNAUTHENTICATED', 'Assinatura do webhook inválida', 401);
    const body = z.object({ kind: z.enum(['pix', 'boleto']), txid: z.string().optional(), ourNumber: z.string().optional(), amount: decimal({ positive: true }), paidAt: z.string(), fee: decimal({ min: 0 }).optional(), endToEndId: z.string().optional() }).parse(req.body);
    return withTenant(app.deps.pool, { ...systemContext(tenantId), device: 'bank-webhook' }, (tx) => processBankNotification(tx, accountId, body));
  });

  // ---------------------------------------------------------------- borderô (RN-FIN-07)
  route(app, {
    method: 'POST', url: '/v1/finance/payment-batches', summary: 'Monta borderô com títulos aprovados', tags: ['Pagamentos'], permission: 'financeiro.bordero.criar', status: 201,
    body: z.object({ accountId: z.string().uuid(), paymentDate: isoDate, titleIds: z.array(z.string().uuid()).min(1) }),
  }, async ({ tx, body }) => createPaymentBatch(tx, body));

  route(app, { method: 'POST', url: '/v1/finance/payment-batches/:id/approve', summary: 'Aprova borderô (outra pessoa)', tags: ['Pagamentos'], permission: 'financeiro.titulo.aprovar', params: idParams },
    async ({ tx, params }) => approvePaymentBatch(tx, params.id));

  route(app, { method: 'POST', url: '/v1/finance/payment-batches/:id/send', summary: 'Envia ao banco (API/remessa); baixa só após o retorno', tags: ['Pagamentos'], permission: 'financeiro.bordero.criar', params: idParams },
    async ({ tx, params, deps }) => sendPaymentBatch(tx, deps.services, params.id));

  route(app, {
    method: 'POST', url: '/v1/finance/payment-batch-items/:id/return', summary: 'Retorno do banco para um pagamento (confirma e baixa)', tags: ['Pagamentos'], permission: 'financeiro.titulo.baixar', params: idParams,
    body: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  }, async ({ tx, params, body }) => confirmPaymentBatchItem(tx, params.id, body.ok, body.reason));

  route(app, { method: 'GET', url: '/v1/finance/payment-batches/:id', summary: 'Borderô e itens', tags: ['Pagamentos'], permission: 'financeiro.titulo.ler', params: idParams }, async ({ tx, params }) => ({
    ...(await tx.one(`SELECT * FROM finance.payment_batches WHERE id = $1`, [params.id], 'Borderô')),
    items: await tx.query(`SELECT * FROM finance.payment_batch_items WHERE batch_id = $1`, [params.id]),
  }));

  // ---------------------------------------------------------------- contas, transferências e relatórios
  route(app, { method: 'GET', url: '/v1/finance/balances', summary: 'Saldo por conta', tags: ['Tesouraria'], permission: 'financeiro.conta.ler', query: z.object({ date: isoDate.optional() }) },
    async ({ tx, ctx, query }) => accountBalances(tx, ctx.companyId, query.date));

  route(app, {
    method: 'POST', url: '/v1/finance/transfers', summary: 'Transferência entre contas', tags: ['Tesouraria'], permission: 'financeiro.conta.editar', status: 201, company: true,
    body: z.object({ fromAccountId: z.string().uuid(), toAccountId: z.string().uuid(), amount: decimal({ positive: true }), date: isoDate, description: z.string().default('Transferência entre contas') }),
  }, async ({ tx, body }) => transferBetweenAccounts(tx, body));

  route(app, {
    method: 'POST', url: '/v1/finance/forecasts', summary: 'Previsão manual para o fluxo projetado', tags: ['Tesouraria'], permission: 'financeiro.conta.editar', status: 201, company: true,
    body: z.object({ date: isoDate, direction: z.enum(['C', 'D']), amount: decimal({ positive: true }), description: z.string().min(3), categoryId: z.string().uuid().nullish() }),
  }, async ({ tx, body }) => tx.one(`INSERT INTO finance.cash_forecasts (tenant_id, company_id, forecast_date, direction, amount, description, category_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tx.tenantId, tx.companyId, body.date, body.direction, body.amount, body.description, body.categoryId ?? null, tx.userId]));

  route(app, {
    method: 'GET', url: '/v1/finance/cash-flow', summary: 'Fluxo de caixa realizado e projetado (diário, semanal, mensal)', tags: ['Relatórios financeiros'], permission: 'financeiro.relatorio.ler',
    query: z.object({ from: isoDate, to: isoDate, granularity: z.enum(['day', 'week', 'month']).default('day'), accountId: z.string().uuid().optional() }),
  }, async ({ tx, ctx, query }) => cashFlow(tx, ctx.companyId, query.from, query.to, query.granularity, query.accountId));

  route(app, {
    method: 'GET', url: '/v1/finance/dre', summary: 'DRE gerencial por competência ou caixa, com filtros e orçado × realizado', tags: ['Relatórios financeiros'], permission: 'financeiro.relatorio.ler',
    query: z.object({ from: isoDate, to: isoDate, basis: z.enum(['competence', 'cash']).default('competence'), establishmentId: z.string().uuid().optional(), costCenterId: z.string().uuid().optional(), projectId: z.string().uuid().optional() }),
  }, async ({ tx, ctx, query }) => managementDre(tx, { companyId: ctx.companyId, ...query }));

  route(app, {
    method: 'GET', url: '/v1/finance/aging', summary: 'Aging de inadimplência', tags: ['Relatórios financeiros'], permission: 'financeiro.relatorio.ler', query: z.object({ kind: z.enum(['receivable', 'payable']).default('receivable') }),
  }, async ({ tx, ctx, query }) => aging(tx, ctx.companyId, query.kind));

  route(app, {
    method: 'PUT', url: '/v1/finance/budgets', summary: 'Orçamento anual por categoria e centro de custo', tags: ['Relatórios financeiros'], permission: 'financeiro.orcamento.editar', company: true,
    body: z.object({ year: z.number().int(), lines: z.array(z.object({ month: z.number().int().min(1).max(12), categoryId: z.string().uuid(), costCenterId: z.string().uuid().nullish(), amount: decimal() })).min(1) }),
  }, async ({ tx, body }) => {
    for (const l of body.lines) {
      await tx.exec(`INSERT INTO finance.budgets (tenant_id, company_id, year, month, category_id, cost_center_id, amount) VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (company_id, year, month, category_id, cost_center_id) DO UPDATE SET amount = EXCLUDED.amount`,
        [tx.tenantId, tx.companyId, body.year, l.month, l.categoryId, l.costCenterId ?? null, l.amount]);
    }
    return { saved: body.lines.length };
  });

  route(app, {
    method: 'GET', url: '/v1/finance/budgets/vs-actual', summary: 'Orçado × realizado por categoria (alerta quando ultrapassa)', tags: ['Relatórios financeiros'], permission: 'financeiro.relatorio.ler',
    query: z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12).optional() }),
  }, async ({ tx, ctx, query }) => {
    const rows = await tx.query(
      `SELECT c.code, c.name, b.month, sum(b.amount) AS budget,
              coalesce((SELECT sum(t.amount) FROM finance.titles t WHERE t.category_id = b.category_id AND t.status <> 'cancelled' AND t.company_id = b.company_id
                         AND extract(year FROM t.competence_date) = b.year AND extract(month FROM t.competence_date) = b.month), 0) AS actual
         FROM finance.budgets b JOIN finance.categories c ON c.id = b.category_id
        WHERE ($1::uuid IS NULL OR b.company_id = $1) AND b.year = $2 AND ($3::int IS NULL OR b.month = $3)
        GROUP BY c.code, c.name, b.month, b.category_id, b.company_id, b.year ORDER BY b.month, c.code`, [ctx.companyId, query.year, query.month ?? null]);
    return rows.map((r) => ({ ...r, exceeded: D(r.actual).greaterThan(r.budget) }));
  });
}
