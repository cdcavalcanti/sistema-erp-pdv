import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl, parseMoney } from '../lib/format';
import type { Item, SaleView } from '../lib/types';
import { useAuthorized } from '../authorize';
import { Alert, Field, Modal } from '../ui';

/** Desconto (seção 13): por item ou na venda, percentual ou valor; acima da alçada pede supervisor. */
export function DiscountModal({ sale, item, limit, onClose, onChange }: { sale: SaleView; item: Item | null; limit: string; onClose: () => void; onChange: (v: SaleView) => void }) {
  const [scope, setScope] = useState<'item' | 'sale'>(item ? 'item' : 'sale');
  const [kind, setKind] = useState<'percent' | 'value'>('percent');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const authorized = useAuthorized();
  const submit = async (remove = false) => {
    setError(null);
    const discount = remove ? null : { kind, value: parseMoney(value) };
    const url = scope === 'item' && item ? `/api/sales/${sale.sale.id}/items/${item.id}/discount` : `/api/sales/${sale.sale.id}/discount`;
    try {
      onChange(await authorized((authorization) => api<SaleView>('POST', url, { discount, authorization })));
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setError(e.message);
    }
  };
  return (
    <Modal title="Desconto" onClose={onClose} onSubmit={() => void submit()} footer={<>
      <button type="button" onClick={() => void submit(true)}>Remover desconto</button>
      <button className="primary" type="submit">Aplicar <kbd>ENTER</kbd></button>
    </>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="seg">
        <button type="button" className={scope === 'sale' ? 'on' : ''} onClick={() => setScope('sale')}>Na venda (R$ {brl(sale.sale.subtotal)})</button>
        <button type="button" disabled={!item} className={scope === 'item' ? 'on' : ''} onClick={() => setScope('item')}>
          {item ? `No item ${item.seq} — ${item.description}` : 'Selecione um item com ↑ ↓'}
        </button>
      </div>
      <div className="seg">
        <button type="button" className={kind === 'percent' ? 'on' : ''} onClick={() => setKind('percent')}>Percentual (%)</button>
        <button type="button" className={kind === 'value' ? 'on' : ''} onClick={() => setKind('value')}>Valor (R$)</button>
      </div>
      <Field label={kind === 'percent' ? 'Percentual' : 'Valor'} hint={`Seu limite: ${Number(limit).toLocaleString('pt-BR')}%. Acima disso, o supervisor autoriza.`}>
        <input data-autofocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
    </Modal>
  );
}
