import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { D, ZERO, roundMoney } from '@vortex/money';
import { salesOrderSchema } from '@vortex/contracts';
import { api, newIdempotencyKey, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Field, Input, PageHeader, Select, useDebounced, useHotkeys, useToast } from '../../components/ui';
import { brl, doc } from '../../lib/format';

interface Party { id: string; legal_name: string; tax_id: string | null; status: string }
interface Product { id: string; sku: string; description: string; stock_unit: string }
interface Line { key: string; productId: string; sku: string; description: string; unit: string; quantity: string; unitPrice: string; discountPercent: string }

const lineTotal = (l: Line) => {
  try {
    return roundMoney(D(l.quantity || 0).times(l.unitPrice || 0).times(D(100).minus(l.discountPercent || 0)).dividedBy(100));
  } catch {
    return ZERO;
  }
};

/** Busca com sugestões (cliente ou produto) operável só pelo teclado: ↑/↓, Enter e Esc. */
function Lookup<T extends { id: string }>({ inputRef, placeholder, fetcher, render, onPick, label, queryKey }: {
  inputRef?: React.RefObject<HTMLInputElement | null>; placeholder: string; fetcher: (q: string) => Promise<T[]>; render: (r: T) => React.ReactNode; onPick: (r: T) => void; label: string; queryKey: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const dq = useDebounced(q.trim(), 150);
  const res = useQuery({ queryKey: [queryKey, dq], queryFn: () => fetcher(dq), enabled: dq.length >= 1 });
  const items = res.data ?? [];
  useEffect(() => setSel(0), [dq]);
  const pick = (r: T | undefined) => {
    if (!r) return;
    onPick(r);
    setQ('');
    setOpen(false);
  };
  return (
    <div className="relative">
      <Input ref={inputRef as React.Ref<HTMLInputElement>} placeholder={placeholder} value={q} aria-label={label} role="combobox" aria-expanded={open && items.length > 0}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(items[sel]); }
          else if (e.key === 'Escape') { setQ(''); setOpen(false); }
        }} />
      {open && items.length > 0 && (
        <ul className="suggest" role="listbox">
          {items.map((r, i) => <li key={r.id} role="option" aria-selected={i === sel} onMouseDown={(e) => { e.preventDefault(); pick(r); }}>{render(r)}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * Digitação de pedido (seção 24: atalhos de teclado; usável no celular). F2 busca produto,
 * Enter inclui, F4 troca o cliente, F9 grava, Ctrl+Enter grava e fatura. A mesma
 * Idempotency-Key acompanha a gravação: clique duplo não gera dois pedidos.
 */
export default function OrderEntryPage() {
  const { can, me } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const productRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const idem = useRef(newIdempotencyKey());
  const [party, setParty] = useState<Party | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [establishmentId, setEstablishmentId] = useState('');
  const [paymentTermId, setPaymentTermId] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ests = useQuery({ queryKey: ['establishments'], queryFn: () => api.get<{ id: string; code: string; trade_name: string | null; legal_name: string }[]>('/v1/establishments') });
  const terms = useQuery({ queryKey: ['payment-terms'], queryFn: () => api.get<{ id: string; name: string; active: boolean }[]>('/v1/payment-terms') });
  useEffect(() => {
    const allowed = (ests.data ?? []).filter((e) => !me?.establishmentIds || me.establishmentIds.includes(e.id));
    if (!establishmentId && allowed[0]) setEstablishmentId(allowed[0].id);
  }, [ests.data, establishmentId, me]);
  useEffect(() => customerRef.current?.focus(), []);

  const addProduct = async (p: Product) => {
    let unitPrice = '0';
    try {
      const qt = await api.get<{ unitPrice: string }>('/v1/pricing/quote', { productId: p.id, customerId: party?.id, establishmentId: establishmentId || undefined });
      unitPrice = D(qt.unitPrice).toFixed(2);
    } catch {
      toast(`Sem preço vigente para ${p.sku}: informe o preço`, 'bad');
    }
    setLines((ls) => {
      const ex = ls.find((l) => l.productId === p.id);
      if (ex) return ls.map((l) => (l === ex ? { ...l, quantity: D(l.quantity || 0).plus(1).toString() } : l));
      return [...ls, { key: crypto.randomUUID(), productId: p.id, sku: p.sku, description: p.description, unit: p.stock_unit, quantity: '1', unitPrice, discountPercent: '0' }];
    });
    setTimeout(() => productRef.current?.focus(), 0);
  };
  const total = useMemo(() => lines.reduce((a, l) => a.plus(lineTotal(l)), ZERO), [lines]);
  const gross = useMemo(() => lines.reduce((a, l) => {
    try {
      return a.plus(roundMoney(D(l.quantity || 0).times(l.unitPrice || 0)));
    } catch {
      return a;
    }
  }, ZERO), [lines]);

  const save = async (invoice: boolean) => {
    if (busy) return;
    setError(null);
    const body = {
      establishmentId, partyId: party?.id, paymentTermId: paymentTermId || null, notes: notes || null, channel: 'counter' as const,
      items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent || '0' })),
    };
    // Mesmo esquema que a API aplica: o erro aparece antes de ir ao servidor
    const parsed = salesOrderSchema.safeParse(body);
    if (!parsed.success) {
      setError(new Error(parsed.error.issues.map((i) => (i.path[0] === 'partyId' ? 'Escolha o cliente' : i.path[0] === 'items' && i.path.length === 1 ? i.message : `${i.path.join('.')}: ${i.message}`)).join(' · ')));
      return;
    }
    setBusy(true);
    try {
      const o = await api.post<{ id: string; number: string; status: string }>('/v1/sales/orders', body, { idempotencyKey: idem.current });
      if (invoice && o.status === 'approved' && can('vendas.pedido.faturar')) {
        const inv = await api.post<{ transmission?: { status: string; message?: string } }>(`/v1/sales/orders/${o.id}/invoice`, {}, { idempotencyKey: `${idem.current}:fatura` });
        toast(`Pedido ${o.number} faturado: NF-e ${inv.transmission?.status ?? 'gerada'}`);
      } else {
        toast(o.status === 'pending_approval' ? `Pedido ${o.number} aguardando aprovação` : `Pedido ${o.number} gravado`);
      }
      nav(`/vendas/pedidos/${o.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  useHotkeys({
    F2: () => productRef.current?.focus(),
    F4: () => customerRef.current?.focus(),
    F9: () => void save(false),
    'Ctrl+Enter': () => void save(true),
  }, [lines, party, establishmentId, paymentTermId, notes, busy]);

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  return (
    <>
      <PageHeader title="Novo pedido" subtitle={<span className="hide-sm"><kbd>F4</kbd> cliente · <kbd>F2</kbd> produto · <kbd>F9</kbd> gravar · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> gravar e faturar</span>} />
      <div className="order-grid">
        <div className="stack">
          <section className="card card-pad stack">
            <div className="grid-3">
              <Field label="Cliente (F4)">
                {party ? (
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <span style={{ flex: 1, minWidth: 0 }}><strong>{party.legal_name}</strong> <span className="muted mono">{doc(party.tax_id)}</span></span>
                    <button className="btn sm" type="button" onClick={() => { setParty(null); setTimeout(() => customerRef.current?.focus(), 0); }}>Trocar</button>
                  </div>
                ) : (
                  <Lookup<Party> inputRef={customerRef} queryKey="lk-party" label="Cliente" placeholder="Nome ou CPF/CNPJ" render={(r) => <><span style={{ flex: 1 }}>{r.legal_name}</span><span className="muted mono">{doc(r.tax_id)}</span></>}
                    fetcher={async (q) => (await api.get<Page<Party>>('/v1/parties', { q, role: 'customer', limit: 8 })).items}
                    onPick={(p) => { setParty(p); setTimeout(() => productRef.current?.focus(), 0); }} />
                )}
              </Field>
              <Field label="Estabelecimento">
                <Select value={establishmentId} onChange={(e) => setEstablishmentId(e.target.value)}>
                  {(ests.data ?? []).filter((e) => !me?.establishmentIds || me.establishmentIds.includes(e.id)).map((e) => <option key={e.id} value={e.id}>{e.code} — {e.trade_name ?? e.legal_name}</option>)}
                </Select>
              </Field>
              <Field label="Condição de pagamento">
                <Select value={paymentTermId} onChange={(e) => setPaymentTermId(e.target.value)}>
                  <option value="">Padrão do cliente</option>
                  {(terms.data ?? []).filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </Field>
            </div>
          </section>
          <section className="card">
            <div className="card-pad">
              <Field label="Produto (F2) — Enter inclui; repetir soma 1">
                <Lookup<Product> inputRef={productRef} queryKey="lk-product" label="Produto" placeholder="SKU, descrição ou código de barras"
                  render={(r) => <><span className="mono">{r.sku}</span><span style={{ flex: 1 }}>{r.description}</span></>}
                  fetcher={async (q) => (await api.get<Page<Product>>('/v1/products', { q, limit: 8 })).items} onPick={addProduct} />
              </Field>
            </div>
            <table className="lines">
              <thead><tr><th>Produto</th><th className="num" style={{ width: 100 }}>Qtd.</th><th className="num" style={{ width: 120 }}>Preço</th><th className="num" style={{ width: 90 }}>Desc. %</th>
                <th className="num" style={{ width: 120 }}>Total</th><th style={{ width: 40 }} /></tr></thead>
              <tbody>
                {lines.length === 0 && <tr><td colSpan={6} className="empty">Nenhum item. Use F2 para buscar produtos.</td></tr>}
                {lines.map((l) => (
                  <tr key={l.key}>
                    <td className="desc"><span className="mono muted">{l.sku}</span> {l.description}</td>
                    <td className="num"><Input className="num" inputMode="decimal" aria-label={`Quantidade ${l.sku}`} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value.replace(',', '.') })} /></td>
                    <td className="num"><Input className="num" inputMode="decimal" aria-label={`Preço ${l.sku}`} value={l.unitPrice} onChange={(e) => update(l.key, { unitPrice: e.target.value.replace(',', '.') })} /></td>
                    <td className="num"><Input className="num" inputMode="decimal" aria-label={`Desconto ${l.sku}`} value={l.discountPercent} onChange={(e) => update(l.key, { discountPercent: e.target.value.replace(',', '.') })} /></td>
                    <td className="num"><strong>{brl(lineTotal(l).toFixed(2))}</strong></td>
                    <td><button className="btn ghost sm" type="button" aria-label={`Remover ${l.sku}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <Field label="Observações"><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <aside className="card card-pad stack" style={{ position: 'sticky', top: 0 }}>
          <h2>Resumo</h2>
          <div className="totals">
            <div><span>Itens</span><span>{lines.length}</span></div>
            <div><span>Produtos</span><span>{brl(gross.toFixed(2))}</span></div>
            <div><span>Descontos</span><span>{brl(gross.minus(total).toFixed(2))}</span></div>
            <div className="grand"><span>Total</span><span>{brl(total.toFixed(2))}</span></div>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Tributos são calculados pelo motor fiscal ao faturar. Desconto acima da sua alçada envia o pedido para aprovação.</p>
          <ErrorBox error={error} />
          <button className="btn" type="button" disabled={busy} onClick={() => save(false)}>Gravar <span className="kbd-hint">F9</span></button>
          {can('vendas.pedido.faturar') && <button className="btn primary" type="button" disabled={busy} onClick={() => save(true)}>Gravar e faturar <span className="kbd-hint">Ctrl+Enter</span></button>}
        </aside>
      </div>
    </>
  );
}
