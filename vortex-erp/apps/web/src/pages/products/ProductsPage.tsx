import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { PRODUCT_KINDS, productSchema } from '@vortex/contracts';
import { isValidGTIN } from '@vortex/validators';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable } from '../../components/DataTable';
import { Dialog, ErrorBox, Field, Input, PageHeader, Select, Status, useDebounced, useToast } from '../../components/ui';
import { brl, qty } from '../../lib/format';
import { usePaged } from '../../lib/hooks';

interface ProductRow { id: string; sku: string; description: string; gtin: string | null; kind: string; ncm: string | null; stock_unit: string; status: string; last_purchase_cost: string | null }
const KIND_LABEL: Record<string, string> = { goods: 'Mercadoria', raw_material: 'Matéria-prima', finished: 'Produto acabado', service: 'Serviço', kit: 'Kit', fixed_asset: 'Imobilizado',
  consumable: 'Uso e consumo', packaging: 'Embalagem' };

export default function ProductsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const list = usePaged<ProductRow>(['products'], '/v1/products', { q: dq || undefined });
  const [creating, setCreating] = useState(false);
  const openId = params.get('abrir');
  return (
    <>
      <PageHeader title="Produtos" subtitle="SKU, unidades, classificação fiscal e custos"
        actions={can('produtos.produto.criar') && <button className="btn primary" onClick={() => setCreating(true)}>Novo produto</button>} />
      <div className="row" style={{ marginBottom: 10 }}>
        <Input placeholder="SKU, descrição ou GTIN" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} aria-label="Buscar produtos" />
      </div>
      <ErrorBox error={list.error} />
      <DataTable rows={list.rows} rowKey={(r) => r.id} label="Produtos" height="calc(100vh - 230px)" onOpen={(r) => setParams({ abrir: r.id })}
        footer={list.hasNextPage && <button className="btn sm" onClick={() => list.fetchNextPage()}>Carregar mais</button>}
        columns={[
          { key: 'sku', label: 'SKU', width: '140px', render: (r) => <span className="mono">{r.sku}</span> },
          { key: 'description', label: 'Descrição', width: 'minmax(220px, 3fr)' },
          { key: 'kind', label: 'Tipo', width: '130px', render: (r) => KIND_LABEL[r.kind] ?? r.kind, hideOnMobile: true },
          { key: 'ncm', label: 'NCM', width: '100px', render: (r) => <span className="mono">{r.ncm}</span>, hideOnMobile: true },
          { key: 'gtin', label: 'GTIN', width: '140px', render: (r) => <span className="mono">{r.gtin}</span>, hideOnMobile: true },
          { key: 'stock_unit', label: 'Un.', width: '60px' },
          { key: 'last_purchase_cost', label: 'Últ. custo', type: 'money', width: '120px', hideOnMobile: true },
          { key: 'status', label: 'Situação', width: '100px', render: (r) => <Status value={r.status} /> },
        ]} />
      {creating && <ProductForm onClose={() => setCreating(false)} />}
      {openId && <ProductDetail id={openId} onClose={() => setParams({})} />}
    </>
  );
}

type FormIn = z.input<typeof productSchema>;
type FormOut = z.output<typeof productSchema>;

function ProductForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const { register, handleSubmit, watch, setValue, setError, formState: { errors, isSubmitting } } = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(productSchema), defaultValues: { kind: 'goods', stockUnit: 'UN', saleUnit: 'UN', origin: 0 },
  });
  const [serverError, setServerError] = useState<unknown>(null);
  const gtin = watch('gtin');
  const description = watch('description');
  // Classificação fiscal assistida (seção 20): a IA sugere; o contador confirma o rascunho depois
  const classify = useMutation({
    mutationFn: () => api.post<{ id: string; confidence: string | null; source: string; payload: { suggestion: { ncm: string; ncmDescription: string | null; cest: string | null; cclasstrib: string | null }; rationale: string } }>('/v1/ai/classify-product', { description }),
    onSuccess: (d) => {
      setValue('ncm', d.payload.suggestion.ncm);
      if (d.payload.suggestion.cest) setValue('cest', d.payload.suggestion.cest);
      if (d.payload.suggestion.cclasstrib) setValue('cclasstrib', d.payload.suggestion.cclasstrib);
    },
  });
  const submit = handleSubmit(async (v) => {
    setServerError(null);
    try {
      await api.post('/v1/products', v);
      toast('Produto cadastrado');
      qc.invalidateQueries({ queryKey: ['products'] });
      onClose();
    } catch (e) {
      if (e instanceof ApiError) for (const [k, msg] of Object.entries(e.fieldErrors)) setError(k as never, { message: msg });
      setServerError(e);
    }
  });
  return (
    <Dialog title="Novo produto" onClose={onClose} wide footer={<>
      <button className="btn" type="button" onClick={onClose}>Cancelar</button>
      <button className="btn primary" type="submit" form="product-form" disabled={isSubmitting}>Salvar</button>
    </>}>
      <form id="product-form" className="stack" onSubmit={submit} noValidate>
        <div className="grid-4">
          <Field label="SKU" error={errors.sku?.message}><Input {...register('sku')} invalid={!!errors.sku} /></Field>
          <Field label="Tipo"><Select {...register('kind')}>{PRODUCT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select></Field>
          <Field label="GTIN (código de barras)" error={errors.gtin?.message} hint={gtin && !/^SEM GTIN$/i.test(gtin) && !isValidGTIN(gtin) ? 'Dígito verificador não confere' : undefined}>
            <Input inputMode="numeric" {...register('gtin', { setValueAs: (v) => v || null })} />
          </Field>
          <Field label="Origem (ICMS)">
            <Select {...register('origin', { setValueAs: (v) => Number(v) })}>
              <option value={0}>0 — Nacional</option><option value={1}>1 — Estrangeira (importação direta)</option><option value={2}>2 — Estrangeira (mercado interno)</option>
              <option value={3}>3 — Nacional, importação &gt; 40%</option><option value={5}>5 — Nacional, importação ≤ 40%</option>
            </Select>
          </Field>
        </div>
        <Field label="Descrição (até 120 caracteres; vai na nota)" error={errors.description?.message}><Input maxLength={120} {...register('description')} invalid={!!errors.description} /></Field>
        <div className="grid-4">
          <Field label="NCM" error={errors.ncm?.message}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <Input inputMode="numeric" maxLength={8} {...register('ncm')} invalid={!!errors.ncm} />
              {can('ia.assistente.usar') && <button type="button" className="btn" disabled={!description || classify.isPending} onClick={() => classify.mutate()} title="Sugerir com IA">Sugerir</button>}
            </div>
          </Field>
          <Field label="CEST" error={errors.cest?.message}><Input inputMode="numeric" maxLength={7} {...register('cest', { setValueAs: (v) => v || null })} /></Field>
          <Field label="cClassTrib (IBS/CBS)" error={errors.cclasstrib?.message}><Input inputMode="numeric" maxLength={6} {...register('cclasstrib', { setValueAs: (v) => v || null })} /></Field>
          <Field label="Unidade de estoque"><Input {...register('stockUnit')} /></Field>
        </div>
        {classify.data && (
          <div className="alert ok">
            Sugestão {classify.data.source === 'ai' ? 'da IA' : 'pelas regras'}: NCM <strong>{classify.data.payload.suggestion.ncm}</strong> {classify.data.payload.suggestion.ncmDescription}
            {classify.data.confidence && ` (confiança ${classify.data.confidence}%)`}. {classify.data.payload.rationale} O contador confirma em IA › Rascunhos.
          </div>
        )}
        <div className="grid-4">
          <label className="check"><input type="checkbox" {...register('controlsLot')} /> Controla lote</label>
          <label className="check"><input type="checkbox" {...register('controlsExpiry')} /> Controla validade</label>
          <label className="check"><input type="checkbox" {...register('ownProduction')} /> Produção própria</label>
          <label className="check"><input type="checkbox" {...register('allowNegativeStock')} /> Permite estoque negativo</label>
        </div>
        <ErrorBox error={serverError ?? classify.error} />
      </form>
    </Dialog>
  );
}

function ProductDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const p = useQuery({ queryKey: ['product', id], queryFn: () => api.get<Record<string, any>>(`/v1/products/${id}`) });
  const stock = useQuery({ queryKey: ['balances', id], queryFn: () => api.get<{ warehouse_code: string; quantity: string; reserved: string; available: string; avg_cost: string | null; value: string; lot_number: string | null }[]>('/v1/stock/balances', { productId: id }) });
  const price = useQuery({ queryKey: ['quote', id], queryFn: () => api.get<{ unitPrice: string; priceListCode: string; margin: { marginPercent: string } | null }>('/v1/pricing/quote', { productId: id }), retry: false });
  const d = p.data;
  return (
    <Dialog title={d ? `${d.sku} — ${d.description}` : 'Produto'} onClose={onClose} wide>
      <ErrorBox error={p.error} />
      {d && (
        <div className="stack">
          <div className="grid-4">
            <Field label="NCM / CEST"><span className="mono">{d.ncm} {d.cest && `/ ${d.cest}`}</span></Field>
            <Field label="Unidade"><span>{d.stock_unit}</span></Field>
            <Field label="Preço de venda">{price.data ? <span>{brl(price.data.unitPrice)} <span className="muted">({price.data.priceListCode})</span></span> : <span className="muted">sem tabela</span>}</Field>
            <Field label="Margem">{price.data?.margin ? <span>{price.data.margin.marginPercent}%</span> : <span className="muted">—</span>}</Field>
          </div>
          <h3>Estoque</h3>
          {(stock.data ?? []).length === 0 ? <span className="muted">Sem saldo.</span> : (
            <table className="lines">
              <thead><tr><th>Depósito</th><th>Lote</th><th className="num">Físico</th><th className="num">Reservado</th><th className="num">Disponível</th><th className="num">Custo médio</th><th className="num">Valor</th></tr></thead>
              <tbody>{stock.data!.map((b, i) => (
                <tr key={i}><td>{b.warehouse_code}</td><td>{b.lot_number}</td><td className="num">{qty(b.quantity)}</td><td className="num">{qty(b.reserved)}</td><td className="num">{qty(b.available)}</td>
                  <td className="num">{brl(b.avg_cost)}</td><td className="num">{brl(b.value)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}
    </Dialog>
  );
}
