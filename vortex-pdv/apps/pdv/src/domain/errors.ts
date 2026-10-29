/**
 * Erro de regra do PDV com código estável (a interface decide o que mostrar) e mensagem em
 * português para o operador. `needsAuthorization` indica que um supervisor pode liberar.
 */
export class PdvError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new PdvError('NOT_FOUND', `${what} não encontrado`, 404);
export const invalid = (message: string, details: Record<string, unknown> = {}) => new PdvError('VALIDATION', message, 422, details);
export const conflict = (code: string, message: string) => new PdvError(code, message, 409);
export const forbidden = (message: string, permission?: string) => new PdvError('FORBIDDEN', message, 403, permission ? { permission } : {});
/** Ação permitida com autorização de quem tem a permissão (PIN do supervisor). */
export const needsAuthorization = (permission: string, message: string, details: Record<string, unknown> = {}) =>
  new PdvError('AUTHORIZATION_REQUIRED', message, 403, { permission, ...details });
