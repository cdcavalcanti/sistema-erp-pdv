import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { Dialog, ErrorBox, Input, Kpi, PageHeader, useDebounced } from '../../components/ui';
import { brl, date, doc, qty } from '../../lib/format';

interface Supplier { id: string; legal_name: string; trade_name: string | null; tax_id: string | null; city: string | null; receipts: number; total_12m: string; last_purchase: string | null;
  products: number; open_orders: number; payable_open: string }

/** Fornecedores de reposição: o que compramos de cada um, quando, e quanto devemos. */
export default function SuppliersPage() {
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const [open, setOpen] = useState<Supplier | null>(null);
  const list = useQuery({ queryKey: ['suppliers', query], queryFn: () => api.get<Supplier[]>('/v1/purchasing/suppliers', { q: query || undefined }) });
  const rows = list.data ?? [];
  const total = rows.reduce((s, r) => s + Number(r.total_12m), 0);
  const owed = rows.reduce((s, r) => s + Number(r.payable_open), 0);
  return (
    <>
      <PageHeader title="Fornecedores" subtitle="Quem repõe o estoque: compras nos últimos 12 meses, última compra e saldo a pagar"
        actions={<><Link className="btn" to="/compras/recebimentos">Compras e recebimentos</Link><Link className="btn primary" to="/pessoas">Cadastrar fornecedor</Link></>} />
      <div className="toolbar"><Input placeholder="Nome ou CNPJ" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} aria-label="Buscar fornecedor" /></div>
      <ErrorBox error={list.error} />
      <div className="stat-row">
        <Kpi label="Fornecedores" value={String(rows.length)} delta={`${rows.filter((r) => r.receipts > 0).length} com compras`} />
        <Kpi label="Comprado em 12 meses" value={brl(total.toFixed(2))} />
        <Kpi label="A pagar em aberto" value={brl(owed.toFixed(2))} tone={owed > 0 ? 'down' : undefined} />
        <Kpi label="Pedidos de compra em aberto" value={String(rows.reduce((s, r) => s + r.open_orders, 0))} />
      </div>
      <DataTable rows={rows} rowKey={(r) => r.id} label="Fornecedores" height="calc(100vh - 360px)" onOpen={setOpen}
        empty={<div className="empty-state"><b>Nenhum fornecedor</b>Cadastre em Pessoas com o papel “fornecedor”.</div>}
        columns={[
          { key: 'legal_name', label: 'Fornecedor', width: 'minmax(220px, 2fr)', render: (r) => <>{r.trade_name ?? r.legal_name}{r.trade_name && <span className="muted"> · {r.legal_name}</span>}</> },
          { key: 'tax_id', label: 'CNPJ', width: '160px', hideOnMobile: true, render: (r) => doc(r.tax_id) },
          { key: 'city', label: 'Cidade', width: '140px', hideOnMobile: true },
          { key: 'total_12m', label: 'Compras 12m', type: 'money', width: '130px' },
          { key: 'last_purchase', label: 'Última compra', width: '120px', render: (r) => r.last_purchase ? date(r.last_purchase) : '—', sortValue: (r) => r.last_purchase ?? '' },
          { key: 'products', label: 'Produtos', type: 'number', width: '90px', hideOnMobile: true },
          { key: 'open_orders', label: 'Pedidos abertos', type: 'number', width: '120px', hideOnMobile: true },
          { key: 'payable_open', label: 'A pagar', type: 'money', width: '120px' },
        ]} />
      {open && <SupplierDialog s={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function SupplierDialog({ s, onClose }: { s: Supplier; onClose: () => void }) {
  const q = useQuery({ queryKey: ['supplier-products', s.id], queryFn: () => api.get<any[]>(`/v1/purchasing/suppliers/${s.id}/products`) });
  return (
    <Dialog title={s.trade_name ?? s.legal_name} wide onClose={onClose} footer={<button className="btn" onClick={onClose}>Fechar</button>}>
      <div className="stack">
        <div className="muted">{s.legal_name} · {doc(s.tax_id)}{s.city ? ` · ${s.city}` : ''}</div>
        <h3>Produtos que fornece</h3>
        <ErrorBox error={q.error} />
        {q.data?.length === 0 ? <p className="muted">Nenhuma compra concluída deste fornecedor.</p> : (
          <table className="lines">
            <thead><tr><th>Produto</th><th className="num">Comprado</th><th className="num">Último preço</th><th>Última compra</th></tr></thead>
            <tbody>{(q.data ?? []).map((p) => (
              <tr key={p.product_id}><td className="desc"><span className="mono muted">{p.sku}</span> {p.description}</td><td className="num">{qty(p.quantity_bought)} {p.unit}</td>
                <td className="num">{brl(Number(p.last_unit_price).toFixed(2))}</td><td>{date(p.last_purchase)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </Dialog>
  );
}
