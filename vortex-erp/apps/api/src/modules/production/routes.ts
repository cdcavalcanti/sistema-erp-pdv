import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { decimal, idParams, isoDate } from '../../http/schemas.js';
import { assertEstablishmentScope, assertWarehouseScope } from '../../core/access.js';
import {
  cancelProductionOrder, closeProductionOrder, consumeMaterials, createBom, createProductionOrder, getBom, getProductionOrder, releaseProductionOrder, theoreticalVsReal,
} from './service.js';

export function registerProductionRoutes(app: App) {
  route(app, {
    method: 'POST', url: '/v1/production/boms', summary: 'Nova versão da ficha técnica (insumos, perda, rendimento, vigência; modo simples para food service)', tags: ['Produção'],
    permission: 'producao.ficha.editar', status: 201,
    body: z.object({ productId: z.string().uuid(), validFrom: isoDate, yieldQuantity: decimal({ positive: true }).optional(), simpleMode: z.boolean().optional(),
      laborCostPerUnit: decimal({ min: 0 }).optional(), overheadPercent: decimal({ min: 0 }).optional(), notes: z.string().nullish(),
      items: z.array(z.object({ componentId: z.string().uuid(), quantity: decimal({ positive: true }), lossPercent: decimal({ min: 0 }).optional(), notes: z.string().nullish() })).min(1) }),
  }, async ({ tx, body }) => createBom(tx, body));

  route(app, { method: 'GET', url: '/v1/production/boms', summary: 'Versões das fichas técnicas de um produto', tags: ['Produção'], permission: 'produtos.produto.ler',
    query: z.object({ productId: z.string().uuid() }) },
  async ({ tx, query }) => tx.query(`SELECT * FROM production.boms WHERE product_id = $1 ORDER BY version DESC`, [query.productId]));

  route(app, { method: 'GET', url: '/v1/production/boms/:id', summary: 'Ficha técnica com custo padrão (insumos pelo custo médio + mão de obra + indiretos)', tags: ['Produção'],
    permission: 'produtos.produto.ler', params: idParams, query: z.object({ establishmentId: z.string().uuid().optional() }) },
  async ({ tx, params, query }) => getBom(tx, params.id, query.establishmentId ?? null));

  route(app, {
    method: 'POST', url: '/v1/production/orders', summary: 'Ordem de produção pela ficha vigente', tags: ['Produção'], permission: 'producao.ordem.editar', status: 201,
    body: z.object({ productId: z.string().uuid(), quantity: decimal({ positive: true }), warehouseId: z.string().uuid(), plannedDate: isoDate.nullish(), lotNumber: z.string().nullish() }),
  }, async ({ tx, ctx, body }) => {
    assertWarehouseScope(ctx, body.warehouseId);
    return createProductionOrder(tx, body);
  });

  route(app, { method: 'GET', url: '/v1/production/orders', summary: 'Ordens de produção', tags: ['Produção'], permission: 'producao.ordem.editar', query: z.object({ status: z.string().optional() }) },
    async ({ tx, ctx, query }) => tx.query(
      `SELECT o.*, p.sku, p.description FROM production.orders o JOIN catalog.products p ON p.id = o.product_id
        WHERE ($1::uuid IS NULL OR o.company_id = $1) AND ($2::text IS NULL OR o.status = $2) ORDER BY o.number DESC LIMIT 500`, [ctx.companyId, query.status ?? null]));

  route(app, { method: 'GET', url: '/v1/production/orders/:id', summary: 'Ordem com insumos previstos × consumidos e custo padrão × real', tags: ['Produção'],
    permission: 'producao.ordem.editar', params: idParams }, async ({ tx, params }) => getProductionOrder(tx, params.id));

  route(app, { method: 'POST', url: '/v1/production/orders/:id/release', summary: 'Libera e reserva os insumos', tags: ['Produção'], permission: 'producao.ordem.editar', params: idParams },
    async ({ tx, params }) => releaseProductionOrder(tx, params.id));

  route(app, {
    method: 'POST', url: '/v1/production/orders/:id/consumption', summary: 'Apontamento de consumo real de insumos', tags: ['Produção'], permission: 'producao.ordem.editar', params: idParams,
    body: z.object({ lines: z.array(z.object({ componentId: z.string().uuid(), quantity: decimal({ positive: true }), lotId: z.string().uuid().nullish() })).min(1) }),
  }, async ({ tx, params, body }) => consumeMaterials(tx, params.id, body.lines));

  route(app, {
    method: 'POST', url: '/v1/production/orders/:id/close', summary: 'Encerra: produzido, perdas, lote do acabado e custo real', tags: ['Produção'], permission: 'producao.ordem.editar', params: idParams,
    body: z.object({ producedQuantity: decimal({ positive: true }), lostQuantity: decimal({ min: 0 }).optional(), backflush: z.boolean().optional(), lotNumber: z.string().nullish(),
      expiresAt: isoDate.nullish() }),
  }, async ({ tx, params, body }) => closeProductionOrder(tx, params.id, body));

  route(app, {
    method: 'POST', url: '/v1/production/orders/:id/cancel', summary: 'Cancela (estorna consumos e libera reservas)', tags: ['Produção'], permission: 'producao.ordem.editar', params: idParams,
    body: z.object({ reason: z.string().min(5) }),
  }, async ({ tx, params, body }) => cancelProductionOrder(tx, params.id, body.reason));

  route(app, {
    method: 'GET', url: '/v1/production/theoretical-vs-real', summary: 'CMV teórico × real por insumo (vendas × ficha técnica e ordens × consumo, perdas e inventário)', tags: ['Produção'],
    permission: 'estoque.saldo.ler', query: z.object({ establishmentId: z.string().uuid(), from: isoDate, to: isoDate }),
  }, async ({ tx, ctx, query }) => {
    assertEstablishmentScope(ctx, query.establishmentId);
    return theoreticalVsReal(tx, query);
  });
}
