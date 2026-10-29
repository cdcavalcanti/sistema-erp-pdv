# ADR-0002 — Motor fiscal como biblioteca pura com testes dourados

**Status:** aceito

## Contexto
O cálculo de tributos (ICMS, ST, FCP, DIFAL, IPI, PIS/Cofins, ISS e, desde 2026, IBS/CBS)
é a parte mais arriscada do produto. Um erro gera autuação para o cliente. As regras
mudam por UF, regime, NCM, CFOP e vigência. O guia pede mais de 300 casos validados
por contador e que qualquer mudança rode todos eles.

## Decisão
- O pacote `@vortex/fiscal-engine` recebe toda a entrada já resolvida (emitente,
  destinatário, itens, regras e alíquotas vigentes) e devolve impostos por item, totais e
  memória de cálculo. Ele não faz I/O, não lê relógio e não acessa o banco.
- A API faz só a ponte (`fiscal/engine-adapter.ts`). Ela busca as regras com vigência na
  data da operação, chama o motor e grava o resultado congelado no documento.
- Os testes dourados (`golden.cases.ts`) são casos reais escritos à mão. As matrizes
  geradas (DIFAL, Simples por UF, monofásicos) completam a meta de 300+. Os testes de
  propriedade verificam que Σ itens = totais e que o rateio do cabeçalho fecha.

## Alternativas
- **Cálculo no banco (procedures):** é difícil de testar e de versionar, e fica preso ao SQL.
- **Serviço fiscal de terceiros para cálculo:** cria dependência e latência na digitação
  do pedido, e o cálculo deixa de ser auditável.

## Consequências
- O motor é determinístico (há um teste para isso) e roda inteiro em cerca de 1 s no CI.
- Uma regra fiscal nova exige um caso dourado novo, revisado pelo contador.
- O mesmo pacote pode ser usado pelo PDV, que compartilha o motor (seção 26).
