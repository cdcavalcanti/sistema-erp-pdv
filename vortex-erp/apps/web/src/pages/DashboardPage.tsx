import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorBox, Kpi, PageHeader } from '../components/ui';
import { BarList, Columns, ShareBar, TimeChart } from '../components/charts';
import { brl, date, pct, qty } from '../lib/format';
import { STAGES } from '../lib/orders';

interface Dashboard {
  date: string;
  revenue: { month: string; previousMonth: string; variationPercent: string; documents: number; averageTicket: string };
  margin: { value: string; percent: string };
  cash: { available: string; accounts: { code: string; name: string; balance: string }[] };
  delinquency: { overdue: string; open: string; titles: number; percent: string };
  idleStock: { value: string; products: number };
  targets: { id: string; name: string; target: string; achieved: string; percent: string }[];
  alerts: { code: string; title: string; severity: 'critical' | 'warning' | 'info'; link: string; count: number }[];
}
interface Charts {
  period: { from: string; to: string; days: number };
  daily: { date: string; orders: string; pdv: string; docs: number }[];
  channels: { channel: string; revenue: string; docs: number }[];
  topProducts: { sku: string; description: string; quantity: string; revenue: string; gross_margin: string }[];
  topCustomers: { name: string; revenue: string; docs: number }[];
  receivables: { bucket: string; amount: string; titles: number }[];
  payables: { bucket: string; amount: string; titles: number }[];
  cash: { today: string; forecast: { date: string; inflow: string; outflow: string; balance: string }[] };
  ordersByStage: { stage: string; orders: number; total: string }[];
  lowStock: { sku: string; description: string; reorder_point: string; available: string }[];
}
const KNOWN = ['/fiscal/', '/financeiro/', '/relatorios', '/compras/', '/aprovacoes', '/estoque', '/vendas/'];
const RANGES = [7, 30, 90] as const;
const ddmm = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const money = (v: number) => brl(v.toFixed(2));
// Vencidos em tons de alerta, a vencer em neutro: a faixa é a identidade, o rótulo diz qual é
const agingColor = (d: { bucket: string }) => (d.bucket.startsWith('Vencido') ? 'var(--bad)' : 'var(--series-4)');

/** Painel do dono (seção 19): indicadores do mês, gráficos do período e o que pede atenção. */
export default function DashboardPage() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/v1/dashboard/owner') });
  const c = useQuery({ queryKey: ['dashboard-charts', days], queryFn: () => api.get<Charts>('/v1/dashboard/owner/charts', { days }) });
  const d = q.data;
  const ch = c.data;
  const total = ch ? ch.daily.reduce((s, x) => s + Number(x.orders) + Number(x.pdv), 0) : 0;
  const pdvShare = ch && total ? ch.daily.reduce((s, x) => s + Number(x.pdv), 0) / total : 0;
  const pipeline = ch ? STAGES.filter((s) => !['delivered', 'cancelled'].includes(s.key)).map((s) => ({ ...s, ...(ch.ordersByStage.find((x) => x.stage === s.key) ?? { orders: 0, total: '0' }) })) : [];
  return (
    <>
      <PageHeader title="Painel do dono" subtitle={d ? `Posição em ${date(d.date)}` : undefined}
        actions={<div className="chips" role="group" aria-label="Período dos gráficos">
          {RANGES.map((r) => <button key={r} type="button" className="chip" aria-pressed={days === r} onClick={() => setDays(r)}>{r} dias</button>)}
        </div>} />
      <ErrorBox error={q.error ?? c.error} />
      {d && (
        <div className="stat-row">
          <Kpi label="Faturamento no mês" value={brl(d.revenue.month)} tone={Number(d.revenue.variationPercent) >= 0 ? 'up' : 'down'}
            delta={Number(d.revenue.previousMonth) ? `${Number(d.revenue.variationPercent) >= 0 ? '▲' : '▼'} ${pct(d.revenue.variationPercent)} sobre o mesmo período do mês anterior` : 'Sem mês anterior para comparar'} />
          <Kpi label="Margem bruta" value={brl(d.margin.value)} delta={`${pct(d.margin.percent)} do faturamento`} />
          <Kpi label="Ticket médio" value={brl(d.revenue.averageTicket)} delta={`${d.revenue.documents} notas no mês`} />
          <Kpi label="Caixa disponível" value={brl(d.cash.available)} delta={ch ? `Em 30 dias: ${brl(ch.cash.forecast.at(-1)?.balance ?? '0')}` : `${d.cash.accounts.length} conta(s)`}
            tone={ch && Number(ch.cash.forecast.at(-1)?.balance ?? 0) < 0 ? 'down' : undefined} />
          <Kpi label="Inadimplência" value={brl(d.delinquency.overdue)} delta={`${pct(d.delinquency.percent)} do a receber · ${d.delinquency.titles} título(s)`}
            tone={Number(d.delinquency.overdue) > 0 ? 'down' : undefined} />
        </div>
      )}
      {ch && (
        <div className="dash-grid">
          <section className="card panel span-8">
            <div className="panel-head"><h2>Faturamento por dia</h2><span className="muted">{brl(total.toFixed(2))} em {ch.period.days} dias · {(pdvShare * 100).toFixed(0)}% na loja física</span></div>
            <TimeChart data={ch.daily} x="date" stacked label="Faturamento diário: pedidos e loja física" format={money} xFormat={ddmm}
              series={[{ key: 'orders', label: 'Pedidos (NF-e)' }, { key: 'pdv', label: 'Loja física (PDV)' }]} />
          </section>
          <section className="card panel span-4">
            <div className="panel-head"><h2>Vendas por canal</h2></div>
            <ShareBar data={ch.channels} label={(x) => x.channel} value={(x) => Number(x.revenue)} format={money} />
          </section>

          <section className="card panel span-12">
            <div className="panel-head"><h2>Pedidos em andamento</h2><span className="spacer" /><Link to="/vendas/pedidos">Ver todos</Link></div>
            <div className="pipeline">
              {pipeline.map((s) => (
                <Link key={s.key} to={`/vendas/pedidos?etapa=${s.key}`} title={s.hint}>
                  <small>{s.short}</small><b>{s.orders}</b><small>{brl(s.total)}</small>
                </Link>
              ))}
            </div>
          </section>

          <section className="card panel span-6">
            <div className="panel-head"><h2>Produtos mais vendidos</h2><span className="muted">por faturamento</span></div>
            <BarList data={ch.topProducts} label={(x) => `${x.description}`} value={(x) => Number(x.revenue)} format={money}
              sub={(x) => `${qty(x.quantity)} un · margem ${brl(x.gross_margin)}`} />
          </section>
          <section className="card panel span-6">
            <div className="panel-head"><h2>Maiores clientes</h2></div>
            <BarList data={ch.topCustomers} label={(x) => x.name} value={(x) => Number(x.revenue)} format={money} color={() => 'var(--series-2)'}
              sub={(x) => `${x.docs} nota(s)`} />
          </section>

          <section className="card panel span-6">
            <div className="panel-head"><h2>A receber por vencimento</h2><span className="muted">{brl(ch.receivables.reduce((s, x) => s + Number(x.amount), 0).toFixed(2))} em aberto</span></div>
            <Columns data={ch.receivables} label={(x) => x.bucket} value={(x) => Number(x.amount)} format={money} color={agingColor} ariaLabel="Títulos a receber por faixa de vencimento" />
          </section>
          <section className="card panel span-6">
            <div className="panel-head"><h2>A pagar por vencimento</h2><span className="muted">{brl(ch.payables.reduce((s, x) => s + Number(x.amount), 0).toFixed(2))} em aberto</span></div>
            <Columns data={ch.payables} label={(x) => x.bucket} value={(x) => Number(x.amount)} format={money} color={agingColor} ariaLabel="Títulos a pagar por faixa de vencimento" />
          </section>

          <section className="card panel span-8">
            <div className="panel-head"><h2>Saldo projetado (30 dias)</h2><span className="muted">caixa e bancos hoje + a receber − a pagar, pelo vencimento</span></div>
            <TimeChart data={ch.cash.forecast} x="date" label="Saldo de caixa projetado" format={money} xFormat={ddmm} series={[{ key: 'balance', label: 'Saldo projetado' }]} height={180} />
          </section>
          <section className="card panel span-4">
            <div className="panel-head"><h2>Estoque no ponto de pedido</h2><span className="spacer" /><Link to="/estoque">Estoque</Link></div>
            {ch.lowStock.length === 0 ? <p className="muted">Nenhum produto abaixo do ponto de pedido. 👍</p> : (
              <ul className="plain-list">{ch.lowStock.map((p) => (
                <li key={p.sku}><span>{p.description}</span><b className={Number(p.available) <= 0 ? 'down' : ''}>{qty(p.available)}</b><small className="muted">ponto {qty(p.reorder_point)}</small></li>
              ))}</ul>
            )}
          </section>

          {d && (
            <section className="card panel span-6">
              <div className="panel-head"><h2>Pede atenção</h2></div>
              {d.alerts.filter((a) => a.count > 0).length === 0 && <span className="muted">Nada pendente. 👍</span>}
              {d.alerts.filter((a) => a.count > 0).map((a) => (
                <div key={a.code} className={`alert ${a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : ''}`}>
                  <strong>{a.count}</strong> · {KNOWN.some((k) => a.link.startsWith(k)) ? <Link to={a.link}>{a.title}</Link> : a.title}
                </div>
              ))}
            </section>
          )}
          {d && (
            <section className="card panel span-6">
              <div className="panel-head"><h2>Contas e estoque parado</h2></div>
              {d.cash.accounts.map((a) => <div key={a.code} className="row"><span>{a.name}</span><span className="spacer" /><strong>{brl(a.balance)}</strong></div>)}
              <div className="row"><span>Estoque parado há 90 dias ({d.idleStock.products} produtos)</span><span className="spacer" /><strong>{brl(d.idleStock.value)}</strong></div>
              {d.targets.map((t) => (
                <div key={t.id}>
                  <div className="row"><span>Meta: {t.name}</span><span className="spacer" /><span>{brl(t.achieved)} de {brl(t.target)} ({pct(t.percent)})</span></div>
                  <div className="bar"><span style={{ width: `${Math.min(100, Number(t.percent))}%` }} /></div>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </>
  );
}
