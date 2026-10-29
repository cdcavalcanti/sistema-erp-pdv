import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl } from '../lib/format';
import type { SaleView } from '../lib/types';
import { useAuthorized } from '../authorize';
import { Alert, Field, Modal } from '../ui';

/** Recuperação de energia (seção 43): venda em andamento encontrada → recuperar ou descartar com controle. */
export function RecoveryModal({ sale, onResume, onDiscarded }: { sale: SaleView; onResume: () => void; onDiscarded: () => void }) {
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState('Venda interrompida por queda de energia');
  const [error, setError] = useState<string | null>(null);
  const authorized = useAuthorized();
  const items = sale.items.filter((i) => i.status === 'active');
  const paid = sale.payments.filter((p) => p.status === 'approved' || p.status === 'pending');
  return (
    <Modal title="Venda em andamento encontrada" onClose={onResume} onSubmit={async () => {
      if (!discarding) return onResume();
      try {
        await authorized((authorization) => api('POST', `/api/sales/${sale.sale.id}/cancel`, { reason, authorization }));
        onDiscarded();
      } catch (e) {
        if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setError(e.message);
      }
    }} footer={discarding ? <button className="danger" type="submit">Descartar venda</button> : <>
      <button type="button" onClick={() => setDiscarding(true)}>Descartar</button>
      <button className="primary xl" type="submit" data-autofocus>Recuperar venda <kbd>ENTER</kbd></button>
    </>}>
      <p>Venda <b>{sale.sale.number}</b> com {items.length} item(ns), total R$ {brl(sale.sale.total)}.</p>
      {paid.length > 0 && <Alert kind="warn">Há {paid.length} pagamento(s) registrados nesta venda: ao descartar, serão estornados.</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {discarding && <Field label="Motivo do descarte"><textarea data-autofocus rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
    </Modal>
  );
}
