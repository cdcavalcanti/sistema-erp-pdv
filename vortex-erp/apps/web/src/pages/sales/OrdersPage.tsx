import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable } from '../../components/DataTable';
import { ErrorBox, Input, PageHeader, useDebounced } from '../../components/ui';
import { dateTime } from '../../lib/format';
import { usePaged } from '../../lib/hooks';
import { STAGES, stageLabel, stageTone } from '../../lib/orders';

interface OrderRow { id: string; number: string; stage: string; channel: string; total: string; created_at: string; party_name: string; items_count: number; tracking_code: string | null }
const CHANNEL: Record<string, string> = { counter: 'Balcão', ecommerce: 'E-commerce', marketplace: 'Marketplace', crm: 'Representante', whatsapp: 'WhatsApp', api: 'API', pdv: 'PDV', wholesale: 'Atacado' };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Histórico de pedidos com a etapa de cada um: do pedido criado até a entrega (ou cancelamento). */
export default function OrdersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const stage = params.get('etapa') ?? '';
  const [from, setFrom] = useState(daysAgo(90));
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const counts = useQuery({ queryKey: ['orders', 'stages', from], queryFn: () => api.get<{ stage: string; orders: number; total: string }[]>('/v1/sales/orders/stages', { from }) });
  const list = usePaged<OrderRow>(['orders'], '/v1/sales/orders', { stage: stage || undefined, from: from || undefined, q: query || undefined });
  const count = (k: string) => counts.data?.find((x) => x.stage === k)?.orders ?? 0;
  const all = counts.data?.reduce((s, x) => s + x.orders, 0) ?? 0;
  const pick = (k: string) => setParams(k ? { etapa: k } : {});
  return (
    <>
      <PageHeader title="Pedidos" subtitle="Do pedido à entrega: clique numa etapa para filtrar"
        actions={can('vendas.pedido.criar') && <Link className="btn primary" to="/vendas/pedidos/novo">Novo pedido <span className="kbd-hint">F2</span></Link>} />
      <div className="chips" role="group" aria-label="Etapa" style={{ marginBottom: 12 }}>
        <button type="button" className="chip" aria-pressed={!stage} onClick={() => pick('')}>Todos <span className="count">{all}</span></button>
        {STAGES.map((s) => (
          <button key={s.key} type="button" className="chip" aria-pressed={stage === s.key} onClick={() => pick(s.key)} title={s.hint}>{s.short} <span className="count">{count(s.key)}</span></button>
        ))}
      </div>
      <div className="toolbar">
        <Input placeholder="Cliente ou número do pedido" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} aria-label="Buscar pedido" />
        <label className="row">Desde <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      </div>
      <ErrorBox error={list.error ?? counts.error} />
      <DataTable rows={list.rows} rowKey={(r) => r.id} label="Pedidos" height="calc(100vh - 300px)" onOpen={(r) => nav(`/vendas/pedidos/${r.id}`)}
        empty={<div className="empty-state"><b>Nenhum pedido {stage ? `em “${stageLabel(stage)}”` : 'no período'}</b>Ajuste a etapa ou a data.</div>}
        footer={list.hasNextPage && <button className="btn sm" onClick={() => list.fetchNextPage()}>Carregar mais</button>}
        columns={[
          { key: 'number', label: 'Nº', type: 'number', width: '80px' },
          { key: 'created_at', label: 'Data', width: '158px', render: (r) => dateTime(r.created_at), sortValue: (r) => r.created_at },
          { key: 'party_name', label: 'Cliente', width: 'minmax(200px, 3fr)' },
          { key: 'channel', label: 'Canal', width: '120px', hideOnMobile: true, render: (r) => CHANNEL[r.channel] ?? r.channel },
          { key: 'items_count', label: 'Itens', type: 'number', width: '70px', hideOnMobile: true },
          { key: 'total', label: 'Total', type: 'money', width: '130px' },
          { key: 'stage', label: 'Etapa', width: '190px', render: (r) => <span className={`badge ${stageTone(r.stage)}`}>{stageLabel(r.stage)}</span>, sortValue: (r) => STAGES.findIndex((s) => s.key === r.stage) },
        ]} />
    </>
  );
}

