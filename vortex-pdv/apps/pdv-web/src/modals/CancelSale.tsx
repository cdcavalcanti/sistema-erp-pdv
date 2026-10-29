import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl } from '../lib/format';
import type { SaleView } from '../lib/types';
import { useAuthorized } from '../authorize';
import { Alert, Field, Modal } from '../ui';

/** Cancelamento da venda (seção 23): motivo, usuário, autorização e data/hora ficam registrados. */
export function CancelSaleModal({ sale, onClose, onDone }: { sale: SaleView; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const authorized = useAuthorized();
  const completed = sale.sale.status === 'completed';
  return (
    <Modal title={`Cancelar venda ${sale.sale.number}`} tone="danger" onClose={onClose} onSubmit={async () => {
      setError(null);
      try {
        await authorized((authorization) => api('POST', `/api/sales/${sale.sale.id}/cancel`, { reason, authorization }));
        onDone();
      } catch (e) {
        if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setError(e.message);
      }
    }} footer={<button className="danger" type="submit">Cancelar venda <kbd>ENTER</kbd></button>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p>Total R$ {brl(sale.sale.total)}. {completed ? 'A NFC-e será cancelada na SEFAZ e os pagamentos estornados.' : 'Pagamentos já aprovados serão estornados.'}</p>
      <Field label="Motivo (mínimo 15 caracteres)"><textarea data-autofocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Modal>
  );
}
