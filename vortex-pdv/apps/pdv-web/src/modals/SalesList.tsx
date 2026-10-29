import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl, qty, time } from '../lib/format';
import { can, type Operator, type SaleView } from '../lib/types';
import { useAuthorized } from '../authorize';
import { Alert, Modal } from '../ui';
import { CancelSaleModal } from './CancelSale';

interface Row {
  id: string; number: string; status: string; total: string; fiscal_status: string | null; sync_status: string; completed_at: string | null; customer: string | null;
  operator_name: string | null; items_count: number; cancelled_items: number; methods: string | null; sync_error: string | null;
}
const FISCAL: Record<string, string> = { authorized: 'autorizada', contingency: 'contingência', rejected: 'REJEITADA', cancelled: 'cancelada', pending: 'pendente' };
const SYNC: Record<string, string> = { synced: 'no ERP', pending: 'na fila', failed: 'falha no envio', local: '—' };
const METHOD: Record<string, string> = { cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito', pos_debit: 'Débito (maq.)', pos_credit: 'Crédito (maq.)' };
type Period = 'today' | 'yesterday' | '7d' | '30d' | 'custom';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
function range(p: Period, custom: { from: string; to: string }) {
  switch (p) {
    case 'today': return { from: daysAgo(0), to: daysAgo(0) };
    case 'yesterday': return { from: daysAgo(1), to: daysAgo(1) };
    case '7d': return { from: daysAgo(6), to: daysAgo(0) };
    case '30d': return { from: daysAgo(29), to: daysAgo(0) };
    default: return custom;
  }
}
const dateTime = (s: string) => new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Histórico de vendas (F11 / Menu → 1): período, busca, situação; detalhe com itens cancelados; reimprimir, cancelar, reprocessar. */
export function SalesListModal({ operator, onClose }: { operator: Operator; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [period, setPeriod] = useState<Period>('today');
  const [custom, setCustom] = useState({ from: daysAgo(6), to: daysAgo(0) });
  const [status, setStatus] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [cancel, setCancel] = useState<SaleView | null>(null);
  const [open, setOpen] = useState<{ row: Row; view: SaleView } | null>(null);
  const authorized = useAuthorized();
  const r = range(period, custom);
  const query = new URLSearchParams({ from: r.from, to: r.to, ...(q ? { q } : {}), ...(status === 'failed' ? { sync: 'failed' } : status ? { status } : {}) }).toString();
  const load = () => api<Row[]>('GET', `/api/sales?${query}`).then(setRows).catch(() => setRows([]));
  // Atualiza sozinha: a situação "na fila" → "no ERP" muda com a sincronização em segundo plano
  useEffect(() => {
    void load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [query]);
  const summary = useMemo(() => {
    const done = rows.filter((x) => x.status === 'completed');
    const total = done.reduce((a, x) => a + Number(x.total), 0);
    return { count: done.length, total, ticket: done.length ? total / done.length : 0, cancelled: rows.length - done.length, pending: rows.filter((x) => x.sync_status !== 'synced').length };
  }, [rows]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMsg({ kind: 'ok', text: ok });
      void load();
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setMsg({ kind: 'error', text: e.message });
    }
  };
  const show = (row: Row) => api<SaleView>('GET', `/api/sales/${row.id}`).then((view) => setOpen({ row, view })).catch(() => undefined);
  if (cancel) return <CancelSaleModal sale={cancel} onClose={() => setCancel(null)} onDone={() => { setCancel(null); setOpen(null); setMsg({ kind: 'ok', text: 'Venda cancelada' }); void load(); }} />;
  if (open) return <SaleDetail operator={operator} row={open.row} view={open.view} onBack={() => setOpen(null)} onClose={onClose} onCancel={() => setCancel(open.view)}
    onReprint={() => void act(() => authorized((authorization) => api('POST', `/api/sales/${open.row.id}/reprint`, { authorization })), 'Comprovante reimpresso')} msg={msg} />;
  return (
    <Modal title={can(operator, 'pdv.operador.consultar') ? 'Histórico de vendas do caixa' : 'Histórico das minhas vendas'} wide onClose={onClose}>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="history-filters">
        <div className="seg" role="group" aria-label="Período">
          {([['today', 'Hoje'], ['yesterday', 'Ontem'], ['7d', '7 dias'], ['30d', '30 dias'], ['custom', 'Período']] as [Period, string][]).map(([k, label]) => (
            <button key={k} type="button" className={period === k ? 'on' : ''} aria-pressed={period === k} onClick={() => setPeriod(k)}>{label}</button>
          ))}
        </div>
        {period === 'custom' && (
          <div className="row">
            <input type="date" aria-label="De" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            <input type="date" aria-label="Até" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </div>
        )}
        <div className="row">
          <input data-autofocus aria-label="Buscar venda" placeholder="Número da venda ou cliente" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todas</option><option value="completed">Concluídas</option><option value="cancelled">Canceladas</option>
            <option value="with_cancelled_items">Com item cancelado</option><option value="failed">Com falha no envio ao ERP</option>
          </select>
        </div>
      </div>
      <div className="history-summary">
        <div><span>Vendas</span><b>{summary.count}</b></div>
        <div><span>Total</span><b>R$ {brl(summary.total)}</b></div>
        <div><span>Ticket médio</span><b>R$ {brl(summary.ticket)}</b></div>
        <div><span>Canceladas</span><b>{summary.cancelled}</b></div>
        <div className={summary.pending ? 'warn' : ''}><span>Fora do ERP</span><b>{summary.pending}</b></div>
      </div>
      {rows.length === 0 ? <p className="muted empty-msg">Nenhuma venda neste período.</p> : (
        <div className="history-scroll">
          <table className="conf history">
            <thead><tr><th>Data</th><th>Venda</th><th>Cliente</th><th>Operador</th><th>Pagamento</th><th className="num">Total</th><th>NFC-e</th><th>ERP</th></tr></thead>
            <tbody>{rows.map((x) => {
              const customer = x.customer ? (JSON.parse(x.customer) as { name: string | null }).name : null;
              return (
                <tr key={x.id} className={`clickable${x.status === 'cancelled' ? ' cancelled' : ''}`} tabIndex={0} onClick={() => void show(x)} onKeyDown={(e) => e.key === 'Enter' && void show(x)}>
                  <td>{x.completed_at ? (period === 'today' ? time(x.completed_at) : dateTime(x.completed_at)) : '-'}</td>
                  <td className="mono">{x.number}{x.cancelled_items > 0 && <span className="tag low" title="Itens cancelados no caixa"> {x.cancelled_items} item(ns) cancelado(s)</span>}</td>
                  <td>{customer ?? <span className="muted">Consumidor</span>}</td>
                  <td>{x.operator_name ?? '-'}</td>
                  <td>{(x.methods ?? '').split(',').filter(Boolean).map((m) => METHOD[m] ?? m).join(' + ') || '-'}</td>
                  <td className="num">{brl(x.total)}</td>
                  <td>{x.status === 'cancelled' ? 'cancelada' : FISCAL[x.fiscal_status ?? 'pending']}</td>
                  <td title={x.sync_error ?? undefined} className={x.sync_status === 'failed' ? 'bad-text' : ''}>{SYNC[x.sync_status]}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function SaleDetail({ operator, row, view, onBack, onClose, onCancel, onReprint, msg }: {
  operator: Operator; row: Row; view: SaleView; onBack: () => void; onClose: () => void; onCancel: () => void; onReprint: () => void; msg: { kind: 'ok' | 'error'; text: string } | null;
}) {
  const active = view.items.filter((i) => i.status === 'active');
  const cancelled = view.items.filter((i) => i.status === 'cancelled');
  return (
    <Modal title={`Venda ${row.number}`} wide onClose={onClose} footer={<>
      <button type="button" onClick={onBack}>Voltar ao histórico</button>
      <button type="button" onClick={onReprint}>Reimprimir</button>
      {row.status === 'completed' && can(operator, 'pdv.venda.cancelar') && <button type="button" className="danger" onClick={onCancel}>Cancelar venda</button>}
    </>}>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {row.sync_status === 'failed' && <Alert kind="error">Não chegou ao ERP: {row.sync_error ?? 'motivo não informado'}</Alert>}
      <div className="history-summary">
        <div><span>Data</span><b>{row.completed_at ? dateTime(row.completed_at) : '-'}</b></div>
        <div><span>Operador</span><b>{row.operator_name ?? '-'}</b></div>
        <div><span>Cliente</span><b>{view.sale.customer?.name ?? 'Consumidor'}</b></div>
        <div><span>Total</span><b>R$ {brl(view.sale.total)}</b></div>
        <div><span>ERP</span><b>{SYNC[row.sync_status]}</b></div>
      </div>
      <h3>Itens</h3>
      <table className="conf">
        <thead><tr><th>#</th><th>Produto</th><th className="num">Qtd</th><th className="num">Preço</th><th className="num">Desconto</th><th className="num">Total</th></tr></thead>
        <tbody>{active.map((i) => (
          <tr key={i.id}><td>{String(i.seq).padStart(3, '0')}</td><td>{i.description}<br /><small className="muted">{i.sku}</small></td>
            <td className="num">{qty(i.quantity)} {i.unit}</td><td className="num">{brl(i.unit_price)}</td><td className="num">{brl(i.discount)}</td><td className="num">{brl(i.total)}</td></tr>
        ))}</tbody>
      </table>
      {cancelled.length > 0 && (
        <>
          <h3>Cancelados no caixa</h3>
          <table className="conf">
            <thead><tr><th>Produto</th><th className="num">Qtd</th><th className="num">Valor</th><th>Motivo</th></tr></thead>
            <tbody>{cancelled.map((i) => (
              <tr key={i.id} className="cancelled"><td>{i.description}{i.cancelled_from_seq ? <small className="muted"> (do item {String(i.cancelled_from_seq).padStart(3, '0')})</small> : null}</td>
                <td className="num">{qty(i.quantity)} {i.unit}</td><td className="num">{brl(Number(i.quantity) * Number(i.unit_price))}</td><td>{i.cancel_reason ?? '-'}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
      <h3>Pagamentos</h3>
      <table className="conf">
        <tbody>{view.payments.filter((p) => p.status === 'approved' || p.status === 'refunded').map((p) => (
          <tr key={p.id}><td>{METHOD[p.method] ?? p.method}{p.installments > 1 ? ` ${p.installments}x` : ''}</td><td className="num">{brl(p.amount)}</td>
            <td>{p.status === 'refunded' ? 'estornado' : p.change !== '0' && Number(p.change) > 0 ? `troco ${brl(p.change)}` : ''}{p.nsu ? ` NSU ${p.nsu}` : ''}</td></tr>
        ))}</tbody>
      </table>
      {view.fiscal && <p className="muted mono">NFC-e {view.fiscal.number} série {view.fiscal.series} · {FISCAL[view.fiscal.status] ?? view.fiscal.status} · {view.fiscal.accessKey}</p>}
    </Modal>
  );
}
