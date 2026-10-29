import { useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Gráficos leves em SVG (sem biblioteca): uma escala só por gráfico, marcas finas, rótulos e
 * dica ao passar o mouse. As cores vêm de --series-1..6 (paleta validada para daltonismo nos dois
 * temas); texto sempre nas cores de texto, nunca na cor da série.
 */
export interface Series { key: string; label: string; color?: string }

const seriesColor = (i: number, s?: Series) => s?.color ?? `var(--series-${(i % 6) + 1})`;

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const compact = (v: number) => new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

/** Linhas (ou área empilhada) no tempo, com cruz e dica no ponto mais próximo do mouse. */
export function TimeChart<T extends Record<string, any>>({ data, x, series, stacked = false, height = 220, format, xFormat, label }: {
  data: T[]; x: keyof T; series: Series[]; stacked?: boolean; height?: number; format: (v: number) => string; xFormat: (v: string) => string; label: string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const pad = { l: 52, r: 12, t: 12, b: 26 };
  const vals = data.map((d) => series.map((s) => Number(d[s.key]) || 0));
  const max = niceMax(Math.max(0, ...vals.map((v) => (stacked ? v.reduce((a, b) => a + b, 0) : Math.max(0, ...v)))));
  const sx = (i: number) => pad.l + (data.length <= 1 ? 0 : (i / (data.length - 1)) * (W - pad.l - pad.r));
  const sy = (v: number) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const paths = useMemo(() => {
    const base = data.map(() => 0);
    return series.map((_s, si) => {
      const top = data.map((_, i) => (stacked ? base[i]! + vals[i]![si]! : vals[i]![si]!));
      const line = top.map((v, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join('');
      const area = stacked ? `${line}${[...base].reverse().map((v, j) => `L${sx(data.length - 1 - j).toFixed(1)},${sy(v).toFixed(1)}`).join('')}Z` : null;
      if (stacked) top.forEach((v, i) => { base[i] = v; });
      return { line, area };
    });
  }, [data, series, stacked, max]);
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };
  const every = Math.max(1, Math.ceil(data.length / 8));
  return (
    <div className="chart">
      {series.length > 1 && <Legend series={series} />}
      <div className="chart-plot">
        <svg ref={ref} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} className="grid" /><text x={pad.l - 8} y={sy(t) + 4} className="axis" textAnchor="end">{compact(t)}</text></g>)}
          {data.map((d, i) => ((i % every === 0 && data.length - 1 - i >= every / 2) || i === data.length - 1) && <text key={i} x={sx(i)} y={height - 6} className="axis" textAnchor="middle">{xFormat(String(d[x]))}</text>)}
          {paths.map((p, i) => (
            <g key={series[i]!.key}>
              {p.area && <path d={p.area} fill={seriesColor(i, series[i])} opacity={0.18} />}
              <path d={p.line} fill="none" stroke={seriesColor(i, series[i])} strokeWidth={2} strokeLinejoin="round" />
            </g>
          ))}
          {hover !== null && <line x1={sx(hover)} x2={sx(hover)} y1={pad.t} y2={height - pad.b} className="crosshair" />}
          {hover !== null && series.map((s, si) => {
            const v = stacked ? vals[hover]!.slice(0, si + 1).reduce((a, b) => a + b, 0) : vals[hover]![si]!;
            return <circle key={s.key} cx={sx(hover)} cy={sy(v)} r={4} fill={seriesColor(si, s)} stroke="var(--surface)" strokeWidth={2} />;
          })}
        </svg>
        {hover !== null && (
          <div className="tooltip" style={{ left: `${(sx(hover) / W) * 100}%` }}>
            <b>{xFormat(String(data[hover]![x]))}</b>
            {series.map((s, si) => <div key={s.key}><i style={{ background: seriesColor(si, s) }} />{s.label}<span>{format(vals[hover]![si]!)}</span></div>)}
            {series.length > 1 && <div className="total">Total<span>{format(vals[hover]!.reduce((a, b) => a + b, 0))}</span></div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Barras horizontais com o valor escrito ao lado (identidade pelo rótulo, não pela cor). */
export function BarList<T extends Record<string, any>>({ data, label, value, format, color, sub, empty = 'Sem dados no período' }: {
  data: T[]; label: (d: T) => ReactNode; value: (d: T) => number; format: (v: number) => string; color?: (d: T, i: number) => string; sub?: (d: T) => ReactNode; empty?: string;
}) {
  const max = Math.max(0, ...data.map(value));
  if (!data.length || max === 0) return <p className="muted chart-empty">{empty}</p>;
  return (
    <ul className="barlist">
      {data.map((d, i) => (
        <li key={i} title={format(value(d))}>
          <div className="barlist-label"><span>{label(d)}</span><b>{format(value(d))}</b></div>
          <div className="barlist-track"><span style={{ width: `${Math.max(1.5, (value(d) / max) * 100)}%`, background: color?.(d, i) ?? 'var(--series-1)' }} /></div>
          {sub && <small className="muted">{sub(d)}</small>}
        </li>
      ))}
    </ul>
  );
}

/** Colunas verticais por categoria (ex.: vencimentos por faixa), com valor acima de cada coluna. */
export function Columns<T extends Record<string, any>>({ data, label, value, format, color, height = 180, ariaLabel }: {
  data: T[]; label: (d: T) => string; value: (d: T) => number; format: (v: number) => string; color: (d: T, i: number) => string; height?: number; ariaLabel: string;
}) {
  const max = niceMax(Math.max(0, ...data.map(value)));
  return (
    <div className="columns" role="img" aria-label={ariaLabel} style={{ height }}>
      {data.map((d, i) => {
        const v = value(d);
        return (
          <div key={i} className="column" title={`${label(d)}: ${format(v)}`}>
            <small className="column-value">{v > 0 ? compact(v) : '—'}</small>
            <div className="column-bar" style={{ height: `${(v / max) * 100}%`, background: color(d, i) }} />
            <small className="column-label">{label(d)}</small>
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return <div className="legend">{series.map((s, i) => <span key={s.key}><i style={{ background: seriesColor(i, s) }} />{s.label}</span>)}</div>;
}

/** Barra de proporção (participação de cada parte no todo), com legenda e percentuais. */
export function ShareBar<T extends Record<string, any>>({ data, label, value, format }: { data: T[]; label: (d: T) => string; value: (d: T) => number; format: (v: number) => string }) {
  // Seis cores fixas: do sétimo em diante vira "Outros" (nunca uma cor repetida ou gerada)
  const rows: { name: string; v: number }[] = data.map((d) => ({ name: label(d), v: value(d) }));
  if (rows.length > 6) rows.splice(5, rows.length, { name: 'Outros', v: rows.slice(5).reduce((a, r) => a + r.v, 0) });
  const total = rows.reduce((a, d) => a + d.v, 0);
  if (!total) return <p className="muted chart-empty">Sem vendas no período</p>;
  return (
    <div className="share">
      <div className="share-bar">{rows.map((d, i) => <span key={i} style={{ width: `${(d.v / total) * 100}%`, background: seriesColor(i) }} title={`${d.name}: ${format(d.v)}`} />)}</div>
      <ul>{rows.map((d, i) => (
        <li key={i}><i style={{ background: seriesColor(i) }} /><span>{d.name}</span><b>{format(d.v)}</b><small>{((d.v / total) * 100).toFixed(0)}%</small></li>
      ))}</ul>
    </div>
  );
}
