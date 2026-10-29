import { D } from '@vortex/money';
import type { RequestContext, Tx } from '../../db/tx.js';
import { pgdasSupport } from '../obligations/simples.js';

/**
 * Apuração de impostos do período (controle fiscal): débitos das saídas (notas autorizadas) ×
 * créditos das entradas (livro de créditos), saldo a recolher ou credor por tributo, ICMS por
 * CFOP e por UF de destino, ST/DIFAL/FCP e a evolução dos últimos meses. É conferência
 * gerencial; a apuração oficial sai na EFD (contador).
 */
const DEBIT_TAXES = ['ICMS', 'ICMS_ST', 'FCP', 'FCP_ST', 'DIFAL', 'FCP_DEST', 'IPI', 'PIS', 'COFINS', 'ISS', 'IBS_UF', 'IBS_MUN', 'CBS'];
const LABEL: Record<string, string> = {
  ICMS: 'ICMS próprio', ICMS_ST: 'ICMS-ST (retido)', FCP: 'FCP', FCP_ST: 'FCP-ST', DIFAL: 'DIFAL (UF de destino)', FCP_DEST: 'FCP destino', IPI: 'IPI', PIS: 'PIS', COFINS: 'Cofins', ISS: 'ISS',
  IBS: 'IBS', CBS: 'CBS',
};

export async function taxAssessment(tx: Tx, ctx: RequestContext, f: { from: string; to: string; establishmentId: string | null }) {
  const docWhere = `d.direction = 'S' AND d.status IN ('autorizada', 'contingencia') AND d.issuer_kind = 'own' AND ($1::uuid IS NULL OR d.company_id = $1)
    AND ($4::uuid IS NULL OR d.establishment_id = $4) AND d.tax_date BETWEEN $2 AND $3`;
  const args = [ctx.companyId, f.from, f.to, f.establishmentId];
  const debits = await tx.query<{ tax: string; base: string; value: string; docs: number }>(
    `SELECT t.tax, sum(t.base) AS base, sum(t.value) AS value, count(DISTINCT d.id)::int AS docs
       FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id JOIN fiscal.document_item_taxes t ON t.document_item_id = i.id
      WHERE ${docWhere} AND t.tax = ANY($5) GROUP BY t.tax`, [...args, DEBIT_TAXES]);
  const credits = await tx.query<{ tax: string; amount: string }>(
    `SELECT c.tax, sum(CASE WHEN c.status = 'reversed' THEN -c.amount WHEN c.status IN ('appropriated', 'used') THEN c.amount ELSE 0 END) AS amount
       FROM fiscal.tax_credits c WHERE ($1::uuid IS NULL OR c.company_id = $1) AND ($4::uuid IS NULL OR c.establishment_id = $4) AND c.competence BETWEEN $2 AND $3
      GROUP BY c.tax`, args);
  const conditional = await tx.query<{ tax: string; amount: string }>(
    `SELECT c.tax, sum(c.amount) AS amount FROM fiscal.tax_credits c
      WHERE c.status = 'conditional' AND ($1::uuid IS NULL OR c.company_id = $1) AND ($4::uuid IS NULL OR c.establishment_id = $4) AND c.competence BETWEEN $2 AND $3
      GROUP BY c.tax`, args);
  // IBS soma UF + município para o confronto com o crédito de IBS
  const debitOf = (tax: string) => tax === 'IBS'
    ? debits.filter((d) => d.tax === 'IBS_UF' || d.tax === 'IBS_MUN').reduce((s, d) => s.plus(d.value), D(0))
    : D(debits.find((d) => d.tax === tax)?.value ?? 0);
  const creditOf = (tax: string) => D(credits.find((c) => c.tax === tax)?.amount ?? 0);
  const summary = ['ICMS', 'IPI', 'PIS', 'COFINS', 'ISS', 'IBS', 'CBS'].map((tax) => {
    const debit = debitOf(tax);
    const credit = creditOf(tax);
    const balance = debit.minus(credit);
    return { tax, label: LABEL[tax] ?? tax, debit: debit.toFixed(2), credit: credit.toFixed(2), conditional: D(conditional.find((c) => c.tax === tax)?.amount ?? 0).toFixed(2),
      toPay: balance.greaterThan(0) ? balance.toFixed(2) : '0.00', creditCarried: balance.lessThan(0) ? balance.abs().toFixed(2) : '0.00' };
  }).filter((r) => D(r.debit).greaterThan(0) || D(r.credit).greaterThan(0));
  // ST, DIFAL e FCP: recolhidos à parte (guia própria por UF)
  const special = ['ICMS_ST', 'FCP', 'FCP_ST', 'DIFAL', 'FCP_DEST'].map((tax) => ({ tax, label: LABEL[tax]!, value: D(debits.find((d) => d.tax === tax)?.value ?? 0).toFixed(2) }))
    .filter((r) => D(r.value).greaterThan(0));
  // Um tributo por linha em document_item_taxes: agrega por item antes de somar o valor do item
  const itemTaxes = `LEFT JOIN LATERAL (SELECT coalesce(sum(t.base) FILTER (WHERE t.tax = 'ICMS'), 0) AS icms_base, coalesce(sum(t.value) FILTER (WHERE t.tax = 'ICMS'), 0) AS icms,
            coalesce(sum(t.value) FILTER (WHERE t.tax = 'ICMS_ST'), 0) AS icms_st, coalesce(sum(t.value) FILTER (WHERE t.tax IN ('DIFAL', 'FCP_DEST')), 0) AS difal
       FROM fiscal.document_item_taxes t WHERE t.document_item_id = i.id) t ON true`;
  const byCfop = await tx.query(
    `SELECT i.cfop, count(DISTINCT d.id)::int AS docs, sum(i.total - i.discount) AS amount,
            sum(t.icms_base) AS icms_base, sum(t.icms) AS icms, sum(t.icms_st) AS icms_st
       FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id ${itemTaxes}
      WHERE ${docWhere} GROUP BY i.cfop ORDER BY amount DESC`, args);
  const byUf = await tx.query(
    `SELECT coalesce(d.recipient_uf, d.issuer_uf) AS uf, count(DISTINCT d.id)::int AS docs, sum(i.total - i.discount) AS amount,
            sum(t.icms) AS icms, sum(t.difal) AS difal
       FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id ${itemTaxes}
      WHERE ${docWhere} GROUP BY 1 ORDER BY amount DESC`, args);
  const monthly = await tx.query<{ month: string; icms_debit: string; icms_credit: string; pis_cofins_debit: string }>(
    `SELECT to_char(m.month, 'YYYY-MM') AS month,
            coalesce((SELECT sum(t.value) FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id JOIN fiscal.document_item_taxes t ON t.document_item_id = i.id
                       WHERE d.direction = 'S' AND d.status IN ('autorizada', 'contingencia') AND d.issuer_kind = 'own' AND ($1::uuid IS NULL OR d.company_id = $1)
                         AND ($3::uuid IS NULL OR d.establishment_id = $3) AND t.tax = 'ICMS' AND date_trunc('month', d.tax_date) = m.month), 0) AS icms_debit,
            coalesce((SELECT sum(CASE WHEN c.status = 'reversed' THEN -c.amount WHEN c.status IN ('appropriated', 'used') THEN c.amount ELSE 0 END) FROM fiscal.tax_credits c
                       WHERE c.tax = 'ICMS' AND ($1::uuid IS NULL OR c.company_id = $1) AND ($3::uuid IS NULL OR c.establishment_id = $3) AND date_trunc('month', c.competence) = m.month), 0) AS icms_credit,
            coalesce((SELECT sum(t.value) FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id JOIN fiscal.document_item_taxes t ON t.document_item_id = i.id
                       WHERE d.direction = 'S' AND d.status IN ('autorizada', 'contingencia') AND d.issuer_kind = 'own' AND ($1::uuid IS NULL OR d.company_id = $1)
                         AND ($3::uuid IS NULL OR d.establishment_id = $3) AND t.tax IN ('PIS', 'COFINS') AND date_trunc('month', d.tax_date) = m.month), 0) AS pis_cofins_debit
       FROM generate_series(date_trunc('month', $2::date) - interval '5 months', date_trunc('month', $2::date), interval '1 month') m(month) ORDER BY m.month`,
    [ctx.companyId, f.to, f.establishmentId]);
  const regime = await tx.maybeOne<{ regime: string }>(
    `SELECT r.regime FROM core.establishment_tax_regimes r JOIN core.establishments e ON e.id = r.establishment_id
      WHERE ($1::uuid IS NULL OR e.company_id = $1) AND ($2::uuid IS NULL OR e.id = $2) AND r.valid_from <= $3 AND (r.valid_to IS NULL OR r.valid_to >= $3)
      ORDER BY r.valid_from DESC LIMIT 1`,
    [ctx.companyId, f.establishmentId, f.to]);
  // Simples Nacional: ICMS, PIS, Cofins e demais vão no DAS; mostra a estimativa do período (mês de `to`)
  const simples = regime && ['simples_nacional', 'simples_excesso_sublimite', 'mei'].includes(regime.regime) && ctx.companyId
    ? await pgdasSupport(tx, ctx.companyId, f.to.slice(0, 7)) : null;
  const totals = summary.reduce((s, r) => ({ debit: s.debit.plus(r.debit), credit: s.credit.plus(r.credit), toPay: s.toPay.plus(r.toPay) }), { debit: D(0), credit: D(0), toPay: D(0) });
  return {
    period: { from: f.from, to: f.to }, regime: regime?.regime ?? null, simples, summary, special, byCfop, byUf, monthly,
    totals: { debit: totals.debit.toFixed(2), credit: totals.credit.toFixed(2), toPay: totals.toPay.plus(special.reduce((s, r) => s.plus(r.value), D(0))).toFixed(2) },
  };
}
