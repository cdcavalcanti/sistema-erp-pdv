import { D, sum } from '@vortex/money';

/**
 * DPS — Declaração de Prestação de Serviço do padrão nacional da NFS-e (leiaute 1.00),
 * com o grupo IBSCBS da reforma. Uma DPS descreve um único serviço (código de
 * tributação nacional); serviços diferentes viram DPS separadas.
 */
const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (v: unknown) => D(String(v ?? 0)).toFixed(2);

/** Item da LC 116 ("17.01") → código de tributação nacional (6 dígitos: item, subitem, desdobro). */
export function nationalServiceCode(lc116: string): string {
  const [item, sub = '01'] = lc116.split('.');
  return `${item!.padStart(2, '0')}${sub.padStart(2, '0')}01`;
}

const SIMPLES = ['simples_nacional', 'mei', 'simples_excesso_sublimite'];

export function buildDpsXml(doc: Record<string, any>, issuer: Record<string, any>, items: (Record<string, any> & { taxes: Record<string, any>[] })[]): string {
  const codes = [...new Set(items.map((i) => i.service_code))];
  if (codes.length !== 1 || !codes[0]) throw new Error('A DPS aceita um único código de serviço (LC 116)');
  const tax = (t: string) => items.flatMap((i) => i.taxes).filter((x) => x.tax === t);
  const vServ = sum(items.map((i) => D(i.total).minus(i.discount)));
  const iss = tax('ISS');
  const issRate = iss[0]?.rate ?? '0';
  const retained = Boolean(iss[0]?.details?.retained);
  const cbs = sum(tax('CBS').map((t) => t.value));
  const ibsUf = sum(tax('IBS_UF').map((t) => t.value));
  const ibsMun = sum(tax('IBS_MUN').map((t) => t.value));
  const ibsCbsBase = tax('CBS')[0]?.base;
  const cst = tax('CBS')[0]?.cst ?? '000';
  const cclass = tax('CBS')[0]?.details?.cclasstrib ?? items[0]!.cclasstrib ?? '000001';
  const tpInsc = '2';
  const id = `DPS${issuer.city_ibge}${tpInsc}${String(issuer.cnpj).padStart(14, '0')}${String(doc.series).padStart(5, '0')}${String(doc.number).padStart(15, '0')}`;
  const addr = doc.recipient_address ?? {};
  const takerDoc = doc.recipient_tax_id ? (String(doc.recipient_tax_id).length === 11 ? `<CPF>${doc.recipient_tax_id}</CPF>` : `<CNPJ>${doc.recipient_tax_id}</CNPJ>`) : '';
  const simples = SIMPLES.includes(doc.regime);
  const ibscbs = ibsCbsBase ? `<IBSCBS><finNFSe>0</finNFSe><indFinal>${doc.final_consumer ? 1 : 0}</indFinal><cIndOp>100301</cIndOp><indDest>0</indDest>`
    + `<valores><trib><gIBSCBS><CST>${esc(cst)}</CST><cClassTrib>${esc(cclass)}</cClassTrib></gIBSCBS></trib></valores>`
    + `<totCIBS><vTotNF>${money(vServ)}</vTotNF><gIBS><vIBSTot>${money(ibsUf.plus(ibsMun))}</vIBSTot><gIBSUFTot><vIBSUF>${money(ibsUf)}</vIBSUF></gIBSUFTot><gIBSMunTot><vIBSMun>${money(ibsMun)}</vIBSMun></gIBSMunTot></gIBS>`
    + `<gCBS><vCBS>${money(cbs)}</vCBS></gCBS></totCIBS></IBSCBS>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.00"><infDPS Id="${id}">`
    + `<tpAmb>${doc.environment}</tpAmb><dhEmi>${new Date(doc.issued_at ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, '-00:00')}</dhEmi><verAplic>VORTEX-1.0</verAplic>`
    + `<serie>${doc.series}</serie><nDPS>${doc.number}</nDPS><dCompet>${String(doc.tax_date).slice(0, 10)}</dCompet><tpEmit>1</tpEmit><cLocEmi>${issuer.city_ibge}</cLocEmi>`
    + `<prest><CNPJ>${issuer.cnpj}</CNPJ>${issuer.im ? `<IM>${esc(issuer.im)}</IM>` : ''}<regTrib><opSimpNac>${simples ? (doc.regime === 'mei' ? 2 : 3) : 1}</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>`
    + `<toma>${takerDoc}<xNome>${esc(doc.recipient_name ?? 'Consumidor')}</xNome>`
    + (addr.cityIbge ? `<end><endNac><cMun>${addr.cityIbge}</cMun><CEP>${esc(addr.zip ?? '')}</CEP></endNac><xLgr>${esc(addr.street)}</xLgr><nro>${esc(addr.number)}</nro><xBairro>${esc(addr.district)}</xBairro></end>` : '')
    + `${doc.recipient_email ? `<email>${esc(doc.recipient_email)}</email>` : ''}</toma>`
    + `<serv><locPrest><cLocPrestacao>${issuer.city_ibge}</cLocPrestacao></locPrest><cServ><cTribNac>${nationalServiceCode(codes[0])}</cTribNac>`
    + `<xDescServ>${esc(items.map((i) => `${i.description}${D(i.quantity).equals(1) ? '' : ` (${D(i.quantity).toString()} ${i.unit})`}`).join('; ').slice(0, 2000))}</xDescServ>`
    + `${items[0]!.nbs ? `<cNBS>${esc(items[0]!.nbs)}</cNBS>` : ''}</cServ></serv>`
    + `<valores><vServPrest><vServ>${money(vServ)}</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN>${simples ? '' : `<pAliq>${D(issRate).toFixed(2)}</pAliq>`}`
    + `<tpRetISSQN>${retained ? 2 : 1}</tpRetISSQN></tribMun><totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores>`
    + `${ibscbs}</infDPS></DPS>`;
}
