# ADR-0008 — Esquemas zod compartilhados entre API e web

**Status:** aceito

## Contexto
As validações de CNPJ, CPF, UF, CEP, IBGE, decimais e datas precisam dar o mesmo resultado
no formulário e na API. Senão o usuário vê "ok" na tela e recebe 422 ao gravar.

## Decisão
- O pacote `@vortex/contracts` define primitivas e esquemas de entrada (pessoa, produto,
  pedido, login). A API usa esses esquemas no helper `route()`. A web usa os mesmos com
  `react-hook-form` + `zodResolver`.
- As mensagens de validação em português (`installPtBrMessages`) também ficam no pacote e são
  instaladas pela API e pela web, então o erro na tela é o mesmo que a API devolveria.
- A documentação OpenAPI é gerada a partir dos mesmos esquemas (`z.toJSONSchema`, em `/docs`).

## Consequências
- Mudar um contrato quebra o typecheck dos dois lados ao mesmo tempo.
- Regras que dependem do banco (unicidade, saldo, limite de crédito) continuam só na API.
