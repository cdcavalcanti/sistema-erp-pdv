import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { DataTable } from '../../components/DataTable';
import { ErrorBox, Field, Input, Kpi, PageHeader, Select } from '../../components/ui';
import { Columns } from '../../components/charts';
import { brl, num, pct } from '../../lib/format';

interface Assessment {
  period: { from: string; to: string }; regime: string | null;
  simples: { revenue: string; estimatedDas: string; rbt12: string; establishments: { segments: { activity: string; revenue: string; effectiveRate: string; estimatedDas: string }[] }[]; warnings: string[] } | null;
  summary: { tax: string; label: string; debit: string; credit: string; conditional: string; toPay: string; creditCarried: string }[];
  special: { tax: string; label: string; value: string }[];
  byCfop: { cfop: string; docs: number; amount: string; icms_base: string; icms: string; icms_st: string }[];
  byUf: { uf: string; docs: number; amount: string; icms: string; difal: string }[];
  monthly: { month: string; icms_debit: string; icms_credit: string; pis_cofins_debit: string }[];
  totals: { debit: string; credit: string; toPay: string };
}
const REGIME: Record<string, string> = { simples_nacional: 'Simples Nacional', simples_excesso_sublimite: 'Simples (excesso de sublimite)', mei: 'MEI', lucro_presumido: 'Lucro Presumido', lucro_real: 'Lucro Real' };
const CFOP: Record<string, string> = { '5102': 'Venda dentro do estado', '6102': 'Venda para outro estado', '5405': 'Venda com ST (substituído)', '6108': 'Venda a não contribuinte de outra UF',
  '5101': 'Venda de produção própria', '6101': 'Venda de produção própria p/ outra UF', '5202': 'Devolução de compra', '5949': 'Outra saída', '5929': 'Venda já com cupom' };
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthRange = (offset: number) => {
  const n = new Date();
  return { from: iso(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset, 1))), to: iso(new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset + 1, 0))) };
};

/** Controle fiscal: apuração do período (ICMS e demais) e simulador de cálculo por produto e destino. */
export default function TaxesPage() {
  const [tab, setTab] = useState<'assessment' | 'simulator'>('assessment');
  return (
    <>
      <PageHeader title="Impostos" subtitle="Apuração gerencial do período e simulador de cálculo (ICMS, ST, DIFAL, IPI, PIS/Cofins, IBS/CBS)" />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'assessment'} onClick={() => setTab('assessment')}>Apuração do período</button>
        <button role="tab" aria-selected={tab === 'simulator'} onClick={() => setTab('simulator')}>Simulador de cálculo</button>
      </div>
      {tab === 'assessment' ? <AssessmentTab /> : <SimulatorTab />}
    </>
  );
}

function AssessmentTab() {
  const [range, setRange] = useState(monthRange(0));
  const q = useQuery({ queryKey: ['assessment', range], queryFn: () => api.get<Assessment>('/v1/fiscal/assessment', range) });
  const a = q.data;
  return (
    <>
      <div className="toolbar">
        <div className="chips" role="group" aria-label="Competência">
          <button type="button" className="chip" aria-pressed={range.from === monthRange(0).from} onClick={() => setRange(monthRange(0))}>Mês atual</button>
          <button type="button" className="chip" aria-pressed={range.from === monthRange(-1).from} onClick={() => setRange(monthRange(-1))}>Mês passado</button>
        </div>
        <label className="row">De <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label className="row">até <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        {a?.regime && <span className="badge info">{REGIME[a.regime] ?? a.regime}</span>}
      </div>
      <ErrorBox error={q.error} />
      {a && (
        <div className="stack">
          {a.simples && (
            <div className="alert">
              <b>Empresa do {REGIME[a.regime!]}:</b> o ICMS, o PIS, a Cofins e os demais tributos do regime são pagos juntos no DAS. Estimativa do DAS da competência{' '}
              {a.period.to.slice(5, 7)}/{a.period.to.slice(0, 4)}: <b>{brl(a.simples.estimatedDas)}</b> sobre receita de {brl(a.simples.revenue)} (RBT12 {brl(a.simples.rbt12)}).
              {a.simples.warnings.map((w) => <div key={w} className="muted" style={{ fontSize: 12, marginTop: 4 }}>{w}</div>)}
            </div>
          )}
          <div className="stat-row">
            <Kpi label="Débitos (saídas)" value={brl(a.totals.debit)} delta="impostos destacados nas notas emitidas" />
            <Kpi label="Créditos (entradas)" value={brl(a.totals.credit)} delta="livro de créditos das compras" />
            <Kpi label="A recolher" value={brl(a.totals.toPay)} delta="inclui ST, DIFAL e FCP" tone={Number(a.totals.toPay) > 0 ? 'down' : undefined} />
          </div>
          <section className="card">
            <div className="card-head"><h2>Débito × crédito por tributo</h2></div>
            {a.summary.length === 0 ? <p className="card-pad muted">Sem tributos destacados no período{a.simples ? ' (no Simples, o recolhimento é pelo DAS).' : '.'}</p> : (
              <table className="lines">
                <thead><tr><th>Tributo</th><th className="num">Débito</th><th className="num">Crédito</th><th className="num">Crédito condicionado</th><th className="num">A recolher</th><th className="num">Saldo credor</th></tr></thead>
                <tbody>{a.summary.map((r) => (
                  <tr key={r.tax}><td><b>{r.label}</b></td><td className="num">{brl(r.debit)}</td><td className="num">{brl(r.credit)}</td><td className="num">{brl(r.conditional)}</td>
                    <td className="num"><b>{brl(r.toPay)}</b></td><td className="num">{Number(r.creditCarried) ? brl(r.creditCarried) : '—'}</td></tr>
                ))}</tbody>
              </table>
            )}
            {a.special.length > 0 && (
              <div className="card-pad"><h3 style={{ marginBottom: 8 }}>Recolhidos em guia própria</h3>
                <div className="chips">{a.special.map((s) => <span key={s.tax} className="chip">{s.label}: <b>{brl(s.value)}</b></span>)}</div></div>
            )}
          </section>
          <div className="dash-grid">
            <section className="card panel span-6">
              <div className="panel-head"><h2>ICMS débito × crédito (6 meses)</h2></div>
              {a.monthly.every((m) => Number(m.icms_debit) === 0 && Number(m.icms_credit) === 0)
                ? <p className="muted">Sem ICMS destacado nos últimos 6 meses{a.simples ? ' (empresa do Simples: o ICMS vai no DAS)' : ''}.</p> : <>
              <Columns data={a.monthly.flatMap((m) => [{ k: `${MONTHS[Number(m.month.slice(5)) - 1]} déb.`, v: Number(m.icms_debit), t: 'd' }, { k: `${MONTHS[Number(m.month.slice(5)) - 1]} créd.`, v: Number(m.icms_credit), t: 'c' }])}
                label={(x) => x.k} value={(x) => x.v} format={(v) => brl(v.toFixed(2))} color={(x) => (x.t === 'd' ? 'var(--series-3)' : 'var(--series-2)')} ariaLabel="ICMS débito e crédito por mês" />
              <div className="legend"><span><i style={{ background: 'var(--series-3)' }} />Débito (saídas)</span><span><i style={{ background: 'var(--series-2)' }} />Crédito (entradas)</span></div></>}
            </section>
            <section className="card panel span-6">
              <div className="panel-head"><h2>Por UF de destino</h2></div>
              {a.byUf.length === 0 ? <p className="muted">Sem saídas no período.</p> : (
                <table className="lines">
                  <thead><tr><th>UF</th><th className="num">Notas</th><th className="num">Valor</th><th className="num">ICMS</th><th className="num">DIFAL/FCP</th></tr></thead>
                  <tbody>{a.byUf.map((u) => <tr key={u.uf}><td><b>{u.uf}</b></td><td className="num">{u.docs}</td><td className="num">{brl(u.amount)}</td><td className="num">{brl(u.icms)}</td><td className="num">{brl(u.difal)}</td></tr>)}</tbody>
                </table>
              )}
            </section>
          </div>
          <section className="card">
            <div className="card-head"><h2>Saídas por CFOP</h2></div>
            <DataTable rows={a.byCfop} rowKey={(r) => r.cfop} label="Saídas por CFOP" height={Math.min(420, 60 + a.byCfop.length * 38)} columns={[
              { key: 'cfop', label: 'CFOP', width: '80px', render: (r) => <b className="mono">{r.cfop}</b> },
              { key: 'desc', label: 'Operação', width: 'minmax(200px, 2fr)', render: (r) => CFOP[r.cfop] ?? '' },
              { key: 'docs', label: 'Notas', type: 'number', width: '80px' },
              { key: 'amount', label: 'Valor', type: 'money', width: '130px' },
              { key: 'icms_base', label: 'Base ICMS', type: 'money', width: '130px', hideOnMobile: true },
              { key: 'icms', label: 'ICMS', type: 'money', width: '120px' },
              { key: 'icms_st', label: 'ICMS-ST', type: 'money', width: '120px', hideOnMobile: true },
            ]} />
          </section>
          <p className="muted" style={{ fontSize: 12 }}>Apuração gerencial para acompanhamento. A apuração oficial é a da EFD ICMS/IPI e EFD-Contribuições (em Obrigações), conferida pelo contador.</p>
        </div>
      )}
    </>
  );
}

interface SimResult {
  regime: string; issuerUf: string; interstate: boolean; warnings: string[];
  totals: Record<string, any>;
  items: { cfop: string; values: Record<string, string>; taxes: Record<string, any>; memory: string[] | Record<string, unknown>[]; warnings: string[] }[];
}

function SimulatorTab() {
  const ests = useQuery({ queryKey: ['establishments'], queryFn: () => api.get<{ id: string; code: string; trade_name: string | null; uf?: string }[]>('/v1/establishments') });
  const products = useQuery({ queryKey: ['products-sim'], queryFn: () => api.get<{ items: { id: string; sku: string; description: string; ncm: string }[] }>('/v1/products', { limit: 500 }) });
  const [f, setF] = useState({ establishmentId: '', productId: '', quantity: '1', unitPrice: '100,00', uf: 'SP', ieIndicator: '9', finalConsumer: true, operation: 'VENDA' });
  const sim = useMutation({
    mutationFn: () => api.post<SimResult>('/v1/fiscal/simulate', {
      establishmentId: f.establishmentId || ests.data?.[0]?.id, operationTypeCode: f.operation,
      recipient: { uf: f.uf, ieIndicator: Number(f.ieIndicator), finalConsumer: f.finalConsumer },
      items: [{ productId: f.productId || products.data?.items[0]?.id, quantity: f.quantity.replace(',', '.'), unitPrice: f.unitPrice.replace(/\./g, '').replace(',', '.') }],
    }),
  });
  const r = sim.data;
  const it = r?.items[0];
  const row = (label: string, t: any, extra?: string) => t && (Number(t.value) > 0 || Number(t.base) > 0 || t.cst || t.csosn) ? (
    <tr key={label}><td><b>{label}</b>{extra ? <span className="muted"> · {extra}</span> : null}</td><td>{t.cst ?? t.csosn ?? '—'}</td><td className="num">{brl(t.base ?? '0')}</td>
      <td className="num">{t.rate ? pct(Number(t.rate).toFixed(2)) : '—'}</td><td className="num"><b>{brl(t.value ?? '0')}</b></td></tr>
  ) : null;
  return (
    <div className="dash-grid">
      <section className="card panel span-4">
        <div className="panel-head"><h2>Operação</h2></div>
        <Field label="Estabelecimento (emitente)">
          <Select value={f.establishmentId} onChange={(e) => setF({ ...f, establishmentId: e.target.value })}>{(ests.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.code} · {e.trade_name ?? ''}</option>)}</Select>
        </Field>
        <Field label="Produto">
          <Select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>{(products.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.description} (NCM {p.ncm})</option>)}</Select>
        </Field>
        <div className="grid-2">
          <Field label="Quantidade"><Input inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
          <Field label="Preço unitário (R$)"><Input inputMode="decimal" value={f.unitPrice} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} /></Field>
        </div>
        <div className="grid-2">
          <Field label="UF do destinatário">
            <Select value={f.uf} onChange={(e) => setF({ ...f, uf: e.target.value })}>{'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'.split(' ').map((u) => <option key={u}>{u}</option>)}</Select>
          </Field>
          <Field label="Destinatário">
            <Select value={`${f.ieIndicator}|${f.finalConsumer}`} onChange={(e) => { const [ie, fc] = e.target.value.split('|'); setF({ ...f, ieIndicator: ie!, finalConsumer: fc === 'true' }); }}>
              <option value="9|true">Consumidor final (sem IE)</option><option value="1|false">Contribuinte (revenda)</option><option value="1|true">Contribuinte, uso e consumo</option>
            </Select>
          </Field>
        </div>
        <button className="btn primary" disabled={sim.isPending} onClick={() => sim.mutate()}>{sim.isPending ? 'Calculando…' : 'Calcular impostos'}</button>
        <ErrorBox error={sim.error} />
      </section>
      <section className="card panel span-8">
        <div className="panel-head"><h2>Resultado</h2>{r && <span className="muted">{REGIME[r.regime] ?? r.regime} · {r.issuerUf} → {f.uf} · CFOP {it?.cfop}{r.interstate ? ' · interestadual' : ''}</span>}</div>
        {!r && <p className="muted">Escolha o produto, o destino e o tipo de destinatário e clique em Calcular. O cálculo usa o mesmo motor e as mesmas regras fiscais das notas.</p>}
        {r && it && (
          <>
            <table className="lines">
              <thead><tr><th>Tributo</th><th>CST/CSOSN</th><th className="num">Base</th><th className="num">Alíquota</th><th className="num">Valor</th></tr></thead>
              <tbody>
                {row('ICMS', it.taxes.icms)}{row('FCP', it.taxes.fcp)}{row('ICMS-ST', it.taxes.st)}{row('DIFAL', it.taxes.difal && { ...it.taxes.difal, rate: it.taxes.difal.destRate }, 'UF de destino')}
                {row('IPI', it.taxes.ipi)}{row('PIS', it.taxes.pis)}{row('Cofins', it.taxes.cofins)}{row('ISS', it.taxes.iss)}
                {it.taxes.ibsCbs && row('IBS (UF)', { cst: it.taxes.ibsCbs.cst, base: it.taxes.ibsCbs.base, ...it.taxes.ibsCbs.ibsUf }, it.taxes.ibsCbs.informative ? 'reforma, informativo em 2026' : 'reforma')}
                {it.taxes.ibsCbs && row('IBS (município)', { cst: it.taxes.ibsCbs.cst, base: it.taxes.ibsCbs.base, ...it.taxes.ibsCbs.ibsMun }, 'reforma')}
                {it.taxes.ibsCbs && row('CBS', { cst: it.taxes.ibsCbs.cst, base: it.taxes.ibsCbs.base, ...it.taxes.ibsCbs.cbs }, it.taxes.ibsCbs.informative ? 'reforma, informativo em 2026' : 'reforma')}
              </tbody>
            </table>
            <div className="stat-row">
              <Kpi label="Valor dos produtos" value={brl(r.totals.product)} />
              <Kpi label="Total da nota" value={brl(r.totals.invoice ?? r.totals.product)} />
              <Kpi label="Tributos no preço" value={brl(['icms', 'fcp', 'pis', 'cofins', 'iss', 'difal', 'fcpDest'].reduce((s, k) => s + Number(r.totals[k] ?? 0), 0).toFixed(2))}
                delta={`${num(((['icms', 'fcp', 'pis', 'cofins', 'iss', 'difal', 'fcpDest'].reduce((s, k) => s + Number(r.totals[k] ?? 0), 0) / (Number(r.totals.product) || 1)) * 100).toFixed(2))}% da venda`} />
            </div>
            {[...r.warnings, ...it.warnings].map((w) => <div key={w} className="alert warn">{w}</div>)}
            {Array.isArray(it.memory) && it.memory.length > 0 && (
              <details><summary>Memória de cálculo</summary>
                <ul className="plain-list" style={{ marginTop: 8 }}>{it.memory.map((m, i) => <li key={i}><span style={{ whiteSpace: 'normal' }}>{typeof m === 'string' ? m : JSON.stringify(m)}</span></li>)}</ul>
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}
