import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { D } from '@vortex/money';
import { api } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { ErrorBox, Input, PageHeader } from '../../components/ui';
import { brl, date } from '../../lib/format';

interface Balance { product_id: string; warehouse_id: string; lot_id: string | null; sku: string; description: string; stock_unit: string; warehouse_code: string; lot_number: string | null;
  expires_at: string | null; quantity: string; reserved: string; blocked: string; available: string; avg_cost: string | null; value: string }

export default function StockPage() {
  const q = useQuery({ queryKey: ['balances-all'], queryFn: () => api.get<Balance[]>('/v1/stock/balances') });
  const [f, setF] = useState('');
  const rows = useMemo(() => (q.data ?? []).filter((b) => !f || `${b.sku} ${b.description} ${b.lot_number ?? ''}`.toLowerCase().includes(f.toLowerCase())), [q.data, f]);
  const total = rows.reduce((a, b) => a.plus(b.value || 0), D(0));
  return (
    <>
      <PageHeader title="Saldos de estoque" subtitle={`Valor em estoque (custo médio): ${brl(total.toFixed(2))}`} />
      <div className="row" style={{ marginBottom: 10 }}><Input placeholder="Filtrar por SKU, descrição ou lote" value={f} onChange={(e) => setF(e.target.value)} style={{ maxWidth: 360 }} aria-label="Filtrar" /></div>
      <ErrorBox error={q.error} />
      <DataTable rows={rows} rowKey={(r) => `${r.product_id}-${r.warehouse_id}-${r.lot_id ?? ''}`} label="Saldos" height="calc(100vh - 230px)" columns={[
        { key: 'sku', label: 'SKU', width: '130px', render: (r) => <span className="mono">{r.sku}</span> },
        { key: 'description', label: 'Descrição', width: 'minmax(200px, 3fr)' },
        { key: 'warehouse_code', label: 'Depósito', width: '110px', hideOnMobile: true },
        { key: 'lot_number', label: 'Lote', width: '110px', hideOnMobile: true, render: (r) => r.lot_number ? <>{r.lot_number}{r.expires_at && <span className="muted"> · {date(r.expires_at)}</span>}</> : '' },
        { key: 'quantity', label: 'Físico', type: 'qty', width: '90px' },
        { key: 'reserved', label: 'Reservado', type: 'qty', width: '90px', hideOnMobile: true },
        { key: 'available', label: 'Disponível', type: 'qty', width: '90px' },
        { key: 'avg_cost', label: 'Custo médio', type: 'money', width: '110px', hideOnMobile: true },
        { key: 'value', label: 'Valor', type: 'money', width: '120px' },
      ]} />
    </>
  );
}
