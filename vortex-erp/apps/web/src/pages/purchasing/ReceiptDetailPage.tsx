import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, type Page } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBox, Input, PageHeader, Status, useToast } from '../../components/ui';
import { brl, date, qty } from '../../lib/format';

interface Item {
  id: string; xml_item_number: number; supplier_code: string; description: string; ean: string | null; supplier_unit?: string; supplier_quantity?: string; supplier_unit_price?: string;
  product_id: string | null; sku: string | null; product_description: string | null; stock_unit: string | null; factor?: string; stock_quantity?: string | null; match_source?: string | null;
  match_confidence?: string | null; counted_quantity: string | null; lot_number: string | null; lot_expires_at: string | null;
}
interface Receipt {
  id: string; number: string; series: string; issue_date: string; status: string; supplier_name: string; order_number: string | null; total_invoice?: string; blind?: boolean; items: Item[];
  approvals: { id: string; reason: string; status: string }[];
}
interface Check { status: string; divergences: { code: string; message: string; itemId?: string }[]; pendingApproval: string[]; blocking: string[]; readyToComplete: boolean }

const MATCH: Record<string, string> = { supplier_code: 'código do fornecedor', gtin: 'código de barras', suggestion: 'sugestão', manual: 'manual', order: 'pedido' };

/** Vínculo de produto para um item: confirma a sugestão ou busca outro produto do cadastro. */
function MapProduct({ item, onMap }: { item: Item; onMap: (productId: string, factor: string) => void }) {
  const [q, setQ] = useState('');
  const [factor, setFactor] = useState(item.factor ?? '1');
  const res = useQuery({ queryKey: ['map-search', q], queryFn: () => api.get<Page<{ id: string; sku: string; description: string }>>('/v1/products', { q, limit: 6 }), enabled: q.length >= 2 });
  return (
    <div className="stack" style={{ gap: 6 }}>
      {item.product_id && item.match_source === 'suggestion' && (
        <button className="btn sm" type="button" onClick={() => onMap(item.product_id!, factor)}>Confirmar {item.sku}</button>
      )}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <Input placeholder="Buscar produto" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Produto para o item ${item.xml_item_number}`} />
        <Input className="num" style={{ width: 70 }} value={factor} onChange={(e) => setFactor(e.target.value)} aria-label="Fator" title="Unidades de estoque por unidade do fornecedor" />
      </div>
      {(res.data?.items ?? []).map((p) => <button key={p.id} type="button" className="btn sm ghost" style={{ justifyContent: 'flex-start' }} onClick={() => onMap(p.id, factor)}>{p.sku} — {p.description}</button>)}
    </div>
  );
}

export default function ReceiptDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => api.get<Receipt>(`/v1/purchasing/receipts/${id}`) });
  const [counts, setCounts] = useState<Record<string, { quantity: string; lotNumber: string; expiresAt: string }>>({});
  const [check, setCheck] = useState<Check | null>(null);
  useEffect(() => {
    if (!q.data) return;
    setCounts(Object.fromEntries(q.data.items.map((i) => [i.id, { quantity: i.counted_quantity ?? '', lotNumber: i.lot_number ?? '', expiresAt: i.lot_expires_at?.slice(0, 10) ?? '' }])));
  }, [q.data]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['receipt', id] });
  const map = useMutation({ mutationFn: (v: { itemId: string; productId: string; factor: string }) => api.put(`/v1/purchasing/receipts/${id}/items/${v.itemId}/product`, { productId: v.productId, factor: v.factor }), onSuccess: refresh });
  const suggest = useMutation({ mutationFn: () => api.post<{ suggested: number }>(`/v1/ai/receipts/${id}/suggest-matches`), onSuccess: (r) => { toast(`${r.suggested} sugestão(ões) de vínculo`); refresh(); } });
  const count = useMutation({
    mutationFn: () => api.post(`/v1/purchasing/receipts/${id}/count`, { items: Object.entries(counts).filter(([, c]) => c.quantity !== '').map(([itemId, c]) => ({ itemId, quantity: c.quantity.replace(',', '.'), lotNumber: c.lotNumber || null, expiresAt: c.expiresAt || null })) }),
    onSuccess: () => { toast('Conferência salva'); refresh(); },
  });
  const runCheck = useMutation({ mutationFn: () => api.post<Check>(`/v1/purchasing/receipts/${id}/check`), onSuccess: (r) => { setCheck(r); refresh(); } });
  const complete = useMutation({ mutationFn: () => api.post(`/v1/purchasing/receipts/${id}/complete`), onSuccess: () => { toast('Recebimento concluído: estoque, custos e títulos lançados'); refresh(); qc.invalidateQueries({ queryKey: ['receipts'] }); } });
  const r = q.data;
  const open = r && !['completed', 'cancelled'].includes(r.status);
  return (
    <>
      <PageHeader title={r ? `NF-e ${r.number}/${r.series}` : 'Recebimento'} subtitle={r && <>{r.supplier_name} · emitida em {date(r.issue_date)} · {r.order_number ? `pedido ${r.order_number}` : 'sem pedido'} · <Status value={r.status} /></>}
        actions={<>
          <Link className="btn" to="/compras/recebimentos">Voltar</Link>
          {open && can('ia.assistente.usar') && <button className="btn" disabled={suggest.isPending} onClick={() => suggest.mutate()}>Sugerir vínculos (IA)</button>}
          {open && <button className="btn" disabled={count.isPending} onClick={() => count.mutate()}>Salvar conferência</button>}
          {open && <button className="btn" disabled={runCheck.isPending} onClick={() => runCheck.mutate()}>Conferir 3 vias</button>}
          {open && <button className="btn primary" disabled={complete.isPending} onClick={() => complete.mutate()}>Concluir</button>}
        </>} />
      <ErrorBox error={q.error ?? map.error ?? suggest.error ?? count.error ?? runCheck.error ?? complete.error} />
      {r?.blind && <div className="alert warn" style={{ marginBottom: 10 }}>Conferência cega: quantidades e valores da nota ficam ocultos até a conclusão.</div>}
      {check && (
        <div className={`alert ${check.readyToComplete ? 'ok' : 'warn'}`} style={{ marginBottom: 10 }}>
          {check.readyToComplete ? 'Pronto para concluir.' : 'Há divergências:'}
          {check.divergences.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{check.divergences.map((d, i) => <li key={i}>{d.message}</li>)}</ul>}
        </div>
      )}
      {r && (
        <section className="card" style={{ overflowX: 'auto' }}>
          <table className="lines">
            <thead><tr><th>#</th><th>Item da nota</th>{!r.blind && <th className="num">Qtd. nota</th>}<th>Produto interno</th><th className="num">Qtd. estoque</th><th className="num">Contado</th><th>Lote</th><th>Validade</th></tr></thead>
            <tbody>{r.items.map((i) => (
              <tr key={i.id}>
                <td>{i.xml_item_number}</td>
                <td className="desc"><div>{i.description}</div><div className="muted mono" style={{ fontSize: 11 }}>{i.supplier_code}{i.ean ? ` · ${i.ean}` : ''}</div></td>
                {!r.blind && <td className="num">{qty(i.supplier_quantity)} {i.supplier_unit}<div className="muted" style={{ fontSize: 11 }}>{brl(i.supplier_unit_price)}</div></td>}
                <td style={{ minWidth: 260 }}>
                  {i.product_id && <div><span className="mono">{i.sku}</span> {i.product_description} {i.match_source && <span className={`badge ${i.match_source === 'suggestion' ? 'warn' : 'ok'}`}>{MATCH[i.match_source] ?? i.match_source}{i.match_confidence ? ` ${Number(i.match_confidence).toFixed(0)}%` : ''}</span>}</div>}
                  {open && (!i.product_id || i.match_source === 'suggestion') && <MapProduct item={i} onMap={(productId, factor) => map.mutate({ itemId: i.id, productId, factor })} />}
                </td>
                <td className="num">{qty(i.stock_quantity)} {i.stock_unit}</td>
                <td className="num"><Input className="num" style={{ width: 90 }} inputMode="decimal" disabled={!open} aria-label={`Contado item ${i.xml_item_number}`} value={counts[i.id]?.quantity ?? ''}
                  onChange={(e) => setCounts((c) => ({ ...c, [i.id]: { ...c[i.id]!, quantity: e.target.value } }))} /></td>
                <td><Input style={{ width: 110 }} disabled={!open} value={counts[i.id]?.lotNumber ?? ''} aria-label="Lote" onChange={(e) => setCounts((c) => ({ ...c, [i.id]: { ...c[i.id]!, lotNumber: e.target.value } }))} /></td>
                <td><Input type="date" disabled={!open} value={counts[i.id]?.expiresAt ?? ''} aria-label="Validade" onChange={(e) => setCounts((c) => ({ ...c, [i.id]: { ...c[i.id]!, expiresAt: e.target.value } }))} /></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </>
  );
}
