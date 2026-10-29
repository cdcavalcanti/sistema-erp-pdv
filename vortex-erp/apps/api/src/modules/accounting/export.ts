import { D } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import type { Services } from '../../services.js';
import { tarGz } from '../../core/tar.js';
import { generateEfdIcmsIpi } from './efd.js';

const csv = (rows: unknown[][]) => rows.map((r) => r.map((c) => {
  const s = c === null || c === undefined ? '' : String(c);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(';')).join('\r\n');
const br = (v: unknown) => (v === null || v === undefined ? '' : D(String(v)).toFixed(2).replace('.', ','));

/**
 * Exportação ao contador (MVP — seção 14): XMLs autorizados e de entrada, livros de
 * entrada e saída, lançamentos em layout de importação e EFD ICMS/IPI (blocos C e H).
 */
export async function buildAccountantPackage(tx: Tx, services: Services, input: { companyId: string; from: string; to: string; inventoryDate?: string | null }) {
  const files: { name: string; content: Buffer | string }[] = [];
  const warnings: string[] = [];
  const docs = await tx.query<Record<string, any>>(
    `SELECT * FROM fiscal.documents WHERE company_id = $1 AND tax_date BETWEEN $2 AND $3 AND status IN ('autorizada','cancelada','denegada','inutilizada') ORDER BY tax_date, model, number`,
    [input.companyId, input.from, input.to]);
  for (const d of docs) {
    if (d.authorized_xml_key) files.push({ name: `xml/${d.direction === 'S' ? 'saidas' : 'entradas-proprias'}/${d.access_key}.xml`, content: await services.storage.get(d.authorized_xml_key) });
  }
  const inbound = await tx.query<Record<string, any>>(`SELECT * FROM fiscal.inbound_documents WHERE company_id = $1 AND issued_at::date BETWEEN $2 AND $3 AND xml_key IS NOT NULL`, [input.companyId, input.from, input.to]);
  for (const i of inbound) files.push({ name: `xml/entradas/${i.access_key}.xml`, content: await services.storage.get(i.xml_key) });
  const cfops = await tx.query<{ document_id: string; cfops: string }>(`SELECT document_id, string_agg(DISTINCT cfop, ',') AS cfops FROM fiscal.document_items WHERE document_id = ANY($1) GROUP BY document_id`, [docs.map((d) => d.id)]);
  const cfopOf = new Map(cfops.map((c) => [c.document_id, c.cfops]));
  const book = (dir: 'S' | 'E') => csv([
    ['data', 'modelo', 'serie', 'numero', 'chave', 'situacao', 'participante', 'cnpj_cpf', 'uf', 'cfops', 'valor_contabil', 'base_icms', 'icms', 'icms_st', 'ipi', 'pis', 'cofins', 'ibs', 'cbs'],
    ...docs.filter((d) => d.direction === dir).map((d) => [d.tax_date, d.model, d.series, d.number, d.access_key, d.status, d.recipient_name, d.recipient_tax_id, d.recipient_uf,
      cfopOf.get(d.id) ?? '', br(d.total_invoice), br(d.totals?.icmsBase), br(d.total_icms), br(d.total_st), br(d.total_ipi), br(d.total_pis), br(d.total_cofins), br(d.total_ibs), br(d.total_cbs)]),
  ]);
  files.push({ name: 'livros/registro-saidas.csv', content: book('S') });
  files.push({ name: 'livros/registro-entradas.csv', content: book('E') });
  // Lançamentos: layout de lote (uma linha por partida) aceito pelos sistemas contábeis mais usados
  const lines = await tx.query<Record<string, any>>(
    `SELECT e.entry_date, e.number, a.code, a.referential_code, l.debit, l.credit, l.history, cc.code AS cost_center
       FROM accounting.journal_entries e JOIN accounting.journal_lines l ON l.entry_id = e.id JOIN accounting.chart_of_accounts a ON a.id = l.account_id
       LEFT JOIN finance.cost_centers cc ON cc.id = l.cost_center_id
      WHERE e.company_id = $1 AND e.entry_date BETWEEN $2 AND $3 ORDER BY e.entry_date, e.number`, [input.companyId, input.from, input.to]);
  files.push({ name: 'contabil/lancamentos.csv', content: csv([['data', 'lote', 'conta', 'conta_referencial', 'natureza', 'valor', 'historico', 'centro_custo'],
    ...lines.map((l) => [l.entry_date, l.number, l.code, l.referential_code, D(l.debit).greaterThan(0) ? 'D' : 'C', br(D(l.debit).greaterThan(0) ? l.debit : l.credit), l.history, l.cost_center])]) });
  const plan = await tx.query(`SELECT code, name, nature, balance_side, is_analytic, referential_code FROM accounting.chart_of_accounts ORDER BY code`);
  files.push({ name: 'contabil/plano-de-contas.csv', content: csv([['codigo', 'nome', 'natureza', 'saldo', 'analitica', 'referencial'], ...plan.map((p) => [p.code, p.name, p.nature, p.balance_side, p.is_analytic ? 'S' : 'N', p.referential_code])]) });
  const ests = await tx.query<{ id: string; cnpj: string; regime: string | null }>(
    `SELECT e.id, e.cnpj, (SELECT regime FROM core.establishment_tax_regimes r WHERE r.establishment_id = e.id AND r.valid_from <= $2 AND (r.valid_to IS NULL OR r.valid_to >= $2)) AS regime
       FROM core.establishments e WHERE e.company_id = $1`, [input.companyId, input.to]);
  for (const e of ests) {
    if (['simples_nacional', 'mei'].includes(e.regime ?? '')) {
      warnings.push(`Estabelecimento ${e.cnpj} no Simples Nacional: EFD ICMS/IPI não gerada (dispensada na maioria das UFs)`);
      continue;
    }
    const efd = await generateEfdIcmsIpi(tx, { companyId: input.companyId, establishmentId: e.id, from: input.from, to: input.to, inventoryDate: input.inventoryDate });
    files.push({ name: `sped/efd-icms-ipi-${e.cnpj}-${input.from.slice(0, 7)}.txt`, content: Buffer.from(efd.content, 'latin1') });
    warnings.push(...efd.warnings.map((w) => `${e.cnpj}: ${w}`));
  }
  const manifest = { company: input.companyId, from: input.from, to: input.to, generatedAt: new Date().toISOString(), documents: docs.length, inboundXmls: inbound.length, journalLines: lines.length, warnings,
    notice: 'Arquivos SPED devem ser validados no PVA oficial antes do envio.' };
  files.push({ name: 'LEIAME.json', content: JSON.stringify(manifest, null, 2) });
  const buf = tarGz(files);
  const stored = await services.storage.putImmutable(`exportacoes/${tx.tenantId}/${input.companyId}/contador-${input.from}-${input.to}-${Date.now()}.tar.gz`, buf, 'application/gzip');
  return { key: stored.key, sha256: stored.sha256, files: files.map((f) => f.name), warnings };
}
