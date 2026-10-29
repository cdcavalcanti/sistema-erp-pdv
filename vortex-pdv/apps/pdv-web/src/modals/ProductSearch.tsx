import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { brl, qty } from '../lib/format';
import { Field, Modal } from '../ui';

interface ProductView { id: string; sku: string; description: string; gtin: string | null; reference: string | null; unit: string; price: string; basePrice: string;
  promotions: { name: string }[]; available: string | null; stockStatus: 'available' | 'low' | 'out' | 'blocked' }

const STOCK: Record<ProductView['stockStatus'], string> = { available: 'Disponível', low: 'Estoque baixo', out: 'Sem estoque', blocked: 'Bloqueado' };

/** Consulta de produto (F5): nome, descrição, SKU, referência; preço e situação de estoque. */
export function ProductSearchModal({ initial, onClose, onPick }: { initial: string; onClose: () => void; onPick: (id: string) => void }) {
  const [q, setQ] = useState(initial);
  const [list, setList] = useState<ProductView[]>([]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (q.trim().length < 2) return setList([]);
    const id = setTimeout(() => api<ProductView[]>('GET', `/api/products?q=${encodeURIComponent(q.trim())}`).then((l) => { setList(l); setIdx(0); }).catch(() => setList([])), 200);
    return () => clearTimeout(id);
  }, [q]);
  return (
    <Modal title="Consultar produto" wide onClose={onClose}>
      <Field label="Nome, descrição, SKU ou referência">
        <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(list.length - 1, i + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
          if (e.key === 'Enter') { e.preventDefault(); const p = list[idx]; if (p && p.stockStatus !== 'blocked') onPick(p.id); }
        }} />
      </Field>
      <ul className="pick products">
        {list.map((p, i) => (
          <li key={p.id}>
            <button type="button" className={`row-btn ${i === idx ? 'active' : ''}`} disabled={p.stockStatus === 'blocked'} onClick={() => onPick(p.id)}>
              <span><b>{p.description}</b><small>{p.sku}{p.reference ? ` · ref ${p.reference}` : ''}{p.gtin ? ` · ${p.gtin}` : ''}</small></span>
              <span className={`tag ${p.stockStatus}`}>{STOCK[p.stockStatus]}{p.available !== null ? ` (${qty(p.available)})` : ''}</span>
              <span className="price">R$ {brl(p.price)}{p.promotions.length > 0 && <small className="promo">{p.promotions[0]!.name}</small>}<small>/{p.unit}</small></span>
            </button>
          </li>
        ))}
        {q.trim().length >= 2 && !list.length && <li className="muted">Nenhum produto encontrado</li>}
      </ul>
    </Modal>
  );
}
