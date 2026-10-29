# Vortex PDV

Frente de caixa offline-first integrada ao Vortex ERP, construída a partir da
*Vortex PDV — Especificação Completa*. O ERP é o cérebro administrativo e o PDV, a operação
de venda (seção 56). O PDV **não** reimplementa cadastros, estoque, financeiro nem contabilidade:
ele lê esses dados do ERP pela API e devolve vendas, caixa, devoluções e auditoria (seções 2 e 4).

| Documento | Para quem |
|---|---|
| [instalacao.md](instalacao.md) | Implantação: cadastro do terminal no ERP, pareamento, instalação no Linux, atualização, backup e periféricos |
| [operacao.md](operacao.md) | Operador, supervisor e gerente: atalhos, venda, pagamentos, caixa, devolução e o que fazer quando algo cai |
| [homologacao.md](homologacao.md) | Integrações simuladas (mocks) identificadas, como provocar cada cenário e o roteiro com provedores reais |
| [ADR-0001](adr/0001-pdv-agente-local-offline.md) | Por que o PDV é um agente local com SQLite e uma interface web |

## Arquitetura (seção 45)

```
┌──────────────── terminal do caixa ────────────────┐            ┌──────── Vortex ERP ────────┐
│ apps/pdv-web  (React)  ── só fala com o agente ── │            │ /v1/pdv/*  (chave x-api-key │
│        │ HTTP 127.0.0.1:4545                       │            │  por terminal, com escopos) │
│ apps/pdv  (agente Node 22)                         │  push/pull │ estoque, títulos, contábil, │
│   http/        API local, validação, erros pt-BR  │ ─────────► │ NFC-e (registro), eventos,  │
│   application/ casos de uso (venda, caixa, ...)   │ ◄───────── │ parâmetros, operadores,     │
│   domain/      regras puras (carrinho, troco...)  │  webhooks  │ monitoramento dos terminais │
│   db/          SQLite local (WAL, sync FULL)      │            └─────────────────────────────┘
│   sync/        fila SYNC_QUEUE + motor de sync    │
│   erp/         cliente da API do ERP              │──► Parceiro fiscal / SEFAZ (NFC-e)
│   payment/     dinheiro, Pix, TEF, maquininha     │──► PSP Pix (API Pix do Bacen)
│   fiscal/      NFC-e 4.00, QR, contingência       │
│   printer/     ESC/POS, gaveta                    │──► impressora térmica (TCP 9100)
│   hardware/    balança Toledo, display            │──► balança (TCP / ser2net)
│   security/    PIN scrypt, cifra AES-256-GCM      │
│   audit/       eventos imutáveis (seção 39)       │
└────────────────────────────────────────────────────┘
```

- **A interface não fala com o ERP.** Tudo passa pelo agente local, que grava a venda no SQLite
  antes de qualquer chamada externa. Sem internet, o caixa continua vendendo (seção 29).
- **Mesmo motor fiscal do ERP.** O agente usa `@vortex/fiscal-engine` com o contexto fiscal que o
  ERP envia na carga (regime, regras por produto). Os impostos da NFC-e e os do ERP batem.
- **Integrações por interface.** Provedores reais e simulados implementam as mesmas interfaces.
  Simulador ligado aparece na barra de status ("Homologação") e na tela de status, com o nome
  de cada integração simulada. Em produção com `PDV_SEFAZ_AMBIENTE=1`, o agente não sobe com
  nenhum simulador de fiscal, Pix ou TEF (`config.ts`).

### Banco local (seção 30) e fila (seção 31)

`apps/pdv/src/db/migrations/001_init.sql` tem produtos, códigos de barras, preços, promoções,
clientes (CPF cifrado + hash para busca), formas de pagamento, operadores (PIN em hash), saldos de
estoque, sessões, caixas e movimentos, vendas, itens, pagamentos, documentos fiscais, devoluções,
eventos (com triggers que impedem alterar e apagar) e `sync_queue`.

`sync_queue` tem exatamente os campos da seção 31: `id, type, entity, entity_id, payload,
created_at, status, attempts, last_error, synced_at`. Estados: `PENDING → PROCESSING → SYNCED |
FAILED`. Há uma entrada por `(type, entity_id)`, e a ordem de envio é cliente → caixa → venda →
autorização da contingência → cancelamento/devolução. Um item que caiu por ERP fora do ar volta a
ser tentado assim que a conexão retorna. Um item recusado por regra fica `FAILED` com o motivo,
sem travar o resto.

### Idempotência (seções 32 e 44)

- `sale_uuid` gerado no terminal. O ERP importa a venda uma vez por `saleUuid`, e reenvios
  devolvem o mesmo resultado.
- Número da venda `PDV-03-20261027-000124` (terminal, dia da loja, sequência local persistente).
- Cada pagamento tem `idempotency_key` do cliente e `transaction_id` do provedor. Há no máximo
  um pagamento pendente por venda, garantido por índice único, então um duplo clique não cobra
  duas vezes.
- A NFC-e pendente após uma queda é **consultada** antes de ser retransmitida. Na contingência
  offline, a chave normal original é guardada para a mesma checagem.

## Onde está cada seção da especificação

| Seção | Implementação |
|---|---|
| 5 Perfis | Papéis `operador_caixa`, `supervisor_caixa` e `gerente` no ERP (`core/permissions.ts`), com permissões `pdv.*` sincronizadas para o terminal (`security/permissions.ts`). Alçada de desconto por papel: 5 / 15 / 30 / 100 % |
| 6 Login | Usuário + PIN de 6 dígitos (`PUT /v1/users/:id/pdv-operator`), bloqueio após 5 erros por 5 min, sessão com expiração por inatividade (`application/auth.ts`) |
| 7, 25–28 Caixa | `application/cash.ts`: abertura única por terminal, sangria/suprimento com supervisor, fechamento cego, conferência por forma, diferença registrada e enviada ao ERP, reabertura pelo gerente |
| 8–14 Venda | `application/sales.ts` + `domain/cart.ts`, `barcode.ts`: código, SKU, referência, `3*codigo`, GTIN de embalagem, etiqueta de balança, pesáveis, promoções, descontos com alçada, cliente por CPF ou cadastro rápido |
| 15–20 Pagamento | `payment/providers.ts`, `domain/payments.ts`: dinheiro com troco, Pix (só com confirmação do PSP), débito/crédito/parcelado no TEF, maquininha avulsa (NSU), pagamento múltiplo, recusa, cancelamento e timeout |
| 21 Impressão | `printer/`: comprovante ESC/POS (CP860, QR da NFC-e), gaveta pelo pulso da impressora, reimpressão auditada, impressora sem papel não perde a venda |
| 22–24 Cancelamentos e devolução | Item com motivo; venda em andamento; venda concluída (NFC-e cancelada no prazo, estorno do pagamento, ERP avisado); devolução parcial limitada ao vendido (`application/returns.ts`) |
| 29–33 Offline, banco, fila, idempotência, ERP | `db/`, `sync/queue.ts`, `sync/engine.ts`, `erp/client.ts` |
| 34 Webhooks | `POST /webhooks/erp` com HMAC `t=…,v1=…` e janela de 5 min. Eventos de produto, preço, promoção, estoque, cliente, parâmetros e operadores disparam nova carga |
| 35–36 Estoque | O ERP define limites e se o estoque baixo ou zerado só avisa ou bloqueia (`domain/stock.ts`) |
| 37–38 Fiscal | `fiscal/`: NFC-e 4.00, chave, série = código do terminal, QR v2 online/offline com CSC, rejeição e reprocessamento, cancelamento no prazo, contingência offline (tpEmis 9) e transmissão posterior |
| 39 Auditoria | `audit/audit.ts`: as 16 ações da seção com `user_id, terminal_id, action, entity, entity_id, metadata, timestamp`, enviadas em lote ao ERP (`/v1/pdv/events`) |
| 40 Segurança | Nenhum dado de cartão é guardado (só NSU, autorização e bandeira); CPF cifrado; PIN em scrypt; chave do terminal cifrada; API local só em 127.0.0.1 com limite de tentativas |
| 41 Atalhos | F2–F12, ESC e ENTER (`pdv-web/src/lib/hotkeys.ts`). Veja [operacao.md](operacao.md) |
| 42 Status | Barra de status e modal de status: ERP, fiscal, pagamento, impressora, banco local, balança, fila e simuladores |
| 43 Queda de energia | Banco com `synchronous=FULL`; ao voltar, a venda em andamento é oferecida para continuar, os pagamentos pendentes são consultados e a NFC-e pendente também |
| 46 Design | Tema escuro de alto contraste por padrão (claro conforme o sistema), botões grandes, uso por teclado e toque, layout para tablet |
| 47 Painel | Painel do gerente: vendas do dia, ticket médio, caixas abertos, operadores e pendências, do terminal e da loja (`/v1/pdv/dashboard`) |
| 48–50 Multiterminal, multiloja, monitoramento | Cada terminal tem chave e código próprios e pertence a um estabelecimento. Heartbeat com versão, fila, erros e saúde dos serviços; `GET /v1/pdv/terminals` no ERP |
| 51 Atualização | `cli/update-gate.ts` + `infra/update.sh`: só atualiza sem venda, pagamento nem NFC-e em andamento, com backup e volta automática se a versão nova não subir |
| 52 Backup | Cópia consistente do banco (`VACUUM INTO`) a cada hora e sob demanda, guardando as 48 últimas |

## Testes (seções 53 e 54)

| Pedido | Onde |
|---|---|
| Venda: produto único, vários, quantidade, desconto, cliente, cancelamento | `apps/pdv/test/sale-flow.test.ts`, `domain.test.ts` |
| Pagamento: dinheiro, Pix, cartão, múltiplos, recusa, timeout | `sale-flow.test.ts`, `http.test.ts` |
| Caixa: abertura, sangria, suprimento, fechamento, diferença | `operations.test.ts`, `domain.test.ts` |
| Offline: queda, venda offline, reconexão, sincronização, duplicidade | `operations.test.ts` |
| Fiscal: autorização, rejeição, cancelamento, indisponibilidade | `operations.test.ts` |
| Hardware: scanner, impressora, gaveta, balança | `sale-flow.test.ts`, `operations.test.ts`, `config.test.ts` |
| **Aceite do MVP** (LOGIN → … → FINANCEIRO) contra o ERP real | `apps/pdv/test/acceptance/mvp.test.ts`: confere estoque, caixa, títulos baixados e balancete fechado no Postgres do ERP. Usa o projeto vortex-erp da pasta vizinha (ou `ERP_DIR`); sem ele, é pulado |
| Telas, de ponta a ponta, com ERP, agente e interface reais | `apps/pdv-web/e2e/caixa.spec.ts` (desktop e tablet) |
| Configuração espelhada no `.env.example` e produção sem simuladores | `apps/pdv/test/config.test.ts` |

```bash
pnpm test        # unidade e integração; o aceite do MVP roda quando o vortex-erp está ao lado (ou em ERP_DIR)
pnpm e2e         # Playwright: sobe o ERP (vortex-erp), o agente e a interface
```
