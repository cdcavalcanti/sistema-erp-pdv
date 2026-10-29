import { useEffect, useState } from 'react';
import { ThemeToggle, VortexSymbol } from '@vortex/brand';
import type { Status, Terminal } from '../App';
import type { Operator } from '../lib/types';

/** Faixa superior: loja, terminal, operador, caixa e conexão (seção 6) com pendências (seção 29). */
export function StatusBar({ terminal, status, operator, cashOpenedAt, onStatus }: {
  terminal: Terminal; status: Status | null; operator?: Operator | null; cashOpenedAt?: string | null; onStatus?: () => void;
}) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const erp = status?.services.erp;
  const online = erp?.status === 'online';
  const pending = erp?.queue?.pendingSales ?? 0;
  const contingency = status?.services.fiscal.contingency ?? 0;
  return (
    <header className="topbar">
      <div className="brand"><VortexSymbol size={22} glow title="Vortex PDV" /> {terminal.store?.trade_name || terminal.store?.legal_name || 'Vortex PDV'}</div>
      <div className="chip">Caixa <b>{terminal.terminal}</b></div>
      {operator && <div className="chip">Operador <b>{operator.name}</b></div>}
      {cashOpenedAt && <div className="chip">Aberto às <b>{new Date(cashOpenedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b></div>}
      {terminal.environment === 2 && <div className="chip warn">Homologação</div>}
      <div className="spacer" />
      <button type="button" className={`conn ${online ? 'ok' : 'off'}`} onClick={onStatus} aria-label="Situação dos serviços">
        <span className="dot" />{online ? 'Online' : 'OFFLINE'}
        {pending > 0 && <span className="badge">{pending} pendente{pending > 1 ? 's' : ''}</span>}
        {contingency > 0 && <span className="badge warn">{contingency} em contingência</span>}
      </button>
      <ThemeToggle className="theme-btn" />
      <div className="clock">{now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
    </header>
  );
}
