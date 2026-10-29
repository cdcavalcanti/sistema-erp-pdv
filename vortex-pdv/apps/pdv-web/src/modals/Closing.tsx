import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl, parseMoney } from '../lib/format';
import { can, type Operator } from '../lib/types';
import { useAuthorized } from '../authorize';
import { Alert, Field, Modal } from '../ui';

interface Conference { group: 'cash' | 'pix' | 'debit' | 'credit'; expected: string; informed: string; difference: string; kind: 'positive' | 'negative' | 'none' }
const GROUP: Record<Conference['group'], string> = { cash: 'Dinheiro', pix: 'Pix', debit: 'Débito', credit: 'Crédito' };
const KIND: Record<Conference['kind'], string> = { positive: 'Sobra', negative: 'Falta', none: 'Sem diferença' };

/**
 * Fechamento e conferência (seções 27 e 28): o operador informa dinheiro contado e totais de
 * Pix e cartões; aparecem esperado, informado e diferença. Fechamento cego quando o ERP define.
 */
export function ClosingModal({ operator, blind, onClose, onClosed }: { operator: Operator; blind: boolean; onClose: () => void; onClosed: () => void }) {
  const [summary, setSummary] = useState<any>(null);
  const [informed, setInformed] = useState({ cash: '', pix: '', debit: '', credit: '' });
  const [result, setResult] = useState<{ conference: Conference[]; difference: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const authorized = useAuthorized();
  const showExpected = !blind || can(operator, 'pdv.caixa.fechar');
  useEffect(() => {
    api('GET', '/api/cash/summary').then(setSummary).catch((e) => setError(e.message));
  }, []);

  if (result) {
    return (
      <Modal key="result" title="Caixa fechado" tone={result.difference === '0.00' ? 'ok' : 'danger'} onClose={onClosed} onSubmit={onClosed}
        footer={<button className="primary" type="submit" data-autofocus>Concluir <kbd>ENTER</kbd></button>}>
        <table className="conf">
          <thead><tr><th>Forma</th><th>Esperado</th><th>Informado</th><th>Diferença</th><th /></tr></thead>
          <tbody>{result.conference.map((c) => (
            <tr key={c.group} className={c.kind}><td>{GROUP[c.group]}</td><td className="num">{brl(c.expected)}</td><td className="num">{brl(c.informed)}</td>
              <td className="num">{brl(c.difference)}</td><td>{KIND[c.kind]}</td></tr>
          ))}</tbody>
        </table>
        <Alert kind={result.difference === '0.00' ? 'ok' : 'warn'}>Diferença total: R$ {brl(result.difference)} — registrada e enviada ao ERP.</Alert>
      </Modal>
    );
  }
  return (
    <Modal key="form" title="Fechamento do caixa" wide onClose={onClose} onSubmit={async () => {
      setError(null);
      try {
        setResult(await authorized((authorization) => api('POST', '/api/cash/close', {
          informed: { cash: parseMoney(informed.cash || '0'), pix: parseMoney(informed.pix || '0'), debit: parseMoney(informed.debit || '0'), credit: parseMoney(informed.credit || '0') },
          authorization })));
      } catch (e) {
        if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setError(e.message);
      }
    }} footer={<button className="primary" type="submit">Fechar caixa <kbd>ENTER</kbd></button>}>
      {error && <Alert kind="error">{error}</Alert>}
      {summary && (
        <p className="muted">{summary.salesCount} venda(s) · R$ {brl(summary.salesTotal)}{showExpected && summary.expected ? ` · esperado em dinheiro R$ ${brl(summary.expected.cash)}` : ' · fechamento cego'}</p>
      )}
      <div className="grid2">
        {(['cash', 'pix', 'debit', 'credit'] as const).map((g, i) => (
          <Field key={g} label={`${GROUP[g]} ${g === 'cash' ? 'contado na gaveta' : 'conforme extrato/comprovantes'} (R$)`}
            hint={showExpected && summary?.expected ? `Esperado: ${brl(summary.expected[g])}` : undefined}>
            <input {...(i === 0 ? { 'data-autofocus': true } : {})} inputMode="decimal" value={informed[g]} onChange={(e) => setInformed({ ...informed, [g]: e.target.value })} />
          </Field>
        ))}
      </div>
    </Modal>
  );
}
