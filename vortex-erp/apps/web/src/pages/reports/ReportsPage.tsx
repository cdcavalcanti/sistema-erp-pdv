import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, downloadPost } from '../../api/client';
import { DataTable, type Column, type ColumnType } from '../../components/DataTable';
import { ErrorBox, Field, Input, PageHeader, Select, useToast } from '../../components/ui';
import { monthStart, today } from '../../lib/format';

interface JsonSchema { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; enum?: string[]; format?: string; pattern?: string; default?: unknown; anyOf?: JsonSchema[] }
interface ReportDef { code: string; area: string; title: string; description: string; heavy: boolean; params: JsonSchema }
interface Result { code: string; title: string; columns: { key: string; label: string; type?: string }[]; rows: Record<string, unknown>[]; generatedAt: string }

const AREAS: Record<string, string> = { vendas: 'Vendas', compras: 'Compras', estoque: 'Estoque', financeiro: 'Financeiro', fiscal: 'Fiscal', gestao: 'Gestão' };
const PARAM_LABEL: Record<string, string> = { from: 'De', to: 'Até', establishmentId: 'Estabelecimento', groupBy: 'Agrupar por', productId: 'Produto', days: 'Dias', date: 'Data',
  warehouseId: 'Depósito', kind: 'Tipo', accountId: 'Conta', basis: 'Regime', granularity: 'Agrupamento', supplierId: 'Fornecedor' };
const ENUM_LABEL: Record<string, string> = { day: 'Dia', month: 'Mês', week: 'Semana', salesperson: 'Vendedor', customer: 'Cliente', product: 'Produto', category: 'Categoria', channel: 'Canal',
  establishment: 'Filial', receivable: 'A receber', payable: 'A pagar', competence: 'Competência', cash: 'Caixa' };

const isDate = (s: JsonSchema) => s.pattern?.includes('\\d{4}-\\d{2}-\\d{2}') || s.format === 'date';
function defaultFor(key: string, s: JsonSchema): string {
  if (s.default !== undefined) return String(s.default);
  if (key === 'from') return monthStart();
  if (key === 'to' || key === 'date') return today();
  return '';
}

/** Catálogo de relatórios (seção 19): filtros gerados pelo esquema da API; exporta CSV, Excel e PDF; pesados vão para a fila. */
export default function ReportsPage() {
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const cat = useQuery({ queryKey: ['reports-catalog'], queryFn: () => api.get<ReportDef[]>('/v1/reports') });
  const ests = useQuery({ queryKey: ['establishments'], queryFn: () => api.get<{ id: string; code: string }[]>('/v1/establishments') });
  const code = sp.get('codigo') ?? '';
  const def = cat.data?.find((r) => r.code === code);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!def) return;
    setValues(Object.fromEntries(Object.entries(def.params.properties ?? {}).map(([k, s]) => [k, defaultFor(k, s)])));
  }, [def]);
  const params = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === '') continue;
      const s = def?.params.properties?.[k];
      out[k] = s?.type === 'number' || s?.type === 'integer' ? Number(v) : v;
    }
    return out;
  }, [values, def]);
  const run = useMutation({ mutationFn: () => api.post<Result>(`/v1/reports/${code}/run`, { params, format: 'json' }) });
  const queue = useMutation({ mutationFn: (format: string) => api.post(`/v1/reports/${code}/runs`, { params, format }), onSuccess: () => toast('Relatório em fila: você recebe um e-mail quando ficar pronto') });
  const exportAs = useMutation({ mutationFn: (format: 'csv' | 'xlsx' | 'pdf') => downloadPost(`/v1/reports/${code}/run`, { params, format }, `${code}.${format}`) });
  useEffect(() => run.reset(), [code]); // eslint-disable-line react-hooks/exhaustive-deps
  const columns: Column<Record<string, unknown>>[] = (run.data?.columns ?? []).map((c) => ({ key: c.key, label: c.label, type: (c.type as ColumnType) ?? 'text' }));
  const byArea = Object.entries(AREAS).map(([a, label]) => ({ a, label, items: (cat.data ?? []).filter((r) => r.area === a) })).filter((g) => g.items.length);
  return (
    <>
      <PageHeader title="Relatórios" subtitle="Respeitam suas permissões e o escopo de filiais (RN-REL-01)" />
      <ErrorBox error={cat.error} />
      <div className="row" style={{ marginBottom: 12 }}>
        <Select value={code} onChange={(e) => setSp(e.target.value ? { codigo: e.target.value } : {})} style={{ maxWidth: 420 }} aria-label="Relatório">
          <option value="">Escolha um relatório…</option>
          {byArea.map((g) => <optgroup key={g.a} label={g.label}>{g.items.map((r) => <option key={r.code} value={r.code}>{r.title}{r.heavy ? ' (em fila)' : ''}</option>)}</optgroup>)}
        </Select>
      </div>
      {def && (
        <section className="card card-pad stack" style={{ marginBottom: 12 }}>
          <p className="muted" style={{ margin: 0 }}>{def.description}</p>
          <div className="grid-4">
            {Object.entries(def.params.properties ?? {}).map(([k, s]) => {
              const enumVals = s.enum ?? s.anyOf?.find((x) => x.enum)?.enum;
              const label = `${PARAM_LABEL[k] ?? k}${def.params.required?.includes(k) ? '' : ' (opcional)'}`;
              if (k === 'establishmentId') {
                return <Field key={k} label={label}><Select value={values[k] ?? ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                  <option value="">Todos</option>{(ests.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.code}</option>)}</Select></Field>;
              }
              if (enumVals) {
                return <Field key={k} label={label}><Select value={values[k] ?? ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })}>
                  {!def.params.required?.includes(k) && <option value="">—</option>}{enumVals.map((v) => <option key={v} value={v}>{ENUM_LABEL[v] ?? v}</option>)}</Select></Field>;
              }
              return <Field key={k} label={label}><Input type={isDate(s) ? 'date' : s.type === 'number' || s.type === 'integer' ? 'number' : 'text'} value={values[k] ?? ''}
                onChange={(e) => setValues({ ...values, [k]: e.target.value })} /></Field>;
            })}
          </div>
          <div className="row">
            <span className="spacer" />
            {def.heavy ? (
              <>
                <button className="btn" disabled={queue.isPending} onClick={() => queue.mutate('pdf')}>Gerar PDF</button>
                <button className="btn primary" disabled={queue.isPending} onClick={() => queue.mutate('xlsx')}>Gerar Excel</button>
              </>
            ) : (
              <>
                <button className="btn" disabled={exportAs.isPending} onClick={() => exportAs.mutate('csv')}>CSV</button>
                <button className="btn" disabled={exportAs.isPending} onClick={() => exportAs.mutate('xlsx')}>Excel</button>
                <button className="btn" disabled={exportAs.isPending} onClick={() => exportAs.mutate('pdf')}>PDF</button>
                <button className="btn primary" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Gerando…' : 'Ver na tela'}</button>
              </>
            )}
          </div>
          <ErrorBox error={run.error ?? queue.error ?? exportAs.error} />
        </section>
      )}
      {run.data && <DataTable rows={run.data.rows.map((r, i) => ({ ...r, __row: i }))} rowKey={(r) => String(r.__row)} columns={columns} label={run.data.title} height="calc(100vh - 380px)" />}
    </>
  );
}
