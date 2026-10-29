import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { D } from '@vortex/money';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable } from '../../components/DataTable';
import { Dialog, ErrorBox, Field, Input, PageHeader, Select, Status, useToast } from '../../components/ui';
import { brl, date, today } from '../../lib/format';
import { usePaged } from '../../lib/hooks';

interface Title {
  id: string; kind: 'receivable' | 'payable'; document_number: string; installment: number; installments_total: number; party_name: string; issue_date: string; due_date: string;
  amount: string; balance: string; status: string; overdue: boolean; approved_at: string | null; digitable_line: string | null; pix_qr_code: string | null;
}
interface TitleDetail extends Title {
  chargesToday: { fine: string; interest: string; daysLate: number } | null;
  settlements: { id: string; settlement_date: string; total: string; principal: string; kind: string; reversed: boolean }[];
  charges: { id: string; kind: string; amount: string; status: string; qr_code: string | null; digitable_line: string | null }[];
}

/** Contas a receber e a pagar (seção 13): vencimentos, baixa com encargos, cobrança e aprovação. */
export default function TitlesPage() {
  const [params, setParams] = useSearchParams();
  const kind = (params.get('tipo') ?? 'receivable') as 'receivable' | 'payable';
  const overdue = params.get('vencidas') === '1';
  const [status, setStatus] = useState('');
  const list = usePaged<Title>(['titles'], '/v1/finance/titles', { kind, overdue: overdue || undefined, status: status || undefined });
  const openId = params.get('abrir');
  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v === null) p.delete(k); else p.set(k, v);
    setParams(p);
  };
  const totalOpen = list.rows.filter((t) => ['open', 'partially_paid'].includes(t.status)).reduce((a, t) => a.plus(t.balance), D(0));
  return (
    <>
      <PageHeader title={kind === 'receivable' ? 'Contas a receber' : 'Contas a pagar'} subtitle={`Em aberto na lista: ${brl(totalOpen.toFixed(2))}`} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={kind === 'receivable'} onClick={() => set({ tipo: 'receivable' })}>A receber</button>
        <button role="tab" aria-selected={kind === 'payable'} onClick={() => set({ tipo: 'payable' })}>A pagar</button>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="check"><input type="checkbox" checked={overdue} onChange={(e) => set({ vencidas: e.target.checked ? '1' : null })} /> Só vencidos</label>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Situação">
          <option value="">Todas as situações</option><option value="open">Abertos</option><option value="partially_paid">Pagos parcialmente</option><option value="paid">Pagos</option>
          <option value="renegotiated">Renegociados</option><option value="cancelled">Cancelados</option>
        </Select>
      </div>
      <ErrorBox error={list.error} />
      <DataTable rows={list.rows} rowKey={(r) => r.id} label="Títulos" height="calc(100vh - 280px)" onOpen={(r) => set({ abrir: r.id })}
        footer={list.hasNextPage && <button className="btn sm" onClick={() => list.fetchNextPage()}>Carregar mais</button>}
        columns={[
          { key: 'due_date', label: 'Vencimento', type: 'date', width: '110px', render: (r) => <span className={r.overdue ? 'down' : undefined}>{date(r.due_date)}</span>, sortValue: (r) => r.due_date },
          { key: 'document_number', label: 'Documento', width: '170px', render: (r) => `${r.document_number}${r.installments_total > 1 ? ` ${r.installment}/${r.installments_total}` : ''}` },
          { key: 'party_name', label: kind === 'receivable' ? 'Cliente' : 'Fornecedor', width: 'minmax(200px, 3fr)' },
          { key: 'amount', label: 'Valor', type: 'money', width: '120px', hideOnMobile: true },
          { key: 'balance', label: 'Saldo', type: 'money', width: '120px' },
          { key: 'status', label: 'Situação', width: '150px', render: (r) => <>{<Status value={r.status} />}{r.kind === 'payable' && r.status === 'open' && !r.approved_at && <span className="badge warn" style={{ marginLeft: 4 }}>a aprovar</span>}</> },
        ]} />
      {openId && <TitleDialog id={openId} onClose={() => set({ abrir: null })} />}
    </>
  );
}

function TitleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['title', id], queryFn: () => api.get<TitleDetail>(`/v1/finance/titles/${id}`) });
  const accounts = useQuery({ queryKey: ['financial-accounts'], queryFn: () => api.get<{ id: string; code: string; name: string; kind: string; active: boolean }[]>('/v1/financial-accounts') });
  const [form, setForm] = useState({ date: today(), accountId: '', amount: '' });
  const t = q.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['title', id] });
    qc.invalidateQueries({ queryKey: ['titles'] });
  };
  const due = t ? D(t.balance).plus(t.chargesToday?.fine ?? 0).plus(t.chargesToday?.interest ?? 0).toFixed(2) : '';
  const settle = useMutation({
    mutationFn: () => api.post(`/v1/finance/titles/${id}/settle`, { date: form.date, accountId: form.accountId || accounts.data?.find((a) => a.kind !== 'acquirer')?.id, amount: (form.amount || due).replace(',', '.') }),
    onSuccess: () => { toast('Baixa registrada'); refresh(); },
  });
  const approve = useMutation({ mutationFn: () => api.post(`/v1/finance/titles/${id}/approve`), onSuccess: () => { toast('Pagamento aprovado'); refresh(); } });
  const charge = useMutation({ mutationFn: (kind: 'boleto' | 'pix_cob') => api.post(`/v1/finance/titles/${id}/charge`, { kind }), onSuccess: () => { toast('Cobrança registrada'); refresh(); } });
  const open = t && ['open', 'partially_paid'].includes(t.status);
  return (
    <Dialog title={t ? `${t.kind === 'receivable' ? 'A receber' : 'A pagar'} — ${t.document_number}` : 'Título'} onClose={onClose} wide>
      <ErrorBox error={q.error ?? settle.error ?? approve.error ?? charge.error} />
      {t && (
        <div className="stack">
          <div className="grid-4">
            <Field label={t.kind === 'receivable' ? 'Cliente' : 'Fornecedor'}><span>{t.party_name}</span></Field>
            <Field label="Vencimento"><span>{date(t.due_date)}</span></Field>
            <Field label="Valor / saldo"><span>{brl(t.amount)} / <strong>{brl(t.balance)}</strong></span></Field>
            <Field label="Situação"><Status value={t.status} /></Field>
          </div>
          {t.chargesToday && t.chargesToday.daysLate > 0 && (
            <div className="alert warn">{t.chargesToday.daysLate} dia(s) de atraso: multa {brl(t.chargesToday.fine)} + juros {brl(t.chargesToday.interest)} = <strong>{brl(due)}</strong> hoje.</div>
          )}
          {t.digitable_line && <Field label="Linha digitável"><Input readOnly className="mono" value={t.digitable_line} /></Field>}
          {t.pix_qr_code && <Field label="Pix copia e cola"><Input readOnly className="mono" value={t.pix_qr_code} onFocus={(e) => e.target.select()} /></Field>}
          {open && t.kind === 'payable' && !t.approved_at && can('financeiro.titulo.aprovar') && (
            <div className="row"><span className="muted">Pagamento ainda não aprovado (quem lançou não aprova — segregação de funções).</span><span className="spacer" />
              <button className="btn" disabled={approve.isPending} onClick={() => approve.mutate()}>Aprovar pagamento</button></div>
          )}
          {open && t.kind === 'receivable' && can('financeiro.titulo.criar') && (
            <div className="row"><span className="muted">Cobrança:</span>
              <button className="btn sm" disabled={charge.isPending} onClick={() => charge.mutate('boleto')}>Emitir boleto</button>
              <button className="btn sm" disabled={charge.isPending} onClick={() => charge.mutate('pix_cob')}>Gerar Pix</button></div>
          )}
          {open && can('financeiro.titulo.baixar') && (
            <section className="card card-pad stack">
              <h3>Registrar {t.kind === 'receivable' ? 'recebimento' : 'pagamento'}</h3>
              <div className="grid-3">
                <Field label="Data"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
                <Field label="Conta">
                  <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })}>
                    {(accounts.data ?? []).filter((a) => a.active && a.kind !== 'acquirer').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
                </Field>
                <Field label="Valor" hint={`Sugerido: ${brl(due)}`}><Input className="num" inputMode="decimal" placeholder={due} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></Field>
              </div>
              <div className="row"><span className="spacer" /><button className="btn primary" disabled={settle.isPending} onClick={() => settle.mutate()}>Baixar</button></div>
            </section>
          )}
          {t.settlements.length > 0 && (
            <>
              <h3>Baixas</h3>
              <table className="lines"><thead><tr><th>Data</th><th>Tipo</th><th className="num">Principal</th><th className="num">Total</th><th /></tr></thead>
                <tbody>{t.settlements.map((s) => <tr key={s.id}><td>{date(s.settlement_date)}</td><td>{s.kind}</td><td className="num">{brl(s.principal)}</td><td className="num">{brl(s.total)}</td>
                  <td>{s.reversed && <span className="badge bad">estornada</span>}</td></tr>)}</tbody></table>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
