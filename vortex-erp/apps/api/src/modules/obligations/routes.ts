import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate } from '../../http/schemas.js';
import { tarGz } from '../../core/tar.js';
import { cancelServiceInvoice, createServiceInvoice } from './services-taken.js';
import { generateReinf } from './reinf.js';
import { generateEfdContribuicoes } from './efd-contribuicoes.js';
import { defisSupport, pgdasSupport } from './simples.js';

const tags = ['Obrigações'];
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Período no formato AAAA-MM');
const money = decimal({ min: 0 });

export function registerObligationRoutes(app: App) {
  route(app, {
    method: 'POST', url: '/v1/purchasing/service-invoices', summary: 'NFS-e de serviço tomado: título líquido, guias das retenções (IRRF, CSRF, INSS, ISS) e contábil', tags: ['Compras'],
    permission: 'compras.servico_tomado.lancar', status: 201, company: true,
    body: z.object({
      establishmentId: z.string().uuid(), supplierId: z.string().uuid(), number: z.string().min(1).max(20), series: z.string().max(5).nullish(), nfseKey: z.string().regex(/^\d{50}$/).nullish(),
      issueDate: isoDate, dueDate: isoDate, serviceCode: z.string(), reinfServiceType: z.string().regex(/^\d{9}$/).nullish(), incomeNature: z.string().regex(/^\d{5}$/).nullish(),
      description: z.string().max(500).nullish(), grossAmount: decimal({ positive: true }), laborAssignment: z.boolean().optional(), inssDeductions: money.nullish(),
      issRetained: z.boolean().optional(), issRate: decimal({ min: 0 }).nullish(),
      retentions: z.object({ irrf: money, csll: money, pis: money, cofins: money, inss: money, iss: money }).partial().nullish(),
      categoryId: z.string().uuid().nullish(), costCenterId: z.string().uuid().nullish(),
    }),
  }, async ({ tx, body }) => createServiceInvoice(tx, body));

  route(app, {
    method: 'GET', url: '/v1/purchasing/service-invoices', summary: 'Serviços tomados com as retenções', tags: ['Compras'], permission: 'compras.servico_tomado.lancar',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  }, async ({ tx, ctx, query }) => tx.query(
    `SELECT si.*, p.legal_name AS supplier_name FROM purchasing.service_invoices si JOIN registry.parties p ON p.id = si.supplier_id
      WHERE ($1::uuid IS NULL OR si.company_id = $1) AND ($2::date IS NULL OR si.issue_date >= $2) AND ($3::date IS NULL OR si.issue_date <= $3) ORDER BY si.issue_date DESC, si.number`,
    [ctx.companyId, query.from ?? null, query.to ?? null]));

  route(app, {
    method: 'POST', url: '/v1/purchasing/service-invoices/:id/cancel', summary: 'Cancela o lançamento (títulos e contábil estornados)', tags: ['Compras'],
    permission: 'compras.servico_tomado.lancar', params: idParams, body: z.object({ reason: z.string() }),
  }, async ({ tx, params, body }) => cancelServiceInvoice(tx, params.id, body.reason));

  route(app, {
    method: 'GET', url: '/v1/obligations/efd-contribuicoes', summary: 'EFD-Contribuições (PIS/Cofins) do mês, por documento', tags, permission: 'contabil.exportacao.gerar', company: true,
    query: z.object({ period }),
  }, async ({ tx, query }) => generateEfdContribuicoes(tx, { companyId: tx.companyId, period: query.period }));

  const reinfQuery = z.object({ period, includeR1000: z.enum(['true', 'false']).optional(), environment: z.enum(['1', '2']).optional() });
  const reinf = (tx: any, q: z.infer<typeof reinfQuery>) => generateReinf(tx, { companyId: tx.companyId, period: q.period, includeR1000: q.includeR1000 === 'true',
    environment: q.environment === '1' ? 1 : 2 });
  route(app, {
    method: 'GET', url: '/v1/obligations/reinf', summary: 'Eventos da EFD-Reinf do período (R-1000, R-2010, R-2020, R-4010, R-4020, R-2099, R-4099)', tags,
    permission: 'contabil.exportacao.gerar', company: true, query: reinfQuery,
  }, async ({ tx, query }) => reinf(tx, query));

  route(app, {
    method: 'GET', url: '/v1/obligations/reinf/download', summary: 'Eventos da EFD-Reinf em arquivo .tar.gz (um XML por evento)', tags, permission: 'contabil.exportacao.gerar', company: true,
    query: reinfQuery,
  }, async ({ tx, query, reply }) => {
    const r = await reinf(tx, query);
    const buf = tarGz(r.events.map((e) => ({ name: `${e.type}_${e.id}.xml`, content: e.xml })));
    reply.header('content-type', 'application/gzip').header('content-disposition', `attachment; filename="reinf-${query.period}.tar.gz"`);
    return reply.send(buf);
  });

  route(app, {
    method: 'GET', url: '/v1/obligations/pgdas', summary: 'Apoio ao PGDAS-D: receita segregada, RBT12, Fator R e alíquota efetiva', tags, permission: 'contabil.exportacao.gerar', company: true,
    query: z.object({ period }),
  }, async ({ tx, query }) => pgdasSupport(tx, tx.companyId, query.period));

  route(app, {
    method: 'GET', url: '/v1/obligations/defis', summary: 'Apoio à DEFIS: receita anual, empregados, saldos e estoques', tags, permission: 'contabil.exportacao.gerar', company: true,
    query: z.object({ year: z.coerce.number().int().min(2018).max(2100) }),
  }, async ({ tx, query }) => defisSupport(tx, tx.companyId, query.year));
}
