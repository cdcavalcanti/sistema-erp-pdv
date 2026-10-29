import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl } from '../lib/format';
import type { SaleView } from '../lib/types';
import { useAuthorized } from '../authorize';
import { Qr } from '../lib/qr';
import { Alert, Modal } from '../ui';
import { LABEL } from './Payment';

const FISCAL: Record<string, [string, 'ok' | 'warn' | 'error']> = {
  authorized: ['NFC-e autorizada', 'ok'], contingency: ['NFC-e em contingência (será transmitida)', 'warn'], rejected: ['NFC-e rejeitada: reprocessar em Vendas', 'error'],
  pending: ['NFC-e aguardando retorno', 'warn'],
};

/** Venda concluída (seção 20): número, total, pagamentos, troco e situação fiscal; imprimir, comprovante digital, nova venda. */
export function CompletedModal({ sale, onClose }: { sale: SaleView; onClose: () => void }) {
  const [receipt, setReceipt] = useState<{ text: string; qrUrl: string | null } | null>(null);
  const [digital, setDigital] = useState(false);
  const [msg, setMsg] = useState<string | null>(sale.printError ?? null);
  const authorized = useAuthorized();
  const fiscal = FISCAL[sale.fiscal?.status ?? 'pending'] ?? FISCAL.pending!;
  useEffect(() => {
    api<{ text: string; qrUrl: string | null }>('GET', `/api/sales/${sale.sale.id}/receipt`).then(setReceipt).catch(() => undefined);
  }, [sale.sale.id]);
  return (
    <Modal title="Venda concluída" tone="ok" wide onClose={onClose} onSubmit={onClose} footer={<>
      <button type="button" onClick={async () => {
        try {
          await authorized((authorization) => api('POST', `/api/sales/${sale.sale.id}/reprint`, { authorization }));
          setMsg('Comprovante reimpresso');
        } catch (e) {
          if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setMsg(e.message);
        }
      }}>Imprimir novamente</button>
      <button type="button" onClick={() => setDigital(!digital)} disabled={!receipt?.qrUrl}>Comprovante digital</button>
      <button className="primary xl" type="submit" data-autofocus>Nova venda <kbd>ENTER</kbd></button>
    </>}>
      <div className="done">
        <div>
          <p className="muted">Venda {sale.sale.number}</p>
          <p className="done-total">R$ {brl(sale.sale.total)}</p>
          {Number(sale.sale.change_total) > 0 && <p className="done-change">TROCO <strong>R$ {brl(sale.sale.change_total)}</strong></p>}
          <ul className="plain">{sale.payments.filter((p) => p.status === 'approved').map((p) => <li key={p.id}>{LABEL[p.method]} — R$ {brl(Number(p.amount) + Number(p.change))}</li>)}</ul>
          <Alert kind={fiscal[1]}>{fiscal[0]}{sale.fiscal ? ` · nº ${sale.fiscal.number} série ${sale.fiscal.series}` : ''}</Alert>
          {msg && <Alert kind="warn">{msg}</Alert>}
          {digital && receipt?.qrUrl && <div className="digital"><Qr value={receipt.qrUrl} size={180} label="QR Code de consulta da NFC-e" /><p className="muted">O cliente aponta a câmera para consultar a NFC-e.</p></div>}
        </div>
        {receipt && <pre className="receipt" aria-label="Comprovante">{receipt.text}</pre>}
      </div>
    </Modal>
  );
}
