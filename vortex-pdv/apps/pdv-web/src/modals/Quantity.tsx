import { useState } from 'react';
import { qty } from '../lib/format';
import type { Item } from '../lib/types';
import { Field, Modal } from '../ui';

/** Quantidade (seção 11): antes do próximo produto ou alterando o item selecionado. */
export function QuantityModal({ item, onClose, onNext, onItem }: { item: Item | null; onClose: () => void; onNext: (q: string) => void; onItem: (q: string) => void }) {
  const [value, setValue] = useState('');
  const valid = Number(value.replace(',', '.')) > 0;
  return (
    <Modal title="Quantidade" onClose={onClose} onSubmit={() => valid && (item ? onItem(value) : onNext(value))}
      footer={<>
        {item && <button type="button" disabled={!valid} onClick={() => onNext(value)}>Para o próximo item</button>}
        <button className="primary" type="submit" disabled={!valid}>{item ? `Alterar item ${item.seq}` : 'Próximo item'} <kbd>ENTER</kbd></button>
      </>}>
      {item && <p>Item {item.seq}: <b>{item.description}</b> — atual {qty(item.quantity)} {item.unit}</p>}
      <Field label="Quantidade" hint="Pesáveis aceitam decimais (0,350)">
        <input data-autofocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
    </Modal>
  );
}
