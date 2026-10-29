import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { cep, cnpj, ibge, idParams, isoDate, uf } from '../../http/schemas.js';
import { AppError } from '../../errors.js';
import { safeEqual } from '../../core/crypto.js';
import { changeTaxRegime, createEstablishment, onboardTenant, storeCertificate } from './service.js';
import { createCompanyDefaults } from '../registry/defaults.js';

const REGIMES = ['simples_nacional', 'simples_excesso_sublimite', 'mei', 'lucro_presumido', 'lucro_real'] as const;

export function registerOrgRoutes(app: App) {
  // Provisionamento de tenant. Em produção é chamado pelo console VORTEX ID com a chave de provisionamento.
  const onboardingBody = z.object({
    tenant: z.object({ name: z.string().min(2), slug: z.string().regex(/^[a-z0-9-]{3,40}$/, 'Use letras minúsculas, números e hífen') }),
    admin: z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(10, 'Senha com no mínimo 10 caracteres') }),
  });
  app.post('/v1/onboarding', { schema: { summary: 'Provisiona um tenant com papéis padrão e administrador', tags: ['Organização'] } }, async (req, reply) => {
    const { config } = app.deps;
    if (config.env === 'production' && (typeof req.headers['x-provisioning-key'] !== 'string' || !config.provisioningKey || !safeEqual(req.headers['x-provisioning-key'], config.provisioningKey))) {
      throw new AppError('FORBIDDEN', 'Provisionamento restrito ao console VORTEX', 403);
    }
    const body = onboardingBody.parse(req.body);
    const r = await onboardTenant(app.deps.pool, body);
    reply.status(201);
    return r;
  });

  route(app, { method: 'GET', url: '/v1/companies', summary: 'Lista empresas do tenant', tags: ['Organização'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM core.companies ORDER BY legal_name`));

  route(app, {
    method: 'POST', url: '/v1/companies', summary: 'Cria empresa (CNPJ raiz)', tags: ['Organização'], permission: 'admin.empresa.gerenciar', status: 201,
    body: z.object({ cnpjRoot: z.string().transform((s) => s.toUpperCase().replace(/[^0-9A-Z]/g, '')).refine((s) => /^[0-9A-Z]{8}$/.test(s), 'Raiz do CNPJ com 8 posições'), legalName: z.string().min(2), tradeName: z.string().optional(), economicGroupId: z.string().uuid().optional() }),
  }, async ({ tx, body }) => {
    const company = await tx.one(`INSERT INTO core.companies (tenant_id, cnpj_root, legal_name, trade_name, economic_group_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tx.tenantId, body.cnpjRoot, body.legalName, body.tradeName ?? null, body.economicGroupId ?? null, tx.userId]);
    await createCompanyDefaults(tx, company.id);
    return company;
  });

  route(app, {
    method: 'POST', url: '/v1/economic-groups', summary: 'Cria grupo econômico', tags: ['Organização'], permission: 'admin.empresa.gerenciar', status: 201,
    body: z.object({ name: z.string().min(2) }),
  }, async ({ tx, body }) => tx.one(`INSERT INTO core.economic_groups (tenant_id, name, created_by) VALUES ($1,$2,$3) RETURNING *`, [tx.tenantId, body.name, tx.userId]));

  route(app, { method: 'GET', url: '/v1/establishments', summary: 'Lista estabelecimentos', tags: ['Organização'], permission: null }, async ({ tx, ctx }) => {
    const rows = await tx.query(
      `SELECT e.*, (SELECT regime FROM core.establishment_tax_regimes r WHERE r.establishment_id = e.id AND r.valid_from <= current_date AND (r.valid_to IS NULL OR r.valid_to >= current_date)) AS current_regime
         FROM core.establishments e WHERE ($1::uuid IS NULL OR e.company_id = $1) ORDER BY e.code`, [ctx.companyId]);
    return ctx.establishmentIds ? rows.filter((r) => ctx.establishmentIds!.includes(r.id)) : rows;
  });

  const estBody = z.object({
    companyId: z.string().uuid(), code: z.string().min(1).max(20), cnpj, legalName: z.string().min(2), tradeName: z.string().optional(),
    ie: z.string().nullish(), im: z.string().nullish(), cnae: z.string().nullish(), uf, cityIbge: ibge, cityName: z.string().min(2),
    street: z.string().min(2), number: z.string().min(1), complement: z.string().nullish(), district: z.string().min(2), zip: cep,
    phone: z.string().nullish(), email: z.string().email().nullish(), sefazEnvironment: z.union([z.literal(1), z.literal(2)]).optional(),
    regime: z.object({ regime: z.enum(REGIMES), validFrom: isoDate }),
  });
  route(app, { method: 'POST', url: '/v1/establishments', summary: 'Cria estabelecimento (filial) com depósito e séries padrão', tags: ['Organização'], permission: 'admin.empresa.gerenciar', status: 201, body: estBody },
    async ({ tx, body }) => createEstablishment(tx, body as never));

  route(app, {
    method: 'POST', url: '/v1/establishments/:id/tax-regimes', summary: 'Muda o regime tributário a partir de uma data (RN-ORG-03)', tags: ['Organização'], permission: 'admin.empresa.gerenciar', status: 201,
    params: idParams, body: z.object({ regime: z.enum(REGIMES), validFrom: isoDate }),
  }, async ({ tx, params, body }) => changeTaxRegime(tx, params.id, body.regime, body.validFrom));

  route(app, { method: 'GET', url: '/v1/establishments/:id/tax-regimes', summary: 'Histórico de regimes', tags: ['Organização'], permission: null, params: idParams },
    async ({ tx, params }) => tx.query(`SELECT * FROM core.establishment_tax_regimes WHERE establishment_id = $1 ORDER BY valid_from`, [params.id]));

  route(app, {
    method: 'POST', url: '/v1/establishments/:id/certificate', summary: 'Envia certificado A1 (guardado cifrado, RN-ORG-04)', tags: ['Organização'], permission: 'fiscal.certificado.gerenciar',
    params: idParams, body: z.object({ pfxBase64: z.string().min(100), password: z.string().min(1) }),
  }, async ({ tx, params, body, deps }) => storeCertificate(tx, deps.vault, params.id, body.pfxBase64, body.password));

  route(app, { method: 'GET', url: '/v1/warehouses', summary: 'Lista depósitos', tags: ['Organização'], permission: null }, async ({ tx, ctx }) => {
    const rows = await tx.query(`SELECT * FROM core.warehouses WHERE ($1::uuid IS NULL OR company_id = $1) ORDER BY code`, [ctx.companyId]);
    return ctx.warehouseIds ? rows.filter((r) => ctx.warehouseIds!.includes(r.id)) : rows;
  });

  route(app, {
    method: 'POST', url: '/v1/warehouses', summary: 'Cria depósito/local de estoque', tags: ['Organização'], permission: 'admin.empresa.gerenciar', status: 201,
    body: z.object({
      establishmentId: z.string().uuid(), code: z.string().min(1), name: z.string().min(2),
      kind: z.enum(['own', 'store', 'central', 'in_transit', 'consigned', 'damaged', 'third_party']).default('own'), allowNegative: z.boolean().default(false),
    }),
  }, async ({ tx, body }) => {
    const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [body.establishmentId], 'Estabelecimento');
    return tx.one(
      `INSERT INTO core.warehouses (tenant_id, company_id, establishment_id, code, name, kind, allow_negative, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tx.tenantId, est.company_id, body.establishmentId, body.code, body.name, body.kind, body.allowNegative, tx.userId]);
  });

  route(app, { method: 'GET', url: '/v1/fiscal-series', summary: 'Lista séries fiscais', tags: ['Organização'], permission: null }, async ({ tx, ctx }) =>
    tx.query(`SELECT * FROM core.fiscal_series WHERE ($1::uuid IS NULL OR company_id = $1) ORDER BY model, series`, [ctx.companyId]));

  route(app, {
    method: 'POST', url: '/v1/fiscal-series', summary: 'Cria série fiscal', tags: ['Organização'], permission: 'admin.empresa.gerenciar', status: 201,
    body: z.object({ establishmentId: z.string().uuid(), model: z.enum(['55', '65', '57', '58']), series: z.number().int().min(0).max(999), nextNumber: z.number().int().min(1).default(1), environment: z.union([z.literal(1), z.literal(2)]).default(2) }),
  }, async ({ tx, body }) => {
    const est = await tx.one<{ company_id: string }>(`SELECT company_id FROM core.establishments WHERE id = $1`, [body.establishmentId], 'Estabelecimento');
    return tx.one(
      `INSERT INTO core.fiscal_series (tenant_id, company_id, establishment_id, model, series, next_number, environment, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tx.tenantId, est.company_id, body.establishmentId, body.model, body.series, body.nextNumber, body.environment, tx.userId]);
  });
}
