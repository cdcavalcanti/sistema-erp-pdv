import { z } from 'zod';

type Issue = Parameters<NonNullable<z.core.$ZodConfig['customError']>>[0];

const FORMATS: Record<string, string> = {
  uuid: 'Identificador (UUID) inválido',
  guid: 'Identificador (UUID) inválido',
  email: 'E-mail inválido',
  url: 'URL inválida',
  datetime: 'Data e hora inválidas (ISO 8601 com fuso)',
  date: 'Data inválida',
  regex: 'Formato inválido',
};

function messagePt(issue: Issue): string | undefined {
  const missing = issue.input === undefined || issue.input === null;
  if (missing && (issue.code === 'invalid_type' || issue.code === 'invalid_value' || issue.code === 'invalid_union')) return 'Campo obrigatório';
  switch (issue.code) {
    case 'invalid_type':
      return `Tipo inválido: esperado ${issue.expected}`;
    case 'invalid_format':
      return FORMATS[issue.format] ?? 'Texto inválido';
    case 'too_small':
      if (issue.origin === 'string') return `Deve ter no mínimo ${issue.minimum} caractere(s)`;
      if (issue.origin === 'array' || issue.origin === 'set') return `Informe no mínimo ${issue.minimum} item(ns)`;
      return `Deve ser no mínimo ${issue.minimum}`;
    case 'too_big':
      if (issue.origin === 'string') return `Deve ter no máximo ${issue.maximum} caractere(s)`;
      if (issue.origin === 'array' || issue.origin === 'set') return `Informe no máximo ${issue.maximum} item(ns)`;
      return `Deve ser no máximo ${issue.maximum}`;
    case 'invalid_value':
      return issue.values.length === 1 ? 'Valor inválido' : `Valor inválido; aceitos: ${issue.values.map(String).join(', ')}`;
    case 'invalid_union':
      return 'Tipo inválido';
    case 'unrecognized_keys':
      return `Campos não reconhecidos: ${issue.keys.join(', ')}`;
    case 'not_multiple_of':
      return `Deve ser múltiplo de ${issue.divisor}`;
    case 'invalid_key':
    case 'invalid_element':
      return 'Valor inválido';
    default:
      return undefined;
  }
}

/**
 * Mensagens de validação em português (seção 23), iguais na API e na web.
 * Mensagens definidas no próprio esquema (ex.: `.min(1, 'Inclua ao menos um item')`) têm precedência.
 */
export function installPtBrMessages(): void {
  z.config({ customError: messagePt });
}
