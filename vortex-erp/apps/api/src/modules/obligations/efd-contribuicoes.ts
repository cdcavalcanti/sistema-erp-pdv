import { D, ZERO, roundMoney, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { ruleViolation, validation } from '../../errors.js';
import { ITEM_TYPE, closeSped, dt, f, num } from '../accounting/efd.js';

/**
 * EFD-Contribuições (seção 15, V1): apuração de PIS e Cofins por documento (leiaute 006).
 * Lucro Presumido → regime cumulativo (0,65% e 3%); Lucro Real → não cumulativo (1,65% e 7,6%)
 * com crédito sobre as aquisições para revenda e insumos. Blocos 0, A (NFS-e), C (NF-e e NFC-e),
 * M (apuração) e 9; D, F, I, P e 1 vão sem movimento. O arquivo segue para o PVA oficial.
 */
export interface EfdContribOptions {
  companyId: string;
  /** Período de apuração AAAA-MM */
  period: string;
}

const RATES = { cumulative: { pis: '0.65', cofins: '3.00' }, noncumulative: { pis: '1.65', cofins: '7.60' } };
const TAXED = new Set(['01', '02']);
/** CFOP de entrada → natureza da base de crédito (tabela 4.3.7): 01 revenda, 02 insumo; demais sem crédito */
function creditNature(cfop: string): string | null {
  const c = cfop.slice(1);
  if (['102', '403', '117', '118', '121'].includes(c)) return '01';
  if (['101', '401', '122', '124', '125'].includes(c)) return '02';
  return null;
}

export async function generateEfdContribuicoes(tx: Tx, o: EfdContribOptions): Promise<{ content: string; warnings: string[]; counts: Record<string, number>; totals: Record<string, string> }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.period)) throw validation({ period: 'Período no formato AAAA-MM' });
  const from = `${o.period}-01`;
  const to = new Date(Date.UTC(Number(o.period.slice(0, 4)), Number(o.period.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const warnings: string[] = [];
  const lines: string[] = [];
  const add = (...fields: unknown[]) => lines.push(`|${fields.map(f).join('|')}|`);

  const company = await tx.one<{ legal_name: string; settings: any }>(`SELECT legal_name, settings FROM core.companies WHERE id = $1`, [o.companyId], 'Empresa');
  const ests = await tx.query<Record<string, any>>(
    `SELECT e.*, (SELECT regime FROM core.establishment_tax_regimes r WHERE r.establishment_id = e.id AND r.valid_from <= $2 AND (r.valid_to IS NULL OR r.valid_to >= $2)) AS regime
       FROM core.establishments e WHERE e.company_id = $1 AND e.status = 'active' ORDER BY (right(e.cnpj, 6) LIKE '0001%') DESC, e.code`, [o.companyId, to]);
  if (!ests.length) throw validation({ companyId: 'Empresa sem estabelecimentos' });
  const regimes = new Set(ests.map((e) => e.regime));
  if ([...regimes].some((r) => r === 'simples_nacional' || r === 'mei')) {
    throw ruleViolation('RN-FIS', 'Optante do Simples Nacional não entrega EFD-Contribuições: use o apoio ao PGDAS-D');
  }
  const nonCumulative = regimes.has('lucro_real');
  const rate = nonCumulative ? RATES.noncumulative : RATES.cumulative;
  const head = ests[0]!;

  const docs = await tx.query<Record<string, any>>(
    `SELECT d.*, p.code AS party_code FROM fiscal.documents d LEFT JOIN registry.parties p ON p.id = d.party_id
      WHERE d.company_id = $1 AND d.tax_date BETWEEN $2 AND $3 AND d.model IN ('55','65','99')
        AND d.status IN ('autorizada','cancelada','denegada','inutilizada') AND (d.issuer_kind = 'own' OR $4)
      ORDER BY d.establishment_id, d.model, d.direction, d.series, d.number`, [o.companyId, from, to, nonCumulative]);
  const items = docs.length ? await tx.query<Record<string, any>>(
    `SELECT i.*, p.kind AS product_kind FROM fiscal.document_items i LEFT JOIN catalog.products p ON p.id = i.product_id WHERE i.document_id = ANY($1) ORDER BY i.item_number`,
    [docs.map((d) => d.id)]) : [];
  const taxes = items.length ? await tx.query<Record<string, any>>(`SELECT * FROM fiscal.document_item_taxes WHERE document_item_id = ANY($1)`, [items.map((i) => i.id)]) : [];
  const tax = (itemId: string, t: string) => taxes.find((x) => x.document_item_id === itemId && x.tax === t);

  // Apuração acumulada
  const ap = {
    revenue: ZERO,
    taxedBase: { pis: ZERO, cofins: ZERO },
    nonTaxed: new Map<string, Decimal>(),
    credit: new Map<string, { base: Decimal }>(),
    retained: { pis: ZERO, cofins: ZERO },
  };
  // Linha por item conforme o regime: saída tributada (CST 01) ou não (04/06/07/08/09); entrada com ou sem crédito
  const itemTax = (d: Record<string, any>, i: Record<string, any>) => {
    const pis = tax(i.id, 'PIS');
    const cof = tax(i.id, 'COFINS');
    const value = D(i.total).minus(i.discount);
    if (d.direction === 'S') {
      const cst = pis?.cst && pis.cst !== '' ? pis.cst : '01';
      const taxed = TAXED.has(cst);
      ap.revenue = ap.revenue.plus(value);
      if (taxed) {
        ap.taxedBase.pis = ap.taxedBase.pis.plus(pis?.base ?? value);
        ap.taxedBase.cofins = ap.taxedBase.cofins.plus(cof?.base ?? value);
      } else {
        ap.nonTaxed.set(cst, (ap.nonTaxed.get(cst) ?? ZERO).plus(value));
      }
      const base = taxed ? D(pis?.base ?? value) : ZERO;
      return { cstPis: cst, cstCof: cof?.cst ?? cst, base, basCof: taxed ? D(cof?.base ?? value) : ZERO, aliqPis: taxed ? rate.pis : '0', aliqCof: taxed ? rate.cofins : '0',
        vPis: taxed ? roundMoney(base.times(rate.pis).dividedBy(100)) : ZERO, vCof: taxed ? roundMoney(D(cof?.base ?? value).times(rate.cofins).dividedBy(100)) : ZERO, nat: null as string | null };
    }
    // Entrada (só no não cumulativo): CST 50 com crédito sobre o valor sem o ICMS destacado (Lei 14.592/2023)
    const nat = creditNature(i.cfop);
    if (!nat) return { cstPis: '70', cstCof: '70', base: ZERO, basCof: ZERO, aliqPis: '0', aliqCof: '0', vPis: ZERO, vCof: ZERO, nat: null };
    const base = value.minus(tax(i.id, 'ICMS')?.value ?? 0);
    const cur = ap.credit.get(nat) ?? { base: ZERO };
    cur.base = cur.base.plus(base);
    ap.credit.set(nat, cur);
    return { cstPis: '50', cstCof: '50', base, basCof: base, aliqPis: rate.pis, aliqCof: rate.cofins, vPis: roundMoney(base.times(rate.pis).dividedBy(100)),
      vCof: roundMoney(base.times(rate.cofins).dividedBy(100)), nat };
  };

  // ---------------------------------------------------------------- bloco 0
  add('0000', '006', '0', '', '', dt(from), dt(to), company.legal_name, head.cnpj, head.uf, head.city_ibge, head.suframa ?? '', '00', company.settings?.fiscal?.activityIndicator ?? '2');
  add('0001', '0');
  const acc = company.settings?.accountant;
  if (acc?.name && acc?.cpf && acc?.crc) add('0100', acc.name, acc.cpf, acc.crc, acc.cnpj ?? '', acc.zip ?? '', acc.street ?? '', acc.number ?? '', '', acc.district ?? '', acc.phone ?? '', '', acc.email ?? '', acc.cityIbge ?? '');
  else warnings.push('Registro 0100 (contabilista) não gerado: cadastre os dados do contador nas configurações da empresa');
  add('0110', nonCumulative ? '1' : '2', nonCumulative ? '1' : '', '1', nonCumulative ? '' : '9');
  for (const e of ests) {
    add('0140', e.code, e.legal_name, e.cnpj, e.uf, e.ie, e.city_ibge, e.im, e.suframa ?? '');
    const eDocs = docs.filter((d) => d.establishment_id === e.id && d.status === 'autorizada');
    const partyIds = [...new Set(eDocs.filter((d) => d.party_id).map((d) => d.party_id))];
    const parties = partyIds.length ? await tx.query<Record<string, any>>(
      `SELECT p.*, a.city_ibge, a.street, a.number, a.complement, a.district, a.country_code FROM registry.parties p
         LEFT JOIN LATERAL (SELECT * FROM registry.party_addresses x WHERE x.party_id = p.id ORDER BY (x.kind = 'fiscal') DESC LIMIT 1) a ON true WHERE p.id = ANY($1) ORDER BY p.code`, [partyIds]) : [];
    for (const p of parties) {
      add('0150', p.code, p.legal_name, p.country_code ?? '1058', p.kind === 'PJ' ? p.tax_id : '', p.kind === 'PF' ? p.tax_id : '', p.ie && p.ie !== 'ISENTO' ? p.ie : '', p.city_ibge, p.suframa,
        p.street, p.number, p.complement, p.district);
    }
    const eItems = items.filter((i) => eDocs.some((d) => d.id === i.document_id));
    for (const u of [...new Set(eItems.map((i) => i.unit))].sort()) add('0190', u, (await tx.maybeOne<{ description: string }>(`SELECT description FROM fiscal.units WHERE code = $1`, [u]))?.description ?? u);
    for (const i of [...new Map(eItems.filter((x) => x.product_id).map((x) => [x.product_id, x])).values()]) {
      add('0200', i.sku, i.description, i.gtin, '', i.unit, ITEM_TYPE[i.product_kind] ?? '00', i.ncm, '', i.ncm?.slice(0, 2), i.service_code, '');
    }
  }
  add('0990', lines.length + 1);

  // ---------------------------------------------------------------- bloco A (serviços: NFS-e)
  const aStart = lines.length;
  const services = docs.filter((d) => d.model === '99');
  add('A001', services.length ? '0' : '1');
  for (const e of ests) {
    const eDocs = services.filter((d) => d.establishment_id === e.id);
    if (!eDocs.length) continue;
    add('A010', e.cnpj);
    for (const d of eDocs) {
      if (d.status !== 'autorizada') {
        add('A100', d.direction === 'S' ? '1' : '0', d.issuer_kind === 'own' ? '0' : '1', '', '02', d.series, '', d.number, d.nfse_key ?? '', dt(d.tax_date), '', '', '', '', '', '', '', '', '', '', '');
        continue;
      }
      const dItems = items.filter((i) => i.document_id === d.id);
      const rows = dItems.map((i) => ({ i, t: itemTax(d, i) }));
      const sumOf = (k: 'base' | 'basCof' | 'vPis' | 'vCof') => rows.reduce<Decimal>((a, r) => a.plus(r.t[k]), ZERO);
      const ret = (t: string) => dItems.reduce<Decimal>((a, i) => a.plus(tax(i.id, t)?.value ?? 0), ZERO);
      ap.retained.pis = ap.retained.pis.plus(ret('RET_PIS'));
      ap.retained.cofins = ap.retained.cofins.plus(ret('RET_COFINS'));
      add('A100', '1', '0', d.party_code, '00', d.series, '', d.number, d.nfse_key ?? '', dt(d.issued_at ?? d.tax_date), dt(d.tax_date), num(d.total_invoice), '1', num(0),
        num(sumOf('base')), num(sumOf('vPis')), num(sumOf('basCof')), num(sumOf('vCof')), num(ret('RET_PIS')), num(ret('RET_COFINS')), num(dItems.reduce<Decimal>((a, i) => a.plus(tax(i.id, 'ISS')?.value ?? 0), ZERO)));
      for (const { i, t } of rows) {
        add('A170', i.item_number, i.sku, i.description, num(i.total), num(i.discount), '', '', t.cstPis, num(t.base), num(t.aliqPis, 4), num(t.vPis), t.cstCof, num(t.basCof), num(t.aliqCof, 4),
          num(t.vCof), '', '');
      }
    }
  }
  add('A990', lines.length - aStart + 1);

  // ---------------------------------------------------------------- bloco C (NF-e e NFC-e)
  const cStart = lines.length;
  const goods = docs.filter((d) => d.model === '55' || d.model === '65');
  add('C001', goods.length ? '0' : '1');
  for (const e of ests) {
    const eDocs = goods.filter((d) => d.establishment_id === e.id);
    if (!eDocs.length) continue;
    add('C010', e.cnpj, '2');
    for (const d of eDocs) {
      const indOper = d.direction === 'S' ? '1' : '0';
      const indEmit = d.issuer_kind === 'own' ? '0' : '1';
      if (d.status !== 'autorizada') {
        add('C100', indOper, indEmit, '', d.model, { cancelada: '02', denegada: '04', inutilizada: '05' }[d.status as 'cancelada'] ?? '02', d.series, d.number, d.access_key);
        continue;
      }
      const dItems = items.filter((i) => i.document_id === d.id);
      const rows = dItems.map((i) => ({ i, t: itemTax(d, i) }));
      const tt = d.totals ?? {};
      add('C100', indOper, indEmit, d.party_code, d.model, d.emission_type !== 1 ? '08' : '00', d.series, d.number, d.access_key, dt(d.issued_at ?? d.tax_date), dt(d.exit_at ?? d.tax_date),
        num(d.total_invoice), (d.installments ?? []).length ? '1' : '0', num(tt.discount), num(0), num(tt.product), d.freight_mode, num(tt.freight), num(tt.insurance), num(tt.otherExpenses),
        num(tt.icmsBase), num(tt.icms), num(tt.stBase), num(tt.st), num(tt.ipi), num(rows.reduce<Decimal>((a, r) => a.plus(r.t.vPis), ZERO)), num(rows.reduce<Decimal>((a, r) => a.plus(r.t.vCof), ZERO)), num(0), num(0));
      if (d.model === '65') {
        // NFC-e: registro analítico por CFOP e CST (C175)
        const g = new Map<string, { cfop: string; cst: string; opr: Decimal; desc: Decimal; base: Decimal; vPis: Decimal; basCof: Decimal; vCof: Decimal; aPis: string; aCof: string }>();
        for (const { i, t } of rows) {
          const k = `${i.cfop}|${t.cstPis}`;
          const cur = g.get(k) ?? { cfop: i.cfop, cst: t.cstPis, opr: ZERO, desc: ZERO, base: ZERO, vPis: ZERO, basCof: ZERO, vCof: ZERO, aPis: t.aliqPis, aCof: t.aliqCof };
          cur.opr = cur.opr.plus(i.total);
          cur.desc = cur.desc.plus(i.discount);
          cur.base = cur.base.plus(t.base);
          cur.vPis = cur.vPis.plus(t.vPis);
          cur.basCof = cur.basCof.plus(t.basCof);
          cur.vCof = cur.vCof.plus(t.vCof);
          g.set(k, cur);
        }
        for (const x of g.values()) add('C175', x.cfop, num(x.opr), num(x.desc), x.cst, num(x.base), num(x.aPis, 4), '', '', num(x.vPis), x.cst, num(x.basCof), num(x.aCof, 4), '', '', num(x.vCof), '', '');
        continue;
      }
      for (const { i, t } of rows) {
        const ic = tax(i.id, 'ICMS');
        const st = tax(i.id, 'ICMS_ST');
        const ipi = tax(i.id, 'IPI');
        add('C170', i.item_number, i.sku, i.description, num(i.quantity, 5), i.unit, num(i.total), num(i.discount), '0', `${i.origin}${ic?.cst ?? '90'}`, i.cfop, '', num(ic?.base), num(ic?.rate),
          num(ic?.value), num(st?.base), num(st?.rate), num(st?.value), '0', ipi?.cst ?? '', ipi?.details?.enqCode ?? '', num(ipi?.base), num(ipi?.rate), num(ipi?.value),
          t.cstPis, num(t.base), num(t.aliqPis, 4), '', '', num(t.vPis), t.cstCof, num(t.basCof), num(t.aliqCof, 4), '', '', num(t.vCof), '');
      }
    }
  }
  add('C990', lines.length - cStart + 1);
  for (const b of ['D', 'F', 'I']) {
    add(`${b}001`, '1');
    add(`${b}990`, 2);
  }

  // ---------------------------------------------------------------- bloco M (apuração)
  const mStart = lines.length;
  add('M001', '0');
  const credit = { pis: ZERO, cofins: ZERO };
  const mCredit = (tax: 'pis' | 'cofins') => {
    if (!nonCumulative || !ap.credit.size) return;
    const base = [...ap.credit.values()].reduce<Decimal>((a, c) => a.plus(c.base), ZERO);
    const value = roundMoney(base.times(rate[tax]).dividedBy(100));
    credit[tax] = value;
    add(tax === 'pis' ? 'M100' : 'M500', '101', '0', num(base), num(rate[tax], 4), '', '', num(value), num(0), num(0), num(0), num(value), '0', num(value), num(0));
    for (const [nat, c] of ap.credit) add(tax === 'pis' ? 'M105' : 'M505', nat, '50', num(c.base), '', num(c.base), num(c.base), '', '', '');
  };
  const mContribution = (tax: 'pis' | 'cofins') => {
    const base = ap.taxedBase[tax];
    const apur = roundMoney(base.times(rate[tax]).dividedBy(100));
    const usedCredit = credit[tax].greaterThan(apur) ? apur : credit[tax];
    const retained = ap.retained[tax].greaterThan(apur.minus(usedCredit)) ? apur.minus(usedCredit) : ap.retained[tax];
    const toPay = apur.minus(usedCredit).minus(retained);
    if (nonCumulative) {
      add(tax === 'pis' ? 'M200' : 'M600', num(apur), num(usedCredit), num(0), num(apur.minus(usedCredit)), num(retained), num(0), num(toPay), num(0), num(0), num(0), num(0), num(toPay));
    } else {
      add(tax === 'pis' ? 'M200' : 'M600', num(0), num(0), num(0), num(0), num(0), num(0), num(0), num(apur), num(retained), num(0), num(toPay), num(toPay));
    }
    if (base.greaterThan(0)) {
      add(tax === 'pis' ? 'M210' : 'M610', nonCumulative ? '01' : '51', num(ap.revenue), num(base), num(0), num(0), num(base), num(rate[tax], 4), '', '', num(apur), num(0), num(0), num(0), num(0), num(apur));
    }
    return { base, apur, credit: usedCredit, retained, toPay };
  };
  mCredit('pis');
  const pis = mContribution('pis');
  for (const [cst, v] of ap.nonTaxed) {
    add('M400', cst, num(v), '', '');
    add('M410', company.settings?.fiscal?.natRec?.[cst] ?? '999', num(v), '', '');
  }
  mCredit('cofins');
  const cofins = mContribution('cofins');
  for (const [cst, v] of ap.nonTaxed) {
    add('M800', cst, num(v), '', '');
    add('M810', company.settings?.fiscal?.natRec?.[cst] ?? '999', num(v), '', '');
  }
  if (ap.nonTaxed.size && !company.settings?.fiscal?.natRec) warnings.push('M410/M810 com natureza de receita 999: revise as tabelas 4.3.10 a 4.3.16 com o contador');
  add('M990', lines.length - mStart + 1);
  add('P001', '1');
  add('P990', 2);
  add('1001', '1');
  add('1990', 2);
  const counts = closeSped(lines, add);
  return {
    content: `${lines.join('\r\n')}\r\n`, warnings, counts,
    totals: {
      regime: nonCumulative ? 'nao_cumulativo' : 'cumulativo', revenue: ap.revenue.toFixed(2), pisBase: pis.base.toFixed(2), pis: pis.apur.toFixed(2), pisCredit: pis.credit.toFixed(2),
      pisRetained: pis.retained.toFixed(2), pisToPay: pis.toPay.toFixed(2), cofinsBase: cofins.base.toFixed(2), cofins: cofins.apur.toFixed(2), cofinsCredit: cofins.credit.toFixed(2),
      cofinsRetained: cofins.retained.toFixed(2), cofinsToPay: cofins.toPay.toFixed(2),
    },
  };
}
