import { z } from 'zod';
import { route, type App } from '../../http/app.js';
import { has } from '../../core/access.js';

export interface SearchHit {
  type: 'product' | 'party' | 'sales_order' | 'title' | 'fiscal_document' | 'purchase_order';
  id: string;
  title: string;
  subtitle: string | null;
}

/**
 * Busca global (seção 24, usabilidade): procura em cadastros e documentos só o que o usuário pode
 * ver. Documento de pessoa aparece mascarado (LGPD); números exatos têm prioridade.
 */
export function registerSearchRoutes(app: App) {
  route(app, {
    method: 'GET', url: '/v1/search', summary: 'Busca global (produtos, pessoas, pedidos, títulos e notas)', tags: ['Busca'], permission: null,
    query: z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(20).default(5) }),
  }, async ({ tx, ctx, query }) => {
    const q = query.q;
    const like = `%${q.toLowerCase()}%`;
    const digits = q.replace(/\D/g, '');
    const num = /^\d{1,12}$/.test(q) ? q : null;
    const hits: SearchHit[] = [];
    const n = query.limit;
    if (has(ctx, 'produtos.produto.ler')) {
      for (const r of await tx.query<{ id: string; sku: string; description: string; gtin: string | null }>(
        `SELECT id, sku, description, gtin FROM catalog.products WHERE status = 'active' AND (lower(sku) LIKE $1 OR lower(description) LIKE $1 OR gtin = $2)
          ORDER BY (lower(sku) = lower($3)) DESC, sku LIMIT $4`, [like, digits || null, q, n])) {
        hits.push({ type: 'product', id: r.id, title: `${r.sku} — ${r.description}`, subtitle: r.gtin });
      }
    }
    if (has(ctx, 'cadastros.pessoa.ler')) {
      for (const r of await tx.query<{ id: string; legal_name: string; trade_name: string | null; tax_id: string | null }>(
        `SELECT id, legal_name, trade_name, tax_id FROM registry.parties WHERE status <> 'inactive' AND anonymized_at IS NULL
            AND (lower(legal_name) LIKE $1 OR lower(coalesce(trade_name, '')) LIKE $1 OR ($2::text <> '' AND tax_id LIKE $2 || '%'))
          ORDER BY legal_name LIMIT $3`, [like, digits.length >= 4 ? digits : '', n])) {
        const doc = r.tax_id ? `${r.tax_id.length === 11 ? 'CPF' : 'CNPJ'} ${r.tax_id.slice(0, 3)}***${r.tax_id.slice(-2)}` : null;
        hits.push({ type: 'party', id: r.id, title: r.trade_name ? `${r.legal_name} (${r.trade_name})` : r.legal_name, subtitle: doc });
      }
    }
    if (num && has(ctx, 'vendas.pedido.ler')) {
      for (const r of await tx.query<{ id: string; number: string; party: string; status: string; total: string }>(
        `SELECT o.id, o.number::text, p.legal_name AS party, o.status, o.total FROM sales.orders o JOIN registry.parties p ON p.id = o.party_id
          WHERE ($1::uuid IS NULL OR o.company_id = $1) AND o.number::text = $2 AND ($3::uuid IS NULL OR o.salesperson_id = $3) LIMIT $4`,
        [ctx.companyId, num, ctx.ownPortfolioOnly ? ctx.partyId : null, n])) {
        hits.push({ type: 'sales_order', id: r.id, title: `Pedido ${r.number} — ${r.party}`, subtitle: `${r.status} · R$ ${r.total}` });
      }
    }
    if (num && has(ctx, 'compras.pedido.ler')) {
      for (const r of await tx.query<{ id: string; number: string; party: string; status: string }>(
        `SELECT o.id, o.number::text, p.legal_name AS party, o.status FROM purchasing.orders o JOIN registry.parties p ON p.id = o.supplier_id
          WHERE ($1::uuid IS NULL OR o.company_id = $1) AND o.number::text = $2 LIMIT $3`, [ctx.companyId, num, n])) {
        hits.push({ type: 'purchase_order', id: r.id, title: `Pedido de compra ${r.number} — ${r.party}`, subtitle: r.status });
      }
    }
    if (has(ctx, 'financeiro.titulo.ler')) {
      for (const r of await tx.query<{ id: string; document_number: string; installment: number; kind: string; party: string; balance: string; due_date: string }>(
        `SELECT t.id, t.document_number, t.installment, t.kind, p.legal_name AS party, t.balance, t.due_date::text FROM finance.titles t JOIN registry.parties p ON p.id = t.party_id
          WHERE ($1::uuid IS NULL OR t.company_id = $1) AND lower(t.document_number) LIKE $2 ORDER BY t.due_date LIMIT $3`, [ctx.companyId, like, n])) {
        hits.push({ type: 'title', id: r.id, title: `${r.kind === 'receivable' ? 'A receber' : 'A pagar'} ${r.document_number}/${r.installment} — ${r.party}`,
          subtitle: `Saldo R$ ${r.balance} · vence ${r.due_date.split('-').reverse().join('/')}` });
      }
    }
    if ((num || digits.length === 44) && has(ctx, 'fiscal.nota.ler')) {
      for (const r of await tx.query<{ id: string; model: string; series: number; number: number; status: string; recipient_name: string | null }>(
        `SELECT id, model, series, number, status, recipient_name FROM fiscal.documents
          WHERE ($1::uuid IS NULL OR company_id = $1) AND issuer_kind = 'own' AND (number::text = $2 OR access_key = $3) ORDER BY created_at DESC LIMIT $4`,
        [ctx.companyId, num, digits.length === 44 ? digits : null, n])) {
        hits.push({ type: 'fiscal_document', id: r.id, title: `${r.model === '65' ? 'NFC-e' : r.model === '99' ? 'NFS-e' : 'NF-e'} ${r.series}/${r.number}${r.recipient_name ? ` — ${r.recipient_name}` : ''}`,
          subtitle: r.status });
      }
    }
    return { q, hits };
  });
}
