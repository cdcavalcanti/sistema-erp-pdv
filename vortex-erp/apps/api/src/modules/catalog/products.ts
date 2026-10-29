import { z } from 'zod';
import { isValidCESTFormat, isValidGTINOrSemGTIN, isValidNCMFormat } from '@vortex/validators';
import { D, sum } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { conflict, notFound, ruleViolation, validation } from '../../errors.js';
import { decimal } from '../../http/schemas.js';
import { emit } from '../../core/outbox.js';

export { PRODUCT_KINDS, productSchema, type ProductInput } from '@vortex/contracts';
import { productSchema, type ProductInput } from '@vortex/contracts';

/** Validações fiscais do cadastro: GTIN, NCM vigente, CEST compatível, cClassTrib existente. */
async function validateFiscal(tx: Tx, p: Partial<ProductInput>, kind: string, isParent: boolean) {
  const errs: Record<string, string> = {};
  if (p.gtin && !isValidGTINOrSemGTIN(p.gtin)) errs.gtin = 'GTIN/EAN inválido (dígito verificador)';
  if (kind !== 'service' && !isParent) {
    if (!p.ncm) errs.ncm = 'NCM obrigatório';
    else if (!isValidNCMFormat(p.ncm)) errs.ncm = 'NCM deve ter 8 dígitos';
    else {
      const ok = await tx.maybeOne(`SELECT 1 FROM fiscal.ncm WHERE code = $1 AND valid_from <= current_date AND (valid_to IS NULL OR valid_to >= current_date)`, [p.ncm]);
      if (!ok) errs.ncm = 'NCM não encontrado na tabela vigente';
    }
  }
  if (p.cest) {
    if (!isValidCESTFormat(p.cest)) errs.cest = 'CEST deve ter 7 dígitos';
    else {
      const c = await tx.maybeOne<{ ncm_prefixes: string[] }>(`SELECT ncm_prefixes FROM fiscal.cest WHERE code = $1`, [p.cest]);
      if (!c) errs.cest = 'CEST não encontrado';
      else if (p.ncm && c.ncm_prefixes.length && !c.ncm_prefixes.some((pre) => p.ncm!.startsWith(pre))) errs.cest = 'CEST incompatível com o NCM';
    }
  }
  if (p.cclasstrib) {
    const c = await tx.maybeOne(`SELECT 1 FROM fiscal.cclasstrib WHERE code = $1 AND (valid_to IS NULL OR valid_to >= current_date)`, [p.cclasstrib]);
    if (!c) errs.cclasstrib = 'cClassTrib não encontrado na tabela vigente';
  }
  if (kind === 'service' && !p.serviceCode) errs.serviceCode = 'Código de serviço (LC 116) obrigatório para serviço';
  if (Object.keys(errs).length) throw validation(errs);
}

async function sharedCompany(tx: Tx): Promise<string | null> {
  const t = await tx.one<{ settings: { sharing?: { products?: string } } }>(`SELECT settings FROM core.tenants WHERE id = $1`, [tx.tenantId]);
  return t.settings?.sharing?.products === 'company' ? tx.companyId : null;
}

export async function createProduct(tx: Tx, p: ProductInput, parent?: Record<string, any>) {
  await validateFiscal(tx, p, p.kind, p.isVariantParent);
  const companyId = parent?.company_id ?? (await sharedCompany(tx));
  const controlsStock = p.controlsStock ?? (p.kind !== 'service');
  const row = await tx.one(
    `INSERT INTO catalog.products (tenant_id, company_id, sku, description, short_description, gtin, manufacturer_code, brand_id, category_id, kind, parent_id,
       is_variant_parent, variant_attributes, ncm, cest, origin, tax_group, service_code, nbs, cclasstrib, own_production, stock_unit, sale_unit, taxable_unit,
       taxable_factor, controls_stock, controls_lot, controls_expiry, controls_serial, allow_negative_stock, gross_weight, net_weight, width_cm, height_cm, depth_cm,
       kit_explodes_stock, standard_cost, min_margin_percent, commission_percent, photos, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41)
     RETURNING *`,
    [tx.tenantId, companyId, p.sku, p.description, p.shortDescription ?? null, p.gtin ?? null, p.manufacturerCode ?? null, p.brandId ?? null, p.categoryId ?? null,
      p.kind, parent?.id ?? null, p.isVariantParent, JSON.stringify((p as { variantAttributes?: unknown }).variantAttributes ?? {}), p.ncm ?? null, p.cest ?? null, p.origin,
      p.taxGroup ?? null, p.serviceCode ?? null, p.nbs ?? null, p.cclasstrib ?? null, p.ownProduction, p.stockUnit, p.saleUnit ?? p.stockUnit, p.taxableUnit ?? null,
      p.taxableFactor, controlsStock, p.controlsLot || p.controlsExpiry, p.controlsExpiry, p.controlsSerial, p.allowNegativeStock, p.grossWeight ?? null, p.netWeight ?? null,
      p.widthCm ?? null, p.heightCm ?? null, p.depthCm ?? null, p.kitExplodesStock, p.standardCost, p.minMarginPercent ?? null, p.commissionPercent ?? null,
      JSON.stringify(p.photos), tx.userId]);
  return row;
}

/**
 * Grade: cada combinação (ex.: cor × tamanho) é um SKU com estoque e GTIN próprios,
 * herdando fiscal e preço do pai, com possibilidade de exceção.
 */
export const variantSchema = z.object({
  sku: z.string().min(1),
  attributes: z.record(z.string(), z.string()).refine((a) => Object.keys(a).length > 0, 'Informe os atributos da variação'),
  gtin: z.string().nullish(),
  description: z.string().max(120).optional(),
  overrides: productSchema.pick({ ncm: true, cest: true, origin: true, cclasstrib: true, taxGroup: true }).partial().default({}),
});

export async function createVariant(tx: Tx, parentId: string, v: z.infer<typeof variantSchema>) {
  const parent = await tx.one<Record<string, any>>(`SELECT * FROM catalog.products WHERE id = $1`, [parentId], 'Produto');
  if (!parent.is_variant_parent) throw validation({ parentId: 'O produto não é um produto pai de grade' });
  const attrs = Object.entries(v.attributes).map(([k, val]) => `${k}: ${val}`).join(', ');
  const dup = await tx.maybeOne(`SELECT id FROM catalog.products WHERE parent_id = $1 AND variant_attributes = $2::jsonb`, [parentId, JSON.stringify(v.attributes)]);
  if (dup) throw conflict('VARIANT_EXISTS', 'Já existe variação com estes atributos', { existingId: dup.id });
  const input: ProductInput & { variantAttributes: Record<string, string> } = {
    ...productSchema.parse({
      sku: v.sku, description: (v.description ?? `${parent.description} (${attrs})`).slice(0, 120), shortDescription: parent.short_description,
      gtin: v.gtin ?? null, brandId: parent.brand_id, categoryId: parent.category_id, kind: parent.kind === 'kit' ? 'goods' : parent.kind,
      ncm: v.overrides.ncm ?? parent.ncm, cest: v.overrides.cest ?? parent.cest, origin: v.overrides.origin ?? parent.origin,
      taxGroup: v.overrides.taxGroup ?? parent.tax_group, serviceCode: parent.service_code, nbs: parent.nbs, cclasstrib: v.overrides.cclasstrib ?? parent.cclasstrib,
      ownProduction: parent.own_production, stockUnit: parent.stock_unit, saleUnit: parent.sale_unit, taxableUnit: parent.taxable_unit, taxableFactor: parent.taxable_factor,
      controlsLot: parent.controls_lot, controlsExpiry: parent.controls_expiry, controlsSerial: parent.controls_serial, allowNegativeStock: parent.allow_negative_stock,
      minMarginPercent: parent.min_margin_percent, commissionPercent: parent.commission_percent,
    }),
    variantAttributes: v.attributes,
  };
  return createProduct(tx, input, parent);
}

export const productPatchSchema = productSchema.omit({ sku: true, kind: true, isVariantParent: true, standardCost: true }).partial().extend({ version: z.number().int(), status: z.enum(['active', 'inactive']).optional() });

const PATCH_COLUMNS: Record<string, string> = {
  description: 'description', shortDescription: 'short_description', gtin: 'gtin', manufacturerCode: 'manufacturer_code', brandId: 'brand_id', categoryId: 'category_id',
  ncm: 'ncm', cest: 'cest', origin: 'origin', taxGroup: 'tax_group', serviceCode: 'service_code', nbs: 'nbs', cclasstrib: 'cclasstrib', ownProduction: 'own_production',
  saleUnit: 'sale_unit', taxableUnit: 'taxable_unit', taxableFactor: 'taxable_factor', controlsStock: 'controls_stock', controlsLot: 'controls_lot',
  controlsExpiry: 'controls_expiry', controlsSerial: 'controls_serial', allowNegativeStock: 'allow_negative_stock', grossWeight: 'gross_weight', netWeight: 'net_weight',
  widthCm: 'width_cm', heightCm: 'height_cm', depthCm: 'depth_cm', kitExplodesStock: 'kit_explodes_stock', minMarginPercent: 'min_margin_percent',
  commissionPercent: 'commission_percent', photos: 'photos', status: 'status', stockUnit: 'stock_unit',
};

export async function updateProduct(tx: Tx, id: string, patch: z.infer<typeof productPatchSchema>) {
  const cur = await tx.one<Record<string, any>>(`SELECT * FROM catalog.products WHERE id = $1`, [id], 'Produto');
  if (cur.version !== patch.version) throw conflict('VERSION_CONFLICT', 'O produto foi alterado por outra pessoa. Recarregue e tente novamente.');
  if (patch.stockUnit && patch.stockUnit !== cur.stock_unit) {
    const moved = await tx.maybeOne(`SELECT 1 FROM inventory.stock_movements WHERE product_id = $1 LIMIT 1`, [id]);
    if (moved) throw ruleViolation('RN-GER-01', 'Unidade de estoque não pode mudar depois que o produto tem movimento');
  }
  const merged = {
    gtin: patch.gtin !== undefined ? patch.gtin : cur.gtin, ncm: patch.ncm !== undefined ? patch.ncm : cur.ncm, cest: patch.cest !== undefined ? patch.cest : cur.cest,
    cclasstrib: patch.cclasstrib !== undefined ? patch.cclasstrib : cur.cclasstrib, serviceCode: patch.serviceCode !== undefined ? patch.serviceCode : cur.service_code,
  };
  await validateFiscal(tx, merged as Partial<ProductInput>, cur.kind, cur.is_variant_parent);
  const sets: string[] = [];
  const vals: unknown[] = [id, patch.version];
  for (const [k, col] of Object.entries(PATCH_COLUMNS)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v !== undefined) {
      vals.push(k === 'photos' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return cur;
  const row = await tx.maybeOne(`UPDATE catalog.products SET ${sets.join(', ')} WHERE id = $1 AND version = $2 RETURNING *`, vals);
  if (!row) throw conflict('VERSION_CONFLICT', 'O produto foi alterado por outra pessoa. Recarregue e tente novamente.');
  // Propaga mudanças fiscais do pai para as variações que não têm exceção
  if (cur.is_variant_parent) {
    for (const [k, col] of [['ncm', 'ncm'], ['cest', 'cest'], ['origin', 'origin'], ['cclasstrib', 'cclasstrib'], ['taxGroup', 'tax_group']] as const) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) await tx.exec(`UPDATE catalog.products SET ${col} = $2 WHERE parent_id = $1 AND ${col} IS NOT DISTINCT FROM $3`, [id, v, cur[col]]);
    }
  }
  await emit(tx, 'produto.alterado', { type: 'product', id }, { id, sku: row.sku });
  return row;
}

export async function getProduct(tx: Tx, id: string) {
  const p = await tx.maybeOne(`SELECT * FROM catalog.products WHERE id = $1`, [id]);
  if (!p) throw notFound('Produto');
  // Consultas em sequência: o cliente da transação não executa consultas em paralelo.
  const conversions = await tx.query(`SELECT * FROM catalog.unit_conversions WHERE product_id = $1 ORDER BY unit`, [id]);
  const suppliers = await tx.query(`SELECT ps.*, pa.legal_name AS supplier_name FROM catalog.product_suppliers ps JOIN registry.parties pa ON pa.id = ps.supplier_id WHERE ps.product_id = $1`, [id]);
  const kit = await tx.query(`SELECT k.*, c.sku, c.description FROM catalog.kit_items k JOIN catalog.products c ON c.id = k.component_id WHERE k.kit_id = $1`, [id]);
  const variants = await tx.query(`SELECT id, sku, description, gtin, variant_attributes, status FROM catalog.products WHERE parent_id = $1 ORDER BY sku`, [id]);
  const stockParams = await tx.query(`SELECT * FROM catalog.stock_params WHERE product_id = $1`, [id]);
  return { ...p, conversions, suppliers, kitItems: kit, variants, stockParams };
}

export const kitSchema = z.object({
  items: z.array(z.object({ componentId: z.string().uuid(), quantity: decimal({ positive: true }), priceSharePercent: decimal({ min: 0 }) })).min(1),
});

/** Kit: componentes e rateio do preço na nota (percentuais somam 100). */
export async function setKitItems(tx: Tx, kitId: string, body: z.infer<typeof kitSchema>) {
  const kit = await tx.one<{ kind: string }>(`SELECT kind FROM catalog.products WHERE id = $1`, [kitId], 'Produto');
  if (kit.kind !== 'kit') throw validation({ kind: 'O produto não é um kit' });
  const total = sum(body.items.map((i) => i.priceSharePercent));
  if (!total.equals(100)) throw validation({ items: 'O rateio de preço dos componentes deve somar 100%' });
  const comps = await tx.query<{ id: string; kind: string }>(`SELECT id, kind FROM catalog.products WHERE id = ANY($1)`, [body.items.map((i) => i.componentId)]);
  if (comps.length !== body.items.length) throw validation({ items: 'Componente inexistente' });
  if (comps.some((c) => c.kind === 'kit')) throw validation({ items: 'Kit não pode conter outro kit' });
  await tx.exec(`DELETE FROM catalog.kit_items WHERE kit_id = $1`, [kitId]);
  for (const i of body.items) {
    await tx.exec(`INSERT INTO catalog.kit_items (tenant_id, kit_id, component_id, quantity, price_share_percent) VALUES ($1,$2,$3,$4,$5)`,
      [tx.tenantId, kitId, i.componentId, i.quantity, i.priceSharePercent]);
  }
  return tx.query(`SELECT * FROM catalog.kit_items WHERE kit_id = $1`, [kitId]);
}

/** Converte quantidade de uma unidade (venda/compra) para a unidade de estoque. */
export async function toStockUnit(tx: Tx, productId: string, unit: string, qty: string): Promise<{ qty: string; factor: string }> {
  const p = await tx.one<{ stock_unit: string }>(`SELECT stock_unit FROM catalog.products WHERE id = $1`, [productId], 'Produto');
  if (unit === p.stock_unit) return { qty, factor: '1' };
  const conv = await tx.maybeOne<{ factor: string }>(`SELECT factor FROM catalog.unit_conversions WHERE product_id = $1 AND unit = $2`, [productId, unit]);
  if (!conv) throw validation({ unit: `Unidade ${unit} sem conversão cadastrada para ${p.stock_unit}` });
  return { qty: D(qty).times(conv.factor).toFixed(4), factor: conv.factor };
}
