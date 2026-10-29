import { D, ZERO, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { validation } from '../../errors.js';

/**
 * EFD-Reinf (seção 15, V1): eventos XML do leiaute 2.1.2 a partir do que foi gravado no ERP.
 * R-1000 (contribuinte), R-2010 (INSS retido em serviços tomados), R-2020 (INSS retido em
 * serviços prestados), R-4010/R-4020 (IRRF e CSRF em pagamentos a PF/PJ) e os fechamentos
 * R-2099/R-4099. Os eventos saem sem assinatura: o envio (com o certificado) é feito pelo
 * contador ou pela empresa; a homologação valida cada evento no ambiente de testes da RFB.
 */
const VERSION = 'v2_01_02';
const NS = (schema: string) => `http://www.reinf.esocial.gov.br/schemas/${schema}/${VERSION}`;
const VER_PROC = 'VORTEX-ERP-1.0';
const v = (x: Decimal | string | number) => D(String(x)).toFixed(2).replace('.', ',');
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const el = (tag: string, content: unknown) => (content === null || content === undefined || content === '' ? '' : `<${tag}>${typeof content === 'string' && content.startsWith('<') ? content : esc(content)}</${tag}>`);

export interface ReinfEvent {
  type: 'R-1000' | 'R-2010' | 'R-2020' | 'R-2099' | 'R-4010' | 'R-4020' | 'R-4099';
  id: string;
  xml: string;
  summary: Record<string, unknown>;
}

export interface ReinfOptions {
  companyId: string;
  /** Período de apuração AAAA-MM */
  period: string;
  environment?: 1 | 2;
  /** Inclui o R-1000 (cadastro do contribuinte; enviado uma vez e quando mudar) */
  includeR1000?: boolean;
  now?: Date;
}

/** Id do evento: "ID" + tipo de inscrição + inscrição com 14 posições + AAAAMMDDHHMMSS + sequencial de 5. */
export function reinfEventId(cnpjRoot: string, at: Date, seq: number): string {
  const ts = at.toISOString().replace(/\D/g, '').slice(0, 14);
  return `ID1${cnpjRoot.padEnd(14, '0')}${ts}${String(seq).padStart(5, '0')}`;
}

export async function generateReinf(tx: Tx, o: ReinfOptions): Promise<{ events: ReinfEvent[]; warnings: string[] }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.period)) throw validation({ period: 'Período no formato AAAA-MM' });
  const from = `${o.period}-01`;
  const to = new Date(Date.UTC(Number(o.period.slice(0, 4)), Number(o.period.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const company = await tx.one<{ cnpj_root: string; legal_name: string; settings: any }>(`SELECT cnpj_root, legal_name, settings FROM core.companies WHERE id = $1`, [o.companyId], 'Empresa');
  const root = company.cnpj_root;
  const tpAmb = o.environment ?? 2;
  const now = o.now ?? new Date();
  let seq = 0;
  const events: ReinfEvent[] = [];
  const warnings: string[] = [];
  const ideEvento = (withPeriod: boolean) =>
    `<ideEvento>${withPeriod ? `<indRetif>1</indRetif><perApur>${o.period}</perApur>` : ''}<tpAmb>${tpAmb}</tpAmb><procEmi>1</procEmi><verProc>${VER_PROC}</verProc></ideEvento>`;
  const ideContri = `<ideContri><tpInsc>1</tpInsc><nrInsc>${root}</nrInsc></ideContri>`;
  const push = (type: ReinfEvent['type'], schema: string, tag: string, body: string, summary: Record<string, unknown>) => {
    const id = reinfEventId(root, now, ++seq);
    events.push({ type, id, summary, xml: `<?xml version="1.0" encoding="UTF-8"?><Reinf xmlns="${NS(schema)}"><${tag} id="${id}">${body}</${tag}></Reinf>` });
  };

  // ---------------------------------------------------------------- R-1000
  if (o.includeR1000) {
    const regimes = await tx.query<{ regime: string }>(
      `SELECT DISTINCT r.regime FROM core.establishment_tax_regimes r JOIN core.establishments e ON e.id = r.establishment_id
        WHERE e.company_id = $1 AND r.valid_from <= $2 AND (r.valid_to IS NULL OR r.valid_to >= $2)`, [o.companyId, to]);
    const simples = regimes.some((r) => r.regime === 'simples_nacional' || r.regime === 'mei');
    const contact = company.settings?.reinf?.contact ?? company.settings?.accountant;
    if (!contact?.name || !contact?.cpf) warnings.push('R-1000 sem contato: cadastre nome e CPF do responsável (settings.reinf.contact)');
    push('R-1000', 'evtInfoContribuinte', 'evtInfoContri', ideEvento(false) + ideContri
      + `<infoContri><inclusao><idePeriodo><iniValid>${o.period}</iniValid></idePeriodo><infoCadastro><classTrib>${simples ? '01' : '99'}</classTrib>`
      + `<indEscrituracao>${simples ? 0 : 1}</indEscrituracao><indDesoneracao>0</indDesoneracao><indAcordoIsenMulta>0</indAcordoIsenMulta><indSitPJ>0</indSitPJ>`
      + `<contato>${el('nmCtt', contact?.name)}${el('cpfCtt', contact?.cpf?.replace(/\D/g, ''))}${el('foneFixo', contact?.phone?.replace(/\D/g, ''))}${el('email', contact?.email)}</contato>`
      + `</infoCadastro></inclusao></infoContri>`, { classTrib: simples ? '01' : '99' });
  }

  // ---------------------------------------------------------------- R-2010: INSS retido em serviços tomados (por estabelecimento × prestador)
  const taken = await tx.query<Record<string, any>>(
    `SELECT si.*, e.cnpj AS est_cnpj, p.tax_id AS supplier_tax_id, p.kind AS supplier_kind, p.legal_name AS supplier_name
       FROM purchasing.service_invoices si JOIN core.establishments e ON e.id = si.establishment_id JOIN registry.parties p ON p.id = si.supplier_id
      WHERE si.company_id = $1 AND si.status = 'active' AND si.issue_date BETWEEN $2 AND $3 ORDER BY si.issue_date, si.number`, [o.companyId, from, to]);
  const r2010 = new Map<string, Record<string, any>[]>();
  for (const s of taken.filter((x) => D(x.inss).greaterThan(0))) {
    if (s.supplier_kind !== 'PJ') {
      warnings.push(`NFS-e ${s.number}: INSS retido de pessoa física vai no eSocial (S-1200), não no R-2010`);
      continue;
    }
    const k = `${s.est_cnpj}|${s.supplier_tax_id}`;
    r2010.set(k, [...(r2010.get(k) ?? []), s]);
  }
  for (const [k, list] of r2010) {
    const [estCnpj, prest] = k.split('|');
    const gross = list.reduce<Decimal>((a, s) => a.plus(s.gross_amount), ZERO);
    const baseRet = list.reduce<Decimal>((a, s) => a.plus(D(s.gross_amount).minus(s.inss_deductions)), ZERO);
    const ret = list.reduce<Decimal>((a, s) => a.plus(s.inss), ZERO);
    const nfs = list.map((s) => `<nfs>${el('serie', s.series ?? '0')}<numDocto>${esc(s.number)}</numDocto><dtEmissaoNF>${String(s.issue_date instanceof Date ? s.issue_date.toISOString() : s.issue_date).slice(0, 10)}</dtEmissaoNF>`
      + `<vlrBruto>${v(s.gross_amount)}</vlrBruto>${el('obs', s.description?.slice(0, 250))}<infoTpServ><tpServico>${s.reinf_service_type}</tpServico>`
      + `<vlrBaseRet>${v(D(s.gross_amount).minus(s.inss_deductions))}</vlrBaseRet><vlrRetencao>${v(s.inss)}</vlrRetencao></infoTpServ></nfs>`).join('');
    push('R-2010', 'evtTomadorServicos', 'evtServTom', ideEvento(true) + ideContri
      + `<infoServTom><ideEstabObra><tpInscEstab>1</tpInscEstab><nrInscEstab>${estCnpj}</nrInscEstab><indObra>0</indObra>`
      + `<idePrestServ><cnpjPrestador>${prest}</cnpjPrestador><vlrTotalBruto>${v(gross)}</vlrTotalBruto><vlrTotalBaseRet>${v(baseRet)}</vlrTotalBaseRet>`
      + `<vlrTotalRetPrinc>${v(ret)}</vlrTotalRetPrinc><indCPRB>0</indCPRB>${nfs}</idePrestServ></ideEstabObra></infoServTom>`,
      { establishment: estCnpj, provider: prest, documents: list.length, gross: gross.toFixed(2), retention: ret.toFixed(2) });
  }

  // ---------------------------------------------------------------- R-2020: INSS retido pelos clientes em serviços prestados (NFS-e emitidas)
  const prest = await tx.query<Record<string, any>>(
    `SELECT d.id, d.number, d.series, d.issued_at, d.total_invoice, d.recipient_tax_id, e.cnpj AS est_cnpj,
            (SELECT sum(t.value) FROM fiscal.document_items i JOIN fiscal.document_item_taxes t ON t.document_item_id = i.id WHERE i.document_id = d.id AND t.tax = 'RET_INSS') AS inss
       FROM fiscal.documents d JOIN core.establishments e ON e.id = d.establishment_id
      WHERE d.company_id = $1 AND d.model = '99' AND d.issuer_kind = 'own' AND d.status = 'autorizada' AND d.tax_date BETWEEN $2 AND $3`, [o.companyId, from, to]);
  const r2020 = new Map<string, Record<string, any>[]>();
  for (const d of prest.filter((x) => D(x.inss ?? 0).greaterThan(0))) {
    const k = `${d.est_cnpj}|${d.recipient_tax_id}`;
    r2020.set(k, [...(r2020.get(k) ?? []), d]);
  }
  for (const [k, list] of r2020) {
    const [estCnpj, tom] = k.split('|');
    const gross = list.reduce<Decimal>((a, d) => a.plus(d.total_invoice), ZERO);
    const ret = list.reduce<Decimal>((a, d) => a.plus(d.inss), ZERO);
    const nfs = list.map((d) => `<nfs>${el('serie', d.series ?? '0')}<numDocto>${d.number}</numDocto><dtEmissaoNF>${new Date(d.issued_at).toISOString().slice(0, 10)}</dtEmissaoNF>`
      + `<vlrBruto>${v(d.total_invoice)}</vlrBruto><infoTpServ><tpServico>${company.settings?.reinf?.serviceType ?? '100000001'}</tpServico><vlrBaseRet>${v(d.total_invoice)}</vlrBaseRet>`
      + `<vlrRetencao>${v(d.inss)}</vlrRetencao></infoTpServ></nfs>`).join('');
    push('R-2020', 'evtPrestadorServicos', 'evtServPrest', ideEvento(true) + ideContri
      + `<infoServPrest><ideEstabPrest><tpInscEstabPrest>1</tpInscEstabPrest><nrInscEstabPrest>${estCnpj}</nrInscEstabPrest>`
      + `<ideTomador><tpInscTomador>1</tpInscTomador><nrInscTomador>${tom}</nrInscTomador><indObra>0</indObra><vlrTotalBruto>${v(gross)}</vlrTotalBruto>`
      + `<vlrTotalBaseRet>${v(gross)}</vlrTotalBaseRet><vlrTotalRetPrinc>${v(ret)}</vlrTotalRetPrinc>${nfs}</ideTomador></ideEstabPrest></infoServPrest>`,
      { establishment: estCnpj, customer: tom, documents: list.length, retention: ret.toFixed(2) });
  }

  // ---------------------------------------------------------------- R-4010/R-4020: fato gerador é o pagamento ao prestador
  const paid = await tx.query<Record<string, any>>(
    `SELECT si.*, e.cnpj AS est_cnpj, p.tax_id AS supplier_tax_id, p.kind AS supplier_kind, p.legal_name AS supplier_name, s.settlement_date, s.principal
       FROM purchasing.service_invoices si JOIN core.establishments e ON e.id = si.establishment_id JOIN registry.parties p ON p.id = si.supplier_id
       JOIN finance.titles t ON t.origin_type = 'service_invoice' AND t.origin_id = si.id AND t.party_id = si.supplier_id
       JOIN finance.settlements s ON s.title_id = t.id AND s.kind = 'payment' AND NOT s.reversed
      WHERE si.company_id = $1 AND si.status = 'active' AND s.settlement_date BETWEEN $2 AND $3 AND (si.irrf + si.csll + si.pis + si.cofins) > 0
      ORDER BY s.settlement_date`, [o.companyId, from, to]);
  const r4000 = new Map<string, Record<string, any>[]>();
  for (const s of paid) {
    if (!s.supplier_tax_id) continue;
    const k = `${s.est_cnpj}|${s.supplier_kind}|${s.supplier_tax_id}`;
    r4000.set(k, [...(r4000.get(k) ?? []), s]);
  }
  for (const [k, list] of r4000) {
    const [estCnpj, kind, benef] = k.split('|');
    // Pagamento parcial: retenções proporcionais ao líquido pago
    const pays = list.map((s) => {
      const ratio = D(s.principal).dividedBy(s.net_amount);
      const part = (x: string) => D(x).times(ratio).toDecimalPlaces(2);
      return { s, date: new Date(s.settlement_date).toISOString().slice(0, 10), gross: part(s.gross_amount), irrf: part(s.irrf), agreg: part(D(s.csll).plus(s.pis).plus(s.cofins).toFixed(2)) };
    });
    if (kind === 'PJ') {
      const byNat = new Map<string, typeof pays>();
      for (const p of pays) byNat.set(p.s.income_nature ?? '17001', [...(byNat.get(p.s.income_nature ?? '17001') ?? []), p]);
      const idePgto = [...byNat].map(([nat, ps]) => `<idePgto><natRend>${nat}</natRend>${ps.map((p) => `<infoPgto><dtFG>${p.date}</dtFG><vlrBruto>${v(p.gross)}</vlrBruto>`
        + `<retencoes>${p.irrf.greaterThan(0) ? `<vlrBaseIR>${v(p.gross)}</vlrBaseIR><vlrIR>${v(p.irrf)}</vlrIR>` : ''}`
        + `${p.agreg.greaterThan(0) ? `<vlrBaseAgreg>${v(p.gross)}</vlrBaseAgreg><vlrAgreg>${v(p.agreg)}</vlrAgreg>` : ''}</retencoes></infoPgto>`).join('')}</idePgto>`).join('');
      push('R-4020', 'evt4020PagtoBeneficiarioPJ', 'evtRetPJ', ideEvento(true) + ideContri
        + `<ideEstab><tpInscEstab>1</tpInscEstab><nrInscEstab>${estCnpj}</nrInscEstab><ideBenef><cnpjBenef>${benef}</cnpjBenef>${idePgto}</ideBenef></ideEstab>`,
        { establishment: estCnpj, beneficiary: benef, payments: pays.length, irrf: pays.reduce<Decimal>((a, p) => a.plus(p.irrf), ZERO).toFixed(2),
          aggregated: pays.reduce<Decimal>((a, p) => a.plus(p.agreg), ZERO).toFixed(2) });
    } else {
      const idePgto = pays.map((p) => `<idePgto><natRend>${p.s.income_nature ?? '10001'}</natRend><infoPgto><dtFG>${p.date}</dtFG><vlrRendBruto>${v(p.gross)}</vlrRendBruto>`
        + `<vlrRendTrib>${v(p.gross)}</vlrRendTrib><vlrIR>${v(p.irrf)}</vlrIR></infoPgto></idePgto>`).join('');
      push('R-4010', 'evt4010PagtoBeneficiarioPF', 'evtRetPF', ideEvento(true) + ideContri
        + `<ideEstab><tpInscEstab>1</tpInscEstab><nrInscEstab>${estCnpj}</nrInscEstab><ideBenef><cpfBenef>${benef}</cpfBenef>${idePgto}</ideBenef></ideEstab>`,
        { establishment: estCnpj, beneficiary: benef, payments: pays.length, irrf: pays.reduce<Decimal>((a, p) => a.plus(p.irrf), ZERO).toFixed(2) });
    }
  }
  const unpaid = taken.filter((s) => D(s.irrf).plus(s.csll).plus(s.pis).plus(s.cofins).greaterThan(0) && !paid.some((p) => p.id === s.id));
  if (unpaid.length) warnings.push(`${unpaid.length} NFS-e com IRRF/CSRF ainda não pagas: entram na série R-4000 do mês do pagamento`);

  // ---------------------------------------------------------------- fechamentos
  const has = (t: string) => events.some((e) => e.type === t);
  push('R-2099', 'evtFechamento', 'evtFechaEvPer', ideEvento(false).replace('<ideEvento>', `<ideEvento><perApur>${o.period}</perApur>`) + ideContri
    + `<infoFech><evtServTm>${has('R-2010') ? 'S' : 'N'}</evtServTm><evtServPr>${has('R-2020') ? 'S' : 'N'}</evtServPr><evtAssDespRec>N</evtAssDespRec>`
    + `<evtAssDespRep>N</evtAssDespRep><evtComProd>N</evtComProd><evtCPRB>N</evtCPRB><evtAquis>N</evtAquis></infoFech>`, { period: o.period });
  push('R-4099', 'evt4099FechamentoDirf', 'evtFech', ideEvento(false).replace('<ideEvento>', `<ideEvento><perApur>${o.period}</perApur>`) + ideContri
    + `<infoFech><fechRet>0</fechRet></infoFech>`, { period: o.period });
  return { events, warnings };
}
