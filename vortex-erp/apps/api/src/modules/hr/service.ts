import { D, HUNDRED, ZERO, roundMoney, sum, type Decimal } from '@vortex/money';
import type { RequestContext, Tx } from '../../db/tx.js';
import { conflict, forbidden, notFound, validation } from '../../errors.js';
import { has } from '../../core/access.js';
import { onApprovalDecided, requestApproval } from '../../core/approvals.js';
import type { Services } from '../../services.js';
import { subscribe } from '../../worker/registry.js';
import { createParty, type PartyInput } from '../registry/parties.js';
import { createTitles } from '../finance/titles.js';
import { postEvent } from '../accounting/posting.js';

const ledger = async (tx: Tx, code: string) => (await tx.one<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = $1`, [code], `Conta ${code}`)).id;
const lastDay = (competence: string) => new Date(Date.UTC(Number(competence.slice(0, 4)), Number(competence.slice(5, 7)), 0)).toISOString().slice(0, 10);
/** Recolhimentos da folha (DCTFWeb, FGTS Digital, IRRF) vencem no dia 20 do mês seguinte. */
const day20Next = (competence: string) => new Date(Date.UTC(Number(competence.slice(0, 4)), Number(competence.slice(5, 7)), 20)).toISOString().slice(0, 10);

// ------------------------------------------------------------------ cadastro

export async function createEmployee(tx: Tx, input: { partyId?: string | null; party?: Omit<PartyInput, 'roles'> | null; userId?: string | null; registration: string;
  departmentId?: string | null; positionId?: string | null; costCenterId?: string | null; admissionDate: string; baseSalary?: string | null; payrollExternalId?: string | null }) {
  let partyId = input.partyId ?? null;
  if (partyId) {
    await tx.one(`SELECT 1 FROM registry.parties WHERE id = $1`, [partyId], 'Pessoa');
    await tx.exec(`INSERT INTO registry.party_roles (tenant_id, party_id, role) VALUES ($1,$2,'employee') ON CONFLICT DO NOTHING`, [tx.tenantId, partyId]);
  } else if (input.party) {
    partyId = (await createParty(tx, { ...input.party, roles: ['employee'] } as PartyInput)).id;
  } else {
    throw validation({ partyId: 'Informe a pessoa (existente ou nova)' });
  }
  const dept = input.departmentId ? await tx.one<{ cost_center_id: string | null }>(`SELECT cost_center_id FROM hr.departments WHERE id = $1`, [input.departmentId], 'Departamento') : null;
  const e = await tx.one<{ id: string }>(
    `INSERT INTO hr.employees (tenant_id, company_id, party_id, user_id, registration, department_id, position_id, cost_center_id, admission_date, base_salary, payroll_external_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [tx.tenantId, tx.companyId, partyId, input.userId ?? null, input.registration, input.departmentId ?? null, input.positionId ?? null, input.costCenterId ?? dept?.cost_center_id ?? null,
      input.admissionDate, input.baseSalary ?? null, input.payrollExternalId ?? null, tx.userId]);
  if (input.userId) await tx.exec(`UPDATE core.users SET party_id = $2 WHERE id = $1 AND party_id IS NULL`, [input.userId, partyId]);
  return e;
}

/** LGPD/minimização: salário só para quem gere RH ou importa a folha. */
export async function listEmployees(tx: Tx, ctx: RequestContext, filter: { status?: string; departmentId?: string } = {}) {
  const rows = await tx.query<Record<string, any>>(
    `SELECT e.*, p.legal_name AS name, p.tax_id, d.name AS department, ps.name AS position, u.email AS user_email
       FROM hr.employees e JOIN registry.parties p ON p.id = e.party_id LEFT JOIN hr.departments d ON d.id = e.department_id
       LEFT JOIN hr.positions ps ON ps.id = e.position_id LEFT JOIN core.users u ON u.id = e.user_id
      WHERE ($1::uuid IS NULL OR e.company_id = $1) AND ($2::text IS NULL OR e.status = $2) AND ($3::uuid IS NULL OR e.department_id = $3) ORDER BY p.legal_name`,
    [ctx.companyId, filter.status ?? null, filter.departmentId ?? null]);
  const seeSalary = has(ctx, 'rh.colaborador.editar') || has(ctx, 'rh.folha.importar');
  return rows.map((r) => (seeSalary ? r : { ...r, base_salary: undefined }));
}

// ------------------------------------------------------------------ resumo da folha

export async function governmentParty(tx: Tx, kind: 'RFB' | 'FGTS'): Promise<string> {
  const [taxId, name] = kind === 'RFB' ? ['00394460005887', 'RECEITA FEDERAL DO BRASIL'] : ['00360305000104', 'CAIXA ECONOMICA FEDERAL - FGTS'];
  const ex = await tx.maybeOne<{ id: string }>(`SELECT id FROM registry.parties WHERE tax_id = $1 AND status <> 'inactive'`, [taxId]);
  if (ex) {
    await tx.exec(`INSERT INTO registry.party_roles (tenant_id, party_id, role) VALUES ($1,$2,'supplier') ON CONFLICT DO NOTHING`, [tx.tenantId, ex.id]);
    return ex.id;
  }
  return (await createParty(tx, { kind: 'PJ', taxId, legalName: name, roles: ['supplier'], ieIndicator: 9, creditLimit: '0', contacts: [],
    addresses: [{ kind: 'fiscal', zip: '70048900', street: 'Setor de Autarquias Sul', number: 'S/N', district: 'Asa Sul', cityIbge: '5300108', cityName: 'Brasília', uf: 'DF', countryCode: '1058', isDefault: true }] } as PartyInput)).id;
}

export interface PayrollImportInput {
  competence: string;
  paymentDate: string;
  source?: 'api' | 'csv' | 'partner';
  items: { employeeId?: string | null; registration?: string | null; gross: string; inssEmployee?: string; irrf?: string; otherDeductions?: string }[];
  inssEmployer: string;
  /** Padrão: 8% do bruto */
  fgts?: string | null;
}

/**
 * Importa o resumo da folha do sistema parceiro: títulos a pagar (salários líquidos,
 * INSS, FGTS e IRRF) e o lançamento contábil da competência — sem calcular a folha.
 */
export async function importPayroll(tx: Tx, input: PayrollImportInput) {
  if (!/^\d{4}-\d{2}$/.test(input.competence)) throw validation({ competence: 'Competência no formato AAAA-MM' });
  const competence = `${input.competence}-01`;
  if (await tx.maybeOne(`SELECT 1 FROM hr.payroll_imports WHERE company_id = $1 AND competence = $2`, [tx.companyId, competence])) {
    throw conflict('PAYROLL_ALREADY_IMPORTED', `Folha de ${input.competence} já importada`);
  }
  const lines = [];
  for (const it of input.items) {
    const e = await tx.maybeOne<{ id: string; party_id: string; cost_center_id: string | null; registration: string; status: string }>(
      `SELECT id, party_id, cost_center_id, registration, status FROM hr.employees WHERE company_id = $1 AND (id = $2 OR registration = $3)`, [tx.companyId, it.employeeId ?? null, it.registration ?? null]);
    if (!e) throw validation({ items: `Colaborador ${it.registration ?? it.employeeId} não cadastrado` });
    const inss = D(it.inssEmployee ?? 0);
    const irrf = D(it.irrf ?? 0);
    const other = D(it.otherDeductions ?? 0);
    const net = D(it.gross).minus(inss).minus(irrf).minus(other);
    if (net.isNegative()) throw validation({ items: `Líquido negativo para ${e.registration}` });
    lines.push({ e, gross: D(it.gross), inss, irrf, other, net });
  }
  const gross = sum(lines.map((l) => l.gross));
  const fgts = input.fgts != null ? D(input.fgts) : roundMoney(gross.times(8).dividedBy(HUNDRED));
  const totals = { gross, net: sum(lines.map((l) => l.net)), inssEmployee: sum(lines.map((l) => l.inss)), irrf: sum(lines.map((l) => l.irrf)),
    other: sum(lines.map((l) => l.other)), inssEmployer: D(input.inssEmployer), fgts };
  const imp = await tx.one<{ id: string }>(
    `INSERT INTO hr.payroll_imports (tenant_id, company_id, competence, payment_date, source, gross, net, inss_employee, inss_employer, fgts, irrf, other_deductions, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [tx.tenantId, tx.companyId, competence, input.paymentDate, input.source ?? 'api', gross.toFixed(2), totals.net.toFixed(2), totals.inssEmployee.toFixed(2),
      totals.inssEmployer.toFixed(2), fgts.toFixed(2), totals.irrf.toFixed(2), totals.other.toFixed(2), tx.userId]);
  const category = (await tx.maybeOne<{ id: string }>(`SELECT id FROM finance.categories WHERE code = '5.2'`))?.id ?? null;
  const titleIds: string[] = [];
  const salaries = await ledger(tx, '2.1.5.01');
  for (const l of lines) {
    if (l.net.isZero()) continue;
    const [t] = await createTitles(tx, { kind: 'payable', partyId: l.e.party_id, originType: 'payroll', originId: imp.id, documentNumber: `FOLHA ${input.competence} ${l.e.registration}`,
      issueDate: input.paymentDate, competenceDate: lastDay(competence), installments: [{ dueDate: input.paymentDate, amount: l.net.toFixed(2) }], categoryId: category,
      costCenterId: l.e.cost_center_id, ledgerAccountId: salaries });
    titleIds.push(t!.id);
    await tx.exec(`INSERT INTO hr.payroll_import_items (tenant_id, import_id, employee_id, gross, inss_employee, irrf, other_deductions, net, title_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tx.tenantId, imp.id, l.e.id, l.gross.toFixed(2), l.inss.toFixed(2), l.irrf.toFixed(2), l.other.toFixed(2), l.net.toFixed(2), t!.id]);
  }
  const rfb = await governmentParty(tx, 'RFB');
  const caixa = await governmentParty(tx, 'FGTS');
  const charges: [string, string, Decimal, string, string][] = [
    [rfb, `INSS ${input.competence}`, totals.inssEmployee.plus(totals.inssEmployer), '2.1.5.02', 'tax'],
    [caixa, `FGTS ${input.competence}`, fgts, '2.1.5.03', 'tax'],
    [rfb, `IRRF folha ${input.competence}`, totals.irrf, '2.1.5.04', 'tax'],
  ];
  for (const [party, doc, value, acc, origin] of charges) {
    if (value.lessThanOrEqualTo(0)) continue;
    const [t] = await createTitles(tx, { kind: 'payable', partyId: party, originType: origin, originId: imp.id, documentNumber: doc, issueDate: input.paymentDate, competenceDate: lastDay(competence),
      installments: [{ dueDate: day20Next(competence), amount: value.toFixed(2) }], categoryId: category, ledgerAccountId: await ledger(tx, acc) });
    titleIds.push(t!.id);
  }
  const entry = await postEvent(tx, {
    type: 'folha', companyId: tx.companyId, date: lastDay(competence), description: `Folha de pagamento ${input.competence}`, number: input.competence, originType: 'payroll_import', originId: imp.id,
    amounts: { gross, net: totals.net, inss_employee: totals.inssEmployee, inss_employer: totals.inssEmployer, fgts, irrf: totals.irrf, other_deductions: totals.other },
  });
  await tx.exec(`UPDATE hr.payroll_imports SET title_ids = $2, journal_entry_id = $3 WHERE id = $1`, [imp.id, titleIds, entry]);
  return { id: imp.id, competence: input.competence, employees: lines.length, gross: gross.toFixed(2), net: totals.net.toFixed(2), inss: totals.inssEmployee.plus(totals.inssEmployer).toFixed(2),
    fgts: fgts.toFixed(2), irrf: totals.irrf.toFixed(2), titles: titleIds.length, journalEntryId: entry };
}

// ------------------------------------------------------------------ reembolso de despesas

export async function requestReimbursement(tx: Tx, ctx: RequestContext, services: Services, input: { employeeId?: string | null; expenseDate: string; description: string; amount: string;
  categoryId: string; costCenterId?: string | null; paymentMode?: 'direct' | 'payroll'; receiptBase64?: string | null; receiptContentType?: string | null }) {
  let employeeId = input.employeeId ?? null;
  if (employeeId && !has(ctx, 'rh.reembolso.aprovar')) {
    const own = await tx.maybeOne(`SELECT 1 FROM hr.employees WHERE id = $1 AND user_id = $2`, [employeeId, ctx.userId]);
    if (!own) throw forbidden('Você só solicita reembolso para você mesmo');
  }
  employeeId ??= (await tx.maybeOne<{ id: string }>(`SELECT id FROM hr.employees WHERE user_id = $1 AND status = 'active'`, [ctx.userId]))?.id ?? null;
  if (!employeeId) throw validation({ employeeId: 'Usuário sem cadastro de colaborador vinculado' });
  const e = await tx.one<{ cost_center_id: string | null; company_id: string }>(`SELECT cost_center_id, company_id FROM hr.employees WHERE id = $1`, [employeeId], 'Colaborador');
  let receiptKey: string | null = null;
  if (input.receiptBase64) {
    const buf = Buffer.from(input.receiptBase64, 'base64');
    receiptKey = (await services.storage.putImmutable(`reembolsos/${tx.tenantId}/${employeeId}/${Date.now()}`, buf, input.receiptContentType ?? 'application/octet-stream')).key;
  }
  const r = await tx.one<{ id: string }>(
    `INSERT INTO hr.expense_reimbursements (tenant_id, company_id, employee_id, expense_date, description, amount, category_id, cost_center_id, receipt_key, payment_mode, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [tx.tenantId, e.company_id, employeeId, input.expenseDate, input.description, input.amount, input.categoryId, input.costCenterId ?? e.cost_center_id, receiptKey, input.paymentMode ?? 'direct', tx.userId]);
  await requestApproval(tx, { entityType: 'expense_reimbursement', entityId: r.id, action: 'rh.reembolso', reasonCode: 'reembolso', value: input.amount,
    reason: `Reembolso: ${input.description} (R$ ${D(input.amount).toFixed(2)})`, approverPermission: 'rh.reembolso.aprovar' });
  return tx.one(`SELECT * FROM hr.expense_reimbursements WHERE id = $1`, [r.id]);
}

onApprovalDecided('expense_reimbursement', async (tx, req) => {
  const r = await tx.one<Record<string, any>>(`SELECT * FROM hr.expense_reimbursements WHERE id = $1 FOR UPDATE`, [req.entity_id]);
  if (r.status !== 'pending') return;
  if (req.status !== 'approved') {
    await tx.exec(`UPDATE hr.expense_reimbursements SET status = 'rejected' WHERE id = $1`, [r.id]);
    return;
  }
  if (r.payment_mode === 'payroll') {
    await tx.exec(`UPDATE hr.expense_reimbursements SET status = 'approved' WHERE id = $1`, [r.id]);
    return;
  }
  // Pagamento direto: título a pagar ao colaborador (já aprovado) e despesa na categoria
  const e = await tx.one<{ party_id: string }>(`SELECT party_id FROM hr.employees WHERE id = $1`, [r.employee_id]);
  const [t] = await createTitles(tx, { kind: 'payable', partyId: e.party_id, originType: 'expense_reimbursement', originId: r.id, documentNumber: `REEMB-${r.id.slice(0, 8)}`,
    issueDate: new Date().toISOString().slice(0, 10), competenceDate: String(r.expense_date instanceof Date ? r.expense_date.toISOString().slice(0, 10) : r.expense_date),
    installments: [{ dueDate: new Date().toISOString().slice(0, 10), amount: r.amount }], categoryId: r.category_id, costCenterId: r.cost_center_id });
  await tx.exec(`UPDATE finance.titles SET approved_at = now(), approved_by = $2 WHERE id = $1`, [t!.id, tx.userId]);
  const cat = await tx.maybeOne<{ ledger_account_id: string | null }>(`SELECT ledger_account_id FROM finance.categories WHERE id = $1`, [r.category_id]);
  await postEvent(tx, { type: 'titulo_manual_pagar', companyId: r.company_id, date: new Date().toISOString().slice(0, 10), description: `Reembolso ${r.description}`, number: t!.document_number,
    originType: 'title', originId: t!.id, partyId: e.party_id, costCenterId: r.cost_center_id, amounts: { amount: r.amount }, ledgers: { category_ledger: cat?.ledger_account_id } });
  await tx.exec(`UPDATE hr.expense_reimbursements SET status = 'approved', title_id = $2 WHERE id = $1`, [r.id, t!.id]);
});

subscribe('titulo.pago', async (tx, ev) => {
  if (ev.payload.origem !== 'expense_reimbursement') return;
  await tx.exec(`UPDATE hr.expense_reimbursements SET status = 'paid' WHERE id = $1 AND status = 'approved'`, [ev.payload.origemId]);
});

// ------------------------------------------------------------------ exportação para a folha

/** Comissões liberadas, adiantamentos e reembolsos "pela folha" da competência, por colaborador. */
export async function payrollExport(tx: Tx, competence: string, opts: { markExported?: boolean } = {}) {
  const from = `${competence}-01`;
  const to = lastDay(from);
  const employees = await tx.query<{ id: string; party_id: string; registration: string; name: string; payroll_external_id: string | null }>(
    `SELECT e.id, e.party_id, e.registration, p.legal_name AS name, e.payroll_external_id FROM hr.employees e JOIN registry.parties p ON p.id = e.party_id
      WHERE e.company_id = $1 AND e.status <> 'terminated' ORDER BY e.registration`, [tx.companyId]);
  const out = [];
  for (const e of employees) {
    const commission = await tx.one<{ v: string | null }>(`SELECT sum(amount) AS v FROM sales.commissions WHERE salesperson_id = $1 AND status = 'released' AND released_at::date BETWEEN $2 AND $3`,
      [e.party_id, from, to]);
    const advances = await tx.one<{ v: string | null }>(`SELECT sum(amount) AS v FROM finance.titles WHERE party_id = $1 AND origin_type = 'advance' AND kind = 'receivable' AND issue_date BETWEEN $2 AND $3`,
      [e.party_id, from, to]);
    const reimb = await tx.query<{ id: string; amount: string }>(`SELECT id, amount FROM hr.expense_reimbursements WHERE employee_id = $1 AND payment_mode = 'payroll' AND status = 'approved'`, [e.id]);
    const row = { registration: e.registration, externalId: e.payroll_external_id, name: e.name, commissions: D(commission.v ?? 0).toFixed(2), advances: D(advances.v ?? 0).toFixed(2),
      reimbursements: sum(reimb.map((r) => r.amount)).toFixed(2) };
    if ([row.commissions, row.advances, row.reimbursements].some((v) => !D(v).isZero())) out.push(row);
    if (opts.markExported && reimb.length) await tx.exec(`UPDATE hr.expense_reimbursements SET status = 'exported' WHERE id = ANY($1)`, [reimb.map((r) => r.id)]);
  }
  const csv = ['matricula;id_folha;nome;comissoes;adiantamentos;reembolsos', ...out.map((r) => [r.registration, r.externalId ?? '', r.name, r.commissions, r.advances, r.reimbursements]
    .map((v, i) => (i >= 3 ? String(v).replace('.', ',') : String(v))).join(';'))].join('\r\n');
  return { competence, rows: out, csv, totals: { commissions: sum(out.map((r) => r.commissions)).toFixed(2), advances: sum(out.map((r) => r.advances)).toFixed(2),
    reimbursements: sum(out.map((r) => r.reimbursements)).toFixed(2) } };
}

export { notFound, ZERO };
