import { z } from 'zod';
import { findConflicts, type TaxRule } from '@vortex/fiscal-engine';
import { D, HUNDRED } from '@vortex/money';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate } from '../../http/schemas.js';
import { AppError, conflict } from '../../errors.js';
import { auditAction } from '../../core/audit.js';
import type { Tx } from '../../db/tx.js';
import { calculateOperation, loadRules, rowToRule, ruleResultSchema, type TaxRuleRow } from './engine-adapter.js';
import { regimeAt } from '../org/service.js';
import { taxAssessment } from './assessment.js';

const ruleKeysSchema = z.object({
  establishmentId: z.string().uuid().nullish(),
  operationTypeCode: z.string().nullish(),
  direction: z.enum(['S', 'E']).nullish(),
  ufOrigin: z.string().length(2).nullish(),
  ufDest: z.string().min(2).max(2).nullish(),
  ncmPrefix: z.string().regex(/^\d{2,8}$/).nullish(),
  cest: z.string().regex(/^\d{7}$/).nullish(),
  taxGroup: z.string().nullish(),
  productId: z.string().uuid().nullish(),
  recipientIeIndicator: z.union([z.literal(1), z.literal(2), z.literal(9)]).nullish(),
  recipientFinalConsumer: z.boolean().nullish(),
  recipientRegime: z.enum(['simples_nacional', 'mei', 'normal']).nullish(),
  issuerRegime: z.enum(['simples_nacional', 'simples_excesso_sublimite', 'mei', 'lucro_presumido', 'lucro_real']).nullish(),
  origin: z.number().int().min(0).max(8).nullish(),
  itemKind: z.enum(['goods', 'service']).nullish(),
});

const ruleBody = ruleKeysSchema.extend({
  name: z.string().min(3),
  notes: z.string().nullish(),
  validFrom: isoDate,
  validTo: isoDate.nullish(),
  result: ruleResultSchema,
});

function candidateRule(id: string, b: z.infer<typeof ruleBody>): TaxRule {
  return rowToRule({
    id, name: b.name, valid_from: b.validFrom, valid_to: b.validTo ?? null, operation_type_code: b.operationTypeCode ?? null, direction: b.direction ?? null,
    uf_origin: b.ufOrigin ?? null, uf_dest: b.ufDest ?? null, ncm_prefix: b.ncmPrefix ?? null, cest: b.cest ?? null, tax_group: b.taxGroup ?? null,
    product_id: b.productId ?? null, recipient_ie_indicator: b.recipientIeIndicator ?? null, recipient_final_consumer: b.recipientFinalConsumer ?? null,
    recipient_regime: b.recipientRegime ?? null, issuer_regime: b.issuerRegime ?? null, origin: b.origin ?? null, item_kind: b.itemKind ?? null,
    result: b.result as TaxRule['result'], establishment_id: b.establishmentId ?? null,
  });
}

/** RN-FIS-01: empate entre regras igualmente específicas bloqueia o salvamento. */
async function assertNoConflict(tx: Tx, id: string, b: z.infer<typeof ruleBody>) {
  const existing = (await loadRules(tx, b.establishmentId ?? null)).filter((r) => r.id !== id);
  const conflicts = findConflicts(candidateRule(id, b), existing);
  if (conflicts.length) {
    throw conflict('RULE_CONFLICT', `Regra igualmente específica a "${conflicts[0]!.ruleName}" para ${conflicts[0]!.groups.join(', ')}: ajuste as chaves ou a vigência`, { rule: 'RN-FIS-01', conflicts });
  }
}

const insertCols = `establishment_id, name, notes, valid_from, valid_to, operation_type_code, direction, uf_origin, uf_dest, ncm_prefix, cest, tax_group, product_id,
  recipient_ie_indicator, recipient_final_consumer, recipient_regime, issuer_regime, origin, item_kind, result`;
const vals = (b: z.infer<typeof ruleBody>) => [b.establishmentId ?? null, b.name, b.notes ?? null, b.validFrom, b.validTo ?? null, b.operationTypeCode ?? null, b.direction ?? null,
  b.ufOrigin ?? null, b.ufDest ?? null, b.ncmPrefix ?? null, b.cest ?? null, b.taxGroup ?? null, b.productId ?? null, b.recipientIeIndicator ?? null,
  b.recipientFinalConsumer ?? null, b.recipientRegime ?? null, b.issuerRegime ?? null, b.origin ?? null, b.itemKind ?? null, JSON.stringify(b.result)];

export async function insertRule(tx: Tx, b: z.infer<typeof ruleBody>) {
  await assertNoConflict(tx, '00000000-0000-0000-0000-000000000000', b);
  return tx.one(`INSERT INTO fiscal.tax_rules (tenant_id, ${insertCols}, created_by) VALUES ($1,${vals(b).map((_, i) => `$${i + 2}`).join(',')},$${vals(b).length + 2}) RETURNING *`,
    [tx.tenantId, ...vals(b), tx.userId]);
}

const opItem = z.object({
  id: z.string().default(() => Math.random().toString(36).slice(2, 8)), productId: z.string().uuid(), quantity: decimal({ positive: true }), unitPrice: decimal({ min: 0 }),
  discount: decimal({ min: 0 }).optional(), freight: decimal({ min: 0 }).optional(), insurance: decimal({ min: 0 }).optional(), otherExpenses: decimal({ min: 0 }).optional(),
  forUseOrConsumption: z.boolean().optional(),
});
export const simulateBody = z.object({
  establishmentId: z.string().uuid(), operationTypeCode: z.string().default('VENDA'), date: isoDate.optional(), partyId: z.string().uuid().nullish(),
  recipient: z.object({ uf: z.string().length(2), cityIbge: z.string().nullish(), ieIndicator: z.union([z.literal(1), z.literal(2), z.literal(9)]), finalConsumer: z.boolean() }).optional(),
  presential: z.boolean().optional(),
  header: z.object({ freight: decimal({ min: 0 }).optional(), insurance: decimal({ min: 0 }).optional(), otherExpenses: decimal({ min: 0 }).optional(), discount: decimal({ min: 0 }).optional() }).optional(),
  items: z.array(opItem).min(1),
});

export function registerFiscalRoutes(app: App) {
  route(app, {
    method: 'GET', url: '/v1/tax-rules', summary: 'Matriz de regras fiscais', tags: ['Fiscal'], permission: 'fiscal.regra.ler',
    query: z.object({ active: z.coerce.boolean().default(true) }),
  }, async ({ tx, query }) => tx.query(`SELECT * FROM fiscal.tax_rules WHERE active = $1 ORDER BY name`, [query.active]));

  route(app, { method: 'POST', url: '/v1/tax-rules', summary: 'Cria regra fiscal com vigência (bloqueia empate — RN-FIS-01)', tags: ['Fiscal'], permission: 'fiscal.regra.editar', status: 201, body: ruleBody },
    async ({ tx, body }) => insertRule(tx, body));

  route(app, {
    method: 'PUT', url: '/v1/tax-rules/:id', summary: 'Altera regra fiscal (perde a validação do contador)', tags: ['Fiscal'], permission: 'fiscal.regra.editar', params: idParams,
    body: ruleBody.extend({ version: z.number().int() }),
  }, async ({ tx, params, body }) => {
    await assertNoConflict(tx, params.id, body);
    const v = vals(body);
    const sets = insertCols.split(',').map((c, i) => `${c.trim()} = $${i + 3}`).join(', ');
    const row = await tx.maybeOne(`UPDATE fiscal.tax_rules SET ${sets}, validated_by_accountant = false, validated_by = NULL, validated_at = NULL WHERE id = $1 AND version = $2 RETURNING *`,
      [params.id, body.version, ...v]);
    if (!row) throw conflict('VERSION_CONFLICT', 'Regra alterada por outra pessoa ou inexistente');
    return row;
  });

  route(app, { method: 'POST', url: '/v1/tax-rules/:id/deactivate', summary: 'Desativa regra fiscal', tags: ['Fiscal'], permission: 'fiscal.regra.editar', params: idParams },
    async ({ tx, params }) => tx.one(`UPDATE fiscal.tax_rules SET active = false WHERE id = $1 RETURNING *`, [params.id], 'Regra fiscal'));

  route(app, {
    method: 'POST', url: '/v1/tax-rules/:id/accountant-validation', summary: 'Contador valida a regra (parametrização inicial validada pelo contador)', tags: ['Fiscal'], permission: 'fiscal.regra.editar', params: idParams,
  }, async ({ tx, ctx, params }) => {
    if (!ctx.roles.includes('contador') && !ctx.roles.includes('administrador')) throw new AppError('FORBIDDEN', 'Somente o perfil contador valida regras fiscais', 403);
    const r = await tx.one(`UPDATE fiscal.tax_rules SET validated_by_accountant = true, validated_by = $2, validated_at = now() WHERE id = $1 RETURNING *`, [params.id, tx.userId], 'Regra fiscal');
    await auditAction(tx, { action: 'fiscal.regra.validada_contador', table: 'fiscal.tax_rules', recordId: params.id });
    return r;
  });

  route(app, {
    method: 'POST', url: '/v1/fiscal/simulate', summary: 'Calcula tributos de uma operação com memória de cálculo (RN-FIS-04)', tags: ['Fiscal'], permission: 'fiscal.regra.ler', body: simulateBody,
  }, async ({ tx, body }) => {
    const { built, result } = await calculateOperation(tx, { ...body, recipient: body.recipient as never, date: body.date ?? new Date().toISOString().slice(0, 10), items: body.items as never });
    return { regime: built.regime, issuerUf: built.input.issuer.uf, recipient: built.input.recipient, ...result };
  });

  route(app, {
    method: 'GET', url: '/v1/fiscal/assessment', summary: 'Apuração gerencial do período: débitos × créditos por tributo, ICMS por CFOP e UF, ST/DIFAL/FCP e evolução mensal',
    tags: ['Fiscal'], permission: 'fiscal.nota.ler', query: z.object({ from: isoDate, to: isoDate, establishmentId: z.string().uuid().optional() }),
  }, async ({ tx, ctx, query }) => taxAssessment(tx, ctx, { from: query.from, to: query.to, establishmentId: query.establishmentId ?? null }));

  // ------------------------------------------------------------ assistente de parametrização (seção 07, regra prática)
  route(app, {
    method: 'POST', url: '/v1/fiscal/wizard', summary: 'Gera as regras mais comuns a partir do regime e dos NCMs cadastrados (rascunho para o contador validar)', tags: ['Fiscal'], permission: 'fiscal.regra.editar',
    body: z.object({ establishmentId: z.string().uuid(), apply: z.boolean().default(false), validFrom: isoDate.optional() }),
  }, async ({ tx, body }) => {
    const est = await tx.one(`SELECT * FROM core.establishments WHERE id = $1`, [body.establishmentId], 'Estabelecimento');
    const validFrom = body.validFrom ?? new Date().toISOString().slice(0, 10);
    const regime = await regimeAt(tx, body.establishmentId, validFrom);
    const simples = ['simples_nacional', 'mei'].includes(regime);
    const drafts: z.infer<typeof ruleBody>[] = [];
    if (simples) {
      drafts.push({ name: `Simples ${est.uf}: venda sem ST (CSOSN 102)`, establishmentId: body.establishmentId, operationTypeCode: 'VENDA', validFrom, result: { icms: { csosn: '102' } } });
      drafts.push({ name: `Simples ${est.uf}: venda de mercadoria com ST retida anteriormente (CSOSN 500)`, establishmentId: body.establishmentId, operationTypeCode: 'VENDA_ST', validFrom, result: { icms: { csosn: '500' } } });
    } else {
      drafts.push({ name: `${regime} ${est.uf}: venda interna tributada (CST 00)`, establishmentId: body.establishmentId, operationTypeCode: 'VENDA', ufDest: est.uf, validFrom, result: { icms: { cst: '00' } } });
      drafts.push({ name: `${regime} ${est.uf}: venda de mercadoria com ST retida (CST 60)`, establishmentId: body.establishmentId, operationTypeCode: 'VENDA_ST', validFrom, result: { icms: { cst: '60' } } });
    }
    // NCMs com CEST: sinaliza produtos sujeitos a ST que precisam de MVA definido pelo contador
    const cestProducts = await tx.query<{ ncm: string; cest: string; n: number }>(
      `SELECT ncm, cest, count(*)::int AS n FROM catalog.products WHERE cest IS NOT NULL AND status = 'active' GROUP BY ncm, cest ORDER BY n DESC`);
    const pending = cestProducts.map((p) => ({ ncm: p.ncm, cest: p.cest, products: p.n, action: 'Definir MVA e alíquota de ST por UF de destino (protocolo/convênio)' }));
    const mono = await tx.query<{ ncm: string }>(`SELECT DISTINCT p.ncm FROM catalog.products p JOIN fiscal.ncm n ON n.code = p.ncm AND n.pis_cofins_monofasico WHERE p.status = 'active'`);
    let created: unknown[] = [];
    if (body.apply) {
      created = [];
      for (const d of drafts) {
        try {
          created.push(await insertRule(tx, d));
        } catch (e) {
          if (!(e instanceof AppError && e.code === 'RULE_CONFLICT')) throw e;
        }
      }
    }
    return {
      regime, drafts, created, pendingForAccountant: pending, monophasicNcms: mono.map((m) => m.ncm),
      notice: 'A responsabilidade pela tributação é do contribuinte: as regras geradas ficam como "não validadas" até o contador aprovar.',
    };
  });

  // ------------------------------------------------------------ simulador de impacto da reforma (RN-REF-07)
  route(app, {
    method: 'POST', url: '/v1/fiscal/reform-impact', summary: 'Carga tributária atual × projetada por produto e ano (RN-REF-07)', tags: ['Fiscal'], permission: 'fiscal.regra.ler',
    body: z.object({ establishmentId: z.string().uuid(), productIds: z.array(z.string().uuid()).min(1).max(200), operationTypeCode: z.string().default('VENDA'),
      recipient: z.object({ uf: z.string().length(2), ieIndicator: z.union([z.literal(1), z.literal(2), z.literal(9)]).default(9), finalConsumer: z.boolean().default(true) }).optional(),
      years: z.array(z.number().int().min(2026).max(2035)).default([2026, 2027, 2029, 2031, 2033]) }),
  }, async ({ tx, body }) => {
    const prices = await tx.query<{ product_id: string; price: string; sku: string; description: string }>(
      `SELECT DISTINCT ON (p.id) p.id AS product_id, coalesce(i.price, p.last_purchase_cost, 0) AS price, p.sku, p.description
         FROM catalog.products p LEFT JOIN catalog.price_list_items i ON i.product_id = p.id LEFT JOIN catalog.price_lists l ON l.id = i.price_list_id AND l.is_default
        WHERE p.id = ANY($1) ORDER BY p.id, l.is_default DESC NULLS LAST`, [body.productIds]);
    const rows = [];
    for (const p of prices) {
      const price = D(p.price).greaterThan(0) ? D(p.price).toFixed(2) : '100.00';
      const perYear: Record<number, { taxes: string; loadPercent: string; breakdown: Record<string, string> }> = {};
      for (const year of body.years) {
        const { result } = await calculateOperation(tx, {
          establishmentId: body.establishmentId, operationTypeCode: body.operationTypeCode, date: `${year}-07-01`,
          recipient: body.recipient ? { ...body.recipient, uf: body.recipient.uf as never } : undefined,
          items: [{ id: 'x', productId: p.product_id, quantity: '1', unitPrice: price }],
        });
        const t = result.totals;
        const parts: Record<string, string> = { icms: t.icms, st: t.st, fcp: t.fcp, difal: t.difal, ipi: t.ipi, pis: t.pis, cofins: t.cofins, iss: t.iss, cbs: t.cbs, ibs: t.ibs, is: t.is };
        const informative = result.items[0]?.taxes.ibsCbs?.informative;
        const total = Object.entries(parts).reduce((a, [k, v]) => (informative && (k === 'cbs' || k === 'ibs') ? a : a.plus(v)), D(0));
        perYear[year] = { taxes: total.toFixed(2), loadPercent: total.dividedBy(price).times(HUNDRED).toFixed(2), breakdown: parts };
      }
      rows.push({ productId: p.product_id, sku: p.sku, description: p.description, price, years: perYear });
    }
    return { rows, notice: 'Alíquotas de IBS/CBS a partir de 2027 são de referência até a fixação oficial; confirme com o contador.' };
  });

  route(app, { method: 'GET', url: '/v1/fiscal/tables/transition', summary: 'Cronograma da transição 2026–2033', tags: ['Fiscal'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM fiscal.tax_transition ORDER BY year`));
  route(app, { method: 'GET', url: '/v1/fiscal/tables/ibs-cbs-rates', summary: 'Alíquotas de IBS/CBS por vigência', tags: ['Fiscal'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM fiscal.ibs_cbs_rates ORDER BY valid_from, uf NULLS FIRST, city_ibge NULLS FIRST`));
  route(app, { method: 'GET', url: '/v1/fiscal/tables/icms-rates', summary: 'Alíquotas internas de ICMS por UF', tags: ['Fiscal'], permission: null }, async ({ tx }) =>
    tx.query(`SELECT * FROM fiscal.icms_internal_rates ORDER BY uf, valid_from DESC`));
}
