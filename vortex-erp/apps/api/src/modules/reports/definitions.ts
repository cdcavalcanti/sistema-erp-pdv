import { z } from 'zod';
import { D, ZERO, sum } from '@vortex/money';
import type { RequestContext, Tx } from '../../db/tx.js';
import { isoDate } from '../../http/schemas.js';
import { aging, cashFlow, managementDre } from '../finance/reports.js';
import { abcCurve } from '../inventory/counting.js';
import { ownerDashboard } from './dashboard.js';
import { theoreticalVsReal } from '../production/service.js';

export type ColumnType = 'text' | 'money' | 'number' | 'percent' | 'date';
export interface Column {
  key: string;
  label: string;
  type?: ColumnType;
}
export type Row = Record<string, unknown>;

/**
 * Relatório operacional (seção 19). Toda execução respeita as permissões e o escopo
 * do usuário (RN-REL-01): empresa ativa, estabelecimentos permitidos e carteira própria.
 */
export interface ReportDef {
  code: string;
  area: 'vendas' | 'compras' | 'estoque' | 'financeiro' | 'fiscal' | 'gestao';
  title: string;
  description: string;
  permission: string;
  /** Pesado: roda só em fila (RN-REL-02) */
  heavy?: boolean;
  params: z.ZodType<Record<string, unknown>>;
  columns: Column[] | ((p: any) => Column[]);
  run: (tx: Tx, p: any, ctx: RequestContext) => Promise<Row[]>;
}

const period = z.object({ from: isoDate, to: isoDate, establishmentId: z.string().uuid().optional() });
/** Estabelecimentos visíveis: o filtro pedido, limitado ao escopo do usuário. */
function ests(ctx: RequestContext, requested?: string): string[] | null {
  if (requested) return ctx.establishmentIds && !ctx.establishmentIds.includes(requested) ? [] : [requested];
  return ctx.establishmentIds;
}
const pct = (a: unknown, b: unknown) => (D(String(b ?? 0)).isZero() ? '0.00' : D(String(a ?? 0)).dividedBy(String(b)).times(100).toFixed(2));

function abcClasses<T extends Row>(rows: T[], key: string): (T & { cumulative_percent: string; class: string })[] {
  const total = sum(rows.map((r) => String(r[key] ?? 0)));
  let acc = ZERO;
  return rows.map((r) => {
    acc = acc.plus(String(r[key] ?? 0));
    const c = total.isZero() ? ZERO : acc.dividedBy(total).times(100);
    return { ...r, cumulative_percent: c.toFixed(2), class: c.lessThanOrEqualTo(80) ? 'A' : c.lessThanOrEqualTo(95) ? 'B' : 'C' };
  });
}

// Base de vendas: itens de documentos de saída autorizados (ERP e PDV), com tributos sobre a venda e CMV
const SALES_ITEMS = `
  SELECT d.id AS document_id, d.establishment_id, d.issued_at, d.party_id, coalesce(o.salesperson_id, NULL) AS salesperson_id,
         CASE WHEN d.source_type = 'pdv' THEN 'pdv' ELSE coalesce(o.channel, 'counter') END AS channel,
         i.product_id, i.quantity, i.total - i.discount AS revenue, i.discount, i.item_total,
         coalesce(i.unit_cost * i.stock_quantity, 0) AS cmv,
         coalesce((SELECT sum(t.value) FROM fiscal.document_item_taxes t WHERE t.document_item_id = i.id AND t.tax IN ('ICMS','FCP','DIFAL','FCP_DEST','PIS','COFINS','ISS')), 0) AS taxes
    FROM fiscal.documents d
    JOIN fiscal.document_items i ON i.document_id = d.id
    LEFT JOIN sales.orders o ON d.source_type = 'sales_order' AND o.id = d.source_id
   WHERE d.direction = 'S' AND d.status = 'autorizada' AND d.purpose = 1 AND d.source_type IN ('sales_order','pdv')
     AND ($1::uuid IS NULL OR d.company_id = $1) AND d.issued_at::date BETWEEN $2 AND $3
     AND ($4::uuid[] IS NULL OR d.establishment_id = ANY($4)) AND ($5::uuid IS NULL OR o.salesperson_id = $5)`;

const salesGroups: Record<string, { expr: string; join: string; label: string }> = {
  day: { expr: `to_char(s.issued_at, 'YYYY-MM-DD')`, join: '', label: 'Dia' },
  month: { expr: `to_char(s.issued_at, 'YYYY-MM')`, join: '', label: 'Mês' },
  salesperson: { expr: `coalesce(sp.legal_name, '(sem vendedor)')`, join: 'LEFT JOIN registry.parties sp ON sp.id = s.salesperson_id', label: 'Vendedor' },
  customer: { expr: `coalesce(c.legal_name, 'Consumidor final')`, join: 'LEFT JOIN registry.parties c ON c.id = s.party_id', label: 'Cliente' },
  product: { expr: `p.sku || ' — ' || p.description`, join: 'JOIN catalog.products p ON p.id = s.product_id', label: 'Produto' },
  category: { expr: `coalesce(cat.name, '(sem categoria)')`, join: 'JOIN catalog.products p ON p.id = s.product_id LEFT JOIN catalog.categories cat ON cat.id = p.category_id', label: 'Categoria' },
  channel: { expr: 's.channel', join: '', label: 'Canal' },
  establishment: { expr: `e.code || ' — ' || coalesce(e.trade_name, e.legal_name)`, join: 'JOIN core.establishments e ON e.id = s.establishment_id', label: 'Filial' },
};

export const REPORTS: ReportDef[] = [
  // ------------------------------------------------------------------ vendas
  {
    code: 'vendas.por_periodo', area: 'vendas', title: 'Vendas por período', permission: 'vendas.pedido.ler',
    description: 'Faturamento por dia, mês, vendedor, cliente, produto, categoria, canal ou filial; ticket médio; margem bruta (receita − tributos − CMV)',
    params: period.extend({ groupBy: z.enum(['day', 'month', 'salesperson', 'customer', 'product', 'category', 'channel', 'establishment']).default('day') }),
    columns: (p) => [{ key: 'group', label: salesGroups[p.groupBy ?? 'day']!.label }, { key: 'documents', label: 'Notas', type: 'number' }, { key: 'quantity', label: 'Quantidade', type: 'number' },
      { key: 'revenue', label: 'Faturamento', type: 'money' }, { key: 'discounts', label: 'Descontos', type: 'money' }, { key: 'average_ticket', label: 'Ticket médio', type: 'money' },
      { key: 'taxes', label: 'Tributos', type: 'money' }, { key: 'cmv', label: 'CMV', type: 'money' }, { key: 'gross_margin', label: 'Margem bruta', type: 'money' },
      { key: 'margin_percent', label: 'Margem %', type: 'percent' }],
    run: async (tx, p, ctx) => {
      const g = salesGroups[p.groupBy]!;
      const rows = await tx.query(
        `SELECT ${g.expr} AS "group", count(DISTINCT s.document_id)::int AS documents, sum(s.quantity) AS quantity, sum(s.revenue) AS revenue, sum(s.discount) AS discounts,
                sum(s.taxes) AS taxes, sum(s.cmv) AS cmv
           FROM (${SALES_ITEMS}) s ${g.join} GROUP BY 1 ORDER BY ${p.groupBy === 'day' || p.groupBy === 'month' ? '1' : 'revenue DESC'}`,
        [ctx.companyId, p.from, p.to, ests(ctx, p.establishmentId), ctx.ownPortfolioOnly ? ctx.partyId : null]);
      return rows.map((r) => {
        const margin = D(r.revenue ?? 0).minus(r.taxes ?? 0).minus(r.cmv ?? 0);
        return { ...r, revenue: D(r.revenue ?? 0).toFixed(2), cmv: D(r.cmv ?? 0).toFixed(2), taxes: D(r.taxes ?? 0).toFixed(2),
          average_ticket: r.documents ? D(r.revenue ?? 0).dividedBy(r.documents).toFixed(2) : '0.00', gross_margin: margin.toFixed(2), margin_percent: pct(margin, r.revenue) };
      });
    },
  },
  {
    code: 'vendas.descontos', area: 'vendas', title: 'Descontos concedidos', permission: 'vendas.pedido.ler', description: 'Pedidos com desconto sobre o preço de tabela, por vendedor',
    params: period,
    columns: [{ key: 'number', label: 'Pedido' }, { key: 'date', label: 'Data', type: 'date' }, { key: 'customer', label: 'Cliente' }, { key: 'salesperson', label: 'Vendedor' },
      { key: 'list_total', label: 'Total de tabela', type: 'money' }, { key: 'discount', label: 'Desconto', type: 'money' }, { key: 'discount_percent', label: 'Desconto %', type: 'percent' }],
    run: async (tx, p, ctx) => (await tx.query(
      `SELECT o.number, o.created_at::date AS date, c.legal_name AS customer, sp.legal_name AS salesperson, sum(i.list_price * i.quantity)::numeric(18,2) AS list_total,
              (sum(i.list_price * i.quantity) - sum(i.total))::numeric(18,2) AS discount
         FROM sales.orders o JOIN sales.order_items i ON i.order_id = o.id JOIN registry.parties c ON c.id = o.party_id LEFT JOIN registry.parties sp ON sp.id = o.salesperson_id
        WHERE ($1::uuid IS NULL OR o.company_id = $1) AND o.created_at::date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR o.establishment_id = ANY($4))
          AND ($5::uuid IS NULL OR o.salesperson_id = $5) AND o.status <> 'cancelled'
        GROUP BY o.id, c.legal_name, sp.legal_name HAVING sum(i.list_price * i.quantity) - sum(i.total) > 0.005 ORDER BY discount DESC`,
      [ctx.companyId, p.from, p.to, ests(ctx, p.establishmentId), ctx.ownPortfolioOnly ? ctx.partyId : null])).map((r) => ({ ...r, discount_percent: pct(r.discount, r.list_total) })),
  },
  {
    code: 'vendas.pedidos_abertos', area: 'vendas', title: 'Pedidos em aberto', permission: 'vendas.pedido.ler', description: 'Pedidos não faturados com saldo a faturar e reserva',
    params: z.object({ establishmentId: z.string().uuid().optional() }),
    columns: [{ key: 'number', label: 'Pedido' }, { key: 'date', label: 'Data', type: 'date' }, { key: 'status', label: 'Situação' }, { key: 'customer', label: 'Cliente' },
      { key: 'salesperson', label: 'Vendedor' }, { key: 'pending_value', label: 'Saldo a faturar', type: 'money' }, { key: 'expected_delivery', label: 'Entrega prevista', type: 'date' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT o.number, o.created_at::date AS date, o.status, c.legal_name AS customer, sp.legal_name AS salesperson, o.expected_delivery,
              sum((i.quantity - i.quantity_invoiced - i.quantity_cancelled) * i.total / i.quantity)::numeric(18,2) AS pending_value
         FROM sales.orders o JOIN sales.order_items i ON i.order_id = o.id JOIN registry.parties c ON c.id = o.party_id LEFT JOIN registry.parties sp ON sp.id = o.salesperson_id
        WHERE ($1::uuid IS NULL OR o.company_id = $1) AND o.status IN ('open','pending_approval','approved','separating','partially_invoiced')
          AND ($2::uuid[] IS NULL OR o.establishment_id = ANY($2)) AND ($3::uuid IS NULL OR o.salesperson_id = $3)
        GROUP BY o.id, c.legal_name, sp.legal_name ORDER BY o.created_at`,
      [ctx.companyId, ests(ctx, p.establishmentId), ctx.ownPortfolioOnly ? ctx.partyId : null]),
  },
  {
    code: 'vendas.abc_clientes', area: 'vendas', title: 'Curva ABC de clientes', permission: 'vendas.pedido.ler', description: 'Clientes por faturamento acumulado (A até 80%, B até 95%)',
    params: period,
    columns: [{ key: 'customer', label: 'Cliente' }, { key: 'revenue', label: 'Faturamento', type: 'money' }, { key: 'cumulative_percent', label: '% acumulado', type: 'percent' }, { key: 'class', label: 'Classe' }],
    run: async (tx, p, ctx) => abcClasses(await tx.query(
      `SELECT coalesce(c.legal_name, 'Consumidor final') AS customer, sum(s.revenue)::numeric(18,2) AS revenue FROM (${SALES_ITEMS}) s LEFT JOIN registry.parties c ON c.id = s.party_id
        GROUP BY 1 ORDER BY 2 DESC`, [ctx.companyId, p.from, p.to, ests(ctx, p.establishmentId), ctx.ownPortfolioOnly ? ctx.partyId : null]), 'revenue'),
  },
  {
    code: 'vendas.comissoes', area: 'vendas', title: 'Comissões', permission: 'vendas.comissao.ler', description: 'Comissões por vendedor e situação (liberada, pendente, estornada)',
    params: z.object({ from: isoDate, to: isoDate }),
    columns: [{ key: 'salesperson', label: 'Vendedor' }, { key: 'basis', label: 'Base' }, { key: 'status', label: 'Situação' }, { key: 'base_amount', label: 'Base de cálculo', type: 'money' },
      { key: 'amount', label: 'Comissão', type: 'money' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT sp.legal_name AS salesperson, c.basis, c.status, sum(c.base_amount) AS base_amount, sum(c.amount) AS amount
         FROM sales.commissions c JOIN registry.parties sp ON sp.id = c.salesperson_id
        WHERE ($1::uuid IS NULL OR c.company_id = $1) AND c.created_at::date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR c.salesperson_id = $4)
        GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [ctx.companyId, p.from, p.to, ctx.ownPortfolioOnly ? ctx.partyId : null]),
  },
  // ------------------------------------------------------------------ compras
  {
    code: 'compras.por_fornecedor', area: 'compras', title: 'Compras por fornecedor e produto', permission: 'compras.pedido.ler', description: 'Notas de compra recebidas no período',
    params: period.extend({ groupBy: z.enum(['supplier', 'product']).default('supplier') }),
    columns: (p) => [{ key: 'group', label: p.groupBy === 'product' ? 'Produto' : 'Fornecedor' }, { key: 'invoices', label: 'Notas', type: 'number' },
      { key: 'quantity', label: 'Quantidade (estoque)', type: 'number' }, { key: 'payable', label: 'Valor da nota', type: 'money' }, { key: 'entry_cost', label: 'Custo de entrada', type: 'money' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT ${p.groupBy === 'product' ? `p.sku || ' — ' || p.description` : 's.legal_name'} AS "group", count(DISTINCT r.id)::int AS invoices, sum(ri.stock_quantity) AS quantity,
              sum(ri.payable_amount) AS payable, sum(ri.entry_total_cost) AS entry_cost
         FROM purchasing.receipts r JOIN purchasing.receipt_items ri ON ri.receipt_id = r.id JOIN registry.parties s ON s.id = r.supplier_id LEFT JOIN catalog.products p ON p.id = ri.product_id
        WHERE ($1::uuid IS NULL OR r.company_id = $1) AND r.status = 'completed' AND r.completed_at::date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR r.establishment_id = ANY($4))
        GROUP BY 1 ORDER BY payable DESC`, [ctx.companyId, p.from, p.to, ests(ctx, p.establishmentId)]),
  },
  {
    code: 'compras.evolucao_preco', area: 'compras', title: 'Evolução do preço de compra', permission: 'compras.pedido.ler', description: 'Preço e custo de entrada por recebimento de um produto',
    params: z.object({ productId: z.string().uuid(), from: isoDate.optional(), to: isoDate.optional() }),
    columns: [{ key: 'date', label: 'Data', type: 'date' }, { key: 'supplier', label: 'Fornecedor' }, { key: 'invoice', label: 'NF' }, { key: 'unit_price', label: 'Preço unitário', type: 'money' },
      { key: 'entry_unit_cost', label: 'Custo de entrada unitário', type: 'money' }, { key: 'variation_percent', label: 'Variação %', type: 'percent' }],
    run: async (tx, p, ctx) => {
      const rows = await tx.query<Row & { unit_price: string }>(
        `SELECT r.issue_date AS date, s.legal_name AS supplier, r.number AS invoice, round(ri.supplier_unit_price / ri.factor, 4) AS unit_price, round(ri.entry_unit_cost, 4) AS entry_unit_cost
           FROM purchasing.receipt_items ri JOIN purchasing.receipts r ON r.id = ri.receipt_id JOIN registry.parties s ON s.id = r.supplier_id
          WHERE ri.product_id = $1 AND r.status = 'completed' AND ($2::uuid IS NULL OR r.company_id = $2) AND ($3::date IS NULL OR r.issue_date >= $3) AND ($4::date IS NULL OR r.issue_date <= $4)
          ORDER BY r.issue_date, r.completed_at`, [p.productId, ctx.companyId, p.from ?? null, p.to ?? null]);
      return rows.map((r, i) => ({ ...r, variation_percent: i === 0 ? '0.00' : D(r.unit_price).minus(rows[i - 1]!.unit_price).dividedBy(rows[i - 1]!.unit_price).times(100).toFixed(2) }));
    },
  },
  {
    code: 'compras.pedidos_atrasados', area: 'compras', title: 'Pedidos de compra atrasados', permission: 'compras.pedido.ler', description: 'Pedidos aprovados com entrega prevista vencida e saldo a receber',
    params: z.object({ establishmentId: z.string().uuid().optional() }),
    columns: [{ key: 'number', label: 'Pedido' }, { key: 'supplier', label: 'Fornecedor' }, { key: 'expected_date', label: 'Previsão', type: 'date' }, { key: 'days_late', label: 'Dias de atraso', type: 'number' },
      { key: 'pending_value', label: 'Saldo a receber', type: 'money' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT o.number, s.legal_name AS supplier, o.expected_date, (current_date - o.expected_date) AS days_late,
              sum((i.quantity - i.quantity_received - i.quantity_cancelled) * i.unit_price)::numeric(18,2) AS pending_value
         FROM purchasing.orders o JOIN purchasing.order_items i ON i.order_id = o.id JOIN registry.parties s ON s.id = o.supplier_id
        WHERE ($1::uuid IS NULL OR o.company_id = $1) AND o.status IN ('approved','partially_received') AND o.expected_date < current_date AND ($2::uuid[] IS NULL OR o.establishment_id = ANY($2))
        GROUP BY o.id, s.legal_name ORDER BY days_late DESC`, [ctx.companyId, ests(ctx, p.establishmentId)]),
  },
  {
    code: 'compras.prazo_entrega', area: 'compras', title: 'Prazo médio de entrega por fornecedor', permission: 'compras.pedido.ler', description: 'Dias entre o pedido e a conclusão do recebimento',
    params: z.object({ from: isoDate, to: isoDate }),
    columns: [{ key: 'supplier', label: 'Fornecedor' }, { key: 'receipts', label: 'Recebimentos', type: 'number' }, { key: 'average_days', label: 'Prazo médio (dias)', type: 'number' },
      { key: 'late_receipts', label: 'Entregas após a previsão', type: 'number' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT s.legal_name AS supplier, count(*)::int AS receipts, round(avg(r.completed_at::date - o.created_at::date), 1) AS average_days,
              count(*) FILTER (WHERE o.expected_date IS NOT NULL AND r.completed_at::date > o.expected_date)::int AS late_receipts
         FROM purchasing.receipts r JOIN purchasing.orders o ON o.id = r.order_id JOIN registry.parties s ON s.id = r.supplier_id
        WHERE ($1::uuid IS NULL OR r.company_id = $1) AND r.status = 'completed' AND r.completed_at::date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY average_days DESC`,
      [ctx.companyId, p.from, p.to]),
  },
  {
    code: 'compras.fora_do_processo', area: 'compras', title: 'Compras fora do processo', permission: 'compras.pedido.ler', description: 'Notas aceitas sem pedido de compra (RN-COM-06)',
    params: z.object({ from: isoDate, to: isoDate }),
    columns: [{ key: 'number', label: 'NF' }, { key: 'issue_date', label: 'Emissão', type: 'date' }, { key: 'supplier', label: 'Fornecedor' }, { key: 'total_invoice', label: 'Valor', type: 'money' },
      { key: 'accepted_by', label: 'Aceita por' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT r.number, r.issue_date, s.legal_name AS supplier, r.total_invoice, u.name AS accepted_by FROM purchasing.receipts r JOIN registry.parties s ON s.id = r.supplier_id
         LEFT JOIN core.users u ON u.id = r.completed_by
        WHERE ($1::uuid IS NULL OR r.company_id = $1) AND r.status = 'completed' AND r.order_id IS NULL AND r.completed_at::date BETWEEN $2 AND $3 ORDER BY r.completed_at`,
      [ctx.companyId, p.from, p.to]),
  },
  // ------------------------------------------------------------------ estoque
  {
    code: 'estoque.posicao', area: 'estoque', title: 'Posição de estoque por depósito', permission: 'estoque.saldo.ler', description: 'Físico, reservado, disponível, custo médio e valor',
    params: z.object({ warehouseId: z.string().uuid().optional() }),
    columns: [{ key: 'warehouse', label: 'Depósito' }, { key: 'sku', label: 'SKU' }, { key: 'description', label: 'Descrição' }, { key: 'quantity', label: 'Físico', type: 'number' },
      { key: 'reserved', label: 'Reservado', type: 'number' }, { key: 'available', label: 'Disponível', type: 'number' }, { key: 'avg_cost', label: 'Custo médio', type: 'money' },
      { key: 'value', label: 'Valor', type: 'money' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT w.code AS warehouse, p.sku, p.description, sum(b.quantity) AS quantity, sum(b.reserved) AS reserved, sum(b.quantity - b.reserved - b.blocked) AS available,
              round(pc.avg_cost, 4) AS avg_cost, round(sum(b.quantity) * coalesce(pc.avg_cost, 0), 2) AS value
         FROM inventory.stock_balances b JOIN core.warehouses w ON w.id = b.warehouse_id JOIN catalog.products p ON p.id = b.product_id
         LEFT JOIN inventory.product_costs pc ON pc.product_id = b.product_id AND pc.establishment_id = b.establishment_id
        WHERE ($1::uuid IS NULL OR b.company_id = $1) AND ($2::uuid IS NULL OR b.warehouse_id = $2) AND ($3::uuid[] IS NULL OR b.warehouse_id = ANY($3))
          AND ($4::uuid[] IS NULL OR b.establishment_id = ANY($4))
        GROUP BY w.code, p.sku, p.description, pc.avg_cost HAVING sum(b.quantity) <> 0 ORDER BY w.code, p.sku`,
      [ctx.companyId, p.warehouseId ?? null, ctx.warehouseIds, ctx.establishmentIds]),
  },
  {
    code: 'estoque.giro', area: 'estoque', title: 'Giro e cobertura de estoque', permission: 'estoque.saldo.ler', description: 'Saídas no período, giro (saídas ÷ saldo) e cobertura em dias',
    params: z.object({ days: z.coerce.number().int().min(7).max(365).default(90), establishmentId: z.string().uuid().optional() }),
    columns: [{ key: 'sku', label: 'SKU' }, { key: 'description', label: 'Descrição' }, { key: 'quantity', label: 'Saldo', type: 'number' }, { key: 'out_quantity', label: 'Saídas', type: 'number' },
      { key: 'turnover', label: 'Giro', type: 'number' }, { key: 'coverage_days', label: 'Cobertura (dias)', type: 'number' }],
    run: async (tx, p, ctx) => (await tx.query(
      `SELECT p.sku, p.description, coalesce(pc.quantity, 0) AS quantity,
              coalesce((SELECT sum(m.quantity) FROM inventory.stock_movements m WHERE m.product_id = p.id AND m.establishment_id = pc.establishment_id
                         AND m.movement_type IN ('sale_out','production_consume','internal_use') AND m.occurred_at >= now() - make_interval(days => $2)), 0) AS out_quantity
         FROM inventory.product_costs pc JOIN catalog.products p ON p.id = pc.product_id
        WHERE ($1::uuid IS NULL OR pc.company_id = $1) AND ($3::uuid[] IS NULL OR pc.establishment_id = ANY($3)) ORDER BY p.sku`,
      [ctx.companyId, p.days, ests(ctx, p.establishmentId)])).map((r: any) => ({
      ...r, turnover: D(r.quantity).lessThanOrEqualTo(0) ? null : D(r.out_quantity).dividedBy(r.quantity).toFixed(2),
      coverage_days: D(r.out_quantity).isZero() ? null : D(r.quantity).dividedBy(D(r.out_quantity).dividedBy(p.days)).toFixed(0),
    })),
  },
  {
    code: 'estoque.abc', area: 'estoque', title: 'Curva ABC de produtos', permission: 'estoque.saldo.ler', description: 'Produtos pelo custo das saídas (A até 80%, B até 95%)',
    params: z.object({ establishmentId: z.string().uuid(), days: z.coerce.number().int().min(7).max(365).default(90) }),
    columns: [{ key: 'sku', label: 'SKU' }, { key: 'description', label: 'Descrição' }, { key: 'value', label: 'Custo das saídas', type: 'money' }, { key: 'cumulativePercent', label: '% acumulado', type: 'percent' },
      { key: 'class', label: 'Classe' }],
    run: async (tx, p, ctx) => {
      if (ests(ctx, p.establishmentId)?.length === 0) return [];
      const rows = await abcCurve(tx, p.establishmentId, p.days);
      const prods = new Map((await tx.query<{ id: string; sku: string; description: string }>(`SELECT id, sku, description FROM catalog.products WHERE id = ANY($1)`, [rows.map((r) => r.productId)])).map((x) => [x.id, x]));
      return rows.map((r) => ({ sku: prods.get(r.productId)?.sku, description: prods.get(r.productId)?.description, value: r.value, cumulativePercent: r.cumulativePercent, class: r.class }));
    },
  },
  {
    code: 'estoque.parados', area: 'estoque', title: 'Estoque parado', permission: 'estoque.saldo.ler', description: 'Produtos com saldo e sem saída há N dias, com o valor imobilizado',
    params: z.object({ days: z.coerce.number().int().min(15).max(730).default(90), establishmentId: z.string().uuid().optional() }),
    columns: [{ key: 'sku', label: 'SKU' }, { key: 'description', label: 'Descrição' }, { key: 'quantity', label: 'Saldo', type: 'number' }, { key: 'value', label: 'Valor parado', type: 'money' },
      { key: 'last_out', label: 'Última saída', type: 'date' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT p.sku, p.description, pc.quantity, round(pc.quantity * pc.avg_cost, 2) AS value,
              (SELECT max(m.occurred_at)::date FROM inventory.stock_movements m WHERE m.product_id = p.id AND m.establishment_id = pc.establishment_id AND m.sign = -1) AS last_out
         FROM inventory.product_costs pc JOIN catalog.products p ON p.id = pc.product_id
        WHERE ($1::uuid IS NULL OR pc.company_id = $1) AND pc.quantity > 0 AND ($3::uuid[] IS NULL OR pc.establishment_id = ANY($3))
          AND NOT EXISTS (SELECT 1 FROM inventory.stock_movements m WHERE m.product_id = p.id AND m.establishment_id = pc.establishment_id AND m.sign = -1
                           AND m.occurred_at >= now() - make_interval(days => $2))
        ORDER BY value DESC`, [ctx.companyId, p.days, ests(ctx, p.establishmentId)]),
  },
  {
    code: 'estoque.validade', area: 'estoque', title: 'Validade a vencer', permission: 'estoque.saldo.ler', description: 'Lotes com saldo que vencem nos próximos N dias (ou já vencidos)',
    params: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    columns: [{ key: 'sku', label: 'SKU' }, { key: 'description', label: 'Descrição' }, { key: 'lot_number', label: 'Lote' }, { key: 'expires_at', label: 'Validade', type: 'date' },
      { key: 'days_left', label: 'Dias restantes', type: 'number' }, { key: 'quantity', label: 'Saldo', type: 'number' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT p.sku, p.description, l.lot_number, l.expires_at, (l.expires_at - current_date) AS days_left, sum(b.quantity) AS quantity
         FROM inventory.lots l JOIN catalog.products p ON p.id = l.product_id JOIN inventory.stock_balances b ON b.lot_id = l.id
        WHERE l.expires_at <= current_date + $1::int AND ($2::uuid IS NULL OR b.company_id = $2) AND ($3::uuid[] IS NULL OR b.establishment_id = ANY($3))
        GROUP BY p.sku, p.description, l.lot_number, l.expires_at HAVING sum(b.quantity) > 0 ORDER BY l.expires_at`, [p.days, ctx.companyId, ctx.establishmentIds]),
  },
  {
    code: 'estoque.perdas', area: 'estoque', title: 'Perdas e ajustes de inventário', permission: 'estoque.saldo.ler', description: 'Perdas, avarias, uso interno e faltas de inventário no período',
    params: period,
    columns: [{ key: 'type', label: 'Tipo' }, { key: 'sku', label: 'SKU' }, { key: 'description', label: 'Descrição' }, { key: 'quantity', label: 'Quantidade', type: 'number' }, { key: 'value', label: 'Valor', type: 'money' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT CASE m.movement_type WHEN 'loss' THEN 'Perda' WHEN 'damage' THEN 'Avaria' WHEN 'internal_use' THEN 'Uso interno' ELSE 'Falta de inventário' END AS type,
              p.sku, p.description, sum(m.quantity) AS quantity, sum(m.total_cost) AS value
         FROM inventory.stock_movements m JOIN catalog.products p ON p.id = m.product_id
        WHERE ($1::uuid IS NULL OR m.company_id = $1) AND m.movement_type IN ('loss','damage','internal_use','inventory_adjust_out') AND m.occurred_at::date BETWEEN $2 AND $3
          AND ($4::uuid[] IS NULL OR m.establishment_id = ANY($4)) AND m.reversal_of IS NULL
        GROUP BY 1, 2, 3 ORDER BY value DESC`, [ctx.companyId, p.from, p.to, ests(ctx, p.establishmentId)]),
  },
  {
    code: 'estoque.kardex', area: 'estoque', title: 'Kardex', permission: 'estoque.saldo.ler', heavy: false, description: 'Movimentos de um produto com saldo e custo médio após cada movimento',
    params: z.object({ productId: z.string().uuid(), from: isoDate, to: isoDate, establishmentId: z.string().uuid().optional() }),
    columns: [{ key: 'occurred_at', label: 'Data', type: 'date' }, { key: 'warehouse', label: 'Depósito' }, { key: 'movement_type', label: 'Tipo' }, { key: 'quantity', label: 'Quantidade', type: 'number' },
      { key: 'unit_cost', label: 'Custo unitário', type: 'money' }, { key: 'total_cost', label: 'Custo total', type: 'money' }, { key: 'balance', label: 'Saldo', type: 'number' },
      { key: 'avg_cost_after', label: 'Custo médio após', type: 'money' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT * FROM (SELECT m.occurred_at, w.code AS warehouse, m.movement_type, m.sign * m.quantity AS quantity, round(m.unit_cost, 4) AS unit_cost, m.total_cost,
              sum(m.sign * m.quantity) OVER (PARTITION BY m.establishment_id ORDER BY m.occurred_at, m.created_at) AS balance, round(m.avg_cost_after, 4) AS avg_cost_after
         FROM inventory.stock_movements m JOIN core.warehouses w ON w.id = m.warehouse_id
        WHERE m.product_id = $1 AND ($2::uuid IS NULL OR m.company_id = $2) AND ($5::uuid[] IS NULL OR m.establishment_id = ANY($5))) k
        WHERE k.occurred_at::date BETWEEN $3 AND $4 ORDER BY k.occurred_at`, [p.productId, ctx.companyId, p.from, p.to, ests(ctx, p.establishmentId)]),
  },
  {
    code: 'estoque.cmv_teorico_real', area: 'estoque', title: 'CMV teórico × real', permission: 'estoque.saldo.ler',
    description: 'Quanto deveria ter sido consumido pela ficha técnica (vendas e ordens) contra o que saiu do estoque, por insumo',
    params: z.object({ establishmentId: z.string().uuid(), from: isoDate, to: isoDate }),
    columns: [{ key: 'sku', label: 'SKU' }, { key: 'description', label: 'Insumo' }, { key: 'theoretical', label: 'Teórico', type: 'number' }, { key: 'real', label: 'Real', type: 'number' },
      { key: 'losses', label: 'Perdas', type: 'number' }, { key: 'inventoryAdjust', label: 'Ajuste de inventário', type: 'number' }, { key: 'difference', label: 'Diferença', type: 'number' },
      { key: 'differenceValue', label: 'Diferença (R$)', type: 'money' }, { key: 'differencePercent', label: 'Diferença %', type: 'percent' }],
    run: async (tx, p, ctx) => (ests(ctx, p.establishmentId)?.length === 0 ? [] : (await theoreticalVsReal(tx, p)).rows),
  },
  // ------------------------------------------------------------------ financeiro
  {
    code: 'financeiro.titulos', area: 'financeiro', title: 'Contas a receber e a pagar por vencimento', permission: 'financeiro.titulo.ler', description: 'Títulos em aberto por data de vencimento',
    params: z.object({ kind: z.enum(['receivable', 'payable']), from: isoDate, to: isoDate }),
    columns: [{ key: 'due_date', label: 'Vencimento', type: 'date' }, { key: 'document_number', label: 'Documento' }, { key: 'installment', label: 'Parcela', type: 'number' },
      { key: 'party', label: 'Pessoa' }, { key: 'amount', label: 'Valor', type: 'money' }, { key: 'balance', label: 'Saldo', type: 'money' }, { key: 'status', label: 'Situação' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT t.due_date, t.document_number, t.installment, p.legal_name AS party, t.amount, t.balance, t.status FROM finance.titles t JOIN registry.parties p ON p.id = t.party_id
        WHERE ($1::uuid IS NULL OR t.company_id = $1) AND t.kind = $2 AND t.status IN ('open','partially_paid') AND t.due_date BETWEEN $3 AND $4
          AND ($5::uuid[] IS NULL OR t.establishment_id IS NULL OR t.establishment_id = ANY($5)) ORDER BY t.due_date, p.legal_name`,
      [ctx.companyId, p.kind, p.from, p.to, ctx.establishmentIds]),
  },
  {
    code: 'financeiro.aging', area: 'financeiro', title: 'Aging de inadimplência', permission: 'financeiro.relatorio.ler', description: 'A vencer, 1–30, 31–60, 61–90 e mais de 90 dias',
    params: z.object({ kind: z.enum(['receivable', 'payable']).default('receivable') }),
    columns: [{ key: 'bucket', label: 'Faixa' }, { key: 'value', label: 'Saldo', type: 'money' }, { key: 'percent', label: '% do total', type: 'percent' }],
    run: async (tx, p, ctx) => {
      const a = await aging(tx, ctx.companyId, p.kind);
      const labels: [string, string][] = [['a_vencer', 'A vencer'], ['d1_30', '1–30 dias'], ['d31_60', '31–60 dias'], ['d61_90', '61–90 dias'], ['d90_mais', 'Mais de 90 dias']];
      return labels.map(([k, l]) => ({ bucket: l, value: D(a[k] ?? 0).toFixed(2), percent: pct(a[k], a.total) }));
    },
  },
  {
    code: 'financeiro.fluxo_caixa', area: 'financeiro', title: 'Fluxo de caixa', permission: 'financeiro.relatorio.ler', description: 'Realizado e projetado por dia, semana ou mês',
    params: z.object({ from: isoDate, to: isoDate, granularity: z.enum(['day', 'week', 'month']).default('day') }),
    columns: [{ key: 'period', label: 'Período' }, { key: 'realized_in', label: 'Entradas realizadas', type: 'money' }, { key: 'realized_out', label: 'Saídas realizadas', type: 'money' },
      { key: 'projected_in', label: 'Entradas previstas', type: 'money' }, { key: 'projected_out', label: 'Saídas previstas', type: 'money' }, { key: 'balance', label: 'Saldo acumulado', type: 'money' }],
    run: async (tx, p, ctx) => {
      const cf = await cashFlow(tx, ctx.companyId, p.from, p.to, p.granularity);
      return [{ period: 'Saldo inicial', realized_in: null, realized_out: null, projected_in: null, projected_out: null, balance: cf.openingBalance },
        ...cf.rows.map((r) => ({ period: r.period, realized_in: r.realizedIn, realized_out: r.realizedOut, projected_in: r.projectedIn, projected_out: r.projectedOut, balance: r.balance }))];
    },
  },
  {
    code: 'financeiro.dre', area: 'financeiro', title: 'DRE gerencial', permission: 'financeiro.relatorio.ler', description: 'Por competência ou caixa',
    params: z.object({ from: isoDate, to: isoDate, basis: z.enum(['competence', 'cash']).default('competence'), establishmentId: z.string().uuid().optional() }),
    columns: [{ key: 'line', label: 'Linha' }, { key: 'value', label: 'Valor', type: 'money' }, { key: 'margin_percent', label: 'Margem %', type: 'percent' }],
    run: async (tx, p, ctx) => {
      const dre = await managementDre(tx, { companyId: ctx.companyId, from: p.from, to: p.to, basis: p.basis, establishmentId: p.establishmentId ?? null });
      return dre.lines.map((l: { label: string; value: string; marginPercent?: string | null }) => ({ line: l.label, value: l.value, margin_percent: l.marginPercent ?? null }));
    },
  },
  {
    code: 'financeiro.extrato', area: 'financeiro', title: 'Extrato por conta', permission: 'financeiro.conta.ler', description: 'Movimentos da conta com saldo acumulado',
    params: z.object({ accountId: z.string().uuid(), from: isoDate, to: isoDate }),
    columns: [{ key: 'movement_date', label: 'Data', type: 'date' }, { key: 'description', label: 'Histórico' }, { key: 'credit', label: 'Entrada', type: 'money' }, { key: 'debit', label: 'Saída', type: 'money' },
      { key: 'balance', label: 'Saldo', type: 'money' }, { key: 'reconciled', label: 'Conciliado' }],
    run: async (tx, p) => {
      const acc = await tx.one<{ initial_balance: string; initial_balance_date: string }>(`SELECT initial_balance, initial_balance_date FROM finance.accounts WHERE id = $1`, [p.accountId], 'Conta');
      const opening = await tx.one<{ v: string | null }>(
        `SELECT sum(CASE WHEN direction = 'C' THEN amount ELSE -amount END) AS v FROM finance.account_movements WHERE account_id = $1 AND movement_date >= $2 AND movement_date < $3`,
        [p.accountId, acc.initial_balance_date, p.from]);
      let bal = D(acc.initial_balance).plus(opening.v ?? 0);
      const rows = await tx.query<{ movement_date: string; description: string; direction: string; amount: string; reconciled: boolean }>(
        `SELECT movement_date, description, direction, amount, reconciled FROM finance.account_movements WHERE account_id = $1 AND movement_date BETWEEN $2 AND $3 ORDER BY movement_date, created_at`,
        [p.accountId, p.from, p.to]);
      return [{ movement_date: p.from, description: 'Saldo anterior', credit: null, debit: null, balance: bal.toFixed(2), reconciled: '' },
        ...rows.map((r) => {
          bal = r.direction === 'C' ? bal.plus(r.amount) : bal.minus(r.amount);
          return { movement_date: r.movement_date, description: r.description, credit: r.direction === 'C' ? r.amount : null, debit: r.direction === 'D' ? r.amount : null,
            balance: bal.toFixed(2), reconciled: r.reconciled ? 'sim' : 'não' };
        })];
    },
  },
  {
    code: 'financeiro.recebiveis_cartao', area: 'financeiro', title: 'Recebíveis de cartão', permission: 'financeiro.titulo.ler', description: 'Bruto, taxa e líquido a receber das adquirentes',
    params: z.object({}),
    columns: [{ key: 'due_date', label: 'Previsão', type: 'date' }, { key: 'document_number', label: 'Documento' }, { key: 'gross_amount', label: 'Bruto', type: 'money' },
      { key: 'fee_amount', label: 'Taxa', type: 'money' }, { key: 'balance', label: 'Líquido a receber', type: 'money' }],
    run: (tx, _p, ctx) => tx.query(
      `SELECT due_date, document_number, gross_amount, fee_amount, balance FROM finance.titles
        WHERE ($1::uuid IS NULL OR company_id = $1) AND kind = 'receivable' AND gross_amount IS NOT NULL AND status IN ('open','partially_paid') ORDER BY due_date`, [ctx.companyId]),
  },
  // ------------------------------------------------------------------ fiscal
  {
    code: 'fiscal.livro', area: 'fiscal', title: 'Livro de entradas e saídas', permission: 'fiscal.nota.ler', description: 'Documentos escriturados no período com bases e impostos',
    params: period.extend({ direction: z.enum(['E', 'S']) }),
    columns: [{ key: 'date', label: 'Data', type: 'date' }, { key: 'model', label: 'Modelo' }, { key: 'series', label: 'Série' }, { key: 'number', label: 'Número' }, { key: 'party', label: 'Participante' },
      { key: 'cfops', label: 'CFOP' }, { key: 'status', label: 'Situação' }, { key: 'total_invoice', label: 'Valor contábil', type: 'money' }, { key: 'icms_base', label: 'Base ICMS', type: 'money' },
      { key: 'total_icms', label: 'ICMS', type: 'money' }, { key: 'total_st', label: 'ICMS-ST', type: 'money' }, { key: 'total_ipi', label: 'IPI', type: 'money' },
      { key: 'total_ibs', label: 'IBS', type: 'money' }, { key: 'total_cbs', label: 'CBS', type: 'money' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT d.tax_date AS date, d.model, d.series, d.number, coalesce(d.recipient_name, d.issuer_name) AS party,
              (SELECT string_agg(DISTINCT i.cfop, ',') FROM fiscal.document_items i WHERE i.document_id = d.id) AS cfops, d.status, d.total_invoice,
              coalesce((d.totals->>'icmsBase')::numeric, 0) AS icms_base, d.total_icms, d.total_st, d.total_ipi, d.total_ibs, d.total_cbs
         FROM fiscal.documents d
        WHERE ($1::uuid IS NULL OR d.company_id = $1) AND d.direction = $2 AND d.tax_date BETWEEN $3 AND $4 AND ($5::uuid[] IS NULL OR d.establishment_id = ANY($5))
          AND d.status IN ('autorizada','cancelada','denegada') ORDER BY d.tax_date, d.model, d.series, d.number`,
      [ctx.companyId, p.direction, p.from, p.to, ests(ctx, p.establishmentId)]),
  },
  {
    code: 'fiscal.apuracao', area: 'fiscal', title: 'Apuração de tributos', permission: 'fiscal.nota.ler', description: 'Débitos das saídas × créditos das entradas por tributo (ICMS, IPI, PIS, Cofins, IBS, CBS)',
    params: period,
    columns: [{ key: 'tax', label: 'Tributo' }, { key: 'debits', label: 'Débitos', type: 'money' }, { key: 'credits', label: 'Créditos', type: 'money' }, { key: 'reversed', label: 'Estornos de crédito', type: 'money' },
      { key: 'balance', label: 'Saldo a recolher (credor se negativo)', type: 'money' }],
    run: async (tx, p, ctx) => {
      const e = ests(ctx, p.establishmentId);
      const debits = await tx.query<{ tax: string; v: string }>(
        `SELECT CASE WHEN t.tax IN ('IBS_UF','IBS_MUN') THEN 'IBS' WHEN t.tax IN ('ICMS','FCP','DIFAL','FCP_DEST') THEN 'ICMS' ELSE t.tax END AS tax, sum(t.value) AS v
           FROM fiscal.documents d JOIN fiscal.document_items i ON i.document_id = d.id JOIN fiscal.document_item_taxes t ON t.document_item_id = i.id
          WHERE d.direction = 'S' AND d.status = 'autorizada' AND d.issuer_kind = 'own' AND d.purpose <> 4 AND ($1::uuid IS NULL OR d.company_id = $1)
            AND d.tax_date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR d.establishment_id = ANY($4))
            AND t.tax IN ('ICMS','FCP','DIFAL','FCP_DEST','IPI','PIS','COFINS','IBS_UF','IBS_MUN','CBS') AND NOT coalesce((t.details->>'informative')::boolean, false)
          GROUP BY 1`, [ctx.companyId, p.from, p.to, e]);
      const credits = await tx.query<{ tax: string; status: string; v: string }>(
        `SELECT tax, status, sum(amount) AS v FROM fiscal.tax_credits WHERE ($1::uuid IS NULL OR company_id = $1) AND competence BETWEEN $2 AND $3
            AND ($4::uuid[] IS NULL OR establishment_id = ANY($4)) GROUP BY 1, 2`, [ctx.companyId, p.from, p.to, e]);
      return ['ICMS', 'IPI', 'PIS', 'COFINS', 'IBS', 'CBS'].map((tax) => {
        const d = D(debits.find((x) => x.tax === tax)?.v ?? 0);
        const c = sum(credits.filter((x) => x.tax === tax && x.status === 'appropriated').map((x) => x.v));
        const r = sum(credits.filter((x) => x.tax === tax && x.status === 'reversed').map((x) => x.v));
        return { tax, debits: d.toFixed(2), credits: c.toFixed(2), reversed: r.toFixed(2), balance: d.minus(c).plus(r).toFixed(2) };
      });
    },
  },
  {
    code: 'fiscal.notas_status', area: 'fiscal', title: 'Notas por situação', permission: 'fiscal.nota.ler', description: 'Quantidade e valor dos documentos emitidos por modelo e situação',
    params: period,
    columns: [{ key: 'model', label: 'Modelo' }, { key: 'status', label: 'Situação' }, { key: 'documents', label: 'Documentos', type: 'number' }, { key: 'total', label: 'Valor', type: 'money' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT model, status, count(*)::int AS documents, sum(total_invoice) AS total FROM fiscal.documents
        WHERE issuer_kind = 'own' AND ($1::uuid IS NULL OR company_id = $1) AND created_at::date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR establishment_id = ANY($4))
        GROUP BY 1, 2 ORDER BY 1, 2`, [ctx.companyId, p.from, p.to, ests(ctx, p.establishmentId)]),
  },
  {
    code: 'fiscal.rejeicoes', area: 'fiscal', title: 'Rejeições mais frequentes', permission: 'fiscal.nota.ler', description: 'Códigos de rejeição da SEFAZ com explicação, para corrigir cadastros e regras',
    params: period,
    columns: [{ key: 'sefaz_code', label: 'Código' }, { key: 'message', label: 'Mensagem da SEFAZ' }, { key: 'explanation', label: 'Explicação' }, { key: 'occurrences', label: 'Ocorrências', type: 'number' }],
    run: (tx, p, ctx) => tx.query(
      `SELECT ev.sefaz_code, max(ev.message) AS message, max(rc.explanation) AS explanation, count(*)::int AS occurrences
         FROM fiscal.document_events ev JOIN fiscal.documents d ON d.id = ev.document_id LEFT JOIN fiscal.rejection_catalog rc ON rc.code = ev.sefaz_code
        WHERE ev.kind = 'rejection' AND ($1::uuid IS NULL OR d.company_id = $1) AND ev.created_at::date BETWEEN $2 AND $3 AND ($4::uuid[] IS NULL OR d.establishment_id = ANY($4))
        GROUP BY ev.sefaz_code ORDER BY occurrences DESC`, [ctx.companyId, p.from, p.to, ests(ctx, p.establishmentId)]),
  },
  {
    code: 'fiscal.contingencia', area: 'fiscal', title: 'Notas em contingência', permission: 'fiscal.nota.ler', description: 'Documentos emitidos fora do ambiente normal e os ainda pendentes de autorização',
    params: z.object({}),
    columns: [{ key: 'model', label: 'Modelo' }, { key: 'number', label: 'Número' }, { key: 'status', label: 'Situação' }, { key: 'emission_type', label: 'tpEmis', type: 'number' },
      { key: 'contingency_at', label: 'Entrada em contingência', type: 'date' }, { key: 'contingency_reason', label: 'Motivo' }, { key: 'total_invoice', label: 'Valor', type: 'money' }],
    run: (tx, _p, ctx) => tx.query(
      `SELECT model, number, status, emission_type, contingency_at, contingency_reason, total_invoice FROM fiscal.documents
        WHERE issuer_kind = 'own' AND ($1::uuid IS NULL OR company_id = $1) AND ($2::uuid[] IS NULL OR establishment_id = ANY($2))
          AND (status = 'contingencia' OR (emission_type <> 1 AND created_at >= now() - interval '30 days')) ORDER BY contingency_at DESC NULLS LAST`,
      [ctx.companyId, ctx.establishmentIds]),
  },
  // ------------------------------------------------------------------ gestão
  {
    code: 'gestao.painel', area: 'gestao', title: 'Painel do dono', permission: 'relatorios.painel.ler', description: 'Faturamento, margem, caixa, inadimplência, estoque parado, metas e alertas',
    params: z.object({ date: isoDate.optional() }),
    columns: [{ key: 'indicator', label: 'Indicador' }, { key: 'value', label: 'Valor' }, { key: 'detail', label: 'Detalhe' }],
    run: async (tx, p, ctx) => {
      const d = await ownerDashboard(tx, ctx, p.date);
      return [
        { indicator: 'Faturamento do mês', value: d.revenue.month, detail: `Mês anterior: ${d.revenue.previousMonth} (${d.revenue.variationPercent}%)` },
        { indicator: 'Margem bruta do mês', value: d.margin.value, detail: `${d.margin.percent}%` },
        { indicator: 'Caixa disponível', value: d.cash.available, detail: `${d.cash.accounts.length} contas` },
        { indicator: 'Inadimplência', value: d.delinquency.overdue, detail: `${d.delinquency.percent}% da carteira` },
        { indicator: 'Estoque parado (90 dias)', value: d.idleStock.value, detail: `${d.idleStock.products} produtos` },
        ...d.targets.map((t) => ({ indicator: `Meta ${t.name}`, value: t.achieved, detail: `${t.percent}% de ${t.target}` })),
        ...d.alerts.map((a) => ({ indicator: `Alerta: ${a.title}`, value: String(a.count), detail: a.severity })),
      ];
    },
  },
];

export const REPORT_BY_CODE = new Map(REPORTS.map((r) => [r.code, r]));
export function columnsOf(def: ReportDef, params: unknown): Column[] {
  return typeof def.columns === 'function' ? def.columns(params) : def.columns;
}
