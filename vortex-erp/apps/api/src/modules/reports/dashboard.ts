import { D, sum } from '@vortex/money';
import type { RequestContext, Tx } from '../../db/tx.js';
import { has } from '../../core/access.js';
import { accountBalances } from '../finance/reports.js';
import { orderStageCounts } from '../sales/orders.js';

export interface Alert {
  code: string;
  title: string;
  count: number;
  severity: 'info' | 'warning' | 'critical';
  link: string;
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
/** Mesmo período do mês anterior (do dia 1 até o mesmo dia): mês corrente × mês fechado distorce. */
function prevMonth(d: string): { from: string; to: string } {
  const first = new Date(`${monthStart(d)}T12:00:00Z`);
  const end = new Date(first.getTime() - 86_400_000);
  const day = Math.min(Number(d.slice(8, 10)), end.getUTCDate());
  return { from: `${end.toISOString().slice(0, 7)}-01`, to: `${end.toISOString().slice(0, 7)}-${String(day).padStart(2, '0')}` };
}
const pct = (a: unknown, b: unknown) => (D(String(b ?? 0)).isZero() ? '0.00' : D(String(a ?? 0)).dividedBy(String(b)).times(100).toFixed(2));

/**
 * Painel do dono (seção 19): faturamento, margem, caixa disponível, inadimplência,
 * estoque parado, metas e alertas — respeitando empresa e estabelecimentos do usuário.
 */
export async function ownerDashboard(tx: Tx, ctx: RequestContext, date?: string) {
  const today = date ?? new Date().toISOString().slice(0, 10);
  const ests = ctx.establishmentIds;
  const sales = async (from: string, to: string, extra = '', params: unknown[] = []) => tx.one<{ revenue: string | null; taxes: string | null; cmv: string | null; docs: number }>(
    `SELECT sum(i.total - i.discount) AS revenue, count(DISTINCT d.id)::int AS docs, sum(coalesce(i.unit_cost * i.stock_quantity, 0)) AS cmv,
            sum((SELECT coalesce(sum(t.value), 0) FROM fiscal.document_item_taxes t WHERE t.document_item_id = i.id AND t.tax IN ('ICMS','FCP','DIFAL','FCP_DEST','PIS','COFINS','ISS'))) AS taxes
       FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id
       LEFT JOIN sales.orders o ON d.source_type = 'sales_order' AND o.id = d.source_id
       LEFT JOIN catalog.products p ON p.id = i.product_id
      WHERE d.direction = 'S' AND d.status = 'autorizada' AND d.purpose = 1 AND d.source_type IN ('sales_order','pdv') AND ($1::uuid IS NULL OR d.company_id = $1)
        AND d.issued_at::date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR d.establishment_id = ANY($4)) ${extra}`,
    [ctx.companyId, from, to, ests, ...params]);
  const cur = await sales(monthStart(today), today);
  const prev = prevMonth(today);
  const last = await sales(prev.from, prev.to);
  const revenue = D(cur.revenue ?? 0);
  const margin = revenue.minus(cur.taxes ?? 0).minus(cur.cmv ?? 0);

  const balances = has(ctx, 'financeiro.conta.ler') || has(ctx, 'relatorios.painel.ler') ? await accountBalances(tx, ctx.companyId) : [];
  const cashAccounts = balances.filter((a: any) => ['cash', 'bank'].includes(a.kind));
  const recv = await tx.one<{ open: string | null; overdue: string | null; titles: number }>(
    `SELECT sum(balance) AS open, sum(balance) FILTER (WHERE due_date < $2) AS overdue, count(*) FILTER (WHERE due_date < $2)::int AS titles
       FROM finance.titles WHERE kind = 'receivable' AND status IN ('open','partially_paid') AND origin_type <> 'advance' AND ($1::uuid IS NULL OR company_id = $1)`, [ctx.companyId, today]);
  const idle = await tx.one<{ value: string | null; products: number }>(
    `SELECT sum(pc.quantity * pc.avg_cost) AS value, count(*)::int AS products FROM inventory.product_costs pc
      WHERE ($1::uuid IS NULL OR pc.company_id = $1) AND pc.quantity > 0 AND ($2::uuid[] IS NULL OR pc.establishment_id = ANY($2))
        AND NOT EXISTS (SELECT 1 FROM inventory.stock_movements m WHERE m.product_id = pc.product_id AND m.establishment_id = pc.establishment_id AND m.sign = -1
                         AND m.occurred_at >= $3::date - 90)`, [ctx.companyId, ests, today]);

  // Metas vigentes: realizado no período da meta, pelo recorte (vendedor, filial, produto, categoria)
  const targets = await tx.query<Record<string, any>>(
    `SELECT t.*, sp.legal_name AS salesperson, e.code AS establishment, p.sku, c.name AS category FROM sales.targets t
       LEFT JOIN registry.parties sp ON sp.id = t.salesperson_id LEFT JOIN core.establishments e ON e.id = t.establishment_id
       LEFT JOIN catalog.products p ON p.id = t.product_id LEFT JOIN catalog.categories c ON c.id = t.category_id
      WHERE ($1::uuid IS NULL OR t.company_id = $1) AND $2::date BETWEEN t.period_start AND t.period_end AND t.target_amount IS NOT NULL
        AND ($3::uuid IS NULL OR t.salesperson_id = $3)`, [ctx.companyId, today, ctx.ownPortfolioOnly ? ctx.partyId : null]);
  const targetRows = [];
  for (const t of targets) {
    const r = await sales(t.period_start instanceof Date ? t.period_start.toISOString().slice(0, 10) : t.period_start, today,
      `AND ($5::uuid IS NULL OR o.salesperson_id = $5) AND ($6::uuid IS NULL OR d.establishment_id = $6) AND ($7::uuid IS NULL OR i.product_id = $7) AND ($8::uuid IS NULL OR p.category_id = $8)`,
      [t.salesperson_id, t.establishment_id, t.product_id, t.category_id]);
    const name = [t.salesperson, t.establishment, t.sku, t.category, t.team].filter(Boolean).join(' · ') || 'geral';
    targetRows.push({ id: t.id, name, target: D(t.target_amount).toFixed(2), achieved: D(r.revenue ?? 0).toFixed(2), percent: pct(r.revenue, t.target_amount) });
  }

  const count = async (sql: string, params: unknown[] = []) => (await tx.one<{ n: number }>(sql, params)).n;
  const alerts = ([
    { code: 'certificado_vencendo', title: 'Certificado digital vence em até 30 dias', severity: 'critical', link: '/configuracoes/certificados',
      count: await count(`SELECT count(*)::int AS n FROM core.establishments WHERE certificate_expires_at IS NOT NULL AND certificate_expires_at < $1::date + 30
                           AND ($2::uuid IS NULL OR company_id = $2)`, [today, ctx.companyId]) },
    { code: 'notas_contingencia', title: 'Notas em contingência aguardando autorização', severity: 'critical', link: '/fiscal/notas?status=contingencia',
      count: await count(`SELECT count(*)::int AS n FROM fiscal.documents WHERE status = 'contingencia' AND ($1::uuid IS NULL OR company_id = $1)`, [ctx.companyId]) },
    { code: 'notas_rejeitadas', title: 'Notas rejeitadas para corrigir', severity: 'warning', link: '/fiscal/notas?status=rejeitada',
      count: await count(`SELECT count(*)::int AS n FROM fiscal.documents WHERE status = 'rejeitada' AND ($1::uuid IS NULL OR company_id = $1)`, [ctx.companyId]) },
    { code: 'pagar_hoje', title: 'Contas a pagar vencendo hoje ou vencidas', severity: 'warning', link: '/financeiro/titulos?tipo=payable&vencidas=1',
      count: await count(`SELECT count(*)::int AS n FROM finance.titles WHERE kind = 'payable' AND status IN ('open','partially_paid') AND due_date <= $1
                           AND ($2::uuid IS NULL OR company_id = $2)`, [today, ctx.companyId]) },
    { code: 'estoque_minimo', title: 'Produtos abaixo do ponto de pedido', severity: 'warning', link: '/relatorios?codigo=estoque.posicao',
      count: await count(`SELECT count(*)::int AS n FROM catalog.stock_params sp JOIN core.warehouses w ON w.id = sp.warehouse_id
                           WHERE ($1::uuid IS NULL OR w.company_id = $1) AND coalesce((SELECT sum(quantity - reserved - blocked) FROM inventory.stock_balances b
                             WHERE b.warehouse_id = sp.warehouse_id AND b.product_id = sp.product_id), 0) <= sp.reorder_point`, [ctx.companyId]) },
    { code: 'estoque_negativo', title: 'Produtos com estoque negativo (venda do PDV sem saldo no ERP: lance a entrada ou ajuste)', severity: 'critical', link: '/estoque',
      count: await count(`SELECT count(DISTINCT b.product_id)::int AS n FROM inventory.stock_balances b JOIN core.warehouses w ON w.id = b.warehouse_id
                           WHERE b.quantity < 0 AND ($1::uuid IS NULL OR w.company_id = $1)`, [ctx.companyId]) },
    { code: 'lotes_vencendo', title: 'Lotes com validade em até 30 dias', severity: 'warning', link: '/relatorios?codigo=estoque.validade',
      count: await count(`SELECT count(DISTINCT l.id)::int AS n FROM inventory.lots l JOIN inventory.stock_balances b ON b.lot_id = l.id
                           WHERE b.quantity > 0 AND l.expires_at <= $1::date + 30 AND ($2::uuid IS NULL OR b.company_id = $2)`, [today, ctx.companyId]) },
    { code: 'aprovacoes_pendentes', title: 'Aprovações aguardando decisão', severity: 'info', link: '/aprovacoes',
      count: (await tx.query<{ approver_permission: string }>(`SELECT approver_permission FROM core.approval_requests WHERE status = 'pending'`)).filter((a) => has(ctx, a.approver_permission)).length },
    { code: 'recebimentos_divergentes', title: 'Recebimentos com divergência', severity: 'info', link: '/compras/recebimentos?status=divergent',
      count: await count(`SELECT count(*)::int AS n FROM purchasing.receipts WHERE status = 'divergent' AND ($1::uuid IS NULL OR company_id = $1)`, [ctx.companyId]) },
    { code: 'jobs_com_erro', title: 'Rotinas automáticas com erro', severity: 'critical', link: '/integracoes/jobs',
      count: await count(`SELECT count(*)::int AS n FROM integration.jobs WHERE tenant_id = $1 AND status = 'dead' AND coalesce(finished_at, created_at) > now() - interval '7 days'`, [tx.tenantId]) },
  ] as Alert[]).filter((a) => a.count > 0);

  return {
    date: today,
    revenue: { month: revenue.toFixed(2), previousMonth: D(last.revenue ?? 0).toFixed(2), variationPercent: D(last.revenue ?? 0).isZero() ? '0.00' : revenue.minus(last.revenue!).dividedBy(last.revenue!).times(100).toFixed(2),
      documents: cur.docs, averageTicket: cur.docs ? revenue.dividedBy(cur.docs).toFixed(2) : '0.00' },
    margin: { value: margin.toFixed(2), percent: pct(margin, revenue) },
    cash: { available: sum(cashAccounts.map((a: any) => a.balance)).toFixed(2), accounts: cashAccounts.map((a: any) => ({ code: a.code, name: a.name, balance: D(a.balance).toFixed(2) })) },
    delinquency: { overdue: D(recv.overdue ?? 0).toFixed(2), open: D(recv.open ?? 0).toFixed(2), titles: recv.titles, percent: pct(recv.overdue, recv.open) },
    idleStock: { value: D(idle.value ?? 0).toFixed(2), products: idle.products },
    targets: targetRows,
    alerts,
  };
}

/**
 * Gráficos do painel do dono (período de `days` dias até `date`): faturamento por dia e por
 * canal, mix de produtos e clientes, vencimentos a receber/pagar, saldo projetado, pedidos por
 * etapa e estoque abaixo do ponto de pedido.
 */
export async function ownerCharts(tx: Tx, ctx: RequestContext, opts: { date?: string; days?: number } = {}) {
  const to = opts.date ?? new Date().toISOString().slice(0, 10);
  const days = opts.days ?? 30;
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const base = `FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id
     WHERE d.direction = 'S' AND d.status IN ('autorizada', 'contingencia') AND d.purpose = 1 AND d.source_type IN ('sales_order', 'pdv')
       AND ($1::uuid IS NULL OR d.company_id = $1) AND ($4::uuid[] IS NULL OR d.establishment_id = ANY($4)) AND d.issued_at::date BETWEEN $2 AND $3`;
  const args = [ctx.companyId, from, to, ctx.establishmentIds];
  const daily = await tx.query<{ date: string; orders: string; pdv: string; docs: number }>(
    `SELECT g.day::date::text AS date,
            coalesce(sum(i.total - i.discount) FILTER (WHERE d.source_type = 'sales_order'), 0) AS orders,
            coalesce(sum(i.total - i.discount) FILTER (WHERE d.source_type = 'pdv'), 0) AS pdv, count(DISTINCT d.id)::int AS docs
       FROM generate_series($2::date, $3::date, interval '1 day') g(day)
       LEFT JOIN (fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id)
         ON d.issued_at::date = g.day::date AND d.direction = 'S' AND d.status IN ('autorizada', 'contingencia') AND d.purpose = 1 AND d.source_type IN ('sales_order', 'pdv')
        AND ($1::uuid IS NULL OR d.company_id = $1) AND ($4::uuid[] IS NULL OR d.establishment_id = ANY($4))
      GROUP BY g.day ORDER BY g.day`, args);
  const channels = await tx.query<{ channel: string; revenue: string; docs: number }>(
    `SELECT CASE WHEN d.source_type = 'pdv' THEN 'Loja (PDV)' ELSE coalesce((SELECT CASE o.channel WHEN 'counter' THEN 'Balcão' WHEN 'ecommerce' THEN 'E-commerce'
              WHEN 'marketplace' THEN 'Marketplace' WHEN 'whatsapp' THEN 'WhatsApp' WHEN 'wholesale' THEN 'Atacado' WHEN 'crm' THEN 'Representantes' ELSE 'Outros' END
              FROM sales.orders o WHERE o.id = d.source_id), 'Pedidos') END AS channel,
            sum(i.total - i.discount) AS revenue, count(DISTINCT d.id)::int AS docs ${base} GROUP BY 1 ORDER BY 2 DESC`, args);
  const topProducts = await tx.query(
    `SELECT p.id, p.sku, p.description, sum(i.quantity) AS quantity, sum(i.total - i.discount) AS revenue,
            sum(i.total - i.discount) - sum(coalesce(i.unit_cost * i.stock_quantity, 0)) AS gross_margin
       ${base.replace('JOIN fiscal.document_items i ON i.document_id = d.id', 'JOIN fiscal.document_items i ON i.document_id = d.id JOIN catalog.products p ON p.id = i.product_id')}
      GROUP BY p.id, p.sku, p.description ORDER BY revenue DESC LIMIT 8`, args);
  const topCustomers = await tx.query(
    `SELECT coalesce(d.recipient_name, 'Consumidor final') AS name, sum(i.total - i.discount) AS revenue, count(DISTINCT d.id)::int AS docs ${base}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6`, args);
  const aging = (kind: 'receivable' | 'payable') => tx.query<{ bucket: string; amount: string; titles: number }>(
    `SELECT b.bucket, coalesce(sum(t.balance), 0) AS amount, count(t.id)::int AS titles
       FROM (VALUES ('Vencido +60', 1), ('Vencido 31–60', 2), ('Vencido 1–30', 3), ('Vence em 0–30', 4), ('Vence em 31–60', 5), ('Vence em +60', 6)) b(bucket, ord)
       LEFT JOIN finance.titles t ON t.kind = $2 AND t.status IN ('open', 'partially_paid') AND t.balance > 0 AND ($1::uuid IS NULL OR t.company_id = $1) AND b.bucket = CASE
              WHEN t.due_date < $3::date - 60 THEN 'Vencido +60' WHEN t.due_date < $3::date - 30 THEN 'Vencido 31–60' WHEN t.due_date < $3::date THEN 'Vencido 1–30'
              WHEN t.due_date <= $3::date + 30 THEN 'Vence em 0–30' WHEN t.due_date <= $3::date + 60 THEN 'Vence em 31–60' ELSE 'Vence em +60' END
      GROUP BY b.bucket, b.ord ORDER BY b.ord`, [ctx.companyId, kind, to]);
  // Saldo projetado: caixa + bancos hoje, mais recebimentos e menos pagamentos previstos dia a dia (30 dias)
  const balances = has(ctx, 'financeiro.conta.ler') || has(ctx, 'relatorios.painel.ler') ? await accountBalances(tx, ctx.companyId) : [];
  const start = balances.filter((a: any) => ['cash', 'bank'].includes(a.kind)).reduce((s: ReturnType<typeof D>, a: any) => s.plus(a.balance), D(0));
  const flows = await tx.query<{ date: string; inflow: string; outflow: string }>(
    `SELECT g.day::date::text AS date,
            coalesce(sum(t.balance) FILTER (WHERE t.kind = 'receivable'), 0) AS inflow, coalesce(sum(t.balance) FILTER (WHERE t.kind = 'payable'), 0) AS outflow
       FROM generate_series($2::date, $2::date + 29, interval '1 day') g(day)
       LEFT JOIN finance.titles t ON t.status IN ('open', 'partially_paid') AND t.balance > 0 AND ($1::uuid IS NULL OR t.company_id = $1)
        AND (CASE WHEN t.due_date < $2 THEN $2 ELSE t.due_date END) = g.day::date
      GROUP BY g.day ORDER BY g.day`, [ctx.companyId, to]);
  let running = start;
  const forecast = flows.map((f) => {
    running = running.plus(f.inflow).minus(f.outflow);
    return { ...f, balance: running.toFixed(2) };
  });
  const lowStock = await tx.query(
    `SELECT p.sku, p.description, sp.reorder_point, sp.min_qty,
            coalesce((SELECT sum(b.quantity - b.reserved - b.blocked) FROM inventory.stock_balances b WHERE b.product_id = sp.product_id AND b.warehouse_id = sp.warehouse_id), 0) AS available
       FROM catalog.stock_params sp JOIN catalog.products p ON p.id = sp.product_id JOIN core.warehouses w ON w.id = sp.warehouse_id
      WHERE ($1::uuid IS NULL OR w.company_id = $1) AND sp.reorder_point IS NOT NULL
        AND coalesce((SELECT sum(b.quantity - b.reserved - b.blocked) FROM inventory.stock_balances b WHERE b.product_id = sp.product_id AND b.warehouse_id = sp.warehouse_id), 0) <= sp.reorder_point
      ORDER BY available ASC LIMIT 8`, [ctx.companyId]);
  return {
    period: { from, to, days }, daily, channels, topProducts, topCustomers,
    receivables: await aging('receivable'), payables: await aging('payable'),
    cash: { today: start.toFixed(2), forecast },
    ordersByStage: has(ctx, 'vendas.pedido.ler') ? await orderStageCounts(tx, { from, to }) : [],
    lowStock,
  };
}
