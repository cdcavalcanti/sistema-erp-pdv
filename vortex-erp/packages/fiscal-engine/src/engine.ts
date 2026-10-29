import { D, ZERO, HUNDRED, allocate, max, roundMoney, round, sum, type Decimal } from '@vortex/money';
import type { UF } from '@vortex/validators';
import { FiscalConfigError, matchContext, selectRule, type MatchContext } from './rules.js';
import { CSOSN, CSOSN_WITH_ST, ICMS_CST, ICMS_CST_EXEMPT, ICMS_CST_WITH_ST, REFERENCE_ICMS_INTERNAL_RATES, interstateIcmsRate } from './tables.js';
import type {
  FiscalOperationInput, FiscalResult, ItemInput, ItemResult, ItemTaxes, MemoryLine, RuleGroup, TaxRule, Totals,
} from './types.js';

const m2 = (d: Decimal) => roundMoney(d).toFixed(2);
const r4 = (d: Decimal | string) => round(D(d), 4).toFixed(4);
const br = (d: Decimal | string) => {
  const v = roundMoney(D(d));
  const [i, f] = v.abs().toFixed(2).split('.');
  return `${v.isNegative() ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f}`;
};
const pctTxt = (d: Decimal | string) => `${D(d).toDecimalPlaces(4).toString().replace('.', ',')}%`;

const SIMPLES_REGIMES = new Set(['simples_nacional', 'mei', 'simples_excesso_sublimite']);

interface ItemContext {
  input: FiscalOperationInput;
  item: ItemInput;
  match: MatchContext;
  interstate: boolean;
  foreign: boolean;
  vProd: Decimal;
  vDesc: Decimal;
  vFrete: Decimal;
  vSeg: Decimal;
  vOutro: Decimal;
  memory: MemoryLine[];
  warnings: string[];
  applied: ItemResult['appliedRules'];
}

function pick<G extends RuleGroup>(c: ItemContext, group: G) {
  const sel = selectRule(c.input.rules, c.match, group);
  if (sel) c.applied.push({ group, ruleId: sel.rule.id, ruleName: sel.rule.name });
  return sel;
}

function mem(c: ItemContext, tax: string, description: string, formula?: string, rule?: TaxRule | null) {
  c.memory.push({ tax, description, formula, ruleId: rule?.id ?? null, ruleName: rule?.name ?? null });
}

/**
 * Calcula todos os tributos de uma operação. Função pura e determinística:
 * a mesma entrada (incluindo regras e tabelas da data) produz sempre o mesmo resultado.
 */
export function calculate(input: FiscalOperationInput): FiscalResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new FiscalConfigError('Data do fato gerador inválida');
  if (!input.items.length) throw new FiscalConfigError('Operação sem itens');
  const foreign = input.recipient.uf === 'EX' || (input.recipient.countryCode !== undefined && input.recipient.countryCode !== '1058');
  const interstate = !foreign && input.recipient.uf !== input.issuer.uf;

  // Valor dos produtos e rateio do cabeçalho (RN-FIS-03)
  const vProds = input.items.map((i) => {
    const q = D(i.quantity);
    const p = D(i.unitPrice);
    if (q.lessThanOrEqualTo(0)) throw new FiscalConfigError(`Item ${i.id}: quantidade deve ser maior que zero`);
    if (p.isNegative()) throw new FiscalConfigError(`Item ${i.id}: valor unitário negativo`);
    return roundMoney(q.times(p));
  });
  const h = input.header ?? {};
  const shareFreight = allocate(h.freight ?? '0', vProds);
  const shareIns = allocate(h.insurance ?? '0', vProds);
  const shareOther = allocate(h.otherExpenses ?? '0', vProds);
  const shareDisc = allocate(h.discount ?? '0', vProds);

  const items: ItemResult[] = input.items.map((item, idx) => {
    const c: ItemContext = {
      input, item, match: matchContext(input, item), interstate, foreign,
      vProd: vProds[idx]!,
      vDesc: roundMoney(D(item.discount ?? '0').plus(shareDisc[idx]!)),
      vFrete: roundMoney(D(item.freight ?? '0').plus(shareFreight[idx]!)),
      vSeg: roundMoney(D(item.insurance ?? '0').plus(shareIns[idx]!)),
      vOutro: roundMoney(D(item.otherExpenses ?? '0').plus(shareOther[idx]!)),
      memory: [], warnings: [], applied: [],
    };
    if (c.vDesc.greaterThan(c.vProd)) throw new FiscalConfigError(`Item ${item.id}: desconto maior que o valor do produto`);
    return computeItem(c);
  });

  return { date: input.date, interstate, items, totals: totalize(items, input), warnings: items.flatMap((i) => i.warnings.map((w) => `${i.id}: ${w}`)) };
}

const BILLING_ONLY = new Set(['future_delivery', 'third_party_order']);
const SHIPMENT_OF_BILLED = new Set(['future_delivery_shipment', 'third_party_shipment']);

function resolveCfop(c: ItemContext): string {
  const { operation, recipient, issuer } = c.input;
  const sel = pick(c, 'cfop');
  let cfop = sel?.value ?? null;
  if (!cfop) {
    cfop = (c.foreign ? operation.cfopForeign : c.interstate ? operation.cfopInterstate : operation.cfopInternal) ?? null;
    // Venda interestadual a não contribuinte: 6107/6108 (EC 87/2015)
    if (cfop && c.interstate && operation.purpose === 'sale' && recipient.ieIndicator === 9) {
      if (cfop === '6101') cfop = '6107';
      if (cfop === '6102') cfop = '6108';
    }
  }
  if (!cfop) throw new FiscalConfigError(`CFOP não definido para a operação ${operation.code} (${c.foreign ? 'exterior' : c.interstate ? 'interestadual' : 'interna'})`, { item: c.item.id });
  // RN-NFE-02: CFOP compatível com a UF de destino e com o sentido da operação
  const first = cfop[0];
  const expected = operation.direction === 'S' ? (c.foreign ? '7' : c.interstate ? '6' : '5') : (c.foreign ? '3' : c.interstate ? '2' : '1');
  if (first !== expected) {
    throw new FiscalConfigError(`CFOP ${cfop} incompatível com operação ${c.interstate ? 'interestadual' : c.foreign ? 'com o exterior' : 'interna'} de ${operation.direction === 'S' ? 'saída' : 'entrada'} (esperado ${expected}xxx)`, { item: c.item.id, cfop });
  }
  mem(c, 'CFOP', `CFOP ${cfop}${sel ? '' : ' (padrão do tipo de operação)'}`, undefined, sel?.rule);
  void issuer;
  return cfop;
}

function computeItem(c: ItemContext): ItemResult {
  const { input, item } = c;
  const { issuer, recipient, operation, tables } = input;
  if (item.kind === 'goods' && !item.ncm) throw new FiscalConfigError(`Item ${item.id}: NCM obrigatório para mercadoria`);
  const factor = D(tables.transition.icmsIssFactor);
  const simples = SIMPLES_REGIMES.has(issuer.regime);
  // RN-VEN-05: simples faturamento (entrega futura, venda à ordem) não destaca ICMS nem IPI;
  // o imposto vai na nota de remessa, que por sua vez não tem PIS/Cofins (já tributados no faturamento)
  const billingOnly = BILLING_ONLY.has(operation.purpose);
  const cfop = resolveCfop(c);
  const valueBase = c.vProd.plus(c.vFrete).plus(c.vSeg).plus(c.vOutro).minus(c.vDesc);
  mem(c, 'VALORES', `Valor do item = ${br(c.vProd)} + frete ${br(c.vFrete)} + seguro ${br(c.vSeg)} + outras ${br(c.vOutro)} − desconto ${br(c.vDesc)} = ${br(valueBase)}`);

  const taxes: ItemTaxes = {
    icms: { cst: null, csosn: null, modBC: 3, base: '0.00', rate: '0.0000', baseReduction: '0.0000', value: '0.00', operationValue: '0.00', deferralRate: '0.0000',
      deferredValue: '0.00', simplesCreditRate: '0.0000', simplesCreditValue: '0.00', exemptValue: '0.00', benefitCode: null, exemptionReason: null },
    fcp: { base: '0.00', rate: '0.0000', value: '0.00' },
    st: null, difal: null, ipi: null,
    pis: { cst: '99', base: '0.00', rate: '0.0000', value: '0.00' },
    cofins: { cst: '99', base: '0.00', rate: '0.0000', value: '0.00' },
    iss: null, ibsCbs: null, is: null,
    retentions: { irrf: '0.00', csll: '0.00', pis: '0.00', cofins: '0.00', inss: '0.00', iss: '0.00' },
  };

  // ------------------------------------------------------------ IPI
  let vIPI = ZERO;
  const ipiSel = item.kind === 'goods' && !billingOnly ? pick(c, 'ipi') : null;
  if (ipiSel) {
    const rate = D(ipiSel.value.rate ?? '0');
    const taxed = ['00', '49', '50', '99'].includes(ipiSel.value.cst) && rate.greaterThan(0);
    const base = taxed ? valueBase : ZERO;
    vIPI = roundMoney(base.times(rate).dividedBy(HUNDRED));
    taxes.ipi = { cst: ipiSel.value.cst, base: m2(base), rate: r4(rate), value: m2(vIPI), enqCode: ipiSel.value.enqCode ?? '999' };
    mem(c, 'IPI', `CST ${ipiSel.value.cst}: base ${br(base)} × ${pctTxt(rate)} = ${br(vIPI)}`, 'base = vProd + frete + seguro + outras − desconto', ipiSel.rule);
  } else if (item.kind === 'goods' && item.ownProduction && operation.direction === 'S' && tables.transition.ipiActive && !simples) {
    c.warnings.push('Produto de produção própria sem regra de IPI parametrizada');
  }

  // ------------------------------------------------------------ ICMS próprio
  let vICMS = ZERO;
  let vFCP = ZERO;
  let icmsBase = ZERO;
  let icmsRateEff = ZERO;
  const stSel = item.kind === 'goods' ? pick(c, 'st') : null;
  const difalSel = item.kind === 'goods' ? pick(c, 'difal') : null;
  const ipiInIcmsBase = Boolean(item.forUseOrConsumption) || recipient.finalConsumer || recipient.ieIndicator === 9;
  const interRate = c.interstate ? D(interstateIcmsRate(issuer.uf, recipient.uf as UF, item.origin)) : null;
  // Alíquota própria: regra > interestadual > interna da UF de origem
  const internalOrigin = D(tables.icmsInternalRates[issuer.uf] ?? REFERENCE_ICMS_INTERNAL_RATES[issuer.uf]);

  if (item.kind === 'goods') {
    const icmsSel = pick(c, 'icms');
    const rv = icmsSel?.value ?? {};
    const nominalRate = rv.rate !== undefined ? D(rv.rate) : interRate ?? internalOrigin;
    icmsRateEff = nominalRate.times(factor);
    const fullBase = valueBase.plus(ipiInIcmsBase ? vIPI : ZERO);
    if (simples) {
      // CSOSN: o Simples normalmente não destaca ICMS (102), salvo crédito permitido (101) e ST
      let csosn = rv.csosn ?? (billingOnly ? '400' : c.foreign ? '300' : stSel ? (issuer.simplesCreditRate && recipient.ieIndicator === 1 ? '201' : '202') : '102');
      if (!CSOSN[csosn]) throw new FiscalConfigError(`CSOSN inválido: ${csosn}`);
      if (stSel && !CSOSN_WITH_ST.has(csosn)) c.warnings.push(`Regra de ST encontrada, mas o CSOSN ${csosn} não prevê ST`);
      taxes.icms.csosn = csosn;
      if ((csosn === '101' || csosn === '201') && issuer.simplesCreditRate) {
        const pCred = D(issuer.simplesCreditRate);
        const vCred = roundMoney(valueBase.times(pCred).dividedBy(HUNDRED));
        taxes.icms.simplesCreditRate = r4(pCred);
        taxes.icms.simplesCreditValue = m2(vCred);
        mem(c, 'ICMS', `CSOSN ${csosn} (${CSOSN[csosn]}): crédito ${br(valueBase)} × ${pctTxt(pCred)} = ${br(vCred)}`, 'vCredICMSSN = valor × pCredSN', icmsSel?.rule);
      } else {
        mem(c, 'ICMS', `CSOSN ${csosn} (${CSOSN[csosn]}): ICMS recolhido no DAS, sem destaque na nota`, undefined, icmsSel?.rule);
      }
      if (issuer.regime === 'simples_excesso_sublimite' || csosn === '900') {
        icmsBase = fullBase.times(D(1).minus(D(rv.baseReduction ?? '0').dividedBy(HUNDRED)));
        vICMS = roundMoney(icmsBase.times(icmsRateEff).dividedBy(HUNDRED));
        taxes.icms.base = m2(icmsBase);
        taxes.icms.rate = r4(icmsRateEff);
        taxes.icms.value = m2(vICMS);
        taxes.icms.operationValue = m2(vICMS);
        mem(c, 'ICMS', `CSOSN ${csosn}: base ${br(icmsBase)} × ${pctTxt(icmsRateEff)} = ${br(vICMS)}`, undefined, icmsSel?.rule);
      }
    } else {
      let cst = rv.cst ?? (c.foreign || billingOnly ? '41' : stSel ? '10' : D(rv.baseReduction ?? '0').greaterThan(0) ? '20' : '00');
      if (!ICMS_CST[cst]) throw new FiscalConfigError(`CST de ICMS inválido: ${cst}`);
      if (stSel && !ICMS_CST_WITH_ST.has(cst)) c.warnings.push(`Regra de ST encontrada, mas o CST ${cst} não prevê ST`);
      taxes.icms.cst = cst;
      taxes.icms.benefitCode = rv.benefitCode ?? null;
      if (ICMS_CST_EXEMPT.has(cst)) {
        if (rv.exemptionReason) {
          const would = roundMoney(fullBase.times(icmsRateEff).dividedBy(HUNDRED));
          taxes.icms.exemptValue = m2(would);
          taxes.icms.exemptionReason = rv.exemptionReason;
        }
        mem(c, 'ICMS', `CST ${cst} (${ICMS_CST[cst]}): sem destaque de ICMS próprio`, undefined, icmsSel?.rule);
      } else {
        const red = D(rv.baseReduction ?? '0');
        icmsBase = fullBase.times(D(1).minus(red.dividedBy(HUNDRED)));
        const opValue = roundMoney(icmsBase.times(icmsRateEff).dividedBy(HUNDRED));
        vICMS = opValue;
        let deferred = ZERO;
        if (cst === '51' && rv.deferral) {
          deferred = roundMoney(opValue.times(D(rv.deferral)).dividedBy(HUNDRED));
          vICMS = opValue.minus(deferred);
          taxes.icms.deferralRate = r4(rv.deferral);
        }
        taxes.icms.base = m2(icmsBase);
        taxes.icms.rate = r4(icmsRateEff);
        taxes.icms.baseReduction = r4(red);
        taxes.icms.operationValue = m2(opValue);
        taxes.icms.deferredValue = m2(deferred);
        taxes.icms.value = m2(vICMS);
        const fx = factor.equals(1) ? '' : ` (alíquota ${pctTxt(nominalRate)} × fator de transição ${factor.toString()})`;
        mem(c, 'ICMS',
          `CST ${cst} (${ICMS_CST[cst]}): base ${br(fullBase)}${red.greaterThan(0) ? ` − redução ${pctTxt(red)} = ${br(icmsBase)}` : ''} × ${pctTxt(icmsRateEff)}${fx} = ${br(opValue)}` +
            (deferred.greaterThan(0) ? `; diferido ${pctTxt(rv.deferral!)} = ${br(deferred)}; ICMS devido ${br(vICMS)}` : ''),
          `base = vProd + frete + seguro + outras − desconto${ipiInIcmsBase && vIPI.greaterThan(0) ? ' + IPI (destinatário final/uso e consumo)' : ''}`, icmsSel?.rule);
        // FCP nas operações internas (interestadual a não contribuinte vai para o destino via DIFAL)
        const fcpRate = rv.fcpRate !== undefined ? D(rv.fcpRate) : !c.interstate ? D(tables.fcpRates?.[issuer.uf] ?? '0') : ZERO;
        if (fcpRate.greaterThan(0)) {
          const eff = fcpRate.times(factor);
          vFCP = roundMoney(icmsBase.times(eff).dividedBy(HUNDRED));
          taxes.fcp = { base: m2(icmsBase), rate: r4(eff), value: m2(vFCP) };
          mem(c, 'FCP', `FCP: base ${br(icmsBase)} × ${pctTxt(eff)} = ${br(vFCP)}`, undefined, icmsSel?.rule);
        }
      }
    }

    // ---------------------------------------------------------- ICMS-ST
    const stCode = taxes.icms.cst ?? taxes.icms.csosn ?? '';
    if (stSel && (ICMS_CST_WITH_ST.has(stCode) || CSOSN_WITH_ST.has(stCode)) && stCode !== '60' && stCode !== '500') {
      const st = stSel.value;
      const stRate = D(st.rate ?? (tables.icmsInternalRates[recipient.uf as UF] ?? REFERENCE_ICMS_INTERNAL_RATES[recipient.uf as UF] ?? '0')).times(factor);
      let baseST: Decimal;
      let mva = D(st.mva ?? '0');
      let adjusted = mva;
      if (st.pautaUnitValue) {
        baseST = D(item.taxableQuantity ?? item.quantity).times(D(st.pautaUnitValue));
        mem(c, 'ICMS-ST', `Base por pauta fiscal: ${D(item.taxableQuantity ?? item.quantity).toString()} × ${br(st.pautaUnitValue)} = ${br(baseST)}`, undefined, stSel.rule);
      } else {
        const adjust = st.adjustMva ?? (c.interstate && !simples);
        if (adjust && c.interstate && interRate) {
          // MVA ajustada = [(1 + MVA) × (1 − ALQ inter) ÷ (1 − ALQ intra)] − 1
          const alqInter = interRate.times(factor).dividedBy(HUNDRED);
          const alqIntra = stRate.dividedBy(HUNDRED);
          adjusted = D(1).plus(mva.dividedBy(HUNDRED)).times(D(1).minus(alqInter)).dividedBy(D(1).minus(alqIntra)).minus(1).times(HUNDRED);
          adjusted = round(adjusted, 4);
          mem(c, 'ICMS-ST', `MVA ajustada = [(1 + ${pctTxt(mva)}) × (1 − ${pctTxt(alqInter.times(100))}) ÷ (1 − ${pctTxt(stRate)})] − 1 = ${pctTxt(adjusted)}`, undefined, stSel.rule);
        }
        const b0 = valueBase.plus(vIPI);
        baseST = b0.times(D(1).plus(adjusted.dividedBy(HUNDRED)));
        mem(c, 'ICMS-ST', `Base ST = (valor ${br(valueBase)} + IPI ${br(vIPI)}) × (1 + ${pctTxt(adjusted)}) = ${br(baseST)}`, 'Base ST = (vProd + IPI + frete + seguro + outras − desconto) × (1 + MVA)', stSel.rule);
      }
      const redST = D(st.baseReduction ?? '0');
      if (redST.greaterThan(0)) baseST = baseST.times(D(1).minus(redST.dividedBy(HUNDRED)));
      baseST = roundMoney(baseST);
      // ICMS próprio a deduzir: o destacado; no Simples, o calculado pela alíquota da operação
      let own = vICMS;
      if (simples || ICMS_CST_EXEMPT.has(stCode) || stCode === '30') {
        const ownRate = (interRate ?? internalOrigin).times(factor);
        own = stCode === '30' || stCode === '203' ? ZERO : roundMoney(valueBase.times(ownRate).dividedBy(HUNDRED));
      }
      const gross = roundMoney(baseST.times(stRate).dividedBy(HUNDRED));
      const vST = max(ZERO, gross.minus(own));
      const fcpStRate = D(st.fcpRate ?? '0').times(factor);
      const vFCPST = roundMoney(baseST.times(fcpStRate).dividedBy(HUNDRED));
      taxes.st = {
        mva: r4(mva), adjustedMva: r4(adjusted), base: m2(baseST), rate: r4(stRate), value: m2(vST), baseReduction: r4(redST),
        fcp: { base: fcpStRate.greaterThan(0) ? m2(baseST) : '0.00', rate: r4(fcpStRate), value: m2(vFCPST) }, ownIcmsDeducted: m2(own),
      };
      mem(c, 'ICMS-ST', `ICMS-ST = ${br(baseST)} × ${pctTxt(stRate)} − ICMS próprio ${br(own)} = ${br(vST)}${vFCPST.greaterThan(0) ? `; FCP-ST ${br(vFCPST)}` : ''}`, 'ICMS-ST = base ST × alíquota interna do destino − ICMS próprio', stSel.rule);
    }

    // ---------------------------------------------------------- DIFAL (EC 87/2015, LC 190/2022)
    if (c.interstate && operation.direction === 'S' && recipient.ieIndicator === 9 && recipient.finalConsumer && interRate && !billingOnly) {
      const dv = difalSel?.value ?? {};
      if (simples && !dv.applyToSimples) {
        mem(c, 'DIFAL', 'Emitente do Simples Nacional: DIFAL não calculado na nota (cláusula nona do Conv. ICMS 93/2015 suspensa)', undefined, difalSel?.rule);
      } else {
        const destRate = D(dv.destRate ?? tables.icmsInternalRates[recipient.uf as UF] ?? REFERENCE_ICMS_INTERNAL_RATES[recipient.uf as UF]).times(factor);
        const inter = interRate.times(factor);
        const fcpDest = D(dv.fcpDestRate ?? tables.fcpRates?.[recipient.uf as UF] ?? '0').times(factor);
        const mode = dv.base ?? tables.difalBase?.[recipient.uf as UF] ?? 'single';
        const vOp = icmsBase.greaterThan(0) ? icmsBase : valueBase.plus(vIPI);
        let baseDest: Decimal;
        let difal: Decimal;
        if (mode === 'double') {
          // Base dupla: retira o ICMS da origem e inclui o do destino "por dentro"
          const icmsOrigin = vOp.times(inter).dividedBy(HUNDRED);
          baseDest = roundMoney(vOp.minus(icmsOrigin).dividedBy(D(1).minus(destRate.dividedBy(HUNDRED))));
          difal = roundMoney(baseDest.times(destRate).dividedBy(HUNDRED).minus(roundMoney(icmsOrigin)));
        } else {
          baseDest = roundMoney(vOp);
          difal = roundMoney(baseDest.times(destRate.minus(inter)).dividedBy(HUNDRED));
        }
        difal = max(ZERO, difal);
        const vFcpDest = roundMoney(baseDest.times(fcpDest).dividedBy(HUNDRED));
        taxes.difal = { base: m2(baseDest), destRate: r4(destRate), interstateRate: r4(inter), value: m2(difal), fcpBase: m2(baseDest), fcpRate: r4(fcpDest), fcpValue: m2(vFcpDest) };
        mem(c, 'DIFAL', `DIFAL (base ${mode === 'double' ? 'dupla' : 'única'}): base ${br(baseDest)} × (${pctTxt(destRate)} − ${pctTxt(inter)}) = ${br(difal)}${vFcpDest.greaterThan(0) ? `; FCP destino ${br(vFcpDest)}` : ''}`, undefined, difalSel?.rule);
      }
    }
  }

  // ------------------------------------------------------------ ISS (serviços — LC 116/2003)
  let vISS = ZERO;
  if (item.kind === 'service') {
    const issSel = pick(c, 'iss');
    if (!issSel && !simples) throw new FiscalConfigError(`Item ${item.id}: alíquota de ISS não parametrizada para o serviço ${item.serviceCode ?? ''}`, { item: item.id });
    if (issSel) {
      const rate = D(issSel.value.rate).times(factor);
      if (D(issSel.value.rate).lessThan(2) || D(issSel.value.rate).greaterThan(5)) c.warnings.push('Alíquota de ISS fora do intervalo legal de 2% a 5%');
      const base = c.vProd.minus(c.vDesc);
      vISS = roundMoney(base.times(rate).dividedBy(HUNDRED));
      taxes.iss = { base: m2(base), rate: r4(rate), value: m2(vISS), retained: Boolean(issSel.value.retained), serviceCode: item.serviceCode ?? null, exigibility: issSel.value.exigibility ?? 1 };
      if (issSel.value.retained) taxes.retentions.iss = m2(vISS);
      mem(c, 'ISS', `ISS: base ${br(base)} × ${pctTxt(rate)} = ${br(vISS)}${issSel.value.retained ? ' (retido pelo tomador)' : ''}`, undefined, issSel.rule);
    } else {
      mem(c, 'ISS', 'Simples Nacional: ISS recolhido no DAS');
    }
  }

  // ------------------------------------------------------------ PIS / Cofins
  computePisCofins(c, taxes, valueBase, vICMS, simples);

  // ------------------------------------------------------------ IBS / CBS (LC 214/2025)
  computeIbsCbs(c, taxes, valueBase, simples);

  // ------------------------------------------------------------ Imposto Seletivo
  if (input.tables.transition.isActive) {
    const isSel = pick(c, 'is');
    if (isSel) {
      const rate = D(isSel.value.rate);
      const vIS = roundMoney(valueBase.times(rate).dividedBy(HUNDRED));
      taxes.is = { cst: isSel.value.cst ?? '000', cclasstrib: isSel.value.cclasstrib ?? null, base: m2(valueBase), rate: r4(rate), value: m2(vIS) };
      mem(c, 'IS', `Imposto Seletivo: base ${br(valueBase)} × ${pctTxt(rate)} = ${br(vIS)}`, undefined, isSel.rule);
    }
  }

  // ------------------------------------------------------------ retenções (serviços tomados/prestados)
  const retSel = pick(c, 'retentions');
  if (retSel) {
    const base = c.vProd.minus(c.vDesc);
    const r = retSel.value;
    const calc = (rate?: string) => (rate ? m2(base.times(D(rate)).dividedBy(HUNDRED)) : '0.00');
    taxes.retentions = { ...taxes.retentions, irrf: calc(r.irrf), csll: calc(r.csll), pis: calc(r.pis), cofins: calc(r.cofins), inss: calc(r.inss) };
    mem(c, 'RETENÇÕES', `Retenções sobre ${br(base)}: IRRF ${taxes.retentions.irrf}, CSLL ${taxes.retentions.csll}, PIS ${taxes.retentions.pis}, Cofins ${taxes.retentions.cofins}, INSS ${taxes.retentions.inss}`, undefined, retSel.rule);
  }

  const vST = D(taxes.st?.value ?? '0');
  const vFCPST = D(taxes.st?.fcp.value ?? '0');
  const total = c.vProd.minus(c.vDesc).plus(c.vFrete).plus(c.vSeg).plus(c.vOutro).plus(vIPI).plus(vST).plus(vFCPST);
  void vFCP;
  return {
    id: item.id,
    cfop,
    values: { product: m2(c.vProd), discount: m2(c.vDesc), freight: m2(c.vFrete), insurance: m2(c.vSeg), otherExpenses: m2(c.vOutro), total: m2(total) },
    taxes,
    appliedRules: c.applied,
    memory: c.memory,
    warnings: c.warnings,
  };
}

function computePisCofins(c: ItemContext, taxes: ItemTaxes, valueBase: Decimal, vICMS: Decimal, simples: boolean) {
  const { issuer, operation, tables } = c.input;
  if (!tables.transition.pisCofinsActive) {
    taxes.pis = { cst: '08', base: '0.00', rate: '0.0000', value: '0.00' };
    taxes.cofins = { cst: '08', base: '0.00', rate: '0.0000', value: '0.00' };
    mem(c, 'PIS/COFINS', 'PIS e Cofins extintos (substituídos pela CBS a partir de 2027): CST 08');
    return;
  }
  const pisSel = pick(c, 'pis');
  const cofSel = pick(c, 'cofins');
  const exclSel = selectRule(c.input.rules, c.match, 'excludeIcmsFromPisCofinsBase');
  const exclude = exclSel?.value ?? true;
  const exit = operation.direction === 'S';
  const mono = !c.item.ownProduction && c.item.ncm && (tables.monophasicNcms ?? []).some((p) => c.item.ncm!.startsWith(p));
  let defaults: { cst: string; pis: string; cofins: string };
  if (simples) defaults = { cst: exit ? '99' : '98', pis: '0', cofins: '0' };
  else if (exit && SHIPMENT_OF_BILLED.has(operation.purpose)) defaults = { cst: '49', pis: '0', cofins: '0' };
  else if (exit && mono) defaults = { cst: '04', pis: '0', cofins: '0' };
  else if (issuer.regime === 'lucro_presumido') defaults = exit ? { cst: '01', pis: '0.65', cofins: '3' } : { cst: '70', pis: '0', cofins: '0' };
  else if (exit) defaults = { cst: '01', pis: '1.65', cofins: '7.6' };
  else if (['purchase', 'sale_return'].includes(operation.purpose)) defaults = { cst: '50', pis: '1.65', cofins: '7.6' };
  else defaults = { cst: '70', pis: '0', cofins: '0' };

  const taxedCsts = new Set(['01', '02', '03', '50', '51', '52', '53', '54', '55', '56', '60', '61', '62', '63', '64', '65', '66']);
  for (const [name, sel, key] of [['PIS', pisSel, 'pis'], ['COFINS', cofSel, 'cofins']] as const) {
    const cst = sel?.value.cst ?? defaults.cst;
    const rate = D(sel?.value.rate ?? (sel ? '0' : defaults[key]));
    const taxed = taxedCsts.has(cst) && rate.greaterThan(0);
    const base = taxed ? valueBase.minus(exclude ? vICMS : ZERO) : ZERO;
    const value = roundMoney(base.times(rate).dividedBy(HUNDRED));
    taxes[key] = { cst, base: m2(base), rate: r4(rate), value: m2(value) };
    mem(c, name, taxed ? `CST ${cst}: base ${br(base)}${exclude && vICMS.greaterThan(0) ? ' (excluído o ICMS destacado)' : ''} × ${pctTxt(rate)} = ${br(value)}` : `CST ${cst}: sem valor a destacar`, undefined, sel?.rule);
  }
}

function computeIbsCbs(c: ItemContext, taxes: ItemTaxes, valueBase: Decimal, simples: boolean) {
  const { tables, date } = c.input;
  const rates = tables.ibsCbsRates;
  if (!rates || date < '2026-01-01') return;
  // Em 2026, Simples e MEI ainda não informam IBS/CBS; passam a informar em 2027.
  if (simples && date < '2027-01-01') {
    mem(c, 'IBS/CBS', 'Simples Nacional/MEI: grupos de IBS/CBS informados a partir de 2027');
    return;
  }
  const sel = pick(c, 'ibsCbs');
  // RN-REF-01: o cClassTrib do produto é o padrão; regra por tipo de operação é a exceção e prevalece
  const byOperation = sel?.rule.keys.operationCode && sel.value.cclasstrib;
  const code = (byOperation ? sel!.value.cclasstrib : null) ?? c.item.cclasstrib ?? sel?.value.cclasstrib ?? '000001';
  const info = tables.cclasstrib[code];
  if (!info) throw new FiscalConfigError(`cClassTrib ${code} não encontrado na tabela vigente`, { item: c.item.id, rule: 'RN-REF-01' });
  const cst = sel?.value.cst ?? info.cst;
  const redIbs = D(sel?.value.reductionIbs ?? info.reductionIbs);
  const redCbs = D(sel?.value.reductionCbs ?? info.reductionCbs);
  // Base "por fora" (NT 2025.002): exclui ICMS, FCP, DIFAL, ISS, PIS e Cofins durante a transição
  const deductions = sum([taxes.icms.value, taxes.fcp.value, taxes.difal?.value ?? '0', taxes.difal?.fcpValue ?? '0', taxes.iss?.value ?? '0', taxes.pis.value, taxes.cofins.value]);
  const base = roundMoney(max(ZERO, valueBase.minus(deductions)));
  const zeroed = info.exempt || info.deferral;
  const eff = (rate: string, red: Decimal) => (zeroed ? ZERO : D(rate).times(D(1).minus(red.dividedBy(HUNDRED))));
  const effUf = eff(rates.ibsUf, redIbs);
  const effMun = eff(rates.ibsMun, redIbs);
  const effCbs = eff(rates.cbs, redCbs);
  const vUf = roundMoney(base.times(effUf).dividedBy(HUNDRED));
  const vMun = roundMoney(base.times(effMun).dividedBy(HUNDRED));
  const vCbs = roundMoney(base.times(effCbs).dividedBy(HUNDRED));
  taxes.ibsCbs = {
    cst, cclasstrib: code, base: m2(base),
    ibsUf: { rate: r4(rates.ibsUf), reduction: r4(redIbs), effectiveRate: r4(effUf), value: m2(vUf) },
    ibsMun: { rate: r4(rates.ibsMun), reduction: r4(redIbs), effectiveRate: r4(effMun), value: m2(vMun) },
    ibsValue: m2(vUf.plus(vMun)),
    cbs: { rate: r4(rates.cbs), reduction: r4(redCbs), effectiveRate: r4(effCbs), value: m2(vCbs) },
    informative: tables.transition.ibsCbsInformative,
  };
  mem(c, 'IBS/CBS',
    `CST ${cst} / cClassTrib ${code}: base ${br(base)} (valor ${br(valueBase)} − tributos atuais ${br(deductions)}); ` +
      `IBS UF ${pctTxt(effUf)} = ${br(vUf)}; IBS Mun ${pctTxt(effMun)} = ${br(vMun)}; CBS ${pctTxt(effCbs)} = ${br(vCbs)}` +
      (redIbs.greaterThan(0) || redCbs.greaterThan(0) ? ` (redução IBS ${pctTxt(redIbs)}, CBS ${pctTxt(redCbs)})` : '') +
      (tables.transition.ibsCbsInformative ? ' — informativo, fora do total da nota' : ''),
    'base = vProd + frete + seguro + outras − desconto − ICMS − FCP − DIFAL − ISS − PIS − Cofins', sel?.rule);
}

function totalize(items: ItemResult[], input: FiscalOperationInput): Totals {
  const s = (f: (i: ItemResult) => string | undefined | null) => m2(sum(items.map((i) => f(i) ?? '0')));
  const ibs = D(s((i) => i.taxes.ibsCbs?.ibsValue));
  const cbs = D(s((i) => i.taxes.ibsCbs?.cbs.value));
  const isv = D(s((i) => i.taxes.is?.value));
  const invoice = D(s((i) => i.values.total));
  const informative = input.tables.transition.ibsCbsInformative;
  return {
    product: s((i) => i.values.product),
    discount: s((i) => i.values.discount),
    freight: s((i) => i.values.freight),
    insurance: s((i) => i.values.insurance),
    otherExpenses: s((i) => i.values.otherExpenses),
    icmsBase: s((i) => i.taxes.icms.base),
    icms: s((i) => i.taxes.icms.value),
    icmsExempt: s((i) => i.taxes.icms.exemptValue),
    fcp: s((i) => i.taxes.fcp.value),
    stBase: s((i) => i.taxes.st?.base),
    st: s((i) => i.taxes.st?.value),
    fcpSt: s((i) => i.taxes.st?.fcp.value),
    difal: s((i) => i.taxes.difal?.value),
    fcpDest: s((i) => i.taxes.difal?.fcpValue),
    ipi: s((i) => i.taxes.ipi?.value),
    pis: s((i) => i.taxes.pis.value),
    cofins: s((i) => i.taxes.cofins.value),
    issBase: s((i) => i.taxes.iss?.base),
    iss: s((i) => i.taxes.iss?.value),
    ibsCbsBase: s((i) => i.taxes.ibsCbs?.base),
    ibsUf: s((i) => i.taxes.ibsCbs?.ibsUf.value),
    ibsMun: s((i) => i.taxes.ibsCbs?.ibsMun.value),
    ibs: m2(ibs),
    cbs: m2(cbs),
    is: m2(isv),
    simplesCredit: s((i) => i.taxes.icms.simplesCreditValue),
    retentions: {
      irrf: s((i) => i.taxes.retentions.irrf), csll: s((i) => i.taxes.retentions.csll), pis: s((i) => i.taxes.retentions.pis),
      cofins: s((i) => i.taxes.retentions.cofins), inss: s((i) => i.taxes.retentions.inss), iss: s((i) => i.taxes.retentions.iss),
    },
    invoice: m2(invoice),
    invoiceWithNewTaxes: m2(informative ? invoice : invoice.plus(ibs).plus(cbs).plus(isv)),
  };
}
