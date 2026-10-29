import { D, ZERO, roundMoney, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { conflict, ruleViolation, validation } from '../../errors.js';
import { requireReason } from '../../core/audit.js';
import { postEvent, reverseEntries } from '../accounting/posting.js';
import { cancelTitlesOfOrigin, createTitles } from '../finance/titles.js';
import { governmentParty } from '../hr/service.js';

export interface RetentionInput {
  gross: string;
  supplierKind: 'PF' | 'PJ' | 'EX';
  /** Regime do prestador: optante do Simples/MEI não sofre IRRF nem PIS/Cofins/CSLL retidos */
  supplierRegime: string | null;
  serviceCode: string;
  laborAssignment?: boolean;
  inssDeductions?: string;
  issRetained?: boolean;
  issRate?: string | null;
}
export interface Retentions {
  irrf: Decimal; csll: Decimal; pis: Decimal; cofins: Decimal; inss: Decimal; iss: Decimal;
  inssBase: Decimal;
  notes: string[];
}

/** Itens da LC 116 com IRRF de 1% (limpeza, conservação, segurança, vigilância e locação de mão de obra — RIR/2018 art. 716). */
const IRRF_1_PERCENT = new Set(['7.10', '7.11', '11.02', '17.05']);
const MIN_RETENTION = D('10.00');

/**
 * Retenções na fonte sobre serviços tomados de pessoa jurídica (seção 07): IRRF 1,5% (1% nos
 * serviços de limpeza/segurança/mão de obra), CSLL 1%, PIS 0,65% e Cofins 3% (Lei 10.833/2003,
 * art. 30), INSS 11% na cessão de mão de obra (Lei 8.212/1991, art. 31) e ISS quando o município
 * exige do tomador. Retenção de até R$ 10,00 é dispensada. Pessoa física fica para informação
 * manual (tabela progressiva do IR e contribuinte individual).
 */
export function computeRetentions(i: RetentionInput): Retentions {
  const gross = D(i.gross);
  const notes: string[] = [];
  const r: Retentions = { irrf: ZERO, csll: ZERO, pis: ZERO, cofins: ZERO, inss: ZERO, iss: ZERO, inssBase: ZERO, notes };
  if (i.supplierKind === 'PJ') {
    if (i.supplierRegime === 'simples_nacional' || i.supplierRegime === 'mei') {
      notes.push('Prestador do Simples Nacional: sem retenção de IRRF e de PIS/Cofins/CSLL');
    } else {
      const irrf = roundMoney(gross.times(IRRF_1_PERCENT.has(i.serviceCode) ? '0.01' : '0.015'));
      if (irrf.greaterThan(MIN_RETENTION)) r.irrf = irrf;
      else if (irrf.greaterThan(0)) notes.push('IRRF de até R$ 10,00 dispensado');
      const csll = roundMoney(gross.times('0.01'));
      const pis = roundMoney(gross.times('0.0065'));
      const cofins = roundMoney(gross.times('0.03'));
      if (csll.plus(pis).plus(cofins).greaterThan(MIN_RETENTION)) Object.assign(r, { csll, pis, cofins });
      else notes.push('PIS/Cofins/CSLL de até R$ 10,00 dispensados');
    }
  } else if (i.supplierKind === 'PF') {
    notes.push('Prestador pessoa física: informe IRRF e INSS conforme a tabela vigente');
  }
  if (i.laborAssignment) {
    r.inssBase = gross.minus(i.inssDeductions ?? '0');
    const inss = roundMoney(r.inssBase.times('0.11'));
    if (inss.greaterThanOrEqualTo(MIN_RETENTION)) r.inss = inss;
    else notes.push('INSS abaixo de R$ 10,00 dispensado');
  }
  if (i.issRetained) {
    if (!i.issRate) throw validation({ issRate: 'Informe a alíquota do ISS retido' });
    r.iss = roundMoney(gross.times(i.issRate).dividedBy(100));
  }
  return r;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Dia N do mês seguinte, antecipado para sexta-feira quando cai no fim de semana. */
export function nextMonthDay(date: string, day: number): string {
  const [y, m] = date.split('-').map(Number);
  const d = new Date(Date.UTC(y!, m!, Math.min(day, 28)));
  if (day > 28) d.setUTCDate(Math.min(day, new Date(Date.UTC(y!, m! + 1, 0)).getUTCDate()));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}

export interface ServiceInvoiceInput {
  establishmentId: string;
  supplierId: string;
  number: string;
  series?: string | null;
  nfseKey?: string | null;
  issueDate: string;
  dueDate: string;
  serviceCode: string;
  reinfServiceType?: string | null;
  incomeNature?: string | null;
  description?: string | null;
  grossAmount: string;
  laborAssignment?: boolean;
  inssDeductions?: string | null;
  issRetained?: boolean;
  issRate?: string | null;
  /** Valores informados substituem o cálculo automático */
  retentions?: Partial<Record<'irrf' | 'csll' | 'pis' | 'cofins' | 'inss' | 'iss', string>> | null;
  categoryId?: string | null;
  costCenterId?: string | null;
}

async function ledger(tx: Tx, code: string) {
  return (await tx.one<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = $1`, [code], `Conta ${code}`)).id;
}

async function municipalityParty(tx: Tx, est: Record<string, any>): Promise<string> {
  const name = `PREFEITURA MUNICIPAL DE ${String(est.city_name).toUpperCase()}`;
  const ex = await tx.maybeOne<{ id: string }>(`SELECT id FROM registry.parties WHERE kind = 'PJ' AND legal_name = $1 AND status = 'active' LIMIT 1`, [name]);
  if (ex) return ex.id;
  const p = await tx.one<{ id: string }>(
    `INSERT INTO registry.parties (tenant_id, code, kind, legal_name, ie_indicator, final_consumer, notes, created_by)
     VALUES ($1, core.next_tenant_counter('party'), 'PJ', $2, 9, false, 'Credor do ISS retido na fonte', $3) RETURNING id`, [tx.tenantId, name, tx.userId]);
  await tx.exec(`INSERT INTO registry.party_roles (tenant_id, party_id, role) VALUES ($1,$2,'supplier')`, [tx.tenantId, p.id]);
  return p.id;
}

/**
 * Lança a NFS-e de serviço tomado: título do fornecedor pelo líquido, guias das retenções
 * (DARF IRRF 1708, DARF CSRF 5952, INSS na DCTFWeb e ISS do município) e o lançamento contábil.
 * As retenções alimentam a EFD-Reinf (R-2010 e série R-4000).
 */
export async function createServiceInvoice(tx: Tx, input: ServiceInvoiceInput) {
  const est = await tx.one<Record<string, any>>(`SELECT e.*, c.settings FROM core.establishments e JOIN core.companies c ON c.id = e.company_id WHERE e.id = $1`, [input.establishmentId], 'Estabelecimento');
  const sup = await tx.one<{ id: string; kind: 'PF' | 'PJ' | 'EX'; tax_regime: string | null; legal_name: string }>(
    `SELECT p.id, p.kind, p.tax_regime, p.legal_name FROM registry.parties p WHERE p.id = $1 AND EXISTS (SELECT 1 FROM registry.party_roles r WHERE r.party_id = p.id AND r.role = 'supplier')`,
    [input.supplierId], 'Fornecedor');
  if (!/^\d{1,2}\.\d{2}$/.test(input.serviceCode)) throw validation({ serviceCode: 'Item da lista da LC 116 no formato 17.01' });
  if (input.laborAssignment && !input.reinfServiceType) throw validation({ reinfServiceType: 'Informe o tipo de serviço (tabela 06 da EFD-Reinf) para a retenção de INSS' });
  const dup = await tx.maybeOne(`SELECT 1 FROM purchasing.service_invoices WHERE company_id = $1 AND supplier_id = $2 AND number = $3 AND series IS NOT DISTINCT FROM $4 AND status = 'active'`,
    [est.company_id, sup.id, input.number, input.series ?? null]);
  if (dup) throw conflict('DUPLICATE', 'NFS-e já lançada para este fornecedor');
  const auto = computeRetentions({ gross: input.grossAmount, supplierKind: sup.kind, supplierRegime: sup.tax_regime, serviceCode: input.serviceCode, laborAssignment: input.laborAssignment,
    inssDeductions: input.inssDeductions ?? '0', issRetained: input.issRetained, issRate: input.issRate });
  const r = { irrf: auto.irrf, csll: auto.csll, pis: auto.pis, cofins: auto.cofins, inss: auto.inss, iss: auto.iss };
  for (const [k, v] of Object.entries(input.retentions ?? {})) if (v != null) r[k as keyof typeof r] = D(v);
  const totalRet = Object.values(r).reduce((a, v) => a.plus(v), ZERO);
  const gross = D(input.grossAmount);
  const net = gross.minus(totalRet);
  if (net.lessThanOrEqualTo(0)) throw ruleViolation('RN-FIS', 'Retenções maiores que o valor do serviço');
  const si = await tx.one<Record<string, any>>(
    `INSERT INTO purchasing.service_invoices (tenant_id, company_id, establishment_id, supplier_id, number, series, nfse_key, issue_date, service_code, reinf_service_type, income_nature,
       description, gross_amount, inss_deductions, labor_assignment, irrf, csll, pis, cofins, inss, iss, net_amount, due_date, category_id, cost_center_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
    [tx.tenantId, est.company_id, est.id, sup.id, input.number, input.series ?? null, input.nfseKey ?? null, input.issueDate, input.serviceCode, input.reinfServiceType ?? null,
      input.incomeNature ?? (sup.kind === 'PJ' ? '17001' : null), input.description ?? null, gross.toFixed(2), D(input.inssDeductions ?? 0).toFixed(2), input.laborAssignment ?? false,
      r.irrf.toFixed(2), r.csll.toFixed(2), r.pis.toFixed(2), r.cofins.toFixed(2), r.inss.toFixed(2), r.iss.toFixed(2), net.toFixed(2), input.dueDate, input.categoryId ?? null,
      input.costCenterId ?? null, tx.userId]);
  const doc = `NFS-e ${input.number}${input.series ? `/${input.series}` : ''}`;
  const base = { originType: 'service_invoice', originId: si.id, issueDate: input.issueDate, competenceDate: input.issueDate, establishmentId: est.id, costCenterId: input.costCenterId ?? null };
  const titles = await createTitles(tx, { ...base, kind: 'payable', partyId: sup.id, documentNumber: doc, installments: [{ dueDate: input.dueDate, amount: net.toFixed(2) }], categoryId: input.categoryId ?? null });
  const taxCat = (await tx.maybeOne<{ id: string }>(`SELECT id FROM finance.categories WHERE kind = 'expense' AND accepts_entries ORDER BY code LIMIT 1`))?.id ?? null;
  const gov = async (partyId: string, label: string, amount: Decimal, due: string, account: string) => {
    if (amount.lessThanOrEqualTo(0)) return;
    titles.push(...await createTitles(tx, { ...base, kind: 'payable', partyId, documentNumber: `${label} ${doc}`, installments: [{ dueDate: due, amount: amount.toFixed(2) }], categoryId: taxCat,
      ledgerAccountId: await ledger(tx, account), notes: `Retenção na fonte sobre ${doc} de ${sup.legal_name}` }));
  };
  const rfb = r.irrf.plus(r.csll).plus(r.pis).plus(r.cofins).plus(r.inss).greaterThan(0) ? await governmentParty(tx, 'RFB') : null;
  if (rfb) {
    await gov(rfb, 'IRRF 1708', r.irrf, nextMonthDay(input.issueDate, 20), '2.1.2.08');
    await gov(rfb, 'CSRF 5952', r.csll.plus(r.pis).plus(r.cofins), nextMonthDay(input.issueDate, 20), '2.1.2.08');
    await gov(rfb, 'INSS retido', r.inss, nextMonthDay(input.issueDate, 20), '2.1.2.09');
  }
  if (r.iss.greaterThan(0)) await gov(await municipalityParty(tx, est), 'ISS retido', r.iss, nextMonthDay(input.issueDate, Number(est.settings?.fiscal?.issDueDay ?? 10)), '2.1.2.05');
  await tx.exec(`UPDATE purchasing.service_invoices SET title_ids = $2 WHERE id = $1`, [si.id, titles.map((t) => t.id)]);
  const cat = input.categoryId ? await tx.maybeOne<{ ledger_account_id: string | null }>(`SELECT ledger_account_id FROM finance.categories WHERE id = $1`, [input.categoryId]) : null;
  await postEvent(tx, { type: 'servico_tomado', companyId: est.company_id, establishmentId: est.id, date: input.issueDate, description: `Serviço tomado ${doc}`, number: input.number,
    originType: 'service_invoice', originId: si.id, partyId: sup.id, categoryId: input.categoryId ?? null, costCenterId: input.costCenterId ?? null,
    amounts: { gross, net, irrf: r.irrf, csll: r.csll, pis: r.pis, cofins: r.cofins, inss: r.inss, iss: r.iss }, ledgers: { category_ledger: cat?.ledger_account_id } });
  return { ...si, title_ids: titles.map((t) => t.id), notes: auto.notes, titles: titles.map((t) => ({ id: t.id, document_number: t.document_number, amount: t.amount, due_date: t.due_date, party_id: t.party_id })) };
}

export async function cancelServiceInvoice(tx: Tx, id: string, reason: string) {
  await requireReason(tx, reason, 'compras.servico_tomado.cancelar');
  const si = await tx.one<Record<string, any>>(`SELECT * FROM purchasing.service_invoices WHERE id = $1 FOR UPDATE`, [id], 'Serviço tomado');
  if (si.status === 'cancelled') throw conflict('INVALID_STATUS', 'Lançamento já cancelado');
  await cancelTitlesOfOrigin(tx, 'service_invoice', id, reason);
  await reverseEntries(tx, 'service_invoice', id, new Date().toISOString().slice(0, 10), reason);
  return tx.one(`UPDATE purchasing.service_invoices SET status = 'cancelled' WHERE id = $1 RETURNING *`, [id]);
}
