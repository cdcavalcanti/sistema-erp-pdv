import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { systemContext, withTenant, type Tx } from '../src/db/tx.js';
import { postMovement } from '../src/modules/inventory/stock.js';
import { postEvent } from '../src/modules/accounting/posting.js';
import { makeApp, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;
let customer: string;
type Sku = 'FARINHA' | 'QUEIJO' | 'TOMATE' | 'SAL' | 'PIZZA' | 'MOLHO';
const p = {} as Record<Sku, string>;
const today = new Date().toISOString().slice(0, 10);
const run = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app.deps.pool, systemContext(t.tenantId, t.companyId), fn);
const ADDR = [{ kind: 'fiscal', zip: '50050000', street: 'Rua do Sol', number: '10', district: 'Boa Vista', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }];

async function product(sku: Sku, unit: string, stock: string, cost: string, extra: Record<string, unknown> = {}) {
  const r = await t.admin.post('/v1/products', { sku, description: `Item ${sku}`, ncm: '61091000', stockUnit: unit, saleUnit: unit, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (D(stock).greaterThan(0)) {
    await run(async (tx) => {
      const mv = await postMovement(tx, { warehouseId: t.warehouseId, productId: r.body.id, type: 'opening', quantity: stock, unitCost: cost, sourceType: 'test' });
      await postEvent(tx, { type: 'estoque_inicial', companyId: t.companyId, date: today, description: `Saldo inicial ${sku}`, originType: 'test', originId: mv!.id, amounts: { value: mv!.total_cost } });
    });
  }
  p[sku] = r.body.id;
  return r.body.id as string;
}
const qty = async (id: string) => D((await t.admin.get('/v1/stock/balances', { productId: id })).body[0]?.quantity ?? 0).toFixed(4);
async function balanced() {
  const tb = (await t.admin.get('/v1/accounting/trial-balance', { from: '2026-01-01', to: '2027-12-31' })).body;
  expect(tb.totals.debit).toBe(tb.totals.credit);
}

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
  await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true });
  customer = (await t.admin.post('/v1/parties', { kind: 'PF', taxId: '529.982.247-25', legalName: 'Cliente Restaurante', roles: ['customer'], finalConsumer: true, addresses: ADDR,
    creditLimit: '10000' })).body.id;
  await product('FARINHA', 'KG', '50', '4.00');
  await product('QUEIJO', 'KG', '20', '40.00');
  await product('TOMATE', 'KG', '100', '6.00');
  await product('SAL', 'KG', '10', '2.00');
  await product('PIZZA', 'UN', '0', '0');
  await product('MOLHO', 'L', '0', '0', { controlsLot: true });
  const list = (await t.admin.get('/v1/price-lists')).body.find((l: any) => l.is_default);
  await t.admin.put(`/v1/price-lists/${list.id}/items`, { productId: p.PIZZA, price: '60.00' });
});
afterAll(async () => app.close());

describe('Ficha técnica (seção 17)', () => {
  it('versões com vigência, perda e rendimento; custo padrão pelo custo médio', async () => {
    const v1 = await t.admin.post('/v1/production/boms', { productId: p.PIZZA, validFrom: '2026-01-01', yieldQuantity: '2', simpleMode: true, laborCostPerUnit: '3.00', overheadPercent: '10',
      items: [{ componentId: p.FARINHA, quantity: '0.6', lossPercent: '10' }, { componentId: p.QUEIJO, quantity: '0.4' }] });
    expect(v1.status, JSON.stringify(v1.body)).toBe(201);
    // Por pizza: farinha 0,3 × 1,1 = 0,33 kg (R$ 1,32); queijo 0,2 kg (R$ 8,00); indiretos 10% de 9,32 = 0,932; + mão de obra 3,00
    expect(D(v1.body.standardCost.unit).toFixed(4)).toBe('13.2520');
    expect(v1.body.items.find((i: any) => i.component_id === p.FARINHA).grossPerUnit).toBe('0.33');
    const bad = await t.admin.post('/v1/production/boms', { productId: p.PIZZA, validFrom: '2025-12-01', items: [{ componentId: p.FARINHA, quantity: '1' }] });
    expect(bad.status).toBe(422);
    const self = await t.admin.post('/v1/production/boms', { productId: p.PIZZA, validFrom: '2027-01-01', items: [{ componentId: p.PIZZA, quantity: '1' }] });
    expect(self.status).toBe(422);
  });

  it('modo simples (food service): a venda do prato baixa os insumos da ficha, sem ordem de produção', async () => {
    const o = await t.admin.post('/v1/sales/orders', { establishmentId: t.establishmentId, partyId: customer, items: [{ productId: p.PIZZA, quantity: 4 }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const inv = await t.admin.post(`/v1/sales/orders/${o.body.id}/invoice`, {});
    expect(inv.body.transmission.status).toBe('autorizada');
    expect(await qty(p.FARINHA)).toBe('48.6800');
    expect(await qty(p.QUEIJO)).toBe('19.2000');
    await balanced();
  });
});

describe('Ordem de produção', () => {
  let orderId: string;
  it('reserva insumos, aponta consumo real, encerra com perdas e lote; custo real × padrão', async () => {
    const bom = await t.admin.post('/v1/production/boms', { productId: p.MOLHO, validFrom: '2026-01-01', yieldQuantity: '10', laborCostPerUnit: '0.50', overheadPercent: '10',
      items: [{ componentId: p.TOMATE, quantity: '12' }, { componentId: p.SAL, quantity: '0.1' }] });
    expect(bom.status).toBe(201);
    const o = await t.admin.post('/v1/production/orders', { productId: p.MOLHO, quantity: '20', warehouseId: t.warehouseId });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    orderId = o.body.id;
    expect(o.body.materials.map((m: any) => [m.sku, m.planned_quantity]).sort()).toEqual([['SAL', '0.2000'], ['TOMATE', '24.0000']]);
    // padrão por litro: 1,2 × 6 + 0,01 × 2 = 7,22 + 10% + 0,50 = 8,442
    expect(D(o.body.standard_unit_cost).toFixed(3)).toBe('8.442');
    await t.admin.post(`/v1/production/orders/${orderId}/release`);
    const bal = (await t.admin.get('/v1/stock/balances', { productId: p.TOMATE })).body[0];
    expect(bal.reserved).toBe('24.0000');
    const c = await t.admin.post(`/v1/production/orders/${orderId}/consumption`, { lines: [{ componentId: p.TOMATE, quantity: '25' }] });
    expect(c.body.status).toBe('in_progress');
    const closed = await t.admin.post(`/v1/production/orders/${orderId}/close`, { producedQuantity: '19', lostQuantity: '1', expiresAt: '2026-12-31' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.status).toBe('closed');
    // Sal baixado pelo previsto (backflush): 0,2 × (19 + 1) / 20
    expect(closed.body.materials.find((m: any) => m.sku === 'SAL').consumed_quantity).toBe('0.2000');
    // Real: (25 × 6 + 0,2 × 2) = 150,40 + 10% (15,04) + 19 × 0,50 (9,50) = 174,94 ÷ 19
    expect(closed.body.materials_cost).toBe('150.40');
    expect(D(closed.body.real_unit_cost).toFixed(4)).toBe(D('174.94').dividedBy(19).toFixed(4));
    expect(D(closed.body.variance.unit).greaterThan(0)).toBe(true);
    expect(await qty(p.MOLHO)).toBe('19.0000');
    expect(await qty(p.TOMATE)).toBe('75.0000');
    expect((await t.admin.get('/v1/stock/balances', { productId: p.TOMATE })).body[0].reserved).toBe('0.0000');
    const lot = await run((tx) => tx.one<{ lot_number: string; expires_at: string }>(`SELECT lot_number, expires_at::text FROM inventory.lots WHERE product_id = $1`, [p.MOLHO]));
    expect(lot.lot_number).toMatch(/^OP\d+$/);
    expect(lot.expires_at).toBe('2026-12-31');
    await balanced();
    const rec = (await t.admin.get('/v1/accounting/reconciliation', { date: '2027-12-31' })).body;
    expect(rec.find((l: any) => l.account.startsWith('Estoque')).ok).toBe(true);
  });

  it('cancelamento estorna os consumos e libera as reservas', async () => {
    const o = await t.admin.post('/v1/production/orders', { productId: p.MOLHO, quantity: '10', warehouseId: t.warehouseId });
    await t.admin.post(`/v1/production/orders/${o.body.id}/release`);
    await t.admin.post(`/v1/production/orders/${o.body.id}/consumption`, { lines: [{ componentId: p.TOMATE, quantity: '5' }] });
    expect(await qty(p.TOMATE)).toBe('70.0000');
    const c = await t.admin.post(`/v1/production/orders/${o.body.id}/cancel`, { reason: 'Falta de embalagem' });
    expect(c.body.status).toBe('cancelled');
    expect(await qty(p.TOMATE)).toBe('75.0000');
    expect((await t.admin.get('/v1/stock/balances', { productId: p.TOMATE })).body[0].reserved).toBe('0.0000');
  });

  it('CMV teórico × real: perda de insumo aparece como diferença', async () => {
    await run((tx) => postMovement(tx, { warehouseId: t.warehouseId, productId: p.FARINHA, type: 'loss', quantity: '0.5', sourceType: 'test', reason: 'Saco rasgado' }));
    const r = (await t.admin.get('/v1/production/theoretical-vs-real', { establishmentId: t.establishmentId, from: today, to: today })).body;
    const farinha = r.rows.find((x: any) => x.sku === 'FARINHA');
    expect(farinha).toMatchObject({ theoretical: '1.3200', real: '1.8200', losses: '0.5000', difference: '0.5000' });
    const tomate = r.rows.find((x: any) => x.sku === 'TOMATE');
    // Teórico: 19 litros bons × 1,2 kg = 22,8 kg; real consumido: 25 kg (inclui o litro perdido)
    expect(tomate).toMatchObject({ theoretical: '22.8000', real: '25.0000', difference: '2.2000' });
    expect(D(r.totals.difference).greaterThan(0)).toBe(true);
    const viaCatalog = await t.admin.post('/v1/reports/estoque.cmv_teorico_real/run', { params: { establishmentId: t.establishmentId, from: today, to: today } });
    expect(viaCatalog.body.rows.length).toBe(r.rows.length);
  });
});
