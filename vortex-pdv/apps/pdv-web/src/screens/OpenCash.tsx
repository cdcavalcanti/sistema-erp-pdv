import { useState } from 'react';
import { api, ApiError, session } from '../lib/api';
import { parseMoney } from '../lib/format';
import type { SessionInfo, Terminal } from '../App';
import { useAuthorized } from '../authorize';
import { StatusBar } from './StatusBar';
import { Alert } from '../ui';

/** Abertura de caixa (seção 7): valor inicial (fundo de troco); registra operador, terminal e sessão. */
export function OpenCashScreen({ terminal, info, onOpened }: { terminal: Terminal; info: SessionInfo; onOpened: () => void }) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const authorized = useAuthorized();
  const submit = async () => {
    setError(null);
    try {
      await authorized((authorization) => api('POST', '/api/cash/open', { amount: parseMoney(amount || '0'), authorization }));
      onOpened();
    } catch (e) {
      if (e instanceof ApiError) setError(e.message);
    }
  };
  return (
    <div className="screen center">
      <StatusBar terminal={terminal} status={null} operator={info.operator} />
      <form className="card login" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h1>Abertura do caixa {terminal.terminal}</h1>
        <p className="muted">Conte o fundo de troco e informe o valor inicial.</p>
        {error && <Alert kind="error">{error}</Alert>}
        <label className="field big"><span>Valor inicial (R$)</span>
          <input autoFocus inputMode="decimal" placeholder="0,00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button className="primary xl" type="submit">Abrir caixa <kbd>ENTER</kbd></button>
        <button type="button" className="link" onClick={() => api('POST', '/api/auth/logout').finally(() => session.set(null))}>Trocar operador</button>
      </form>
    </div>
  );
}
