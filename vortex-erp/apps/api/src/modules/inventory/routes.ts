import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, decodeCursor, idParams, isoDate, page } from '../../http/schemas.js';
import { listMovements, movementTotals } from './history.js';
import { assertWarehouseScope, requirePerm } from '../../core/access.js';
import { requireReason } from '../../core/audit.js';
import { notFound, validation } from '../../errors.js';
import { allocateFefo, getOrCreateLot, reverseMovement } from './stock.js';
import { abcCurve, approveInventory, countItem, createManualMovement, inventoryReport, openInventory, reviewInventory, transferBetweenWarehouses } from './counting.js';

export function registerInventoryRoutes(app: App) {
  route(app, {
    method: 'GET', url: '/v1/stock/balances', summary: 'Saldos por estabelecimento/depósito/produto/lote (disponível = físico − reservado − bloqueado)', tags: ['Estoque'], permission: 'estoque.saldo.ler',
    query: z.object({ productId: z.string().uuid().optional(), warehouseId: z.string().uuid().optional(), establishmentId: z.string().uuid().optional(), onlyPositive: z.coerce.boolean().default(false) }),
  }, async ({ tx, ctx, query }) => {
    if (query.warehouseId) assertWarehouseScope(ctx, query.warehouseId);
    const rows = await tx.query(
      `SELECT b.*, (b.quantity - b.reserved - b.blocked) AS available, p.sku, p.description, p.stock_unit, w.code AS warehouse_code, l.lot_number, l.expires_at,
              pc.avg_cost, round(b.quantity * coalesce(pc.avg_cost, 0), 2) AS value
         FROM inventory.stock_balances b JOIN catalog.products p ON p.id = b.product_id JOIN core.warehouses w ON w.id = b.warehouse_id
         LEFT JOIN inventory.lots l ON l.id = b.lot_id LEFT JOIN inventory.product_costs pc ON pc.product_id = b.product_id AND pc.establishment_id = b.establishment_id
        WHERE ($1::uuid IS NULL OR b.product_id = $1) AND ($2::uuid IS NULL OR b.warehouse_id = $2) AND ($3::uuid IS NULL OR b.establishment_id = $3)
          AND ($4::uuid IS NULL OR b.company_id = $4) AND (NOT $5 OR b.quantity > 0)
        ORDER BY p.sku, w.code, l.expires_at NULLS LAST LIMIT 2000`,
      [query.productId ?? null, query.warehouseId ?? null, query.establishmentId ?? null, ctx.companyId, query.onlyPositive]);
    return ctx.warehouseIds ? rows.filter((r) => ctx.warehouseIds!.includes(r.warehouse_id)) : rows;
  });

  route(app, {
    method: 'GET', url: '/v1/stock/kardex', summary: 'Kardex (livro de movimentos) com saldo acumulado e ajustes de custo', tags: ['Estoque'], permission: 'estoque.saldo.ler',
    query: z.object({ productId: z.string().uuid(), establishmentId: z.string().uuid(), from: isoDate.optional(), to: isoDate.optional() }),
  }, async ({ tx, query }) => {
    const opening = await tx.one<{ q: string | null }>(
      `SELECT sum(sign * quantity) AS q FROM inventory.stock_movements WHERE product_id = $1 AND establishment_id = $2 AND ($3::date IS NOT NULL AND occurred_at < $3::date)`,
      [query.productId, query.establishmentId, query.from ?? null]);
    const rows = await tx.query(
      `SELECT m.*, w.code AS warehouse_code, l.lot_number,
              sum(m.sign * m.quantity) OVER (ORDER BY m.occurred_at, m.created_at) + $5::numeric AS balance_after,
              (SELECT new_unit_cost FROM inventory.cost_adjustments a WHERE a.movement_id = m.id ORDER BY a.created_at DESC LIMIT 1) AS adjusted_unit_cost
         FROM inventory.stock_movements m JOIN core.warehouses w ON w.id = m.warehouse_id LEFT JOIN inventory.lots l ON l.id = m.lot_id
        WHERE m.product_id = $1 AND m.establishment_id = $2 AND ($3::date IS NULL OR m.occurred_at >= $3::date) AND ($4::date IS NULL OR m.occurred_at < $4::date + 1)
        ORDER BY m.occurred_at, m.created_at`,
      [query.productId, query.establishmentId, query.from ?? null, query.to ?? null, opening.q ?? '0']);
    return { openingBalance: opening.q ?? '0', movements: rows };
  });

  route(app, {
    method: 'GET', url: '/v1/stock/movements', summary: 'Histórico de entradas e saídas de todo o estoque, com a origem (venda, PDV, compra, devolução, ajuste)', tags: ['Estoque'],
    permission: 'estoque.saldo.ler',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional(), direction: z.enum(['in', 'out']).optional(), type: z.string().max(40).optional(), productId: z.string().uuid().optional(),
      q: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().optional() }),
  }, async ({ tx, ctx, query }) => page(await listMovements(tx, { companyId: ctx.companyId, from: query.from ?? null, to: query.to ?? null, direction: query.direction ?? null,
    type: query.type ?? null, productId: query.productId ?? null, q: query.q || null, limit: query.limit, cursor: decodeCursor(query.cursor) }), query.limit));

  route(app, {
    method: 'GET', url: '/v1/stock/movements/totals', summary: 'Entradas e saídas do período por tipo (quantidade e custo)', tags: ['Estoque'], permission: 'estoque.saldo.ler',
    query: z.object({ from: isoDate.optional(), to: isoDate.optional() }),
  }, async ({ tx, ctx, query }) => movementTotals(tx, { companyId: ctx.companyId, from: query.from ?? null, to: query.to ?? null }));

  route(app, {
    method: 'POST', url: '/v1/stock/manual-movements', summary: 'Baixa por perda/avaria/consumo ou saldo inicial (motivo obrigatório; aprovação acima da alçada — RN-EST-06)', tags: ['Estoque'],
    permission: 'estoque.movimento.criar', status: 201,
    body: z.object({ warehouseId: z.string().uuid(), productId: z.string().uuid(), lotId: z.string().uuid().nullish(), type: z.enum(['loss', 'damage', 'internal_use', 'opening']),
      quantity: decimal({ positive: true }), unitCost: decimal({ min: 0 }).nullish(), reasonCode: z.string().min(2), reason: z.string().min(5), occurredAt: z.string().datetime({ offset: true }).optional() }),
  }, async ({ tx, ctx, body }) => {
    assertWarehouseScope(ctx, body.warehouseId);
    if (body.type === 'opening' && !body.unitCost) throw validation({ unitCost: 'Custo unitário obrigatório no saldo inicial' });
    return createManualMovement(tx, body);
  });

  route(app, {
    method: 'POST', url: '/v1/stock/transfers', summary: 'Transferência entre depósitos do mesmo estabelecimento', tags: ['Estoque'], permission: 'estoque.movimento.criar', status: 201,
    body: z.object({ fromWarehouseId: z.string().uuid(), toWarehouseId: z.string().uuid(), productId: z.string().uuid(), lotId: z.string().uuid().nullish(), quantity: decimal({ positive: true }), reason: z.string().optional() }),
  }, async ({ tx, ctx, body, req }) => {
    assertWarehouseScope(ctx, body.fromWarehouseId);
    return transferBetweenWarehouses(tx, { ...body, idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? undefined });
  });

  route(app, {
    method: 'POST', url: '/v1/stock/movements/:id/reverse', summary: 'Estorna movimento (novo movimento inverso, com motivo)', tags: ['Estoque'], permission: 'estoque.movimento.aprovar', status: 201,
    params: idParams, body: z.object({ reason: z.string() }),
  }, async ({ tx, params, body }) => {
    await requireReason(tx, body.reason, 'estoque.movimento.estornar');
    return reverseMovement(tx, params.id, body.reason);
  });

  route(app, { method: 'GET', url: '/v1/stock/manual-movements', summary: 'Baixas manuais e status de aprovação', tags: ['Estoque'], permission: 'estoque.saldo.ler' }, async ({ tx, ctx }) =>
    tx.query(`SELECT m.*, p.sku, p.description FROM inventory.manual_movements m JOIN catalog.products p ON p.id = m.product_id WHERE ($1::uuid IS NULL OR m.company_id = $1) ORDER BY m.created_at DESC LIMIT 500`, [ctx.companyId]));

  route(app, {
    method: 'GET', url: '/v1/stock/reservations', summary: 'Reservas ativas', tags: ['Estoque'], permission: 'estoque.saldo.ler', query: z.object({ productId: z.string().uuid().optional() }),
  }, async ({ tx, query }) => tx.query(`SELECT * FROM inventory.reservations WHERE status = 'active' AND ($1::uuid IS NULL OR product_id = $1) ORDER BY created_at`, [query.productId ?? null]));

  route(app, {
    method: 'GET', url: '/v1/stock/fefo', summary: 'Sugestão de lotes para separação (FEFO — RN-EST-05)', tags: ['Estoque'], permission: 'estoque.saldo.ler',
    query: z.object({ warehouseId: z.string().uuid(), productId: z.string().uuid(), quantity: decimal({ positive: true }) }),
  }, async ({ tx, query }) => allocateFefo(tx, query.warehouseId, query.productId, query.quantity));

  route(app, {
    method: 'POST', url: '/v1/stock/lots', summary: 'Cadastra lote', tags: ['Estoque'], permission: 'estoque.movimento.criar', status: 201,
    body: z.object({ productId: z.string().uuid(), lotNumber: z.string().min(1), manufacturedAt: isoDate.nullish(), expiresAt: isoDate.nullish(), supplierId: z.string().uuid().nullish() }),
  }, async ({ tx, body }) => ({ id: await getOrCreateLot(tx, body.productId, body.lotNumber, body) }));

  route(app, {
    method: 'POST', url: '/v1/stock/lots/:id/status', summary: 'Bloqueia/libera lote', tags: ['Estoque'], permission: 'estoque.movimento.aprovar', params: idParams,
    body: z.object({ status: z.enum(['available', 'blocked']), reason: z.string() }),
  }, async ({ tx, params, body }) => {
    await requireReason(tx, body.reason, 'estoque.lote.status');
    return tx.one(`UPDATE inventory.lots SET status = $2 WHERE id = $1 RETURNING *`, [params.id, body.status], 'Lote');
  });

  route(app, { method: 'GET', url: '/v1/stock/cost-recalculations', summary: 'Recálculos de custo e relatório do que mudou (RN-EST-04)', tags: ['Estoque'], permission: 'estoque.saldo.ler' }, async ({ tx }) =>
    tx.query(`SELECT r.*, p.sku FROM inventory.cost_recalculations r JOIN catalog.products p ON p.id = r.product_id ORDER BY r.created_at DESC LIMIT 200`));

  // ---------------------------------------------------------------- inventário
  route(app, {
    method: 'POST', url: '/v1/inventories', summary: 'Abre inventário (geral, amostragem ou cíclico) e tira a foto do saldo', tags: ['Inventário'], permission: 'estoque.inventario.criar', status: 201,
    body: z.object({ warehouseId: z.string().uuid(), kind: z.enum(['general', 'sample', 'cyclic']), freezeMode: z.enum(['block', 'register']).default('register'),
      categoryIds: z.array(z.string().uuid()).optional(), productIds: z.array(z.string().uuid()).optional(), abcClass: z.enum(['A', 'B', 'C']).optional(), divergenceLimitPercent: decimal({ min: 0 }).optional() }),
  }, async ({ tx, ctx, body }) => {
    assertWarehouseScope(ctx, body.warehouseId);
    return openInventory(tx, body);
  });

  route(app, { method: 'GET', url: '/v1/inventories', summary: 'Inventários', tags: ['Inventário'], permission: 'estoque.saldo.ler' }, async ({ tx, ctx }) =>
    tx.query(`SELECT * FROM inventory.inventories WHERE ($1::uuid IS NULL OR company_id = $1) ORDER BY created_at DESC`, [ctx.companyId]));

  route(app, { method: 'GET', url: '/v1/inventories/:id', summary: 'Relatório do inventário (também usado no bloco H)', tags: ['Inventário'], permission: 'estoque.saldo.ler', params: idParams },
    async ({ tx, params }) => inventoryReport(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/inventories/:id/counts', summary: 'Registra contagem (leitura por código de barras/celular)', tags: ['Inventário'], permission: 'estoque.inventario.criar', params: idParams,
    body: z.object({ productId: z.string().uuid().optional(), barcode: z.string().optional(), lotId: z.string().uuid().nullish(), quantity: decimal({ min: 0 }), countNumber: z.union([z.literal(1), z.literal(2)]).optional() }),
  }, async ({ tx, params, body }) => {
    let productId = body.productId;
    if (!productId && body.barcode) {
      const p = await tx.maybeOne<{ id: string }>(`SELECT id FROM catalog.products WHERE gtin = $1 OR sku = $1 UNION SELECT product_id FROM catalog.unit_conversions WHERE gtin = $1 LIMIT 1`, [body.barcode]);
      productId = p?.id;
    }
    if (!productId) throw notFound('Produto com este código de barras');
    return countItem(tx, params.id, { productId, lotId: body.lotId, quantity: body.quantity, countNumber: body.countNumber });
  });

  route(app, { method: 'POST', url: '/v1/inventories/:id/review', summary: 'Encerra contagem e calcula diferenças', tags: ['Inventário'], permission: 'estoque.inventario.criar', params: idParams },
    async ({ tx, params }) => reviewInventory(tx, params.id));

  route(app, { method: 'POST', url: '/v1/inventories/:id/approve', summary: 'Aprova diferenças e gera ajustes (fechamento)', tags: ['Inventário'], permission: 'estoque.inventario.aprovar', params: idParams },
    async ({ tx, params }) => approveInventory(tx, params.id));

  // ---------------------------------------------------------------- indicadores de estoque (seção 12)
  route(app, {
    method: 'GET', url: '/v1/stock/indicators', summary: 'Giro, cobertura, curva ABC, parados, ruptura, perdas por motivo, valor de estoque, validade', tags: ['Estoque'], permission: 'estoque.saldo.ler',
    query: z.object({ establishmentId: z.string().uuid(), days: z.coerce.number().int().min(7).max(365).default(90), idleDays: z.coerce.number().int().min(1).default(60), expiringDays: z.coerce.number().int().min(1).default(30) }),
  }, async ({ tx, ctx, query }) => {
    requirePerm(ctx, 'estoque.saldo.ler');
    const value = await tx.query(
      `SELECT w.code AS warehouse, coalesce(c.name, 'Sem categoria') AS category, round(sum(b.quantity * coalesce(pc.avg_cost, 0)), 2) AS value
         FROM inventory.stock_balances b JOIN core.warehouses w ON w.id = b.warehouse_id JOIN catalog.products p ON p.id = b.product_id
         LEFT JOIN catalog.categories c ON c.id = p.category_id LEFT JOIN inventory.product_costs pc ON pc.product_id = b.product_id AND pc.establishment_id = b.establishment_id
        WHERE b.establishment_id = $1 GROUP BY 1, 2 ORDER BY 1, 3 DESC`, [query.establishmentId]);
    const perProduct = await tx.query(
      `WITH sales AS (
         SELECT product_id, sum(quantity) AS qty, sum(total_cost) AS cmv FROM inventory.stock_movements
          WHERE establishment_id = $1 AND movement_type = 'sale_out' AND occurred_at >= now() - ($2 || ' days')::interval GROUP BY product_id),
       stock AS (
         SELECT b.product_id, sum(b.quantity) AS qty, sum(b.quantity - b.reserved - b.blocked) AS available FROM inventory.stock_balances b WHERE b.establishment_id = $1 GROUP BY b.product_id),
       last_sale AS (
         SELECT product_id, max(occurred_at) AS at FROM inventory.stock_movements WHERE establishment_id = $1 AND movement_type = 'sale_out' GROUP BY product_id)
       SELECT p.id AS product_id, p.sku, p.description, coalesce(s.qty, 0) AS stock_qty, coalesce(s.available, 0) AS available,
              coalesce(sa.qty, 0) AS sold_qty, coalesce(sa.cmv, 0) AS cmv, pc.avg_cost,
              CASE WHEN coalesce(s.qty, 0) * coalesce(pc.avg_cost, 0) > 0 THEN round(coalesce(sa.cmv, 0) / (s.qty * pc.avg_cost), 2) END AS turnover,
              CASE WHEN coalesce(sa.qty, 0) > 0 THEN round(coalesce(s.qty, 0) / (sa.qty / $2::numeric), 1) END AS coverage_days,
              ls.at AS last_sale_at
         FROM catalog.products p LEFT JOIN stock s ON s.product_id = p.id LEFT JOIN sales sa ON sa.product_id = p.id
         LEFT JOIN last_sale ls ON ls.product_id = p.id LEFT JOIN inventory.product_costs pc ON pc.product_id = p.id AND pc.establishment_id = $1
        WHERE p.controls_stock AND (s.qty IS NOT NULL OR sa.qty IS NOT NULL)`,
      [query.establishmentId, String(query.days)]);
    const idle = perProduct.filter((p) => Number(p.stock_qty) > 0 && (!p.last_sale_at || new Date(p.last_sale_at).getTime() < Date.now() - query.idleDays * 86_400_000));
    const rupture = perProduct.filter((p) => Number(p.available) <= 0 && Number(p.sold_qty) > 0);
    const losses = await tx.query(
      `SELECT reason_code, movement_type, count(*)::int AS occurrences, sum(estimated_value) AS value FROM inventory.manual_movements
        WHERE establishment_id = $1 AND status = 'posted' AND movement_type IN ('loss','damage','internal_use') AND occurred_at >= now() - ($2 || ' days')::interval
        GROUP BY 1, 2 ORDER BY value DESC`, [query.establishmentId, String(query.days)]);
    const expiring = await tx.query(
      `SELECT l.id, l.lot_number, l.expires_at, p.sku, p.description, sum(b.quantity) AS quantity FROM inventory.lots l JOIN catalog.products p ON p.id = l.product_id
         JOIN inventory.stock_balances b ON b.lot_id = l.id AND b.establishment_id = $1
        WHERE l.expires_at <= current_date + $2::int AND b.quantity > 0 GROUP BY l.id, p.sku, p.description ORDER BY l.expires_at`, [query.establishmentId, query.expiringDays]);
    const accuracy = await tx.query(
      `SELECT i.number, i.closed_at, round(100.0 * count(*) FILTER (WHERE it.diff_qty = 0) / nullif(count(*), 0), 2) AS accuracy_percent
         FROM inventory.inventories i JOIN inventory.inventory_items it ON it.inventory_id = i.id WHERE i.establishment_id = $1 AND i.status = 'closed'
        GROUP BY i.id ORDER BY i.closed_at DESC LIMIT 10`, [query.establishmentId]);
    return { stockValue: value, products: perProduct, abc: await abcCurve(tx, query.establishmentId, query.days), idle, rupture, losses, expiring, inventoryAccuracy: accuracy };
  });
}
