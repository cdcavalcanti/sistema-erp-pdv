# VORTEX ERP

ERP horizontal para pequenas e médias empresas brasileiras, construído a partir do
guia *Como construir o ERP da VORTEX*. Ele cobre cadastros, motor fiscal (ICMS, ST,
DIFAL, IPI, PIS/Cofins, ISS e IBS/CBS da reforma), NF-e/NFC-e/CT-e/NFS-e por gateway,
estoque e custos, vendas, compras, financeiro e conciliação, contabilidade por eventos,
obrigações (EFD ICMS/IPI, EFD-Contribuições, EFD-Reinf, apoio ao PGDAS-D/DEFIS),
contratos e recorrência, produção, RH (importação da folha) e IA com Claude.

A frente de caixa (**Vortex PDV**) é um projeto separado, `vortex-pdv`, que integra com este ERP
pela API `/v1/pdv/*` (veja a seção [Vortex PDV](#vortex-pdv)).

## Estrutura

```
apps/
  api/          Fastify 5 + PostgreSQL 16 (RLS por tenant). Rotas REST /v1, OpenAPI em /docs
    migrations/ SQL versionado (aplicado em ordem, uma vez)
    src/modules/<módulo>/  rotas, serviços e jobs de cada área
    src/worker/ fila de jobs, outbox e webhooks
    test/       testes de integração contra Postgres real
  web/          React 19 + Vite. Testes de componente (Vitest) e ponta a ponta (Playwright)
packages/
  money/        Decimal, escalas e arredondamento (único lugar onde se arredonda)
  validators/   CPF, CNPJ (inclusive alfanumérico), IE por UF, GTIN, chave de acesso
  fiscal-engine/ motor fiscal puro (sem I/O) e testes dourados
  contracts/    esquemas zod compartilhados entre API e web (e copiados no vortex-pdv)
  pricing/      preço, promoções e tabelas (mesmo cálculo no ERP e no PDV)
  brand/        identidade visual Vortex: símbolo, wordmark e tema claro/escuro
docs/
  adr/          decisões de arquitetura
  rn-catalog.json, rn-matrix.md  as 89 regras RN- e o teste que cobre cada uma
  tabelas-oficiais.md            carga e atualização de NCM, CEST, CFOP, cClassTrib e IBGE
  operacao.md                    homologação SEFAZ, backup, observabilidade, LGPD e piloto
infra/          roles do banco, Dockerfiles e nginx
```

## Rodando localmente

Requisitos: Node 22+, pnpm 10 e Docker (ou um PostgreSQL 16).

```bash
cp .env.example .env               # ajuste se necessário; nunca coloque segredos reais no git
docker compose up -d postgres      # cria os roles vortex_owner / vortex_app / vortex_worker
pnpm install
pnpm --filter "./packages/*" build
pnpm db:migrate
pnpm db:seed                       # tenant "demo" com 90 dias de operação fictícia (~2 min)
pnpm dev:api                       # http://localhost:3333  (OpenAPI: /docs)
pnpm --filter @vortex/api worker   # fila de jobs, outbox, webhooks e agendamentos
pnpm dev:web                       # http://localhost:5173
```

Usuários do tenant `demo` (o seed imprime a chave TOTP do admin):

| Usuário | Senha | Papel |
|---|---|---|
| gerente@demo.local | vortex-gerente-123 | gerente |
| vendedor@demo.local | vortex-vendedor-123 | vendedor |
| admin@demo.local | vortex-admin-123 | administrador (exige MFA) |

O seed preenche 90 dias de operação fictícia para todas as telas terem o que mostrar:

- compras recebidas por XML de seis fornecedores;
- cerca de 130 pedidos em todas as etapas (criado, em aprovação, aprovado, separação, conferido, faturado, despachado, entregue e cancelado);
- cerca de 1.500 vendas da loja física em dois caixas, com itens cancelados, aberturas, sangrias e fechamentos;
- despesas do mês, títulos pagos, a vencer e vencidos;
- uma segunda empresa, **Vortex Distribuidora** (Lucro Presumido), para ver ICMS de débito, crédito e DIFAL em Fiscal → Impostos. Ela fica no seletor de empresa, no topo.

`SEED_HISTORY=0` pula o histórico.

Sem `ANTHROPIC_API_KEY` a IA fica desligada e cada funcionalidade usa as regras
determinísticas. Os gateways fiscal e bancário começam em modo `simulated`. A emissão
real usa `FISCAL_GATEWAY=partner` e `SEFAZ_AMBIENTE=2`, que é homologação; nunca teste emissão em produção.

Para subir tudo em contêineres: `docker compose up --build`. A web fica em http://localhost:8080.

## Testes

```bash
pnpm typecheck
pnpm test                          # pacotes, API (Postgres em TEST_DATABASE_URL) e web
pnpm --filter @vortex/web e2e      # Playwright contra API e web reais
node scripts/rn-matrix.mjs         # regenera docs/rn-matrix.md
```

O que a seção 25 do guia pede e onde está:

| Exigência | Onde |
|---|---|
| 300+ casos fiscais dourados | `packages/fiscal-engine/test/golden.*` (casos manuais e matrizes DIFAL, Simples e monofásicos) |
| Um teste por regra RN-, com o código no nome | `apps/api/test/*.test.ts`. `rn-coverage.test.ts` falha se alguma das 89 regras ficar sem teste |
| Propriedades: somas fecham | motor (Σ itens = totais), `inventory.test.ts` (saldo = Σ movimentos), `properties.test.ts` (débitos = créditos sob eventos e estornos aleatórios) |
| Isolamento de tenant em todas as rotas | `tenant-isolation.test.ts` percorre a tabela de rotas, lendo e escrevendo com ids de outro tenant |
| Smoke sem rede e `.env.example` espelhado | `config.test.ts` |
| Fluxos de tela | `apps/web/e2e/fluxos.spec.ts` (desktop e celular) |

## Vortex PDV

O PDV é o projeto `vortex-pdv`. Para testar os dois juntos, extraia os projetos lado a lado
(`projetos/vortex-erp` e `projetos/vortex-pdv`) e, com este ERP rodando:

```bash
pnpm db:seed          # cria o terminal 03 e os operadores do caixa e grava ../vortex-pdv/apps/pdv/.env
pnpm dev:api          # o PDV conversa com o ERP em http://localhost:3333
```

Depois siga o README do vortex-pdv. Se o PDV estiver em outra pasta, o seed mostra a chave do
terminal para colar no `.env` do agente, ou grave direto com
`SEED_PDV_ENV=/caminho/vortex-pdv/apps/pdv/.env pnpm db:seed`.

Logins do caixa (usuário / PIN): `ana` / 482913 (operador), `sup` / 730184 (supervisor) e
`ger` / 915372 (gerente). Do lado do ERP ficam os terminais (chave por terminal, rotação e
bloqueio), operadores com PIN, parâmetros da loja, a importação das vendas, o cancelamento, a
devolução, o caixa e a auditoria dos terminais (`apps/api/src/modules/pdv`).

## Identidade visual

O ERP usa a identidade Vortex a partir de `@vortex/brand` (o PDV tem a mesma cópia): símbolo e wordmark redesenhados em
vetor, preto, prata e creme, com o violeta como detalhe (foco, seleção e destaques). Tem
**tema claro e escuro**. O botão no topo alterna entre sistema, claro e escuro, e a escolha fica
salva no navegador. As cores ficam em variáveis CSS no início de `apps/web/src/styles.css`. A fonte Inter vem
empacotada, sem depender de internet.

## Princípios que o código segue

- **Tenant no banco.** Toda tabela de negócio tem `tenant_id`, RLS forçada e chaves
  estrangeiras compostas `(tenant_id, id)`. A API conecta como `vortex_app`, que nunca tem `BYPASSRLS`.
- **Nada some.** Há auditoria por trigger. Documentos emitidos e lançamentos são
  imutáveis e se corrigem por estorno. Períodos fechados ficam travados no banco.
- **Somas verificadas no banco.** Débitos = créditos é uma constraint trigger diferida e
  o saldo de estoque só muda junto com um movimento (RN-GER-01).
- **Efeitos externos depois do commit.** Eventos vão para o outbox na mesma transação.
  Transmissões, webhooks e e-mails saem por jobs idempotentes.
- **IA só lê.** O que ela propõe vira rascunho, e uma pessoa com a permissão confirma (RN-IA-01).

Veja `docs/adr/` para o porquê de cada escolha.
