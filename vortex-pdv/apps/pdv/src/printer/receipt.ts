import { D } from '@vortex/money';

/**
 * Layout do comprovante (seção 21): estabelecimento, produtos, quantidades, valores, descontos,
 * total, pagamentos, troco, documento fiscal (DANFE NFC-e com chave e QR Code), data/hora e
 * número da venda. Gera texto em colunas, comum à impressão ESC/POS e à pré-visualização.
 */
export interface ReceiptData {
  store: { legalName: string; tradeName?: string | null; cnpj: string; ie?: string | null; address: string };
  header?: string;
  footer?: string;
  saleNumber: string;
  terminal: string;
  operator: string;
  at: Date;
  customer?: { name: string | null; taxIdMasked: string | null } | null;
  items: { seq: number; code: string; description: string; quantity: string; unit: string; unitPrice: string; gross: string; discount: string; total: string }[];
  subtotal: string;
  discount: string;
  total: string;
  payments: { label: string; amount: string; detail?: string | null }[];
  change: string;
  approximateTaxes?: string | null;
  fiscal?: { status: string; series: number; number: number; accessKey: string; protocol: string | null; authorizedAt: string | null; qrUrl: string; consultUrl: string;
    environment: 1 | 2; contingency: boolean } | null;
  reprint?: boolean;
  cancelled?: boolean;
}

export type ReceiptLine = { text: string; align?: 'left' | 'center' | 'right'; bold?: boolean; double?: boolean } | { qr: string } | { rule: true };

const brl = (v: string) => D(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const qty = (v: string) => D(v).toDecimalPlaces(3).toString().replace('.', ',');
const two = (left: string, right: string, w: number) => {
  const l = left.slice(0, Math.max(0, w - right.length - 1));
  return l + ' '.repeat(Math.max(1, w - l.length - right.length)) + right;
};
const fmtDate = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' }).format(d);
const fmtCnpj = (c: string) => c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : c;
const chunk = (s: string, n: number) => s.match(new RegExp(`.{1,${n}}`, 'g')) ?? [];

export function receiptLines(r: ReceiptData, width: 32 | 42 | 48): ReceiptLine[] {
  const out: ReceiptLine[] = [];
  const t = (text: string, o: Omit<Extract<ReceiptLine, { text: string }>, 'text'> = {}) => out.push({ text, ...o });
  t(r.store.tradeName || r.store.legalName, { align: 'center', bold: true });
  t(r.store.legalName, { align: 'center' });
  t(`CNPJ ${fmtCnpj(r.store.cnpj)}${r.store.ie ? `  IE ${r.store.ie}` : ''}`, { align: 'center' });
  for (const l of chunk(r.store.address, width)) t(l, { align: 'center' });
  if (r.header) t(r.header, { align: 'center' });
  out.push({ rule: true });
  if (r.cancelled) t('*** VENDA CANCELADA ***', { align: 'center', bold: true });
  if (r.reprint) t('*** REIMPRESSÃO ***', { align: 'center', bold: true });
  if (r.fiscal) {
    t('Documento Auxiliar da Nota Fiscal de', { align: 'center', bold: true });
    t('Consumidor Eletrônica', { align: 'center', bold: true });
    if (r.fiscal.environment === 2) t('EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL', { align: 'center', bold: true });
    if (r.fiscal.contingency) t('EMITIDA EM CONTINGÊNCIA', { align: 'center', bold: true });
  } else {
    t('COMPROVANTE DE VENDA - SEM VALOR FISCAL', { align: 'center', bold: true });
  }
  out.push({ rule: true });
  t(two('# CÓD DESCRIÇÃO', 'TOTAL', width), { bold: true });
  for (const i of r.items) {
    t(`${String(i.seq).padStart(3, '0')} ${i.code} ${i.description}`);
    t(two(`    ${qty(i.quantity)} ${i.unit} x ${brl(i.unitPrice)}`, brl(i.gross), width));
    if (D(i.discount).greaterThan(0)) t(two('    desconto', `-${brl(i.discount)}`, width));
  }
  out.push({ rule: true });
  t(two('QTD. TOTAL DE ITENS', String(r.items.length), width));
  t(two('Subtotal R$', brl(r.subtotal), width));
  if (D(r.discount).greaterThan(0)) t(two('Descontos R$', `-${brl(r.discount)}`, width));
  t(two('VALOR A PAGAR R$', brl(r.total), width), { bold: true, double: width >= 42 });
  t(two('FORMA DE PAGAMENTO', 'VALOR PAGO R$', width));
  for (const p of r.payments) {
    t(two(p.label, brl(p.amount), width));
    if (p.detail) t(`  ${p.detail}`);
  }
  if (D(r.change).greaterThan(0)) t(two('Troco R$', brl(r.change), width), { bold: true });
  out.push({ rule: true });
  if (r.fiscal) {
    t(`Consulte pela chave de acesso em ${r.fiscal.consultUrl}`, { align: 'center' });
    for (const l of chunk(r.fiscal.accessKey.replace(/(\d{4})/g, '$1 ').trim(), width)) t(l, { align: 'center' });
    out.push({ rule: true });
    t(r.customer?.taxIdMasked ? `CONSUMIDOR ${r.customer.name ?? ''} - ${r.customer.taxIdMasked}` : 'CONSUMIDOR NÃO IDENTIFICADO', { align: 'center' });
    t(`NFC-e nº ${String(r.fiscal.number).padStart(9, '0')} Série ${String(r.fiscal.series).padStart(3, '0')} ${fmtDate(r.at)}`, { align: 'center', bold: true });
    if (r.fiscal.protocol) t(`Protocolo de autorização: ${r.fiscal.protocol}`, { align: 'center' });
    if (r.fiscal.authorizedAt) t(`Data de autorização: ${fmtDate(new Date(r.fiscal.authorizedAt))}`, { align: 'center' });
    out.push({ qr: r.fiscal.qrUrl });
  } else if (r.customer?.taxIdMasked) {
    t(`Cliente: ${r.customer.name ?? ''} ${r.customer.taxIdMasked}`);
  }
  if (r.approximateTaxes) t(`Tributos aproximados R$ ${brl(r.approximateTaxes)} (Lei 12.741/2012)`, { align: 'center' });
  out.push({ rule: true });
  t(`Venda ${r.saleNumber}`, { align: 'center', bold: true });
  t(`PDV ${r.terminal} - Operador ${r.operator} - ${fmtDate(r.at)}`, { align: 'center' });
  if (r.footer) t(r.footer, { align: 'center' });
  return out;
}

/** Texto puro (pré-visualização na tela e arquivo de spool). */
export function receiptText(lines: ReceiptLine[], width: number): string {
  return lines.map((l) => {
    if ('rule' in l) return '-'.repeat(width);
    if ('qr' in l) return `[QR Code] ${l.qr}`;
    const txt = l.text.length > width ? l.text : l.align === 'center' ? ' '.repeat(Math.floor((width - l.text.length) / 2)) + l.text : l.align === 'right' ? l.text.padStart(width) : l.text;
    return txt;
  }).join('\n');
}
