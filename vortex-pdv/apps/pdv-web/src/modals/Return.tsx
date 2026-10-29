import { useState } from 'react';
import { api, ApiError, newKey } from '../lib/api';
import { brl, qty } from '../lib/format';
import { useAuthorized } from '../authorize';
import { Alert, Field, Modal } from '../ui';

interface Returnable { saleNumber: string; local: boolean; customerIdentified: boolean; items: { itemNumber: number; description: string; quantity: string; returned: string; unitTotal: string }[] }

/** Devolução (seção 24): pesquisar a venda, selecionar itens, motivo e reembolso; o ERP recebe a operação. */
export function ReturnModal({ onClose, onDone }: { onClose: () => void; onDone: (t: string) => void }) {
  const [number, setNumber] = useState('');
  const [info, setInfo] = useState<Returnable | null>(null);
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'cash' | 'pix' | 'card' | 'store_credit'>('cash');
  const [customer, setCustomer] = useState({ taxId: '', name: '' });
  const [error, setError] = useState<string | null>(null);
  const [reference] = useState(() => `DEV-${newKey()}`);
  const authorized = useAuthorized();
  const total = info?.items.reduce((a, i) => a + Number(qtys[i.itemNumber] || 0) * Number(i.unitTotal), 0) ?? 0;

  const find = async () => {
    setError(null);
    try {
      setInfo(await api<Returnable>('GET', `/api/returns/sale/${encodeURIComponent(number.trim())}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Venda não encontrada');
    }
  };
  const submit = async () => {
    setError(null);
    const items = Object.entries(qtys).filter(([, q]) => Number(q.replace(',', '.')) > 0).map(([n, q]) => ({ itemNumber: Number(n), quantity: q.replace(',', '.') }));
    try {
      await authorized((authorization) => api('POST', '/api/returns', { saleNumber: info!.saleNumber, items, reason, refundMethod: refund,
        customer: info!.customerIdentified ? null : customer, reference, authorization }));
      onDone(`Devolução de R$ ${brl(total)} registrada`);
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setError(e.message);
    }
  };

  return (
    <Modal key={info ? 'items' : 'find'} title="Devolução" wide onClose={onClose} onSubmit={() => void (info ? submit() : find())}
      footer={<button className="primary" type="submit">{info ? `Devolver R$ ${brl(total)}` : 'Pesquisar venda'} <kbd>ENTER</kbd></button>}>
      {error && <Alert kind="error">{error}</Alert>}
      {!info ? (
        <Field label="Número da venda" hint="Está no comprovante: PDV-03-20261027-000124">
          <input data-autofocus value={number} onChange={(e) => setNumber(e.target.value)} />
        </Field>
      ) : (
        <>
          <p>Venda <b>{info.saleNumber}</b>{!info.local && ' (outro terminal)'}</p>
          <table className="conf">
            <thead><tr><th>#</th><th>Produto</th><th>Vendido</th><th>Já devolvido</th><th>Devolver</th></tr></thead>
            <tbody>{info.items.map((i, n) => (
              <tr key={i.itemNumber}><td>{i.itemNumber}</td><td>{i.description}</td><td className="num">{qty(i.quantity)}</td><td className="num">{qty(i.returned)}</td>
                <td><input {...(n === 0 ? { 'data-autofocus': true } : {})} aria-label={`Devolver item ${i.itemNumber}`} inputMode="decimal" className="small"
                  value={qtys[i.itemNumber] ?? ''} onChange={(e) => setQtys({ ...qtys, [i.itemNumber]: e.target.value })} /></td></tr>
            ))}</tbody>
          </table>
          <Field label="Motivo"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Field label="Reembolso">
            <select value={refund} onChange={(e) => setRefund(e.target.value as typeof refund)}>
              <option value="cash">Dinheiro (sai da gaveta)</option><option value="pix" disabled={!info.local}>Devolução do Pix</option>
              <option value="card" disabled={!info.local}>Estorno no cartão</option><option value="store_credit">Crédito em loja</option>
            </select>
          </Field>
          {!info.customerIdentified && (
            <div className="grid2">
              <Field label="CPF de quem devolve"><input inputMode="numeric" value={customer.taxId} onChange={(e) => setCustomer({ ...customer, taxId: e.target.value })} /></Field>
              <Field label="Nome"><input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} /></Field>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
