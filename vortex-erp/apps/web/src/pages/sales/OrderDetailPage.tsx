import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, download, openAuthed } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Dialog, ErrorBox, Field, Input, PageHeader, Status, useToast } from '../../components/ui';
import { brl, dateTime, qty } from '../../lib/format';
import { STAGES, stageLabel, stageTone } from '../../lib/orders';

interface PickLine { sku: string; description: string; quantity: string; checked: string; lotNumber: string | null }
interface Order {
  id: string; number: string; status: string; stage: string; party_name: string; total: string; total_products: string; total_discount: string; created_at: string; notes: string | null;
  cancel_reason: string | null;
  items: { id: string; sku: string; description: string; quantity: string; unit_price: string; discount_percent: string; total: string; quantity_invoiced: string; quantity_to_invoice: string }[];
  approvals: { id: string; reason: string; status: string }[];
  invoices: { id: string; number: string; series: number; status: string; access_key: string; total_invoice: string }[];
  shipments: { id: string; status: string; picking: PickLine[]; volumes: number | null; tracking_code: string | null; carrier_name: string | null; delivery_receiver: string | null }[];
  timeline: { stage: string; at: string | null }[];
}

/** Pedido: linha do tempo das etapas e a próxima ação em destaque (aprovar, separar, conferir, faturar, despachar, entregar). */
export default function OrderDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api.get<Order>(`/v1/sales/orders/${id}`) });
  const [dialog, setDialog] = useState<'cancel' | 'check' | 'ship' | 'deliver' | null>(null);
  const [form, setForm] = useState({ reason: '', volumes: '1', tracking: '', receiver: '' });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['order', id] });
    qc.invalidateQueries({ queryKey: ['orders'] });
  };
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown; ok: string }) => api.post<any>(`/v1/sales/orders/${id}/${path}`, body ?? {}),
    onSuccess: (r, v) => {
      const t = r?.transmission;
      toast(t ? `NF-e ${t.status}${t.message ? `: ${t.message}` : ''}` : v.ok, t?.status === 'rejeitada' ? 'bad' : 'ok');
      setDialog(null);
      refresh();
    },
  });
  const o = q.data;
  const ship = o?.shipments.at(-1);
  const editable = can('vendas.pedido.editar');
  const next = o && nextAction(o.stage, can);
  const flow = STAGES.filter((s) => s.key !== 'cancelled' && s.key !== 'pending_approval');
  const reached = (k: string) => Boolean(o?.timeline.find((t) => t.stage === k)?.at);
  return (
    <>
      <PageHeader title={o ? `Pedido ${o.number}` : 'Pedido'} subtitle={o && <>{o.party_name} · {dateTime(o.created_at)} · <span className={`badge ${stageTone(o.stage)}`}>{stageLabel(o.stage)}</span></>}
        actions={<>
          <Link className="btn" to="/vendas/pedidos">Voltar</Link>
          {o && !['invoiced', 'shipped', 'delivered', 'cancelled'].includes(o.stage) && can('vendas.pedido.cancelar') && <button className="btn danger" onClick={() => setDialog('cancel')}>Cancelar pedido</button>}
          {o?.stage === 'approved' && can('vendas.pedido.faturar') && <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ path: 'invoice', ok: 'Faturado' })}>Faturar sem separação</button>}
          {next && (editable || next.perm !== 'vendas.pedido.editar') && (
            <button className="btn primary" disabled={act.isPending} onClick={() => (next.dialog ? setDialog(next.dialog) : act.mutate({ path: next.path!, ok: next.ok }))}>
              {act.isPending ? 'Aguarde…' : next.label}
            </button>
          )}
        </>} />
      <ErrorBox error={q.error ?? act.error} />
      {o && (
        <div className="stack">
          {o.stage === 'cancelled' ? (
            <div className="alert bad">Pedido cancelado em {dateTime(o.timeline.find((t) => t.stage === 'cancelled')?.at ?? null)}{o.cancel_reason ? ` — ${o.cancel_reason}` : ''}</div>
          ) : (
            <section className="card card-pad">
              <ol className="stepper" aria-label="Etapas do pedido">
                {flow.map((s) => {
                  const at = o.timeline.find((t) => t.stage === s.key)?.at;
                  const current = s.key === o.stage || (o.stage === 'pending_approval' && s.key === 'approved');
                  return (
                    <li key={s.key} className={`${reached(s.key) ? 'done' : ''}${current ? ' current' : ''}`}>
                      <span className="dot" aria-hidden="true">{reached(s.key) ? '✓' : ''}</span>
                      <b>{s.short}</b>
                      <small>{at ? dateTime(at) : current && o.stage === 'pending_approval' ? 'Em aprovação' : '—'}</small>
                    </li>
                  );
                })}
              </ol>
              {next && <p className="muted" style={{ margin: '12px 0 0' }}>Próximo passo: <b>{next.label}</b> — {next.hint}</p>}
            </section>
          )}
          {o.approvals.filter((a) => a.status === 'pending').map((a) => <div key={a.id} className="alert warn">Aguardando aprovação: {a.reason} · <Link to="/aprovacoes">Aprovações</Link></div>)}
          <section className="card">
            <div className="card-head"><h2>Itens</h2></div>
            <table className="lines">
              <thead><tr><th>Produto</th><th className="num">Qtd.</th><th className="num">Faturado</th><th className="num">Preço</th><th className="num">Desc. %</th><th className="num">Total</th></tr></thead>
              <tbody>{o.items.map((i) => (
                <tr key={i.id}><td className="desc"><span className="mono muted">{i.sku}</span> {i.description}</td><td className="num">{qty(i.quantity)}</td><td className="num">{qty(i.quantity_invoiced)}</td>
                  <td className="num">{brl(i.unit_price)}</td><td className="num">{qty(i.discount_percent)}</td><td className="num">{brl(i.total)}</td></tr>
              ))}</tbody>
            </table>
            <div className="card-pad totals" style={{ maxWidth: 320, marginLeft: 'auto' }}>
              <div><span>Produtos</span><span>{brl(o.total_products)}</span></div>
              <div><span>Descontos</span><span>{brl(o.total_discount)}</span></div>
              <div className="grand"><span>Total</span><span>{brl(o.total)}</span></div>
            </div>
          </section>
          {ship && ship.picking.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>Separação</h2><span className="spacer" /><Status value={ship.status} label={{ picking: 'em separação', checked: 'conferida', shipped: 'despachada', delivered: 'entregue', returned: 'devolvida' }[ship.status]} /></div>
              <table className="lines">
                <thead><tr><th>Produto</th><th>Lote</th><th className="num">Pedido</th><th className="num">Conferido</th></tr></thead>
                <tbody>{ship.picking.map((l, i) => (
                  <tr key={i}><td className="desc"><span className="mono muted">{l.sku}</span> {l.description}</td><td>{l.lotNumber ?? '—'}</td><td className="num">{qty(l.quantity)}</td>
                    <td className={`num ${Number(l.checked) === Number(l.quantity) ? 'up' : ''}`}>{qty(l.checked)}</td></tr>
                ))}</tbody>
              </table>
            </section>
          )}
          {ship && (ship.tracking_code || ship.delivery_receiver) && (
            <section className="card card-pad stack">
              <h2>Entrega</h2>
              {ship.tracking_code && <div>Rastreio: <b className="mono">{ship.tracking_code}</b>{ship.carrier_name ? ` · ${ship.carrier_name}` : ''}{ship.volumes ? ` · ${ship.volumes} volume(s)` : ''}</div>}
              {ship.delivery_receiver && <div>Recebido por: <b>{ship.delivery_receiver}</b></div>}
            </section>
          )}
          {o.invoices.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>Notas fiscais</h2></div>
              <table className="lines">
                <thead><tr><th>Série/número</th><th>Chave</th><th>Situação</th><th className="num">Valor</th><th /></tr></thead>
                <tbody>{o.invoices.map((d) => (
                  <tr key={d.id}><td>{d.series}/{d.number}</td><td className="mono" style={{ fontSize: 11 }}>{d.access_key}</td><td><Status value={d.status} /></td><td className="num">{brl(d.total_invoice)}</td>
                    <td className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => openAuthed(`/v1/fiscal/documents/${d.id}/danfe`)}>DANFE</button>
                      <button className="btn sm" onClick={() => download(`/v1/fiscal/documents/${d.id}/xml`, undefined, `${d.access_key}.xml`)}>XML</button>
                    </td></tr>
                ))}</tbody>
              </table>
            </section>
          )}
        </div>
      )}
      {dialog === 'cancel' && (
        <Dialog title="Cancelar pedido" onClose={() => setDialog(null)} footer={<>
          <button className="btn" onClick={() => setDialog(null)}>Voltar</button>
          <button className="btn primary" disabled={form.reason.trim().length < 15 || act.isPending} onClick={() => act.mutate({ path: 'cancel', body: { reason: form.reason }, ok: 'Pedido cancelado' })}>Confirmar cancelamento</button>
        </>}>
          <Field label="Motivo (mínimo 15 caracteres, fica na auditoria)" hint={`${form.reason.trim().length}/15`}>
            <textarea className="input" rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
        </Dialog>
      )}
      {dialog === 'check' && (
        <Dialog title="Concluir separação e conferência" onClose={() => setDialog(null)} footer={<>
          <button className="btn" onClick={() => setDialog(null)}>Voltar</button>
          <button className="btn primary" disabled={act.isPending} onClick={() => act.mutate({ path: 'picking/check-all', body: { volumes: Number(form.volumes) || null }, ok: 'Separação conferida' })}>Confirmar conferência</button>
        </>}>
          <p>Confirma que todos os itens foram separados nas quantidades do pedido? Divergências podem ser conferidas item a item com o leitor de código de barras.</p>
          <Field label="Volumes"><Input inputMode="numeric" value={form.volumes} onChange={(e) => setForm({ ...form, volumes: e.target.value })} /></Field>
        </Dialog>
      )}
      {dialog === 'ship' && (
        <Dialog title="Despachar pedido" onClose={() => setDialog(null)} footer={<>
          <button className="btn" onClick={() => setDialog(null)}>Voltar</button>
          <button className="btn primary" disabled={act.isPending} onClick={() => act.mutate({ path: 'ship', body: { trackingCode: form.tracking || null, volumes: Number(form.volumes) || null }, ok: 'Pedido despachado' })}>Despachar</button>
        </>}>
          <div className="stack">
            <Field label="Código de rastreio (opcional)"><Input value={form.tracking} onChange={(e) => setForm({ ...form, tracking: e.target.value })} /></Field>
            <Field label="Volumes"><Input inputMode="numeric" value={form.volumes} onChange={(e) => setForm({ ...form, volumes: e.target.value })} /></Field>
          </div>
        </Dialog>
      )}
      {dialog === 'deliver' && (
        <Dialog title="Registrar entrega" onClose={() => setDialog(null)} footer={<>
          <button className="btn" onClick={() => setDialog(null)}>Voltar</button>
          <button className="btn primary" disabled={form.receiver.trim().length < 2 || act.isPending} onClick={() => act.mutate({ path: 'deliver', body: { receiverName: form.receiver }, ok: 'Entrega registrada' })}>Confirmar entrega</button>
        </>}>
          <Field label="Quem recebeu"><Input value={form.receiver} onChange={(e) => setForm({ ...form, receiver: e.target.value })} autoFocus /></Field>
        </Dialog>
      )}
    </>
  );
}

interface Next { label: string; hint: string; path?: string; dialog?: 'check' | 'ship' | 'deliver'; ok: string; perm: string }

/** Ação que leva o pedido à próxima etapa, se o usuário pode fazê-la. */
function nextAction(stage: string, can: (p: string) => boolean): Next | null {
  const map: Record<string, Next> = {
    open: { label: 'Enviar para aprovação', hint: 'aprova direto se não houver bloqueio de crédito, margem ou desconto', path: 'submit', ok: 'Pedido enviado', perm: 'vendas.pedido.criar' },
    approved: { label: 'Enviar para separação', hint: 'gera a lista de separação por depósito e lote', path: 'picking', ok: 'Enviado para separação', perm: 'vendas.pedido.editar' },
    to_pick: { label: 'Iniciar separação', hint: 'o separador começou a separar os itens', path: 'picking/start', ok: 'Separação iniciada', perm: 'vendas.pedido.editar' },
    picking: { label: 'Concluir conferência', hint: 'confirma que tudo foi separado e conferido', dialog: 'check', ok: '', perm: 'vendas.pedido.editar' },
    checked: { label: 'Faturar', hint: 'emite a NF-e, baixa o estoque e gera os títulos', path: 'invoice', ok: 'Faturado', perm: 'vendas.pedido.faturar' },
    invoiced: { label: 'Despachar', hint: 'a mercadoria sai com a NF-e; informe o rastreio', dialog: 'ship', ok: '', perm: 'vendas.pedido.editar' },
    shipped: { label: 'Registrar entrega', hint: 'informe quem recebeu', dialog: 'deliver', ok: '', perm: 'vendas.pedido.editar' },
  };
  const n = map[stage];
  return n && can(n.perm) ? n : null;
}
