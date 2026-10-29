# Decisões de arquitetura (ADR)

Cada decisão segue o formato: contexto, decisão, alternativas consideradas e consequências.
Uma decisão nova que mude uma anterior ganha um ADR novo. O antigo fica com o status
"substituído por ADR-NNNN".

| ADR | Decisão | Status |
|---|---|---|
| [0001](0001-multitenancy-rls.md) | Multi-tenant em banco único com Row Level Security | Aceito |
| [0002](0002-motor-fiscal-biblioteca-pura.md) | Motor fiscal como biblioteca pura com testes dourados | Aceito |
| [0003](0003-dinheiro-e-arredondamento.md) | Decimal e arredondamento centralizados | Aceito |
| [0004](0004-fila-e-outbox-no-postgres.md) | Fila de jobs e outbox no próprio Postgres | Aceito |
| [0005](0005-contabilidade-por-eventos.md) | Contabilidade por eventos, com partidas dobradas garantidas pelo banco | Aceito |
| [0006](0006-gateway-fiscal-terceirizado.md) | Emissão por parceiro (FiscalGateway), não por comunicação direta com a SEFAZ | Aceito |
| [0007](0007-ia-somente-leitura.md) | IA com ferramentas de leitura, rascunhos e dados pessoais mascarados | Aceito |
| [0008](0008-esquemas-compartilhados.md) | Esquemas zod compartilhados entre API e web | Aceito |

As decisões do Vortex PDV (projeto separado, `vortex-pdv`) ficam em `docs/adr` daquele projeto.
