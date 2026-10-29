import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable } from '../../components/DataTable';
import { ErrorBox, PageHeader, Select, Status, useToast } from '../../components/ui';
import { brl } from '../../lib/format';

interface Receipt { id: string; number: string; series: string; issue_date: string; status: string; without_order: boolean; blind_count: boolean; total_invoice: string | null; supplier_name: string }
interface PurchaseOrder { id: string; number: string; created_at: string; status: string; supplier_name: string; total: string; expected_date: string | null }
const PO_STATUS: Record<string, string> = { draft: 'Rascunho', pending_approval: 'Em aprovação', approved: 'Aprovado', partially_received: 'Recebido em parte', received: 'Recebido', cancelled: 'Cancelado' };
const RECEIPT_STATUS: Record<string, string> = { pre_receipt: 'Pré-recebimento', checking: 'Em conferência', divergent: 'Divergente', completed: 'Concluído', cancelled: 'Cancelado' };

/** Recebimento (seção 11): importa o XML do fornecedor, faz o de-para, confere e conclui. */
export default function ReceiptsPage() {
  const { can, me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const view = params.get('ver') ?? 'notas';
  const orders = useQuery({ queryKey: ['purchase-orders'], enabled: view === 'pedidos', queryFn: () => api.get<PurchaseOrder[]>('/v1/purchasing/orders') });
  const q = useQuery({ queryKey: ['receipts', status], queryFn: () => api.get<Receipt[]>('/v1/purchasing/receipts', { status: status || undefined }) });
  const ests = useQuery({ queryKey: ['establishments'], queryFn: () => api.get<{ id: string; code: string }[]>('/v1/establishments') });
  const [establishmentId, setEstablishmentId] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const importXml = useMutation({
    mutationFn: async (f: File) => api.post<{ id: string }>('/v1/purchasing/receipts', { establishmentId: establishmentId || ests.data?.find((e) => !me?.establishmentIds || me.establishmentIds.includes(e.id))?.id, xml: await f.text() }),
    onSuccess: (r) => {
      toast('Nota importada');
      qc.invalidateQueries({ queryKey: ['receipts'] });
      nav(`/compras/recebimentos/${r.id}`);
    },
  });
  return (
    <>
      <PageHeader title="Compras" subtitle="Pedidos de compra e notas recebidas dos fornecedores (nota × pedido × conferência física)"
        actions={can('compras.recebimento.criar') && <>
          <Select value={establishmentId} onChange={(e) => setEstablishmentId(e.target.value)} style={{ width: 'auto' }} aria-label="Estabelecimento">
            {(ests.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.code}</option>)}
          </Select>
          <input ref={file} type="file" accept=".xml,text/xml,application/xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importXml.mutate(f); e.target.value = ''; }} />
          <button className="btn primary" disabled={importXml.isPending} onClick={() => file.current?.click()}>{importXml.isPending ? 'Importando…' : 'Importar XML da NF-e'}</button>
        </>} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={view === 'notas'} onClick={() => setParams({})}>Notas recebidas</button>
        <button role="tab" aria-selected={view === 'pedidos'} onClick={() => setParams({ ver: 'pedidos' })}>Pedidos de compra</button>
      </div>
      {view === 'pedidos' ? (
        <>
          <ErrorBox error={orders.error} />
          <DataTable rows={orders.data ?? []} rowKey={(r) => r.id} label="Pedidos de compra" height="calc(100vh - 260px)"
            empty={<div className="empty-state"><b>Nenhum pedido de compra</b>Pedidos de compra são criados pela API ou a partir da sugestão de compra.</div>}
            columns={[
              { key: 'number', label: 'Nº', type: 'number', width: '80px' },
              { key: 'created_at', label: 'Data', type: 'date', width: '110px' },
              { key: 'supplier_name', label: 'Fornecedor', width: 'minmax(200px, 3fr)' },
              { key: 'expected_date', label: 'Previsão', type: 'date', width: '110px', hideOnMobile: true },
              { key: 'total', label: 'Total', type: 'money', width: '130px' },
              { key: 'status', label: 'Situação', width: '160px', render: (r) => <Status value={r.status} label={PO_STATUS[r.status]} /> },
            ]} />
        </>
      ) : (
      <>
      <div className="chips" role="group" aria-label="Situação" style={{ marginBottom: 12 }}>
        {['', 'pre_receipt', 'checking', 'divergent', 'completed'].map((s) => (
          <button key={s} type="button" className="chip" aria-pressed={status === s} onClick={() => setParams(s ? { status: s } : {})}>{s ? RECEIPT_STATUS[s] : 'Todas'}</button>
        ))}
      </div>
      <ErrorBox error={q.error ?? importXml.error} />
      <DataTable rows={q.data ?? []} rowKey={(r) => r.id} label="Recebimentos" height="calc(100vh - 260px)" onOpen={(r) => nav(`/compras/recebimentos/${r.id}`)} columns={[
        { key: 'number', label: 'Nota', width: '110px', render: (r) => `${r.number}/${r.series}` },
        { key: 'issue_date', label: 'Emissão', type: 'date', width: '110px' },
        { key: 'supplier_name', label: 'Fornecedor', width: 'minmax(200px, 3fr)' },
        { key: 'total_invoice', label: 'Valor', type: 'money', width: '130px', render: (r) => (r.total_invoice === null ? <span className="muted">conferência cega</span> : brl(r.total_invoice)) },
        { key: 'without_order', label: 'Pedido', width: '110px', render: (r) => (r.without_order ? <span className="badge warn">Sem pedido</span> : <span className="badge">Com pedido</span>), hideOnMobile: true },
        { key: 'status', label: 'Situação', width: '150px', render: (r) => <Status value={r.status} label={RECEIPT_STATUS[r.status]} /> },
      ]} />
      <p className="muted" style={{ fontSize: 12 }}>Notas recebidas também chegam pela distribuição DF-e (manifestação) e entram aqui como pré-recebimento.</p>
      </>
      )}
    </>
  );
}
