# ADR-0003 — Decimal e arredondamento centralizados

**Status:** aceito

## Contexto
Diferenças de um centavo entre itens e total da nota geram rejeição na SEFAZ e
lançamentos desbalanceados. `number` em JavaScript não representa valores monetários
com exatidão.

## Decisão
- O pacote `@vortex/money` exporta `D()` (decimal.js com 50 dígitos, `ROUND_HALF_UP`) e
  as escalas por tipo de campo (`FIELD_SCALES`: dinheiro 2, quantidade 4, preço unitário 10,
  alíquota 4). Ele é o **único** lugar que arredonda (`round`, `roundMoney`…).
- No banco, valores são `numeric(18,2)` e quantidades `numeric(18,4)`. Pela API, valores
  trafegam como string decimal (`decimal` em `@vortex/contracts`), nunca como `number`.
- Rateios (frete, desconto, impostos do cabeçalho) usam o método do maior resto, para que
  a soma das partes seja igual ao todo.

## Consequências
- Testes de propriedade em `money`, no motor e no banco garantem que as somas fecham.
- Na web, `lib/format.ts` só formata e nunca recalcula valores.
