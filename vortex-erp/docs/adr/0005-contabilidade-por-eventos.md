# ADR-0005 — Contabilidade por eventos, com partidas dobradas garantidas pelo banco

**Status:** aceito

## Contexto
O contador precisa de livros consistentes com as operações (RN-CTB-01 a 05), e o
usuário de PME não lança contabilidade.

## Decisão
- Cada fato de negócio (venda faturada, recebimento, compra, folha, serviço tomado…)
  chama `postEvent` com valores nomeados. A regra de contabilização do tenant
  (`accounting.posting_rules`, editável e especializável por operação, filial e categoria)
  transforma esses valores em linhas. As regras padrão estão em `DEFAULT_POSTING_RULES`.
- Débitos = créditos é verificado na aplicação e de novo no banco, por uma constraint
  trigger `DEFERRABLE INITIALLY DEFERRED`, no commit.
- Lançamentos são imutáveis. Correção é por estorno (`reverseEntries`). Período fechado é
  travado por trigger em todas as tabelas com data contábil.

## Consequências
- `properties.test.ts` gera sequências aleatórias de eventos e estornos e verifica que o
  livro fecha e que cada origem estornada zera em todas as contas. Também verifica que o
  banco recusa um lançamento desbalanceado gravado por fora da aplicação.
- Mudar uma regra de contabilização só afeta lançamentos futuros.
