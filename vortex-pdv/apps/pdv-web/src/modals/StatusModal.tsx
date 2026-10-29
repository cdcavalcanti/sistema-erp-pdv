import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuthorized } from '../authorize';
import type { Status, Terminal } from '../App';
import { Alert, Field, Modal } from '../ui';

const NAMES: Record<string, string> = { erp: 'ERP', fiscal: 'Fiscal (NFC-e)', payment: 'Pagamento', printer: 'Impressora', localDb: 'Banco local', scale: 'Balança' };
const GOOD = new Set(['online', 'ok']);
const TYPE: Record<string, string> = { sale: 'Venda', sale_cancel: 'Cancelamento', return: 'Devolução', cash_movement: 'Caixa', customer: 'Cliente', nfce_authorization: 'Autorização de contingência' };

/** Tela de status (seção 42): ERP, fiscal, pagamento, impressora e banco local; alertas claros. */
export function StatusModal({ terminal, onClose }: { terminal: Terminal; onClose: () => void }) {
  const [st, setSt] = useState<Status | null>(null);
  const [queue, setQueue] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const authorized = useAuthorized();
  const archive = async () => {
    setError(null);
    try {
      await authorized((authorization) => api('POST', `/api/sync/${archiving.id}/archive`, { reason, authorization }));
      setArchiving(null);
      setReason('');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'AUTHORIZATION_CANCELLED') setError(e.message);
    }
  };
  const load = () => Promise.all([api<Status>('GET', '/api/status').then(setSt), api('GET', '/api/sync/queue?status=FAILED').then(setQueue)]).catch(() => undefined);
  useEffect(() => void load(), []);
  const sync = async () => {
    setBusy(true);
    await api('POST', '/api/sync', {}).catch(() => undefined);
    await load();
    setBusy(false);
  };
  const dev = (path: string, body: unknown) => api('POST', path, body).then(load).catch(() => undefined);
  return (
    <Modal title="Status dos serviços" wide onClose={onClose} footer={<>
      <button type="button" onClick={() => api('POST', '/api/sync/retry', {}).then(sync)}>Reenviar falhas</button>
      <button className="primary" type="button" onClick={() => void sync()} disabled={busy}>{busy ? 'Sincronizando…' : 'Sincronizar agora'}</button>
    </>}>
      {st?.alerts.map((a) => <Alert key={a} kind="warn">{a}</Alert>)}
      <ul className="services">
        {st && Object.entries(st.services).map(([k, v]) => (
          <li key={k} className={GOOD.has(v.status) ? 'ok' : 'bad'}>
            <span className="dot" /><b>{NAMES[k]}</b><span>{v.status}</span>
            {k === 'erp' && <small>Fila: {v.queue.PENDING} pendente(s), {v.queue.FAILED} com falha · última carga {v.lastPullAt ? new Date(v.lastPullAt).toLocaleTimeString('pt-BR') : '—'}</small>}
            {k === 'fiscal' && <small>{v.provider} · contingência {v.contingency} · rejeitadas {v.rejected}</small>}
          </li>
        ))}
      </ul>
      {queue?.items?.length > 0 && (
        <>
          <h3>Envios com falha</h3>
          <ul className="plain failed-list">{queue.items.map((i: any) => (
            <li key={i.id}>
              <span><b>{TYPE[i.type] ?? i.type}</b> · {i.attempts} tentativa(s) · {i.last_error}</span>
              {!i.retryable && <button type="button" className="sm" onClick={() => { setArchiving(i); setError(null); }}>Arquivar…</button>}
            </li>
          ))}</ul>
          {archiving && (
            <div className="archive-box">
              <p>Arquivar tira este envio da fila e dos alertas; ele fica no histórico com o motivo e quem autorizou. Use só quando o ERP nunca vai aceitar
                (ex.: venda feita quando o terminal estava ligado a outra loja). Precisa de gerente.</p>
              {error && <Alert kind="error">{error}</Alert>}
              <Field label="Motivo (mínimo 10 caracteres)"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="row">
                <button type="button" onClick={() => setArchiving(null)}>Voltar</button>
                <button type="button" className="danger" disabled={reason.trim().length < 10} onClick={() => void archive()}>Arquivar envio</button>
              </div>
            </div>
          )}
        </>
      )}
      <p className="muted">Terminal {terminal.terminal} · versão {terminal.version}{st?.update.requested ? ` · atualização ${st.update.requested} ${st.update.safe ? 'pronta' : `aguardando: ${st.update.reason}`}` : ''}</p>
      {terminal.simulators.length > 0 && (
        <div className="sim-box">
          <b>Integrações simuladas (homologação):</b> {terminal.simulators.join(' · ')}
          <div className="row">
            <button type="button" onClick={() => dev('/api/dev/sefaz', { online: st?.services.fiscal.status !== 'online' })}>SEFAZ {st?.services.fiscal.status === 'online' ? 'fora do ar' : 'no ar'}</button>
            <button type="button" onClick={() => dev('/api/dev/printer', { status: st?.services.printer.status === 'ok' ? 'paper_out' : 'ok' })}>Impressora {st?.services.printer.status === 'ok' ? 'sem papel' : 'ok'}</button>
            <button type="button" onClick={() => dev('/api/dev/scale', { weight: '0.500', stable: true })}>Balança 0,500 kg</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
