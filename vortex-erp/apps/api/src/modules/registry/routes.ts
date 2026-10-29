import { z } from 'zod';
import { cleanDoc, isValidCNPJ, onlyDigits } from '@vortex/validators';
import { route, type App } from '../../http/app.js';
import { decimal, decodeCursor, idParams, page } from '../../http/schemas.js';
import { AppError, notFound, validation } from '../../errors.js';
import {
  PARTY_ROLES, addBankAccount, addressSchema, bankAccountSchema, contactSchema, createParty, deleteParty, getParty, insertAddress, insertContact,
  lgpdAnonymize, lgpdExport, partyPatchSchema, partySchema, setPartyStatus, updateParty,
} from './parties.js';

export function registerRegistryRoutes(app: App) {
  // ---------------------------------------------------------------- consultas públicas (RN-CAD-04)
  route(app, {
    method: 'GET', url: '/v1/lookups/cnpj/:cnpj', summary: 'Consulta pública de CNPJ para preencher o cadastro (o usuário confirma)', tags: ['Cadastros'], permission: 'cadastros.pessoa.criar',
    params: z.object({ cnpj: z.string() }),
  }, async ({ params, deps }) => {
    const c = cleanDoc(params.cnpj);
    if (!isValidCNPJ(c)) throw validation({ cnpj: 'CNPJ inválido' });
    const info = await deps.services.lookups.cnpj(c);
    if (!info) throw new AppError('NOT_FOUND', 'CNPJ não encontrado na base pública', 404);
    return { ...info, blocksCreditSale: info.registrationStatus === 'inapta' || info.registrationStatus === 'baixada' };
  });

  route(app, {
    method: 'GET', url: '/v1/lookups/cep/:cep', summary: 'Consulta de CEP (endereço e código IBGE)', tags: ['Cadastros'], permission: null,
    params: z.object({ cep: z.string() }),
  }, async ({ params, deps }) => {
    const info = await deps.services.lookups.cep(onlyDigits(params.cep));
    if (!info) throw new AppError('NOT_FOUND', 'CEP não encontrado', 404);
    return info;
  });

  // ---------------------------------------------------------------- pessoas
  route(app, {
    method: 'GET', url: '/v1/parties', summary: 'Lista pessoas (clientes, fornecedores, transportadoras...)', tags: ['Cadastros'], permission: 'cadastros.pessoa.ler',
    query: z.object({ q: z.string().optional(), role: z.enum(PARTY_ROLES).optional(), status: z.enum(['active', 'blocked', 'inactive']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50), cursor: z.string().optional() }),
  }, async ({ tx, ctx, query }) => {
    const c = decodeCursor(query.cursor);
    const q = query.q?.trim() || null;
    const rows = await tx.query(
      `SELECT p.id, p.code, p.kind, p.tax_id, p.legal_name, p.trade_name, p.status, p.credit_limit, p.registration_status, p.created_at,
              coalesce((SELECT array_agg(role) FROM registry.party_roles r WHERE r.party_id = p.id AND r.active), '{}') AS roles,
              (SELECT city_name || '/' || uf FROM registry.party_addresses a WHERE a.party_id = p.id AND a.kind = 'fiscal' AND a.is_default LIMIT 1) AS city
         FROM registry.parties p
        WHERE ($1::uuid IS NULL OR p.company_id IS NULL OR p.company_id = $1)
          AND ($2::text IS NULL OR p.legal_name ILIKE '%' || $2 || '%' OR p.trade_name ILIKE '%' || $2 || '%' OR p.tax_id = regexp_replace(upper($2), '[^0-9A-Z]', '', 'g') OR p.code::text = $2)
          AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM registry.party_roles r WHERE r.party_id = p.id AND r.role = $3 AND r.active))
          AND ($4::text IS NULL OR p.status = $4) AND ($4::text IS NOT NULL OR p.status <> 'inactive')
          AND ($5::uuid IS NULL OR p.salesperson_id = $5)
          AND ($6::timestamptz IS NULL OR (p.created_at, p.id) < ($6, $7::uuid))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $8`,
      [ctx.companyId, q, query.role ?? null, query.status ?? null, ctx.ownPortfolioOnly ? ctx.partyId : null, c?.at ?? null, c?.id ?? null, query.limit + 1]);
    return page(rows, query.limit);
  });

  route(app, { method: 'POST', url: '/v1/parties', summary: 'Cadastra pessoa com papéis, endereços e contatos', tags: ['Cadastros'], permission: 'cadastros.pessoa.criar', status: 201, body: partySchema },
    async ({ tx, body }) => createParty(tx, body));

  route(app, { method: 'GET', url: '/v1/parties/:id', summary: 'Detalhe da pessoa', tags: ['Cadastros'], permission: 'cadastros.pessoa.ler', params: idParams },
    async ({ tx, params }) => getParty(tx, params.id));

  route(app, { method: 'PATCH', url: '/v1/parties/:id', summary: 'Altera pessoa (concorrência otimista por version)', tags: ['Cadastros'], permission: 'cadastros.pessoa.editar', params: idParams, body: partyPatchSchema },
    async ({ tx, params, body }) => updateParty(tx, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/parties/:id/status', summary: 'Bloqueia, inativa ou reativa (RN-CAD-05: inativar em vez de excluir)', tags: ['Cadastros'], permission: 'cadastros.pessoa.inativar', params: idParams,
    body: z.object({ status: z.enum(['active', 'blocked', 'inactive']), reason: z.string().optional() }),
  }, async ({ tx, params, body }) => setPartyStatus(tx, params.id, body.status, body.reason));

  route(app, { method: 'DELETE', url: '/v1/parties/:id', summary: 'Exclui pessoa sem nenhum vínculo (RN-CAD-05)', tags: ['Cadastros'], permission: 'cadastros.pessoa.inativar', params: idParams },
    async ({ tx, params }) => deleteParty(tx, params.id));

  route(app, { method: 'POST', url: '/v1/parties/:id/addresses', summary: 'Adiciona endereço', tags: ['Cadastros'], permission: 'cadastros.pessoa.editar', status: 201, params: idParams, body: addressSchema },
    async ({ tx, params, body }) => insertAddress(tx, params.id, body));

  route(app, { method: 'DELETE', url: '/v1/parties/:id/addresses/:addressId', summary: 'Remove endereço', tags: ['Cadastros'], permission: 'cadastros.pessoa.editar', params: z.object({ id: z.string().uuid(), addressId: z.string().uuid() }) },
    async ({ tx, params }) => {
      const deleted = await tx.exec(`DELETE FROM registry.party_addresses WHERE id = $1 AND party_id = $2`, [params.addressId, params.id]);
      if (!deleted) throw notFound('Endereço');
      return { deleted };
    });

  route(app, { method: 'POST', url: '/v1/parties/:id/contacts', summary: 'Adiciona contato (com consentimentos LGPD)', tags: ['Cadastros'], permission: 'cadastros.pessoa.editar', status: 201, params: idParams, body: contactSchema },
    async ({ tx, params, body }) => insertContact(tx, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/parties/:id/bank-accounts', summary: 'Nova conta bancária/chave Pix (exige dupla aprovação — RN-ACE-02)', tags: ['Cadastros'], permission: 'cadastros.conta_bancaria.criar', status: 201,
    params: idParams, body: bankAccountSchema,
  }, async ({ tx, params, body }) => addBankAccount(tx, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/parties/:id/refresh-registration', summary: 'Atualiza situação cadastral pela consulta pública (RN-CAD-04)', tags: ['Cadastros'], permission: 'cadastros.pessoa.editar', params: idParams,
  }, async ({ tx, params, deps }) => {
    const p = await tx.one<{ tax_id: string | null; kind: string }>(`SELECT tax_id, kind FROM registry.parties WHERE id = $1`, [params.id], 'Pessoa');
    if (p.kind !== 'PJ' || !p.tax_id) throw validation({ taxId: 'Consulta disponível apenas para CNPJ' });
    const info = await deps.services.lookups.cnpj(p.tax_id);
    if (!info) throw new AppError('NOT_FOUND', 'CNPJ não encontrado na base pública', 404);
    await tx.exec(`UPDATE registry.parties SET registration_status = $2, registration_checked_at = now() WHERE id = $1`, [params.id, info.registrationStatus]);
    return { registrationStatus: info.registrationStatus };
  });

  route(app, { method: 'GET', url: '/v1/parties/:id/lgpd-export', summary: 'Exporta dados pessoais do titular (RN-ACE-04)', tags: ['LGPD'], permission: 'cadastros.pessoa.editar', params: idParams, writes: true },
    async ({ tx, params }) => lgpdExport(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/parties/:id/anonymize', summary: 'Anonimiza dados pessoais a pedido do titular (RN-ACE-04)', tags: ['LGPD'], permission: 'cadastros.pessoa.inativar', params: idParams,
    body: z.object({ reason: z.string() }),
  }, async ({ tx, params, body }) => lgpdAnonymize(tx, params.id, body.reason));

  // ---------------------------------------------------------------- tabelas auxiliares
  const auxWrite = 'cadastros.tabela.editar';

  route(app, { method: 'GET', url: '/v1/payment-terms', summary: 'Condições de pagamento', tags: ['Tabelas auxiliares'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM registry.payment_terms WHERE active ORDER BY code`));

  const termBody = z.object({
    code: z.string().min(1), name: z.string().min(2),
    installments: z.array(z.object({ days: z.number().int().min(0), percent: decimal({ positive: true }) })).min(1),
    downPaymentPercent: decimal({ min: 0 }).default('0'), interestPercentMonth: decimal({ min: 0 }).default('0'),
    fixedDueDay: z.number().int().min(1).max(31).nullish(), isCash: z.boolean().default(false),
  }).superRefine((v, ctx) => {
    const total = v.installments.reduce((a, i) => a + Number(i.percent), Number(v.downPaymentPercent));
    if (Math.abs(total - 100) > 0.0001) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Entrada + parcelas devem somar 100%', path: ['installments'] });
  });
  route(app, { method: 'POST', url: '/v1/payment-terms', summary: 'Cria condição de pagamento (ex.: 30/60/90)', tags: ['Tabelas auxiliares'], permission: auxWrite, status: 201, body: termBody },
    async ({ tx, body }) => tx.one(
      `INSERT INTO registry.payment_terms (tenant_id, code, name, installments, down_payment_percent, interest_percent_month, fixed_due_day, is_cash, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [tx.tenantId, body.code, body.name, JSON.stringify(body.installments), body.downPaymentPercent, body.interestPercentMonth, body.fixedDueDay ?? null, body.isCash, tx.userId]));

  route(app, { method: 'GET', url: '/v1/payment-methods', summary: 'Formas de pagamento', tags: ['Tabelas auxiliares'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM registry.payment_methods WHERE active ORDER BY code`));

  route(app, {
    method: 'POST', url: '/v1/payment-methods', summary: 'Cria forma de pagamento', tags: ['Tabelas auxiliares'], permission: auxWrite, status: 201,
    body: z.object({
      code: z.string(), name: z.string(), kind: z.enum(['cash', 'pix', 'boleto', 'credit_card', 'debit_card', 'transfer', 'store_credit', 'check', 'other']),
      nfeTpag: z.string().regex(/^\d{2}$/), financialAccountId: z.string().uuid().nullish(), acquirerPartyId: z.string().uuid().nullish(),
      feePercent: decimal({ min: 0 }).default('0'), settlementDays: z.number().int().min(0).default(0),
    }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO registry.payment_methods (tenant_id, code, name, kind, nfe_tpag, financial_account_id, acquirer_party_id, fee_percent, settlement_days, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tx.tenantId, body.code, body.name, body.kind, body.nfeTpag, body.financialAccountId ?? null, body.acquirerPartyId ?? null, body.feePercent, body.settlementDays, tx.userId]));

  route(app, {
    method: 'PATCH', url: '/v1/payment-methods/:id', summary: 'Altera taxa/prazo/conta da forma de pagamento', tags: ['Tabelas auxiliares'], permission: auxWrite, params: idParams,
    body: z.object({ financialAccountId: z.string().uuid().nullish(), acquirerPartyId: z.string().uuid().nullish(), feePercent: decimal({ min: 0 }).optional(), settlementDays: z.number().int().min(0).optional(), active: z.boolean().optional() }),
  }, async ({ tx, params, body }) => tx.one(
    `UPDATE registry.payment_methods SET financial_account_id = coalesce($2, financial_account_id), acquirer_party_id = coalesce($3, acquirer_party_id),
            fee_percent = coalesce($4, fee_percent), settlement_days = coalesce($5, settlement_days), active = coalesce($6, active) WHERE id = $1 RETURNING *`,
    [params.id, body.financialAccountId ?? null, body.acquirerPartyId ?? null, body.feePercent ?? null, body.settlementDays ?? null, body.active ?? null], 'Forma de pagamento'));

  route(app, { method: 'GET', url: '/v1/financial-accounts', summary: 'Contas financeiras (bancos, caixas, carteiras, cartões)', tags: ['Tabelas auxiliares'], permission: null }, async ({ tx, ctx }) =>
    tx.query(`SELECT * FROM finance.accounts WHERE ($1::uuid IS NULL OR company_id = $1) ORDER BY code`, [ctx.companyId]));

  route(app, {
    method: 'POST', url: '/v1/financial-accounts', summary: 'Cria conta financeira', tags: ['Tabelas auxiliares'], permission: 'financeiro.conta.editar', status: 201, company: true,
    body: z.object({
      code: z.string(), name: z.string(), kind: z.enum(['bank', 'cash', 'wallet', 'corporate_card', 'acquirer', 'investment']), establishmentId: z.string().uuid().nullish(),
      bankCode: z.string().regex(/^\d{3}$/).nullish(), branch: z.string().nullish(), accountNumber: z.string().nullish(), pixKey: z.string().nullish(),
      initialBalance: decimal().default('0'), initialBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ledgerAccountId: z.string().uuid().nullish(),
    }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO finance.accounts (tenant_id, company_id, establishment_id, code, name, kind, bank_code, branch, account_number, pix_key, initial_balance, initial_balance_date, ledger_account_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12::date, current_date),$13,$14) RETURNING *`,
    [tx.tenantId, tx.companyId, body.establishmentId ?? null, body.code, body.name, body.kind, body.bankCode ?? null, body.branch ?? null, body.accountNumber ?? null,
      body.pixKey ?? null, body.initialBalance, body.initialBalanceDate ?? null, body.ledgerAccountId ?? null, tx.userId]));

  route(app, { method: 'GET', url: '/v1/categories', summary: 'Plano gerencial (categorias de DRE)', tags: ['Tabelas auxiliares'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM finance.categories WHERE active ORDER BY code`));

  route(app, {
    method: 'POST', url: '/v1/categories', summary: 'Cria categoria gerencial', tags: ['Tabelas auxiliares'], permission: auxWrite, status: 201,
    body: z.object({ code: z.string(), name: z.string(), parentId: z.string().uuid().nullish(),
      kind: z.enum(['revenue', 'deduction', 'cost', 'expense', 'financial_revenue', 'financial_expense', 'tax_on_profit', 'investment', 'financing', 'transfer']),
      dreGroup: z.string(), ledgerAccountId: z.string().uuid().nullish() }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO finance.categories (tenant_id, code, name, parent_id, kind, dre_group, ledger_account_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tx.tenantId, body.code, body.name, body.parentId ?? null, body.kind, body.dreGroup, body.ledgerAccountId ?? null, tx.userId]));

  route(app, { method: 'GET', url: '/v1/cost-centers', summary: 'Centros de custo (hierárquicos)', tags: ['Tabelas auxiliares'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM finance.cost_centers WHERE active ORDER BY code`));

  route(app, {
    method: 'POST', url: '/v1/cost-centers', summary: 'Cria centro de custo', tags: ['Tabelas auxiliares'], permission: auxWrite, status: 201,
    body: z.object({ code: z.string(), name: z.string(), parentId: z.string().uuid().nullish() }),
  }, async ({ tx, body }) => tx.one(`INSERT INTO finance.cost_centers (tenant_id, code, name, parent_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tx.tenantId, body.code, body.name, body.parentId ?? null, tx.userId]));

  route(app, { method: 'GET', url: '/v1/projects', summary: 'Projetos', tags: ['Tabelas auxiliares'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM finance.projects WHERE active ORDER BY code`));

  route(app, {
    method: 'POST', url: '/v1/projects', summary: 'Cria projeto', tags: ['Tabelas auxiliares'], permission: auxWrite, status: 201,
    body: z.object({ code: z.string(), name: z.string() }),
  }, async ({ tx, body }) => tx.one(`INSERT INTO finance.projects (tenant_id, code, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *`, [tx.tenantId, body.code, body.name, tx.userId]));

  route(app, { method: 'GET', url: '/v1/chart-of-accounts', summary: 'Plano de contas contábil', tags: ['Tabelas auxiliares'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM accounting.chart_of_accounts ORDER BY code`));

  route(app, {
    method: 'POST', url: '/v1/chart-of-accounts', summary: 'Cria conta contábil (vinculada ao referencial — RN-CTB-03)', tags: ['Tabelas auxiliares'], permission: 'contabil.lancamento.criar', status: 201,
    body: z.object({ code: z.string(), name: z.string(), parentId: z.string().uuid().nullish(), nature: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense', 'result']),
      balanceSide: z.enum(['D', 'C']), isAnalytic: z.boolean().default(true), acceptsManual: z.boolean().default(false), referentialCode: z.string().min(1) }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO accounting.chart_of_accounts (tenant_id, code, name, parent_id, nature, balance_side, is_analytic, accepts_manual, referential_code, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [tx.tenantId, body.code, body.name, body.parentId ?? null, body.nature, body.balanceSide, body.isAnalytic, body.acceptsManual, body.referentialCode, tx.userId]));

  route(app, { method: 'GET', url: '/v1/operation-types', summary: 'Naturezas / tipos de operação', tags: ['Tabelas auxiliares'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM fiscal.operation_types WHERE active ORDER BY code`));

  route(app, {
    method: 'POST', url: '/v1/operation-types', summary: 'Cria tipo de operação (define o que movimenta: estoque, financeiro, fiscal)', tags: ['Tabelas auxiliares'], permission: 'fiscal.regra.editar', status: 201,
    body: z.object({
      code: z.string(), name: z.string(), direction: z.enum(['S', 'E']), purpose: z.string(), nfePurpose: z.number().int().min(1).max(4).default(1),
      movesStock: z.boolean(), stockTarget: z.enum(['own', 'third_party_with_us', 'ours_with_third_party', 'none']).default('own'),
      generatesFinancial: z.boolean(), generatesFiscal: z.boolean(), generatesCommission: z.boolean().default(false), fiscalModel: z.string().default('55'),
      cfopInternal: z.string().regex(/^\d{4}$/).nullish(), cfopInterstate: z.string().regex(/^\d{4}$/).nullish(), cfopForeign: z.string().regex(/^\d{4}$/).nullish(),
      categoryId: z.string().uuid().nullish(),
    }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO fiscal.operation_types (tenant_id, code, name, direction, purpose, nfe_purpose, moves_stock, stock_target, generates_financial, generates_fiscal,
       generates_commission, fiscal_model, cfop_internal, cfop_interstate, cfop_foreign, category_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [tx.tenantId, body.code, body.name, body.direction, body.purpose, body.nfePurpose, body.movesStock, body.stockTarget, body.generatesFinancial, body.generatesFiscal,
      body.generatesCommission, body.fiscalModel, body.cfopInternal ?? null, body.cfopInterstate ?? null, body.cfopForeign ?? null, body.categoryId ?? null, tx.userId]));

  // ---------------------------------------------------------------- tabelas oficiais (somente leitura)
  const official = (url: string, table: string, cols: string, searchCols: string[], order: string) =>
    route(app, {
      method: 'GET', url, summary: `Tabela oficial ${table}`, tags: ['Tabelas oficiais'], permission: null,
      query: z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }),
    }, async ({ tx, query }) => {
      const where = query.q ? `WHERE ${searchCols.map((c) => `${c}::text ILIKE '%' || $1 || '%'`).join(' OR ')}` : 'WHERE $1::text IS NULL';
      return tx.query(`SELECT ${cols} FROM ${table} ${where} ORDER BY ${order} LIMIT $2`, [query.q ?? null, query.limit]);
    });
  official('/v1/official/ncm', 'fiscal.ncm', '*', ['code', 'description'], 'code');
  official('/v1/official/cest', 'fiscal.cest', '*', ['code', 'description'], 'code');
  official('/v1/official/cfop', 'fiscal.cfop', '*', ['code', 'description'], 'code');
  official('/v1/official/cclasstrib', 'fiscal.cclasstrib', '*', ['code', 'cst', 'description'], 'code');
  official('/v1/official/cities', 'fiscal.ibge_cities', '*', ['code', 'name', 'uf'], 'uf, name');
  official('/v1/official/countries', 'fiscal.countries', '*', ['bacen_code', 'name'], 'name');
  official('/v1/official/units', 'fiscal.units', '*', ['code', 'description'], 'code');
  official('/v1/official/service-codes', 'fiscal.service_codes', '*', ['code', 'description'], 'code');
  official('/v1/official/nbs', 'fiscal.nbs', '*', ['code', 'description'], 'code');
}
