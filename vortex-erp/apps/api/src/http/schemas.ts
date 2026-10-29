import { z } from 'zod';

// Primitivas de entrada compartilhadas com o web app (validação por esquema nos dois lados)
export { uuid, decimal, cnpj, cpf, uf, cep, ibge, isoDate } from '@vortex/contracts';
import { uuid } from '@vortex/contracts';
export const idParams = z.object({ id: uuid });

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
  q: z.string().optional(),
});

/** Paginação por cursor (seção 23): cursor = base64 de "<created_at>|<id>". */
export function decodeCursor(cursor?: string): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!at || !id) return null;
    return { at, id };
  } catch {
    return null;
  }
}

export function encodeCursor(row: { created_at: Date | string; id: string }): string {
  const at = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return Buffer.from(`${at}|${row.id}`, 'utf8').toString('base64url');
}

export function page<T extends { created_at: Date | string; id: string }>(rows: T[], limit: number): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]!) : null };
}

/** JSON Schema (OpenAPI 3.0) de um esquema zod, só para documentação; a validação continua no zod. */
export const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
