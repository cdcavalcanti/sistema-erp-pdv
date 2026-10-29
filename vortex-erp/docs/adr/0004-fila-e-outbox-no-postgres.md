# ADR-0004 — Fila de jobs e outbox no próprio Postgres

**Status:** aceito

## Contexto
Emitir uma NF-e, entregar webhooks, rodar a régua de cobrança e fazer a distribuição de
DF-e são efeitos externos que não podem se perder nem acontecer em dobro. O sistema
também não pode depender de esses serviços estarem no ar no momento da transação (seção 03).

## Decisão
- `integration.outbox_events` é gravado **na mesma transação** que muda o negócio. O job
  `outbox.dispatch` publica os eventos para os assinantes internos e para os webhooks
  (HMAC, com retentativa exponencial).
- `integration.jobs` é a fila, consumida com `FOR UPDATE SKIP LOCKED`. Tem deduplicação por
  `(tenant, nome, chave)`, tentativas com backoff, estado `dead` e recuperação de jobs
  travados (`jobs.recover_stale`). Agendamentos ficam em `integration.job_schedules`.
- Toda rota de criação aceita `Idempotency-Key`. Ações externas pós-commit
  (`afterCommit`) também rodam em replays e são idempotentes.

## Alternativas
- **Broker dedicado (SQS, RabbitMQ, Kafka):** mais uma peça para operar e um commit
  em duas fases. O volume previsto cabe no Postgres. Se precisar, o outbox pode publicar
  num broker sem mudar os módulos.

## Consequências
- Basta um banco para desenvolver e testar. Os testes drenam a fila de forma síncrona (`drain`).
- A profundidade da fila e o job mais antigo aparecem em `/metrics`.
