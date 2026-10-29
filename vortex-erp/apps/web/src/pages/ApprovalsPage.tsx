import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { DataTable } from '../components/DataTable';
import { Dialog, ErrorBox, Field, PageHeader, useToast } from '../components/ui';
import { brl, dateTime } from '../lib/format';

interface Approval { id: string; entity_type: string; action: string; reason: string; value: string | null; required_approvals: number; approvals: number; created_at: string }

const ENTITY: Record<string, string> = { sales_order: 'Pedido de venda', purchase_order: 'Pedido de compra', party_bank_account: 'Conta bancária', expense_reimbursement: 'Reembolso',
  stock_movement: 'Movimento de estoque', title: 'Título' };

/** Aprovações (seção 04): alçadas e segregação de funções; quem pediu não aprova o próprio pedido. */
export default function ApprovalsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['approvals'], queryFn: () => api.get<Approval[]>('/v1/approvals') });
  const [open, setOpen] = useState<Approval | null>(null);
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (d: 'approve' | 'reject') => api.post(`/v1/approvals/${open!.id}/decision`, { decision: d, comment: comment || undefined }),
    onSuccess: (_r, d) => {
      toast(d === 'approve' ? 'Aprovado' : 'Rejeitado');
      setOpen(null);
      setComment('');
      qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
  return (
    <>
      <PageHeader title="Aprovações" subtitle="Solicitações que você pode decidir" />
      <ErrorBox error={q.error} />
      <DataTable rows={q.data ?? []} rowKey={(r) => r.id} onOpen={setOpen} label="Aprovações pendentes" columns={[
        { key: 'entity_type', label: 'Tipo', width: '160px', render: (r) => ENTITY[r.entity_type] ?? r.entity_type },
        { key: 'reason', label: 'Motivo', width: 'minmax(220px, 3fr)' },
        { key: 'value', label: 'Valor', type: 'money', width: '130px' },
        { key: 'approvals', label: 'Votos', width: '80px', render: (r) => `${r.approvals}/${r.required_approvals}` },
        { key: 'created_at', label: 'Pedido em', width: '150px', render: (r) => dateTime(r.created_at), hideOnMobile: true },
      ]} />
      {open && (
        <Dialog title={ENTITY[open.entity_type] ?? open.entity_type} onClose={() => setOpen(null)} footer={<>
          <button className="btn danger" disabled={decide.isPending} onClick={() => decide.mutate('reject')}>Rejeitar</button>
          <button className="btn primary" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>Aprovar</button>
        </>}>
          <div className="stack">
            <p style={{ margin: 0 }}>{open.reason}</p>
            {open.value && <p style={{ margin: 0 }}>Valor: <strong>{brl(open.value)}</strong></p>}
            <Field label="Comentário (opcional)"><textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
            <ErrorBox error={decide.error} />
          </div>
        </Dialog>
      )}
    </>
  );
}
