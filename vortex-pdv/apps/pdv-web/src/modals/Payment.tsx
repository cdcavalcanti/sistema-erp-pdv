import { useEffect, useRef, useState } from 'react';
import { api, ApiError, newKey } from '../lib/api';
import { brl, parseMoney } from '../lib/format';
import type { Payment, SaleView } from '../lib/types';
import type { Terminal } from '../App';
import { Qr } from '../lib/qr';
import { Alert, Field, Modal } from '../ui';

type Method = Payment['method'];
const METHODS: { m: Method; label: string; key: string }[] = [
  { m: 'cash', label: 'Dinheiro', key: 'D' }, { m: 'pix', label: 'Pix', key: 'P' }, { m: 'debit', label: 'Débito', key: 'B' }, { m: 'credit', label: 'Crédito', key: 'C' },
  { m: 'pos_debit', label: 'Maquininha débito', key: 'M' }, { m: 'pos_credit', label: 'Maquininha crédito', key: 'N' },
];
export const LABEL: Record<Method, string> = { cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito', pos_debit: 'Maquininha débito', pos_credit: 'Maquininha crédito' };
const STATUS: Record<Payment['status'], string> = { pending: 'aguardando', approved: 'aprovado', declined: 'recusado', cancelled: 'cancelado', timeout: 'tempo esgotado', refunded: 'estornado' };

/**
 * Pagamento (seções 15 a 19): dinheiro com troco, Pix com QR Code aguardando a confirmação real do
 * PSP, cartão no TEF (pinpad) ou na maquininha, e pagamento múltiplo. A venda conclui sozinha
 * quando o total aprovado fecha. Nada é considerado pago sem confirmação.
 */
export function PaymentModal({ sale, terminal, maxInstallments, onChange, onCompleted, onBack }: {
  sale: SaleView; terminal: Terminal; maxInstallments: number; onChange: (v: SaleView) => void; onCompleted: (v: SaleView) => void; onBack: () => void;
}) {
  const [method, setMethod] = useState<Method>('cash');
  const [amount, setAmount] = useState(brl(sale.remaining));
  const [installments, setInstallments] = useState(1);
  const [pos, setPos] = useState({ nsu: '', authorization: '', brand: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const completing = useRef(false);
  const pending = sale.payments.find((p) => p.status === 'pending');
  const approved = sale.payments.filter((p) => p.status === 'approved');
  const remaining = Number(sale.remaining);
  const simulated = terminal.simulators.length > 0 && terminal.environment === 2;

  useEffect(() => setAmount(brl(sale.remaining)), [sale.remaining]);

  // Aguardando Pix/TEF: consulta o provedor até aprovar, recusar ou esgotar o tempo
  useEffect(() => {
    if (!pending || pending.method.startsWith('pos_')) return;
    const id = setInterval(() => {
      api<SaleView>('POST', `/api/payments/${pending.id}/poll`).then(onChange).catch(() => undefined);
    }, 1500);
    return () => clearInterval(id);
  }, [pending?.id]);

  // Total pago fechou: conclui (NFC-e, impressão, registro, fila do ERP)
  useEffect(() => {
    if (remaining > 0 || pending || completing.current || sale.sale.status !== 'payment') return;
    completing.current = true;
    setBusy(true);
    api<SaleView>('POST', `/api/sales/${sale.sale.id}/complete`)
      .then(onCompleted)
      .catch((e) => { completing.current = false; setError(e instanceof ApiError ? e.message : 'Falha ao concluir a venda'); })
      .finally(() => setBusy(false));
  }, [remaining, pending?.id, sale.sale.status]);

  const pay = async () => {
    if (busy || pending) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api<SaleView>('POST', `/api/sales/${sale.sale.id}/payments`, { method, amount: parseMoney(amount), installments: method.endsWith('credit') ? installments : undefined,
        idempotencyKey: newKey() }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha no pagamento');
    } finally {
      setBusy(false);
    }
  };

  const cashChange = method === 'cash' ? Math.max(0, Number(parseMoney(amount)) - remaining) : 0;
  const onKey = (e: React.KeyboardEvent) => {
    if (!e.altKey) return;
    const m = METHODS.find((x) => x.key === e.key.toUpperCase());
    if (m) {
      e.preventDefault();
      setMethod(m.m);
    }
  };

  return (
    <Modal title={`Pagamento — venda ${sale.sale.number}`} wide onClose={() => (pending ? undefined : onBack())} onSubmit={() => void pay()}
      footer={!pending && remaining > 0 ? <>
        <button type="button" onClick={onBack} disabled={approved.length > 0}>Voltar à venda <kbd>ESC</kbd></button>
        <button className="primary xl" type="submit" disabled={busy}>Receber {LABEL[method]} <kbd>ENTER</kbd></button>
      </> : undefined}>
      <div className="pay" onKeyDown={onKey}>
        <div className="pay-summary">
          <div><span>Total</span><strong>R$ {brl(sale.sale.total)}</strong></div>
          <div><span>Pago</span><strong>R$ {brl(approved.reduce((a, p) => a + Number(p.amount), 0))}</strong></div>
          <div className="due"><span>Falta</span><strong data-testid="remaining">R$ {brl(sale.remaining)}</strong></div>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        {busy && remaining === 0 && <Alert kind="info">Emitindo NFC-e e imprimindo…</Alert>}

        {pending ? <PendingPayment p={pending} simulated={simulated} pos={pos} setPos={setPos} onChange={onChange} setError={setError} /> : remaining > 0 && (
          <>
            <div className="methods" role="radiogroup" aria-label="Forma de pagamento">
              {METHODS.map((x) => (
                <button key={x.m} type="button" role="radio" aria-checked={method === x.m} className={method === x.m ? 'on' : ''} onClick={() => setMethod(x.m)}>
                  {x.label} <kbd>Alt+{x.key}</kbd>
                </button>
              ))}
            </div>
            <div className="pay-fields">
              <Field label={method === 'cash' ? 'Valor recebido (R$)' : 'Valor (R$)'}>
                <input data-autofocus className="big" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.target.select()} />
              </Field>
              {method.endsWith('credit') && (
                <Field label="Parcelas">
                  <select value={installments} onChange={(e) => setInstallments(Number(e.target.value))}>
                    {Array.from({ length: maxInstallments }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? 'À vista' : `${n}x de R$ ${brl(Number(parseMoney(amount)) / n)}`}</option>)}
                  </select>
                </Field>
              )}
              {method === 'cash' && <div className="change" aria-live="polite">Troco <strong>R$ {brl(cashChange)}</strong></div>}
            </div>
          </>
        )}

        {sale.payments.length > 0 && (
          <table className="pays">
            <tbody>
              {sale.payments.map((p) => (
                <tr key={p.id} className={p.status}>
                  <td>{LABEL[p.method]}{p.installments > 1 ? ` ${p.installments}x` : ''}</td>
                  <td className="num">R$ {brl(p.amount)}{Number(p.change) > 0 && <small> (troco {brl(p.change)})</small>}</td>
                  <td>{STATUS[p.status]}{p.nsu ? ` · NSU ${p.nsu}` : ''}{p.message && p.status !== 'approved' ? ` · ${p.message}` : ''}</td>
                  <td>{p.status === 'approved' && sale.sale.status === 'payment' && remaining > 0 && (
                    <button type="button" className="link" onClick={() => api<SaleView>('POST', `/api/payments/${p.id}/cancel`).then(onChange).catch((e) => setError(e.message))}>Estornar</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}

function PendingPayment({ p, simulated, pos, setPos, onChange, setError }: {
  p: Payment; simulated: boolean; pos: { nsu: string; authorization: string; brand: string }; setPos: (v: { nsu: string; authorization: string; brand: string }) => void;
  onChange: (v: SaleView) => void; setError: (m: string | null) => void;
}) {
  const cancel = () => api<SaleView>('POST', `/api/payments/${p.id}/cancel`).then(onChange).catch((e) => setError(e.message));
  if (p.method === 'pix') {
    return (
      <div className="pending pix">
        {p.qr_code && <Qr value={p.qr_code} label="QR Code Pix" />}
        <div>
          <h3>Pix de R$ {brl(p.amount)}</h3>
          <p className="wait">Aguardando a confirmação do pagamento…</p>
          <p className="muted">O pagamento só é aceito quando o banco confirma. Mostrar o QR Code não confirma nada.</p>
          {p.expires_at && <p className="muted">Expira às {new Date(p.expires_at).toLocaleTimeString('pt-BR')}</p>}
          <details><summary>Pix copia e cola</summary><code className="copy">{p.qr_code}</code></details>
          <div className="row">
            <button type="button" onClick={() => void cancel()}>Cancelar Pix</button>
            {simulated && <button type="button" className="sim" onClick={() => api('POST', `/api/dev/pix/${p.transaction_id}/pay`)}>Simular pagamento do cliente (homologação)</button>}
          </div>
        </div>
      </div>
    );
  }
  if (p.method === 'debit' || p.method === 'credit') {
    return (
      <div className="pending">
        <h3>{LABEL[p.method]} de R$ {brl(p.amount)} no pinpad</h3>
        <p className="wait">{p.message ?? 'Aguardando o cartão…'}</p>
        <button type="button" onClick={() => void cancel()}>Cancelar transação</button>
      </div>
    );
  }
  return (
    <form className="pending" onSubmit={async (e) => {
      e.preventDefault();
      try {
        onChange(await api<SaleView>('POST', `/api/payments/${p.id}/confirm`, { nsu: pos.nsu, authorization: pos.authorization, brand: pos.brand || null }));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Falha na confirmação');
      }
    }}>
      <h3>{LABEL[p.method]} de R$ {brl(p.amount)}</h3>
      <p className="muted">Passe o cartão na maquininha e copie do comprovante dela:</p>
      <div className="grid3">
        <Field label="NSU"><input data-autofocus inputMode="numeric" value={pos.nsu} onChange={(e) => setPos({ ...pos, nsu: e.target.value })} /></Field>
        <Field label="Autorização"><input value={pos.authorization} onChange={(e) => setPos({ ...pos, authorization: e.target.value })} /></Field>
        <Field label="Bandeira"><input value={pos.brand} onChange={(e) => setPos({ ...pos, brand: e.target.value })} placeholder="VISA, MASTER, ELO…" /></Field>
      </div>
      <div className="row"><button type="button" onClick={() => void cancel()}>Cancelar</button><button className="primary" type="submit">Confirmar pagamento</button></div>
    </form>
  );
}
