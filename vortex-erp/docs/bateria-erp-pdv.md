# Bateria de testes integrada ERP × PDV — 28/10/2026

Objetivo: achar o que funciona mal e o que falta para o Vortex ERP e o Vortex PDV conversarem.
Ambiente: os dois projetos rodando localmente (ERP em `:3333` com o tenant `demo` e 90 dias de
dados fictícios; agente do PDV em `:4545` no terminal 03), SEFAZ, Pix e TEF simulados de homologação.

## Resultado

| Suíte | Resultado |
|---|---|
| ERP — API (unitários e integração, Postgres real) | 216 de 216 |
| ERP — web (componentes) | 10 de 10 |
| ERP — web ponta a ponta (Playwright, inclui as telas novas e a conversa com a assistente) | 6 de 6 |
| PDV — agente (unitários e integração) | 53 de 53 |
| PDV — frente de caixa (componentes) | 5 de 5 |
| PDV — ponta a ponta (Playwright, sobe o ERP vizinho) | 5 de 5 |
| **Bateria integrada ERP × PDV** (`pnpm bateria` no vortex-pdv) | **30 de 30** + offline 3 de 3 |

O que a bateria integrada faz, com venda de verdade no agente e conferência no ERP:

1. Carga completa: produtos e operadores novos do ERP chegam ao PDV; nenhum produto duplicado.
2. Abertura de caixa chega ao ERP.
3. Venda com cancelamento parcial de item (2 de 3): total, operador, item cancelado com motivo,
   NFC-e autorizada e baixa de estoque só do que foi vendido.
4. Venda com CPF de cliente já cadastrado: chega ligada à pessoa.
5. Cancelamento de venda concluída: chega ao ERP e o estoque volta.
6. Devolução: chega ao ERP e o estoque volta.
7. Preço alterado e produto novo no ERP aparecem no PDV no "Sincronizar agora".
8. Produto sem estoque no ERP: o PDV avisa ao vender.
9. Cliente cadastrado no caixa vira pessoa no ERP, e a venda chega ligada a ele.
10. Sangria e fechamento cego chegam com esperado, contado e diferença.
11. Monitoramento: o ERP vê o terminal online, a versão e as pendências; a auditoria do PDV chega.
12. Painel do dono e resumo da Loja física somam as vendas do caixa.
13. Offline: com o ERP parado a venda conclui e fica na fila; ao voltar, chega uma vez só e a fila zera.

## Problemas encontrados e corrigidos

| # | Problema | Efeito | Correção |
|---|---|---|---|
| 1 | **PDV guardava o catálogo do ERP anterior.** Ao trocar ou recriar o ERP (ex.: do zip antigo para o projeto separado), os produtos velhos ficavam ativos ao lado dos novos (dois `CAFE-500`). | A venda podia usar o produto velho e o ERP recusava com "Produto não encontrado", **para sempre**. Causa mais provável do "fiz dois testes e não chegou no ERP". | Carga completa inativa o que não existe mais no ERP; o agente detecta troca de loja/ERP, recarrega tudo, tira os clientes do ERP anterior e arquiva o que não pode mais ser enviado (com motivo). A atualização força uma carga completa uma vez. O PDV não vende produto inativo. |
| 2 | Envio recusado em definitivo ficava como alerta eterno. | "1 envio não aceito" na tela sem ter o que fazer. | Em Status, o gerente pode **arquivar** o envio com motivo (fica no histórico e na auditoria). |
| 3 | **ERP recusava venda do PDV sem saldo** ("Saldo insuficiente"), mesmo com a NFC-e já autorizada na SEFAZ. | Venda que aconteceu de verdade não entrava no ERP. | O ERP aceita a saída (o saldo fica negativo) e o painel do dono mostra "Produtos com estoque negativo" para regularizar. |
| 4 | Produto sem nenhuma entrada no ERP aparecia como "disponível" no PDV. | Nenhum aviso ao vender algo que não existe no estoque. | Sem saldo no ERP conta como zero; o PDV avisa (política padrão "avisar"; dá para "bloquear" nos parâmetros da loja). |
| 5 | **Cliente cadastrado no caixa era recusado pelo ERP** (o ERP exige endereço fiscal). | A venda chegava sem cliente, mesmo com CPF na nota. | O PDV envia o endereço da loja (como o ERP já faz na devolução), e o ERP cria o consumidor pelo CPF se a venda chegar antes do cadastro. |
| 6 | Preço e produto novo só chegavam ao PDV a cada 5 minutos, e "Sincronizar agora" não buscava. | Preço desatualizado no caixa. | "Sincronizar agora" busca na hora; a busca automática passou a 1 minuto (`PDV_PULL_INTERVAL_MS`). |
| 7 | Apuração de impostos: valor por CFOP e por UF somava o item uma vez para cada tributo. | Valores de 5 a 7 vezes maiores na tela de Impostos. | Corrigido, com teste de regressão. |

## O que ainda falta (não corrigido nesta rodada)

- **ERP → PDV sem empurrar alterações.** O ERP na nuvem não alcança o agente na rede da loja,
  então o PDV busca as alterações a cada 1 minuto (ou no "Sincronizar agora"). Para ser
  instantâneo, falta um canal do ERP para o agente (conexão aberta pelo agente, SSE/WebSocket).
- **Produto com lote (FEFO) sem lote no ERP** ainda pode recusar a venda do PDV, pelo mesmo motivo
  do item 3. Só afeta produtos com controle de lote.
- **Venda arquivada no PDV existe na SEFAZ, mas não no ERP.** Arquivar resolve a fila, mas o
  contador precisa lançar ou cancelar essa NFC-e. Na prática: não recriar o ERP com caixas em
  operação, e fechar e sincronizar o caixa antes de mudar o terminal de loja.
- **Cancelamento de item sem supervisor por padrão.** O parâmetro da loja
  `itemCancelRequiresAuthorization` vem desligado; recomendamos ligar em produção.
- **Dois caixas e a última unidade.** Cada terminal só vê a venda do outro depois da sincronização
  (até cerca de 1 minuto), e os dois podem vender a mesma última unidade. Com a correção 3, o ERP
  aceita e mostra o estoque negativo para regularizar.
- **Ao recriar o banco do ERP (`db:reset`)**, a chave do terminal muda. Gere outra com
  `SEED_PDV_ENV=../vortex-pdv/apps/pdv/.env pnpm db:seed` e reinicie o agente.

## Como repetir

```bash
# vortex-erp
pnpm db:reset && SEED_PDV_ENV=../vortex-pdv/apps/pdv/.env pnpm db:seed
pnpm dev:api
# vortex-pdv
pnpm dev            # agente :4545
pnpm bateria        # cenários com o ERP no ar
# offline: pare o ERP e rode
OFFLINE_READY=1 node scripts/bateria-integrada.mjs offline
# suba o ERP de novo e rode, com o número de venda que foi impresso
OFFLINE_SALE=PDV-03-AAAAMMDD-000NNN node scripts/bateria-integrada.mjs offline_back
```
