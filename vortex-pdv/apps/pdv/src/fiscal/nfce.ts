import { createHash } from 'node:crypto';
import { D } from '@vortex/money';
import { UFS, buildAccessKey, type UF } from '@vortex/validators';
import type { FiscalResult } from '@vortex/fiscal-engine';

/**
 * NFC-e modelo 65, leiaute 4.00 (com os grupos de IBS/CBS da NT 2025.002). O XML sai sem
 * assinatura: a assinatura XMLDSig com o certificado A1 da loja é feita pelo provedor fiscal
 * (fornecedor homologado) ou pelo assinador local, conforme a implantação.
 */
export interface Issuer {
  cnpj: string;
  legalName: string;
  tradeName?: string | null;
  ie: string;
  uf: string;
  cityIbge: string;
  cityName: string;
  street: string;
  number: string;
  district: string;
  zip: string;
  phone?: string | null;
  regime: string;
}

export interface NfceItem {
  code: string;
  gtin: string | null;
  description: string;
  ncm: string;
  cest: string | null;
  /** Origem da mercadoria (0 nacional ... 8) */
  origin: number;
  unit: string;
  quantity: string;
  unitPrice: string;
  gross: string;
  discount: string;
}

export interface NfcePayment {
  tPag: string;
  amount: string;
  change: string;
  card?: { brand?: string | null; authorization?: string | null; integrated: boolean } | null;
}

export interface NfceInput {
  issuer: Issuer;
  series: number;
  number: number;
  issuedAt: Date;
  environment: 1 | 2;
  emission: { type: 1 } | { type: 9; at: Date; reason: string };
  numericCode: string;
  customer: { taxId: string; name: string | null } | null;
  items: NfceItem[];
  taxes: FiscalResult;
  approximateTaxes: { items: string[]; total: string };
  payments: NfcePayment[];
  csc: { id: string; token: string };
  additionalInfo?: string;
}

export interface BuiltNfce {
  accessKey: string;
  xml: string;
  qrUrl: string;
  consultUrl: string;
  total: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (name: string, value: string | number | null | undefined) => (value === null || value === undefined || value === '' ? '' : `<${name}>${esc(String(value))}</${name}>`);
const m2 = (v: string) => D(v).toFixed(2);
const q4 = (v: string) => D(v).toFixed(4);
const u10 = (v: string) => D(v).toFixed(10);
/** Data/hora com fuso, como a SEFAZ exige (AAAA-MM-DDThh:mm:ss-03:00) */
export function sefazDateTime(d: Date, offsetMinutes = -180): string {
  const local = new Date(d.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const off = Math.abs(offsetMinutes);
  return `${local.toISOString().slice(0, 19)}${sign}${String(Math.floor(off / 60)).padStart(2, '0')}:${String(off % 60).padStart(2, '0')}`;
}

/** CRT do emitente pelo regime: 1 Simples, 2 Simples com excesso de sublimite, 4 MEI, 3 Regime normal. */
export const crtOf = (regime: string) => (regime === 'simples_nacional' ? 1 : regime === 'simples_excesso_sublimite' ? 2 : regime === 'mei' ? 4 : 3);

/** URL de consulta do QR Code e de consulta por chave, por UF (homologação/produção). Validar com a SEFAZ da UF. */
const QR_URLS: Record<string, [string, string]> = {
  PE: ['http://nfce.sefaz.pe.gov.br/nfce/consulta', 'http://nfcehomolog.sefaz.pe.gov.br/nfce/consulta'],
  SP: ['https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx', 'https://www.homologacao.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx'],
};
export function qrBaseUrl(uf: string, environment: 1 | 2): string {
  const u = QR_URLS[uf];
  return u ? u[environment === 1 ? 0 : 1] : `https://www.sefazvirtual.fazenda.gov.br/nfce/qrcode/${uf}/${environment === 1 ? 'producao' : 'homologacao'}`;
}

/**
 * QR Code da NFC-e versão 2 (NT 2015.002 e atualizações). Online: chave|2|tpAmb|idCSC|hash.
 * Contingência offline: chave|2|tpAmb|dia|vNF|digVal|idCSC|hash. Hash = SHA-1 (hex, maiúsculo)
 * dos parâmetros concatenados ao CSC.
 */
export function qrCodeUrl(p: { accessKey: string; environment: 1 | 2; uf: string; csc: { id: string; token: string }; offline?: { day: string; total: string; digestValue: string } }): string {
  const idCsc = String(Number(p.csc.id));
  const params = p.offline
    ? [p.accessKey, '2', String(p.environment), p.offline.day, p.offline.total, Buffer.from(p.offline.digestValue, 'base64').toString('hex'), idCsc]
    : [p.accessKey, '2', String(p.environment), idCsc];
  const joined = params.join('|');
  const hash = createHash('sha1').update(joined + p.csc.token).digest('hex').toUpperCase();
  return `${qrBaseUrl(p.uf, p.environment)}?p=${joined}|${hash}`;
}

function icmsGroup(t: FiscalResult['items'][number]['taxes'], origin: string): string {
  const i = t.icms;
  if (i.csosn) {
    const g = ['101'].includes(i.csosn) ? `ICMSSN101` : ['201', '202', '203'].includes(i.csosn) ? 'ICMSSN202' : i.csosn === '500' ? 'ICMSSN500' : i.csosn === '900' ? 'ICMSSN900' : 'ICMSSN102';
    const extra = i.csosn === '101' ? tag('pCredSN', D(i.simplesCreditRate).toFixed(4)) + tag('vCredICMSSN', m2(i.simplesCreditValue)) : '';
    return `<ICMS><${g}>${tag('orig', origin)}${tag('CSOSN', i.csosn)}${extra}</${g}></ICMS>`;
  }
  const cst = i.cst ?? '00';
  if (cst === '00') return `<ICMS><ICMS00>${tag('orig', origin)}${tag('CST', cst)}${tag('modBC', i.modBC)}${tag('vBC', m2(i.base))}${tag('pICMS', D(i.rate).toFixed(4))}${tag('vICMS', m2(i.value))}</ICMS00></ICMS>`;
  if (cst === '20') return `<ICMS><ICMS20>${tag('orig', origin)}${tag('CST', cst)}${tag('modBC', i.modBC)}${tag('pRedBC', D(i.baseReduction).toFixed(4))}${tag('vBC', m2(i.base))}${tag('pICMS', D(i.rate).toFixed(4))}${tag('vICMS', m2(i.value))}</ICMS20></ICMS>`;
  if (cst === '60') return `<ICMS><ICMS60>${tag('orig', origin)}${tag('CST', cst)}</ICMS60></ICMS>`;
  if (['40', '41', '50'].includes(cst)) return `<ICMS><ICMS40>${tag('orig', origin)}${tag('CST', cst)}</ICMS40></ICMS>`;
  return `<ICMS><ICMS90>${tag('orig', origin)}${tag('CST', cst)}${tag('modBC', i.modBC)}${tag('vBC', m2(i.base))}${tag('pICMS', D(i.rate).toFixed(4))}${tag('vICMS', m2(i.value))}</ICMS90></ICMS>`;
}

function pisCofins(name: 'PIS' | 'COFINS', t: { cst: string; base: string; rate: string; value: string }): string {
  const aliq = ['01', '02'].includes(t.cst);
  const inner = aliq
    ? `<${name}Aliq>${tag('CST', t.cst)}${tag('vBC', m2(t.base))}${tag(`p${name}`, D(t.rate).toFixed(4))}${tag(`v${name}`, m2(t.value))}</${name}Aliq>`
    : ['04', '05', '06', '07', '08', '09'].includes(t.cst) ? `<${name}NT>${tag('CST', t.cst)}</${name}NT>`
      : `<${name}Outr>${tag('CST', t.cst)}${tag('vBC', m2(t.base))}${tag(`p${name}`, D(t.rate).toFixed(4))}${tag(`v${name}`, m2(t.value))}</${name}Outr>`;
  return `<${name}>${inner}</${name}>`;
}

function ibsCbsGroup(t: FiscalResult['items'][number]['taxes']): string {
  const g = t.ibsCbs;
  if (!g) return '';
  return `<IBSCBS>${tag('CST', g.cst)}${tag('cClassTrib', g.cclasstrib)}<gIBSCBS>${tag('vBC', m2(g.base))}`
    + `<gIBSUF>${tag('pIBSUF', D(g.ibsUf.rate).toFixed(4))}${tag('vIBSUF', m2(g.ibsUf.value))}</gIBSUF>`
    + `<gIBSMun>${tag('pIBSMun', D(g.ibsMun.rate).toFixed(4))}${tag('vIBSMun', m2(g.ibsMun.value))}</gIBSMun>${tag('vIBS', m2(g.ibsValue))}`
    + `<gCBS>${tag('pCBS', D(g.cbs.rate).toFixed(4))}${tag('vCBS', m2(g.cbs.value))}</gCBS></gIBSCBS></IBSCBS>`;
}

/** Digest SHA-1 (base64) do infNFe, como o DigestValue da assinatura; usado no QR Code offline. */
export const digestOf = (infNFe: string) => createHash('sha1').update(infNFe).digest('base64');

export function buildNfce(n: NfceInput): BuiltNfce {
  const e = n.issuer;
  const cUF = UFS[e.uf as UF];
  if (!cUF) throw new Error(`UF do emitente inválida: ${e.uf}`);
  const local = new Date(n.issuedAt.getTime() - 180 * 60_000);
  const aamm = local.toISOString().slice(2, 4) + local.toISOString().slice(5, 7);
  const accessKey = buildAccessKey({ cUF, aamm, cnpj: e.cnpj, modelo: '65', serie: n.series, numero: n.number, tpEmis: String(n.emission.type), cNF: n.numericCode });
  const r = n.taxes;
  const tot = r.totals;
  const dets = n.items.map((it, i) => {
    const res = r.items[i]!;
    const origin = String(it.origin);
    return `<det nItem="${i + 1}"><prod>${tag('cProd', it.code)}${tag('cEAN', it.gtin ?? 'SEM GTIN')}${tag('xProd', n.environment === 2 && i === 0 ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : it.description)}`
      + `${tag('NCM', it.ncm)}${tag('CEST', it.cest)}${tag('CFOP', res.cfop)}${tag('uCom', it.unit)}${tag('qCom', q4(it.quantity))}${tag('vUnCom', u10(it.unitPrice))}${tag('vProd', m2(it.gross))}`
      + `${tag('cEANTrib', it.gtin ?? 'SEM GTIN')}${tag('uTrib', it.unit)}${tag('qTrib', q4(it.quantity))}${tag('vUnTrib', u10(it.unitPrice))}${D(it.discount).greaterThan(0) ? tag('vDesc', m2(it.discount)) : ''}${tag('indTot', 1)}</prod>`
      + `<imposto>${tag('vTotTrib', n.approximateTaxes.items[i])}${icmsGroup(res.taxes, origin)}${pisCofins('PIS', res.taxes.pis)}${pisCofins('COFINS', res.taxes.cofins)}${ibsCbsGroup(res.taxes)}</imposto></det>`;
  }).join('');
  const dest = n.customer
    ? `<dest>${n.customer.taxId.length === 11 ? tag('CPF', n.customer.taxId) : tag('CNPJ', n.customer.taxId)}${tag('xNome', n.customer.name)}${tag('indIEDest', 9)}</dest>` : '';
  const pag = `<pag>${n.payments.map((p) => `<detPag>${tag('tPag', p.tPag)}${tag('vPag', m2(D(p.amount).plus(p.change).toString()))}`
    + (p.card ? `<card>${tag('tpIntegra', p.card.integrated ? 1 : 2)}${tag('tBand', p.card.brand ? brandCode(p.card.brand) : null)}${tag('cAut', p.card.authorization)}</card>` : '') + '</detPag>').join('')}`
    + `${tag('vTroco', m2(n.payments.reduce((a, p) => a.plus(p.change), D(0)).toString()))}</pag>`;
  const contingency = n.emission.type === 9 ? tag('dhCont', sefazDateTime(n.emission.at)) + tag('xJust', n.emission.reason.slice(0, 256).padEnd(15, '.')) : '';
  const ide = `<ide>${tag('cUF', cUF)}${tag('cNF', n.numericCode)}${tag('natOp', 'VENDA')}${tag('mod', 65)}${tag('serie', n.series)}${tag('nNF', n.number)}`
    + `${tag('dhEmi', sefazDateTime(n.issuedAt))}${tag('tpNF', 1)}${tag('idDest', 1)}${tag('cMunFG', e.cityIbge)}${tag('tpImp', 4)}${tag('tpEmis', n.emission.type)}`
    + `${tag('cDV', accessKey.slice(-1))}${tag('tpAmb', n.environment)}${tag('finNFe', 1)}${tag('indFinal', 1)}${tag('indPres', 1)}${tag('procEmi', 0)}${tag('verProc', 'VORTEX PDV 1.0')}${contingency}</ide>`;
  const emit = `<emit>${tag('CNPJ', e.cnpj)}${tag('xNome', e.legalName)}${tag('xFant', e.tradeName)}<enderEmit>${tag('xLgr', e.street)}${tag('nro', e.number)}${tag('xBairro', e.district)}`
    + `${tag('cMun', e.cityIbge)}${tag('xMun', e.cityName)}${tag('UF', e.uf)}${tag('CEP', e.zip)}${tag('cPais', 1058)}${tag('xPais', 'BRASIL')}${tag('fone', e.phone)}</enderEmit>${tag('IE', e.ie)}${tag('CRT', crtOf(e.regime))}</emit>`;
  const total = `<total><ICMSTot>${tag('vBC', m2(tot.icmsBase))}${tag('vICMS', m2(tot.icms))}${tag('vICMSDeson', '0.00')}${tag('vFCP', m2(tot.fcp))}${tag('vBCST', m2(tot.stBase))}${tag('vST', m2(tot.st))}`
    + `${tag('vFCPST', m2(tot.fcpSt))}${tag('vFCPSTRet', '0.00')}${tag('vProd', m2(tot.product))}${tag('vFrete', '0.00')}${tag('vSeg', '0.00')}${tag('vDesc', m2(tot.discount))}${tag('vII', '0.00')}`
    + `${tag('vIPI', m2(tot.ipi))}${tag('vIPIDevol', '0.00')}${tag('vPIS', m2(tot.pis))}${tag('vCOFINS', m2(tot.cofins))}${tag('vOutro', '0.00')}${tag('vNF', m2(tot.invoice))}${tag('vTotTrib', n.approximateTaxes.total)}</ICMSTot>`
    + (D(tot.ibsCbsBase).greaterThan(0) ? `<IBSCBSTot>${tag('vBCIBSCBS', m2(tot.ibsCbsBase))}<gIBS>${tag('vIBS', m2(tot.ibs))}</gIBS><gCBS>${tag('vCBS', m2(tot.cbs))}</gCBS></IBSCBSTot>` : '') + '</total>';
  const infAdic = `<infAdic>${tag('infCpl', [n.additionalInfo, `Tributos aproximados: R$ ${n.approximateTaxes.total} (Lei 12.741/2012)`].filter(Boolean).join(' | '))}</infAdic>`;
  const infNFe = `<infNFe versao="4.00" Id="NFe${accessKey}">${ide}${emit}${dest}${dets}${total}<transp>${tag('modFrete', 9)}</transp>${pag}${infAdic}</infNFe>`;
  const day = sefazDateTime(n.issuedAt).slice(8, 10);
  const qrUrl = qrCodeUrl({ accessKey, environment: n.environment, uf: e.uf, csc: n.csc,
    offline: n.emission.type === 9 ? { day, total: m2(tot.invoice), digestValue: digestOf(infNFe) } : undefined });
  const consultUrl = qrBaseUrl(e.uf, n.environment).replace(/\?.*$/, '');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe">${infNFe}<infNFeSupl>${tag('qrCode', qrUrl)}${tag('urlChave', consultUrl)}</infNFeSupl></NFe>`;
  return { accessKey, xml, qrUrl, consultUrl, total: m2(tot.invoice) };
}

/** Código da bandeira do cartão (tBand) */
export function brandCode(brand: string): string {
  const b = brand.toUpperCase();
  return ({ VISA: '01', MASTERCARD: '02', MASTER: '02', AMEX: '03', 'AMERICAN EXPRESS': '03', SOROCRED: '04', DINERS: '05', ELO: '06', HIPERCARD: '07', AURA: '08', CABAL: '09' } as Record<string, string>)[b] ?? '99';
}
