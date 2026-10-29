/** Unidades federativas com código IBGE (cUF da NF-e). */
export const UFS = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35',
  PR: '41', SC: '42', RS: '43',
  MS: '50', MT: '51', GO: '52', DF: '53',
} as const;
export type UF = keyof typeof UFS;
export const UF_LIST = Object.keys(UFS) as UF[];
export const isUF = (v: string): v is UF => v in UFS;
export const ufFromCode = (code: string): UF | undefined =>
  (Object.entries(UFS) as [UF, string][]).find(([, c]) => c === code)?.[0];

/** Região (usada para alíquota interestadual de 7% × 12% do ICMS). */
export const UF_REGION: Record<UF, 'N' | 'NE' | 'CO' | 'SE' | 'S'> = {
  RO: 'N', AC: 'N', AM: 'N', RR: 'N', PA: 'N', AP: 'N', TO: 'N',
  MA: 'NE', PI: 'NE', CE: 'NE', RN: 'NE', PB: 'NE', PE: 'NE', AL: 'NE', SE: 'NE', BA: 'NE',
  MG: 'SE', ES: 'SE', RJ: 'SE', SP: 'SE',
  PR: 'S', SC: 'S', RS: 'S',
  MS: 'CO', MT: 'CO', GO: 'CO', DF: 'CO',
};
