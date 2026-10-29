import { z } from 'zod';
import { UFS, isUF, isValidCNPJ, isValidCPF, isValidIE, cleanDoc, onlyDigits, type UF } from '@vortex/validators';
import type { Tx } from '../../db/tx.js';
import { AppError, conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import { requestApproval, onApprovalDecided } from '../../core/approvals.js';
import { auditAction, requireReason } from '../../core/audit.js';

export { PARTY_ROLES, addressSchema, contactSchema, partySchema, type PartyInput } from '@vortex/contracts';
import { PARTY_ROLES, addressSchema, contactSchema, partySchema, type PartyInput } from '@vortex/contracts';

function validateAddress(a: z.infer<typeof addressSchema>, idx: number): Record<string, string> {
  const errs: Record<string, string> = {};
  if (a.countryCode === '1058') {
    if (!a.zip || a.zip.length !== 8) errs[`addresses.${idx}.zip`] = 'CEP com 8 dígitos';
    if (!a.uf || !isUF(a.uf)) errs[`addresses.${idx}.uf`] = 'UF inválida';
    if (!a.cityIbge) errs[`addresses.${idx}.cityIbge`] = 'Código IBGE do município obrigatório';
    else if (a.uf && isUF(a.uf) && a.cityIbge.slice(0, 2) !== UFS[a.uf]) errs[`addresses.${idx}.cityIbge`] = 'Município não pertence à UF informada';
  }
  return errs;
}

/** Normaliza e valida o documento (RN-CAD-01) e a IE (RN-CAD-03). */
export function normalizeParty(input: PartyInput): PartyInput & { taxIdClean: string | null; ieClean: string | null } {
  const errs: Record<string, string> = {};
  let taxIdClean: string | null = null;
  if (input.kind === 'PF') {
    taxIdClean = input.taxId ? onlyDigits(input.taxId) : null;
    if (!taxIdClean || !isValidCPF(taxIdClean)) errs.taxId = 'CPF inválido';
  } else if (input.kind === 'PJ') {
    taxIdClean = input.taxId ? cleanDoc(input.taxId) : null;
    if (!taxIdClean || !isValidCNPJ(taxIdClean)) errs.taxId = 'CNPJ inválido';
  } else if (!input.foreignId) {
    errs.foreignId = 'Identificação estrangeira obrigatória';
  }
  const fiscal = input.addresses.find((a) => a.kind === 'fiscal') ?? input.addresses[0];
  input.addresses.forEach((a, i) => Object.assign(errs, validateAddress(a, i)));
  let ieClean: string | null = null;
  if (input.ieIndicator === 1) {
    // Contribuinte: IE obrigatória e validada pela UF do endereço fiscal
    if (!input.ie) errs.ie = 'IE obrigatória para contribuinte do ICMS';
    else if (!fiscal?.uf || !isUF(fiscal.uf)) errs.ie = 'Informe o endereço fiscal para validar a IE';
    else if (!isValidIE(input.ie, fiscal.uf as UF)) errs.ie = `Inscrição estadual inválida para ${fiscal.uf}`;
    else ieClean = input.ie.replace(/[^0-9P]/gi, '').toUpperCase();
  } else if (input.ieIndicator === 2) {
    // Isento: grava "ISENTO" conforme leiaute da NF-e
    ieClean = 'ISENTO';
  }
  if (input.roles.includes('customer') || input.roles.includes('supplier')) {
    if (input.addresses.length === 0) errs.addresses = 'Informe ao menos o endereço fiscal';
  }
  if (Object.keys(errs).length) throw validation(errs);
  // Não contribuinte é sempre consumidor final na NF-e
  const finalConsumer = input.ieIndicator === 9 ? true : (input.finalConsumer ?? false);
  return { ...input, finalConsumer, taxIdClean, ieClean };
}

async function sharedCompany(tx: Tx): Promise<string | null> {
  const t = await tx.one<{ settings: { sharing?: { parties?: string } } }>(`SELECT settings FROM core.tenants WHERE id = $1`, [tx.tenantId]);
  return t.settings?.sharing?.parties === 'company' ? tx.companyId : null;
}

export async function createParty(tx: Tx, raw: PartyInput) {
  const p = normalizeParty(raw);
  // RN-CAD-02: CPF/CNPJ único por tenant entre pessoas ativas — abre o existente
  if (p.taxIdClean) {
    const existing = await tx.maybeOne<{ id: string; legal_name: string }>(
      `SELECT id, legal_name FROM registry.parties WHERE tax_id = $1 AND status <> 'inactive'`, [p.taxIdClean]);
    if (existing) {
      throw conflict('PARTY_EXISTS', `Já existe cadastro ativo para este documento: ${existing.legal_name}`, { rule: 'RN-CAD-02', existingId: existing.id });
    }
  }
  const companyId = await sharedCompany(tx);
  const party = await tx.one(
    `INSERT INTO registry.parties (tenant_id, company_id, code, kind, tax_id, foreign_id, legal_name, trade_name, birth_date, ie_indicator, ie, im, suframa,
       tax_regime, final_consumer, xml_email, price_list_id, salesperson_id, payment_term_id, segment, carrier_id, credit_limit, risk_class,
       payment_method_id, ledger_account_id, cost_center_id, lgpd_purpose, notes, created_by)
     VALUES ($1,$2,core.next_tenant_counter('party'),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     RETURNING *`,
    [tx.tenantId, companyId, p.kind, p.taxIdClean, p.foreignId ?? null, p.legalName, p.tradeName ?? null, p.birthDate ?? null, p.ieIndicator, p.ieClean,
      p.im ?? null, p.suframa ?? null, p.taxRegime ?? null, p.finalConsumer, p.xmlEmail ?? null, p.priceListId ?? null, p.salespersonId ?? null,
      p.paymentTermId ?? null, p.segment ?? null, p.carrierId ?? null, p.creditLimit, p.riskClass ?? null, p.paymentMethodId ?? null,
      p.ledgerAccountId ?? null, p.costCenterId ?? null, p.lgpdPurpose ?? (p.kind === 'PF' ? 'Execução de contrato de compra e venda e obrigações fiscais' : null), p.notes ?? null, tx.userId]);
  for (const role of new Set(p.roles)) {
    await tx.exec(`INSERT INTO registry.party_roles (tenant_id, party_id, role) VALUES ($1,$2,$3)`, [tx.tenantId, party.id, role]);
  }
  for (const a of p.addresses) await insertAddress(tx, party.id, a);
  for (const c of p.contacts) await insertContact(tx, party.id, c);
  if (p.roles.includes('customer')) await emit(tx, 'cliente.criado', { type: 'party', id: party.id }, { id: party.id, nome: party.legal_name, documento: party.tax_id });
  return getParty(tx, party.id);
}

export async function insertAddress(tx: Tx, partyId: string, a: z.infer<typeof addressSchema>) {
  const errs = validateAddress(a, 0);
  if (Object.keys(errs).length) throw validation(errs);
  if (a.isDefault) {
    await tx.exec(`UPDATE registry.party_addresses SET is_default = false WHERE party_id = $1 AND kind = $2`, [partyId, a.kind]);
  }
  return tx.one(
    `INSERT INTO registry.party_addresses (tenant_id, party_id, kind, zip, street, number, complement, district, city_ibge, city_name, uf, country_code, is_default, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [tx.tenantId, partyId, a.kind, a.zip ?? null, a.street, a.number, a.complement ?? null, a.district, a.cityIbge ?? null, a.cityName, a.uf ?? null, a.countryCode, a.isDefault, tx.userId]);
}

export async function insertContact(tx: Tx, partyId: string, c: z.infer<typeof contactSchema>) {
  return tx.one(
    `INSERT INTO registry.party_contacts (tenant_id, party_id, name, job_title, phone, whatsapp, email, consents, preferred_channel, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tx.tenantId, partyId, c.name, c.jobTitle ?? null, c.phone ?? null, c.whatsapp ?? null, c.email ?? null, JSON.stringify(c.consents), c.preferredChannel ?? null, tx.userId]);
}

export async function getParty(tx: Tx, id: string) {
  const party = await tx.maybeOne(`SELECT * FROM registry.parties WHERE id = $1`, [id]);
  if (!party) throw notFound('Pessoa');
  if (tx.ctx.ownPortfolioOnly && tx.ctx.partyId && party.salesperson_id !== tx.ctx.partyId) {
    throw new AppError('FORBIDDEN', 'Cliente fora da sua carteira', 403);
  }
  // Consultas em sequência: o cliente da transação não executa consultas em paralelo.
  const roles = await tx.query(`SELECT role, active, since FROM registry.party_roles WHERE party_id = $1`, [id]);
  const addresses = await tx.query(`SELECT * FROM registry.party_addresses WHERE party_id = $1 ORDER BY kind, is_default DESC`, [id]);
  const contacts = await tx.query(`SELECT * FROM registry.party_contacts WHERE party_id = $1 ORDER BY name`, [id]);
  const bankAccounts = await tx.query(`SELECT id, bank_code, branch, account_type, pix_key_type, holder_name, status, created_at,
                     CASE WHEN account_number IS NULL THEN NULL ELSE '****' || right(account_number, 3) END AS account_number_masked,
                     CASE WHEN pix_key IS NULL THEN NULL ELSE left(pix_key, 3) || '****' END AS pix_key_masked
                FROM registry.party_bank_accounts WHERE party_id = $1 ORDER BY created_at`, [id]);
  return { ...party, roles: roles.map((r) => r.role), roleDetails: roles, addresses, contacts, bankAccounts };
}

export const partyPatchSchema = partySchema
  .omit({ kind: true, taxId: true, roles: true, addresses: true, contacts: true })
  .partial()
  .extend({ version: z.number().int(), roles: z.array(z.enum(PARTY_ROLES)).min(1).optional() });

/** Alteração com concorrência otimista (campo version). */
export async function updateParty(tx: Tx, id: string, patch: z.infer<typeof partyPatchSchema>) {
  const current = await tx.one<Record<string, any>>(`SELECT * FROM registry.parties WHERE id = $1`, [id], 'Pessoa');
  if (current.version !== patch.version) {
    throw conflict('VERSION_CONFLICT', 'O cadastro foi alterado por outra pessoa. Recarregue e tente novamente.', { currentVersion: current.version });
  }
  const addresses = await tx.query(`SELECT * FROM registry.party_addresses WHERE party_id = $1`, [id]);
  const fiscal = addresses.find((a) => a.kind === 'fiscal') ?? addresses[0];
  const ieIndicator = patch.ieIndicator ?? current.ie_indicator;
  let ie = current.ie as string | null;
  if (patch.ieIndicator !== undefined || patch.ie !== undefined) {
    if (ieIndicator === 1) {
      const candidate = patch.ie ?? current.ie;
      if (!candidate || !fiscal?.uf || !isValidIE(candidate, fiscal.uf)) throw validation({ ie: 'Inscrição estadual inválida para a UF do endereço fiscal' });
      ie = candidate.replace(/[^0-9P]/gi, '').toUpperCase();
    } else ie = ieIndicator === 2 ? 'ISENTO' : null;
  }
  const map: Record<string, string> = {
    legalName: 'legal_name', tradeName: 'trade_name', birthDate: 'birth_date', im: 'im', suframa: 'suframa', taxRegime: 'tax_regime',
    finalConsumer: 'final_consumer', xmlEmail: 'xml_email', priceListId: 'price_list_id', salespersonId: 'salesperson_id', paymentTermId: 'payment_term_id',
    segment: 'segment', carrierId: 'carrier_id', creditLimit: 'credit_limit', riskClass: 'risk_class', paymentMethodId: 'payment_method_id',
    ledgerAccountId: 'ledger_account_id', costCenterId: 'cost_center_id', lgpdPurpose: 'lgpd_purpose', notes: 'notes', foreignId: 'foreign_id',
  };
  const sets: string[] = ['ie_indicator = $3', 'ie = $4'];
  const vals: unknown[] = [id, patch.version, ieIndicator, ie];
  for (const [k, col] of Object.entries(map)) {
    if ((patch as Record<string, unknown>)[k] !== undefined) {
      vals.push((patch as Record<string, unknown>)[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (ieIndicator === 9) sets.push('final_consumer = true');
  const updated = await tx.maybeOne(`UPDATE registry.parties SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING id`, vals);
  if (!updated) throw conflict('VERSION_CONFLICT', 'O cadastro foi alterado por outra pessoa. Recarregue e tente novamente.');
  if (patch.roles) {
    await tx.exec(`DELETE FROM registry.party_roles WHERE party_id = $1 AND NOT (role = ANY($2))`, [id, patch.roles]);
    await tx.exec(`INSERT INTO registry.party_roles (tenant_id, party_id, role) SELECT $1, $2, unnest($3::text[]) ON CONFLICT DO NOTHING`, [tx.tenantId, id, patch.roles]);
  }
  await emit(tx, 'cliente.alterado', { type: 'party', id }, { id });
  return getParty(tx, id);
}

export async function setPartyStatus(tx: Tx, id: string, status: 'active' | 'blocked' | 'inactive', reason?: string) {
  const p = await tx.one<{ tax_id: string | null; status: string }>(`SELECT tax_id, status FROM registry.parties WHERE id = $1`, [id], 'Pessoa');
  if (status === 'blocked') await requireReason(tx, reason, 'cadastros.pessoa.bloquear');
  if (status === 'active' && p.status === 'inactive' && p.tax_id) {
    const dup = await tx.maybeOne(`SELECT id FROM registry.parties WHERE tax_id = $1 AND status <> 'inactive' AND id <> $2`, [p.tax_id, id]);
    if (dup) throw conflict('PARTY_EXISTS', 'Já existe outro cadastro ativo para este documento', { rule: 'RN-CAD-02', existingId: dup.id });
  }
  await tx.exec(`UPDATE registry.parties SET status = $2, block_reason = $3 WHERE id = $1`, [id, status, status === 'blocked' ? reason ?? null : null]);
  if (status === 'blocked') await emit(tx, 'cliente.bloqueado', { type: 'party', id }, { id, motivo: reason });
  return getParty(tx, id);
}

/**
 * RN-CAD-05: exclusão física só para cadastro sem nenhum vínculo.
 * As FKs dos módulos (pedidos, notas, títulos...) não têm CASCADE, então o banco recusa.
 */
export async function deleteParty(tx: Tx, id: string) {
  await tx.one(`SELECT id FROM registry.parties WHERE id = $1`, [id], 'Pessoa');
  await tx.exec('SAVEPOINT del_party');
  try {
    await tx.exec(`DELETE FROM registry.party_roles WHERE party_id = $1`, [id]);
    await tx.exec(`DELETE FROM registry.party_addresses WHERE party_id = $1`, [id]);
    await tx.exec(`DELETE FROM registry.party_contacts WHERE party_id = $1`, [id]);
    await tx.exec(`DELETE FROM registry.parties WHERE id = $1`, [id]);
    await tx.exec('RELEASE SAVEPOINT del_party');
  } catch (e) {
    await tx.exec('ROLLBACK TO SAVEPOINT del_party');
    if ((e as { code?: string }).code === '23503') {
      throw ruleViolation('RN-CAD-05', 'Cadastro com movimento não pode ser excluído; use a inativação');
    }
    throw e;
  }
  return { deleted: true };
}

// ------------------------------------------------------------------ contas bancárias (RN-ACE-02)
export const bankAccountSchema = z.object({
  bankCode: z.string().regex(/^\d{3}$/).nullish(),
  branch: z.string().nullish(),
  accountNumber: z.string().nullish(),
  accountType: z.enum(['checking', 'savings', 'payment']).nullish(),
  pixKeyType: z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']).nullish(),
  pixKey: z.string().nullish(),
  holderName: z.string().min(2),
  holderTaxId: z.string().transform(cleanDoc),
});

export async function addBankAccount(tx: Tx, partyId: string, b: z.infer<typeof bankAccountSchema>) {
  const party = await tx.one<{ legal_name: string; tax_id: string | null }>(`SELECT legal_name, tax_id FROM registry.parties WHERE id = $1`, [partyId], 'Pessoa');
  if (!b.pixKey && !(b.bankCode && b.branch && b.accountNumber)) throw validation({ pixKey: 'Informe chave Pix ou banco/agência/conta' });
  if (!(isValidCPF(b.holderTaxId) || isValidCNPJ(b.holderTaxId))) throw validation({ holderTaxId: 'CPF/CNPJ do titular inválido' });
  const acc = await tx.one(
    `INSERT INTO registry.party_bank_accounts (tenant_id, party_id, bank_code, branch, account_number, account_type, pix_key_type, pix_key, holder_name, holder_tax_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, status`,
    [tx.tenantId, partyId, b.bankCode ?? null, b.branch ?? null, b.accountNumber ?? null, b.accountType ?? null, b.pixKeyType ?? null, b.pixKey ?? null, b.holderName, b.holderTaxId, tx.userId]);
  const holderDiffers = party.tax_id !== null && party.tax_id !== b.holderTaxId;
  const approval = await requestApproval(tx, {
    entityType: 'party_bank_account', entityId: acc.id, action: 'cadastros.conta_bancaria', reasonCode: 'dupla_aprovacao',
    reason: `Nova conta bancária/chave Pix para ${party.legal_name}${holderDiffers ? ' — ATENÇÃO: titular diferente do cadastro' : ''}`,
    approverPermission: 'cadastros.conta_bancaria.aprovar', requiredApprovals: 2,
  });
  // Alerta: principal vetor de fraude em contas a pagar
  await emit(tx, 'fornecedor.conta_bancaria_alterada', { type: 'party', id: partyId }, { partyId, bankAccountId: acc.id, holderDiffers, requestedBy: tx.userId });
  await auditAction(tx, { action: 'cadastros.conta_bancaria.solicitada', table: 'registry.party_bank_accounts', recordId: acc.id, sensitive: true, data: { holderDiffers } });
  return { ...acc, approvalRequestId: approval.id };
}

onApprovalDecided('party_bank_account', async (tx, req) => {
  await tx.exec(
    `UPDATE registry.party_bank_accounts SET status = $2, approved_at = CASE WHEN $2 = 'active' THEN now() END WHERE id = $1`,
    [req.entity_id, req.status === 'approved' ? 'active' : 'rejected']);
});

// ------------------------------------------------------------------ LGPD (RN-ACE-04)
type RetentionCheck = (tx: Tx, partyId: string) => Promise<boolean>;
const retentionChecks: RetentionCheck[] = [];
/** Módulos fiscais registram se a pessoa tem documentos que a lei obriga a guardar. */
export function registerFiscalRetentionCheck(fn: RetentionCheck) {
  retentionChecks.push(fn);
}

export async function lgpdExport(tx: Tx, id: string) {
  const party = await getParty(tx, id);
  await auditAction(tx, { action: 'lgpd.exportacao', table: 'registry.parties', recordId: id, sensitive: true });
  return { geradoEm: new Date().toISOString(), finalidade: party.lgpd_purpose, titular: party };
}

/** Anonimiza dados pessoais de PF, preservando apenas o que a lei fiscal obriga a guardar. */
export async function lgpdAnonymize(tx: Tx, id: string, reason: string) {
  const p = await tx.one<{ kind: string; anonymized_at: string | null }>(`SELECT kind, anonymized_at FROM registry.parties WHERE id = $1`, [id], 'Pessoa');
  if (p.kind !== 'PF') throw ruleViolation('RN-ACE-04', 'Anonimização se aplica a pessoa física');
  if (p.anonymized_at) throw conflict('ALREADY_ANONYMIZED', 'Cadastro já anonimizado');
  await requireReason(tx, reason, 'lgpd.anonimizar');
  let retain = false;
  for (const check of retentionChecks) if (await check(tx, id)) retain = true;
  await tx.exec(`DELETE FROM registry.party_contacts WHERE party_id = $1`, [id]);
  await tx.exec(`DELETE FROM registry.party_addresses WHERE party_id = $1 AND kind <> 'fiscal'`, [id]);
  await tx.exec(
    `UPDATE registry.parties SET status = 'inactive', anonymized_at = now(), birth_date = NULL, xml_email = NULL, notes = NULL, trade_name = NULL,
            legal_name = CASE WHEN $2 THEN legal_name ELSE 'Titular anonimizado' END,
            tax_id = CASE WHEN $2 THEN tax_id ELSE NULL END
      WHERE id = $1`, [id, retain]);
  if (!retain) await tx.exec(`DELETE FROM registry.party_addresses WHERE party_id = $1`, [id]);
  return { anonymized: true, retainedForFiscalObligation: retain };
}

export { UFS };
