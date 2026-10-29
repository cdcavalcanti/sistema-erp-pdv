# Tabelas oficiais

As tabelas oficiais ficam no schema `fiscal`. Elas são globais, iguais para todos os
tenants, e a aplicação (`vortex_app`) só pode lê-las. A escrita usa a credencial do dono
do schema (`DATABASE_OWNER_URL`). A API as expõe em `/v1/official/*`, para busca e autocompletar.

| Tabela | Conteúdo | Fonte oficial | Vigência |
|---|---|---|---|
| `fiscal.ncm` | NCM e alíquota de IPI (TIPI) | Siscomex / Receita Federal (TIPI) | sim: `valid_from`/`valid_to` |
| `fiscal.cest` | CEST × NCM (substituição tributária) | Convênio ICMS 142/2018 e atualizações | não |
| `fiscal.cfop` | CFOP com indicador de devolução | Ajuste SINIEF / Portal NF-e | não |
| `fiscal.cclasstrib` | cClassTrib do IBS/CBS (CST, reduções, crédito presumido, diferimento, isenção, base legal) | Portal NF-e — tabela da NT 2025.002 / LC 214/2025 | sim |
| `fiscal.ibge_cities` | Municípios (código IBGE de 7 dígitos, UF) | API de localidades do IBGE | não |
| `fiscal.countries` | Países (código BACEN) | Tabela BACEN usada na NF-e | não |
| `fiscal.units` | Unidades de medida comerciais | Uso da casa (alinhado à NF-e) | não |
| `fiscal.nbs` | NBS (serviços) | Portal da NFS-e nacional | não |
| `fiscal.service_codes` | Item da lista da LC 116/2003 e código de tributação nacional | Portal da NFS-e nacional | não |

## Carga inicial

A migration `0003_official_seed.sql` carrega um **subconjunto de desenvolvimento**
(CFOPs usuais, NCMs dos exemplos e dos testes, cClassTrib principais, capitais e as
cidades usadas nos testes). Isso basta para desenvolver e rodar a suíte sem rede. Antes do
piloto, carregue as tabelas completas:

```bash
pnpm --filter @vortex/api fiscal:import ibge_cities --ibge                 # baixa da API do IBGE
pnpm --filter @vortex/api fiscal:import ncm ./dados/ncm.json 2026-01-01
pnpm --filter @vortex/api fiscal:import cclasstrib ./dados/cclasstrib.json 2026-01-01
pnpm --filter @vortex/api fiscal:import cest ./dados/cest.json
pnpm --filter @vortex/api fiscal:import cfop ./dados/cfop.json
```

Formato dos JSON: um array de objetos. Os campos aceitos estão em
`apps/api/src/modules/registry/official-import.ts`. Por exemplo:
NCM `{ code, description, ipiRate?, validFrom? }`, cClassTrib
`{ code, cst, description, reductionIbs, reductionCbs, presumedCredit, deferral, exempt, legalBasis }`.
O importador aceita também os nomes em português usados nas planilhas oficiais (`codigo`, `descricao`).

## Atualização

- O job `tabelas_oficiais.atualizar` roda **semanalmente** no worker. Ele busca os
  municípios na API do IBGE e, quando configurados, os JSON de `NCM_SOURCE_URL`,
  `CCLASSTRIB_SOURCE_URL` e `CEST_SOURCE_URL`. NCM e cClassTrib não têm uma API oficial
  estável. Por isso, a operação publica os arquivos convertidos a partir das tabelas do
  Portal NF-e/Siscomex num bucket interno e aponta essas variáveis para eles.
- **Vigência (RN-GER-03).** Quando a descrição ou o tratamento de um NCM ou cClassTrib
  muda, o importador encerra a versão vigente na véspera (`valid_to = vigência − 1`) e cria
  a nova. Documentos já emitidos continuam ligados à versão da data em que foram emitidos.
  O motor fiscal sempre recebe a versão vigente na data da operação.
- O importador é idempotente: rodar de novo o mesmo arquivo não muda nada.
- O resultado de cada execução fica em `integration.jobs.result` (inseridos, atualizados e
  vigências encerradas). Se a execução falhar, o job vai para retentativa e aparece em `/metrics`.

## Antes de cada entrega em produção

Alíquotas, prazos e leiautes mudam com frequência. Antes de cada entrega, confirme no
Portal Nacional da NF-e, no Portal da Conformidade Fácil e com o contador:

1. A versão da tabela de cClassTrib e as NTs vigentes (NT 2025.002 e posteriores).
2. A TIPI vigente (mudanças de IPI por decreto).
3. Os convênios de ST e o CEST das UFs atendidas.
4. Se algum caso dourado de `packages/fiscal-engine/test/golden.cases.ts` mudou de resultado.
