import { z } from 'zod';
import { cleanDoc, isUF, isValidCNPJ, isValidCPF, onlyDigits } from '@vortex/validators';

export const uuid = z.string().uuid('UUID inválido');

/** Decimal como texto (nunca float): aceita "10.50", "10,50" ou número JSON. */
export const decimal = (opts: { min?: number; positive?: boolean } = {}) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s = String(v).trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Número decimal inválido' });
      return z.NEVER;
    }
    if (opts.positive && Number(s) <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Deve ser maior que zero' });
      return z.NEVER;
    }
    if (opts.min !== undefined && Number(s) < opts.min) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Deve ser no mínimo ${opts.min}` });
      return z.NEVER;
    }
    return s;
  });

export const cnpj = z.string().transform(cleanDoc).refine(isValidCNPJ, 'CNPJ inválido');
export const cpf = z.string().transform(onlyDigits).refine(isValidCPF, 'CPF inválido');
export const uf = z.string().length(2).transform((s) => s.toUpperCase()).refine(isUF, 'UF inválida');
export const cep = z.string().transform(onlyDigits).refine((s) => s.length === 8, 'CEP deve ter 8 dígitos');
export const ibge = z.string().regex(/^\d{7}$/, 'Código IBGE do município deve ter 7 dígitos');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data no formato AAAA-MM-DD');
