import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl, parseMoney } from '../lib/format';
import { useAuthorized } from '../authorize';
import { Alert, Field, Modal } from '../ui';

/** Sangria (seção 25) e suprimento (seção 26): valor, motivo e observação; supervisor quando exigido. */
export function CashMoveModal({ kind, onClose, onDone }: { kind: 'withdrawal' | 'supply'; onClose: () => void; onDone: (text: string) => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState(kind === 'withdrawal' ? 'Excesso de dinheiro no caixa' : 'Reforço de troco');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const authorized = useAuthorized();
  const label = kind === 'withdrawal' ? 'Sangria' : 'Suprimento';
  return (
    <Modal title={label} onClose={onClose} onSubmit={async () => {
      setError(null);
      try {
        const r = await authorized((authorization) => api<{ amount: string }>('POST', kind === 'withdrawal' ? '/api/cash/withdraw' : '/api/cash/supply',
          { amount: parseMoney(amount), reason, note: note || null, authorization }));
        onDone(`${label} de R$ ${brl(r.amount)} registrada`);
      } catch (e) {
        if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setError(e.message);
      }
    }} footer={<button className="primary" type="submit">Registrar {label.toLowerCase()} <kbd>ENTER</kbd></button>}>
      {error && <Alert kind="error">{error}</Alert>}
      <Field label="Valor (R$)"><input data-autofocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Motivo"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      {kind === 'withdrawal' && <Field label="Observação"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: envelope 12" /></Field>}
    </Modal>
  );
}
