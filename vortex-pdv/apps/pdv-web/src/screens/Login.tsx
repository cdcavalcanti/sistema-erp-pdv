import { useRef, useState } from 'react';
import { api, ApiError, session } from '../lib/api';
import type { Status, Terminal } from '../App';
import { VortexLockup } from '@vortex/brand';
import { StatusBar } from './StatusBar';
import { Alert } from '../ui';

/** Login extremamente rápido (seção 6): usuário + PIN, funciona offline. */
export function LoginScreen({ terminal, status, onLogged }: { terminal: Terminal; status: Status | null; onLogged: () => void }) {
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (busy || !login || !pin) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('POST', '/api/auth/login', { login: login.trim(), pin });
      session.set(r.token);
      onLogged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha no login');
      setPin('');
      pinRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen center">
      <StatusBar terminal={terminal} status={status} />
      <div className="login-stage">
        <VortexLockup size={56} glow tagline="PONTO DE VENDA" />
        <form className="card login" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <h1>Entrar no caixa {terminal.terminal}</h1>
          {error && <Alert kind="error">{error}</Alert>}
          <label className="field big"><span>Usuário</span>
            <input autoFocus value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="off" autoCapitalize="none"
              onKeyDown={(e) => e.key === 'Enter' && login && (e.preventDefault(), pinRef.current?.focus())} />
          </label>
          <label className="field big"><span>PIN</span>
            <input ref={pinRef} type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" />
          </label>
          <button className="primary xl" type="submit" disabled={busy || !login || !pin}>Entrar <kbd>ENTER</kbd></button>
          {status?.services.erp.status !== 'online' && <p className="muted">ERP offline: o login funciona com os operadores já sincronizados.</p>}
        </form>
      </div>
    </div>
  );
}
