# ADR-0001 — PDV como agente local offline-first (SQLite) com interface web

**Status:** aceito

## Contexto
A especificação do Vortex PDV exige que o caixa venda sem internet (seção 29), não perca a
venda numa queda de energia (43), não duplique nada no ERP (32 e 44) e fale com impressora,
gaveta, balança e pinpad (seção 57). O ERP já existe e não deve ganhar um PDV paralelo dentro
dele (seção 2).

## Decisão
- **Agente local** (`apps/pdv`, Node 22) em cada terminal, com API HTTP só em 127.0.0.1.
  A interface (`apps/pdv-web`, React) fala apenas com ele e é servida pelo próprio agente em produção.
- **SQLite embutido** (`node:sqlite`) em WAL com `synchronous=FULL`. Cada operação é uma
  transação local completa, gravada antes de qualquer chamada externa.
- **Fila `sync_queue` no banco local** com os campos da seção 31 e envio idempotente
  (`saleUuid`, `idempotencyKey`, número da venda). Push antes de pull, uma entrada por entidade.
- **ERP como fonte da verdade administrativa:** produtos, preços, promoções, clientes, saldos,
  operadores (PIN em hash), parâmetros e contexto fiscal chegam por `GET /v1/pdv/sync`. O PDV
  só altera dados locais de operação.
- **Mesmo motor fiscal do ERP** (`@vortex/fiscal-engine`) para calcular os impostos da NFC-e no terminal.
- **Integrações por interface**, cada uma com uma implementação simulada identificada.
  Produção com emissão real recusa simuladores.

## Alternativas consideradas
- *PDV 100% web falando direto com o ERP:* não funciona offline e depende do navegador para a impressora e a balança.
- *Electron:* empacota o mesmo agente e a mesma interface, mas aumenta o pacote e a superfície de
  atualização. O navegador em modo quiosque apontando para o agente entrega o mesmo resultado.
- *Postgres local no terminal:* operação e backup mais pesados para um único usuário por máquina.

## Consequências
- O terminal precisa de Node 22 e de um serviço (systemd). O instalador e a atualização
  controlada ficam em `infra/`.
- Cada terminal tem a própria chave de API com escopos mínimos. A revogação é feita no ERP
  (`/rotate-key` e `/block`).
- Vendas offline dependem dos limites do ERP (`offlineMaxHours`). O que ainda não sincronizou só
  existe no terminal e é coberto pelo backup local (seção 52).
