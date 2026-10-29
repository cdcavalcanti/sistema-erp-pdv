import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@vortex/money';
import type { App } from '../src/http/app.js';
import { bestPromotion, applyRule } from '../src/modules/catalog/pricing-core.js';
import { systemContext, withTenant } from '../src/db/tx.js';
import { applyDuePriceChanges } from '../src/modules/catalog/pricing.js';
import { makeApp, makeCnpj, setupTenant, type TenantFixture } from './helpers.js';

let app: App;
let t: TenantFixture;

export const baseProduct = (sku: string, extra: Record<string, unknown> = {}) => ({
  sku, description: `Produto ${sku}`, ncm: '22021000', cest: '0300700', gtin: null, stockUnit: 'UN', ...extra,
});

beforeAll(async () => {
  app = await makeApp();
  t = await setupTenant(app);
});
afterAll(async () => app.close());

describe('Produtos', () => {
  it('valida GTIN, NCM vigente e CEST compatível com o NCM', async () => {
    const badGtin = await t.admin.post('/v1/products', baseProduct('P-BAD', { gtin: '7891000315508' }));
    expect(badGtin.status).toBe(422);
    expect(badGtin.body.details.fields.gtin).toBeDefined();
    const badNcm = await t.admin.post('/v1/products', baseProduct('P-BAD2', { ncm: '99999999' }));
    expect(badNcm.body.details.fields.ncm).toMatch(/vigente/);
    const badCest = await t.admin.post('/v1/products', baseProduct('P-BAD3', { ncm: '61091000', cest: '0300700' }));
    expect(badCest.body.details.fields.cest).toMatch(/incompatível/);
    const ok = await t.admin.post('/v1/products', baseProduct('REFRI-2L', { gtin: '7891000315507' }));
    expect(ok.status).toBe(201);
    const dup = await t.admin.post('/v1/products', baseProduct('REFRI-2L-B', { gtin: '7891000315507' }));
    expect(dup.status).toBe(409);
  });

  it('serviço exige código LC 116 e não controla estoque', async () => {
    const s = await t.admin.post('/v1/products', { sku: 'SRV-1', description: 'Consultoria', kind: 'service', serviceCode: '17.01', stockUnit: 'HR' });
    expect(s.status).toBe(201);
    expect(s.body.controls_stock).toBe(false);
  });

  it('grade: variação herda fiscal do pai; mudança fiscal do pai propaga', async () => {
    const pai = await t.admin.post('/v1/products', { sku: 'CAM', description: 'Camiseta básica', ncm: '61091000', isVariantParent: true });
    expect(pai.status).toBe(201);
    const v1 = await t.admin.post(`/v1/products/${pai.body.id}/variants`, { sku: 'CAM-AZ-M', attributes: { cor: 'Azul', tamanho: 'M' } });
    expect(v1.status).toBe(201);
    expect(v1.body.ncm).toBe('61091000');
    expect(v1.body.parent_id).toBe(pai.body.id);
    const dupVar = await t.admin.post(`/v1/products/${pai.body.id}/variants`, { sku: 'CAM-AZ-M2', attributes: { cor: 'Azul', tamanho: 'M' } });
    expect(dupVar.status).toBe(409);
    const upd = await t.admin.patch(`/v1/products/${pai.body.id}`, { version: pai.body.version, origin: 2 });
    expect(upd.status).toBe(200);
    const v1b = await t.admin.get(`/v1/products/${v1.body.id}`);
    expect(v1b.body.origin).toBe(2);
  });

  it('kit: rateio do preço deve somar 100%', async () => {
    const a = await t.admin.post('/v1/products', baseProduct('KA'));
    const b = await t.admin.post('/v1/products', baseProduct('KB'));
    const kit = await t.admin.post('/v1/products', baseProduct('KIT1', { kind: 'kit' }));
    const bad = await t.admin.put(`/v1/products/${kit.body.id}/kit-items`, { items: [{ componentId: a.body.id, quantity: 1, priceSharePercent: 60 }, { componentId: b.body.id, quantity: 2, priceSharePercent: 30 }] });
    expect(bad.status).toBe(422);
    const ok = await t.admin.put(`/v1/products/${kit.body.id}/kit-items`, { items: [{ componentId: a.body.id, quantity: 1, priceSharePercent: 60 }, { componentId: b.body.id, quantity: 2, priceSharePercent: 40 }] });
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveLength(2);
  });

  it('conversão de unidade: caixa com 12 = 12 UN', async () => {
    const p = await t.admin.post('/v1/products', baseProduct('CONV1'));
    const r = await t.admin.put(`/v1/products/${p.body.id}/conversions`, { conversions: [{ unit: 'CX', factor: 12 }] });
    expect(r.body[0].factor).toBe('12.000000');
  });
});

describe('Preços', () => {
  it('RN-PRE-01 prioridade: cliente → segmento → canal → padrão; variação herda preço do pai', async () => {
    const p = await t.admin.post('/v1/products', baseProduct('PRIO1'));
    const padrao = await t.admin.post('/v1/price-lists', { code: 'PADRAO', name: 'Padrão', isDefault: true });
    const atacado = await t.admin.post('/v1/price-lists', { code: 'ATAC', name: 'Atacado', channels: ['wholesale'] });
    const seg = await t.admin.post('/v1/price-lists', { code: 'SEG-REST', name: 'Restaurantes', segment: 'restaurante' });
    await t.admin.put(`/v1/price-lists/${padrao.body.id}/items`, { productId: p.body.id, price: '10.00' });
    await t.admin.put(`/v1/price-lists/${atacado.body.id}/items`, { productId: p.body.id, price: '9.00' });
    await t.admin.put(`/v1/price-lists/${seg.body.id}/items`, { productId: p.body.id, price: '8.50' });
    const cli = await t.admin.post('/v1/parties', { kind: 'PJ', taxId: makeCnpj(), legalName: 'Restaurante X', roles: ['customer'], segment: 'restaurante',
      addresses: [{ kind: 'fiscal', zip: '50050000', street: 'Rua A', number: '1', district: 'Centro', cityIbge: '2611606', cityName: 'Recife', uf: 'PE' }] });
    const cliList = await t.admin.post('/v1/price-lists', { code: 'CLI-X', name: 'Especial X', customerId: cli.body.id });
    expect((await t.admin.get('/v1/pricing/quote', { productId: p.body.id })).body.unitPrice).toBe('10');
    expect((await t.admin.get('/v1/pricing/quote', { productId: p.body.id, channel: 'wholesale' })).body.unitPrice).toBe('9');
    const segQ = await t.admin.get('/v1/pricing/quote', { productId: p.body.id, channel: 'wholesale', customerId: cli.body.id });
    expect(segQ.body, JSON.stringify(segQ.body) + JSON.stringify(cli.body)).toMatchObject({ level: 'segment' });
    await t.admin.put(`/v1/price-lists/${cliList.body.id}/items`, { productId: p.body.id, price: '8.00' });
    const q = await t.admin.get('/v1/pricing/quote', { productId: p.body.id, channel: 'wholesale', customerId: cli.body.id });
    expect(q.body.level).toBe('customer');
    expect(q.body.unitPrice).toBe('8');
    // variação sem preço próprio herda do pai
    const pai = await t.admin.post('/v1/products', baseProduct('PAI-P', { isVariantParent: true }));
    await t.admin.put(`/v1/price-lists/${padrao.body.id}/items`, { productId: pai.body.id, price: '50.00' });
    const v = await t.admin.post(`/v1/products/${pai.body.id}/variants`, { sku: 'PAI-P-1', attributes: { tamanho: 'G' } });
    expect((await t.admin.get('/v1/pricing/quote', { productId: v.body.id })).body.unitPrice).toBe('50');
  });

  it('RN-PRE-02 promoções não se acumulam (vale a mais vantajosa), salvo configuração', () => {
    const base = D('10');
    const promos = [
      { id: 'a', name: '10%', rule: { type: 'percent_off' as const, percent: '10' }, cumulative: false, remaining: null },
      { id: 'b', name: 'leve 3 pague 2', rule: { type: 'buy_x_pay_y' as const, buy: 3, pay: 2 }, cumulative: false, remaining: null },
    ];
    expect(bestPromotion(base, D(1), promos).unitPrice.toString()).toBe('9');
    expect(bestPromotion(base, D(3), promos).applied[0]!.id).toBe('b');
    expect(applyRule(base, D(4), { type: 'buy_x_pay_y', buy: 3, pay: 2 }).toFixed(2)).toBe('7.50');
    const cum = [
      { id: 'c', name: '10%', rule: { type: 'percent_off' as const, percent: '10' }, cumulative: true, remaining: null },
      { id: 'd', name: '5%', rule: { type: 'percent_off' as const, percent: '5' }, cumulative: true, remaining: null },
    ];
    expect(bestPromotion(base, D(1), cum).unitPrice.toString()).toBe('8.55');
    // limite de quantidade esgotado não aplica
    expect(bestPromotion(base, D(5), [{ ...promos[0]!, remaining: D(2) }]).applied).toHaveLength(0);
  });

  it('RN-PRE-02 promoção por API aplicada na cotação', async () => {
    const p = await t.admin.post('/v1/products', baseProduct('PROMO1'));
    const l = (await t.admin.get('/v1/price-lists')).body.find((x: any) => x.is_default);
    await t.admin.put(`/v1/price-lists/${l.id}/items`, { productId: p.body.id, price: '20.00' });
    const now = Date.now();
    const pr = await t.admin.post('/v1/promotions', { name: 'Progressivo', startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 86_400_000).toISOString(),
      rule: { type: 'progressive', tiers: [{ minQty: '5', percent: '5' }, { minQty: '10', percent: '10' }] }, productIds: [p.body.id] });
    expect(pr.status).toBe(201);
    const q = await t.admin.get('/v1/pricing/quote', { productId: p.body.id, qty: '10' });
    expect(q.body.unitPrice).toBe('18');
    expect(q.body.promotions[0].name).toBe('Progressivo');
    const bad = await t.admin.post('/v1/promotions', { name: 'X', startsAt: new Date(now).toISOString(), endsAt: new Date(now + 1000).toISOString(), rule: { type: 'buy_x_pay_y', buy: 2, pay: 3 } });
    expect(bad.status).toBe(422);
  });

  it('RN-PRE-04 alteração de preço gera histórico e pode ser agendada', async () => {
    const p = await t.admin.post('/v1/products', baseProduct('HIST1'));
    const l = (await t.admin.get('/v1/price-lists')).body.find((x: any) => x.is_default);
    await t.admin.put(`/v1/price-lists/${l.id}/items`, { productId: p.body.id, price: '5.00' });
    await t.admin.put(`/v1/price-lists/${l.id}/items`, { productId: p.body.id, price: '5.50', reason: 'Reajuste do fornecedor' });
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const sch = await t.admin.put(`/v1/price-lists/${l.id}/items`, { productId: p.body.id, price: '6.00', effectiveAt: future });
    expect(sch.body.scheduled).toBe(true);
    expect((await t.admin.get('/v1/pricing/quote', { productId: p.body.id })).body.unitPrice).toBe('5.5');
    const hist = await t.admin.get(`/v1/products/${p.body.id}/price-history`);
    expect(hist.body).toHaveLength(2);
    expect(hist.body[0].old_price).toBe('5.0000000000');
    expect(hist.body[0].changed_by_name).toBeTruthy();
    // Simula a chegada da data e roda o job
    await withTenant(app.deps.pool, systemContext(t.tenantId), async (tx) => {
      await tx.exec(`UPDATE catalog.scheduled_price_changes SET effective_at = now() - interval '1 minute' WHERE id = $1`, [sch.body.change.id]);
      expect(await applyDuePriceChanges(tx)).toBe(1);
    });
    expect((await t.admin.get('/v1/pricing/quote', { productId: p.body.id })).body.unitPrice).toBe('6');
  });

  it('markup divisor: exemplo do guia (custo 60 → 100,00)', async () => {
    const r = await t.admin.post('/v1/pricing/suggest', { cost: '60', taxesPercent: 8, commissionPercent: 3, cardFeePercent: 2, fixedExpensesPercent: 12, marginPercent: 15 });
    expect(r.body.suggestedPrice).toBe('100.00');
  });
});
