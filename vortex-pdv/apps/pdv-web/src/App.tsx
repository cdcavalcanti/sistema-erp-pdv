import { useCallback, useEffect, useState } from 'react';
import { api, session } from './lib/api';
import type { CashSession, Operator, SaleView } from './lib/types';
import { AuthorizationProvider } from './authorize';
import { LoginScreen } from './screens/Login';
import { OpenCashScreen } from './screens/OpenCash';
import { SaleScreen } from './screens/Sale';
import { NotPairedScreen } from './screens/NotPaired';

export interface Terminal {
  terminal: string;
  version: string;
  store: { trade_name?: string; legal_name?: string } | null;
  online: boolean;
  environment: 1 | 2;
  paired: boolean;
  simulators: string[];
}

export interface Status {
  services: Record<'erp' | 'fiscal' | 'payment' | 'printer' | 'localDb' | 'scale', { status: string; [k: string]: any }>;
  alerts: string[];
  update: { requested: string | null; safe: boolean; reason: string | null };
}

export interface SessionInfo {
  operator: Operator;
  cash: CashSession | null;
  sale: SaleView | null;
  online: boolean;
  settings: { cash: { blindClosing: boolean; maxCashInDrawer: string }; payments: { maxInstallments: number }; receipt: { footer: string } };
}

/**
 * Vortex PDV: tela de operação, não um painel administrativo (seção 46). Fluxo: terminal
 * pareado → login (usuário + PIN) → abertura de caixa → frente de caixa.
 */
export function App() {
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState(session.token);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [agentDown, setAgentDown] = useState(false);

  useEffect(() => session.onChange(() => setToken(session.token)), []);

  const refreshStatus = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([api<Terminal>('GET', '/api/terminal'), api<Status>('GET', '/api/status')]);
      setTerminal(t);
      setStatus(s);
      setAgentDown(false);
    } catch {
      setAgentDown(true);
    }
  }, []);

  const refreshSession = useCallback(async () => {
    if (!session.token) return setInfo(null);
    try {
      setInfo(await api<SessionInfo>('GET', '/api/session'));
    } catch {
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const id = setInterval(refreshStatus, 10_000);
    return () => clearInterval(id);
  }, [refreshStatus]);
  useEffect(() => void refreshSession(), [token, refreshSession]);

  if (agentDown) {
    return <div className="fatal"><h1>Agente do PDV não responde</h1><p>Verifique se o serviço Vortex PDV está em execução neste terminal.</p>
      <button className="primary" onClick={refreshStatus}>Tentar novamente</button></div>;
  }
  if (!terminal) return <div className="fatal"><p>Carregando…</p></div>;
  if (!terminal.paired) return <NotPairedScreen terminal={terminal} status={status} onRetry={refreshStatus} />;

  return (
    <AuthorizationProvider>
      {!token || !info ? (
        <LoginScreen terminal={terminal} status={status} onLogged={refreshSession} />
      ) : !info.cash ? (
        <OpenCashScreen terminal={terminal} info={info} onOpened={refreshSession} />
      ) : (
        <SaleScreen terminal={terminal} status={status} info={info} refreshStatus={refreshStatus} refreshSession={refreshSession} />
      )}
    </AuthorizationProvider>
  );
}
