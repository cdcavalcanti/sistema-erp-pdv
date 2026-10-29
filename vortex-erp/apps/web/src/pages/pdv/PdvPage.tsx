import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { Dialog, ErrorBox, Input, Kpi, PageHeader, Select, useDebounced } from '../../components/ui';
import { brl, dateTime, qty } from '../../lib/format';
import { usePaged } from '../../lib/hooks';

interface SaleRow {
  id: string; sale_id: string; pdv_id: string; status: string; total: string; occurred_at: string; operator_name: string | null; cancelled_items_count: number;
  fiscal_status: string; series: number; number: string; emission_type: number; recipient_name: string | null; items_count: number; returns_count: number; store_name: string;
  payments: { tPag: string; value: string }[];
}
interface Summary {
  sales: number; total: string; averageTicket: string; cancelled_sales: number; cancelled_total: string; cancelled_items: number; cancelled_items_value: string; pending_authorization: number;
  byTerminal: { pdv_id: string; sales: number; total: string }[]; byOperator: { operator: string; sales: number; total: string; cancelled_items: number }[];
}
interface CancelledItem { sku: string | null; description: string; quantity: string; unit: string | null; unitPrice: string; reason: string; partial?: boolean; operatorName: string | null; authorizedByName: string | null; at: string | null }
interface SaleDetail extends SaleRow {
  access_key: string; protocol: string | null; cancel_reason: string | null; total_products: string; total_discount: string; recipient_tax_id: string | null;
  items: { item_number: number; sku: string; description: string; quantity: string; returned_quantity: string; unit_price: string; discount: string; total: string }[];
  cancelled_items: CancelledItem[]; returns: { reference: string; total: string; refund_method: string; occurred_at: string }[];
  events: { action: string; metadata: Record<string, any>; occurred_at: string; user_name: string | null }[];
}
const TPAG: Record<string, string> = { '01': 'Dinheiro', '03': 'Crédito', '04': 'Débito', '17': 'Pix', '05': 'Crédito loja', '15': 'Boleto', '99': 'Outros' };
const KIND: Record<string, string> = { opening: 'Abertura', supply: 'Suprimento', withdrawal: 'Sangria', closing: 'Fechamento', reopening: 'Reabertura' };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Vendas, caixas e terminais da loja física: tudo o que o Vortex PDV mandou para o ERP. */
export default function PdvPage() {
  const [tab, setTab] = useState<'sales' | 'cash' | 'terminals'>('sales');
  return (
    <>
      <PageHeader title="Loja física (PDV)" subtitle="O que os caixas do Vortex PDV enviaram ao ERP: vendas, cancelamentos, caixas e terminais" />
      <div className="tabs" role="tablist">
        {([['sales', 'Vendas'], ['cash', 'Caixas'], ['terminals', 'Terminais']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'sales' && <Sales />}
      {tab === 'cash' && <Cash />}
      {tab === 'terminals' && <Terminals />}
    </>
  );
}

function Sales() {
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(daysAgo(0));
  const [status, setStatus] = useState('');
  const [pdvId, setPdvId] = useState('');
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const [open, setOpen] = useState<string | null>(null);
  const filter = { from, to, status: status || undefined, pdvId: pdvId || undefined, q: query || undefined };
  const summary = useQuery({ queryKey: ['pdv-summary', filter], queryFn: () => api.get<Summary>('/v1/pdv/sales/summary', filter) });
  const list = usePaged<SaleRow>(['pdv-sales'], '/v1/pdv/sales', filter);
  const s = summary.data;
  return (
    <>
      <div className="toolbar">
        <label className="row">De <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row">até <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <Select value={pdvId} onChange={(e) => setPdvId(e.target.value)} aria-label="Terminal" style={{ width: 'auto' }}>
          <option value="">Todos os caixas</option>{s?.byTerminal.map((t) => <option key={t.pdv_id} value={t.pdv_id}>Caixa {t.pdv_id}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação" style={{ width: 'auto' }}>
          <option value="">Todas</option><option value="active">Concluídas</option><option value="cancelled">Canceladas</option><option value="with_cancelled_items">Com item cancelado no caixa</option>
        </Select>
        <Input placeholder="Venda, cliente ou operador" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} aria-label="Buscar venda" />
      </div>
      <ErrorBox error={summary.error ?? list.error} />
      {s && (
        <div className="stat-row">
          <Kpi label="Vendas" value={String(s.sales)} delta={`${brl(s.total)} no período`} />
          <Kpi label="Ticket médio" value={brl(s.averageTicket)} />
          <Kpi label="Canceladas" value={String(s.cancelled_sales)} delta={brl(s.cancelled_total)} tone={s.cancelled_sales ? 'down' : undefined} />
          <Kpi label="Itens cancelados no caixa" value={String(s.cancelled_items)} delta={`${brl(s.cancelled_items_value)} retirados das vendas`} tone={s.cancelled_items ? 'down' : undefined} />
          <Kpi label="NFC-e em contingência" value={String(s.pending_authorization)} delta="aguardando autorização" tone={s.pending_authorization ? 'down' : undefined} />
        </div>
      )}
      {s && s.byOperator.length > 0 && (
        <section className="card card-pad" style={{ marginBottom: 14 }}>
          <h3 style={{ marginBottom: 10 }}>Por operador</h3>
          <table className="lines">
            <thead><tr><th>Operador</th><th className="num">Vendas</th><th className="num">Total</th><th className="num">Ticket</th><th className="num">Itens cancelados</th></tr></thead>
            <tbody>{s.byOperator.map((o) => (
              <tr key={o.operator}><td>{o.operator}</td><td className="num">{o.sales}</td><td className="num">{brl(o.total)}</td><td className="num">{brl((Number(o.total) / (o.sales || 1)).toFixed(2))}</td>
                <td className="num">{o.cancelled_items}</td></tr>
            ))}</tbody>
          </table>
        </section>
      )}
      <DataTable rows={list.rows} rowKey={(r) => r.id} label="Vendas do PDV" height="calc(100vh - 470px)" onOpen={(r) => setOpen(r.id)}
        empty={<div className="empty-state"><b>Nenhuma venda do PDV no período</b>As vendas aparecem aqui assim que o caixa sincroniza com o ERP.</div>}
        footer={list.hasNextPage && <button className="btn sm" onClick={() => list.fetchNextPage()}>Carregar mais</button>}
        columns={[
          { key: 'occurred_at', label: 'Data', width: '158px', render: (r) => dateTime(r.occurred_at), sortValue: (r) => r.occurred_at },
          { key: 'sale_id', label: 'Venda', width: 'minmax(200px, 1.4fr)', render: (r) => <span className="mono">{r.sale_id}</span> },
          { key: 'pdv_id', label: 'Caixa', width: '70px' },
          { key: 'operator_name', label: 'Operador', width: 'minmax(120px, 1fr)', hideOnMobile: true },
          { key: 'recipient_name', label: 'Cliente', width: 'minmax(120px, 1fr)', hideOnMobile: true, render: (r) => r.recipient_name ?? <span className="muted">Consumidor</span> },
          { key: 'payments', label: 'Pagamento', width: '150px', hideOnMobile: true, render: (r) => [...new Set(r.payments.map((p) => TPAG[p.tPag] ?? p.tPag))].join(' + ') },
          { key: 'total', label: 'Total', type: 'money', width: '120px' },
          { key: 'status', label: 'Situação', width: '170px', render: (r) => r.status === 'cancelled' ? <span className="badge bad">Cancelada</span>
            : r.cancelled_items_count ? <span className="badge warn">{r.cancelled_items_count} item(ns) cancelado(s)</span>
              : r.fiscal_status === 'contingencia' ? <span className="badge warn">Contingência</span> : <span className="badge ok">Concluída</span> },
        ]} />
      {open && <SaleDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function SaleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['pdv-sale', id], queryFn: () => api.get<SaleDetail>(`/v1/pdv/sales/by-id/${id}`) });
  const s = q.data;
  return (
    <Dialog title={s ? `Venda ${s.sale_id}` : 'Venda do PDV'} wide onClose={onClose} footer={<button className="btn" onClick={onClose}>Fechar</button>}>
      <ErrorBox error={q.error} />
      {s && (
        <div className="stack">
          <div className="stat-row">
            <div><small className="muted">Data</small><div><b>{dateTime(s.occurred_at)}</b></div></div>
            <div><small className="muted">Caixa / operador</small><div><b>{s.pdv_id}</b> · {s.operator_name ?? '—'}</div></div>
            <div><small className="muted">Cliente</small><div><b>{s.recipient_name ?? 'Consumidor final'}</b></div></div>
            <div><small className="muted">NFC-e</small><div><b>{s.series}/{s.number}</b> · {s.fiscal_status}</div></div>
            <div><small className="muted">Total</small><div><b>{brl(s.total)}</b></div></div>
          </div>
          {s.status === 'cancelled' && <div className="alert bad">Venda cancelada{s.cancel_reason ? `: ${s.cancel_reason}` : ''}</div>}
          <h3>Itens vendidos</h3>
          <table className="lines">
            <thead><tr><th>#</th><th>Produto</th><th className="num">Qtd.</th><th className="num">Devolvido</th><th className="num">Preço</th><th className="num">Desconto</th><th className="num">Total</th></tr></thead>
            <tbody>{s.items.map((i) => (
              <tr key={i.item_number}><td>{i.item_number}</td><td className="desc"><span className="mono muted">{i.sku}</span> {i.description}</td><td className="num">{qty(i.quantity)}</td>
                <td className="num">{Number(i.returned_quantity) ? qty(i.returned_quantity) : '—'}</td><td className="num">{brl(i.unit_price)}</td><td className="num">{brl(i.discount)}</td><td className="num">{brl(i.total)}</td></tr>
            ))}</tbody>
          </table>
          <h3>Cancelados no caixa (antes de concluir)</h3>
          {s.cancelled_items.length === 0 ? <p className="muted">Nenhum item cancelado nesta venda.</p> : (
            <table className="lines">
              <thead><tr><th>Produto</th><th className="num">Qtd.</th><th className="num">Valor</th><th>Motivo</th><th>Operador</th><th>Autorizado por</th></tr></thead>
              <tbody>{s.cancelled_items.map((c, i) => (
                <tr key={i}><td className="desc">{c.sku && <span className="mono muted">{c.sku}</span>} {c.description}{c.partial ? <small className="muted"> (parcial)</small> : null}</td>
                  <td className="num">{qty(c.quantity)} {c.unit ?? ''}</td><td className="num">{brl((Number(c.quantity) * Number(c.unitPrice)).toFixed(2))}</td><td>{c.reason}</td>
                  <td>{c.operatorName ?? '—'}</td><td>{c.authorizedByName ?? '—'}</td></tr>
              ))}</tbody>
            </table>
          )}
          <h3>Pagamentos</h3>
          <div className="chips">{s.payments.map((p, i) => <span key={i} className="chip">{TPAG[p.tPag] ?? p.tPag} · {brl(p.value)}</span>)}</div>
          {s.returns.length > 0 && (
            <>
              <h3>Devoluções</h3>
              {s.returns.map((r) => <div key={r.reference} className="row">{dateTime(r.occurred_at)} · {r.reference} · {brl(r.total)} · reembolso {r.refund_method}</div>)}
            </>
          )}
          {s.events.length > 0 && (
            <>
              <h3>Auditoria do caixa</h3>
              <ul className="plain-list">{s.events.map((e, i) => (
                <li key={i}><span>{e.action.replaceAll('_', ' ').toLowerCase()} {e.metadata?.description ?? e.metadata?.product ?? ''} {e.metadata?.reason ? `— ${e.metadata.reason}` : ''}</span>
                  <small className="muted">{e.user_name ?? ''} · {dateTime(e.occurred_at)}</small></li>
              ))}</ul>
            </>
          )}
          <p className="muted mono" style={{ fontSize: 11 }}>{s.access_key}</p>
        </div>
      )}
    </Dialog>
  );
}

function Cash() {
  const [from, setFrom] = useState(daysAgo(6));
  const q = useQuery({ queryKey: ['pdv-cash', from], queryFn: () => api.get<any[]>('/v1/pdv/cash-movements', { from }) });
  return (
    <>
      <div className="toolbar"><label className="row">Desde <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label></div>
      <ErrorBox error={q.error} />
      <DataTable rows={q.data ?? []} rowKey={(r) => r.id} label="Movimentos de caixa" height="calc(100vh - 290px)"
        empty={<div className="empty-state"><b>Nenhum movimento de caixa no período</b>Abertura, sangria, suprimento e fechamento aparecem aqui.</div>}
        columns={[
          { key: 'occurred_at', label: 'Data', width: '158px', render: (r) => dateTime(r.occurred_at), sortValue: (r) => r.occurred_at },
          { key: 'pdv_id', label: 'Caixa', width: '70px' },
          { key: 'kind', label: 'Movimento', width: '120px', render: (r) => KIND[r.kind] ?? r.kind },
          { key: 'amount', label: 'Valor', type: 'money', width: '120px' },
          { key: 'difference', label: 'Diferença', width: '130px', render: (r) => r.difference === null ? '—'
            : <span className={Number(r.difference) < 0 ? 'down' : Number(r.difference) > 0 ? 'up' : ''}>{brl(r.difference)} {Number(r.difference) < 0 ? '(falta)' : Number(r.difference) > 0 ? '(sobra)' : ''}</span> },
          { key: 'operator_name', label: 'Operador', width: 'minmax(120px, 1fr)' },
          { key: 'authorized_by_name', label: 'Autorizado por', width: 'minmax(120px, 1fr)', hideOnMobile: true },
          { key: 'reason', label: 'Motivo', width: 'minmax(160px, 1.5fr)', hideOnMobile: true },
        ]} />
    </>
  );
}

function Terminals() {
  const q = useQuery({ queryKey: ['pdv-terminals'], queryFn: () => api.get<any[]>('/v1/pdv/terminals'), refetchInterval: 15_000 });
  return (
    <>
      <ErrorBox error={q.error} />
      <div className="dash-grid">
        {(q.data ?? []).map((t) => (
          <section key={t.id} className="card panel span-4">
            <div className="panel-head"><h2>Caixa {t.code}</h2><span className="muted">{t.name}</span><span className="spacer" />
              <span className={`badge ${t.status !== 'active' ? 'bad' : t.online ? 'ok' : 'warn'}`}>{t.status !== 'active' ? 'Bloqueado' : t.online ? 'Online' : 'Offline'}</span></div>
            <div className="row"><span>Último contato</span><span className="spacer" /><b>{t.last_seen_at ? dateTime(t.last_seen_at) : 'nunca'}</b></div>
            <div className="row"><span>Última sincronização</span><span className="spacer" /><b>{t.last_sync_at ? dateTime(t.last_sync_at) : '—'}</b></div>
            <div className="row"><span>Vendas aguardando envio</span><span className="spacer" /><b>{t.pending_sales ?? 0}</b></div>
            <div className="row"><span>Versão</span><span className="spacer" /><b>{t.app_version ?? '—'}</b></div>
          </section>
        ))}
        {q.data?.length === 0 && <div className="empty-state span-12"><b>Nenhum terminal cadastrado</b>Cadastre o terminal pela API (POST /v1/pdv/terminals) e pareie o caixa.</div>}
      </div>
    </>
  );
}
