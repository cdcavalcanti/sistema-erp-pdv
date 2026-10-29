import { D, ZERO, roundMoney, sum, type Decimal } from '@vortex/money';
import type { Tx } from '../../db/tx.js';
import { AppError } from '../../errors.js';

export interface TemplateLine {
  side: 'D' | 'C';
  /** Código do plano ("1.1.2.01") ou "@chave|códigoPadrão" resolvido pelo contexto do evento */
  account: string;
  /** Soma de chaves de valor; prefixo "-" subtrai */
  amount: string[];
  history?: string;
}

/**
 * Regras padrão de contabilização por evento (RN-CTB-02). Cada tenant recebe uma
 * cópia editável; podem ser especializadas por tipo de operação, filial e categoria.
 */
export const DEFAULT_POSTING_RULES: Record<string, TemplateLine[]> = {
  venda_faturada: [
    { side: 'D', account: '@receivable_ledger|1.1.2.01', amount: ['receivable_total'], history: 'Venda NF {number}' },
    { side: 'D', account: '1.1.2.01', amount: ['invoice_total', '-receivable_total'], history: 'Venda NF {number} (sem financeiro)' },
    { side: 'C', account: '3.1', amount: ['invoice_total', '-st', '-fcp_st', '-ipi'], history: 'Receita de venda NF {number}' },
    { side: 'C', account: '2.1.2.07', amount: ['st', 'fcp_st'], history: 'ICMS-ST retido NF {number}' },
    { side: 'C', account: '2.1.2.06', amount: ['ipi'], history: 'IPI NF {number}' },
    { side: 'D', account: '3.3.2', amount: ['icms', 'fcp', 'difal', 'fcp_dest', 'pis', 'cofins', 'iss'], history: 'Tributos sobre a venda NF {number}' },
    { side: 'C', account: '2.1.2.01', amount: ['icms', 'fcp', 'difal', 'fcp_dest'], history: 'ICMS a recolher NF {number}' },
    { side: 'C', account: '2.1.2.02', amount: ['pis', 'cofins'], history: 'PIS/Cofins a recolher NF {number}' },
    { side: 'C', account: '2.1.2.05', amount: ['iss'], history: 'ISS a recolher NF {number}' },
    { side: 'D', account: '4.1', amount: ['cmv'], history: 'CMV NF {number}' },
    { side: 'C', account: '1.1.3.01', amount: ['cmv'], history: 'Baixa de estoque NF {number}' },
  ],
  devolucao_venda: [
    { side: 'D', account: '3.3.1', amount: ['invoice_total', '-st', '-fcp_st', '-ipi'], history: 'Devolução de venda NF {number}' },
    { side: 'D', account: '2.1.2.07', amount: ['st', 'fcp_st'], history: 'Estorno ICMS-ST NF {number}' },
    { side: 'D', account: '2.1.2.06', amount: ['ipi'], history: 'Estorno IPI NF {number}' },
    { side: 'C', account: '1.1.2.01', amount: ['invoice_total'], history: 'Devolução de venda NF {number}' },
    { side: 'D', account: '2.1.2.01', amount: ['icms', 'fcp', 'difal', 'fcp_dest'], history: 'Estorno ICMS NF {number}' },
    { side: 'D', account: '2.1.2.02', amount: ['pis', 'cofins'], history: 'Estorno PIS/Cofins NF {number}' },
    { side: 'C', account: '3.3.2', amount: ['icms', 'fcp', 'difal', 'fcp_dest', 'pis', 'cofins'], history: 'Estorno de tributos NF {number}' },
    { side: 'D', account: '1.1.3.01', amount: ['cmv'], history: 'Retorno ao estoque NF {number}' },
    { side: 'C', account: '4.1', amount: ['cmv'], history: 'Estorno de CMV NF {number}' },
  ],
  cartao_venda: [
    { side: 'D', account: '1.1.2.02', amount: ['net'], history: 'Recebível de cartão {number}' },
    { side: 'D', account: '4.2.2', amount: ['fee'], history: 'Taxa de cartão {number}' },
    { side: 'C', account: '1.1.2.01', amount: ['gross'], history: 'Venda no cartão {number}' },
  ],
  recebimento: [
    { side: 'D', account: '@settlement_ledger|1.1.1.02', amount: ['total'], history: 'Recebimento {number}' },
    { side: 'D', account: '4.4.2', amount: ['discount'], history: 'Desconto concedido {number}' },
    { side: 'C', account: '@title_ledger|1.1.2.01', amount: ['principal', 'discount'], history: 'Baixa do título {number}' },
    { side: 'C', account: '3.4', amount: ['interest', 'fine'], history: 'Juros e multa recebidos {number}' },
    { side: 'D', account: '1.1.4.03', amount: ['split_tax'], history: 'IBS/CBS recolhidos no split payment {number}' },
  ],
  pagamento: [
    { side: 'D', account: '@title_ledger|2.1.1', amount: ['principal', 'discount'], history: 'Pagamento {number}' },
    { side: 'D', account: '4.4.1', amount: ['interest', 'fine'], history: 'Juros e multa pagos {number}' },
    { side: 'C', account: '@settlement_ledger|1.1.1.02', amount: ['total'], history: 'Pagamento {number}' },
    { side: 'C', account: '3.4', amount: ['discount'], history: 'Desconto obtido {number}' },
  ],
  compra_recebida: [
    { side: 'D', account: '1.1.3.01', amount: ['stock_cost'], history: 'Entrada de mercadorias NF {number}' },
    { side: 'D', account: '@expense_ledger|4.3', amount: ['expense'], history: 'Compra para uso/consumo NF {number}' },
    { side: 'D', account: '1.1.4.01', amount: ['icms_credit'], history: 'ICMS a recuperar NF {number}' },
    { side: 'D', account: '1.1.4.02', amount: ['pis_credit', 'cofins_credit'], history: 'PIS/Cofins a recuperar NF {number}' },
    { side: 'D', account: '1.1.4.03', amount: ['ibs_cbs_credit'], history: 'IBS/CBS a recuperar NF {number}' },
    { side: 'C', account: '2.1.1', amount: ['invoice_total'], history: 'Fornecedor NF {number}' },
    { side: 'C', account: '2.1.1', amount: ['freight_payable'], history: 'Frete CT-e rateado na NF {number}' },
  ],
  devolucao_compra: [
    { side: 'D', account: '2.1.1', amount: ['invoice_total'], history: 'Devolução de compra NF {number}' },
    { side: 'C', account: '1.1.3.01', amount: ['stock_cost'], history: 'Saída por devolução NF {number}' },
    { side: 'C', account: '@expense_ledger|4.3', amount: ['expense'], history: 'Estorno de despesa NF {number}' },
    { side: 'C', account: '1.1.4.01', amount: ['icms_credit'], history: 'Estorno de crédito de ICMS NF {number}' },
    { side: 'C', account: '1.1.4.02', amount: ['pis_credit', 'cofins_credit'], history: 'Estorno de crédito PIS/Cofins NF {number}' },
    { side: 'C', account: '1.1.4.03', amount: ['ibs_cbs_credit'], history: 'Estorno de crédito IBS/CBS NF {number}' },
    // Frete de compra (CT-e) já incorporado ao custo e que o fornecedor não devolve
    { side: 'D', account: '4.2.3', amount: ['freight_loss'], history: 'Frete de compra não recuperado na devolução NF {number}' },
  ],
  consumo_os: [
    { side: 'D', account: '4.1', amount: ['value'], history: 'Peças aplicadas na OS {number}' },
    { side: 'C', account: '1.1.3.01', amount: ['value'], history: 'Peças aplicadas na OS {number}' },
  ],
  // Mão de obra e custos indiretos absorvidos pelo produto acabado (seção 17)
  producao_encerrada: [
    { side: 'D', account: '1.1.3.01', amount: ['absorbed'], history: 'Custos absorvidos na OP {number}' },
    { side: 'C', account: '4.3', amount: ['absorbed'], history: 'Absorção de mão de obra e indiretos na OP {number}' },
  ],
  // Resumo da folha (seção 18): bruto e encargos patronais em despesa; líquido, INSS, FGTS e IRRF a pagar
  folha: [
    { side: 'D', account: '4.5', amount: ['gross', 'inss_employer', 'fgts'], history: 'Folha de pagamento {number}' },
    { side: 'C', account: '2.1.5.01', amount: ['net'], history: 'Salários a pagar {number}' },
    { side: 'C', account: '2.1.5.02', amount: ['inss_employee', 'inss_employer'], history: 'INSS a recolher {number}' },
    { side: 'C', account: '2.1.5.03', amount: ['fgts'], history: 'FGTS a recolher {number}' },
    { side: 'C', account: '2.1.5.04', amount: ['irrf'], history: 'IRRF a recolher {number}' },
    { side: 'C', account: '4.5', amount: ['other_deductions'], history: 'Descontos em folha {number}' },
  ],
  remessa_entrega_futura: [
    { side: 'D', account: '3.3.2', amount: ['icms'], history: 'ICMS da remessa NF {number}' },
    { side: 'C', account: '2.1.2.01', amount: ['icms'], history: 'ICMS a recolher NF {number}' },
    { side: 'D', account: '4.1', amount: ['cmv'], history: 'CMV da remessa NF {number}' },
    { side: 'C', account: '1.1.3.01', amount: ['cmv'], history: 'Baixa de estoque NF {number}' },
  ],
  servico_tomado: [
    { side: 'D', account: '@category_ledger|4.3', amount: ['gross'], history: 'Serviço tomado NFS-e {number}' },
    { side: 'C', account: '2.1.1', amount: ['net'], history: 'Fornecedor NFS-e {number}' },
    { side: 'C', account: '2.1.2.08', amount: ['irrf', 'csll', 'pis', 'cofins'], history: 'IRRF/CSRF retidos NFS-e {number}' },
    { side: 'C', account: '2.1.2.09', amount: ['inss'], history: 'INSS retido NFS-e {number}' },
    { side: 'C', account: '2.1.2.05', amount: ['iss'], history: 'ISS retido NFS-e {number}' },
  ],
  baixa_estoque: [
    { side: 'D', account: '4.2.3', amount: ['value'], history: 'Perda/avaria de estoque {number}' },
    { side: 'C', account: '1.1.3.01', amount: ['value'], history: 'Baixa de estoque {number}' },
  ],
  estoque_inicial: [
    { side: 'D', account: '1.1.3.01', amount: ['value'], history: 'Saldo inicial de estoque {number}' },
    { side: 'C', account: '2.3.2', amount: ['value'], history: 'Saldo inicial de estoque {number}' },
  ],
  ajuste_inventario: [
    { side: 'D', account: '1.1.3.01', amount: ['gain'], history: 'Sobra de inventário {number}' },
    { side: 'C', account: '4.2.3', amount: ['gain'], history: 'Sobra de inventário {number}' },
    { side: 'D', account: '4.2.3', amount: ['loss'], history: 'Falta de inventário {number}' },
    { side: 'C', account: '1.1.3.01', amount: ['loss'], history: 'Falta de inventário {number}' },
  ],
  titulo_manual_pagar: [
    { side: 'D', account: '@category_ledger|4.3', amount: ['amount'], history: 'Despesa {number}' },
    { side: 'C', account: '2.1.1', amount: ['amount'], history: 'Título a pagar {number}' },
  ],
  titulo_manual_receber: [
    { side: 'D', account: '1.1.2.01', amount: ['amount'], history: 'Título a receber {number}' },
    { side: 'C', account: '@category_ledger|3.4', amount: ['amount'], history: 'Receita {number}' },
  ],
  renegociacao: [
    { side: 'D', account: '1.1.2.01', amount: ['charges'], history: 'Encargos renegociados {number}' },
    { side: 'C', account: '3.4', amount: ['charges'], history: 'Encargos renegociados {number}' },
    { side: 'D', account: '4.4.2', amount: ['discount'], history: 'Desconto na renegociação {number}' },
    { side: 'C', account: '1.1.2.01', amount: ['discount'], history: 'Desconto na renegociação {number}' },
  ],
  perda_titulo: [
    { side: 'D', account: '4.3', amount: ['amount'], history: 'Perda com crédito incobrável {number}' },
    { side: 'C', account: '1.1.2.01', amount: ['amount'], history: 'Baixa por incobrável {number}' },
  ],
  adiantamento_cliente: [
    { side: 'D', account: '@settlement_ledger|1.1.1.02', amount: ['amount'], history: 'Adiantamento de cliente {number}' },
    { side: 'C', account: '2.1.3', amount: ['amount'], history: 'Adiantamento de cliente {number}' },
  ],
  adiantamento_fornecedor: [
    { side: 'D', account: '1.1.5', amount: ['amount'], history: 'Adiantamento a fornecedor {number}' },
    { side: 'C', account: '@settlement_ledger|1.1.1.02', amount: ['amount'], history: 'Adiantamento a fornecedor {number}' },
  ],
  compensacao_adiantamento: [
    { side: 'D', account: '@advance_ledger|2.1.3', amount: ['amount'], history: 'Compensação de adiantamento {number}' },
    { side: 'C', account: '@title_ledger|1.1.2.01', amount: ['amount'], history: 'Compensação de adiantamento {number}' },
  ],
  transferencia_contas: [
    { side: 'D', account: '@to_ledger|1.1.1.02', amount: ['amount'], history: 'Transferência entre contas {number}' },
    { side: 'C', account: '@from_ledger|1.1.1.02', amount: ['amount'], history: 'Transferência entre contas {number}' },
  ],
  movimento_conta: [
    { side: 'D', account: '@debit_ledger|4.3', amount: ['amount'], history: '{number}' },
    { side: 'C', account: '@credit_ledger|1.1.1.02', amount: ['amount'], history: '{number}' },
  ],
};

export async function createDefaultPostingRules(tx: Tx): Promise<void> {
  for (const [event, lines] of Object.entries(DEFAULT_POSTING_RULES)) {
    await tx.exec(`INSERT INTO accounting.posting_rules (tenant_id, event_type, lines) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tx.tenantId, event, JSON.stringify(lines)]);
  }
}

export interface PostingEvent {
  type: string;
  companyId: string;
  establishmentId?: string | null;
  date: string;
  description: string;
  number?: string;
  originType: string;
  originId?: string | null;
  operationTypeCode?: string | null;
  categoryId?: string | null;
  partyId?: string | null;
  costCenterId?: string | null;
  amounts: Record<string, string | Decimal | null | undefined>;
  /** Contas contábeis (ids) resolvidas pelo contexto: "@settlement_ledger" etc. */
  ledgers?: Record<string, string | null | undefined>;
  idempotencyKey?: string | null;
  manual?: boolean;
  reversalOf?: string | null;
}

/**
 * Contabilização automática por eventos (RN-CTB-02). O débito = crédito é
 * garantido pelo banco no fim da transação (RN-CTB-01).
 */
export async function postEvent(tx: Tx, ev: PostingEvent): Promise<string | null> {
  if (ev.idempotencyKey) {
    const ex = await tx.maybeOne<{ id: string }>(`SELECT id FROM accounting.journal_entries WHERE idempotency_key = $1`, [ev.idempotencyKey]);
    if (ex) return ex.id;
  }
  const rule = await tx.maybeOne<{ lines: TemplateLine[] }>(
    `SELECT lines FROM accounting.posting_rules
      WHERE event_type = $1 AND active AND (operation_type_code IS NULL OR operation_type_code = $2) AND (establishment_id IS NULL OR establishment_id = $3)
        AND (category_id IS NULL OR category_id = $4)
      ORDER BY (operation_type_code IS NOT NULL)::int + (establishment_id IS NOT NULL)::int + (category_id IS NOT NULL)::int DESC LIMIT 1`,
    [ev.type, ev.operationTypeCode ?? null, ev.establishmentId ?? null, ev.categoryId ?? null]);
  // Tenant criado antes de um evento novo existir: usa a regra padrão do sistema
  const template = rule?.lines ?? DEFAULT_POSTING_RULES[ev.type];
  if (!template) return null;
  const amount = (keys: string[]) => roundMoney(sum(keys.map((k) => (k.startsWith('-') ? D(String(ev.amounts[k.slice(1)] ?? '0')).negated() : D(String(ev.amounts[k] ?? '0'))))));
  const codes = new Map<string, string>();
  const accountId = async (spec: string): Promise<string> => {
    let code = spec;
    if (spec.startsWith('@')) {
      const [key, fallback] = spec.slice(1).split('|');
      const id = ev.ledgers?.[key!];
      if (id) return id;
      code = fallback!;
    }
    if (!codes.has(code)) {
      const acc = await tx.maybeOne<{ id: string }>(`SELECT id FROM accounting.chart_of_accounts WHERE code = $1`, [code]);
      if (!acc) throw new AppError('ACCOUNTING_CONFIG', `Conta contábil ${code} não encontrada no plano (regra ${ev.type})`, 422);
      codes.set(code, acc.id);
    }
    return codes.get(code)!;
  };
  const lines: { accountId: string; debit: Decimal; credit: Decimal; history: string }[] = [];
  for (const l of template) {
    const v = amount(l.amount);
    if (v.isZero()) continue;
    // Valor negativo inverte o lado (ex.: ajuste)
    const side = v.isNegative() ? (l.side === 'D' ? 'C' : 'D') : l.side;
    const abs = v.abs();
    lines.push({ accountId: await accountId(l.account), debit: side === 'D' ? abs : ZERO, credit: side === 'C' ? abs : ZERO,
      history: (l.history ?? ev.description).replace('{number}', ev.number ?? '') });
  }
  if (!lines.length) return null;
  const d = sum(lines.map((l) => l.debit));
  const c = sum(lines.map((l) => l.credit));
  if (!d.equals(c)) throw new AppError('ACCOUNTING_UNBALANCED', `Regra de contabilização "${ev.type}" gerou lançamento desbalanceado (D ${d.toFixed(2)} × C ${c.toFixed(2)})`, 422, { rule: 'RN-CTB-01' });
  const entry = await tx.one<{ id: string }>(
    `INSERT INTO accounting.journal_entries (tenant_id, company_id, establishment_id, number, entry_date, description, event_type, origin_type, origin_id, manual, reversal_of, idempotency_key, created_by)
     VALUES ($1,$2,$3,core.next_counter($2,'journal'),$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [tx.tenantId, ev.companyId, ev.establishmentId ?? null, ev.date, ev.description, ev.type, ev.originType, ev.originId ?? null, ev.manual ?? false, ev.reversalOf ?? null, ev.idempotencyKey ?? null, tx.userId]);
  for (const l of lines) {
    await tx.exec(`INSERT INTO accounting.journal_lines (tenant_id, entry_id, account_id, debit, credit, cost_center_id, party_id, history) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tx.tenantId, entry.id, l.accountId, l.debit.toFixed(2), l.credit.toFixed(2), ev.costCenterId ?? null, ev.partyId ?? null, l.history]);
  }
  return entry.id;
}

/** Estorno: lançamento novo com débitos e créditos invertidos (RN-GER-02). */
export async function reverseEntries(tx: Tx, originType: string, originId: string, date: string, reason: string): Promise<number> {
  const entries = await tx.query<{ id: string; company_id: string; establishment_id: string | null; event_type: string; description: string }>(
    `SELECT e.id, e.company_id, e.establishment_id, e.event_type, e.description FROM accounting.journal_entries e
      WHERE e.origin_type = $1 AND e.origin_id = $2 AND e.reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM accounting.journal_entries r WHERE r.reversal_of = e.id)`,
    [originType, originId]);
  for (const e of entries) {
    const rev = await tx.one<{ id: string }>(
      `INSERT INTO accounting.journal_entries (tenant_id, company_id, establishment_id, number, entry_date, description, event_type, origin_type, origin_id, reversal_of, created_by)
       VALUES ($1,$2,$3,core.next_counter($2,'journal'),$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [tx.tenantId, e.company_id, e.establishment_id, date, `Estorno: ${e.description} (${reason})`.slice(0, 500), `estorno_${e.event_type}`, originType, originId, e.id, tx.userId]);
    await tx.exec(
      `INSERT INTO accounting.journal_lines (tenant_id, entry_id, account_id, debit, credit, cost_center_id, party_id, history)
       SELECT tenant_id, $2, account_id, credit, debit, cost_center_id, party_id, 'Estorno: ' || history FROM accounting.journal_lines WHERE entry_id = $1`,
      [e.id, rev.id]);
  }
  return entries.length;
}
