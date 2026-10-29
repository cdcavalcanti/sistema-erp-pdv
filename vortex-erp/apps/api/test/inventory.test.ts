import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement, reserve, runCostRecalc } from '../src/modules/inventory/stock.js';
import { createUser, getWorkerDeps, makeApp, setupTenant, type TenantFixture } from './helpers.js';
import { drain } from '../src/worker/runner.js';

let app: App;
let t: TenantFixture;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, { ...systemContext(t.tenantId, t.companyId) }, fn);
async function product(sku: string, extra: Record<string, unknown> = {}) {
  const r = await t.admin.post('/v1/products', { sku, description: `Produto ${sku}`, ncm: '61091000', ...extra });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.id as string;
}
const opening = (productId: string, quantity: string, unitCost: string, extra: Record<string, unknown> = {}) =>
  run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId, type: 'opening', quantity, unitCost, sourceType: 'test', ...extra }));
const sale = (productId: string, quantity: string, extra: Record<string, unknown> = {}) =>
  run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId, type: 'sale_out', quantity, sourceType: 'test', ...extra }));
const balance = async (productId: string) => (await t.admin.get('/v1/stock/balances', { productId })).body;

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
});
afterAll(async () => app.close());

describe('Estoque e custos', () => {
  it('RN-EST-03 custo médio ponderado móvel; saídas não alteram o custo médio', async () => {
    const p = await product('CM1');
    await opening(p, '10', '5.00');
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p, type: 'purchase_in', quantity: '10', unitCost: '7.00', sourceType: 'test' }));
    const out = await sale(p, '5');
    expect(out!.unit_cost).toBe('6.0000000000');
    expect(out!.total_cost).toBe('30.00');
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p, type: 'purchase_in', quantity: '5', unitCost: '9.00', sourceType: 'test' }));
    // (15 × 6 + 5 × 9) ÷ 20 = 6,75
    const k = await t.admin.get('/v1/stock/kardex', { productId: p, establishmentId: t.establishmentId });
    expect(k.body.movements.at(-1).avg_cost_after).toBe('6.7500000000');
    expect(k.body.movements.at(-1).balance_after).toBe('20.0000');
    const prod = await t.admin.get(`/v1/products/${p}`);
    expect(prod.body.last_purchase_cost).toBe('9.0000000000');
  });

  it('RN-EST-02 estoque negativo bloqueado por padrão; liberado por produto', async () => {
    const p = await product('NEG1');
    await opening(p, '1', '10');
    await expect(sale(p, '2')).rejects.toMatchObject({ details: { rule: 'RN-EST-02' } });
    const p2 = await product('NEG2', { allowNegativeStock: true });
    await opening(p2, '1', '10');
    await sale(p2, '3');
    const b = await balance(p2);
    expect(b[0].quantity).toBe('-2.0000');
    // Entrada posterior corrige o custo e dispara recálculo das saídas a descoberto
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p2, type: 'purchase_in', quantity: '5', unitCost: '12', sourceType: 'test' }));
    const rec = await t.admin.get('/v1/stock/cost-recalculations');
    expect(rec.body.some((r: any) => r.product_id === p2)).toBe(true);
  });

  it('decisão da seção 22: duas vendas simultâneas do último item — só uma passa', async () => {
    const p = await product('LAST1');
    await opening(p, '1', '10');
    const results = await Promise.allSettled([sale(p, '1'), sale(p, '1'), sale(p, '1')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await balance(p))[0].quantity).toBe('0.0000');
  });

  it('RN-GER-07 movimento com a mesma chave nunca duplica a baixa', async () => {
    const p = await product('IDEM-MV');
    await opening(p, '10', '1');
    const a = await sale(p, '3', { idempotencyKey: 'venda-123-item-1' });
    const b = await sale(p, '3', { idempotencyKey: 'venda-123-item-1' });
    expect(b!.id).toBe(a!.id);
    expect((await balance(p))[0].quantity).toBe('7.0000');
  });

  it('RN-EST-01 disponível = físico − reservado − bloqueado; reserva consumida na venda', async () => {
    const p = await product('RES1');
    await opening(p, '10', '2');
    const res = await run((tx) => reserve(tx, { warehouseId: t.warehouseId, productId: p, quantity: '8', sourceType: 'test', sourceId: '00000000-0000-0000-0000-000000000001' }));
    expect((await balance(p))[0].available).toBe('2.0000');
    await expect(sale(p, '3')).rejects.toMatchObject({ details: { rule: 'RN-EST-02' } });
    await sale(p, '8', { consumeReservationId: res!.id });
    const b = (await balance(p))[0];
    expect(b.quantity).toBe('2.0000');
    expect(b.reserved).toBe('0.0000');
  });

  it('RN-GER-02 estorno é novo movimento inverso, com motivo', async () => {
    const p = await product('REV1');
    await opening(p, '5', '3');
    const s = await sale(p, '2');
    const semMotivo = await t.admin.post(`/v1/stock/movements/${s!.id}/reverse`, { reason: 'x' });
    expect(semMotivo.status).toBe(422);
    const r = await t.admin.post(`/v1/stock/movements/${s!.id}/reverse`, { reason: 'Venda lançada em duplicidade pelo operador' });
    expect(r.status).toBe(201);
    expect(r.body.movement_type).toBe('reversal_in');
    expect((await balance(p))[0].quantity).toBe('5.0000');
    expect((await t.admin.post(`/v1/stock/movements/${s!.id}/reverse`, { reason: 'Venda lançada em duplicidade pelo operador' })).status).toBe(409);
  });

  it('RN-EST-05 FEFO e bloqueio de lote vencido para venda', async () => {
    const p = await product('LOT1', { controlsLot: true, controlsExpiry: true });
    const l1 = await t.admin.post('/v1/stock/lots', { productId: p, lotNumber: 'L-NOV', expiresAt: '2030-11-30' });
    const l2 = await t.admin.post('/v1/stock/lots', { productId: p, lotNumber: 'L-JAN', expiresAt: '2030-01-31' });
    const l3 = await t.admin.post('/v1/stock/lots', { productId: p, lotNumber: 'L-VENCIDO', expiresAt: '2020-01-01' });
    for (const l of [l1, l2, l3]) await opening(p, '5', '1', { lotId: l.body.id });
    const fefo = await t.admin.get('/v1/stock/fefo', { warehouseId: t.warehouseId, productId: p, quantity: '7' });
    expect(fefo.body.map((x: any) => [x.lotNumber, x.quantity])).toEqual([['L-JAN', '5.0000'], ['L-NOV', '2.0000']]);
    await expect(sale(p, '1', { lotId: l3.body.id })).rejects.toMatchObject({ details: { rule: 'RN-EST-05' } });
    await expect(sale(p, '1')).rejects.toMatchObject({ details: { fields: { lotId: expect.stringMatching(/lote/) } } });
  });

  it('RN-EST-06 perda exige motivo e, acima da alçada, aprovação', async () => {
    const p = await product('PERDA1');
    await opening(p, '100', '50');
    const est = await createUser(app, t, ['estoquista']);
    const small = await est.post('/v1/stock/manual-movements', { warehouseId: t.warehouseId, productId: p, type: 'damage', quantity: 2, reasonCode: 'AVARIA', reason: 'Caixa amassada no recebimento' });
    expect(small.body.status).toBe('posted');
    const big = await est.post('/v1/stock/manual-movements', { warehouseId: t.warehouseId, productId: p, type: 'loss', quantity: 20, reasonCode: 'ROUBO', reason: 'Furto identificado no CFTV' });
    expect(big.body.status).toBe('pending_approval');
    expect((await balance(p))[0].quantity).toBe('98.0000');
    const ger = await createUser(app, t, ['gerente']);
    const ok = await ger.post(`/v1/approvals/${big.body.approvalRequestId}/decision`, { decision: 'approve' });
    expect(ok.body.status).toBe('approved');
    expect((await balance(p))[0].quantity).toBe('78.0000');
    const ind = await t.admin.get('/v1/stock/indicators', { establishmentId: t.establishmentId });
    expect(ind.body.losses.find((l: any) => l.reason_code === 'ROUBO').value).toBe('1000.00');
  });

  it('RN-EST-04 entrada retroativa dispara recálculo com relatório do que mudou', async () => {
    const p = await product('RETRO1');
    const d = (s: string) => new Date(s);
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p, type: 'purchase_in', quantity: '10', unitCost: '10', sourceType: 'test', occurredAt: d('2026-09-01T10:00:00Z') }));
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p, type: 'sale_out', quantity: '5', sourceType: 'test', occurredAt: d('2026-09-10T10:00:00Z') }));
    // Nota de compra lançada com data anterior à venda
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p, type: 'purchase_in', quantity: '10', unitCost: '20', sourceType: 'test', occurredAt: d('2026-09-05T10:00:00Z') }));
    await drain(getWorkerDeps(app));
    const rec = (await t.admin.get('/v1/stock/cost-recalculations')).body.find((r: any) => r.product_id === p);
    expect(rec.status).toBe('done');
    // custo correto da venda de 10/09: (10×10 + 10×20) ÷ 20 = 15
    expect(rec.report.changes[0]).toMatchObject({ oldUnitCost: '10.0000000000', newUnitCost: '15.0000000000', difference: '25.00' });
  });

  it('RN-CTB-04 período fechado bloqueia movimento e recálculo', async () => {
    const p = await product('PER1');
    await run((tx) => tx.exec(`INSERT INTO accounting.periods (tenant_id, company_id, year, month, status, closed_at) VALUES ($1,$2,2026,1,'closed',now())`, [t.tenantId, t.companyId]));
    await expect(run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p, type: 'opening', quantity: '1', unitCost: '1', sourceType: 'test', occurredAt: new Date('2026-01-15T12:00:00Z') })))
      .rejects.toThrow(/RN-CTB-04/);
    await opening(p, '1', '1', { occurredAt: new Date('2026-02-01T12:00:00Z') });
    const id = await run(async (tx) => (await tx.one(`INSERT INTO inventory.cost_recalculations (tenant_id, company_id, establishment_id, product_id, from_date) VALUES ($1,$2,$3,$4,'2026-01-10') RETURNING id`,
      [t.tenantId, t.companyId, t.establishmentId, p])).id);
    const r = await run((tx) => runCostRecalc(tx, id));
    expect(r).toMatchObject({ blocked: true });
  });

  it('inventário: foto, contagem, segunda contagem obrigatória, aprovação e ajuste', async () => {
    const a = await product('INV-A');
    const b = await product('INV-B', { gtin: '7891000315507' });
    await opening(a, '10', '2');
    await opening(b, '20', '3');
    const inv = await t.admin.post('/v1/inventories', { warehouseId: t.warehouseId, kind: 'general', productIds: [a, b], divergenceLimitPercent: '5' });
    expect(inv.status).toBe(201);
    expect(inv.body.items).toBe(2);
    const c1 = await t.admin.post(`/v1/inventories/${inv.body.id}/counts`, { productId: a, quantity: 10 });
    expect(c1.body.needsRecount).toBe(false);
    const c2 = await t.admin.post(`/v1/inventories/${inv.body.id}/counts`, { barcode: '7891000315507', quantity: 17 });
    expect(c2.body.needsRecount).toBe(true);
    expect((await t.admin.post(`/v1/inventories/${inv.body.id}/review`)).status).toBe(409);
    const contador2 = await createUser(app, t, ['estoquista']);
    await contador2.post(`/v1/inventories/${inv.body.id}/counts`, { productId: b, quantity: 18, countNumber: 2 });
    // venda durante a contagem (modo registrar)
    await sale(b, '1');
    const rev = await t.admin.post(`/v1/inventories/${inv.body.id}/review`);
    expect(rev.status).toBe(200);
    const itemB = rev.body.items.find((i: any) => i.product_id === b);
    expect(itemB.diff_qty).toBe('-1.0000'); // esperado 19 (20 − 1 vendido), contado 18
    const ger = await createUser(app, t, ['gerente']);
    const ap = await ger.post(`/v1/inventories/${inv.body.id}/approve`);
    expect(ap.body.inventory.status).toBe('closed');
    expect((await balance(b))[0].quantity).toBe('18.0000');
  });

  it('propriedade: saldo = soma dos movimentos, custo médio nunca negativo', async () => {
    const p = await product('PROP1', { allowNegativeStock: true });
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ in: fc.boolean(), q: fc.integer({ min: 1, max: 50 }), c: fc.integer({ min: 1, max: 1000 }) }), { minLength: 1, maxLength: 15 }), async (ops) => {
        for (const o of ops) {
          await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p, type: o.in ? 'purchase_in' : 'sale_out', quantity: String(o.q), unitCost: o.in ? (o.c / 10).toFixed(2) : null, sourceType: 'prop' }));
        }
        const { sumq, bal, avg } = await run(async (tx) => ({
          sumq: (await tx.one(`SELECT coalesce(sum(sign * quantity), 0) AS s FROM inventory.stock_movements WHERE product_id = $1`, [p])).s,
          bal: (await tx.one(`SELECT quantity FROM inventory.stock_balances WHERE product_id = $1`, [p])).quantity,
          avg: (await tx.one(`SELECT avg_cost FROM inventory.product_costs WHERE product_id = $1`, [p])).avg_cost,
        }));
        return D(sumq).equals(bal) && !D(avg).isNegative();
      }),
      { numRuns: 15 },
    );
  });
});
