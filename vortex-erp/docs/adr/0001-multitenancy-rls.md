# ADR-0001 — Multi-tenant em banco único com Row Level Security

**Status:** aceito

## Contexto
O plano é atender mais de 1.000 tenants pequenos e alguns com até 100 mil notas por mês
(seção 24), sem mudar a arquitetura. Vazar dados entre clientes é o pior defeito que um
ERP pode ter. A seção 25 exige um teste automático que tente ler e escrever dados de
outro tenant em todas as rotas.

## Decisão
- Usar um banco e um schema por área (`core`, `registry`, `fiscal`, `sales`…). Toda tabela de
  negócio tem `tenant_id` e uma RLS **forçada** (`FORCE ROW LEVEL SECURITY`), com a política
  `tenant_id = core.current_tenant()`.
- A API conecta como `vortex_app` (`NOBYPASSRLS`) e define `vortex.tenant_id` no início de
  cada transação (`withTenant`). O worker usa `vortex_worker` (`BYPASSRLS`) só para varrer
  filas. A regra de negócio de um tenant roda de novo como `vortex_app`, já com o contexto.
- Cada FK entre tabelas de tenant tem uma FK composta `(tenant_id, coluna) → (tenant_id, id)`
  (migration 0023). Assim, nem um `INSERT` com `tenant_id` correto consegue apontar
  para uma linha de outro tenant, mesmo que a validação da aplicação falhe.
- O tenant só é descoberto antes de haver contexto por funções `SECURITY DEFINER`
  mínimas: slug → id e prefixo da chave de API.

## Alternativas
- **Schema por tenant:** dá isolamento forte, mas cria milhares de schemas, migrations
  N vezes mais lentas e pools difíceis de dimensionar.
- **Banco por tenant:** custo operacional inviável para tenants pequenos. Fica como
  opção futura para um cliente grande, porque o código não depende disso.
- **Filtro só na aplicação:** um `WHERE` esquecido vira um vazamento. Foi descartado.

## Consequências
- `tenant-isolation.test.ts` percorre a tabela de rotas (`app.routeTable`) e garante que
  toda leitura ou escrita com ids de outro tenant falha sem alterar nada.
- Índices começam por `tenant_id`. As tabelas grandes (auditoria e movimentos de estoque)
  são particionadas por data, e o job `partitions.ensure` cria as partições futuras.
- Consultas entre tenants (métricas, filas) passam por funções `SECURITY DEFINER` que
  só devolvem números agregados.
