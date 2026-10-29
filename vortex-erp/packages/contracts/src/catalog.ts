import { z } from 'zod';
import { decimal } from './primitives.js';

export const PRODUCT_KINDS = ['goods', 'raw_material', 'finished', 'service', 'kit', 'fixed_asset', 'consumable', 'packaging'] as const;

export const productSchema = z.object({
  sku: z.string().min(1).max(60),
  description: z.string().min(2).max(120),
  shortDescription: z.string().max(40).nullish(),
  gtin: z.string().nullish(),
  manufacturerCode: z.string().nullish(),
  brandId: z.string().uuid().nullish(),
  categoryId: z.string().uuid().nullish(),
  kind: z.enum(PRODUCT_KINDS).default('goods'),
  isVariantParent: z.boolean().default(false),
  ncm: z.string().nullish(),
  cest: z.string().nullish(),
  origin: z.number().int().min(0).max(8).default(0),
  taxGroup: z.string().nullish(),
  serviceCode: z.string().nullish(),
  nbs: z.string().nullish(),
  cclasstrib: z.string().regex(/^\d{6}$/).nullish(),
  ownProduction: z.boolean().default(false),
  stockUnit: z.string().default('UN'),
  saleUnit: z.string().optional(),
  taxableUnit: z.string().nullish(),
  taxableFactor: decimal({ positive: true }).default('1'),
  controlsStock: z.boolean().optional(),
  controlsLot: z.boolean().default(false),
  controlsExpiry: z.boolean().default(false),
  controlsSerial: z.boolean().default(false),
  allowNegativeStock: z.boolean().default(false),
  grossWeight: decimal({ min: 0 }).nullish(),
  netWeight: decimal({ min: 0 }).nullish(),
  widthCm: decimal({ min: 0 }).nullish(),
  heightCm: decimal({ min: 0 }).nullish(),
  depthCm: decimal({ min: 0 }).nullish(),
  kitExplodesStock: z.boolean().default(true),
  standardCost: decimal({ min: 0 }).default('0'),
  minMarginPercent: decimal().nullish(),
  commissionPercent: decimal({ min: 0 }).nullish(),
  photos: z.array(z.string().url()).default([]),
});
export type ProductInput = z.infer<typeof productSchema>;
