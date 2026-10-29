import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { download, openAuthed } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { ErrorBox, Input, PageHeader, Select, Status } from '../../components/ui';
import { dateTime, doc, monthStart } from '../../lib/format';
import { usePaged } from '../../lib/hooks';

interface FiscalDoc { id: string; model: string; series: number; number: string; access_key: string | null; status: string; direction: string; recipient_name: string | null; recipient_tax_id: string | null;
  total_invoice: string; issued_at: string | null; sefaz_code: string | null; sefaz_message: string | null; rejection_explanation: string | null }
const MODEL: Record<string, string> = { '55': 'NF-e', '65': 'NFC-e', '99': 'NFS-e' };

/** Notas emitidas: situação na SEFAZ, explicação de rejeições, DANFE e XML. */
export default function FiscalDocumentsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [model, setModel] = useState('');
  const [from, setFrom] = useState(monthStart());
  const list = usePaged<FiscalDoc>(['fiscal-docs'], '/v1/fiscal/documents', { status: status || undefined, model: model || undefined, from, direction: 'S' });
  const [open, setOpen] = useState<FiscalDoc | null>(null);
  return (
    <>
      <PageHeader title="Notas emitidas" actions={<>
        <Select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: 'auto' }} aria-label="Modelo"><option value="">Todos os modelos</option><option value="55">NF-e</option><option value="65">NFC-e</option><option value="99">NFS-e</option></Select>
        <Select value={status} onChange={(e) => setParams(e.target.value ? { status: e.target.value } : {})} style={{ width: 'auto' }} aria-label="Situação">
          <option value="">Todas as situações</option><option value="autorizada">Autorizadas</option><option value="rejeitada">Rejeitadas</option><option value="contingencia">Contingência</option>
          <option value="cancelada">Canceladas</option><option value="pendente_envio">Pendentes</option>
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Desde" style={{ width: 'auto' }} />
      </>} />
      <ErrorBox error={list.error} />
      <DataTable rows={list.rows} rowKey={(r) => r.id} label="Notas" height="calc(100vh - 220px)" onOpen={setOpen}
        footer={list.hasNextPage && <button className="btn sm" onClick={() => list.fetchNextPage()}>Carregar mais</button>}
        columns={[
          { key: 'model', label: 'Modelo', width: '80px', render: (r) => MODEL[r.model] ?? r.model },
          { key: 'number', label: 'Série/número', width: '110px', render: (r) => `${r.series}/${r.number}`, sortValue: (r) => Number(r.number) },
          { key: 'issued_at', label: 'Emissão', width: '158px', render: (r) => dateTime(r.issued_at), sortValue: (r) => r.issued_at },
          { key: 'recipient_name', label: 'Destinatário', width: 'minmax(200px, 3fr)', render: (r) => r.recipient_name ?? <span className="muted">Consumidor</span> },
          { key: 'total_invoice', label: 'Valor', type: 'money', width: '120px' },
          { key: 'status', label: 'Situação', width: '140px', render: (r) => <Status value={r.status} /> },
        ]} />
      {open && (
        <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Nota fiscal">
            <div className="dialog-head"><h2>{MODEL[open.model]} {open.series}/{open.number}</h2><span className="spacer" /><button className="btn ghost sm" onClick={() => setOpen(null)} aria-label="Fechar">✕</button></div>
            <div className="dialog-body stack">
              <div><Status value={open.status} /> {open.sefaz_code && <span className="muted">SEFAZ {open.sefaz_code}: {open.sefaz_message}</span>}</div>
              {open.rejection_explanation && <div className="alert warn">{open.rejection_explanation}</div>}
              <div>{open.recipient_name} <span className="mono muted">{doc(open.recipient_tax_id)}</span></div>
              {open.access_key && <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{open.access_key}</div>}
            </div>
            <div className="dialog-foot">
              {open.model !== '99' && <button className="btn" onClick={() => openAuthed(`/v1/fiscal/documents/${open.id}/danfe`)}>DANFE</button>}
              <button className="btn" onClick={() => download(`/v1/fiscal/documents/${open.id}/xml`, undefined, `${open.access_key ?? open.id}.xml`)}>Baixar XML</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
