import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate } from '../../http/schemas.js';
import { partySchema } from '../registry/parties.js';
import { createEmployee, importPayroll, listEmployees, payrollExport, requestReimbursement } from './service.js';

export function registerHrRoutes(app: App) {
  route(app, {
    method: 'POST', url: '/v1/hr/departments', summary: 'Departamento (com centro de custo)', tags: ['RH'], permission: 'rh.colaborador.editar', status: 201, company: true,
    body: z.object({ code: z.string().min(1), name: z.string().min(2), costCenterId: z.string().uuid().nullish() }),
  }, async ({ tx, body }) => tx.one(`INSERT INTO hr.departments (tenant_id, company_id, code, name, cost_center_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tx.tenantId, tx.companyId, body.code, body.name, body.costCenterId ?? null]));

  route(app, { method: 'GET', url: '/v1/hr/departments', summary: 'Departamentos', tags: ['RH'], permission: 'rh.colaborador.ler' }, async ({ tx, ctx }) =>
    tx.query(`SELECT * FROM hr.departments WHERE ($1::uuid IS NULL OR company_id = $1) ORDER BY code`, [ctx.companyId]));

  route(app, {
    method: 'POST', url: '/v1/hr/positions', summary: 'Cargo (com CBO)', tags: ['RH'], permission: 'rh.colaborador.editar', status: 201,
    body: z.object({ code: z.string().min(1), name: z.string().min(2), cbo: z.string().regex(/^\d{6}$/).nullish() }),
  }, async ({ tx, body }) => tx.one(`INSERT INTO hr.positions (tenant_id, code, name, cbo) VALUES ($1,$2,$3,$4) RETURNING *`, [tx.tenantId, body.code, body.name, body.cbo ?? null]));

  route(app, { method: 'GET', url: '/v1/hr/positions', summary: 'Cargos', tags: ['RH'], permission: 'rh.colaborador.ler' }, async ({ tx }) =>
    tx.query(`SELECT * FROM hr.positions ORDER BY code`));

  route(app, {
    method: 'POST', url: '/v1/hr/employees', summary: 'Colaborador (papel de Pessoa) com cargo, departamento, centro de custo e usuário', tags: ['RH'], permission: 'rh.colaborador.editar',
    status: 201, company: true,
    body: z.object({ partyId: z.string().uuid().nullish(), party: partySchema.omit({ roles: true }).nullish(), userId: z.string().uuid().nullish(), registration: z.string().min(1),
      departmentId: z.string().uuid().nullish(), positionId: z.string().uuid().nullish(), costCenterId: z.string().uuid().nullish(), admissionDate: isoDate,
      baseSalary: decimal({ min: 0 }).nullish(), payrollExternalId: z.string().nullish() }),
  }, async ({ tx, ctx, body }) => {
    const e = await createEmployee(tx, body as never);
    return (await listEmployees(tx, ctx)).find((x) => x.id === e.id);
  });

  route(app, { method: 'GET', url: '/v1/hr/employees', summary: 'Colaboradores (salário só para quem gere RH)', tags: ['RH'], permission: 'rh.colaborador.ler',
    query: z.object({ status: z.string().optional(), departmentId: z.string().uuid().optional() }) },
  async ({ tx, ctx, query }) => listEmployees(tx, ctx, query));

  route(app, {
    method: 'PATCH', url: '/v1/hr/employees/:id', summary: 'Altera vínculo, salário ou desligamento', tags: ['RH'], permission: 'rh.colaborador.editar', params: idParams,
    body: z.object({ departmentId: z.string().uuid().nullish(), positionId: z.string().uuid().nullish(), costCenterId: z.string().uuid().nullish(), baseSalary: decimal({ min: 0 }).nullish(),
      status: z.enum(['active', 'on_leave', 'terminated']).optional(), terminationDate: isoDate.nullish(), userId: z.string().uuid().nullish() }),
  }, async ({ tx, params, body }) => tx.one(
    `UPDATE hr.employees SET department_id = coalesce($2, department_id), position_id = coalesce($3, position_id), cost_center_id = coalesce($4, cost_center_id),
            base_salary = coalesce($5, base_salary), status = coalesce($6, status), termination_date = coalesce($7, termination_date), user_id = coalesce($8, user_id)
      WHERE id = $1 RETURNING *`,
    [params.id, body.departmentId ?? null, body.positionId ?? null, body.costCenterId ?? null, body.baseSalary ?? null, body.status ?? null, body.terminationDate ?? null, body.userId ?? null],
    'Colaborador'));

  route(app, {
    method: 'POST', url: '/v1/hr/payroll-imports', summary: 'Importa o resumo da folha do parceiro: títulos (salários, INSS, FGTS, IRRF) e lançamento contábil', tags: ['RH'],
    permission: 'rh.folha.importar', status: 201, company: true,
    body: z.object({ competence: z.string().regex(/^\d{4}-\d{2}$/), paymentDate: isoDate, source: z.enum(['api', 'csv', 'partner']).optional(), inssEmployer: decimal({ min: 0 }),
      fgts: decimal({ min: 0 }).nullish(), items: z.array(z.object({ employeeId: z.string().uuid().nullish(), registration: z.string().nullish(), gross: decimal({ min: 0 }),
        inssEmployee: decimal({ min: 0 }).optional(), irrf: decimal({ min: 0 }).optional(), otherDeductions: decimal({ min: 0 }).optional() })).min(1) }),
  }, async ({ tx, body }) => importPayroll(tx, body));

  route(app, { method: 'GET', url: '/v1/hr/payroll-imports', summary: 'Folhas importadas', tags: ['RH'], permission: 'rh.folha.importar' }, async ({ tx, ctx }) =>
    tx.query(`SELECT * FROM hr.payroll_imports WHERE ($1::uuid IS NULL OR company_id = $1) ORDER BY competence DESC`, [ctx.companyId]));

  route(app, {
    method: 'GET', url: '/v1/hr/payroll-export', summary: 'Comissões, adiantamentos e reembolsos da competência para o sistema de folha (JSON ou CSV)', tags: ['RH'],
    permission: 'rh.folha.importar', company: true, query: z.object({ competence: z.string().regex(/^\d{4}-\d{2}$/), format: z.enum(['json', 'csv']).default('json'), markExported: z.coerce.boolean().default(false) }),
    writes: true,
  }, async ({ tx, query, reply }) => {
    const r = await payrollExport(tx, query.competence, { markExported: query.markExported });
    if (query.format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="folha-${query.competence}.csv"`);
      return `﻿${r.csv}\r\n`;
    }
    return r;
  });

  route(app, {
    method: 'POST', url: '/v1/hr/reimbursements', summary: 'Solicita reembolso de despesa (comprovante opcional); vai para aprovação', tags: ['RH'], permission: 'rh.reembolso.solicitar', status: 201,
    body: z.object({ employeeId: z.string().uuid().nullish(), expenseDate: isoDate, description: z.string().min(3), amount: decimal({ positive: true }), categoryId: z.string().uuid(),
      costCenterId: z.string().uuid().nullish(), paymentMode: z.enum(['direct', 'payroll']).optional(), receiptBase64: z.string().max(10_000_000).nullish(), receiptContentType: z.string().nullish() }),
  }, async ({ tx, ctx, body, deps }) => requestReimbursement(tx, ctx, deps.services, body));

  route(app, { method: 'GET', url: '/v1/hr/reimbursements', summary: 'Reembolsos (os meus; todos para quem aprova)', tags: ['RH'], permission: 'rh.reembolso.solicitar' },
    async ({ tx, ctx }) => tx.query(
      `SELECT r.*, p.legal_name AS employee_name FROM hr.expense_reimbursements r JOIN hr.employees e ON e.id = r.employee_id JOIN registry.parties p ON p.id = e.party_id
        WHERE ($1::boolean OR e.user_id = $2) ORDER BY r.created_at DESC LIMIT 500`, [ctx.permissions.has('*') || ctx.permissions.has('rh.reembolso.aprovar'), ctx.userId]));
}
