import { D, round, type Decimal } from '@vortex/money';
import { UF_REGION, type UF } from '@vortex/validators';

/**
 * Alíquota interestadual de ICMS (Res. Senado 22/1989 e 13/2012):
 * - 4% para mercadoria importada ou com conteúdo de importação > 40% (origens 1, 2, 3 e 8);
 * - 7% de S/SE (exceto ES) para N, NE, CO e ES;
 * - 12% nos demais casos.
 */
export function interstateIcmsRate(ufOrigin: UF, ufDest: UF, origin: number): string {
  if ([1, 2, 3, 8].includes(origin)) return '4';
  const southSoutheast = (uf: UF) => (UF_REGION[uf] === 'S' || UF_REGION[uf] === 'SE') && uf !== 'ES';
  if (southSoutheast(ufOrigin) && !southSoutheast(ufDest)) return '7';
  return '12';
}

/**
 * Alíquotas internas modais de referência por UF. SÃO DADOS DE REFERÊNCIA: a
 * parametrização de cada cliente vem das regras fiscais validadas pelo contador e
 * da tabela fiscal.icms_internal_rates (com vigência), que prevalecem sobre estes valores.
 */
export const REFERENCE_ICMS_INTERNAL_RATES: Record<UF, string> = {
  AC: '19', AL: '20', AM: '20', AP: '18', BA: '20.5', CE: '20', DF: '20', ES: '17', GO: '19', MA: '23', MG: '18', MS: '17', MT: '17',
  PA: '19', PB: '20', PE: '20.5', PI: '22.5', PR: '19.5', RJ: '20', RN: '20', RO: '19.5', RR: '20', RS: '17', SC: '17', SE: '20', SP: '18', TO: '20',
};

// ------------------------------------------------------------------ Simples Nacional (LC 123/2006, redação da LC 155/2016)

export type SimplesAnnex = 'I' | 'II' | 'III' | 'IV' | 'V';

interface Bracket {
  upTo: number;
  rate: string;
  deduction: string;
  /** Parcela do ICMS na alíquota efetiva (%), quando houver */
  icmsShare?: string;
}

export const SIMPLES_ANNEXES: Record<SimplesAnnex, Bracket[]> = {
  I: [
    { upTo: 180_000, rate: '4', deduction: '0', icmsShare: '34' },
    { upTo: 360_000, rate: '7.3', deduction: '5940', icmsShare: '34' },
    { upTo: 720_000, rate: '9.5', deduction: '13860', icmsShare: '33.5' },
    { upTo: 1_800_000, rate: '10.7', deduction: '22500', icmsShare: '33.5' },
    { upTo: 3_600_000, rate: '14.3', deduction: '87300', icmsShare: '33.5' },
    { upTo: 4_800_000, rate: '19', deduction: '378000' },
  ],
  II: [
    { upTo: 180_000, rate: '4.5', deduction: '0', icmsShare: '32' },
    { upTo: 360_000, rate: '7.8', deduction: '5940', icmsShare: '32' },
    { upTo: 720_000, rate: '10', deduction: '13860', icmsShare: '32' },
    { upTo: 1_800_000, rate: '11.2', deduction: '22500', icmsShare: '32' },
    { upTo: 3_600_000, rate: '14.7', deduction: '85500', icmsShare: '32' },
    { upTo: 4_800_000, rate: '30', deduction: '720000' },
  ],
  III: [
    { upTo: 180_000, rate: '6', deduction: '0' },
    { upTo: 360_000, rate: '11.2', deduction: '9360' },
    { upTo: 720_000, rate: '13.5', deduction: '17640' },
    { upTo: 1_800_000, rate: '16', deduction: '35640' },
    { upTo: 3_600_000, rate: '21', deduction: '125640' },
    { upTo: 4_800_000, rate: '33', deduction: '648000' },
  ],
  IV: [
    { upTo: 180_000, rate: '4.5', deduction: '0' },
    { upTo: 360_000, rate: '9', deduction: '8100' },
    { upTo: 720_000, rate: '10.2', deduction: '12420' },
    { upTo: 1_800_000, rate: '14', deduction: '39780' },
    { upTo: 3_600_000, rate: '22', deduction: '183780' },
    { upTo: 4_800_000, rate: '33', deduction: '828000' },
  ],
  V: [
    { upTo: 180_000, rate: '15.5', deduction: '0' },
    { upTo: 360_000, rate: '18', deduction: '4500' },
    { upTo: 720_000, rate: '19.5', deduction: '9900' },
    { upTo: 1_800_000, rate: '20.5', deduction: '17100' },
    { upTo: 3_600_000, rate: '23', deduction: '62100' },
    { upTo: 4_800_000, rate: '30.5', deduction: '540000' },
  ],
};

export interface SimplesEffective {
  bracket: number;
  nominalRate: Decimal;
  deduction: Decimal;
  /** Alíquota efetiva (%) = (RBT12 × Aliq − PD) ÷ RBT12 */
  effectiveRate: Decimal;
  /** pCredSN: parcela do ICMS na alíquota efetiva (%), para CSOSN 101/201 */
  icmsCreditRate: Decimal | null;
}

/**
 * Alíquota efetiva do Simples Nacional a partir da receita bruta dos últimos 12 meses (RBT12).
 * O ERP guarda a receita para calcular a alíquota e o crédito de ICMS informado (seção 07).
 */
export function simplesEffectiveRate(rbt12: string, annex: SimplesAnnex): SimplesEffective {
  const rb = D(rbt12);
  if (rb.lessThanOrEqualTo(0)) {
    const b = SIMPLES_ANNEXES[annex][0]!;
    return { bracket: 1, nominalRate: D(b.rate), deduction: D(0), effectiveRate: D(b.rate), icmsCreditRate: b.icmsShare ? round(D(b.rate).times(b.icmsShare).dividedBy(100), 4) : null };
  }
  const brackets = SIMPLES_ANNEXES[annex];
  const idx = brackets.findIndex((b) => rb.lessThanOrEqualTo(b.upTo));
  if (idx < 0) throw new RangeError('Receita bruta acima do limite do Simples Nacional (R$ 4,8 milhões)');
  const b = brackets[idx]!;
  const effective = rb.times(b.rate).dividedBy(100).minus(b.deduction).dividedBy(rb).times(100);
  return {
    bracket: idx + 1,
    nominalRate: D(b.rate),
    deduction: D(b.deduction),
    effectiveRate: round(effective, 4),
    icmsCreditRate: b.icmsShare ? round(effective.times(b.icmsShare).dividedBy(100), 4) : null,
  };
}

// ------------------------------------------------------------------ descrições de CST (para a memória de cálculo e a tela)

export const ICMS_CST: Record<string, string> = {
  '00': 'Tributada integralmente', '02': 'Tributação monofásica própria sobre combustíveis', '10': 'Tributada e com cobrança do ICMS por ST',
  '15': 'Tributação monofásica própria e com responsabilidade pela retenção sobre combustíveis', '20': 'Com redução de base de cálculo',
  '30': 'Isenta ou não tributada e com cobrança do ICMS por ST', '40': 'Isenta', '41': 'Não tributada', '50': 'Suspensão', '51': 'Diferimento',
  '53': 'Tributação monofásica sobre combustíveis com recolhimento diferido', '60': 'ICMS cobrado anteriormente por ST',
  '61': 'Tributação monofásica sobre combustíveis cobrada anteriormente', '70': 'Com redução de base de cálculo e cobrança do ICMS por ST', '90': 'Outras',
};

export const CSOSN: Record<string, string> = {
  '101': 'Tributada pelo Simples Nacional com permissão de crédito', '102': 'Tributada pelo Simples Nacional sem permissão de crédito',
  '103': 'Isenção do ICMS no Simples Nacional para faixa de receita bruta', '201': 'Tributada pelo Simples Nacional com permissão de crédito e com cobrança do ICMS por ST',
  '202': 'Tributada pelo Simples Nacional sem permissão de crédito e com cobrança do ICMS por ST', '203': 'Isenção do ICMS no Simples Nacional para faixa de receita bruta e com cobrança do ICMS por ST',
  '300': 'Imune', '400': 'Não tributada pelo Simples Nacional', '500': 'ICMS cobrado anteriormente por ST ou por antecipação', '900': 'Outros',
};

export const ICMS_CST_WITH_ST = new Set(['10', '30', '70', '90']);
export const CSOSN_WITH_ST = new Set(['201', '202', '203', '900']);
export const ICMS_CST_TAXED = new Set(['00', '10', '20', '51', '70', '90']);
export const ICMS_CST_EXEMPT = new Set(['30', '40', '41', '50', '60']);
