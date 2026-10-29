import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { createUser, makeApp, setupTenant, type Client, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let cats: Record<string, string>;
let accounts: Record<string, string>;
let vendedor: Client & { userId: string };
let gerente: Client & { userId: string };
const emp: Record<'ana' | 'bruno' | 'vend', string> = { ana: '', bruno: '', vend: '' };
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const tb = async () => (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  cats = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.categories`))).map((a) => [a.code, a.id]));
  accounts = Object.fromEntries((await run((tx) => tx.query<{ code: string; id: string }>(`SELECT code, id FROM finance.accounts`))).map((a) => [a.code, a.id]));
  vendedor = await createUser(app, t, ['vendedor']);
  gerente = await createUser(app, t, ['gerente']);
});
afterAll(async () => app.close());

describe('Colaboradores (seção 18)', () => {
  it('cadastro com cargo, departamento e centro de custo; salário só para quem gere RH', async () => {
    const cc = (await run((tx) => tx.one<{ id: string }>(`SELECT id FROM finance.cost_centers WHERE code = 'VENDAS'`))).id;
    const dep = await t.admin.post('/v1/hr/departments', { code: 'COM', name: 'Comercial', costCenterId: cc });
    expect(dep.status).toBe(201);
    const pos = await t.admin.post('/v1/hr/positions', { code: 'VEND', name: 'Vendedor', cbo: '521110' });
    const mk = async (name: string, cpf: string, reg: string, salary: string, extra: Record<string, unknown> = {}) => {
      const r = await t.admin.post('/v1/hr/employees', { party: { kind: 'PF', taxId: cpf, legalName: name }, registration: reg, departmentId: dep.body.id, positionId: pos.body.id,
        admissionDate: '2025-03-01', baseSalary: salary, ...extra });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body;
    };
    const ana = await mk('Ana Souza', '529.982.247-25', '001', '3000.00');
    expect(ana.cost_center_id).toBe(cc);
    expect(ana.base_salary).toBe('3000.00');
    emp.ana = ana.id;
    emp.bruno = (await mk('Bruno Lima', '111.444.777-35', '002', '5000.00')).id;
    emp.vend = (await mk('Carla Vendas', '935.411.347-80', '003', '2500.00', { userId: vendedor.userId })).id;
    const seen = (await gerente.get('/v1/hr/employees')).body;
    expect(seen).toHaveLength(3);
    expect(seen[0].base_salary).toBeUndefined();
    expect((await vendedor.get('/v1/hr/employees')).status).toBe(403);
  });
});

describe('Importação do resumo da folha', () => {
  it('gera títulos (líquidos, INSS, FGTS, IRRF) nas contas trabalhistas e o lançamento da competência', async () => {
    const r = await t.admin.post('/v1/hr/payroll-imports', { competence: '2026-09', paymentDate: '2026-10-05', inssEmployer: '1600.00', items: [
      { registration: '001', gross: '3000.00', inssEmployee: '253.41', irrf: '68.12', otherDeductions: '180.00' },
      { registration: '002', gross: '5000.00', inssEmployee: '551.29', irrf: '370.40' },
    ] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ employees: 2, gross: '8000.00', net: '6576.78', inss: '2404.70', fgts: '640.00', irrf: '438.52', titles: 5 });
    expect((await t.admin.post('/v1/hr/payroll-imports', { competence: '2026-09', paymentDate: '2026-10-05', inssEmployer: '0', items: [{ registration: '001', gross: '1' }] })).status).toBe(409);
    const titles = (await t.admin.get('/v1/finance/titles', { kind: 'payable', limit: '50' })).body.items;
    const inss = titles.find((x: any) => x.document_number === 'INSS 2026-09');
    expect(inss).toMatchObject({ amount: '2404.70', due_date: '2026-10-20' });
    const b = await tb();
    expect(b.totals.debit).toBe(b.totals.credit);
    const acc = (code: string) => b.rows.find((x: any) => x.code === code)?.closing;
    expect(acc('2.1.5.01')).toBe('-6576.78');
    expect(acc('2.1.5.02')).toBe('-2404.70');
    expect(acc('4.5')).toBe('10060.00');

    // Pagar o salário da Ana debita "salários a pagar" (não fornecedores)
    const ana = titles.find((x: any) => x.document_number === 'FOLHA 2026-09 001');
    expect(ana.amount).toBe('2498.47');
    const fin = await createUser(app, t, ['financeiro']);
    expect((await fin.post(`/v1/finance/titles/${ana.id}/approve`)).status).toBe(200);
    expect((await fin.post(`/v1/finance/titles/${ana.id}/settle`, { date: '2026-10-05', accountId: accounts.BANCO, amount: '2498.47' })).status).toBe(200);
    const b2 = await tb();
    expect(b2.rows.find((x: any) => x.code === '2.1.5.01').closing).toBe('-4078.31');
    expect(b2.rows.find((x: any) => x.code === '2.1.1')?.closing ?? '0.00').toBe('0.00');
    const rec = (await t.admin.get('/v1/accounting/reconciliation', { date: '2027-12-31' })).body;
    expect(rec.find((l: any) => l.account.startsWith('Fornecedores')).ok).toBe(true);
  });
});

describe('Reembolso de despesas e exportação para a folha', () => {
  it('colaborador solicita; gestor aprova; pagamento direto vira título aprovado; "pela folha" vai na exportação', async () => {
    const r1 = await vendedor.post('/v1/hr/reimbursements', { expenseDate: '2026-10-01', description: 'Táxi para visita a cliente', amount: '120.00', categoryId: cats['5.3'],
      receiptBase64: Buffer.from('recibo').toString('base64'), receiptContentType: 'image/jpeg' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.status).toBe('pending');
    // Quem solicitou não aprova; o gestor aprova
    const pend = (await gerente.get('/v1/approvals')).body.find((a: any) => a.entity_id === r1.body.id);
    expect((await gerente.post(`/v1/approvals/${pend.id}/decision`, { decision: 'approve' })).status).toBe(200);
    const mine = (await vendedor.get('/v1/hr/reimbursements')).body;
    const approved = mine.find((x: any) => x.id === r1.body.id);
    expect(approved.status).toBe('approved');
    const title = (await t.admin.get(`/v1/finance/titles/${approved.title_id}`)).body;
    expect(title).toMatchObject({ amount: '120.00', origin_type: 'expense_reimbursement' });
    expect(title.approved_at).toBeTruthy();

    const r2 = await vendedor.post('/v1/hr/reimbursements', { expenseDate: '2026-10-02', description: 'Estacionamento', amount: '80.00', categoryId: cats['5.3'], paymentMode: 'payroll' });
    const p2 = (await gerente.get('/v1/approvals')).body.find((a: any) => a.entity_id === r2.body.id);
    await gerente.post(`/v1/approvals/${p2.id}/decision`, { decision: 'approve' });
    const exp = (await t.admin.get('/v1/hr/payroll-export', { competence: '2026-10', markExported: 'true' })).body;
    expect(exp.rows).toEqual([expect.objectContaining({ registration: '003', reimbursements: '80.00' })]);
    expect(exp.csv).toContain('003;;Carla Vendas;0,00;0,00;80,00');
    expect((await t.admin.get('/v1/hr/payroll-export', { competence: '2026-10' })).body.rows).toHaveLength(0);
    // Outro colaborador não pede reembolso em nome de terceiros
    expect((await vendedor.post('/v1/hr/reimbursements', { employeeId: emp.ana, expenseDate: '2026-10-02', description: 'Teste', amount: '10.00', categoryId: cats['5.3'] })).status).toBe(403);
    const b = await tb();
    expect(b.totals.debit).toBe(b.totals.credit);
  });
});
