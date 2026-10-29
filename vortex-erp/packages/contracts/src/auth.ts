import { z } from 'zod';

export const loginSchema = z.object({
  tenant: z.string().min(3, 'Informe o identificador da empresa'),
  email: z.string().email('E-mail inválido'),
  password: z.string().min(1, 'Informe a senha'),
  totp: z.string().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;
