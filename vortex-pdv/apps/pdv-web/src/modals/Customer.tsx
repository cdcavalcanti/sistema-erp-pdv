import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { SaleView } from '../lib/types';
import { Alert, Field, Modal } from '../ui';

interface CustomerView { id: string; name: string; taxIdMasked: string | null; status: string; blockReason: string | null; pending: boolean }

/** Cliente (seção 14): consumidor final, pesquisar (local e no ERP), CPF na nota ou novo cadastro mínimo. */
export function CustomerModal({ sale, online, canCreate, onClose, onChange }: {
  sale: SaleView; online: boolean; canCreate: boolean; onClose: () => void; onChange: (v: SaleView) => void;
}) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<CustomerView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ taxId: '', name: '', phone: '', email: '' });

  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) return setList([]);
    const id = setTimeout(() => {
      api<CustomerView[]>('GET', `/api/customers?q=${encodeURIComponent(term)}`).then(setList).catch(() => setList([]));
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  const set = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      onChange(await api<SaleView>('POST', `/api/sales/${sale.sale.id}/customer`, body));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao identificar o cliente');
    }
  };
  const digits = q.replace(/\D/g, '');

  if (creating) {
    return (
      <Modal key="create" title="Novo cliente" onClose={() => setCreating(false)} onSubmit={async () => {
        setError(null);
        try {
          const c = await api<CustomerView>('POST', '/api/customers', { taxId: form.taxId, name: form.name, phone: form.phone || null, email: form.email || null });
          await set({ customerId: c.id });
        } catch (e) {
          setError(e instanceof ApiError ? e.message : 'Falha no cadastro');
        }
      }} footer={<button className="primary" type="submit">Cadastrar e usar <kbd>ENTER</kbd></button>}>
        {error && <Alert kind="error">{error}</Alert>}
        <p className="muted">Cadastro mínimo: o cadastro completo continua no ERP.</p>
        <Field label="CPF/CNPJ"><input data-autofocus inputMode="numeric" value={form.taxId} onChange={(e) => setForm({ ...form, taxId: e.target.value })} /></Field>
        <Field label="Nome"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Telefone"><input inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="E-mail"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
      </Modal>
    );
  }

  return (
    <Modal key="search" title="Cliente da venda" onClose={onClose} wide footer={<>
      <button type="button" onClick={() => void set({ customerId: null })}>Consumidor final</button>
      {canCreate && <button type="button" onClick={() => { setForm({ ...form, taxId: digits.length >= 11 ? q : '' }); setCreating(true); }}>Novo cliente</button>}
    </>}>
      {error && <Alert kind="error">{error}</Alert>}
      <Field label="CPF, CNPJ ou nome" hint={online ? 'Busca no cadastro local e, se não achar, no ERP' : 'Offline: busca só no cadastro local'}>
        <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (list[0]) void set({ customerId: list[0].id }); else if (digits.length === 11 || digits.length === 14) void set({ taxId: q }); } }} />
      </Field>
      {(digits.length === 11 || digits.length === 14) && !list.length && (
        <button type="button" className="row-btn" onClick={() => void set({ taxId: q })}>Usar CPF/CNPJ {q} só na nota <kbd>ENTER</kbd></button>
      )}
      <ul className="pick">
        {list.map((c) => (
          <li key={c.id}>
            <button type="button" className="row-btn" disabled={c.status === 'blocked'} onClick={() => void set({ customerId: c.id })}>
              <b>{c.name}</b> <span className="muted">{c.taxIdMasked}</span>
              {c.status === 'blocked' && <span className="tag bad">Bloqueado{c.blockReason ? `: ${c.blockReason}` : ''}</span>}
              {c.pending && <span className="tag">aguardando ERP</span>}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
