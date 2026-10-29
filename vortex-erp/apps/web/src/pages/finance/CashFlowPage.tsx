import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { D, type Decimal } from '@vortex/money';
import { api } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { ErrorBox, Input, Kpi, PageHeader, Select } from '../../components/ui';
import { brl, date, today } from '../../lib/format';

interface CashFlow { openingBalance: string; rows: { period: string; realizedIn: string; realizedOut: string; projectedIn: string; projectedOut: string; balance: string }[] }
const plus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Fluxo de caixa realizado e projetado (títulos a vencer, pedidos e contratos). */
export default function CashFlowPage() {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(plus(60));
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('week');
  const q = useQuery({ queryKey: ['cashflow', from, to, granularity], queryFn: () => api.get<CashFlow>('/v1/finance/cash-flow', { from, to, granularity }) });
  const rows = q.data?.rows ?? [];
  const min = rows.reduce<{ v: Decimal | null; p: string }>((a, r) => (a.v === null || D(r.balance).lessThan(a.v) ? { v: D(r.balance), p: r.period } : a), { v: null, p: '' });
  return (
    <>
      <PageHeader title="Fluxo de caixa" actions={<>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="De" style={{ width: 'auto' }} />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Até" style={{ width: 'auto' }} />
        <Select value={granularity} onChange={(e) => setGranularity(e.target.value as 'day')} style={{ width: 'auto' }} aria-label="Agrupar por">
          <option value="day">Diário</option><option value="week">Semanal</option><option value="month">Mensal</option>
        </Select>
      </>} />
      <ErrorBox error={q.error} />
      {q.data && (
        <div className="grid-3" style={{ marginBottom: 12 }}>
          <Kpi label="Saldo inicial" value={brl(q.data.openingBalance)} />
          <Kpi label="Saldo final projetado" value={brl(rows.at(-1)?.balance ?? q.data.openingBalance)} />
          <Kpi label="Menor saldo no período" value={min.v ? brl(min.v.toFixed(2)) : '—'} delta={min.p ? `em ${date(min.p)}` : undefined} tone={min.v?.isNegative() ? 'down' : undefined} />
        </div>
      )}
      <DataTable rows={rows} rowKey={(r) => r.period} label="Fluxo de caixa" height="calc(100vh - 300px)" columns={[
        { key: 'period', label: 'Período', type: 'date', width: '120px' },
        { key: 'realizedIn', label: 'Entradas realizadas', type: 'money' },
        { key: 'realizedOut', label: 'Saídas realizadas', type: 'money' },
        { key: 'projectedIn', label: 'A receber', type: 'money' },
        { key: 'projectedOut', label: 'A pagar', type: 'money' },
        { key: 'balance', label: 'Saldo', type: 'money', render: (r) => <strong className={D(r.balance).isNegative() ? 'down' : undefined}>{brl(r.balance)}</strong> },
      ]} />
    </>
  );
}
