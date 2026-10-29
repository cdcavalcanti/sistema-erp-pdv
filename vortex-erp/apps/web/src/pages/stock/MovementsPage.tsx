import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { ErrorBox, Input, Kpi, PageHeader, Select, useDebounced } from '../../components/ui';
import { brl, dateTime, qty } from '../../lib/format';
import { usePaged } from '../../lib/hooks';

interface Movement {
  id: string; occurred_at: string; movement_type: string; sign: number; quantity: string; unit_cost: string; total_cost: string; reason: string | null; source_type: string;
  sku: string; description: string; stock_unit: string; warehouse: string; doc_model: string | null; doc_number: string | null; doc_source: string | null; party_name: string | null;
}
export const MOVEMENT_LABEL: Record<string, string> = {
  opening: 'Saldo inicial', purchase_in: 'Compra', sale_out: 'Venda', sale_return_in: 'Devolução de cliente', purchase_return_out: 'Devolução a fornecedor',
  transfer_out: 'Transferência (saída)', transfer_in: 'Transferência (entrada)', production_consume: 'Consumo na produção', production_output: 'Produção',
  inventory_adjust_in: 'Ajuste de inventário (+)', inventory_adjust_out: 'Ajuste de inventário (−)', loss: 'Perda', damage: 'Avaria', internal_use: 'Uso interno',
  shipment_out: 'Remessa', shipment_return_in: 'Retorno de remessa', third_party_in: 'Entrada de terceiros', third_party_return_out: 'Retorno a terceiros',
  reversal_in: 'Estorno (+)', reversal_out: 'Estorno (−)',
};
const MODEL: Record<string, string> = { '55': 'NF-e', '65': 'NFC-e' };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Histórico de entradas e saídas de todo o estoque, com a origem de cada movimento. */
export default function MovementsPage() {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(daysAgo(0));
  const [direction, setDirection] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const totals = useQuery({ queryKey: ['movement-totals', from, to], queryFn: () => api.get<{ movement_type: string; sign: number; movements: number; quantity: string; total_cost: string }[]>('/v1/stock/movements/totals', { from, to }) });
  const list = usePaged<Movement>(['movements'], '/v1/stock/movements', { from, to, direction: direction || undefined, type: type || undefined, q: query || undefined });
  const sum = (sign: number) => (totals.data ?? []).filter((t) => t.sign === sign);
  const value = (sign: number) => sum(sign).reduce((s, t) => s + Number(t.total_cost), 0);
  return (
    <>
      <PageHeader title="Movimentações de estoque" subtitle="Tudo o que entrou e saiu: compras, vendas (pedidos e PDV), devoluções, transferências e ajustes" />
      <div className="toolbar">
        <label className="row">De <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row">até <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="chips" role="group" aria-label="Sentido">
          {([['', 'Todas'], ['in', 'Entradas'], ['out', 'Saídas']] as const).map(([k, l]) => <button key={k} type="button" className="chip" aria-pressed={direction === k} onClick={() => setDirection(k)}>{l}</button>)}
        </div>
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo" style={{ width: 'auto' }}>
          <option value="">Todos os tipos</option>{Object.entries(MOVEMENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <Input placeholder="Produto (SKU ou descrição)" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} aria-label="Buscar produto" />
      </div>
      <ErrorBox error={list.error ?? totals.error} />
      {totals.data && (
        <div className="stat-row">
          <Kpi label="Entradas (custo)" value={brl(value(1).toFixed(2))} delta={sum(1).map((t) => `${MOVEMENT_LABEL[t.movement_type] ?? t.movement_type}: ${t.movements}`).join(' · ') || 'nenhuma'} />
          <Kpi label="Saídas (custo)" value={brl(value(-1).toFixed(2))} delta={sum(-1).map((t) => `${MOVEMENT_LABEL[t.movement_type] ?? t.movement_type}: ${t.movements}`).join(' · ') || 'nenhuma'} />
          <Kpi label="Saldo do período" value={brl((value(1) - value(-1)).toFixed(2))} tone={value(1) - value(-1) < 0 ? 'down' : 'up'} />
        </div>
      )}
      <DataTable rows={list.rows} rowKey={(r) => r.id} label="Movimentações" height="calc(100vh - 380px)"
        empty={<div className="empty-state"><b>Nenhuma movimentação no período</b>Ajuste as datas ou os filtros.</div>}
        footer={list.hasNextPage && <button className="btn sm" onClick={() => list.fetchNextPage()}>Carregar mais</button>}
        columns={[
          { key: 'occurred_at', label: 'Data', width: '158px', render: (r) => dateTime(r.occurred_at), sortValue: (r) => r.occurred_at },
          { key: 'movement_type', label: 'Tipo', width: '170px', render: (r) => <span className={`badge ${r.sign > 0 ? 'ok' : 'warn'}`}>{r.sign > 0 ? '+ ' : '− '}{MOVEMENT_LABEL[r.movement_type] ?? r.movement_type}</span> },
          { key: 'description', label: 'Produto', width: 'minmax(200px, 2fr)', render: (r) => <><span className="mono muted">{r.sku}</span> {r.description}</> },
          { key: 'quantity', label: 'Qtd.', width: '90px', type: 'number', render: (r) => <span className={r.sign > 0 ? 'up' : 'down'}>{r.sign > 0 ? '+' : '−'}{qty(r.quantity)}</span> },
          { key: 'total_cost', label: 'Custo', type: 'money', width: '110px' },
          { key: 'doc_number', label: 'Origem', width: 'minmax(160px, 1.4fr)', hideOnMobile: true, render: (r) => r.doc_number
            ? <>{r.doc_source === 'pdv' ? 'PDV · ' : ''}{MODEL[r.doc_model ?? ''] ?? 'Nota'} {r.doc_number}{r.party_name ? <span className="muted"> · {r.party_name}</span> : null}</>
            : <span className="muted">{r.reason ?? r.source_type}</span> },
          { key: 'warehouse', label: 'Depósito', width: '110px', hideOnMobile: true },
        ]} />
    </>
  );
}
