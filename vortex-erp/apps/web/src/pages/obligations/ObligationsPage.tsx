import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, download, saveText } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { ErrorBox, Field, Input, Kpi, PageHeader, Select, useToast } from '../../components/ui';
import { brl, pct } from '../../lib/format';

const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const range = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return { from: `${period}-01`, to: new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10) };
};
interface SpedResult { content: string; warnings: string[]; totals?: Record<string, string> }
interface Pgdas { rbt12: string; payroll12: string; factorR: string | null; revenue: string; estimatedDas: string; warnings: string[];
  establishments: { code: string; revenue: string; segments: { annex: string; activity: string; icmsSt: boolean; monophasic: boolean; export: boolean; issRetained: boolean; revenue: string; effectiveRate: string; estimatedDas: string }[] }[] }
interface Reinf { events: { type: string; id: string; summary: Record<string, unknown> }[]; warnings: string[] }

/**
 * Obrigações acessórias (seção 15): o ERP gera os arquivos; o envio é feito pelo contador ou pela
 * empresa nos programas oficiais (PVA, Reinf, PGDAS-D). Cada arquivo deve passar no validador oficial.
 */
export default function ObligationsPage() {
  const toast = useToast();
  const [period, setPeriod] = useState(lastMonth());
  const ests = useQuery({ queryKey: ['establishments'], queryFn: () => api.get<{ id: string; code: string; current_regime: string }[]>('/v1/establishments') });
  const [establishmentId, setEstablishmentId] = useState('');
  useEffect(() => {
    if (!establishmentId && ests.data?.[0]) setEstablishmentId(ests.data[0].id);
  }, [ests.data, establishmentId]);
  const regime = ests.data?.find((e) => e.id === establishmentId)?.current_regime;
  const simples = regime === 'simples_nacional' || regime === 'mei';
  const [warnings, setWarnings] = useState<string[]>([]);
  const efdIcms = useMutation({
    mutationFn: () => api.get<SpedResult>('/v1/accounting/efd-icms-ipi', { establishmentId, ...range(period) }),
    onSuccess: (r) => { saveText(r.content, `EFD-ICMS-IPI-${period}.txt`); setWarnings(r.warnings); toast('EFD ICMS/IPI gerada'); },
  });
  const efdContrib = useMutation({
    mutationFn: () => api.get<SpedResult>('/v1/obligations/efd-contribuicoes', { period }),
    onSuccess: (r) => { saveText(r.content, `EFD-Contribuicoes-${period}.txt`); setWarnings(r.warnings); toast('EFD-Contribuições gerada'); },
  });
  const pack = useMutation({
    mutationFn: async () => {
      const r = await api.post<{ key: string; warnings: string[] }>('/v1/accounting/exports', range(period));
      setWarnings(r.warnings);
      await download('/v1/accounting/exports/download', { key: r.key }, `contador-${period}.tar.gz`);
    },
  });
  const reinf = useQuery({ queryKey: ['reinf', period], queryFn: () => api.get<Reinf>('/v1/obligations/reinf', { period }), enabled: false });
  const pgdas = useQuery({ queryKey: ['pgdas', period], queryFn: () => api.get<Pgdas>('/v1/obligations/pgdas', { period }), enabled: false, retry: false });
  return (
    <>
      <PageHeader title="Obrigações acessórias" subtitle="Arquivos para o contador e os programas oficiais" actions={<>
        <Field label="Competência"><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
        <Field label="Estabelecimento"><Select value={establishmentId} onChange={(e) => setEstablishmentId(e.target.value)}>{(ests.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.code}</option>)}</Select></Field>
      </>} />
      <ErrorBox error={efdIcms.error ?? efdContrib.error ?? pack.error ?? reinf.error ?? pgdas.error} />
      {warnings.length > 0 && <div className="alert warn" style={{ marginBottom: 12 }}><strong>Avisos:</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
      <div className="grid-2">
        <section className="card card-pad stack">
          <h2>Pacote do contador</h2>
          <p className="muted" style={{ margin: 0 }}>XMLs do mês, livros de entrada e saída, lançamentos contábeis e EFD ICMS/IPI.</p>
          <div className="row"><span className="spacer" /><button className="btn primary" disabled={pack.isPending} onClick={() => pack.mutate()}>Gerar e baixar</button></div>
        </section>
        <section className="card card-pad stack">
          <h2>EFD ICMS/IPI</h2>
          <p className="muted" style={{ margin: 0 }}>Blocos 0, C (documentos), E (apuração) e H (inventário). Contribuintes fora do Simples.</p>
          <div className="row"><span className="spacer" /><button className="btn" disabled={!establishmentId || efdIcms.isPending} onClick={() => efdIcms.mutate()}>Gerar arquivo</button></div>
        </section>
        {!simples && (
          <section className="card card-pad stack">
            <h2>EFD-Contribuições</h2>
            <p className="muted" style={{ margin: 0 }}>PIS e Cofins por documento: cumulativo (Presumido) ou não cumulativo (Real) com créditos.</p>
            {efdContrib.data?.totals && <div className="grid-2"><span>PIS a recolher <strong>{brl(efdContrib.data.totals.pisToPay)}</strong></span><span>Cofins a recolher <strong>{brl(efdContrib.data.totals.cofinsToPay)}</strong></span></div>}
            <div className="row"><span className="spacer" /><button className="btn" disabled={efdContrib.isPending} onClick={() => efdContrib.mutate()}>Gerar arquivo</button></div>
          </section>
        )}
        <section className="card card-pad stack">
          <h2>EFD-Reinf</h2>
          <p className="muted" style={{ margin: 0 }}>Retenções em serviços tomados e prestados (R-2010/R-2020) e pagamentos com IRRF/CSRF (R-4010/R-4020).</p>
          <div className="row"><span className="spacer" />
            <button className="btn" onClick={() => reinf.refetch()}>Ver eventos</button>
            <button className="btn" onClick={() => download('/v1/obligations/reinf/download', { period }, `reinf-${period}.tar.gz`)}>Baixar XMLs</button></div>
        </section>
        {simples && (
          <section className="card card-pad stack">
            <h2>Apoio ao PGDAS-D</h2>
            <p className="muted" style={{ margin: 0 }}>Receita segregada por anexo, ST, monofásico e exportação, com RBT12 e Fator R.</p>
            <div className="row"><span className="spacer" /><button className="btn" onClick={() => pgdas.refetch()}>Calcular</button></div>
          </section>
        )}
      </div>
      {reinf.data && (
        <section style={{ marginTop: 12 }}>
          <DataTable rows={reinf.data.events} rowKey={(r) => r.id} label="Eventos Reinf" height={300} columns={[
            { key: 'type', label: 'Evento', width: '100px' }, { key: 'id', label: 'Id', width: 'minmax(260px, 2fr)', render: (r) => <span className="mono">{r.id}</span> },
            { key: 'summary', label: 'Resumo', width: 'minmax(260px, 3fr)', render: (r) => Object.entries(r.summary).map(([k, v]) => `${k}: ${v}`).join(' · ') },
          ]} />
        </section>
      )}
      {pgdas.data && (
        <section className="stack" style={{ marginTop: 12 }}>
          <div className="grid-4">
            <Kpi label="Receita do mês" value={brl(pgdas.data.revenue)} />
            <Kpi label="RBT12" value={brl(pgdas.data.rbt12)} />
            <Kpi label="Fator R" value={pgdas.data.factorR ? pct(pgdas.data.factorR) : '—'} delta={`Folha 12 meses ${brl(pgdas.data.payroll12)}`} />
            <Kpi label="DAS estimado" value={brl(pgdas.data.estimatedDas)} delta="sem as reduções; o oficial sai no PGDAS-D" />
          </div>
          {pgdas.data.establishments.map((e) => (
            <DataTable key={e.code} rows={e.segments.map((s, i) => ({ ...s, key: String(i) }))} rowKey={(r) => r.key} label={`Segregação ${e.code}`} height={220} columns={[
              { key: 'annex', label: 'Anexo', width: '70px' }, { key: 'activity', label: 'Atividade', width: 'minmax(220px, 2fr)' },
              { key: 'flags', label: 'Tratamento', width: 'minmax(200px, 2fr)', render: (s) => [s.icmsSt && 'ICMS-ST', s.monophasic && 'monofásico', s.export && 'exportação', s.issRetained && 'ISS retido'].filter(Boolean).join(', ') || '—' },
              { key: 'revenue', label: 'Receita', type: 'money', width: '130px' }, { key: 'effectiveRate', label: 'Alíq. efetiva', type: 'percent', width: '110px' },
              { key: 'estimatedDas', label: 'DAS estimado', type: 'money', width: '130px' },
            ]} />
          ))}
          {pgdas.data.warnings.map((w, i) => <div key={i} className="alert warn">{w}</div>)}
        </section>
      )}
    </>
  );
}
