import { z } from 'zod';
import { sum } from '@vortex/money';
import { route, type App } from '../../http/app.js';
import { decimal, isoDate } from '../../http/schemas.js';
import { AppError, conflict, forbidden, validation } from '../../errors.js';
import { auditAction, requireReason } from '../../core/audit.js';
import type { TemplateLine } from './posting.js';
import { accountReconciliation, ledger, statements, trialBalance } from './reports.js';
import { buildAccountantPackage } from './export.js';
import { generateEfdIcmsIpi } from './efd.js';

export function registerAccountingRoutes(app: App) {
  // ---------------------------------------------------------------- períodos (RN-CTB-04)
  route(app, { method: 'GET', url: '/v1/accounting/periods', summary: 'Períodos contábeis', tags: ['Contabilidade'], permission: 'contabil.lancamento.ler', company: true },
    async ({ tx }) => tx.query(`SELECT * FROM accounting.periods WHERE company_id = $1 ORDER BY year DESC, month DESC`, [tx.companyId]));

  route(app, {
    method: 'POST', url: '/v1/accounting/periods/close', summary: 'Fecha o mês: nada com data no período pode ser criado, alterado ou estornado', tags: ['Contabilidade'], permission: 'contabil.periodo.fechar', company: true,
    body: z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }),
  }, async ({ tx, body }) => {
    const pending = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM fiscal.documents WHERE company_id = $1 AND status IN ('pendente_envio','em_processamento','contingencia','validando')
          AND extract(year FROM tax_date) = $2 AND extract(month FROM tax_date) = $3`, [tx.companyId, body.year, body.month]);
    if (pending.n > 0) throw conflict('PENDING_DOCUMENTS', `${pending.n} documento(s) fiscal(is) do período ainda não autorizado(s)`);
    const r = await tx.one(
      `INSERT INTO accounting.periods (tenant_id, company_id, year, month, status, closed_at, closed_by) VALUES ($1,$2,$3,$4,'closed',now(),$5)
       ON CONFLICT (company_id, year, month) DO UPDATE SET status = 'closed', closed_at = now(), closed_by = $5 RETURNING *`,
      [tx.tenantId, tx.companyId, body.year, body.month, tx.userId]);
    await auditAction(tx, { action: 'contabil.periodo.fechado', table: 'accounting.periods', recordId: r.id });
    return r;
  });

  route(app, {
    method: 'POST', url: '/v1/accounting/periods/reopen', summary: 'Reabre período (só perfil contador, com motivo)', tags: ['Contabilidade'], permission: 'contabil.periodo.reabrir', company: true,
    body: z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), reason: z.string() }),
  }, async ({ tx, ctx, body }) => {
    if (!ctx.roles.includes('contador') && !ctx.roles.includes('administrador')) throw forbidden('Reabertura só pelo perfil contador', { rule: 'RN-CTB-04' });
    await requireReason(tx, body.reason, 'contabil.periodo.reabrir');
    return tx.one(`UPDATE accounting.periods SET status = 'open', reopened_at = now(), reopened_by = $4, reopen_reason = $5 WHERE company_id = $1 AND year = $2 AND month = $3 AND status = 'closed' RETURNING *`,
      [tx.companyId, body.year, body.month, tx.userId, body.reason], 'Período fechado');
  });

  // ---------------------------------------------------------------- lançamentos
  route(app, {
    method: 'POST', url: '/v1/accounting/entries', summary: 'Lançamento manual (só em contas marcadas — RN-CTB-05; débitos = créditos — RN-CTB-01)', tags: ['Contabilidade'], permission: 'contabil.lancamento.criar', status: 201, company: true,
    body: z.object({ date: isoDate, description: z.string().min(3), lines: z.array(z.object({ accountCode: z.string(), debit: decimal({ min: 0 }).default('0'), credit: decimal({ min: 0 }).default('0'),
      history: z.string().min(3), costCenterId: z.string().uuid().nullish() })).min(2) }),
  }, async ({ tx, body }) => {
    const d = sum(body.lines.map((l) => l.debit));
    const c = sum(body.lines.map((l) => l.credit));
    if (!d.equals(c)) throw new AppError('BUSINESS_RULE', `Lançamento desbalanceado: débitos ${d.toFixed(2)} × créditos ${c.toFixed(2)}`, 422, { rule: 'RN-CTB-01' });
    const entry = await tx.one<{ id: string; number: string }>(
      `INSERT INTO accounting.journal_entries (tenant_id, company_id, number, entry_date, description, event_type, origin_type, manual, created_by)
       VALUES ($1,$2,core.next_counter($2,'journal'),$3,$4,'manual','manual',true,$5) RETURNING id, number`, [tx.tenantId, tx.companyId, body.date, body.description, tx.userId]);
    for (const l of body.lines) {
      const acc = await tx.one<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = $1`, [l.accountCode], `Conta ${l.accountCode}`);
      await tx.exec(`INSERT INTO accounting.journal_lines (tenant_id, entry_id, account_id, debit, credit, cost_center_id, history) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tx.tenantId, entry.id, acc.id, l.debit, l.credit, l.costCenterId ?? null, l.history]);
    }
    return entry;
  });

  route(app, {
    method: 'GET', url: '/v1/accounting/journal', summary: 'Livro diário', tags: ['Relatórios contábeis'], permission: 'contabil.lancamento.ler', company: true, query: z.object({ from: isoDate, to: isoDate }),
  }, async ({ tx, query }) => tx.query(
    `SELECT e.number, e.entry_date, e.description, e.event_type, e.manual, json_agg(json_build_object('conta', a.code, 'nome', a.name, 'debito', l.debit, 'credito', l.credit, 'historico', l.history) ORDER BY l.debit DESC) AS lines
       FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id = e.id JOIN accounting.chart_of_accounts a ON a.id = l.account_id
      WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 GROUP BY e.id ORDER BY e.entry_date, e.number`, [tx.companyId, query.from, query.to]));

  route(app, {
    method: 'GET', url: '/v1/accounting/ledger', summary: 'Razão por conta', tags: ['Relatórios contábeis'], permission: 'contabil.lancamento.ler', company: true,
    query: z.object({ accountCode: z.string(), from: isoDate, to: isoDate }),
  }, async ({ tx, query }) => {
    const acc = await tx.one<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = $1`, [query.accountCode], 'Conta');
    return ledger(tx, tx.companyId, acc.id, query.from, query.to);
  });

  route(app, {
    method: 'GET', url: '/v1/accounting/trial-balance', summary: 'Balancete de verificação', tags: ['Relatórios contábeis'], permission: 'contabil.lancamento.ler', company: true, query: z.object({ from: isoDate, to: isoDate }),
  }, async ({ tx, query }) => trialBalance(tx, tx.companyId, query.from, query.to));

  route(app, {
    method: 'GET', url: '/v1/accounting/statements', summary: 'Balanço patrimonial e DRE contábil', tags: ['Relatórios contábeis'], permission: 'contabil.lancamento.ler', company: true, query: z.object({ from: isoDate, to: isoDate }),
  }, async ({ tx, query }) => statements(tx, tx.companyId, query.from, query.to));

  route(app, {
    method: 'GET', url: '/v1/accounting/reconciliation', summary: 'Conciliação de contas (clientes, fornecedores, estoque × módulos de origem)', tags: ['Relatórios contábeis'], permission: 'contabil.lancamento.ler', company: true,
    query: z.object({ date: isoDate }),
  }, async ({ tx, query }) => accountReconciliation(tx, tx.companyId, query.date));

  route(app, { method: 'GET', url: '/v1/accounting/posting-rules', summary: 'Regras de contabilização por evento (RN-CTB-02)', tags: ['Contabilidade'], permission: 'contabil.lancamento.ler' },
    async ({ tx }) => tx.query(`SELECT * FROM accounting.posting_rules ORDER BY event_type, operation_type_code NULLS FIRST`));

  const lineSchema = z.object({ side: z.enum(['D', 'C']), account: z.string().min(1), amount: z.array(z.string()).min(1), history: z.string().optional() });
  route(app, {
    method: 'PUT', url: '/v1/accounting/posting-rules', summary: 'Define regra de contabilização (por tipo de operação, filial ou categoria)', tags: ['Contabilidade'], permission: 'contabil.lancamento.criar',
    body: z.object({ eventType: z.string(), operationTypeCode: z.string().nullish(), establishmentId: z.string().uuid().nullish(), categoryId: z.string().uuid().nullish(), lines: z.array(lineSchema).min(2) }),
  }, async ({ tx, body }) => {
    for (const l of body.lines) {
      const code = l.account.startsWith('@') ? l.account.split('|')[1] : l.account;
      if (code && !(await tx.maybeOne(`SELECT 1 FROM accounting.chart_of_accounts WHERE code = $1 AND is_analytic`, [code]))) throw validation({ lines: `Conta analítica ${code} não encontrada` });
    }
    return tx.one(
      `INSERT INTO accounting.posting_rules (tenant_id, event_type, operation_type_code, establishment_id, category_id, lines, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, event_type, operation_type_code, establishment_id, category_id) DO UPDATE SET lines = EXCLUDED.lines, active = true RETURNING *`,
      [tx.tenantId, body.eventType, body.operationTypeCode ?? null, body.establishmentId ?? null, body.categoryId ?? null, JSON.stringify(body.lines as TemplateLine[]), tx.userId]);
  });

  // ---------------------------------------------------------------- exportação ao contador e SPED (seção 15)
  route(app, {
    method: 'POST', url: '/v1/accounting/exports', summary: 'Pacote para o contador: XMLs, livros, lançamentos e EFD ICMS/IPI (blocos C e H)', tags: ['Obrigações'], permission: 'contabil.exportacao.gerar', status: 201, company: true,
    body: z.object({ from: isoDate, to: isoDate, inventoryDate: isoDate.nullish() }),
  }, async ({ tx, body, deps }) => buildAccountantPackage(tx, deps.services, { companyId: tx.companyId, ...body }));

  route(app, {
    method: 'GET', url: '/v1/accounting/exports/download', summary: 'Baixa o pacote gerado (.tar.gz)', tags: ['Obrigações'], permission: 'contabil.exportacao.gerar', query: z.object({ key: z.string() }),
  }, async ({ tx, query, deps, reply }) => {
    if (!query.key.startsWith(`exportacoes/${tx.tenantId}/`)) throw forbidden('Arquivo de outro tenant');
    reply.header('content-type', 'application/gzip').header('content-disposition', `attachment; filename="${query.key.split('/').pop()}"`);
    return deps.services.storage.get(query.key);
  });

  route(app, {
    method: 'GET', url: '/v1/accounting/efd-icms-ipi', summary: 'Gera a EFD ICMS/IPI de um estabelecimento (texto)', tags: ['Obrigações'], permission: 'contabil.exportacao.gerar', company: true,
    query: z.object({ establishmentId: z.string().uuid(), from: isoDate, to: isoDate, inventoryDate: isoDate.optional() }),
  }, async ({ tx, query }) => generateEfdIcmsIpi(tx, { companyId: tx.companyId, ...query }));
}
