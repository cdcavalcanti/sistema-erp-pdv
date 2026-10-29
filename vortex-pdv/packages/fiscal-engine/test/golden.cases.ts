/**
 * Casos dourados fiscais (seção 25): operação + produto + UF + regime → impostos esperados.
 * Valores calculados à mão a partir da legislação e das alíquotas de referência
 * da tabela de fixtures. STATUS: pendente de validação formal pelo contador parceiro
 * (decisão dos sócios na seção 27). Qualquer mudança no motor roda todos os casos.
 */
import type { FiscalOperationInput } from '../src/types.js';
import { item, op, rule, VENDA } from './fixtures.js';

export interface GoldenCase {
  id: string;
  title: string;
  input: FiscalOperationInput;
  expect?: Record<string, unknown>;
  expectError?: RegExp;
}

const rPresumido = { regime: 'lucro_presumido' as const };
const rReal = { regime: 'lucro_real' as const };
const contribSP = { uf: 'SP' as const, cityIbge: '3550308', ieIndicator: 1 as const, finalConsumer: false };
const contribPE = { uf: 'PE' as const, cityIbge: '2611606', ieIndicator: 1 as const, finalConsumer: false };

export const GOLDEN: GoldenCase[] = [
  {
    id: 'G001', title: 'Simples PE→PE consumidor final: CSOSN 102, sem destaque, sem IBS/CBS em 2026',
    input: op({ items: [item({ quantity: '2', unitPrice: '50.00' })] }),
    expect: { items: [{ cfop: '5102', taxes: { icms: { csosn: '102', value: '0.00' }, pis: { cst: '99', value: '0.00' }, ibsCbs: null } }], totals: { invoice: '100.00', product: '100.00' } },
  },
  {
    id: 'G002', title: 'Presumido PE→PE contribuinte: ICMS 20,5%, PIS/Cofins cumulativos sem ICMS na base, IBS/CBS informativos',
    input: op({ issuer: rPresumido, recipient: contribPE }),
    expect: {
      items: [{ cfop: '5102', taxes: {
        icms: { cst: '00', base: '100.00', rate: '20.5000', value: '20.50' },
        pis: { cst: '01', base: '79.50', value: '0.52' }, cofins: { cst: '01', base: '79.50', value: '2.39' },
        ibsCbs: { base: '76.59', cbs: { value: '0.69' }, ibsUf: { value: '0.08' }, ibsMun: { value: '0.00' }, informative: true },
      } }],
      totals: { invoice: '100.00', invoiceWithNewTaxes: '100.00', icms: '20.50' },
    },
  },
  {
    id: 'G003', title: 'Lucro Real SP→SP: ICMS 18%, PIS 1,65% e Cofins 7,6% não cumulativos',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ unitPrice: '1000.00' })] }),
    expect: { items: [{ taxes: { icms: { value: '180.00' }, pis: { base: '820.00', value: '13.53' }, cofins: { value: '62.32' }, ibsCbs: { base: '744.15', cbs: { value: '6.70' }, ibsUf: { value: '0.74' } } } }] },
  },
  {
    id: 'G004', title: 'Interestadual SP→PE contribuinte: alíquota 7% (S/SE → NE), CFOP 6102',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribPE, items: [item({ unitPrice: '1000.00' })] }),
    expect: { interstate: true, items: [{ cfop: '6102', taxes: { icms: { rate: '7.0000', value: '70.00' }, difal: null } }] },
  },
  {
    id: 'G005', title: 'Interestadual PE→SP: alíquota 12%',
    input: op({ issuer: rPresumido, recipient: contribSP, items: [item({ unitPrice: '1000.00' })] }),
    expect: { items: [{ taxes: { icms: { rate: '12.0000', value: '120.00' } } }] },
  },
  {
    id: 'G006', title: 'Interestadual SP→RJ com mercadoria importada (origem 1): 4% (Res. SF 13/2012)',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: { uf: 'RJ', cityIbge: '3304557', ieIndicator: 1, finalConsumer: false }, items: [item({ origin: 1, unitPrice: '1000.00' })] }),
    expect: { items: [{ taxes: { icms: { rate: '4.0000', value: '40.00' } } }] },
  },
  {
    id: 'G007', title: 'SP→PE a não contribuinte: CFOP 6108, ICMS 7% na origem e DIFAL base única para PE',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: { uf: 'PE', ieIndicator: 9, finalConsumer: true }, items: [item({ unitPrice: '500.00' })] }),
    expect: { items: [{ cfop: '6108', taxes: { icms: { value: '35.00' }, difal: { base: '500.00', destRate: '20.5000', interstateRate: '7.0000', value: '67.50' } } }], totals: { difal: '67.50' } },
  },
  {
    id: 'G008', title: 'DIFAL base dupla (por dentro) para UF configurada',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: { uf: 'PE', ieIndicator: 9, finalConsumer: true }, items: [item({ unitPrice: '500.00' })], tables: { difalBase: { PE: 'double' } } }),
    expect: { items: [{ taxes: { difal: { base: '584.91', value: '84.91' } } }] },
  },
  {
    id: 'G009', title: 'ICMS-ST interno SP (CST 10): MVA 40%, alíquota 18%',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribSP, rules: [rule({ ncmPrefix: '6109' }, { st: { mva: '40', rate: '18' } })] }),
    expect: { items: [{ taxes: { icms: { cst: '10', value: '18.00' }, st: { base: '140.00', value: '7.20', ownIcmsDeducted: '18.00' } }, values: { total: '107.20' } }], totals: { st: '7.20', invoice: '107.20' } },
  },
  {
    id: 'G010', title: 'ICMS-ST interestadual SP→PE com MVA ajustada',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribPE, rules: [rule({ ncmPrefix: '6109', ufDest: 'PE' }, { st: { mva: '40', rate: '20.5' } })] }),
    expect: { items: [{ taxes: { icms: { value: '7.00' }, st: { adjustedMva: '63.7736', base: '163.77', value: '26.57' } } }] },
  },
  {
    id: 'G011', title: 'Simples com ST (CSOSN 202): ICMS próprio deduzido pela alíquota interna da origem',
    input: op({ recipient: contribPE, rules: [rule({ ncmPrefix: '6109' }, { st: { mva: '30', rate: '20.5' } })] }),
    expect: { items: [{ taxes: { icms: { csosn: '202', value: '0.00' }, st: { base: '130.00', ownIcmsDeducted: '20.50', value: '6.15' } } }], totals: { invoice: '106.15' } },
  },
  {
    id: 'G012', title: 'Simples CSOSN 101: crédito de ICMS informado (pCredSN 1,25%)',
    input: op({ issuer: { simplesCreditRate: '1.25' }, recipient: contribPE, rules: [rule({ recipientIeIndicator: 1 }, { icms: { csosn: '101' } })] }),
    expect: { items: [{ taxes: { icms: { csosn: '101', simplesCreditRate: '1.2500', simplesCreditValue: '1.25', value: '0.00' } } }], totals: { simplesCredit: '1.25' } },
  },
  {
    id: 'G013', title: 'CST 20 com redução de base de 33,33%',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribSP, rules: [rule({ ncmPrefix: '6109' }, { icms: { cst: '20', rate: '18', baseReduction: '33.33' } })] }),
    expect: { items: [{ taxes: { icms: { cst: '20', base: '66.67', value: '12.00', baseReduction: '33.3300' } } }] },
  },
  {
    id: 'G014', title: 'CST 51 com diferimento parcial de 33,33%',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribSP, rules: [rule({}, { icms: { cst: '51', rate: '18', deferral: '33.33' } })] }),
    expect: { items: [{ taxes: { icms: { operationValue: '18.00', deferredValue: '6.00', value: '12.00' } } }] },
  },
  {
    id: 'G015', title: 'CST 40 isenta: sem ICMS; PIS/Cofins sobre o valor cheio',
    input: op({ issuer: rPresumido, recipient: contribPE, rules: [rule({}, { icms: { cst: '40' } })] }),
    expect: { items: [{ taxes: { icms: { cst: '40', base: '0.00', value: '0.00' }, pis: { base: '100.00', value: '0.65' }, cofins: { value: '3.00' } } }] },
  },
  {
    id: 'G016', title: 'RN-FIS-03 rateio de frete e desconto do cabeçalho proporcional ao valor dos itens',
    input: op({ header: { freight: '10.00', discount: '1.00' }, items: [item({ id: 'a', unitPrice: '30.00' }), item({ id: 'b', unitPrice: '30.00' }), item({ id: 'c', unitPrice: '40.00' })] }),
    expect: {
      items: [{ values: { freight: '3.00', discount: '0.30', total: '32.70' } }, { values: { freight: '3.00', discount: '0.30' } }, { values: { freight: '4.00', discount: '0.40', total: '43.60' } }],
      totals: { freight: '10.00', discount: '1.00', invoice: '109.00' },
    },
  },
  {
    id: 'G017', title: 'RN-FIS-03 diferença de centavos do rateio vai para o item de maior valor',
    input: op({ header: { freight: '10.00' }, items: [item({ id: 'a', unitPrice: '10.00' }), item({ id: 'b', unitPrice: '10.00' }), item({ id: 'c', unitPrice: '10.01' })] }),
    expect: { items: [{ values: { freight: '3.33' } }, { values: { freight: '3.33' } }, { values: { freight: '3.34' } }], totals: { freight: '10.00' } },
  },
  {
    id: 'G018', title: 'IPI 10% para contribuinte revendedor: IPI fora da base do ICMS',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ unitPrice: '1000.00', ownProduction: true })], rules: [rule({}, { ipi: { cst: '50', rate: '10' } })] }),
    expect: { items: [{ taxes: { ipi: { value: '100.00' }, icms: { base: '1000.00', value: '180.00' } }, values: { total: '1100.00' } }] },
  },
  {
    id: 'G019', title: 'IPI na base do ICMS para consumidor final',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: { uf: 'SP', ieIndicator: 9, finalConsumer: true }, items: [item({ unitPrice: '1000.00', ownProduction: true })], rules: [rule({}, { ipi: { cst: '50', rate: '10' } })] }),
    expect: { items: [{ taxes: { icms: { base: '1100.00', value: '198.00' } } }] },
  },
  {
    id: 'G020', title: 'Serviço com ISS 5% (presumido) e IBS/CBS de 2026 deduzindo ISS e PIS/Cofins',
    input: op({ issuer: rPresumido, recipient: contribPE, operation: { ...VENDA, code: 'SERVICO', purpose: 'service', cfopInternal: '5933', cfopInterstate: '6933' },
      items: [item({ kind: 'service', ncm: null, serviceCode: '17.01', unitPrice: '1000.00' })], rules: [rule({ itemKind: 'service' }, { iss: { rate: '5' } })] }),
    expect: { items: [{ cfop: '5933', taxes: { iss: { base: '1000.00', value: '50.00' }, pis: { value: '6.50' }, cofins: { value: '30.00' }, ibsCbs: { base: '913.50', cbs: { value: '8.22' }, ibsUf: { value: '0.91' } } } }] },
  },
  {
    id: 'G021', title: 'Retenções sobre serviço: IRRF 1,5%, CSLL 1%, PIS 0,65%, Cofins 3% e ISS retido',
    input: op({ issuer: rPresumido, recipient: contribPE, operation: { ...VENDA, code: 'SERVICO', purpose: 'service', cfopInternal: '5933', cfopInterstate: '6933' },
      items: [item({ kind: 'service', ncm: null, serviceCode: '17.01', unitPrice: '1000.00' })],
      rules: [rule({ itemKind: 'service' }, { iss: { rate: '2', retained: true }, retentions: { irrf: '1.5', csll: '1', pis: '0.65', cofins: '3' } })] }),
    expect: { totals: { retentions: { irrf: '15.00', csll: '10.00', pis: '6.50', cofins: '30.00', inss: '0.00', iss: '20.00' } } },
  },
  {
    id: 'G022', title: '2027: PIS/Cofins extintos (CST 08), CBS cheia, IBS simbólico e total com novos tributos',
    input: op({ date: '2027-03-10', issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ unitPrice: '1000.00' })] }),
    expect: { items: [{ taxes: { pis: { cst: '08', value: '0.00' }, icms: { value: '180.00' }, ibsCbs: { base: '820.00', cbs: { value: '72.16' }, ibsUf: { value: '0.41' }, ibsMun: { value: '0.41' }, informative: false } } }],
      totals: { invoice: '1000.00', invoiceWithNewTaxes: '1072.98' } },
  },
  {
    id: 'G023', title: '2029 (RN-REF-03): ICMS a 90% da alíquota e IBS proporcional da tabela',
    input: op({ date: '2029-06-01', issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ unitPrice: '1000.00' })] }),
    expect: { items: [{ taxes: { icms: { rate: '16.2000', value: '162.00' }, ibsCbs: { base: '838.00', ibsUf: { value: '8.38' }, ibsMun: { value: '6.70' }, cbs: { value: '73.74' } } } }] },
  },
  {
    id: 'G024', title: '2033: ICMS extinto (fator 0) e IBS/CBS plenos',
    input: op({ date: '2033-01-15', issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ unitPrice: '1000.00' })] }),
    expect: { items: [{ taxes: { icms: { value: '0.00' }, ibsCbs: { base: '1000.00', ibsUf: { value: '100.00' }, ibsMun: { value: '80.00' }, cbs: { value: '88.00' } } } }], totals: { invoiceWithNewTaxes: '1268.00' } },
  },
  {
    id: 'G025', title: 'cClassTrib 200034: redução de 60% nas alíquotas de IBS e CBS',
    input: op({ date: '2027-02-01', issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ unitPrice: '1000.00', cclasstrib: '200034' })] }),
    expect: { items: [{ taxes: { ibsCbs: { cst: '200', cclasstrib: '200034', cbs: { effectiveRate: '3.5200', value: '28.86' }, ibsUf: { effectiveRate: '0.0200', value: '0.16' } } } }] },
  },
  {
    id: 'G026', title: 'cClassTrib 200003 (cesta básica): alíquota zero',
    input: op({ date: '2027-02-01', issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ cclasstrib: '200003' })] }),
    expect: { items: [{ taxes: { ibsCbs: { cbs: { value: '0.00' }, ibsValue: '0.00' } } }] },
  },
  {
    id: 'G027', title: 'cClassTrib 410001 (imunidade): sem IBS/CBS',
    input: op({ date: '2027-02-01', issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ cclasstrib: '410001' })] }),
    expect: { items: [{ taxes: { ibsCbs: { cst: '410', cbs: { value: '0.00' } } } }] },
  },
  {
    id: 'G028', title: 'PIS/Cofins monofásico na revenda: CST 04 sem destaque',
    input: op({ issuer: rPresumido, recipient: contribPE, items: [item({ ncm: '22021000' })] }),
    expect: { items: [{ taxes: { pis: { cst: '04', value: '0.00' }, cofins: { cst: '04', value: '0.00' } } }] },
  },
  {
    id: 'G029', title: 'Exportação: CFOP 7102 e ICMS não tributado (CST 41)',
    input: op({ issuer: rPresumido, recipient: { uf: 'EX', ieIndicator: 9, finalConsumer: false, countryCode: '2496' } }),
    expect: { interstate: false, items: [{ cfop: '7102', taxes: { icms: { cst: '41', value: '0.00' } } }] },
  },
  {
    id: 'G030', title: 'RN-FIS-01 regra por NCM vence a regra só por tipo de operação',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribSP,
      rules: [rule({ operationCode: 'VENDA' }, { icms: { cst: '00', rate: '18' } }, { name: 'geral' }), rule({ operationCode: 'VENDA', ncmPrefix: '61091000' }, { icms: { cst: '00', rate: '12' } }, { name: 'ncm' })] }),
    expect: { items: [{ taxes: { icms: { rate: '12.0000', value: '12.00' } }, appliedRules: [{ group: 'icms', ruleName: 'ncm' }] }] },
  },
  {
    id: 'G031', title: 'RN-FIS-01 empate entre regras igualmente específicas é erro de configuração',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribSP,
      rules: [rule({ ufDest: 'SP' }, { icms: { rate: '18' } }, { name: 'A' }), rule({ issuerRegime: 'lucro_presumido' }, { icms: { rate: '12' } }, { name: 'B' })] }),
    expectError: /RN-FIS-01/,
  },
  {
    id: 'G032', title: 'RN-GER-03 regra fora da vigência na data do fato gerador não se aplica',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribSP,
      rules: [rule({}, { icms: { cst: '00', rate: '25' } }, { validFrom: '2020-01-01', validTo: '2026-06-30' })] }),
    expect: { items: [{ taxes: { icms: { rate: '18.0000' } } }] },
  },
  {
    id: 'G033', title: 'RN-GER-03 reprocessamento antigo usa a regra vigente na época',
    input: op({ date: '2026-03-01', issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribSP,
      rules: [rule({}, { icms: { cst: '00', rate: '25' } }, { validFrom: '2020-01-01', validTo: '2026-06-30' })] }),
    expect: { items: [{ taxes: { icms: { rate: '25.0000', value: '25.00' } } }] },
  },
  {
    id: 'G034', title: 'RN-NFE-02 CFOP interno em operação interestadual é recusado',
    input: op({ issuer: rPresumido, recipient: contribSP, rules: [rule({}, { cfop: '5102' })] }),
    expectError: /incompatível/,
  },
  {
    id: 'G035', title: 'FCP interno RJ 2% além do ICMS 20%',
    input: op({ issuer: { uf: 'RJ', cityIbge: '3304557', ...rPresumido }, recipient: { uf: 'RJ', ieIndicator: 1, finalConsumer: false }, rules: [rule({}, { icms: { cst: '00', rate: '20', fcpRate: '2' } })] }),
    expect: { items: [{ taxes: { icms: { value: '20.00' }, fcp: { base: '100.00', rate: '2.0000', value: '2.00' } } }], totals: { fcp: '2.00' } },
  },
  {
    id: 'G036', title: 'Imposto Seletivo (2027) sobre bebida açucarada',
    input: op({ date: '2027-05-01', issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP, items: [item({ ncm: '22021000', unitPrice: '200.00' })],
      rules: [rule({ ncmPrefix: '2202' }, { is: { rate: '10', cst: '000' } })] }),
    expect: { items: [{ taxes: { is: { base: '200.00', value: '20.00' } } }], totals: { is: '20.00' } },
  },
  {
    id: 'G037', title: 'ST por pauta fiscal: base = quantidade × pauta',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: contribSP, items: [item({ quantity: '10', unitPrice: '4.00' })],
      rules: [rule({}, { st: { pautaUnitValue: '6.00', rate: '18' } })] }),
    expect: { items: [{ taxes: { st: { base: '60.00', value: '3.60' } } }] },
  },
  {
    id: 'G038', title: 'Entrada (compra) no Lucro Real: PIS/Cofins CST 50 com crédito',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rReal }, recipient: contribSP,
      operation: { code: 'COMPRA', direction: 'E', purpose: 'purchase', cfopInternal: '1102', cfopInterstate: '2102' }, items: [item({ unitPrice: '1000.00' })] }),
    expect: { items: [{ cfop: '1102', taxes: { pis: { cst: '50', value: '13.53' }, cofins: { cst: '50', value: '62.32' } } }] },
  },
  {
    id: 'G039', title: 'Simples em 2027 também informa IBS/CBS',
    input: op({ date: '2027-01-20', recipient: contribPE }),
    expect: { items: [{ taxes: { icms: { csosn: '102' }, ibsCbs: { base: '100.00', cbs: { value: '8.80' } } } }] },
  },
  {
    id: 'G040', title: 'Quantidade e preço com muitas casas: vProd arredondado uma única vez',
    input: op({ items: [item({ quantity: '3.3333', unitPrice: '0.3333333333' })] }),
    expect: { items: [{ values: { product: '1.11' } }], totals: { invoice: '1.11' } },
  },
  {
    id: 'G041', title: 'Venda interestadual de produção própria a não contribuinte: CFOP 6107',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', ...rPresumido }, recipient: { uf: 'BA', ieIndicator: 9, finalConsumer: true },
      operation: { ...VENDA, code: 'VENDA_PROD', cfopInternal: '5101', cfopInterstate: '6101' }, items: [item({ ownProduction: true })] }),
    expect: { items: [{ cfop: '6107', taxes: { icms: { rate: '7.0000' }, difal: { destRate: '20.5000', value: '13.50' } } }] },
  },
  {
    id: 'G042', title: 'Emitente do Simples em venda interestadual a não contribuinte: DIFAL não destacado',
    input: op({ recipient: { uf: 'SP', ieIndicator: 9, finalConsumer: true } }),
    expect: { items: [{ cfop: '6108', taxes: { difal: null } }] },
  },
  {
    id: 'G043', title: 'Desconto de item maior que o valor do produto é recusado',
    input: op({ items: [item({ discount: '150.00' })] }),
    expectError: /desconto maior/,
  },
  {
    id: 'G044', title: 'Mercadoria sem NCM é recusada',
    input: op({ items: [item({ ncm: null })] }),
    expectError: /NCM obrigatório/,
  },
  {
    id: 'G048', title: 'RN-VEN-05 venda para entrega futura (simples faturamento 5922): sem ICMS e sem IPI; PIS/Cofins no faturamento',
    input: op({ issuer: rPresumido, recipient: contribPE,
      operation: { code: 'ENTREGA_FUT', direction: 'S', purpose: 'future_delivery', cfopInternal: '5922', cfopInterstate: '6922', cfopForeign: '7102' } }),
    expect: { items: [{ cfop: '5922', taxes: { icms: { cst: '41', value: '0.00' }, ipi: null, pis: { cst: '01', base: '100.00', value: '0.65' }, cofins: { value: '3.00' } } }], totals: { icms: '0.00', invoice: '100.00' } },
  },
  {
    id: 'G049', title: 'RN-VEN-05 remessa da entrega futura (5117): ICMS destacado; PIS/Cofins CST 49 (já tributados no faturamento)',
    input: op({ issuer: rPresumido, recipient: contribPE,
      operation: { code: 'REM_ENTREGA_FUT', direction: 'S', purpose: 'future_delivery_shipment', cfopInternal: '5117', cfopInterstate: '6117', cfopForeign: '7102' } }),
    expect: { items: [{ cfop: '5117', taxes: { icms: { cst: '00', value: '20.50' }, pis: { cst: '49', value: '0.00' }, cofins: { cst: '49', value: '0.00' } } }] },
  },
  {
    id: 'G050', title: 'RN-VEN-05 simples faturamento interestadual a não contribuinte: DIFAL fica para a remessa; Simples usa CSOSN 400',
    input: op({ issuer: { uf: 'SP', cityIbge: '3550308', regime: 'simples_nacional' }, recipient: { uf: 'PE', ieIndicator: 9, finalConsumer: true },
      operation: { code: 'ENTREGA_FUT', direction: 'S', purpose: 'future_delivery', cfopInternal: '5922', cfopInterstate: '6922', cfopForeign: '7102' } }),
    expect: { items: [{ cfop: '6922', taxes: { icms: { csosn: '400', value: '0.00' }, difal: null } }] },
  },
  {
    id: 'G051', title: 'RN-REF-01 cClassTrib do produto (redução de 60%) com exceção por tipo de operação (tributação integral na bonificação)',
    input: op({ issuer: rPresumido, recipient: contribPE, items: [item({ cclasstrib: '200034' })],
      operation: { code: 'BONIF', direction: 'S', purpose: 'bonus', cfopInternal: '5910', cfopInterstate: '6910', cfopForeign: '7102' },
      rules: [rule({ operationCode: 'BONIF' }, { ibsCbs: { cclasstrib: '000001' } })] }),
    expect: { items: [{ taxes: { ibsCbs: { cclasstrib: '000001' } } }] },
  },
  {
    id: 'G052', title: 'RN-REF-01 sem exceção para a operação, vale o cClassTrib do produto (60% de redução)',
    input: op({ issuer: rPresumido, recipient: contribPE, items: [item({ cclasstrib: '200034' })], rules: [rule({ operationCode: 'BONIF' }, { ibsCbs: { cclasstrib: '000001' } })] }),
    expect: { items: [{ taxes: { ibsCbs: { cclasstrib: '200034', cbs: { reduction: '60.0000' } } } }] },
  },
];
