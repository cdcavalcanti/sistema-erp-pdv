import { D } from '@vortex/money';
import { buildAccessKey } from '@vortex/validators';

/** XML de NF-e de fornecedor para os testes de recebimento (fixture). */
export interface XmlItem {
  code: string; ean?: string | null; description: string; ncm?: string; cfop?: string; unit?: string; quantity: string; unitPrice: string; discount?: string;
  icmsCst?: string; icmsRate?: string; ipi?: string; st?: string; pisCst?: string; pis?: string; cofins?: string; ibs?: string; cbs?: string; lot?: { number: string; expiresAt: string };
}
let nfeSeq = 1000;
export function supplierNfe(o: { supplierCnpj: string; supplierUf?: string; recipientCnpj: string; issuedAt?: string; items: XmlItem[]; dups?: { dueDate: string; amount: string }[]; crt?: string }) {
  const number = ++nfeSeq;
  const issued = o.issuedAt ?? `${new Date().toISOString().slice(0, 10)}T10:00:00-03:00`;
  const key = buildAccessKey({ cUF: '35', aamm: issued.slice(2, 4) + issued.slice(5, 7), cnpj: o.supplierCnpj, modelo: '55', serie: 1, numero: number, tpEmis: '1', cNF: String(number * 7).padStart(8, '0') });
  const tot = { prod: D(0), desc: D(0), ipi: D(0), st: D(0), icms: D(0), pis: D(0), cofins: D(0), ibs: D(0), cbs: D(0) };
  const det = o.items.map((it, i) => {
    const prod = D(it.quantity).times(it.unitPrice).toDecimalPlaces(2);
    const disc = D(it.discount ?? 0);
    const base = prod.minus(disc);
    const icms = it.icmsRate ? base.times(it.icmsRate).dividedBy(100).toDecimalPlaces(2) : D(0);
    tot.prod = tot.prod.plus(prod); tot.desc = tot.desc.plus(disc); tot.ipi = tot.ipi.plus(it.ipi ?? 0); tot.st = tot.st.plus(it.st ?? 0); tot.icms = tot.icms.plus(icms);
    tot.pis = tot.pis.plus(it.pis ?? 0); tot.cofins = tot.cofins.plus(it.cofins ?? 0); tot.ibs = tot.ibs.plus(it.ibs ?? 0); tot.cbs = tot.cbs.plus(it.cbs ?? 0);
    const cst = it.icmsCst ?? '00';
    const icmsGroup = cst.length === 3 ? `<ICMSSN${cst}><orig>0</orig><CSOSN>${cst}</CSOSN></ICMSSN${cst}>`
      : `<ICMS${cst}><orig>0</orig><CST>${cst}</CST><vBC>${base.toFixed(2)}</vBC><pICMS>${it.icmsRate ?? '0'}</pICMS><vICMS>${icms.toFixed(2)}</vICMS>${it.st ? `<vBCST>${base.toFixed(2)}</vBCST><vICMSST>${it.st}</vICMSST>` : ''}</ICMS${cst}>`;
    return `<det nItem="${i + 1}"><prod><cProd>${it.code}</cProd><cEAN>${it.ean ?? 'SEM GTIN'}</cEAN><xProd>${it.description}</xProd><NCM>${it.ncm ?? '61091000'}</NCM><CFOP>${it.cfop ?? '6102'}</CFOP>
      <uCom>${it.unit ?? 'UN'}</uCom><qCom>${it.quantity}</qCom><vUnCom>${it.unitPrice}</vUnCom><vProd>${prod.toFixed(2)}</vProd>${it.discount ? `<vDesc>${it.discount}</vDesc>` : ''}
      ${it.lot ? `<rastro><nLote>${it.lot.number}</nLote><qLote>${it.quantity}</qLote><dFab>2026-01-01</dFab><dVal>${it.lot.expiresAt}</dVal></rastro>` : ''}</prod>
      <imposto><ICMS>${icmsGroup}</ICMS>${it.ipi ? `<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vIPI>${it.ipi}</vIPI></IPITrib></IPI>` : ''}
      <PIS><PISAliq><CST>${it.pisCst ?? '01'}</CST><vPIS>${it.pis ?? '0.00'}</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>${it.pisCst ?? '01'}</CST><vCOFINS>${it.cofins ?? '0.00'}</vCOFINS></COFINSAliq></COFINS>
      ${it.ibs || it.cbs ? `<IBSCBS><CST>000</CST><gIBSCBS><vIBS>${it.ibs ?? '0.00'}</vIBS><gCBS><vCBS>${it.cbs ?? '0.00'}</vCBS></gCBS></gIBSCBS></IBSCBS>` : ''}</imposto></det>`;
  }).join('');
  const vNF = tot.prod.minus(tot.desc).plus(tot.ipi).plus(tot.st);
  const dups = o.dups ?? [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">
    <ide><cUF>35</cUF><nNF>${number}</nNF><serie>1</serie><mod>55</mod><dhEmi>${issued}</dhEmi></ide>
    <emit><CNPJ>${o.supplierCnpj}</CNPJ><xNome>Fornecedor Têxtil LTDA</xNome><IE>110042490114</IE><enderEmit><xLgr>Rua das Fábricas</xLgr><nro>500</nro><xBairro>Brás</xBairro><cMun>3550308</cMun><xMun>São Paulo</xMun><UF>${o.supplierUf ?? 'SP'}</UF><CEP>03001000</CEP></enderEmit><CRT>${o.crt ?? '3'}</CRT></emit>
    <dest><CNPJ>${o.recipientCnpj}</CNPJ><xNome>Loja</xNome></dest>${det}
    <total><ICMSTot><vProd>${tot.prod.toFixed(2)}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>${tot.desc.toFixed(2)}</vDesc><vOutro>0.00</vOutro><vIPI>${tot.ipi.toFixed(2)}</vIPI>
      <vST>${tot.st.toFixed(2)}</vST><vICMS>${tot.icms.toFixed(2)}</vICMS><vPIS>${tot.pis.toFixed(2)}</vPIS><vCOFINS>${tot.cofins.toFixed(2)}</vCOFINS><vNF>${vNF.toFixed(2)}</vNF></ICMSTot>
      ${tot.ibs.isZero() && tot.cbs.isZero() ? '' : `<IBSCBSTot><gIBS><vIBS>${tot.ibs.toFixed(2)}</vIBS></gIBS><gCBS><vCBS>${tot.cbs.toFixed(2)}</vCBS></gCBS></IBSCBSTot>`}</total>
    ${dups.length ? `<cobr>${dups.map((d, i) => `<dup><nDup>${String(i + 1).padStart(3, '0')}</nDup><dVenc>${d.dueDate}</dVenc><vDup>${d.amount}</vDup></dup>`).join('')}</cobr>` : ''}
    </infNFe></NFe><protNFe><infProt><nProt>135260000${number}</nProt></infProt></protNFe></nfeProc>`;
  return { xml, key, number: String(number), total: vNF.toFixed(2) };
}
