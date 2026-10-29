import { formatBRL } from '@vortex/money';
import { formatCNPJ, formatCPF } from '@vortex/validators';

/**
 * DANFE simplificado em HTML (o XML é a nota; o DANFE é só uma representação).
 * Usado no envio ao destinatário e no link permanente do portal do cliente.
 */
const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const doc = (v: string | null) => (!v ? '' : v.length === 11 ? formatCPF(v) : formatCNPJ(v));

export function renderDanfeHtml(d: Record<string, any>, items: Record<string, any>[]): string {
  const key = String(d.access_key ?? '').replace(/(.{4})/g, '$1 ').trim();
  const homolog = d.environment === 2;
  const rows = items.map((i) => `<tr><td>${esc(i.sku)}</td><td>${esc(i.description)}</td><td>${esc(i.ncm ?? '')}</td><td>${esc(i.cfop)}</td><td>${esc(i.unit)}</td>
    <td class="n">${Number(i.quantity).toLocaleString('pt-BR', { maximumFractionDigits: 4 })}</td><td class="n">${formatBRL(i.unit_price)}</td><td class="n">${formatBRL(i.total)}</td></tr>`).join('');
  const t = d.totals ?? {};
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>DANFE ${esc(d.number)}</title>
<style>body{font:12px/1.4 Arial,sans-serif;margin:24px;color:#111}h1{font-size:16px;margin:0}table{width:100%;border-collapse:collapse;margin-top:8px}
td,th{border:1px solid #999;padding:4px;vertical-align:top}th{background:#eee;text-align:left}.n{text-align:right}.k{font-family:monospace;font-size:13px;letter-spacing:1px}
.warn{background:#fee;border:1px solid #c00;padding:8px;margin:8px 0;font-weight:bold}</style></head><body>
${homolog ? '<div class="warn">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL</div>' : ''}
${d.status === 'cancelada' ? '<div class="warn">NOTA FISCAL CANCELADA</div>' : ''}
<table><tr><td><h1>${esc(d.issuer_name)}</h1>CNPJ ${doc(d.issuer_tax_id)} · IE ${esc(d.issuer_ie ?? '')} · ${esc(d.issuer_uf)}</td>
<td><b>DANFE</b><br>${d.direction === 'S' ? '1 - Saída' : '0 - Entrada'}<br>Nº ${esc(d.number)} · Série ${esc(d.series)}</td></tr>
<tr><td colspan="2">Chave de acesso<br><span class="k">${esc(key)}</span><br>Protocolo de autorização: ${esc(d.protocol ?? '—')} ${d.authorized_at ? new Date(d.authorized_at).toLocaleString('pt-BR') : ''}</td></tr>
<tr><td colspan="2">Natureza da operação: ${esc(d.operation_nature)}</td></tr></table>
<table><tr><th colspan="3">Destinatário</th></tr><tr><td>${esc(d.recipient_name ?? 'Consumidor não identificado')}</td><td>${doc(d.recipient_tax_id)}</td><td>${esc(d.recipient_uf ?? '')}</td></tr></table>
<table><tr><th>Código</th><th>Descrição</th><th>NCM</th><th>CFOP</th><th>Un</th><th>Qtd</th><th>Valor unit.</th><th>Valor</th></tr>${rows}</table>
<table><tr><th>Base ICMS</th><th>ICMS</th><th>Base ST</th><th>ICMS ST</th><th>IPI</th><th>Frete</th><th>Desconto</th><th>Total da nota</th></tr>
<tr><td class="n">${formatBRL(t.icmsBase ?? 0)}</td><td class="n">${formatBRL(t.icms ?? 0)}</td><td class="n">${formatBRL(t.stBase ?? 0)}</td><td class="n">${formatBRL(t.st ?? 0)}</td>
<td class="n">${formatBRL(t.ipi ?? 0)}</td><td class="n">${formatBRL(t.freight ?? 0)}</td><td class="n">${formatBRL(t.discount ?? 0)}</td><td class="n"><b>${formatBRL(d.total_invoice)}</b></td></tr>
<tr><th>IBS</th><th>CBS</th><th>IS</th><th colspan="5">Tributos da reforma (LC 214/2025)</th></tr>
<tr><td class="n">${formatBRL(t.ibs ?? 0)}</td><td class="n">${formatBRL(t.cbs ?? 0)}</td><td class="n">${formatBRL(t.is ?? 0)}</td><td colspan="5">${t.invoiceWithNewTaxes && t.invoiceWithNewTaxes !== t.invoice ? `Total com IBS/CBS/IS: ${formatBRL(t.invoiceWithNewTaxes)}` : 'Valores informativos em 2026 (fora do total da nota)'}</td></tr></table>
${d.additional_info ? `<table><tr><th>Informações complementares</th></tr><tr><td>${esc(d.additional_info)}</td></tr></table>` : ''}
</body></html>`;
}
