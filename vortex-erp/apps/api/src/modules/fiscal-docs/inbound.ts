import { XMLParser } from 'fast-xml-parser';
import { D } from '@vortex/money';
import { cleanDoc, isValidAccessKey } from '@vortex/validators';
import type { Pool } from '../../db/pool.js';
import { withTenant, type RequestContext, type Tx } from '../../db/tx.js';
import { AppError, conflict, validation } from '../../errors.js';
import { emit } from '../../core/outbox.js';
import type { Services } from '../../services.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, isArray: (name) => ['det', 'dup', 'detPag', 'vol', 'NFref'].includes(name) });

export interface ParsedNfe {
  accessKey: string;
  number: string;
  series: string;
  model: string;
  issuedAt: string;
  issuer: { taxId: string; name: string; ie: string | null; uf: string; crt: string | null;
    address: { street: string; number: string; district: string; cityIbge: string; cityName: string; uf: string; zip: string } | null };
  recipient: { taxId: string | null; name: string | null };
  items: {
    number: number; code: string; ean: string | null; orderRef: string | null; description: string; ncm: string | null; cest: string | null; cfop: string; unit: string; quantity: string; unitPrice: string;
    total: string; discount: string; freight: string; insurance: string; other: string;
    icms: { cst: string | null; base: string; rate: string; value: string; snCredit: string }; st: { base: string; value: string }; ipi: { value: string };
    pis: { cst: string | null; value: string }; cofins: { cst: string | null; value: string }; ibs: string; cbs: string;
    lot: { number: string; manufacturedAt: string | null; expiresAt: string | null; quantity: string } | null;
  }[];
  totals: { products: string; freight: string; insurance: string; discount: string; other: string; ipi: string; st: string; icms: string; pis: string; cofins: string; ibs: string; cbs: string; invoice: string };
  installments: { number: string; dueDate: string; amount: string }[];
  protocol: string | null;
}

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const n = (v: unknown) => (v === undefined || v === null || v === '' ? '0' : String(v));

function firstGroup(obj: Record<string, any> | undefined): Record<string, any> {
  if (!obj) return {};
  const k = Object.keys(obj)[0];
  return k ? obj[k] : {};
}

/** Lê o XML de uma NF-e (NFe ou nfeProc) recebida do fornecedor. */
export function parseNfeXml(xml: string): ParsedNfe {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch {
    throw validation({ xml: 'XML inválido' });
  }
  const nfe = doc.nfeProc?.NFe ?? doc.NFe;
  const inf = nfe?.infNFe;
  if (!inf) throw validation({ xml: 'Arquivo não é uma NF-e' });
  const key = s(inf['@Id']).replace(/^NFe/, '');
  if (!isValidAccessKey(key)) throw validation({ xml: 'Chave de acesso inválida no XML' });
  const ide = inf.ide;
  const emit = inf.emit;
  const total = inf.total?.ICMSTot ?? {};
  const ibsTot = inf.total?.IBSCBSTot;
  return {
    accessKey: key,
    number: s(ide.nNF),
    series: s(ide.serie),
    model: s(ide.mod),
    issuedAt: s(ide.dhEmi),
    issuer: { taxId: cleanDoc(s(emit.CNPJ ?? emit.CPF)), name: s(emit.xNome), ie: emit.IE ? s(emit.IE) : null, uf: s(emit.enderEmit?.UF), crt: emit.CRT ? s(emit.CRT) : null,
      address: emit.enderEmit?.xLgr ? { street: s(emit.enderEmit.xLgr), number: s(emit.enderEmit.nro) || 'S/N', district: s(emit.enderEmit.xBairro) || 'Centro',
        cityIbge: s(emit.enderEmit.cMun), cityName: s(emit.enderEmit.xMun), uf: s(emit.enderEmit.UF), zip: s(emit.enderEmit.CEP) } : null },
    recipient: { taxId: inf.dest ? cleanDoc(s(inf.dest.CNPJ ?? inf.dest.CPF)) : null, name: inf.dest ? s(inf.dest.xNome) : null },
    items: (inf.det ?? []).map((d: Record<string, any>) => {
      const p = d.prod;
      const imp = d.imposto ?? {};
      const icms = firstGroup(imp.ICMS);
      const ipi = imp.IPI?.IPITrib ?? {};
      const pis = firstGroup(imp.PIS);
      const cof = firstGroup(imp.COFINS);
      const ibscbs = imp.IBSCBS?.gIBSCBS;
      const rastro = Array.isArray(p.rastro) ? p.rastro[0] : p.rastro;
      return {
        number: Number(d['@nItem']), code: s(p.cProd), orderRef: p.xPed ? s(p.xPed) : null, ean: p.cEAN && p.cEAN !== 'SEM GTIN' ? s(p.cEAN) : null, description: s(p.xProd), ncm: p.NCM ? s(p.NCM) : null,
        cest: p.CEST ? s(p.CEST) : null, cfop: s(p.CFOP), unit: s(p.uCom), quantity: n(p.qCom), unitPrice: n(p.vUnCom), total: n(p.vProd), discount: n(p.vDesc),
        freight: n(p.vFrete), insurance: n(p.vSeg), other: n(p.vOutro),
        icms: { cst: s(icms.CST ?? icms.CSOSN) || null, base: n(icms.vBC), rate: n(icms.pICMS), value: n(icms.vICMS), snCredit: n(icms.vCredICMSSN) },
        st: { base: n(icms.vBCST), value: n(icms.vICMSST) }, ipi: { value: n(ipi.vIPI) },
        pis: { cst: s(pis.CST) || null, value: n(pis.vPIS) }, cofins: { cst: s(cof.CST) || null, value: n(cof.vCOFINS) },
        ibs: n(ibscbs?.vIBS), cbs: n(ibscbs?.gCBS?.vCBS),
        lot: rastro ? { number: s(rastro.nLote), manufacturedAt: rastro.dFab ? s(rastro.dFab) : null, expiresAt: rastro.dVal ? s(rastro.dVal) : null, quantity: n(rastro.qLote) } : null,
      };
    }),
    totals: {
      products: n(total.vProd), freight: n(total.vFrete), insurance: n(total.vSeg), discount: n(total.vDesc), other: n(total.vOutro), ipi: n(total.vIPI), st: n(total.vST),
      icms: n(total.vICMS), pis: n(total.vPIS), cofins: n(total.vCOFINS), ibs: n(ibsTot?.gIBS?.vIBS), cbs: n(ibsTot?.gCBS?.vCBS), invoice: n(total.vNF),
    },
    installments: (inf.cobr?.dup ?? []).map((d: Record<string, any>) => ({ number: s(d.nDup), dueDate: s(d.dVenc), amount: n(d.vDup) })),
    protocol: doc.nfeProc?.protNFe?.infProt?.nProt ? s(doc.nfeProc.protNFe.infProt.nProt) : null,
  };
}

/**
 * Job de distribuição de DF-e (seção 09): consulta por CNPJ de cada estabelecimento,
 * respeitando o limite da SEFAZ (sem documentos novos → próxima consulta em 1 hora).
 */
export async function runDistribution(tx: Tx, services: Services, establishmentId: string) {
  const est = await tx.one<{ id: string; cnpj: string; uf: string; company_id: string; sefaz_environment: 1 | 2 }>(
    `SELECT id, cnpj, uf, company_id, sefaz_environment FROM core.establishments WHERE id = $1`, [establishmentId]);
  await tx.exec(`INSERT INTO fiscal.dfe_cursors (tenant_id, establishment_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tx.tenantId, establishmentId]);
  const cur = await tx.one<{ last_nsu: string; next_query_at: Date }>(`SELECT last_nsu, next_query_at FROM fiscal.dfe_cursors WHERE establishment_id = $1 FOR UPDATE`, [establishmentId]);
  if (new Date(cur.next_query_at).getTime() > Date.now()) return { skipped: true, nextQueryAt: cur.next_query_at };
  let lastNsu = Number(cur.last_nsu);
  let imported = 0;
  for (let page = 0; page < 20; page++) {
    const r = await services.fiscalGateway.distribution({ cnpj: est.cnpj, uf: est.uf, lastNsu, environment: est.sefaz_environment });
    for (const d of r.docs) {
      const supplier = await tx.maybeOne<{ id: string }>(`SELECT id FROM registry.parties WHERE tax_id = $1 AND status <> 'inactive'`, [cleanDoc(d.issuerCnpj)]);
      // Nota inesperada: fornecedor desconhecido ou sem pedido de compra em aberto (ajuda a detectar fraude)
      const hasOrder = supplier ? await tx.maybeOne(`SELECT 1 FROM purchasing.orders WHERE supplier_id = $1 AND status IN ('approved','partially_received') LIMIT 1`, [supplier.id]) : null;
      const ins = await tx.maybeOne<{ id: string }>(
        `INSERT INTO fiscal.inbound_documents (tenant_id, company_id, establishment_id, nsu, access_key, issuer_tax_id, issuer_name, issuer_ie, issued_at, total, sefaz_situation, unexpected, supplier_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id, access_key) DO UPDATE SET sefaz_situation = EXCLUDED.sefaz_situation, nsu = EXCLUDED.nsu RETURNING id`,
        [tx.tenantId, est.company_id, est.id, d.nsu, d.accessKey, cleanDoc(d.issuerCnpj), d.issuerName, d.issuerIe ?? null, d.issuedAt, d.total, d.situation, !supplier || !hasOrder, supplier?.id ?? null]);
      if (ins) {
        imported++;
        await emit(tx, 'nota.entrada.recebida', { type: 'inbound_document', id: ins.id }, { id: ins.id, chave: d.accessKey, emitente: d.issuerName, valor: d.total, inesperada: !supplier || !hasOrder });
      }
    }
    lastNsu = r.lastNsu;
    if (r.code === '137' || lastNsu >= r.maxNsu || !r.docs.length) {
      await tx.exec(`UPDATE fiscal.dfe_cursors SET last_nsu = $2, max_nsu = $3, last_query_at = now(), next_query_at = now() + interval '1 hour' WHERE establishment_id = $1`,
        [establishmentId, lastNsu, r.maxNsu]);
      return { imported, lastNsu };
    }
  }
  await tx.exec(`UPDATE fiscal.dfe_cursors SET last_nsu = $2, last_query_at = now(), next_query_at = now() WHERE establishment_id = $1`, [establishmentId, lastNsu]);
  return { imported, lastNsu };
}

/**
 * Manifestação do destinatário: ciência, confirmação, desconhecimento ou operação não
 * realizada. A ciência libera o download do XML completo.
 */
export async function manifest(pool: Pool, ctx: RequestContext, services: Services, inboundId: string, kind: 'ciencia' | 'confirmada' | 'desconhecida' | 'nao_realizada', reason?: string) {
  const d = await withTenant(pool, ctx, async (tx) => {
    const row = await tx.one<Record<string, any>>(`SELECT i.*, e.cnpj, e.sefaz_environment FROM fiscal.inbound_documents i JOIN core.establishments e ON e.id = i.establishment_id WHERE i.id = $1`, [inboundId], 'Nota de entrada');
    if (kind === 'nao_realizada' && (!reason || reason.length < 15)) throw validation({ reason: 'Justificativa obrigatória (mínimo 15 caracteres)' });
    if (row.manifestation === 'confirmada' || row.manifestation === 'desconhecida' || row.manifestation === 'nao_realizada') throw conflict('ALREADY_MANIFESTED', 'Nota já tem manifestação conclusiva');
    return row;
  });
  const r = await services.fiscalGateway.manifest({ cnpj: d.cnpj, accessKey: d.access_key, kind, reason, environment: d.sefaz_environment });
  return withTenant(pool, ctx, async (tx) => {
    if (r.status !== 'registered') throw new AppError('SEFAZ_REJECTED', `SEFAZ recusou a manifestação: ${r.message}`, 422, { sefazCode: r.code });
    let xmlKey: string | null = d.xml_key;
    if (r.xml) {
      xmlKey = (await services.storage.putImmutable(`nfe-entrada/${d.tenant_id}/${d.access_key}.xml`, r.xml, 'application/xml')).key;
    }
    return tx.one(`UPDATE fiscal.inbound_documents SET manifestation = $2, manifested_at = now(), manifestation_reason = $3, xml_key = $4, content = CASE WHEN $4::text IS NULL THEN content ELSE 'full' END
                    WHERE id = $1 RETURNING *`, [inboundId, kind, reason ?? null, xmlKey]);
  });
}

export function sumParsed(items: ParsedNfe['items'], k: 'total' | 'discount'): string {
  return items.reduce((a, i) => a.plus(i[k]), D(0)).toFixed(2);
}
