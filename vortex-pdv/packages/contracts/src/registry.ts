import { z } from 'zod';
import { onlyDigits } from '@vortex/validators';
import { decimal } from './primitives.js';

export const PARTY_ROLES = ['customer', 'supplier', 'carrier', 'salesperson', 'employee', 'partner'] as const;

export const addressSchema = z.object({
  kind: z.enum(['fiscal', 'delivery', 'billing']).default('fiscal'),
  zip: z.string().transform(onlyDigits).nullish(),
  street: z.string().min(2),
  number: z.string().min(1),
  complement: z.string().nullish(),
  district: z.string().min(1),
  cityIbge: z.string().regex(/^\d{7}$/).nullish(),
  cityName: z.string().min(2),
  uf: z.string().length(2).transform((s) => s.toUpperCase()).nullish(),
  countryCode: z.string().regex(/^\d{4}$/).default('1058'),
  isDefault: z.boolean().default(true),
});

export const contactSchema = z.object({
  name: z.string().min(2),
  jobTitle: z.string().nullish(),
  phone: z.string().nullish(),
  whatsapp: z.string().nullish(),
  email: z.string().email().nullish(),
  consents: z.record(z.string(), z.boolean()).default({}),
  preferredChannel: z.enum(['email', 'whatsapp', 'phone']).nullish(),
});

export const partySchema = z.object({
  kind: z.enum(['PF', 'PJ', 'EX']),
  taxId: z.string().nullish(),
  foreignId: z.string().nullish(),
  legalName: z.string().min(2),
  tradeName: z.string().nullish(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  roles: z.array(z.enum(PARTY_ROLES)).min(1),
  ieIndicator: z.union([z.literal(1), z.literal(2), z.literal(9)]).default(9),
  ie: z.string().nullish(),
  im: z.string().nullish(),
  suframa: z.string().nullish(),
  taxRegime: z.enum(['simples_nacional', 'mei', 'normal']).nullish(),
  finalConsumer: z.boolean().optional(),
  xmlEmail: z.string().email().nullish(),
  priceListId: z.string().uuid().nullish(),
  salespersonId: z.string().uuid().nullish(),
  paymentTermId: z.string().uuid().nullish(),
  segment: z.string().nullish(),
  carrierId: z.string().uuid().nullish(),
  creditLimit: decimal({ min: 0 }).default('0'),
  riskClass: z.enum(['A', 'B', 'C', 'D', 'E']).nullish(),
  paymentMethodId: z.string().uuid().nullish(),
  ledgerAccountId: z.string().uuid().nullish(),
  costCenterId: z.string().uuid().nullish(),
  lgpdPurpose: z.string().nullish(),
  notes: z.string().nullish(),
  addresses: z.array(addressSchema).default([]),
  contacts: z.array(contactSchema).default([]),
});
export type PartyInput = z.infer<typeof partySchema>;
