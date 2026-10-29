import { D } from '@vortex/money';
import { UFS, cleanDoc, type UF } from '@vortex/validators';

/**
 * Gerador do XML da NF-e/NFC-e, leiaute 4.00 com os grupos da reforma tributária
 * (NT 2025.002: IBSCBS por item, IBSCBSTot e vNFTot). Os campos de IBS/CBS são
 * SEMPRE preenchidos, sem depender da trava da SEFAZ (seção 08).
 * A validação contra o XSD oficial roda no pipeline de homologação.
 */
export interface XmlTax {
  tax: string;
  cst: string | null;
  base: string;
  rate: string;
  value: string;
  details: Record<string, any>;
}

export interface XmlItem {
  item_number: number;
  sku: string;
  description: string;
  gtin: string | null;
  ncm: string | null;
  cest: string | null;
  origin: number;
  cfop: string;
  unit: string;
  quantity: string;
  unit_price: string;
  total: string;
  taxable_unit: string;
  taxable_quantity: string;
  taxable_unit_price: string;
  discount: string;
  freight: string;
  insurance: string;
  other_expenses: string;
  service_code: string | null;
  additional_info: string | null;
  taxes: XmlTax[];
  original_access_key?: string | null;
  original_item_number?: number | null;
}

export interface XmlDoc {
  access_key: string;
  numeric_code: string;
  model: string;
  series: number;
  number: number;
  operation_nature: string;
  issued_at: string;
  exit_at: string | null;
  direction: 'S' | 'E';
  purpose: number;
  presence: number;
  final_consumer: boolean;
  environment: number;
  emission_type: number;
  contingency_reason: string | null;
  contingency_at: string | null;
  regime: string;
  recipient_tax_id: string | null;
  recipient_name: string | null;
  recipient_ie: string | null;
  recipient_ie_indicator: number | null;
  recipient_uf: string | null;
  recipient_address: Record<string, any> | null;
  recipient_email: string | null;
  freight_mode: number;
  volumes: any[];
  payments: { tPag: string; value: string; indPag?: number }[];
  installments: { number: string; dueDate: string; amount: string }[];
  additional_info: string | null;
  totals: Record<string, any>;
  references: string[];
}

export interface XmlIssuer {
  cnpj: string;
  legal_name: string;
  trade_name: string | null;
  ie: string | null;
  im: string | null;
  cnae: string | null;
  uf: string;
  city_ibge: string;
  city_name: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  zip: string;
  phone: string | null;
}

const esc = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').trim();
const tag = (name: string, value: unknown) => (value === null || value === undefined || value === '' ? '' : `<${name}>${esc(value)}</${name}>`);
const n2 = (v: unknown) => D(String(v ?? '0')).toFixed(2);
const n4 = (v: unknown) => D(String(v ?? '0')).toFixed(4);
const n10 = (v: unknown) => D(String(v ?? '0')).toFixed(10);
const nonZero = (v: unknown) => !D(String(v ?? '0')).isZero();

const CRT: Record<string, number> = { simples_nacional: 1, simples_excesso_sublimite: 2, lucro_presumido: 3, lucro_real: 3, mei: 4 };
const HOMOLOG_NAME = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

function docId(taxId: string | null) {
  if (!taxId) return '';
  const t = cleanDoc(taxId);
  return t.length === 11 ? tag('CPF', t) : tag('CNPJ', t);
}

function icmsGroup(it: XmlItem): string {
  const t = (k: string) => it.taxes.find((x) => x.tax === k);
  const icms = t('ICMS');
  const st = t('ICMS_ST');
  const fcp = t('FCP');
  const fcpSt = t('FCP_ST');
  const credit = t('ICMS_SN_CREDIT');
  const cst = icms?.cst ?? '41';
  const orig = tag('orig', it.origin);
  const stFields = st
    ? `${tag('modBCST', st.details.pautaUnitValue ? 5 : 4)}${nonZero(st.details.mva) ? tag('pMVAST', n4(st.details.adjustedMva ?? st.details.mva)) : ''}${nonZero(st.details.baseReduction) ? tag('pRedBCST', n4(st.details.baseReduction)) : ''}` +
      `${tag('vBCST', n2(st.base))}${tag('pICMSST', n4(st.rate))}${tag('vICMSST', n2(st.value))}` +
      (fcpSt && nonZero(fcpSt.value) ? `${tag('vBCFCPST', n2(fcpSt.base))}${tag('pFCPST', n4(fcpSt.rate))}${tag('vFCPST', n2(fcpSt.value))}` : '')
    : '';
  const fcpFields = fcp && nonZero(fcp.value) ? `${tag('pFCP', n4(fcp.rate))}${tag('vFCP', n2(fcp.value))}` : '';
  if (cst.length === 3) {
    // Simples Nacional (CSOSN)
    const credFields = credit && nonZero(credit.value) ? `${tag('pCredSN', n4(credit.rate))}${tag('vCredICMSSN', n2(credit.value))}` : '';
    switch (cst) {
      case '101': return `<ICMSSN101>${orig}${tag('CSOSN', cst)}${credFields}</ICMSSN101>`;
      case '102': case '103': case '300': case '400': return `<ICMSSN102>${orig}${tag('CSOSN', cst)}</ICMSSN102>`;
      case '201': return `<ICMSSN201>${orig}${tag('CSOSN', cst)}${stFields}${credFields}</ICMSSN201>`;
      case '202': case '203': return `<ICMSSN202>${orig}${tag('CSOSN', cst)}${stFields}</ICMSSN202>`;
      case '500': return `<ICMSSN500>${orig}${tag('CSOSN', cst)}</ICMSSN500>`;
      default:
        return `<ICMSSN900>${orig}${tag('CSOSN', cst)}${icms && nonZero(icms.value) ? `${tag('modBC', 3)}${tag('vBC', n2(icms.base))}${tag('pICMS', n4(icms.rate))}${tag('vICMS', n2(icms.value))}` : ''}${stFields}${credFields}</ICMSSN900>`;
    }
  }
  const own = icms ? `${tag('modBC', 3)}${nonZero(icms.details.baseReduction) ? tag('pRedBC', n4(icms.details.baseReduction)) : ''}${tag('vBC', n2(icms.base))}${tag('pICMS', n4(icms.rate))}` : '';
  switch (cst) {
    case '00': return `<ICMS00>${orig}${tag('CST', cst)}${tag('modBC', 3)}${tag('vBC', n2(icms!.base))}${tag('pICMS', n4(icms!.rate))}${tag('vICMS', n2(icms!.value))}${fcpFields}</ICMS00>`;
    case '10': return `<ICMS10>${orig}${tag('CST', cst)}${tag('modBC', 3)}${tag('vBC', n2(icms!.base))}${tag('pICMS', n4(icms!.rate))}${tag('vICMS', n2(icms!.value))}${fcpFields}${stFields}</ICMS10>`;
    case '20': return `<ICMS20>${orig}${tag('CST', cst)}${own}${tag('vICMS', n2(icms!.value))}${fcpFields}</ICMS20>`;
    case '30': return `<ICMS30>${orig}${tag('CST', cst)}${stFields}</ICMS30>`;
    case '40': case '41': case '50':
      return `<ICMS40>${orig}${tag('CST', cst)}${icms?.details.exemptionReason ? `${tag('vICMSDeson', n2(icms.details.exemptValue))}${tag('motDesICMS', icms.details.exemptionReason)}` : ''}</ICMS40>`;
    case '51': return `<ICMS51>${orig}${tag('CST', cst)}${own}${tag('vICMSOp', n2(icms!.details.operationValue))}${tag('pDif', n4(icms!.details.deferralRate))}${tag('vICMSDif', n2(icms!.details.deferredValue))}${tag('vICMS', n2(icms!.value))}</ICMS51>`;
    case '60': return `<ICMS60>${orig}${tag('CST', cst)}</ICMS60>`;
    case '70': return `<ICMS70>${orig}${tag('CST', cst)}${own}${tag('vICMS', n2(icms!.value))}${fcpFields}${stFields}</ICMS70>`;
    default: return `<ICMS90>${orig}${tag('CST', cst)}${icms && nonZero(icms.value) ? `${own}${tag('vICMS', n2(icms.value))}` : ''}${stFields}</ICMS90>`;
  }
}

function pisCofins(it: XmlItem, k: 'PIS' | 'COFINS'): string {
  const t = it.taxes.find((x) => x.tax === k);
  const cst = t?.cst ?? '99';
  const taxed = ['01', '02'].includes(cst);
  const nt = ['04', '05', '06', '07', '08', '09'].includes(cst);
  if (taxed) return `<${k}><${k}Aliq>${tag('CST', cst)}${tag('vBC', n2(t!.base))}${tag(`p${k}`, n4(t!.rate))}${tag(`v${k}`, n2(t!.value))}</${k}Aliq></${k}>`;
  if (nt) return `<${k}><${k}NT>${tag('CST', cst)}</${k}NT></${k}>`;
  return `<${k}><${k}Outr>${tag('CST', cst)}${tag('vBC', n2(t?.base ?? '0'))}${tag(`p${k}`, n4(t?.rate ?? '0'))}${tag(`v${k}`, n2(t?.value ?? '0'))}</${k}Outr></${k}>`;
}

function ibsCbsGroup(it: XmlItem): string {
  const uf = it.taxes.find((x) => x.tax === 'IBS_UF');
  const mun = it.taxes.find((x) => x.tax === 'IBS_MUN');
  const cbs = it.taxes.find((x) => x.tax === 'CBS');
  if (!uf || !cbs) return '';
  const red = (t: XmlTax) => (nonZero(t.details.reduction) ? `<gRed>${tag('pRedAliq', n4(t.details.reduction))}${tag('pAliqEfet', n4(t.details.effectiveRate))}</gRed>` : '');
  const vIBS = D(uf.value).plus(mun?.value ?? '0');
  return `<IBSCBS>${tag('CST', uf.cst ?? '000')}${tag('cClassTrib', uf.details.cclasstrib ?? '000001')}<gIBSCBS>${tag('vBC', n2(uf.base))}` +
    `<gIBSUF>${tag('pIBSUF', n4(uf.details.nominalRate ?? uf.rate))}${red(uf)}${tag('vIBSUF', n2(uf.value))}</gIBSUF>` +
    `<gIBSMun>${tag('pIBSMun', n4(mun?.details.nominalRate ?? mun?.rate ?? '0'))}${mun ? red(mun) : ''}${tag('vIBSMun', n2(mun?.value ?? '0'))}</gIBSMun>` +
    `${tag('vIBS', vIBS.toFixed(2))}<gCBS>${tag('pCBS', n4(cbs.details.nominalRate ?? cbs.rate))}${red(cbs)}${tag('vCBS', n2(cbs.value))}</gCBS></gIBSCBS></IBSCBS>`;
}

export function buildNfeXml(doc: XmlDoc, issuer: XmlIssuer, items: XmlItem[]): string {
  const cUF = UFS[issuer.uf as UF];
  const dest = doc.recipient_uf;
  const idDest = !dest || dest === issuer.uf ? 1 : dest === 'EX' ? 3 : 2;
  const homolog = doc.environment === 2;
  const nfce = doc.model === '65';
  const refs = doc.references.map((k) => `<NFref>${tag('refNFe', k)}</NFref>`).join('');
  const ide = `<ide>${tag('cUF', cUF)}${tag('cNF', doc.numeric_code)}${tag('natOp', doc.operation_nature.slice(0, 60))}${tag('mod', doc.model)}${tag('serie', doc.series)}` +
    `${tag('nNF', doc.number)}${tag('dhEmi', doc.issued_at)}${nfce ? '' : tag('dhSaiEnt', doc.exit_at ?? undefined)}${tag('tpNF', doc.direction === 'S' ? 1 : 0)}${tag('idDest', idDest)}` +
    `${tag('cMunFG', issuer.city_ibge)}${tag('tpImp', nfce ? 4 : 1)}${tag('tpEmis', doc.emission_type)}${tag('cDV', doc.access_key.slice(-1))}${tag('tpAmb', doc.environment)}` +
    `${tag('finNFe', doc.purpose)}${tag('indFinal', doc.final_consumer ? 1 : 0)}${tag('indPres', doc.presence)}${tag('procEmi', 0)}${tag('verProc', 'VORTEX-ERP-1.0')}` +
    `${doc.emission_type !== 1 ? `${tag('dhCont', doc.contingency_at)}${tag('xJust', (doc.contingency_reason ?? 'SEFAZ indisponivel').slice(0, 256))}` : ''}${refs}</ide>`;
  const emit = `<emit>${tag('CNPJ', issuer.cnpj)}${tag('xNome', issuer.legal_name)}${tag('xFant', issuer.trade_name)}<enderEmit>${tag('xLgr', issuer.street)}${tag('nro', issuer.number)}` +
    `${tag('xCpl', issuer.complement)}${tag('xBairro', issuer.district)}${tag('cMun', issuer.city_ibge)}${tag('xMun', issuer.city_name)}${tag('UF', issuer.uf)}${tag('CEP', issuer.zip)}` +
    `${tag('cPais', '1058')}${tag('xPais', 'Brasil')}${tag('fone', issuer.phone?.replace(/\D/g, ''))}</enderEmit>${tag('IE', issuer.ie)}${tag('IM', issuer.im)}${issuer.im ? tag('CNAE', issuer.cnae) : ''}` +
    `${tag('CRT', CRT[doc.regime] ?? 3)}</emit>`;
  const a = doc.recipient_address ?? {};
  const destXml = doc.recipient_tax_id || doc.recipient_uf === 'EX'
    ? `<dest>${doc.recipient_uf === 'EX' ? tag('idEstrangeiro', a.foreignId ?? '') : docId(doc.recipient_tax_id)}${tag('xNome', homolog ? HOMOLOG_NAME : doc.recipient_name)}` +
      (a.street ? `<enderDest>${tag('xLgr', a.street)}${tag('nro', a.number)}${tag('xCpl', a.complement)}${tag('xBairro', a.district)}${tag('cMun', doc.recipient_uf === 'EX' ? '9999999' : a.cityIbge)}` +
        `${tag('xMun', doc.recipient_uf === 'EX' ? 'EXTERIOR' : a.cityName)}${tag('UF', doc.recipient_uf)}${tag('CEP', a.zip)}${tag('cPais', a.countryCode ?? '1058')}</enderDest>` : '') +
      `${tag('indIEDest', doc.recipient_ie_indicator ?? 9)}${doc.recipient_ie_indicator === 1 ? tag('IE', doc.recipient_ie) : ''}${tag('email', doc.recipient_email)}</dest>`
    : '';
  const dets = items.map((it) => {
    const ipi = it.taxes.find((x) => x.tax === 'IPI');
    const iss = it.taxes.find((x) => x.tax === 'ISS');
    const difal = it.taxes.find((x) => x.tax === 'DIFAL');
    const fcpDest = it.taxes.find((x) => x.tax === 'FCP_DEST');
    const is = it.taxes.find((x) => x.tax === 'IS');
    const prod = `<prod>${tag('cProd', it.sku)}${tag('cEAN', it.gtin || 'SEM GTIN')}${tag('xProd', homolog && it.item_number === 1 && nfce ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : it.description)}` +
      `${tag('NCM', it.ncm ?? '00')}${tag('CEST', it.cest)}${tag('cBenef', it.taxes.find((x) => x.tax === 'ICMS')?.details.benefitCode)}${tag('CFOP', it.cfop)}${tag('uCom', it.unit)}${tag('qCom', n4(it.quantity))}${tag('vUnCom', n10(it.unit_price))}${tag('vProd', n2(it.total))}` +
      `${tag('cEANTrib', it.gtin || 'SEM GTIN')}${tag('uTrib', it.taxable_unit)}${tag('qTrib', n4(it.taxable_quantity))}${tag('vUnTrib', n10(it.taxable_unit_price))}` +
      `${nonZero(it.freight) ? tag('vFrete', n2(it.freight)) : ''}${nonZero(it.insurance) ? tag('vSeg', n2(it.insurance)) : ''}${nonZero(it.discount) ? tag('vDesc', n2(it.discount)) : ''}` +
      `${nonZero(it.other_expenses) ? tag('vOutro', n2(it.other_expenses)) : ''}${tag('indTot', 1)}</prod>`;
    const imposto = `<imposto>${iss ? '' : `<ICMS>${icmsGroup(it)}</ICMS>`}` +
      (ipi ? `<IPI>${tag('cEnq', ipi.details.enqCode ?? '999')}${['00', '49', '50', '99'].includes(ipi.cst ?? '') ? `<IPITrib>${tag('CST', ipi.cst)}${tag('vBC', n2(ipi.base))}${tag('pIPI', n4(ipi.rate))}${tag('vIPI', n2(ipi.value))}</IPITrib>` : `<IPINT>${tag('CST', ipi.cst)}</IPINT>`}</IPI>` : '') +
      `${pisCofins(it, 'PIS')}${pisCofins(it, 'COFINS')}` +
      (iss ? `<ISSQN>${tag('vBC', n2(iss.base))}${tag('vAliq', n4(iss.rate))}${tag('vISSQN', n2(iss.value))}${tag('cMunFG', issuer.city_ibge)}${tag('cListServ', it.service_code)}${tag('indISS', iss.details.exigibility ?? 1)}${tag('indIncentivo', 2)}</ISSQN>` : '') +
      (difal ? `<ICMSUFDest>${tag('vBCUFDest', n2(difal.base))}${tag('vBCFCPUFDest', n2(fcpDest?.base ?? '0'))}${tag('pFCPUFDest', n4(fcpDest?.rate ?? '0'))}${tag('pICMSUFDest', n4(difal.details.destRate))}${tag('pICMSInter', n2(difal.details.interstateRate))}${tag('pICMSInterPart', '100.0000')}${tag('vFCPUFDest', n2(fcpDest?.value ?? '0'))}${tag('vICMSUFDest', n2(difal.value))}${tag('vICMSUFRemet', '0.00')}</ICMSUFDest>` : '') +
      (is ? `<IS>${tag('CSTIS', is.cst ?? '000')}${tag('cClassTribIS', is.details.cclasstrib ?? '000001')}${tag('vBCIS', n2(is.base))}${tag('pIS', n4(is.rate))}${tag('vIS', n2(is.value))}</IS>` : '') +
      `${ibsCbsGroup(it)}</imposto>`;
    const devol = it.original_access_key ? `<DFeReferenciado>${tag('chaveAcesso', it.original_access_key)}${tag('nItem', it.original_item_number)}</DFeReferenciado>` : '';
    return `<det nItem="${it.item_number}">${prod}${imposto}${tag('infAdProd', it.additional_info)}${devol}</det>`;
  }).join('');
  const t = doc.totals;
  const icmsTot = `<ICMSTot>${tag('vBC', n2(t.icmsBase))}${tag('vICMS', n2(t.icms))}${tag('vICMSDeson', n2(t.icmsExempt))}${tag('vFCPUFDest', n2(t.fcpDest))}${tag('vICMSUFDest', n2(t.difal))}` +
    `${tag('vICMSUFRemet', '0.00')}${tag('vFCP', n2(t.fcp))}${tag('vBCST', n2(t.stBase))}${tag('vST', n2(t.st))}${tag('vFCPST', n2(t.fcpSt))}${tag('vFCPSTRet', '0.00')}` +
    `${tag('vProd', n2(t.product))}${tag('vFrete', n2(t.freight))}${tag('vSeg', n2(t.insurance))}${tag('vDesc', n2(t.discount))}${tag('vII', '0.00')}${tag('vIPI', n2(t.ipi))}` +
    `${tag('vIPIDevol', '0.00')}${tag('vPIS', n2(t.pis))}${tag('vCOFINS', n2(t.cofins))}${tag('vOutro', n2(t.otherExpenses))}${tag('vNF', n2(t.invoice))}</ICMSTot>`;
  const issTot = nonZero(t.iss) ? `<ISSQNtot>${tag('vServ', n2(t.issBase))}${tag('vBC', n2(t.issBase))}${tag('vISS', n2(t.iss))}${tag('dCompet', doc.issued_at.slice(0, 10))}</ISSQNtot>` : '';
  const ibsTot = nonZero(t.ibsCbsBase) || items.some((i) => i.taxes.some((x) => x.tax === 'CBS'))
    ? `<IBSCBSTot>${tag('vBCIBSCBS', n2(t.ibsCbsBase))}<gIBS><gIBSUF>${tag('vDif', '0.00')}${tag('vDevTrib', '0.00')}${tag('vIBSUF', n2(t.ibsUf))}</gIBSUF>` +
      `<gIBSMun>${tag('vDif', '0.00')}${tag('vDevTrib', '0.00')}${tag('vIBSMun', n2(t.ibsMun))}</gIBSMun>${tag('vIBS', n2(t.ibs))}${tag('vCredPres', '0.00')}${tag('vCredPresCondSus', '0.00')}</gIBS>` +
      `<gCBS>${tag('vDif', '0.00')}${tag('vDevTrib', '0.00')}${tag('vCBS', n2(t.cbs))}${tag('vCredPres', '0.00')}${tag('vCredPresCondSus', '0.00')}</gCBS></IBSCBSTot>`
    : '';
  const isTot = nonZero(t.is) ? `<ISTot>${tag('vIS', n2(t.is))}</ISTot>` : '';
  const total = `<total>${icmsTot}${issTot}${isTot}${ibsTot}${tag('vNFTot', n2(t.invoiceWithNewTaxes ?? t.invoice))}</total>`;
  const vols = (doc.volumes ?? []).map((v: any) => `<vol>${tag('qVol', v.quantity)}${tag('esp', v.kind)}${tag('pesoL', v.netWeight ? n4(v.netWeight).slice(0, -1) : undefined)}${tag('pesoB', v.grossWeight ? n4(v.grossWeight).slice(0, -1) : undefined)}</vol>`).join('');
  const transp = `<transp>${tag('modFrete', doc.freight_mode)}${vols}</transp>`;
  const cobr = doc.installments.length && !nfce
    ? `<cobr><fat>${tag('nFat', doc.number)}${tag('vOrig', n2(t.invoice))}${tag('vDesc', '0.00')}${tag('vLiq', n2(t.invoice))}</fat>${doc.installments.map((d) => `<dup>${tag('nDup', d.number)}${tag('dVenc', d.dueDate)}${tag('vDup', n2(d.amount))}</dup>`).join('')}</cobr>`
    : '';
  const pays = doc.payments.length ? doc.payments : [{ tPag: '90', value: '0.00' }];
  const pag = `<pag>${pays.map((p) => `<detPag>${p.indPag !== undefined ? tag('indPag', p.indPag) : ''}${tag('tPag', p.tPag)}${tag('vPag', n2(p.value))}</detPag>`).join('')}</pag>`;
  const infAdic = doc.additional_info ? `<infAdic>${tag('infCpl', doc.additional_info.slice(0, 5000))}</infAdic>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${doc.access_key}" versao="4.00">${ide}${emit}${destXml}${dets}${total}${transp}${cobr}${pag}${infAdic}</infNFe></NFe>`;
}
