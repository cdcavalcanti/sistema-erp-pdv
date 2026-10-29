/**
 * Erros com código estável, mensagem em português e detalhes por campo (seção 23).
 * Erros fiscais incluem o código da SEFAZ em `details.sefazCode`.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} não encontrado(a)`, 404);
export const forbidden = (msg = 'Sem permissão para esta ação', details?: Record<string, unknown>) => new AppError('FORBIDDEN', msg, 403, details);
export const conflict = (code: string, msg: string, details?: Record<string, unknown>) => new AppError(code, msg, 409, details);
/** Violação de regra de negócio: o código RN- vai junto para rastreabilidade. */
export const ruleViolation = (rule: string, msg: string, details?: Record<string, unknown>) =>
  new AppError('BUSINESS_RULE', msg, 422, { rule, ...details });
export const validation = (fields: Record<string, string>) =>
  new AppError('VALIDATION', 'Dados inválidos', 422, { fields });

export function assert(cond: unknown, rule: string, msg: string, details?: Record<string, unknown>): asserts cond {
  if (!cond) throw ruleViolation(rule, msg, details);
}

interface PgError { code?: string; constraint?: string; detail?: string; hint?: string; message: string; table?: string; column?: string }

export function mapDbError(err: unknown): AppError | null {
  const e = err as PgError;
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case '23505':
      return conflict('DUPLICATE', 'Registro duplicado', { constraint: e.constraint, detail: e.detail });
    case '23503':
      return new AppError('REFERENCE', 'Referência inválida ou registro em uso', 422, { constraint: e.constraint, detail: e.detail });
    case '23514':
      return new AppError('CHECK', 'Valor fora das regras do campo', 422, { constraint: e.constraint });
    case '23P01':
      return conflict('OVERLAP', 'Período sobreposto a outro registro', { constraint: e.constraint });
    case '23502':
      return new AppError('VALIDATION', 'Campo obrigatório ausente', 422, { fields: { [e.column ?? 'campo']: 'obrigatório' } });
    case '42501':
      return forbidden('Operação bloqueada pela política de acesso');
    case 'P0001': {
      if (e.hint === 'IMMUTABLE') return conflict('IMMUTABLE_RECORD', e.message);
      const m = /^(RN-[A-Z]+-\d+):\s*(.*)$/s.exec(e.message);
      if (m) return ruleViolation(m[1]!, m[2]!);
      return new AppError('DB_RULE', e.message, 422);
    }
    default:
      return null;
  }
}
