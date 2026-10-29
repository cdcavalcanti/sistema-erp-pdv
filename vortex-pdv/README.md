# Vortex PDV

Frente de caixa offline-first integrada ao **Vortex ERP**. Este projeto é só o PDV. O ERP é o
projeto `vortex-erp`, e os dois conversam pela API do ERP (`/v1/pdv/*`). O PDV lê produtos,
preços, estoque, clientes, operadores e parâmetros do ERP e devolve vendas, caixa, devoluções e
auditoria.

```
apps/
  pdv/          agente do terminal: Node 22 + SQLite local, fila de sincronização, NFC-e,
                pagamentos, impressora e balança (API local em 127.0.0.1:4545)
  pdv-web/      frente de caixa (React); fala só com o agente local
packages/       cópia dos pacotes compartilhados com o ERP: money, validators, fiscal-engine,
                contracts, pricing e brand (identidade visual)
infra/          pacote do terminal, instalador systemd e atualização controlada
docs/           arquitetura e mapa da especificação, instalação, operação e homologação
```

## Rodando localmente

Requisitos: Node 22+, pnpm 10 e o **vortex-erp rodando** (ele precisa de PostgreSQL 16).
Extraia os dois projetos lado a lado:

```
projetos/
  vortex-erp/
  vortex-pdv/
```

**1. ERP** (na pasta `vortex-erp`, siga o README dele; em resumo):

```bash
cp .env.example .env
docker compose up -d postgres      # ou um PostgreSQL 16 local com infra/db/init-roles.sql
pnpm install
pnpm --filter "./packages/*" build
pnpm db:migrate
pnpm db:seed                       # cria o terminal 03 e os operadores do PDV e grava ../vortex-pdv/apps/pdv/.env
pnpm dev:api                       # http://localhost:3333
```

**2. PDV** (nesta pasta):

```bash
pnpm install
pnpm build:packages
pnpm dev                           # agente em http://127.0.0.1:4545
pnpm dev:web                       # frente de caixa em http://localhost:5174
```

Abra http://localhost:5174 e entre com usuário e PIN:

| Usuário | PIN | Perfil |
|---|---|---|
| `ana` | 482913 | operador |
| `sup` | 730184 | supervisor |
| `ger` | 915372 | gerente |

Pix, TEF, SEFAZ, impressora e balança começam **simulados** e aparecem identificados na tela
(caixa amarela de homologação). Os botões de simulação ficam em Menu (F12) → Status.

### Se o `.env` do agente não foi criado

O seed do ERP só grava `apps/pdv/.env` quando encontra esta pasta ao lado dele. Em qualquer
outro lugar, ele mostra a chave do terminal. Então:

```bash
cp apps/pdv/.env.example apps/pdv/.env
# preencha PDV_ERP_API_KEY (chave do terminal), PDV_STORE_ID (id da loja no ERP) e PDV_TERMINAL_CODE=03
```

Outra opção: no vortex-erp, `SEED_PDV_ENV=/caminho/para/vortex-pdv/apps/pdv/.env pnpm db:seed`
gera uma chave nova e grava o arquivo nesse caminho.

## Testes

```bash
pnpm typecheck
pnpm test        # domínio, venda, pagamentos, caixa, offline, fiscal, hardware e configuração
pnpm e2e         # Playwright: ERP + agente + interface reais (precisa do vortex-erp ao lado)
```

O aceite do MVP (LOGIN → … → ESTOQUE → FINANCEIRO, conferido no banco do ERP) roda dentro de
`pnpm test` quando o vortex-erp está na pasta vizinha (ou em `ERP_DIR`) com `pnpm install` e os
pacotes compilados. Sem ele, o aceite é pulado e o resto roda normalmente. Os testes do PDV
usam o Postgres do ERP só no aceite (`TEST_DATABASE_*`, com os mesmos padrões do ERP).

## Pacotes compartilhados

`packages/` tem uma cópia dos pacotes do vortex-erp. O mais importante é `contracts`, com os
esquemas da API `/v1/pdv/*`. Ao mudar um contrato ou o motor fiscal no ERP, copie o pacote para
cá também, para que os dois lados calculem e validem igual.

## Produção

`pnpm release 1.0.0` gera `dist-pdv/vortex-pdv-1.0.0.tar.gz`, com o agente, a interface,
`install.sh` (systemd) e `update.sh` (atualização que espera a venda terminar). O passo a passo,
incluindo os provedores reais de NFC-e, Pix, impressora e balança, está em
[docs/instalacao.md](docs/instalacao.md).

Documentação: [arquitetura e mapa da especificação](docs/README.md), [instalação](docs/instalacao.md),
[operação](docs/operacao.md), [homologação e simuladores](docs/homologacao.md) e [bateria integrada ERP × PDV](docs/bateria-erp-pdv.md) (`pnpm bateria`).
