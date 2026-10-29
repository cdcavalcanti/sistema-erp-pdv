import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, PageHeader, Select, Status, useToast } from '../../components/ui';
import { brl, date, dateTime } from '../../lib/format';

interface Draft { id: string; kind: string; status: string; title: string; payload: Record<string, any>; confidence: string | null; source: 'ai' | 'rules'; created_at: string }
interface Anomaly { id: string; kind: string; severity: string; message: string; status: string; detected_at: string }

const KIND: Record<string, string> = { payable_title: 'Conta a pagar', ncm_classification: 'Classificação fiscal', renegotiation: 'Acordo de cobrança', purchase_suggestion: 'Sugestão de compra' };
const TABS = ['Conversa', 'Para confirmar', 'Ler documento', 'Previsão de demanda', 'Anomalias'] as const;

/**
 * IA dentro do ERP (seção 20): converse com a assistente sobre qualquer parte da operação (ela
 * só lê); o que ela prepara para lançar vira rascunho e só acontece quando alguém confirma (RN-IA-01).
 */
export default function AssistantPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Conversa');
  const drafts = useQuery({ queryKey: ['ai-drafts'], queryFn: () => api.get<Draft[]>('/v1/ai/drafts', { status: 'pending' }) });
  return (
    <>
      <PageHeader title="Assistente VORTEX" subtitle="Pergunte sobre vendas, pedidos, PDV, estoque, financeiro e impostos. Ela consulta os dados; você decide." />
      <div className="tabs" role="tablist">{TABS.map((t) => (
        <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}{t === 'Para confirmar' && drafts.data?.length ? ` (${drafts.data.length})` : ''}</button>
      ))}</div>
      {tab === 'Conversa' && <Chat />}
      {tab === 'Para confirmar' && <Drafts />}
      {tab === 'Ler documento' && <ReadDocument onDone={() => setTab('Para confirmar')} />}
      {tab === 'Previsão de demanda' && <Forecast onDone={() => setTab('Para confirmar')} />}
      {tab === 'Anomalias' && <Anomalies />}
    </>
  );
}

interface Conversation { id: string; title: string; updated_at: string; messages: number }
interface Message { id: string; role: 'user' | 'assistant'; content: string; source: 'ai' | 'rules' | null; tool_calls: { name: string; ok: boolean }[]; created_at: string }
const SUGGESTIONS = [
  'Como está a operação hoje?',
  'Quais pedidos estão parados esperando faturamento ou despacho?',
  'Quanto vendi este mês e quanto foi na loja física?',
  'Quem está me devendo há mais tempo?',
  'Quais produtos estão acabando?',
  'Quanto vou pagar de ICMS este mês?',
];
const TOOL_LABEL: Record<string, string> = {
  operation_overview: 'visão geral', owner_dashboard: 'painel', sales_charts: 'vendas do período', orders_by_stage: 'pedidos por etapa', list_orders: 'pedidos',
  pdv_sales: 'vendas do PDV', tax_assessment: 'apuração de impostos', suppliers: 'fornecedores', overdue_titles: 'títulos vencidos', fiscal_problems: 'notas com problema',
  run_report: 'relatório', list_reports: 'relatórios', search_products: 'produtos', list_establishments: 'filiais',
};

function Chat() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['ai-conversations'], queryFn: () => api.get<Conversation[]>('/v1/ai/conversations') });
  const conv = useQuery({ queryKey: ['ai-conversation', current], enabled: Boolean(current), queryFn: () => api.get<{ id: string; title: string; messages: Message[] }>(`/v1/ai/conversations/${current}`) });
  const end = useRef<HTMLDivElement>(null);
  const send = useMutation({
    mutationFn: (message: string) => api.post<{ conversationId: string }>('/v1/ai/chat', { conversationId: current, message }),
    onMutate: (message) => { setPending(message); setText(''); setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 50); },
    onSuccess: (r) => {
      setCurrent(r.conversationId);
      qc.invalidateQueries({ queryKey: ['ai-conversation', r.conversationId] });
      qc.invalidateQueries({ queryKey: ['ai-conversations'] });
    },
    onSettled: () => { setPending(null); setTimeout(() => end.current?.scrollIntoView({ behavior: 'smooth' }), 120); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/v1/ai/conversations/${id}`),
    onSuccess: (_r, id) => { if (id === current) setCurrent(null); qc.invalidateQueries({ queryKey: ['ai-conversations'] }); },
  });
  const messages = current ? conv.data?.messages ?? [] : [];
  const submit = (m: string) => { if (m.trim() && !send.isPending) send.mutate(m.trim()); };
  return (
    <div className="chat-layout">
      <aside className="chat-list card">
        <button className="btn primary" onClick={() => setCurrent(null)}>+ Nova conversa</button>
        <ul>{(list.data ?? []).map((c) => (
          <li key={c.id} className={c.id === current ? 'active' : ''}>
            <button className="chat-item" onClick={() => setCurrent(c.id)}><span>{c.title}</span><small>{dateTime(c.updated_at)}</small></button>
            <button className="chat-del" aria-label={`Apagar conversa ${c.title}`} title="Apagar" onClick={() => remove.mutate(c.id)}>×</button>
          </li>
        ))}</ul>
        {list.data?.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>Suas conversas ficam salvas aqui.</p>}
      </aside>
      <section className="chat-main card">
        <div className="chat-scroll">
          {messages.length === 0 && !pending && (
            <div className="chat-empty">
              <h2>Como posso ajudar?</h2>
              <p className="muted">Eu consulto vendas, pedidos e etapas, PDV, estoque, fornecedores, financeiro, notas e impostos com as suas permissões. Não altero nada no sistema.</p>
              <div className="suggestions">{SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => submit(s)}>{s}</button>)}</div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="msg-body">{m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}</div>
              {m.role === 'assistant' && (
                <div className="msg-meta">{m.source === 'ai' ? 'IA' : 'Regras (IA não configurada)'}
                  {m.tool_calls.length > 0 && ` · consultou: ${[...new Set(m.tool_calls.map((t) => TOOL_LABEL[t.name] ?? t.name))].join(', ')}`}</div>
              )}
            </div>
          ))}
          {pending && (
            <>
              <div className="msg user"><div className="msg-body">{pending}</div></div>
              <div className="msg assistant"><div className="msg-body typing" aria-live="polite"><span /><span /><span /> Consultando os dados…</div></div>
            </>
          )}
          <div ref={end} />
        </div>
        <ErrorBox error={send.error} />
        <form className="chat-input" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
          <textarea className="input" rows={1} placeholder="Pergunte qualquer coisa sobre a operação… (Enter envia, Shift+Enter quebra linha)" value={text}
            onChange={(e) => setText(e.target.value)} aria-label="Mensagem para a assistente"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(text); } }} />
          <button className="btn primary" disabled={send.isPending || !text.trim()}>Enviar</button>
        </form>
      </section>
    </div>
  );
}

/** Markdown simples das respostas: títulos, negrito, código, listas e tabelas (sem HTML cru). */
function Markdown({ text }: { text: string }) {
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part);
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*\|/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i]!)) rows.push(lines[i]!.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
        i++;
      }
      i--;
      out.push(<table key={i} className="lines md-table"><thead><tr>{rows[0]?.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
        <tbody>{rows.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table>);
    } else if (/^\s*[-*•] /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•] /.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*•] /, ''));
      i--;
      out.push(<ul key={i}>{items.map((x, j) => <li key={j}>{inline(x)}</li>)}</ul>);
    } else if (/^\s*\d+[.)] /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)] /.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)] /, ''));
      i--;
      out.push(<ol key={i}>{items.map((x, j) => <li key={j}>{inline(x)}</li>)}</ol>);
    } else if (/^#{1,4} /.test(l)) {
      out.push(<h3 key={i} className="md-h">{inline(l.replace(/^#{1,4} /, ''))}</h3>);
    } else if (l.trim()) {
      out.push(<p key={i}>{inline(l)}</p>);
    }
  }
  return <div className="md">{out}</div>;
}

function DraftSummary({ d }: { d: Draft }) {
  const p = d.payload;
  if (d.kind === 'payable_title') {
    return <div className="grid-4"><span>{p.supplierName ?? 'Fornecedor ?'}</span><span>{brl(p.amount)}</span><span>vence {date(p.dueDate)}</span>
      <span>{p.missing?.length ? <span className="badge warn">falta: {p.missing.join(', ')}</span> : <span className="badge ok">completo</span>}</span>
      {p.divergences?.length > 0 && <div className="alert warn" style={{ gridColumn: '1 / -1' }}>{p.divergences.join(' · ')}</div>}</div>;
  }
  if (d.kind === 'ncm_classification') {
    return <div>NCM <strong className="mono">{p.suggestion?.ncm}</strong> {p.suggestion?.ncmDescription}{p.suggestion?.cest && ` · CEST ${p.suggestion.cest}`}{p.suggestion?.cclasstrib && ` · cClassTrib ${p.suggestion.cclasstrib}`}
      {p.current?.ncm && <span className="muted"> (atual {p.current.ncm})</span>}<div className="muted">{p.rationale}</div></div>;
  }
  if (d.kind === 'renegotiation') {
    return <div>Dívida {brl(p.debt)} → {p.installments?.length}× {brl(p.installments?.[0]?.amount)} {Number(p.discount) > 0 && `· desconto ${brl(p.discount)}`}
      {p.adjustments?.length > 0 && <div className="muted">Ajustado aos limites: {p.adjustments.join('; ')}</div>}</div>;
  }
  return <div>{p.items?.length} item(ns) · {p.items?.slice(0, 4).map((i: any) => `${i.sku} ${i.suggestedQuantity}`).join(', ')}{p.items?.length > 4 ? '…' : ''}</div>;
}

function Drafts() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['ai-drafts'], queryFn: () => api.get<Draft[]>('/v1/ai/drafts', { status: 'pending' }) });
  const confirm = useMutation({ mutationFn: (id: string) => api.post(`/v1/ai/drafts/${id}/confirm`, {}), onSuccess: () => { toast('Confirmado e lançado'); qc.invalidateQueries({ queryKey: ['ai-drafts'] }); } });
  const discard = useMutation({ mutationFn: (id: string) => api.post(`/v1/ai/drafts/${id}/discard`), onSuccess: () => { toast('Descartado'); qc.invalidateQueries({ queryKey: ['ai-drafts'] }); } });
  return (
    <div className="stack">
      <ErrorBox error={q.error ?? confirm.error ?? discard.error} />
      <div className="alert">
        <b>O que é isto?</b> São ações que a assistente preparou e que <b>só acontecem quando você confirma</b>: uma conta a pagar lida de um boleto, a classificação fiscal
        sugerida para um produto, um acordo de cobrança ou uma sugestão de compra. Confira os dados e confirme ou descarte.
      </div>
      {(q.data ?? []).length === 0 && <div className="empty-state"><b>Nada para confirmar</b>Quando a assistente preparar algo para lançar, aparece aqui.</div>}
      {(q.data ?? []).map((d) => (
        <section key={d.id} className="card card-pad stack draft" style={{ gap: 10 }}>
          <div className="row"><span className="badge info">{KIND[d.kind] ?? d.kind}</span><strong>{d.title}</strong><span className="spacer" />
            <span className="muted">{d.source === 'ai' ? 'Preparado pela IA' : 'Preparado pelas regras'} · {dateTime(d.created_at)}</span></div>
          {d.confidence && (
            <div className="row" style={{ gap: 8 }}><small className="muted">Confiança</small>
              <div className="bar" style={{ flex: 1, maxWidth: 220 }}><span style={{ width: `${Number(d.confidence)}%` }} /></div><small><b>{Number(d.confidence).toFixed(0)}%</b></small></div>
          )}
          <DraftSummary d={d} />
          <div className="row"><span className="spacer" />
            <button className="btn" disabled={discard.isPending} onClick={() => discard.mutate(d.id)}>Descartar</button>
            <button className="btn primary" disabled={confirm.isPending} onClick={() => confirm.mutate(d.id)}>Confirmar</button></div>
        </section>
      ))}
    </div>
  );
}

function ReadDocument({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const read = useMutation({
    mutationFn: async (f: File) => {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return api.post('/v1/ai/read-document', { fileBase64: btoa(bin), contentType: f.type || 'application/pdf', fileName: f.name });
    },
    onSuccess: () => { toast('Documento lido: confira o rascunho'); onDone(); },
  });
  return (
    <div className="card card-pad stack" style={{ maxWidth: 640 }}>
      <p style={{ margin: 0 }}>Envie um boleto, recibo ou nota (PDF ou foto). A linha digitável é conferida pelos dígitos; o rascunho do título a pagar já vem com fornecedor, valor, vencimento e categoria.</p>
      <input ref={file} type="file" accept="application/pdf,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) read.mutate(f); e.target.value = ''; }} />
      <div className="row"><button className="btn primary" disabled={read.isPending} onClick={() => file.current?.click()}>{read.isPending ? 'Lendo…' : 'Escolher arquivo'}</button></div>
      <ErrorBox error={read.error} />
    </div>
  );
}

function Forecast({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const whs = useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/v1/warehouses') });
  const [warehouseId, setWarehouseId] = useState('');
  const [horizon, setHorizon] = useState('30');
  const run = useMutation({
    mutationFn: () => api.post<{ draft: Draft | null; items: unknown[] }>('/v1/ai/demand-forecast', { warehouseId: warehouseId || whs.data?.[0]?.id, horizonDays: Number(horizon) }),
    onSuccess: (r) => { if (r.draft) { toast(`${r.items.length} item(ns) na sugestão de compra`); onDone(); } else toast('Estoque suficiente para o horizonte', 'info'); },
  });
  return (
    <div className="card card-pad stack" style={{ maxWidth: 640 }}>
      <p style={{ margin: 0 }}>Projeta as vendas de cada produto (média ponderada das últimas semanas, sazonalidade do ano anterior e promoções) e sugere a compra considerando saldo, pedidos em aberto e prazo do fornecedor.</p>
      <div className="grid-2">
        <Field label="Depósito"><Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{(whs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></Field>
        <Field label="Horizonte"><Select value={horizon} onChange={(e) => setHorizon(e.target.value)}><option value="15">15 dias</option><option value="30">30 dias</option><option value="60">60 dias</option><option value="90">90 dias</option></Select></Field>
      </div>
      <div className="row"><span className="spacer" /><button className="btn primary" disabled={run.isPending} onClick={() => run.mutate()}>Gerar sugestão</button></div>
      <ErrorBox error={run.error} />
    </div>
  );
}

function Anomalies() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ai-anomalies'], queryFn: () => api.get<Anomaly[]>('/v1/ai/anomalies', { status: 'open' }) });
  const scan = useMutation({ mutationFn: () => api.post<Anomaly[]>('/v1/ai/anomalies/scan'), onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-anomalies'] }) });
  const close = useMutation({ mutationFn: (v: { id: string; status: string }) => api.patch(`/v1/ai/anomalies/${v.id}`, { status: v.status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-anomalies'] }) });
  return (
    <div className="stack">
      <div className="row"><span className="muted">Verificação diária automática: desconto fora do padrão, troca de conta bancária de fornecedor, nota inesperada e quebra de caixa.</span><span className="spacer" />
        {can('ia.assistente.usar') && <button className="btn" disabled={scan.isPending} onClick={() => scan.mutate()}>Verificar agora</button>}</div>
      <ErrorBox error={q.error ?? scan.error ?? close.error} />
      {(q.data ?? []).length === 0 && <div className="empty">Nenhuma anomalia em aberto.</div>}
      {(q.data ?? []).map((a) => (
        <div key={a.id} className={`alert ${a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : ''} row`}>
          <Status value={a.severity} label={a.severity === 'critical' ? 'Crítica' : a.severity === 'warning' ? 'Atenção' : 'Info'} />
          <span style={{ flex: 1, minWidth: 0 }}>{a.message}</span>
          <button className="btn sm" onClick={() => close.mutate({ id: a.id, status: 'resolved' })}>Resolvida</button>
          <button className="btn sm ghost" onClick={() => close.mutate({ id: a.id, status: 'dismissed' })}>Descartar</button>
        </div>
      ))}
    </div>
  );
}
