import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl, qty } from '../lib/format';
import type { Item, SaleView } from '../lib/types';
import { useAuthorized } from '../authorize';
import { Alert, Field, Modal } from '../ui';

const REASONS = ['Cliente desistiu', 'Registrado por engano', 'Produto com defeito', 'Preço divergente'];

/**
 * Cancelamento de item (seção 22): qual item (lista ou número) e quantas unidades. Motivo
 * obrigatório; autorização quando o ERP exige. A parte cancelada vai ao ERP com a venda.
 */
export function CancelItemModal({ sale, item, onClose, onChange }: { sale: SaleView; item: Item; onClose: () => void; onChange: (v: SaleView) => void }) {
  const active = sale.items.filter((i) => i.status === 'active');
  const [itemId, setItemId] = useState(item.id);
  const current = active.find((i) => i.id === itemId) ?? item;
  const [quantity, setQuantity] = useState(qty(current.quantity));
  const [reason, setReason] = useState(REASONS[0]!);
  const [error, setError] = useState<string | null>(null);
  const authorized = useAuthorized();
  const pick = (id: string) => {
    const it = active.find((i) => i.id === id);
    if (!it) return;
    setItemId(id);
    setQuantity(qty(it.quantity));
  };
  const n = Number(quantity.replace(',', '.'));
  const max = Number(current.quantity);
  const valid = n > 0 && n <= max;
  const step = (d: number) => setQuantity(qty(Math.min(max, Math.max(1, Math.round(n) + d))));
  return (
    <Modal title="Cancelar item" tone="danger" onClose={onClose} onSubmit={async () => {
      if (!valid) return setError(`Informe de 1 a ${qty(max)} ${current.unit}`);
      try {
        onChange(await authorized((authorization) => api<SaleView>('POST', `/api/sales/${sale.sale.id}/items/${current.id}/cancel`,
          { reason, quantity: quantity.replace(',', '.'), authorization })));
      } catch (e) {
        if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setError(e.message);
      }
    }} footer={<button className="danger" type="submit" disabled={!valid}>Cancelar {n < max ? `${qty(n)} de ${qty(max)}` : 'item'} <kbd>ENTER</kbd></button>}>
      {error && <Alert kind="error">{error}</Alert>}
      <Field label="Item">
        <select data-autofocus value={itemId} onChange={(e) => pick(e.target.value)}>
          {active.map((i) => <option key={i.id} value={i.id}>{String(i.seq).padStart(3, '0')} · {i.description} · {qty(i.quantity)} {i.unit} · R$ {brl(i.total)}</option>)}
        </select>
      </Field>
      <div className="field">
        <span id="cancel-qty-label">Quantidade a cancelar (de {qty(max)} {current.unit})</span>
        <div className="qty-stepper">
          <button type="button" onClick={() => step(-1)} aria-label="Menos uma" disabled={n <= 1}>−</button>
          <input inputMode="decimal" aria-labelledby="cancel-qty-label" value={quantity} onChange={(e) => setQuantity(e.target.value)} aria-invalid={!valid} />
          <button type="button" onClick={() => step(1)} aria-label="Mais uma" disabled={n >= max}>+</button>
          <button type="button" onClick={() => setQuantity(qty(max))}>Todas</button>
        </div>
      </div>
      <p className="muted">Valor cancelado: R$ {brl(valid ? n * Number(current.unit_price) : 0)}{n < max && valid ? ` · ficam ${qty(max - n)} ${current.unit} no item` : ''}</p>
      <Field label="Motivo">
        <select value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map((r) => <option key={r}>{r}</option>)}</select>
      </Field>
    </Modal>
  );
}
