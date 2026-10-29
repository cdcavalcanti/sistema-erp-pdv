import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate } from '../../http/schemas.js';
import { autoReconcile, dailyPosition, importStatement, reconcile, suggestionsFor, undoReconciliation } from './reconciliation.js';
import { budgetAlerts, defaultCollectionRule, importAcquirerStatement, runCollection, setCollectionRule } from './collection.js';

export function registerBankingRoutes(app: App) {
  // ---------------------------------------------------------------- conciliação bancária (seção 13)
  route(app, {
    method: 'POST', url: '/v1/finance/accounts/:id/statements', summary: 'Importa extrato OFX e concilia automaticamente (txid, nosso número, valor+data+documento, regras)',
    tags: ['Conciliação'], permission: 'financeiro.conciliacao.executar', status: 201, params: idParams,
    body: z.object({ content: z.string().min(20), fileName: z.string().nullish() }),
  }, async ({ tx, params, body }) => importStatement(tx, params.id, body));

  route(app, {
    method: 'GET', url: '/v1/finance/accounts/:id/statement-lines', summary: 'Linhas do extrato', tags: ['Conciliação'], permission: 'financeiro.conciliacao.executar', params: idParams,
    query: z.object({ status: z.enum(['pending', 'reconciled', 'ignored']).optional(), from: isoDate.optional(), to: isoDate.optional() }),
  }, async ({ tx, params, query }) => tx.query(
    `SELECT * FROM finance.statement_lines WHERE account_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::date IS NULL OR line_date >= $3) AND ($4::date IS NULL OR line_date <= $4)
      ORDER BY line_date, amount LIMIT 2000`, [params.id, query.status ?? null, query.from ?? null, query.to ?? null]));

  route(app, {
    method: 'GET', url: '/v1/finance/accounts/:id/unreconciled-movements', summary: 'Movimentos do sistema ainda não conciliados (lado direito da tela)', tags: ['Conciliação'],
    permission: 'financeiro.conciliacao.executar', params: idParams,
  }, async ({ tx, params }) => tx.query(
    `SELECT m.*, p.legal_name AS party_name FROM finance.account_movements m LEFT JOIN registry.parties p ON p.id = m.party_id
      WHERE m.account_id = $1 AND NOT m.reconciled ORDER BY m.movement_date LIMIT 2000`, [params.id]));

  route(app, { method: 'POST', url: '/v1/finance/accounts/:id/auto-reconcile', summary: 'Roda as regras automáticas de novo', tags: ['Conciliação'],
    permission: 'financeiro.conciliacao.executar', params: idParams }, async ({ tx, params }) => {
    await tx.one(`SELECT 1 FROM finance.accounts WHERE id = $1`, [params.id], 'Conta');
    return autoReconcile(tx, params.id);
  });

  route(app, { method: 'GET', url: '/v1/finance/statement-lines/:id/suggestions', summary: 'Sugestões ordenadas por probabilidade (aprende com as escolhas)', tags: ['Conciliação'],
    permission: 'financeiro.conciliacao.executar', params: idParams }, async ({ tx, params }) => suggestionsFor(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/finance/reconciliations', summary: 'Concilia linhas × movimentos, baixa títulos (um para muitos) ou cria movimento na categoria', tags: ['Conciliação'],
    permission: 'financeiro.conciliacao.executar', status: 201,
    body: z.object({ lineIds: z.array(z.string().uuid()).min(1), movementIds: z.array(z.string().uuid()).optional(),
      titles: z.array(z.object({ titleId: z.string().uuid(), amount: decimal({ positive: true }).optional() })).optional(),
      newMovement: z.object({ categoryId: z.string().uuid(), description: z.string().optional(), costCenterId: z.string().uuid().nullish() }).nullish() }),
  }, async ({ tx, body }) => reconcile(tx, body));

  route(app, {
    method: 'POST', url: '/v1/finance/reconciliations/:id/undo', summary: 'Desfaz a conciliação (com motivo)', tags: ['Conciliação'], permission: 'financeiro.conciliacao.executar', params: idParams,
    body: z.object({ reason: z.string() }),
  }, async ({ tx, params, body }) => undoReconciliation(tx, params.id, body.reason));

  route(app, { method: 'POST', url: '/v1/finance/statement-lines/:id/ignore', summary: 'Ignora linha do extrato (ex.: lançamento duplicado do banco)', tags: ['Conciliação'],
    permission: 'financeiro.conciliacao.executar', params: idParams },
  async ({ tx, params }) => tx.one(`UPDATE finance.statement_lines SET status = 'ignored' WHERE id = $1 AND status = 'pending' RETURNING *`, [params.id], 'Linha pendente'));

  route(app, {
    method: 'GET', url: '/v1/finance/accounts/:id/daily-position', summary: 'Saldo do sistema × saldo do banco por dia; diferença em dia conciliado vira alerta', tags: ['Conciliação'],
    permission: 'financeiro.conciliacao.executar', params: idParams, query: z.object({ from: isoDate, to: isoDate }),
  }, async ({ tx, params, query }) => dailyPosition(tx, params.id, query.from, query.to));

  route(app, {
    method: 'POST', url: '/v1/finance/reconciliation-rules', summary: 'Regra salva: texto do extrato → categoria (ex.: "TARIFA" → Tarifas bancárias)', tags: ['Conciliação'],
    permission: 'financeiro.conciliacao.executar', status: 201,
    body: z.object({ accountId: z.string().uuid().nullish(), descriptionPattern: z.string().min(3), direction: z.enum(['C', 'D']).nullish(), categoryId: z.string().uuid(),
      costCenterId: z.string().uuid().nullish() }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO finance.reconciliation_rules (tenant_id, account_id, description_pattern, direction, category_id, cost_center_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tx.tenantId, body.accountId ?? null, body.descriptionPattern, body.direction ?? null, body.categoryId, body.costCenterId ?? null, tx.userId]));

  // ---------------------------------------------------------------- régua de cobrança (RN-FIN-09)
  route(app, { method: 'GET', url: '/v1/finance/collection-rule', summary: 'Régua de cobrança da empresa', tags: ['Cobrança'], permission: 'financeiro.titulo.ler', company: true },
    async ({ tx, ctx }) => defaultCollectionRule(tx, ctx.companyId!));

  route(app, {
    method: 'PUT', url: '/v1/finance/collection-rule', summary: 'Define os passos da régua (D−3, D0, D+3, D+10...) e os canais', tags: ['Cobrança'], permission: 'financeiro.titulo.renegociar', company: true,
    body: z.object({ steps: z.array(z.object({ offsetDays: z.number().int().min(-30).max(180), channels: z.array(z.enum(['email', 'whatsapp'])).min(1) })).min(1).max(12) }),
  }, async ({ tx, ctx, body }) => setCollectionRule(tx, ctx.companyId!, body.steps));

  route(app, { method: 'POST', url: '/v1/finance/collection/run', summary: 'Executa a régua agora (o job roda todo dia)', tags: ['Cobrança'], permission: 'financeiro.titulo.renegociar',
    body: z.object({ date: isoDate.optional() }).default({}) },
  async ({ tx, body, deps }) => runCollection(tx, deps.services, body.date));

  route(app, { method: 'GET', url: '/v1/finance/titles/:id/collection', summary: 'Histórico da régua do título', tags: ['Cobrança'], permission: 'financeiro.titulo.ler', params: idParams },
    async ({ tx, params }) => tx.query(`SELECT * FROM finance.collection_actions WHERE title_id = $1 ORDER BY created_at`, [params.id]));

  // ---------------------------------------------------------------- adquirente e orçamento
  route(app, {
    method: 'POST', url: '/v1/finance/accounts/:id/acquirer-statement', summary: 'Extrato da adquirente: bruto, taxa, líquido; baixa os recebíveis e alerta divergências (RN-FIN-08)',
    tags: ['Cartões'], permission: 'financeiro.conciliacao.executar', params: idParams,
    body: z.object({ lines: z.array(z.object({ kind: z.enum(['sale', 'chargeback', 'anticipation', 'adjustment']).default('sale'), saleDate: isoDate.nullish(), paymentDate: isoDate,
      nsu: z.string().nullish(), authorization: z.string().nullish(), gross: decimal({ min: 0 }), fee: decimal({ min: 0 }).default('0'), net: decimal({ min: 0 }) })).min(1) }),
  }, async ({ tx, params, body }) => importAcquirerStatement(tx, params.id, body.lines));

  route(app, { method: 'POST', url: '/v1/finance/budget-alerts/run', summary: 'Verifica orçado × realizado do mês e alerta excessos', tags: ['Relatórios financeiros'],
    permission: 'financeiro.orcamento.editar' }, async ({ tx }) => budgetAlerts(tx));
}
