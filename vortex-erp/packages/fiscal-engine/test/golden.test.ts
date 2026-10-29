import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { D, sum } from '@vortex/money';
import type { UF } from '@vortex/validators';
import { calculate, findConflicts, simplesEffectiveRate, interstateIcmsRate } from '../src/index.js';
import { GOLDEN } from './golden.cases.js';
import { item, op, rule } from './fixtures.js';

describe('Testes dourados fiscais (casos calculados à mão)', () => {
  for (const c of GOLDEN) {
    it(`${c.id} — ${c.title}`, () => {
      if (c.expectError) {
        expect(() => calculate(c.input)).toThrow(c.expectError);
        return;
      }
      const r = calculate(c.input);
      expect(r).toMatchObject(c.expect!);
    });
  }
});

/**
 * Matriz gerada: regime × par de UFs × valor × origem. O "oráculo" abaixo é uma
 * reimplementação independente e direta das fórmulas (sem passar pelo motor),
 * conferindo ICMS, PIS/Cofins e IBS/CBS de 2026.
 */
const UF_PAIRS: [UF, UF][] = [['SP', 'SP'], ['SP', 'PE'], ['PE', 'SP'], ['MG', 'BA'], ['RS', 'SC'], ['PR', 'AM'], ['ES', 'RJ'], ['SP', 'ES']];
const INTERNAL: Record<string, string> = { SP: '18', PE: '20.5', MG: '18', BA: '20.5', RS: '17', SC: '17', PR: '19.5', AM: '20', ES: '17', RJ: '20' };

function oracle(regime: 'lucro_presumido' | 'lucro_real', from: UF, to: UF, value: string, origin: number) {
  const half = (x: ReturnType<typeof D>) => x.toDecimalPlaces(2, 4 /* ROUND_HALF_UP */);
  let rate: string;
  if (from === to) rate = INTERNAL[from]!;
  else if ([1, 2, 3, 8].includes(origin)) rate = '4';
  else if (['SP', 'MG', 'RJ', 'PR', 'RS', 'SC'].includes(from) && !['SP', 'MG', 'RJ', 'PR', 'RS', 'SC'].includes(to)) rate = '7';
  else rate = '12';
  const v = D(value);
  const icms = half(v.times(rate).dividedBy(100));
  const [pp, cp] = regime === 'lucro_presumido' ? ['0.65', '3'] : ['1.65', '7.6'];
  const pis = half(v.minus(icms).times(pp).dividedBy(100));
  const cof = half(v.minus(icms).times(cp).dividedBy(100));
  const ibsBase = v.minus(icms).minus(pis).minus(cof);
  return {
    rate, icms: icms.toFixed(2), pis: pis.toFixed(2), cofins: cof.toFixed(2), ibsBase: ibsBase.toFixed(2),
    cbs: half(ibsBase.times('0.9').dividedBy(100)).toFixed(2), ibsUf: half(ibsBase.times('0.1').dividedBy(100)).toFixed(2),
  };
}

describe('Matriz dourada gerada (regime × UF × valor × origem)', () => {
  const cases: [string, 'lucro_presumido' | 'lucro_real', UF, UF, string, number][] = [];
  for (const regime of ['lucro_presumido', 'lucro_real'] as const)
    for (const [from, to] of UF_PAIRS)
      for (const value of ['100.00', '999.99', '12345.67'])
        for (const origin of [0, 1]) cases.push([`${regime} ${from}→${to} ${value} origem ${origin}`, regime, from, to, value, origin]);

  it.each(cases)('%s', (_name, regime, from, to, value, origin) => {
    const exp = oracle(regime, from, to, value, origin);
    const r = calculate(op({
      issuer: { uf: from, cityIbge: '0000000', regime },
      recipient: { uf: to, ieIndicator: 1, finalConsumer: false },
      items: [item({ unitPrice: value, origin })],
      tables: { icmsInternalRates: INTERNAL as never },
    }));
    const t = r.items[0]!.taxes;
    expect(t.icms.rate).toBe(D(exp.rate).toFixed(4));
    expect(t.icms.value).toBe(exp.icms);
    expect(t.pis.value).toBe(exp.pis);
    expect(t.cofins.value).toBe(exp.cofins);
    expect(t.ibsCbs!.base).toBe(exp.ibsBase);
    expect(t.ibsCbs!.cbs.value).toBe(exp.cbs);
    expect(t.ibsCbs!.ibsUf.value).toBe(exp.ibsUf);
    expect(r.items[0]!.cfop).toBe(from === to ? '5102' : '6102');
  });

  it('a matriz tem pelo menos 90 casos (meta da fase 1: 100+ com os casos manuais)', () => {
    expect(cases.length + GOLDEN.length).toBeGreaterThanOrEqual(100);
  });
});

/**
 * Matriz V1 (meta: 300+ casos). Alíquotas internas modais das 27 UFs digitadas aqui, à parte da
 * tabela do motor, e entregues como dado de entrada: o teste confere a regra, não a tabela.
 */
const ALL_UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'] as UF[];
const INTERNAL_27: Record<string, string> = {
  AC: '19', AL: '20', AM: '20', AP: '18', BA: '20.5', CE: '20', DF: '20', ES: '17', GO: '19', MA: '23', MG: '18', MS: '17', MT: '17', PA: '19', PB: '20', PE: '20.5',
  PI: '22.5', PR: '19.5', RJ: '20', RN: '20', RO: '19.5', RR: '20', RS: '17', SC: '17', SE: '20', SP: '18', TO: '20',
};
const SOUTH_SOUTHEAST = ['SP', 'MG', 'RJ', 'PR', 'RS', 'SC'];
/** Resolução SF 22/1989 e 13/2012: 4% importado; 7% de S/SE (exceto ES) para N/NE/CO/ES; 12% nos demais. */
function interstate(from: string, to: string, origin: number): string {
  if ([1, 2, 3, 8].includes(origin)) return '4';
  return SOUTH_SOUTHEAST.includes(from) && !SOUTH_SOUTHEAST.includes(to) ? '7' : '12';
}
const half = (x: ReturnType<typeof D>) => x.toDecimalPlaces(2, 4);

describe('Matriz V1: DIFAL para não contribuinte (EC 87/2015, LC 190/2022), base única', () => {
  const difalCases: [string, UF, UF, number][] = [];
  for (const from of ['SP', 'PE', 'RS'] as UF[])
    for (const to of ALL_UFS.filter((u) => u !== from))
      for (const origin of [0, 1]) difalCases.push([`${from}→${to} origem ${origin}`, from, to, origin]);

  it.each(difalCases)('%s', (_n, from, to, origin) => {
    const value = D('250.00');
    const inter = interstate(from, to, origin);
    const r = calculate(op({
      issuer: { uf: from, cityIbge: '0000000', regime: 'lucro_presumido' }, recipient: { uf: to, ieIndicator: 9, finalConsumer: true },
      items: [item({ unitPrice: value.toFixed(2), origin })], tables: { icmsInternalRates: INTERNAL_27 as never },
    }));
    const t = r.items[0]!.taxes;
    expect(r.items[0]!.cfop).toBe('6108');
    expect(t.icms.rate).toBe(D(inter).toFixed(4));
    expect(t.icms.value).toBe(half(value.times(inter).dividedBy(100)).toFixed(2));
    expect(t.difal).toMatchObject({ base: '250.00', destRate: D(INTERNAL_27[to]!).toFixed(4), interstateRate: D(inter).toFixed(4),
      value: half(value.times(D(INTERNAL_27[to]!).minus(inter)).dividedBy(100)).toFixed(2) });
  });

  it('Simples Nacional vendendo a não contribuinte de outra UF não recolhe DIFAL (STF, ADI 5464)', () => {
    const r = calculate(op({ issuer: { uf: 'SP', cityIbge: '3550308', regime: 'simples_nacional' }, recipient: { uf: 'BA', ieIndicator: 9, finalConsumer: true } }));
    expect(r.items[0]!.taxes.difal).toBeNull();
  });
});

describe('Matriz V1: Simples Nacional (CSOSN 102) para contribuinte em cada UF', () => {
  it.each(ALL_UFS.map((u) => [u] as [UF]))('PE→%s', (to) => {
    const r = calculate(op({ issuer: { regime: 'simples_nacional' }, recipient: { uf: to, ieIndicator: 1, finalConsumer: false }, items: [item({ unitPrice: '80.00', quantity: '3' })] }));
    const t = r.items[0]!.taxes;
    expect(r.items[0]!.cfop).toBe(to === 'PE' ? '5102' : '6102');
    expect(t.icms).toMatchObject({ cst: null, csosn: '102', value: '0.00' });
    expect(t.pis).toMatchObject({ cst: '99', value: '0.00' });
    expect(r.totals.invoice).toBe('240.00');
  });
});

describe('Matriz V1: PIS/Cofins monofásico (CST 04) na revenda', () => {
  const monoCases: [string, string, 'lucro_presumido' | 'lucro_real', UF, UF][] = [];
  for (const ncm of ['22021000', '33051000'])
    for (const regime of ['lucro_presumido', 'lucro_real'] as const)
      for (const [from, to] of [['PE', 'PE'], ['SP', 'PE'], ['PE', 'SP']] as [UF, UF][]) monoCases.push([`${ncm} ${regime} ${from}→${to}`, ncm, regime, from, to]);
  it.each(monoCases)('%s', (_n, ncm, regime, from, to) => {
    const r = calculate(op({ issuer: { uf: from, cityIbge: '0000000', regime }, recipient: { uf: to, ieIndicator: 1, finalConsumer: false }, items: [item({ ncm })],
      tables: { icmsInternalRates: INTERNAL_27 as never } }));
    const t = r.items[0]!.taxes;
    expect(t.pis).toMatchObject({ cst: '04', value: '0.00' });
    expect(t.cofins).toMatchObject({ cst: '04', value: '0.00' });
    expect(t.icms.value).toBe(half(D(100).times(from === to ? INTERNAL_27[from]! : interstate(from, to, 0)).dividedBy(100)).toFixed(2));
  });

  it('total de casos dourados (manuais + matrizes) atinge a meta da V1: 300+', () => {
    const generated = 2 * 8 * 3 * 2 + 3 * 26 * 2 + 27 + monoCases.length;
    expect(GOLDEN.length + generated).toBeGreaterThanOrEqual(300);
  });
});

describe('Testes de propriedade do motor', () => {
  const money = fc.integer({ min: 1, max: 5_000_000 }).map((c) => (c / 100).toFixed(2));
  const qty = fc.integer({ min: 1, max: 100_000 }).map((q) => (q / 1000).toFixed(3));
  it('somas fecham: Σ itens = totais; rateio do cabeçalho = valores do cabeçalho', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ qty, price: money }), { minLength: 1, maxLength: 15 }),
        fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 50_000 }),
        fc.constantFrom('simples_nacional', 'lucro_presumido', 'lucro_real'),
        (lines, freightC, discC, regime) => {
          const items = lines.map((l, i) => item({ id: `i${i}`, quantity: l.qty, unitPrice: l.price }));
          const vProd = sum(items.map((i) => D(i.quantity).times(i.unitPrice).toDecimalPlaces(2, 4)));
          const discount = D(Math.min(discC, Math.floor(vProd.times(100).toNumber()))).dividedBy(100).toFixed(2);
          const r = calculate(op({ issuer: { regime: regime as never }, recipient: { ieIndicator: 1, finalConsumer: false }, items, header: { freight: (freightC / 100).toFixed(2), discount } }));
          const s = (f: (x: (typeof r.items)[number]) => string) => sum(r.items.map(f)).toFixed(2);
          return (
            s((i) => i.values.freight) === r.totals.freight && D(r.totals.freight).equals((freightC / 100).toFixed(2)) &&
            s((i) => i.values.discount) === r.totals.discount && D(r.totals.discount).equals(discount) &&
            s((i) => i.values.total) === r.totals.invoice && s((i) => i.taxes.icms.value) === r.totals.icms &&
            D(r.totals.invoice).equals(D(r.totals.product).minus(r.totals.discount).plus(r.totals.freight).plus(r.totals.st).plus(r.totals.fcpSt).plus(r.totals.ipi)) &&
            r.items.every((i) => !D(i.taxes.icms.value).isNegative() && !D(i.taxes.pis.value).isNegative())
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('determinístico: a mesma entrada produz sempre o mesmo resultado', () => {
    const input = op({ issuer: { regime: 'lucro_presumido' }, items: [item({ quantity: '3', unitPrice: '33.33' }), item({ id: 'b', unitPrice: '0.01' })], header: { freight: '1.00' } });
    expect(JSON.stringify(calculate(input))).toBe(JSON.stringify(calculate(input)));
  });

  it('RN-FIS-04 todo item tem memória de cálculo', () => {
    const r = calculate(op({ issuer: { regime: 'lucro_presumido' }, recipient: { ieIndicator: 1, finalConsumer: false } }));
    const taxes = r.items[0]!.memory.map((m) => m.tax);
    expect(taxes).toEqual(expect.arrayContaining(['CFOP', 'VALORES', 'ICMS', 'PIS', 'COFINS', 'IBS/CBS']));
  });
});

describe('Validação de regras ao salvar (RN-FIS-01)', () => {
  it('bloqueia regra com as mesmas chaves e vigência sobreposta', () => {
    const a = rule({ ufDest: 'SP', ncmPrefix: '2202' }, { icms: { rate: '18' } });
    const b = rule({ ufDest: 'SP', ncmPrefix: '2202' }, { icms: { rate: '12' } });
    expect(findConflicts(b, [a])).toHaveLength(1);
  });
  it('permite a mesma chave em vigências que não se sobrepõem', () => {
    const a = rule({ ufDest: 'SP' }, { icms: { rate: '18' } }, { validFrom: '2020-01-01', validTo: '2026-12-31' });
    const b = rule({ ufDest: 'SP' }, { icms: { rate: '19' } }, { validFrom: '2027-01-01' });
    expect(findConflicts(b, [a])).toHaveLength(0);
  });
  it('permite grupos de tributo diferentes', () => {
    const a = rule({ ufDest: 'SP' }, { icms: { rate: '18' } });
    const b = rule({ ufDest: 'SP' }, { st: { mva: '40' } });
    expect(findConflicts(b, [a])).toHaveLength(0);
  });
  it('bloqueia chaves diferentes com a mesma especificidade que podem casar com o mesmo item', () => {
    const a = rule({ ufDest: 'SP' }, { icms: { rate: '18' } });
    const b = rule({ issuerRegime: 'lucro_real' }, { icms: { rate: '12' } });
    expect(findConflicts(b, [a])).toHaveLength(1);
    const c = rule({ ufDest: 'RJ' }, { icms: { rate: '20' } });
    expect(findConflicts(c, [a])).toHaveLength(0);
  });
});

describe('Tabelas', () => {
  it('alíquota interestadual 4/7/12', () => {
    expect(interstateIcmsRate('SP', 'BA', 0)).toBe('7');
    expect(interstateIcmsRate('SP', 'ES', 0)).toBe('7');
    expect(interstateIcmsRate('ES', 'SP', 0)).toBe('12');
    expect(interstateIcmsRate('BA', 'SP', 0)).toBe('12');
    expect(interstateIcmsRate('SP', 'RJ', 0)).toBe('12');
    expect(interstateIcmsRate('SP', 'RJ', 2)).toBe('4');
  });
  it('Simples Nacional: alíquota efetiva e pCredSN (Anexo I)', () => {
    // RBT12 de 500 mil: 3ª faixa (9,5%, PD 13.860) → (500.000 × 9,5% − 13.860) ÷ 500.000 = 6,728%
    const s = simplesEffectiveRate('500000', 'I');
    expect(s.bracket).toBe(3);
    expect(s.effectiveRate.toFixed(4)).toBe('6.7280');
    // ICMS = 33,5% da alíquota efetiva → 2,2539%
    expect(s.icmsCreditRate!.toFixed(4)).toBe('2.2539');
    expect(simplesEffectiveRate('100000', 'I').effectiveRate.toFixed(4)).toBe('4.0000');
    expect(() => simplesEffectiveRate('5000000', 'I')).toThrow();
  });
});
