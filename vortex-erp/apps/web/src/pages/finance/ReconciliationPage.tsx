import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { ErrorBox, PageHeader, Select, useToast } from '../../components/ui';
import { brl, date } from '../../lib/format';

interface Line { id: string; line_date: string; amount: string; description: string; status: string }
interface Suggestion {
  kind: 'movement' | 'titles' | 'category'; score: number; reason: string; movementIds?: string[];
  titles?: { titleId: string; documentNumber: string; party: string; balance: string; dueDate: string }[]; categoryId?: string;
}

/**
 * Conciliação lado a lado (seção 13): extrato à esquerda, sugestões do sistema à direita, ordenadas
 * por probabilidade; cada escolha ensina a memória de conciliação. ↑/↓ trocam de linha, 1–9 aceitam.
 */
export default function ReconciliationPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useQuery({ queryKey: ['financial-accounts'], queryFn: () => api.get<{ id: string; name: string; kind: string; active: boolean }[]>('/v1/financial-accounts') });
  const banks = (accounts.data ?? []).filter((a) => a.active && a.kind === 'bank');
  const [accountId, setAccountId] = useState('');
  useEffect(() => {
    if (!accountId && banks[0]) setAccountId(banks[0].id);
  }, [banks, accountId]);
  const lines = useQuery({ queryKey: ['stmt-lines', accountId], enabled: !!accountId, queryFn: () => api.get<Line[]>(`/v1/finance/accounts/${accountId}/statement-lines`, { status: 'pending' }) });
  const [sel, setSel] = useState(0);
  const line = lines.data?.[sel];
  const sugg = useQuery({ queryKey: ['stmt-sugg', line?.id], enabled: !!line, queryFn: () => api.get<Suggestion[]>(`/v1/finance/statement-lines/${line!.id}/suggestions`) });
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['stmt-lines', accountId] });
    qc.invalidateQueries({ queryKey: ['titles'] });
  };
  const importOfx = useMutation({
    mutationFn: async (f: File) => api.post<{ imported: number; duplicates: number; autoReconciled: number }>(`/v1/finance/accounts/${accountId}/statements`, { content: await f.text(), fileName: f.name }),
    onSuccess: (r) => { toast(`${r.imported} linha(s) importadas${r.duplicates ? ` (${r.duplicates} já existiam)` : ''}, ${r.autoReconciled} conciliadas automaticamente`); refresh(); },
  });
  const accept = useMutation({
    mutationFn: (s: Suggestion) => api.post('/v1/finance/reconciliations', {
      lineIds: [line!.id],
      ...(s.kind === 'movement' ? { movementIds: s.movementIds } : s.kind === 'titles' ? { titles: s.titles!.map((t) => ({ titleId: t.titleId })) } : { newMovement: { categoryId: s.categoryId } }),
    }),
    onSuccess: () => { toast('Conciliado'); refresh(); },
  });
  const ignore = useMutation({ mutationFn: () => api.post(`/v1/finance/statement-lines/${line!.id}/ignore`), onSuccess: () => { toast('Linha ignorada'); refresh(); } });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min((lines.data?.length ?? 1) - 1, s + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
      else if (/^[1-9]$/.test(e.key) && sugg.data?.[Number(e.key) - 1] && !accept.isPending) accept.mutate(sugg.data[Number(e.key) - 1]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lines.data, sugg.data, accept]);
  return (
    <>
      <PageHeader title="Conciliação bancária" subtitle={<span className="hide-sm"><kbd>↑</kbd> <kbd>↓</kbd> trocam de linha · <kbd>1</kbd>–<kbd>9</kbd> aceitam a sugestão</span>}
        actions={<>
          <Select value={accountId} onChange={(e) => { setAccountId(e.target.value); setSel(0); }} style={{ width: 'auto' }} aria-label="Conta">
            {banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
          <input ref={file} type="file" accept=".ofx,.OFX" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importOfx.mutate(f); e.target.value = ''; }} />
          <button className="btn primary" disabled={!accountId || importOfx.isPending} onClick={() => file.current?.click()}>Importar OFX</button>
        </>} />
      <ErrorBox error={lines.error ?? importOfx.error ?? accept.error ?? ignore.error} />
      <div className="recon">
        <section className="card">
          <div className="card-head"><h2>Extrato</h2><span className="spacer" /><span className="muted">{lines.data?.length ?? 0} pendente(s)</span></div>
          {(lines.data ?? []).length === 0 && <div className="empty">Nada pendente. Importe um extrato OFX.</div>}
          {(lines.data ?? []).map((l, i) => (
            <div key={l.id} className={`recon-line${i === sel ? ' active' : ''}`} onClick={() => setSel(i)} role="button" aria-pressed={i === sel}>
              <span className="muted" style={{ width: 80 }}>{date(l.line_date)}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</span>
              <strong className={Number(l.amount) < 0 ? 'down' : 'up'}>{brl(l.amount)}</strong>
            </div>
          ))}
        </section>
        <section className="card">
          <div className="card-head"><h2>Sugestões</h2><span className="spacer" />{line && <button className="btn sm" onClick={() => ignore.mutate()}>Ignorar linha</button>}</div>
          {!line && <div className="empty">Escolha uma linha do extrato.</div>}
          {line && sugg.data?.length === 0 && <div className="empty">Sem sugestão. Lance o título ou a despesa e volte aqui.</div>}
          <div className="card-pad stack">
            {(sugg.data ?? []).map((s, i) => (
              <div key={i} className="card card-pad stack" style={{ gap: 6 }}>
                <div className="row"><kbd>{i + 1}</kbd><strong>{s.kind === 'movement' ? 'Movimento já lançado' : s.kind === 'titles' ? 'Baixar título(s)' : 'Lançar na categoria'}</strong>
                  <span className="spacer" /><span className="badge info">{Math.round(s.score * 100)}%</span></div>
                <span className="muted">{s.reason}</span>
                {s.titles?.map((t) => <div key={t.titleId} className="row"><span>{t.documentNumber} · {t.party}</span><span className="spacer" /><span>{brl(t.balance)} · {date(t.dueDate)}</span></div>)}
                <div className="row"><span className="spacer" /><button className="btn sm primary" disabled={accept.isPending} onClick={() => accept.mutate(s)}>Aceitar</button></div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
