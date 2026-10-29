import type { Tx } from '../../db/tx.js';
import { emit } from '../../core/outbox.js';

interface Finding {
  key: string;
  kind: 'desconto_fora_do_padrao' | 'conta_bancaria_fornecedor' | 'nota_entrada_inesperada' | 'quebra_de_caixa';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  details: Record<string, unknown>;
}

/**
 * Detecção de anomalias (seção 20, V2): desconto fora do padrão, mudança de conta bancária de
 * fornecedor com pagamento a caminho, nota de entrada inesperada e quebra de caixa recorrente.
 * Cada achado é gravado uma vez (chave única) e publicado como ia.anomalia.
 */
export async function detectAnomalies(tx: Tx) {
  const findings: Finding[] = [];

  // 1. Desconto acima de média + 3 desvios (mín. 10 p.p.) do histórico de 90 dias da empresa
  const disc = await tx.query<{ item_id: string; order_id: string; number: string; discount_percent: string; mean: string; sd: string; salesperson: string | null; company_id: string }>(
    `WITH base AS (
       SELECT o.company_id, avg(i.discount_percent) AS mean, coalesce(stddev_samp(i.discount_percent), 0) AS sd
         FROM sales.order_items i JOIN sales.orders o ON o.id = i.order_id
        WHERE o.created_at >= now() - interval '90 days' AND o.status <> 'cancelled' GROUP BY 1 HAVING count(*) >= 10)
     SELECT i.id AS item_id, o.id AS order_id, o.number::text AS number, i.discount_percent, b.mean, b.sd, sp.legal_name AS salesperson, o.company_id
       FROM sales.order_items i JOIN sales.orders o ON o.id = i.order_id JOIN base b ON b.company_id = o.company_id
       LEFT JOIN registry.parties sp ON sp.id = o.salesperson_id
      WHERE o.created_at >= now() - interval '3 days' AND o.status <> 'cancelled' AND i.discount_percent > 0
        AND i.discount_percent > greatest(b.mean + 3 * b.sd, b.mean + 10)`);
  for (const d of disc) {
    findings.push({ key: `desconto:${d.item_id}`, kind: 'desconto_fora_do_padrao', severity: 'warning',
      message: `Pedido ${d.number}: desconto de ${Number(d.discount_percent).toFixed(2)}% (média da empresa ${Number(d.mean).toFixed(2)}%)${d.salesperson ? ` — vendedor ${d.salesperson}` : ''}`,
      details: { orderId: d.order_id, itemId: d.item_id, discountPercent: d.discount_percent, mean: Number(d.mean).toFixed(4), stddev: Number(d.sd).toFixed(4) } });
  }

  // 2. Troca de conta bancária de fornecedor (evento da solicitação) nos últimos 7 dias, com pagamento em aberto
  const banks = await tx.query<{ id: string; party_id: string; legal_name: string; holder_differs: boolean; titles: number; amount: string }>(
    `SELECT ba.id, ba.party_id, p.legal_name, bool_or((e.payload->>'holderDiffers')::boolean) AS holder_differs, count(DISTINCT t.id)::int AS titles,
            (SELECT sum(balance) FROM finance.titles x WHERE x.party_id = ba.party_id AND x.kind = 'payable' AND x.status IN ('open','partially_paid')) AS amount
       FROM integration.outbox_events e
       JOIN registry.party_bank_accounts ba ON ba.id = (e.payload->>'bankAccountId')::uuid
       JOIN registry.parties p ON p.id = ba.party_id
       JOIN finance.titles t ON t.party_id = ba.party_id AND t.kind = 'payable' AND t.status IN ('open','partially_paid')
      WHERE e.event_type = 'fornecedor.conta_bancaria_alterada' AND e.occurred_at >= now() - interval '7 days'
        AND EXISTS (SELECT 1 FROM registry.party_bank_accounts old WHERE old.party_id = ba.party_id AND old.id <> ba.id AND old.created_at < ba.created_at)
      GROUP BY 1, 2, 3`);
  for (const b of banks) {
    findings.push({ key: `conta_bancaria:${b.id}`, kind: 'conta_bancaria_fornecedor', severity: 'critical',
      message: `Conta bancária de ${b.legal_name} alterada recentemente${b.holder_differs ? ' (titular diferente do fornecedor)' : ''} com ${b.titles} pagamento(s) em aberto `
        + `(R$ ${Number(b.amount).toFixed(2).replace('.', ',')}). Confirme com o fornecedor por um telefone já conhecido antes de pagar.`,
      details: { partyId: b.party_id, bankAccountId: b.id, holderDiffers: b.holder_differs, titles: b.titles, amount: b.amount } });
  }

  // 3. Nota de entrada de emitente sem pedido aberto e sem compras nos últimos 180 dias
  const notes = await tx.query<{ id: string; access_key: string; issuer_name: string; issuer_tax_id: string; total: string | null; unexpected: boolean }>(
    `SELECT d.id, d.access_key, d.issuer_name, d.issuer_tax_id, d.total, d.unexpected FROM fiscal.inbound_documents d
      WHERE d.created_at >= now() - interval '7 days' AND d.sefaz_situation = 'autorizada' AND d.receipt_id IS NULL
        AND (d.unexpected OR NOT EXISTS (
          SELECT 1 FROM registry.parties p WHERE p.tax_id = d.issuer_tax_id AND (
            EXISTS (SELECT 1 FROM purchasing.orders o WHERE o.supplier_id = p.id AND o.status IN ('approved','partially_received'))
            OR EXISTS (SELECT 1 FROM purchasing.receipts r WHERE r.supplier_id = p.id AND r.created_at >= now() - interval '180 days'))))`);
  for (const n of notes) {
    findings.push({ key: `nota_inesperada:${n.id}`, kind: 'nota_entrada_inesperada', severity: 'warning',
      message: `Nota de ${n.issuer_name}${n.total ? ` (R$ ${Number(n.total).toFixed(2).replace('.', ',')})` : ''} emitida contra a empresa sem pedido de compra aberto. Se não reconhecer, manifeste "desconhecimento".`,
      details: { inboundDocumentId: n.id, accessKey: n.access_key, issuerTaxId: n.issuer_tax_id } });
  }

  // 4. Quebra de caixa recorrente: 3+ fechamentos com falta no mesmo PDV em 30 dias
  const cash = await tx.query<{ establishment_id: string; pdv_id: string; n: number; total: string; last_id: string }>(
    `SELECT establishment_id, pdv_id, count(*)::int AS n, sum(difference) AS total, (array_agg(id ORDER BY occurred_at DESC))[1] AS last_id
       FROM integration.pdv_cash_movements WHERE kind = 'closing' AND difference < 0 AND occurred_at >= now() - interval '30 days'
      GROUP BY 1, 2 HAVING count(*) >= 3`);
  for (const c of cash) {
    findings.push({ key: `quebra_caixa:${c.last_id}`, kind: 'quebra_de_caixa', severity: 'warning',
      message: `PDV ${c.pdv_id}: ${c.n} fechamentos com falta em 30 dias, total R$ ${Math.abs(Number(c.total)).toFixed(2).replace('.', ',')}`,
      details: { establishmentId: c.establishment_id, pdvId: c.pdv_id, closings: c.n, total: c.total } });
  }

  const created = [];
  for (const f of findings) {
    const row = await tx.maybeOne<{ id: string }>(
      `INSERT INTO ai.anomalies (tenant_id, key, kind, severity, message, details) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, key) DO NOTHING RETURNING id`,
      [tx.tenantId, f.key, f.kind, f.severity, f.message, JSON.stringify(f.details)]);
    if (!row) continue;
    await emit(tx, 'ia.anomalia', { type: 'anomaly', id: row.id }, { id: row.id, tipo: f.kind, severidade: f.severity, mensagem: f.message });
    created.push({ id: row.id, ...f });
  }
  return created;
}
