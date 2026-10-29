import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { D } from '@vortex/money';
import { brl, date, num, pct, qty } from '../lib/format';

export type ColumnType = 'text' | 'money' | 'number' | 'qty' | 'percent' | 'date';

export interface Column<T> {
  key: string;
  label: string;
  type?: ColumnType;
  /** Largura CSS de grid (ex.: "120px", "2fr"); padrão 1fr */
  width?: string;
  render?: (row: T) => ReactNode;
  /** Valor usado na ordenação quando a célula é renderizada */
  sortValue?: (row: T) => string | number | null;
  hideOnMobile?: boolean;
}

const ROW_H = 34;
const numeric = (t?: ColumnType) => t === 'money' || t === 'number' || t === 'qty' || t === 'percent';

function cell(type: ColumnType | undefined, v: unknown): ReactNode {
  if (v === null || v === undefined) return '';
  switch (type) {
    case 'money': return brl(v as string);
    case 'number': return num(v as string);
    case 'qty': return qty(v as string);
    case 'percent': return pct(v as string);
    case 'date': return date(v as string);
    default: return String(v);
  }
}

function compare(a: unknown, b: unknown, type?: ColumnType): number {
  if (a === null || a === undefined || a === '') return 1;
  if (b === null || b === undefined || b === '') return -1;
  if (numeric(type)) return D(String(a)).comparedTo(D(String(b)));
  return String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
}

/**
 * Tabela de dados virtualizada (seção 03: ERP é tela de alta densidade). Renderiza só as linhas
 * visíveis, ordena por coluna e navega pelo teclado: ↑/↓ movem, Enter abre, Home/End pulam.
 */
export function DataTable<T>({ rows, columns, rowKey, onOpen, height = 520, empty = 'Nada para mostrar', footer, label }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  height?: number | string;
  empty?: ReactNode;
  footer?: ReactNode;
  label?: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [active, setActive] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const cols = useMemo(() => columns.filter((c) => !(narrow && c.hideOnMobile)), [columns, narrow]);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = cols.find((c) => c.key === sort.key);
    if (!col) return rows;
    const val = (r: T) => (col.sortValue ? col.sortValue(r) : (r as Record<string, unknown>)[col.key]);
    return [...rows].sort((a, b) => compare(val(a), val(b), col.type) * sort.dir);
  }, [rows, sort, cols]);
  useEffect(() => setActive((a) => Math.min(a, Math.max(0, sorted.length - 1))), [sorted.length]);

  const v = useVirtualizer({ count: sorted.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 12 });
  const template = cols.map((c) => c.width ?? 'minmax(90px, 1fr)').join(' ');

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!sorted.length) return;
    let next = active;
    if (e.key === 'ArrowDown') next = Math.min(sorted.length - 1, active + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, active - 1);
    else if (e.key === 'PageDown') next = Math.min(sorted.length - 1, active + 15);
    else if (e.key === 'PageUp') next = Math.max(0, active - 15);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = sorted.length - 1;
    else if (e.key === 'Enter' && onOpen) {
      e.preventDefault();
      onOpen(sorted[active]!);
      return;
    } else return;
    e.preventDefault();
    setActive(next);
    v.scrollToIndex(next, { align: 'auto' });
  };

  return (
    <div className="dt card">
      <div ref={scrollRef} className="dt-scroll" style={{ height }} tabIndex={0} onKeyDown={onKey} role="grid" aria-label={label} aria-rowcount={sorted.length}>
        <div className="dt-head" style={{ gridTemplateColumns: template }} role="row">
          {cols.map((c) => (
            <button key={c.key} type="button" role="columnheader" className={numeric(c.type) ? 'num' : undefined}
              aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}>
              {c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
            </button>
          ))}
        </div>
        {sorted.length === 0 ? <div className="empty">{empty}</div> : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((vi) => {
              const r = sorted[vi.index]!;
              return (
                <div key={rowKey(r)} role="row" aria-rowindex={vi.index + 1} aria-selected={vi.index === active}
                  className={`dt-row${onOpen ? ' clickable' : ''}${vi.index === active ? ' active' : ''}`}
                  style={{ transform: `translateY(${vi.start}px)`, gridTemplateColumns: template }}
                  onClick={() => setActive(vi.index)} onDoubleClick={() => onOpen?.(r)}>
                  {cols.map((c) => (
                    <div key={c.key} role="gridcell" className={`dt-cell${numeric(c.type) ? ' num' : ''}`}>
                      {c.render ? c.render(r) : cell(c.type, (r as Record<string, unknown>)[c.key])}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="dt-foot">
        <span>{sorted.length} {sorted.length === 1 ? 'registro' : 'registros'}</span>
        {onOpen && sorted.length > 0 && <span className="hide-sm">· <kbd>↑</kbd> <kbd>↓</kbd> navegam, <kbd>Enter</kbd> abre</span>}
        <span className="spacer" />
        {footer}
      </div>
    </div>
  );
}
