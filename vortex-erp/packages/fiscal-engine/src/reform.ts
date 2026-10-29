import type { IbsCbsRates, TransitionYear } from './types.js';

/**
 * Cronograma da reforma tributária do consumo (EC 132/2023, LC 214/2025) — seção 08.
 * É tabela, não código: a API carrega a versão vigente de fiscal.tax_transition;
 * este cronograma é o padrão usado quando a tabela não tem o ano.
 */
export const TRANSITION_SCHEDULE: Record<number, Omit<TransitionYear, 'year'>> = {
  2026: { icmsIssFactor: '1', pisCofinsActive: true, ipiActive: true, ibsCbsInformative: true, isActive: false },
  2027: { icmsIssFactor: '1', pisCofinsActive: false, ipiActive: false, ibsCbsInformative: false, isActive: true },
  2028: { icmsIssFactor: '1', pisCofinsActive: false, ipiActive: false, ibsCbsInformative: false, isActive: true },
  2029: { icmsIssFactor: '0.9', pisCofinsActive: false, ipiActive: false, ibsCbsInformative: false, isActive: true },
  2030: { icmsIssFactor: '0.8', pisCofinsActive: false, ipiActive: false, ibsCbsInformative: false, isActive: true },
  2031: { icmsIssFactor: '0.7', pisCofinsActive: false, ipiActive: false, ibsCbsInformative: false, isActive: true },
  2032: { icmsIssFactor: '0.6', pisCofinsActive: false, ipiActive: false, ibsCbsInformative: false, isActive: true },
  2033: { icmsIssFactor: '0', pisCofinsActive: false, ipiActive: false, ibsCbsInformative: false, isActive: true },
};

export function transitionFor(date: string): TransitionYear {
  const year = Number(date.slice(0, 4));
  if (year < 2026) return { year, icmsIssFactor: '1', pisCofinsActive: true, ipiActive: true, ibsCbsInformative: true, isActive: false };
  const y = Math.min(year, 2033);
  return { year, ...TRANSITION_SCHEDULE[y]! };
}

/**
 * Alíquotas de referência de IBS/CBS por ano. 2026 é o ano de teste (CBS 0,9% e IBS 0,1%);
 * 2027–2028: CBS cheia e IBS simbólico (0,05% + 0,05%). As alíquotas de referência
 * definitivas são fixadas pelo Senado/Comitê Gestor: os valores de 2027 em diante
 * são PLACEHOLDERS e precisam vir da tabela fiscal.ibs_cbs_rates validada.
 */
export const REFERENCE_IBS_CBS: Record<number, IbsCbsRates> = {
  2026: { cbs: '0.9', ibsUf: '0.1', ibsMun: '0' },
  2027: { cbs: '8.8', ibsUf: '0.05', ibsMun: '0.05' },
  2028: { cbs: '8.8', ibsUf: '0.05', ibsMun: '0.05' },
  2029: { cbs: '8.8', ibsUf: '1.0', ibsMun: '0.8' },
  2030: { cbs: '8.8', ibsUf: '2.0', ibsMun: '1.6' },
  2031: { cbs: '8.8', ibsUf: '3.0', ibsMun: '2.4' },
  2032: { cbs: '8.8', ibsUf: '4.0', ibsMun: '3.2' },
  2033: { cbs: '8.8', ibsUf: '10.0', ibsMun: '8.0' },
};

export function referenceIbsCbs(date: string): IbsCbsRates | null {
  const year = Number(date.slice(0, 4));
  if (year < 2026) return null;
  return REFERENCE_IBS_CBS[Math.min(year, 2033)]!;
}
