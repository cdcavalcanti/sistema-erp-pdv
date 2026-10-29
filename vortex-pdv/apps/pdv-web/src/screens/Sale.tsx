import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, session } from '../lib/api';
import { brl, qty } from '../lib/format';
import { beep } from '../lib/sound';
import { SHORTCUTS, useHotkeys } from '../lib/hotkeys';
import { can, type Item, type SaleView } from '../lib/types';
import type { SessionInfo, Status, Terminal } from '../App';
import { StatusBar } from './StatusBar';
import { Alert } from '../ui';
import { CustomerModal } from '../modals/Customer';
import { DiscountModal } from '../modals/Discount';
import { CancelItemModal } from '../modals/CancelItem';
import { ProductSearchModal } from '../modals/ProductSearch';
import { QuantityModal } from '../modals/Quantity';
import { CashMoveModal } from '../modals/CashMove';
import { PaymentModal } from '../modals/Payment';
import { CompletedModal } from '../modals/Completed';
import { CancelSaleModal } from '../modals/CancelSale';
import { MenuModal, type MenuAction } from '../modals/Menu';
import { ClosingModal } from '../modals/Closing';
import { ReturnModal } from '../modals/Return';
import { SalesListModal } from '../modals/SalesList';
import { DashboardModal } from '../modals/Dashboard';
import { StatusModal } from '../modals/StatusModal';
import { RecoveryModal } from '../modals/Recovery';
import { SettingsModal } from '../modals/Settings';

type ModalName = 'customer' | 'discount' | 'cancelItem' | 'search' | 'quantity' | 'withdrawal' | 'supply' | 'payment' | 'completed' | 'cancelSale' | 'menu' | 'closing'
  | 'return' | 'sales' | 'dashboard' | 'status' | 'recovery' | 'settings' | null;

/**
 * Frente de caixa (seção 8): CÓDIGO/PRODUTO → itens → cliente → subtotal → desconto → total →
 * FINALIZAR. Tudo pelo teclado (seção 41) e pelo leitor (que digita o código + Enter).
 */
export function SaleScreen({ terminal, status, info, refreshStatus, refreshSession }: {
  terminal: Terminal; status: Status | null; info: SessionInfo; refreshStatus: () => void; refreshSession: () => void;
}) {
  const op = info.operator;
  const [sale, setSale] = useState<SaleView | null>(info.sale);
  const [code, setCode] = useState('');
  const [nextQty, setNextQty] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalName>(info.sale && info.sale.items.some((i) => i.status === 'active') ? 'recovery' : null);
  const [message, setMessage] = useState<{ kind: 'error' | 'warn' | 'ok'; text: string; notFound?: string } | null>(null);
  const [lastCompleted, setLastCompleted] = useState<SaleView | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Leitura em andamento: F9 logo após o bipe do leitor espera o item entrar antes de finalizar
  const inFlight = useRef<Promise<SaleView | null> | null>(null);
  const saleRef = useRef(sale);
  saleRef.current = sale;
  const listRef = useRef<HTMLDivElement>(null);

  const active = sale?.items.filter((i) => i.status === 'active') ?? [];
  const selectedItem: Item | undefined = active.find((i) => i.id === selected) ?? active.at(-1);
  const focusInput = useCallback(() => setTimeout(() => inputRef.current?.focus(), 0), []);
  const close = useCallback(() => {
    setModal(null);
    focusInput();
  }, [focusInput]);

  const fail = (e: unknown, sound = true) => {
    if (sound) beep.error();
    if (e instanceof ApiError) {
      if (e.code === 'AUTHORIZATION_CANCELLED') return;
      setMessage({ kind: 'error', text: e.message, notFound: e.code === 'PRODUCT_NOT_FOUND' ? String(e.details.code ?? code) : undefined });
    } else setMessage({ kind: 'error', text: (e as Error).message });
  };

  const ensureSale = async (): Promise<SaleView> => {
    const cur = saleRef.current;
    if (cur && (cur.sale.status === 'open' || cur.sale.status === 'payment')) return cur;
    const s = await api<SaleView>('POST', '/api/sales');
    saleRef.current = s;
    setSale(s);
    return s;
  };

  const apply = (v: SaleView) => {
    setSale(v);
    if (v.warnings?.length) setMessage({ kind: 'warn', text: v.warnings.join(' · ') });
  };

  /**
   * Leitura/digitação: Enter adiciona; feedback visual e sonoro (seção 9). Leituras rápidas em
   * sequência entram numa fila e são gravadas na ordem — nenhuma é perdida.
   */
  const queue = useRef<string[]>([]);
  const processing = useRef(false);
  const addCode = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    queue.current.push(nextQty ? `${nextQty.replace(',', '.')}*${text}` : text);
    setNextQty(null);
    setCode('');
    if (processing.current) return;
    processing.current = true;
    setMessage(null);
    let done: (v: SaleView | null) => void = () => undefined;
    inFlight.current = new Promise((r) => (done = r));
    let last: SaleView | null = null;
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!;
        try {
          const s = await ensureSale();
          last = await api<SaleView>('POST', `/api/sales/${s.sale.id}/items`, { code: item });
          saleRef.current = last;
          apply(last);
          setSelected(null);
          beep.ok();
          requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
        } catch (e) {
          fail(e);
        }
      }
    } finally {
      done(last);
      inFlight.current = null;
      processing.current = false;
      focusInput();
    }
  };

  const addProduct = async (productId: string, quantity?: string) => {
    try {
      const s = await ensureSale();
      apply(await api<SaleView>('POST', `/api/sales/${s.sale.id}/items`, { productId, quantity: quantity ?? nextQty ?? undefined }));
      setNextQty(null);
      beep.ok();
      close();
    } catch (e) {
      fail(e);
    }
  };

  const finalize = async () => {
    const current = (await inFlight.current) ?? saleRef.current;
    if (!current || !current.items.some((i) => i.status === 'active')) return setMessage({ kind: 'warn', text: 'Inclua ao menos um item' });
    try {
      if (current.sale.status === 'open') setSale(await api<SaleView>('POST', `/api/sales/${current.sale.id}/finalize`));
      setModal('payment');
    } catch (e) {
      fail(e);
      if (e instanceof ApiError && e.code === 'CUSTOMER_REQUIRED') setModal('customer');
    }
  };

  const onCompleted = (v: SaleView) => {
    setMessage(null);
    setLastCompleted(v);
    setSale(null);
    setModal('completed');
    refreshStatus();
  };

  const menu = (a: MenuAction) => {
    if (a === 'logout') {
      void api('POST', '/api/auth/logout').finally(() => session.set(null));
      return;
    }
    if (a === 'sync') {
      setModal(null);
      void api('POST', '/api/sync', {}).then((r) => setMessage({ kind: r.online ? 'ok' : 'warn', text: r.online ? `Sincronizado: ${r.pushed} envio(s)` : 'ERP offline: tentaremos de novo' }))
        .finally(refreshStatus);
      return;
    }
    setModal(a);
  };

  useHotkeys({
    F2: () => sale && setModal('customer'),
    F3: () => sale && active.length && setModal('discount'),
    F4: () => selectedItem && setModal('cancelItem'),
    F5: () => setModal('search'),
    F6: () => setModal('quantity'),
    F7: () => setModal('withdrawal'),
    F8: () => setModal('supply'),
    F9: () => void finalize(),
    F10: () => sale && setModal('cancelSale'),
    F11: () => setModal('sales'),
    F12: () => setModal('menu'),
    Escape: () => {
      if (code) setCode('');
      else if (nextQty) setNextQty(null);
      else if (selected) setSelected(null);
      else if (sale?.sale.status === 'payment') void api<SaleView>('POST', `/api/sales/${sale.sale.id}/back`).then(setSale).catch(fail);
      setMessage(null);
    },
  }, modal === null);

  // Setas escolhem o item (para quantidade, desconto e cancelamento)
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (!active.length) return;
    const idx = selectedItem ? active.findIndex((i) => i.id === selectedItem.id) : active.length;
    const next = Math.max(0, Math.min(active.length - 1, idx + (e.key === 'ArrowUp' ? -1 : 1)));
    setSelected(active[next]!.id);
  };

  useEffect(() => {
    if (!modal) focusInput();
  }, [modal, focusInput]);

  const s = sale?.sale;
  return (
    <div className="screen pos">
      <StatusBar terminal={terminal} status={status} operator={op} cashOpenedAt={info.cash?.opened_at} onStatus={() => setModal('status')} />
      {status && status.alerts.length > 0 && (
        <div className="alerts-strip" role="status">{status.alerts.map((a) => <span key={a}>⚠ {a}</span>)}</div>
      )}
      <main className="pos-main">
        <section className="pos-left">
          <form className="scan" onSubmit={(e) => { e.preventDefault(); void addCode(code); }}>
            <label htmlFor="code">CÓDIGO / PRODUTO</label>
            <div className="scan-row">
              {nextQty && <span className="qty-tag" aria-label="Quantidade do próximo item">{qty(nextQty.replace(',', '.'))} ×</span>}
              <input id="code" ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={onInputKey} autoFocus autoComplete="off"
                placeholder="Leia o código ou digite SKU / nome" title="Quantidade antes do código: 3*código" aria-describedby="scan-msg" />
              <button type="submit" className="primary">Adicionar</button>
            </div>
            <div id="scan-msg" aria-live="assertive">
              {message && (
                <Alert kind={message.kind}>
                  {message.text}
                  {message.notFound && <> — <button type="button" className="link" onClick={() => setModal('search')}>Pesquisar <kbd>F5</kbd></button></>}
                </Alert>
              )}
            </div>
          </form>
          <div className="items" ref={listRef} role="table" aria-label="Itens da venda">
            <div className="items-head" role="row"><span>#</span><span>Produto</span><span>Qtd</span><span>Preço</span><span>Total</span></div>
            {!sale?.items.length && <div className="empty">Caixa livre — leia o primeiro produto</div>}
            {sale?.items.map((i) => (
              <div key={i.id} role="row" onClick={() => i.status === 'active' && setSelected(i.id)}
                className={`item ${i.status === 'cancelled' ? 'cancelled' : ''} ${i.id === selectedItem?.id ? 'selected' : ''}`}>
                <span className="seq">{String(i.seq).padStart(3, '0')}</span>
                <span className="desc">{i.description}<small>{i.sku}{i.promotions.length ? ` · ${i.promotions.map((p) => p.name).join(', ')}` : ''}
                  {i.status === 'cancelled' ? ` · CANCELADO${i.cancelled_from_seq ? ` (${qty(i.quantity)} do item ${String(i.cancelled_from_seq).padStart(3, '0')})` : ''}${i.cancel_reason ? ` · ${i.cancel_reason}` : ''}` : ''}</small></span>
                <span className="num">{qty(i.quantity)} {i.unit}</span>
                <span className="num">{brl(i.unit_price)}</span>
                <span className="num total">{brl(i.total)}{Number(i.discount) > 0 && <small>−{brl(i.discount)}</small>}</span>
              </div>
            ))}
          </div>
        </section>
        <aside className="pos-right">
          <button type="button" className="customer" onClick={() => sale && setModal('customer')} disabled={!sale}>
            <span>Cliente <kbd>F2</kbd></span>
            <b>{s?.customer ? `${s.customer.name ?? ''} ${s.customer.taxIdMasked ?? ''}` : 'Consumidor final'}</b>
          </button>
          <dl className="totals">
            <div><dt>Itens</dt><dd>{active.length}</dd></div>
            <div><dt>Subtotal</dt><dd>R$ {brl(s?.subtotal)}</dd></div>
            <div><dt>Desconto <kbd>F3</kbd></dt><dd className={Number(s?.discount_total ?? 0) > 0 ? 'discount' : ''}>− R$ {brl(s?.discount_total)}</dd></div>
          </dl>
          <div className="grand" aria-label="Total da venda"><span>TOTAL</span><strong data-testid="total">R$ {brl(s?.total)}</strong></div>
          <button type="button" className="finalize" onClick={() => void finalize()} disabled={!active.length}>FINALIZAR VENDA <kbd>F9</kbd></button>
          <div className="side-actions">
            <button type="button" onClick={() => setModal('search')}>Consultar <kbd>F5</kbd></button>
            <button type="button" onClick={() => setModal('quantity')}>Quantidade <kbd>F6</kbd></button>
            <button type="button" onClick={() => selectedItem && setModal('cancelItem')} disabled={!selectedItem}>Cancelar item <kbd>F4</kbd></button>
            <button type="button" onClick={() => sale && setModal('cancelSale')} disabled={!sale}>Cancelar venda <kbd>F10</kbd></button>
            <button type="button" onClick={() => setModal('menu')}>Menu <kbd>F12</kbd></button>
          </div>
        </aside>
      </main>
      <footer className="shortcuts">{SHORTCUTS.map(([k, l]) => <span key={k}><kbd>{k}</kbd> {l}</span>)}<span><kbd>ENTER</kbd> Confirmar</span></footer>

      {modal === 'recovery' && sale && (
        <RecoveryModal sale={sale} onResume={() => { setModal(sale.sale.status === 'payment' ? 'payment' : null); }}
          onDiscarded={() => { setSale(null); close(); }} />
      )}
      {modal === 'customer' && sale && <CustomerModal sale={sale} online={info.online} onClose={close} onChange={(v) => { apply(v); close(); }} canCreate={can(op, 'pdv.cliente.cadastrar')} />}
      {modal === 'discount' && sale && <DiscountModal sale={sale} item={selected ? selectedItem ?? null : null} limit={op.discountLimitPercent} onClose={close} onChange={(v) => { apply(v); close(); }} />}
      {modal === 'cancelItem' && sale && selectedItem && <CancelItemModal sale={sale} item={selectedItem} onClose={close} onChange={(v) => { apply(v); setSelected(null); close(); }} />}
      {modal === 'search' && <ProductSearchModal initial={message?.notFound ?? ''} onClose={close} onPick={(id) => void addProduct(id)} />}
      {modal === 'quantity' && (
        <QuantityModal item={selected ? selectedItem ?? null : null} onClose={close}
          onNext={(q) => { setNextQty(q); close(); }}
          onItem={async (q) => {
            try {
              apply(await api<SaleView>('PATCH', `/api/sales/${sale!.sale.id}/items/${selectedItem!.id}`, { quantity: q.replace(',', '.') }));
              close();
            } catch (e) {
              fail(e);
            }
          }} />
      )}
      {(modal === 'withdrawal' || modal === 'supply') && <CashMoveModal kind={modal} onClose={close} onDone={(t) => { setMessage({ kind: 'ok', text: t }); close(); }} />}
      {modal === 'payment' && sale && (
        <PaymentModal sale={sale} terminal={terminal} maxInstallments={info.settings.payments.maxInstallments} onChange={setSale} onCompleted={onCompleted}
          onBack={async () => {
            try {
              setSale(await api<SaleView>('POST', `/api/sales/${sale.sale.id}/back`));
              close();
            } catch (e) {
              fail(e, false);
            }
          }} />
      )}
      {modal === 'completed' && lastCompleted && <CompletedModal sale={lastCompleted} onClose={close} />}
      {modal === 'cancelSale' && sale && <CancelSaleModal sale={sale} onClose={close} onDone={() => { setSale(null); setMessage({ kind: 'ok', text: 'Venda cancelada' }); close(); }} />}
      {modal === 'menu' && <MenuModal operator={op} onClose={close} onPick={menu} />}
      {modal === 'closing' && <ClosingModal operator={op} blind={info.settings.cash.blindClosing} onClose={close} onClosed={() => { setModal(null); refreshSession(); }} />}
      {modal === 'return' && <ReturnModal onClose={close} onDone={(t) => { setMessage({ kind: 'ok', text: t }); close(); }} />}
      {modal === 'sales' && <SalesListModal operator={op} onClose={close} />}
      {modal === 'dashboard' && <DashboardModal onClose={close} />}
      {modal === 'status' && <StatusModal terminal={terminal} onClose={() => { refreshStatus(); close(); }} />}
      {modal === 'settings' && <SettingsModal onClose={close} />}
    </div>
  );
}
