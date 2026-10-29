import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { brl } from '../lib/format';
import { Alert, Modal } from '../ui';

/** Painel operacional (seção 47): vendas hoje, número, ticket médio, caixas abertos, operadores e pendências. */
export function DashboardModal({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api('GET', '/api/dashboard').then(setD).catch((e) => setError(e instanceof ApiError ? e.message : 'Falha'));
  }, []);
  const k = (label: string, value: string | number) => <div className="kpi"><span>{label}</span><strong>{value}</strong></div>;
  return (
    <Modal title="Painel operacional de hoje" wide onClose={onClose}>
      {error && <Alert kind="error">{error}</Alert>}
      {d && (
        <>
          <h3>Este terminal</h3>
          <div className="kpis">
            {k('Vendas hoje', `R$ ${brl(d.terminal.salesTotal)}`)}{k('Número de vendas', d.terminal.salesCount)}{k('Ticket médio', `R$ ${brl(d.terminal.averageTicket)}`)}
            {k('Caixas abertos', d.terminal.openCash.length)}{k('Pendências de sincronização', d.terminal.pendingSync)}
          </div>
          {d.terminal.operators.length > 0 && <p className="muted">Operadores: {d.terminal.operators.map((o: any) => `${o.name} (${o.n})`).join(', ')}</p>}
          {d.store ? (
            <>
              <h3>Loja (todos os terminais, pelo ERP)</h3>
              <div className="kpis">
                {k('Vendas hoje', `R$ ${brl(d.store.salesTotal)}`)}{k('Número de vendas', d.store.salesCount)}{k('Ticket médio', `R$ ${brl(d.store.averageTicket)}`)}
                {k('Caixas abertos', d.store.openCash?.length ?? 0)}{k('Pendências', d.store.pendingSync ?? 0)}
              </div>
            </>
          ) : <p className="muted">ERP offline: mostrando só este terminal. Relatórios gerenciais completos ficam no ERP.</p>}
        </>
      )}
    </Modal>
  );
}
