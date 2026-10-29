import { z } from 'zod';
import { emit } from '../../core/outbox.js';
import { D, markupDivisorPrice } from '@vortex/money';
import { route, type App } from '../../http/app.js';
import { decimal, decodeCursor, idParams, isoDate, page } from '../../http/schemas.js';
import { validation } from '../../errors.js';
import { createProduct, createVariant, getProduct, kitSchema, productPatchSchema, productSchema, setKitItems, updateProduct, variantSchema } from './products.js';
import { checkMargin, currentCost, priceWithAndWithoutNewTaxes, quotePrice, setPrice } from './pricing.js';
import { promotionRuleSchema } from './pricing-core.js';

export function registerCatalogRoutes(app: App) {
  route(app, { method: 'GET', url: '/v1/product-categories', summary: 'Categorias de produto (hierárquicas)', tags: ['Produtos'], permission: 'produtos.produto.ler' }, async ({ tx }) =>
    tx.query(`SELECT * FROM catalog.categories WHERE active ORDER BY code`));

  route(app, {
    method: 'POST', url: '/v1/product-categories', summary: 'Cria categoria de produto', tags: ['Produtos'], permission: 'produtos.produto.criar', status: 201,
    body: z.object({ code: z.string(), name: z.string(), parentId: z.string().uuid().nullish(), minMarginPercent: decimal().nullish() }),
  }, async ({ tx, body }) => tx.one(
    `INSERT INTO catalog.categories (tenant_id, code, name, parent_id, min_margin_percent, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tx.tenantId, body.code, body.name, body.parentId ?? null, body.minMarginPercent ?? null, tx.userId]));

  route(app, {
    method: 'POST', url: '/v1/brands', summary: 'Cria marca', tags: ['Produtos'], permission: 'produtos.produto.criar', status: 201, body: z.object({ name: z.string().min(1) }),
  }, async ({ tx, body }) => tx.one(`INSERT INTO catalog.brands (tenant_id, name, created_by) VALUES ($1,$2,$3) RETURNING *`, [tx.tenantId, body.name, tx.userId]));

  route(app, { method: 'GET', url: '/v1/brands', summary: 'Marcas', tags: ['Produtos'], permission: 'produtos.produto.ler' }, async ({ tx }) =>
    tx.query(`SELECT * FROM catalog.brands ORDER BY name`));

  route(app, {
    method: 'GET', url: '/v1/products', summary: 'Busca produtos (SKU, descrição, GTIN)', tags: ['Produtos'], permission: 'produtos.produto.ler',
    query: z.object({ q: z.string().optional(), categoryId: z.string().uuid().optional(), kind: z.string().optional(), status: z.enum(['active', 'inactive']).default('active'),
      includeVariants: z.coerce.boolean().default(true), limit: z.coerce.number().int().min(1).max(500).default(50), cursor: z.string().optional() }),
  }, async ({ tx, ctx, query }) => {
    const c = decodeCursor(query.cursor);
    const rows = await tx.query(
      `SELECT p.id, p.sku, p.description, p.short_description, p.gtin, p.kind, p.ncm, p.cest, p.stock_unit, p.sale_unit, p.status, p.parent_id, p.is_variant_parent,
              p.variant_attributes, p.category_id, p.last_purchase_cost, p.created_at
         FROM catalog.products p
        WHERE p.status = $1 AND ($2::uuid IS NULL OR p.company_id IS NULL OR p.company_id = $2)
          AND ($3::text IS NULL OR p.sku ILIKE $3 || '%' OR p.gtin = $3 OR p.description ILIKE '%' || $3 || '%')
          AND ($4::uuid IS NULL OR p.category_id = $4) AND ($5::text IS NULL OR p.kind = $5) AND ($6 OR p.parent_id IS NULL)
          AND ($7::timestamptz IS NULL OR (p.created_at, p.id) < ($7, $8::uuid))
        ORDER BY p.created_at DESC, p.id DESC LIMIT $9`,
      [query.status, ctx.companyId, query.q?.trim() || null, query.categoryId ?? null, query.kind ?? null, query.includeVariants, c?.at ?? null, c?.id ?? null, query.limit + 1]);
    return page(rows, query.limit);
  });

  route(app, { method: 'POST', url: '/v1/products', summary: 'Cadastra produto ou serviço', tags: ['Produtos'], permission: 'produtos.produto.criar', status: 201, body: productSchema },
    async ({ tx, body }) => createProduct(tx, body));

  route(app, { method: 'GET', url: '/v1/products/:id', summary: 'Detalhe do produto', tags: ['Produtos'], permission: 'produtos.produto.ler', params: idParams },
    async ({ tx, params }) => getProduct(tx, params.id));

  route(app, { method: 'PATCH', url: '/v1/products/:id', summary: 'Altera produto (version)', tags: ['Produtos'], permission: 'produtos.produto.editar', params: idParams, body: productPatchSchema },
    async ({ tx, params, body }) => updateProduct(tx, params.id, body));

  route(app, { method: 'POST', url: '/v1/products/:id/variants', summary: 'Cria variação de grade (herda fiscal e preço do pai)', tags: ['Produtos'], permission: 'produtos.produto.criar', status: 201, params: idParams, body: variantSchema },
    async ({ tx, params, body }) => createVariant(tx, params.id, body));

  route(app, { method: 'PUT', url: '/v1/products/:id/kit-items', summary: 'Define componentes do kit e rateio do preço', tags: ['Produtos'], permission: 'produtos.produto.editar', params: idParams, body: kitSchema },
    async ({ tx, params, body }) => setKitItems(tx, params.id, body));

  route(app, {
    method: 'PUT', url: '/v1/products/:id/conversions', summary: 'Conversões de unidade (ex.: CX = 12 UN)', tags: ['Produtos'], permission: 'produtos.produto.editar', params: idParams,
    body: z.object({ conversions: z.array(z.object({ unit: z.string().min(1), factor: decimal({ positive: true }), purpose: z.enum(['purchase', 'sale', 'both']).default('both'), gtin: z.string().nullish() })) }),
  }, async ({ tx, params, body }) => {
    const p = await tx.one<{ stock_unit: string }>(`SELECT stock_unit FROM catalog.products WHERE id = $1`, [params.id], 'Produto');
    if (body.conversions.some((c) => c.unit === p.stock_unit)) throw validation({ conversions: 'A unidade de estoque não precisa de conversão' });
    await tx.exec(`DELETE FROM catalog.unit_conversions WHERE product_id = $1`, [params.id]);
    for (const c of body.conversions) {
      await tx.exec(`INSERT INTO catalog.unit_conversions (tenant_id, product_id, unit, factor, purpose, gtin) VALUES ($1,$2,$3,$4,$5,$6)`,
        [tx.tenantId, params.id, c.unit, c.factor, c.purpose, c.gtin ?? null]);
    }
    return tx.query(`SELECT * FROM catalog.unit_conversions WHERE product_id = $1`, [params.id]);
  });

  route(app, {
    method: 'POST', url: '/v1/products/:id/suppliers', summary: 'Vincula fornecedor (de-para de código e unidade)', tags: ['Produtos'], permission: 'produtos.produto.editar', status: 201, params: idParams,
    body: z.object({ supplierId: z.string().uuid(), supplierCode: z.string().min(1), supplierUnit: z.string().nullish(), factor: decimal({ positive: true }).default('1'),
      supplierGtin: z.string().nullish(), leadTimeDays: z.number().int().min(0).nullish(), minLot: decimal({ min: 0 }).nullish() }),
  }, async ({ tx, params, body }) => tx.one(
    `INSERT INTO catalog.product_suppliers (tenant_id, product_id, supplier_id, supplier_code, supplier_unit, factor, supplier_gtin, lead_time_days, min_lot, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, supplier_id, supplier_code) DO UPDATE SET product_id = EXCLUDED.product_id, supplier_unit = EXCLUDED.supplier_unit, factor = EXCLUDED.factor,
       lead_time_days = EXCLUDED.lead_time_days, min_lot = EXCLUDED.min_lot RETURNING *`,
    [tx.tenantId, params.id, body.supplierId, body.supplierCode, body.supplierUnit ?? null, body.factor, body.supplierGtin ?? null, body.leadTimeDays ?? null, body.minLot ?? null, tx.userId]));

  route(app, {
    method: 'PUT', url: '/v1/products/:id/stock-params', summary: 'Estoque mínimo, máximo e ponto de pedido por depósito', tags: ['Produtos'], permission: 'produtos.produto.editar', params: idParams,
    body: z.object({ warehouseId: z.string().uuid(), minQty: decimal({ min: 0 }), maxQty: decimal({ min: 0 }).nullish(), reorderPoint: decimal({ min: 0 }) }),
  }, async ({ tx, params, body }) => tx.one(
    `INSERT INTO catalog.stock_params (tenant_id, product_id, warehouse_id, min_qty, max_qty, reorder_point) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (product_id, warehouse_id) DO UPDATE SET min_qty = EXCLUDED.min_qty, max_qty = EXCLUDED.max_qty, reorder_point = EXCLUDED.reorder_point RETURNING *`,
    [tx.tenantId, params.id, body.warehouseId, body.minQty, body.maxQty ?? null, body.reorderPoint]));

  // ---------------------------------------------------------------- tabelas de preço
  route(app, { method: 'GET', url: '/v1/price-lists', summary: 'Tabelas de preço', tags: ['Preços'], permission: 'produtos.preco.ler' }, async ({ tx }) =>
    tx.query(`SELECT * FROM catalog.price_lists ORDER BY is_default DESC, code`));

  const priceListBody = z.object({
    code: z.string(), name: z.string(), validFrom: isoDate.optional(), validTo: isoDate.nullish(),
    channels: z.array(z.enum(['counter', 'pdv', 'ecommerce', 'wholesale', 'marketplace', 'whatsapp'])).default([]), establishmentIds: z.array(z.string().uuid()).default([]),
    segment: z.string().nullish(), customerId: z.string().uuid().nullish(), isDefault: z.boolean().default(false), includesIbsCbs: z.boolean().default(false),
  });
  route(app, { method: 'POST', url: '/v1/price-lists', summary: 'Cria tabela de preço (vigência, canais, estabelecimentos, segmento/cliente)', tags: ['Preços'], permission: 'produtos.preco.editar', status: 201, body: priceListBody },
    async ({ tx, body }) => tx.one(
      `INSERT INTO catalog.price_lists (tenant_id, code, name, valid_from, valid_to, channels, establishment_ids, segment, customer_id, is_default, includes_ibs_cbs, created_by)
       VALUES ($1,$2,$3,coalesce($4::date,'2000-01-01'),$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tx.tenantId, body.code, body.name, body.validFrom ?? null, body.validTo ?? null, body.channels, body.establishmentIds, body.segment ?? null, body.customerId ?? null,
        body.isDefault, body.includesIbsCbs, tx.userId]));

  route(app, { method: 'GET', url: '/v1/price-lists/:id/items', summary: 'Itens da tabela de preço', tags: ['Preços'], permission: 'produtos.preco.ler', params: idParams }, async ({ tx, params }) =>
    tx.query(`SELECT i.*, p.sku, p.description FROM catalog.price_list_items i JOIN catalog.products p ON p.id = i.product_id WHERE i.price_list_id = $1 ORDER BY p.sku, i.min_qty`, [params.id]));

  route(app, {
    method: 'PUT', url: '/v1/price-lists/:id/items', summary: 'Define preço do produto (imediato ou agendado — RN-PRE-04)', tags: ['Preços'], permission: 'produtos.preco.editar', params: idParams,
    body: z.object({ productId: z.string().uuid(), price: decimal({ min: 0 }), minQty: decimal({ min: 0 }).default('0'), effectiveAt: z.string().datetime({ offset: true }).nullish(), reason: z.string().nullish() }),
  }, async ({ tx, params, body }) => setPrice(tx, { priceListId: params.id, productId: body.productId, price: body.price, minQty: body.minQty, effectiveAt: body.effectiveAt, reason: body.reason }));

  route(app, {
    method: 'GET', url: '/v1/products/:id/price-history', summary: 'Histórico de preços (RN-PRE-04)', tags: ['Preços'], permission: 'produtos.preco.ler', params: idParams,
  }, async ({ tx, params }) => tx.query(
    `SELECT h.*, l.code AS price_list_code, u.name AS changed_by_name FROM catalog.price_history h JOIN catalog.price_lists l ON l.id = h.price_list_id
       LEFT JOIN core.users u ON u.id = h.changed_by WHERE h.product_id = $1 ORDER BY h.changed_at DESC`, [params.id]));

  route(app, { method: 'GET', url: '/v1/scheduled-price-changes', summary: 'Alterações de preço agendadas', tags: ['Preços'], permission: 'produtos.preco.ler' }, async ({ tx }) =>
    tx.query(`SELECT * FROM catalog.scheduled_price_changes WHERE status = 'pending' ORDER BY effective_at`));

  // ---------------------------------------------------------------- promoções
  route(app, { method: 'GET', url: '/v1/promotions', summary: 'Promoções', tags: ['Preços'], permission: 'produtos.preco.ler' }, async ({ tx }) =>
    tx.query(`SELECT * FROM catalog.promotions ORDER BY starts_at DESC`));

  route(app, {
    method: 'POST', url: '/v1/promotions', summary: 'Cria promoção (RN-PRE-02)', tags: ['Preços'], permission: 'produtos.preco.editar', status: 201,
    body: z.object({
      name: z.string(), startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), rule: promotionRuleSchema,
      productIds: z.array(z.string().uuid()).default([]), categoryIds: z.array(z.string().uuid()).default([]), channels: z.array(z.string()).default([]),
      establishmentIds: z.array(z.string().uuid()).default([]), maxQuantity: decimal({ positive: true }).nullish(), cumulative: z.boolean().default(false),
    }),
  }, async ({ tx, body }) => {
    if (new Date(body.endsAt) <= new Date(body.startsAt)) throw validation({ endsAt: 'Fim deve ser depois do início' });
    const promo = await tx.one<{ id: string }>(
      `INSERT INTO catalog.promotions (tenant_id, name, starts_at, ends_at, rule, product_ids, category_ids, channels, establishment_ids, max_quantity, cumulative, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [tx.tenantId, body.name, body.startsAt, body.endsAt, JSON.stringify(body.rule), body.productIds, body.categoryIds, body.channels, body.establishmentIds,
        body.maxQuantity ?? null, body.cumulative, tx.userId]);
    await emit(tx, 'promocao.alterada', { type: 'promotion', id: promo.id }, { id: promo.id, active: true });
    return promo;
  });

  route(app, { method: 'POST', url: '/v1/promotions/:id/deactivate', summary: 'Encerra promoção', tags: ['Preços'], permission: 'produtos.preco.editar', params: idParams },
    async ({ tx, params }) => {
      const promo = await tx.one(`UPDATE catalog.promotions SET active = false WHERE id = $1 RETURNING *`, [params.id], 'Promoção');
      await emit(tx, 'promocao.alterada', { type: 'promotion', id: params.id }, { id: params.id, active: false });
      return promo;
    });

  // ---------------------------------------------------------------- formação de preço
  route(app, {
    method: 'GET', url: '/v1/pricing/quote', summary: 'Preço vigente para cliente/canal/quantidade (RN-PRE-01/02)', tags: ['Preços'], permission: 'produtos.preco.ler',
    query: z.object({ productId: z.string().uuid(), customerId: z.string().uuid().optional(), channel: z.string().optional(), establishmentId: z.string().uuid().optional(), qty: decimal({ positive: true }).default('1') }),
  }, async ({ tx, query }) => {
    const quote = await quotePrice(tx, query);
    const margin = await checkMargin(tx, query.establishmentId ?? null, query.productId, quote.unitPrice);
    return { ...quote, margin, newTaxes: await priceWithAndWithoutNewTaxes(tx, quote, query.establishmentId ?? null) };
  });

  route(app, {
    method: 'POST', url: '/v1/pricing/suggest', summary: 'Preço sugerido por markup divisor (seção 06)', tags: ['Preços'], permission: 'produtos.preco.ler',
    body: z.object({
      productId: z.string().uuid().optional(), establishmentId: z.string().uuid().optional(), cost: decimal({ min: 0 }).optional(),
      taxesPercent: decimal({ min: 0 }).default('0'), commissionPercent: decimal({ min: 0 }).default('0'), cardFeePercent: decimal({ min: 0 }).default('0'),
      fixedExpensesPercent: decimal({ min: 0 }).default('0'), marginPercent: decimal({ min: 0 }).default('0'),
    }),
  }, async ({ tx, body }) => {
    const cost = body.cost ? D(body.cost) : body.productId ? await currentCost(tx, body.establishmentId ?? null, body.productId) : null;
    if (!cost) throw validation({ cost: 'Informe o custo ou o produto' });
    const price = markupDivisorPrice(cost, { taxes: body.taxesPercent, commission: body.commissionPercent, cardFee: body.cardFeePercent, fixedExpenses: body.fixedExpensesPercent, margin: body.marginPercent });
    return { cost: cost.toString(), suggestedPrice: price.toFixed(2), divisor: D(1).minus(D(body.taxesPercent).plus(body.commissionPercent).plus(body.cardFeePercent).plus(body.fixedExpensesPercent).plus(body.marginPercent).dividedBy(100)).toString() };
  });
}
