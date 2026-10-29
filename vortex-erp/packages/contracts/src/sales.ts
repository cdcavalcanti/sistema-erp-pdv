import { z } from 'zod';
import { decimal, isoDate } from './primitives.js';

export const SALES_CHANNELS = ['counter', 'ecommerce', 'marketplace', 'crm', 'whatsapp', 'api', 'pdv', 'wholesale'] as const;

export const orderItemSchema = z.object({
  productId: z.string().uuid(), quantity: decimal({ positive: true }), unit: z.string().optional(), unitPrice: decimal({ min: 0 }).optional(),
  discountPercent: decimal({ min: 0 }).optional(), lotId: z.string().uuid().nullish(), notes: z.string().nullish(),
});

export const salesOrderSchema = z.object({
  establishmentId: z.string().uuid(), warehouseId: z.string().uuid().nullish(), partyId: z.string().uuid(), salespersonId: z.string().uuid().nullish(),
  channel: z.enum(SALES_CHANNELS).default('counter'), externalId: z.string().nullish(),
  operationTypeCode: z.string().default('VENDA'), paymentTermId: z.string().uuid().nullish(), paymentMethodId: z.string().uuid().nullish(),
  freightMode: z.number().int().min(0).max(9).optional(), carrierId: z.string().uuid().nullish(), freight: decimal({ min: 0 }).optional(), insurance: decimal({ min: 0 }).optional(),
  otherExpenses: decimal({ min: 0 }).optional(), discount: decimal({ min: 0 }).optional(), items: z.array(orderItemSchema).min(1, 'Inclua ao menos um item'),
  deliveryAddress: z.record(z.string(), z.unknown()).nullish(), expectedDelivery: isoDate.nullish(), customerOrderRef: z.string().nullish(), notes: z.string().nullish(), submit: z.boolean().default(true),
});
export type SalesOrderInput = z.input<typeof salesOrderSchema>;
