import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useDebounced } from './ui';

interface Hit { type: string; id: string; title: string; subtitle: string | null }

const TYPE_LABEL: Record<string, string> = {
  product: 'Produto', party: 'Pessoa', sales_order: 'Pedido', purchase_order: 'Compra', title: 'Título', fiscal_document: 'Nota fiscal', page: 'Tela',
};
export function hitPath(h: Hit): string {
  switch (h.type) {
    case 'product': return `/produtos?abrir=${h.id}`;
    case 'party': return `/pessoas?abrir=${h.id}`;
    case 'sales_order': return `/vendas/pedidos/${h.id}`;
    case 'purchase_order': return `/compras/recebimentos`;
    case 'title': return `/financeiro/titulos?abrir=${h.id}`;
    case 'fiscal_document': return `/fiscal/notas?abrir=${h.id}`;
    default: return h.id;
  }
}

/**
 * Busca global (Ctrl+K ou /): telas do menu e registros da API (produtos, pessoas, pedidos,
 * títulos e notas), só o que o usuário pode ver. ↑/↓ e Enter navegam.
 */
export function CommandPalette({ pages, onClose }: { pages: { label: string; to: string }[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const dq = useDebounced(q.trim(), 200);
  const remote = useQuery({ queryKey: ['search', dq], queryFn: ({ signal }) => api.get<{ hits: Hit[] }>('/v1/search', { q: dq }, signal), enabled: dq.length >= 2 });
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const pageHits: Hit[] = pages.filter((p) => q && norm(p.label).includes(norm(q))).slice(0, 5).map((p) => ({ type: 'page', id: p.to, title: p.label, subtitle: null }));
  const hits = [...pageHits, ...(remote.data?.hits ?? [])];
  useEffect(() => setSel(0), [q, remote.data]);
  const go = (h: Hit | undefined) => {
    if (!h) return;
    nav(hitPath(h));
    onClose();
  };
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Busca global">
        <input className="input" autoFocus placeholder="Buscar produto, cliente, pedido, título, nota ou tela…" value={q} onChange={(e) => setQ(e.target.value)}
          aria-controls="palette-results" aria-activedescendant={hits[sel] ? `hit-${sel}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(hits.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); go(hits[sel]); }
            else if (e.key === 'Escape') onClose();
          }} />
        <ul id="palette-results" role="listbox">
          {hits.map((h, i) => (
            <li key={`${h.type}-${h.id}`} id={`hit-${i}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
              <span className="type">{TYPE_LABEL[h.type] ?? h.type}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.title}</div>
                {h.subtitle && <div className="muted" style={{ fontSize: 12 }}>{h.subtitle}</div>}
              </span>
            </li>
          ))}
          {q.trim().length >= 2 && !remote.isFetching && hits.length === 0 && <li className="muted">Nada encontrado para “{q}”.</li>}
          {q.trim().length < 2 && <li className="muted">Digite ao menos 2 letras. Números buscam pedidos, notas e títulos.</li>}
        </ul>
      </div>
    </div>
  );
}
