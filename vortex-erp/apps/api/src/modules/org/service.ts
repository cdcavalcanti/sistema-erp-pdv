import { randomUUID } from 'node:crypto';
import forge from 'node-forge';
import { cleanDoc, isValidIE, type UF } from '@vortex/validators';
import type { Pool } from '../../db/pool.js';
import { Tx, withTenant, systemContext } from '../../db/tx.js';
import { AppError, ruleViolation, validation } from '../../errors.js';
import { DEFAULT_LIMITS, DEFAULT_ROLES } from '../../core/permissions.js';
import { hashPassword } from '../../core/crypto.js';
import type { Vault } from '../../core/vault.js';
import { enqueue } from '../../core/jobs.js';
import { createTenantDefaults } from '../registry/defaults.js';

export interface OnboardingInput {
  tenant: { name: string; slug: string };
  admin: { name: string; email: string; password: string };
}

/** Cria tenant, papéis padrão, alçadas padrão e o usuário administrador. */
export async function onboardTenant(pool: Pool, input: OnboardingInput): Promise<{ tenantId: string; adminUserId: string }> {
  const tenantId = randomUUID();
  const ctx = systemContext(tenantId);
  return withTenant(pool, ctx, async (tx) => {
    await tx.exec(`INSERT INTO core.tenants (id, name, slug) VALUES ($1, $2, $3)`, [tenantId, input.tenant.name, input.tenant.slug]);
    const roleIds = new Map<string, string>();
    for (const role of DEFAULT_ROLES) {
      const r = await tx.one<{ id: string }>(
        `INSERT INTO core.roles (tenant_id, code, name, is_system, requires_mfa) VALUES ($1,$2,$3,true,$4) RETURNING id`,
        [tenantId, role.code, role.name, role.requiresMfa]);
      roleIds.set(role.code, r.id);
      await tx.exec(
        `INSERT INTO core.role_permissions (tenant_id, role_id, permission) SELECT $1, $2, unnest($3::text[])`,
        [tenantId, r.id, role.permissions]);
    }
    for (const l of DEFAULT_LIMITS) {
      await tx.exec(
        `INSERT INTO core.approval_limits (tenant_id, role_id, action, max_percent, max_value) VALUES ($1,$2,$3,$4,$5)`,
        [tenantId, roleIds.get(l.role), l.action, l.maxPercent ?? null, l.maxValue ?? null]);
    }
    // Compras acima de R$ 10 mil exigem duas aprovações (seção 04)
    await tx.exec(
      `INSERT INTO core.approval_policies (tenant_id, action, min_value, required_approvals, approver_permission)
       VALUES ($1, 'compras.pedido', 0, 1, 'compras.pedido.aprovar'), ($1, 'compras.pedido', 10000.00, 2, 'compras.pedido.aprovar')`,
      [tenantId]);
    const user = await tx.one<{ id: string }>(
      `INSERT INTO core.users (tenant_id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tenantId, input.admin.email, input.admin.name, await hashPassword(input.admin.password)]);
    await tx.exec(`INSERT INTO core.user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [tenantId, user.id, roleIds.get('administrador')]);
    await createTenantDefaults(tx);
    return { tenantId, adminUserId: user.id };
  });
}

export interface EstablishmentInput {
  companyId: string;
  code: string;
  cnpj: string;
  legalName: string;
  tradeName?: string;
  ie?: string | null;
  im?: string | null;
  cnae?: string | null;
  uf: UF;
  cityIbge: string;
  cityName: string;
  street: string;
  number: string;
  complement?: string | null;
  district: string;
  zip: string;
  phone?: string | null;
  email?: string | null;
  sefazEnvironment?: 1 | 2;
  regime: { regime: string; validFrom: string };
}

export async function createEstablishment(tx: Tx, input: EstablishmentInput) {
  const company = await tx.one<{ cnpj_root: string }>(`SELECT cnpj_root FROM core.companies WHERE id = $1`, [input.companyId], 'Empresa');
  const cnpj = cleanDoc(input.cnpj);
  if (cnpj.slice(0, 8) !== company.cnpj_root) {
    throw validation({ cnpj: 'A raiz do CNPJ do estabelecimento deve ser a mesma da empresa' });
  }
  // RN-CAD-03: IE validada pelo algoritmo da UF
  if (input.ie && !isValidIE(input.ie, input.uf)) throw validation({ ie: `Inscrição estadual inválida para ${input.uf}` });
  const est = await tx.one(
    `INSERT INTO core.establishments (tenant_id, company_id, code, cnpj, legal_name, trade_name, ie, im, cnae, uf, city_ibge, city_name,
       street, number, complement, district, zip, phone, email, sefaz_environment, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [tx.tenantId, input.companyId, input.code, cnpj, input.legalName, input.tradeName ?? null, input.ie ? input.ie.replace(/\D/g, '') || input.ie : null,
      input.im ?? null, input.cnae ?? null, input.uf, input.cityIbge, input.cityName, input.street, input.number, input.complement ?? null,
      input.district, input.zip, input.phone ?? null, input.email ?? null, input.sefazEnvironment ?? 2, tx.userId]);
  await tx.exec(
    `INSERT INTO core.establishment_tax_regimes (tenant_id, establishment_id, regime, valid_from, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [tx.tenantId, est.id, input.regime.regime, input.regime.validFrom, tx.userId]);
  // Depósito padrão e séries iniciais de NF-e/NFC-e
  await tx.exec(
    `INSERT INTO core.warehouses (tenant_id, company_id, establishment_id, code, name, kind, is_default, created_by)
     VALUES ($1,$2,$3,'PRINCIPAL','Depósito principal','own',true,$4)`,
    [tx.tenantId, input.companyId, est.id, tx.userId]);
  for (const model of ['55', '65']) {
    await tx.exec(
      `INSERT INTO core.fiscal_series (tenant_id, company_id, establishment_id, model, series, environment, created_by) VALUES ($1,$2,$3,$4,1,$5,$6)`,
      [tx.tenantId, input.companyId, est.id, model, input.sefazEnvironment ?? 2, tx.userId]);
  }
  return est;
}

/**
 * RN-ORG-03: muda o regime a partir de uma data, encerrando o anterior na véspera.
 * Documentos já emitidos guardam o regime usado e não mudam.
 */
export async function changeTaxRegime(tx: Tx, establishmentId: string, regime: string, validFrom: string) {
  const current = await tx.maybeOne<{ id: string; valid_from: string }>(
    `SELECT id, valid_from::text FROM core.establishment_tax_regimes WHERE establishment_id = $1 AND valid_to IS NULL`, [establishmentId]);
  if (current) {
    if (current.valid_from >= validFrom) throw ruleViolation('RN-ORG-03', 'A nova vigência deve começar depois da vigência atual');
    await tx.exec(`UPDATE core.establishment_tax_regimes SET valid_to = ($2::date - 1) WHERE id = $1`, [current.id, validFrom]);
  }
  return tx.one(
    `INSERT INTO core.establishment_tax_regimes (tenant_id, establishment_id, regime, valid_from, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tx.tenantId, establishmentId, regime, validFrom, tx.userId]);
}

export async function regimeAt(tx: Tx, establishmentId: string, date: string): Promise<string> {
  const r = await tx.maybeOne<{ regime: string }>(
    `SELECT regime FROM core.establishment_tax_regimes WHERE establishment_id = $1 AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)`,
    [establishmentId, date]);
  if (!r) throw ruleViolation('RN-ORG-03', 'Estabelecimento sem regime tributário vigente na data');
  return r.regime;
}

/**
 * RN-ORG-04: certificado A1 (PFX) guardado cifrado no cofre. Extrai validade e
 * CNPJ do certificado e agenda avisos de vencimento em 30, 15 e 5 dias.
 */
export async function storeCertificate(tx: Tx, vault: Vault, establishmentId: string, pfxBase64: string, password: string) {
  const est = await tx.one<{ cnpj: string }>(`SELECT cnpj FROM core.establishments WHERE id = $1`, [establishmentId], 'Estabelecimento');
  let notAfter: Date;
  let subject: string;
  try {
    const der = forge.util.decode64(pfxBase64);
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), password);
    const bags = p12.getBags({ bagType: forge.pki.oids.certBag! })[forge.pki.oids.certBag!] ?? [];
    const cert = bags.map((b) => b.cert!).find((c) => c && !c.extensions.some((e: { name: string; cA?: boolean }) => e.name === 'basicConstraints' && e.cA));
    if (!cert) throw new Error('sem certificado');
    notAfter = cert.validity.notAfter;
    subject = cert.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(', ');
  } catch {
    throw new AppError('CERTIFICATE_INVALID', 'Não foi possível abrir o certificado: arquivo ou senha inválidos', 422);
  }
  if (notAfter.getTime() < Date.now()) throw new AppError('CERTIFICATE_EXPIRED', 'Certificado vencido', 422);
  const cnpjInCert = /(\d{14}|[0-9A-Z]{12}\d{2})/.exec(subject)?.[1];
  if (cnpjInCert && cnpjInCert.slice(0, 8) !== est.cnpj.slice(0, 8)) {
    throw new AppError('CERTIFICATE_MISMATCH', 'O certificado pertence a outro CNPJ', 422, { certificateCnpj: cnpjInCert });
  }
  const secretId = await vault.put(tx, 'certificate_a1', `cert-${est.cnpj}`, Buffer.from(pfxBase64, 'base64'), { metadata: { subject }, expiresAt: notAfter });
  const pwdId = await vault.put(tx, 'certificate_password', `cert-pwd-${est.cnpj}`, password, { metadata: { certificate: secretId } });
  await tx.exec(
    `UPDATE core.establishments SET certificate_secret_id = $2, certificate_expires_at = $3 WHERE id = $1`,
    [establishmentId, secretId, notAfter]);
  await tx.exec(`UPDATE core.secrets SET metadata = metadata || jsonb_build_object('password_secret_id', $2::text) WHERE id = $1`, [secretId, pwdId]);
  for (const days of [30, 15, 5]) {
    const runAt = new Date(notAfter.getTime() - days * 86_400_000);
    if (runAt.getTime() > Date.now()) {
      await enqueue(tx, 'certificado.aviso', { establishmentId, days, expiresAt: notAfter.toISOString() }, { runAt, dedupeKey: `${establishmentId}:${secretId}:${days}` });
    }
  }
  return { establishmentId, expiresAt: notAfter.toISOString(), subject };
}
