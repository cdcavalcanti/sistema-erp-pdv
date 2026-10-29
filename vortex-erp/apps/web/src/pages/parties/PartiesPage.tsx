import { useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { PARTY_ROLES, partySchema } from '@vortex/contracts';
import { detectTaxId } from '@vortex/validators';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { DataTable } from '../../components/DataTable';
import { Dialog, ErrorBox, Field, Input, PageHeader, Select, Status, useDebounced, useToast } from '../../components/ui';
import { brl, date, doc } from '../../lib/format';
import { usePaged } from '../../lib/hooks';

interface PartyRow { id: string; code: string; kind: string; tax_id: string | null; legal_name: string; trade_name: string | null; status: string; credit_limit: string; roles: string[]; city: string | null }
const ROLE_LABEL: Record<string, string> = { customer: 'Cliente', supplier: 'Fornecedor', carrier: 'Transportadora', salesperson: 'Vendedor', employee: 'Colaborador', partner: 'Parceiro' };

export default function PartiesPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const dq = useDebounced(q);
  const list = usePaged<PartyRow>(['parties'], '/v1/parties', { q: dq || undefined, role: role || undefined });
  const [creating, setCreating] = useState(false);
  const openId = params.get('abrir');
  return (
    <>
      <PageHeader title="Pessoas" subtitle="Clientes, fornecedores, transportadoras e vendedores em um só cadastro"
        actions={can('cadastros.pessoa.criar') && <button className="btn primary" onClick={() => setCreating(true)}>Nova pessoa</button>} />
      <div className="row" style={{ marginBottom: 10 }}>
        <Input placeholder="Nome, fantasia ou CPF/CNPJ" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} aria-label="Buscar pessoas" />
        <Select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 'auto' }} aria-label="Papel">
          <option value="">Todos os papéis</option>
          {PARTY_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </Select>
      </div>
      <ErrorBox error={list.error} />
      <DataTable rows={list.rows} rowKey={(r) => r.id} label="Pessoas" height="calc(100vh - 230px)" onOpen={(r) => setParams({ abrir: r.id })}
        footer={list.hasNextPage && <button className="btn sm" onClick={() => list.fetchNextPage()}>Carregar mais</button>}
        columns={[
          { key: 'code', label: 'Código', width: '80px', hideOnMobile: true },
          { key: 'legal_name', label: 'Nome / razão social', width: 'minmax(200px, 3fr)', render: (r) => <>{r.legal_name}{r.trade_name && <span className="muted"> · {r.trade_name}</span>}</> },
          { key: 'tax_id', label: 'CPF/CNPJ', width: '170px', render: (r) => <span className="mono">{doc(r.tax_id)}</span> },
          { key: 'roles', label: 'Papéis', width: '200px', render: (r) => r.roles.map((x) => ROLE_LABEL[x] ?? x).join(', '), hideOnMobile: true },
          { key: 'city', label: 'Cidade', width: '160px', hideOnMobile: true },
          { key: 'credit_limit', label: 'Limite de crédito', type: 'money', width: '140px', hideOnMobile: true },
          { key: 'status', label: 'Situação', width: '110px', render: (r) => <Status value={r.status} /> },
        ]} />
      {creating && <PartyForm onClose={() => setCreating(false)} />}
      {openId && <PartyDetail id={openId} onClose={() => setParams({})} />}
    </>
  );
}

type FormIn = z.input<typeof partySchema>;
type FormOut = z.output<typeof partySchema>;

/** Cadastro com o mesmo esquema da API (@vortex/contracts) e as consultas públicas de CNPJ e CEP. */
function PartyForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { register, handleSubmit, watch, setValue, control, setError, formState: { errors, isSubmitting } } = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(partySchema),
    defaultValues: { kind: 'PJ', roles: ['customer'], ieIndicator: 9, creditLimit: '0', addresses: [{ kind: 'fiscal', countryCode: '1058', isDefault: true, street: '', number: '', district: '', cityName: '' }], contacts: [] },
  });
  const contacts = useFieldArray({ control, name: 'contacts' });
  const [serverError, setServerError] = useState<unknown>(null);
  const kind = watch('kind');
  const taxId = watch('taxId');
  const lookupCnpj = useMutation({
    mutationFn: () => api.get<{ legalName: string; tradeName: string | null; registrationStatus: string; address: { zip: string; street: string; number: string; complement: string | null; district: string; cityName: string; cityIbge: string | null; uf: string } | null; email: string | null; simplesNacional: boolean | null }>(`/v1/lookups/cnpj/${encodeURIComponent(taxId ?? '')}`),
    onSuccess: (r) => {
      setValue('legalName', r.legalName);
      if (r.tradeName) setValue('tradeName', r.tradeName);
      if (r.simplesNacional !== null) setValue('taxRegime', r.simplesNacional ? 'simples_nacional' : 'normal');
      if (r.address) {
        for (const k of ['zip', 'street', 'number', 'complement', 'district', 'cityName', 'cityIbge', 'uf'] as const) setValue(`addresses.0.${k}`, r.address[k] ?? undefined);
      }
      if (r.registrationStatus !== 'ativa') toast(`Atenção: situação cadastral ${r.registrationStatus} na Receita`, 'bad');
    },
  });
  const zip = watch('addresses.0.zip');
  const lookupCep = useMutation({
    mutationFn: () => api.get<{ street: string; district: string; cityName: string; cityIbge: string; uf: string }>(`/v1/lookups/cep/${(zip ?? '').replace(/\D/g, '')}`),
    onSuccess: (r) => {
      setValue('addresses.0.street', r.street);
      setValue('addresses.0.district', r.district);
      setValue('addresses.0.cityName', r.cityName);
      setValue('addresses.0.cityIbge', r.cityIbge);
      setValue('addresses.0.uf', r.uf);
    },
  });
  const submit = handleSubmit(async (v) => {
    setServerError(null);
    try {
      await api.post('/v1/parties', v);
      toast('Pessoa cadastrada');
      qc.invalidateQueries({ queryKey: ['parties'] });
      onClose();
    } catch (e) {
      if (e instanceof ApiError) for (const [k, msg] of Object.entries(e.fieldErrors)) setError(k as never, { message: msg });
      setServerError(e);
    }
  });
  const taxInfo = taxId ? detectTaxId(taxId) : null;
  const a = errors.addresses?.[0];
  return (
    <Dialog title="Nova pessoa" onClose={onClose} wide footer={<>
      <button className="btn" type="button" onClick={onClose}>Cancelar</button>
      <button className="btn primary" type="submit" form="party-form" disabled={isSubmitting}>Salvar</button>
    </>}>
      <form id="party-form" className="stack" onSubmit={submit} noValidate>
        <div className="grid-4">
          <Field label="Tipo"><Select {...register('kind')}><option value="PJ">Pessoa jurídica</option><option value="PF">Pessoa física</option><option value="EX">Estrangeiro</option></Select></Field>
          <Field label={kind === 'PF' ? 'CPF' : 'CNPJ'} error={errors.taxId?.message} hint={taxInfo && !taxInfo.valid ? 'Dígitos não conferem' : undefined}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <Input {...register('taxId')} invalid={!!errors.taxId || (taxInfo ? !taxInfo.valid : false)} />
              {kind === 'PJ' && <button type="button" className="btn" disabled={!taxInfo?.valid || lookupCnpj.isPending} onClick={() => lookupCnpj.mutate()} title="Consultar na Receita">Consultar</button>}
            </div>
          </Field>
          <Field label="Inscrição estadual" error={errors.ie?.message}><Input {...register('ie')} /></Field>
          <Field label="Contribuinte de ICMS">
            <Select {...register('ieIndicator', { setValueAs: (v) => Number(v) })}><option value={1}>Contribuinte</option><option value={2}>Isento</option><option value={9}>Não contribuinte</option></Select>
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Nome / razão social" error={errors.legalName?.message}><Input {...register('legalName')} invalid={!!errors.legalName} /></Field>
          <Field label="Nome fantasia"><Input {...register('tradeName')} /></Field>
        </div>
        <fieldset className="card card-pad" style={{ margin: 0 }}>
          <legend className="muted" style={{ padding: '0 4px' }}>Papéis</legend>
          <div className="row">
            {PARTY_ROLES.map((r) => <label key={r} className="check"><input type="checkbox" value={r} {...register('roles')} /> {ROLE_LABEL[r]}</label>)}
            <span className="spacer" />
            <label className="check"><input type="checkbox" {...register('finalConsumer')} /> Consumidor final</label>
          </div>
          {errors.roles && <small className="err">{errors.roles.message ?? 'Escolha ao menos um papel'}</small>}
        </fieldset>
        <h3>Endereço fiscal</h3>
        <div className="grid-4">
          <Field label="CEP" error={a?.zip?.message}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <Input inputMode="numeric" {...register('addresses.0.zip')} invalid={!!a?.zip} />
              <button type="button" className="btn" disabled={lookupCep.isPending} onClick={() => lookupCep.mutate()}>Buscar</button>
            </div>
          </Field>
          <Field label="Logradouro" error={a?.street?.message}><Input {...register('addresses.0.street')} invalid={!!a?.street} /></Field>
          <Field label="Número" error={a?.number?.message}><Input {...register('addresses.0.number')} invalid={!!a?.number} /></Field>
          <Field label="Bairro" error={a?.district?.message}><Input {...register('addresses.0.district')} invalid={!!a?.district} /></Field>
          <Field label="Cidade" error={a?.cityName?.message}><Input {...register('addresses.0.cityName')} invalid={!!a?.cityName} /></Field>
          <Field label="Código IBGE" error={a?.cityIbge?.message}><Input inputMode="numeric" {...register('addresses.0.cityIbge')} /></Field>
          <Field label="UF" error={a?.uf?.message}><Input maxLength={2} {...register('addresses.0.uf')} /></Field>
          <Field label="Complemento"><Input {...register('addresses.0.complement')} /></Field>
        </div>
        <div className="grid-3">
          <Field label="Limite de crédito (R$)" error={errors.creditLimit?.message}><Input inputMode="decimal" className="num" {...register('creditLimit')} /></Field>
          <Field label="E-mail para XML" error={errors.xmlEmail?.message}><Input type="email" {...register('xmlEmail')} /></Field>
          <Field label="Regime tributário">
            <Select {...register('taxRegime', { setValueAs: (v) => v || null })}><option value="">Não informado</option><option value="simples_nacional">Simples Nacional</option><option value="mei">MEI</option><option value="normal">Regime normal</option></Select>
          </Field>
        </div>
        <div className="row"><h3>Contatos</h3><span className="spacer" />
          <button type="button" className="btn sm" onClick={() => contacts.append({ name: '', consents: {} })}>Adicionar contato</button></div>
        {contacts.fields.map((f, i) => (
          <div key={f.id} className="grid-4">
            <Field label="Nome" error={errors.contacts?.[i]?.name?.message}><Input {...register(`contacts.${i}.name`)} /></Field>
            <Field label="E-mail" error={errors.contacts?.[i]?.email?.message}><Input type="email" {...register(`contacts.${i}.email`, { setValueAs: (v) => v || null })} /></Field>
            <Field label="WhatsApp"><Input inputMode="tel" {...register(`contacts.${i}.whatsapp`)} /></Field>
            <label className="check" style={{ alignSelf: 'end', height: 32 }}>
              <input type="checkbox" {...register(`contacts.${i}.consents.cobranca_whatsapp`)} /> Aceita cobrança por WhatsApp (LGPD)
            </label>
          </div>
        ))}
        <ErrorBox error={serverError ?? lookupCnpj.error ?? lookupCep.error} />
      </form>
    </Dialog>
  );
}

function PartyDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['party', id], queryFn: () => api.get<Record<string, any>>(`/v1/parties/${id}`) });
  const p = q.data;
  return (
    <Dialog title={p?.legal_name ?? 'Pessoa'} onClose={onClose} wide>
      <ErrorBox error={q.error} />
      {p && (
        <div className="stack">
          <div className="grid-4">
            <Field label="Documento"><span className="mono">{doc(p.tax_id)}</span></Field>
            <Field label="Situação"><Status value={p.status} /></Field>
            <Field label="Limite de crédito"><span>{brl(p.credit_limit)}</span></Field>
            <Field label="Cadastro"><span>{date(p.created_at)}</span></Field>
          </div>
          {(p.addresses ?? []).map((a: any) => (
            <div key={a.id} className="muted">{a.street}, {a.number}{a.complement ? ` ${a.complement}` : ''} — {a.district}, {a.city_name}/{a.uf} · CEP {a.zip}</div>
          ))}
          {(p.contacts ?? []).length > 0 && <h3>Contatos</h3>}
          {(p.contacts ?? []).map((c: any) => <div key={c.id}>{c.name} {c.email && `· ${c.email}`} {c.whatsapp && `· ${c.whatsapp}`}</div>)}
          {p.lgpd_purpose && <p className="muted" style={{ margin: 0 }}>Finalidade (LGPD): {p.lgpd_purpose}</p>}
        </div>
      )}
    </Dialog>
  );
}
