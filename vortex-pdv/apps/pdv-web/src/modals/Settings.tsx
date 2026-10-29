import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Alert, Field, Modal } from '../ui';

const LABELS: Record<string, string> = { 'receipt.footer': 'Rodapé do comprovante', 'receipt.columns': 'Colunas da impressora (32, 42 ou 48)', 'session.idleMinutes': 'Bloqueio por inatividade (minutos)',
  'receipt.header': 'Cabeçalho do comprovante' };

/** Parâmetros (seção 5, gerente): só os que o ERP libera para o terminal; o resto vem do ERP. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<any>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => {
    api('GET', '/api/settings').then((s) => {
      setSettings(s);
      setValues(Object.fromEntries(s.localOverridable.map((p: string) => [p, String(p.split('.').reduce((a: any, k) => a?.[k], s) ?? '')])));
    });
  }, []);
  const save = async () => {
    setMsg(null);
    try {
      for (const [path, v] of Object.entries(values)) {
        const current = String(path.split('.').reduce((a: any, k) => a?.[k], settings) ?? '');
        if (v !== current) await api('PUT', '/api/settings', { path, value: /^\d+$/.test(v) ? Number(v) : v });
      }
      setMsg({ kind: 'ok', text: 'Parâmetros salvos' });
    } catch (e) {
      setMsg({ kind: 'error', text: e instanceof ApiError ? e.message : 'Falha ao salvar' });
    }
  };
  return (
    <Modal title="Parâmetros do terminal" onClose={onClose} onSubmit={() => void save()} footer={<button className="primary" type="submit">Salvar <kbd>ENTER</kbd></button>}>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <p className="muted">Limites de desconto, estoque, pagamentos e fiscal são definidos no ERP.</p>
      {Object.keys(values).map((p, i) => (
        <Field key={p} label={LABELS[p] ?? p}><input {...(i === 0 ? { 'data-autofocus': true } : {})} value={values[p]} onChange={(e) => setValues({ ...values, [p]: e.target.value })} /></Field>
      ))}
    </Modal>
  );
}
