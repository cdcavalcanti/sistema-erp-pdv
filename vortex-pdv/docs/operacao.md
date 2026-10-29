# Manual de operação do Vortex PDV

Para operador, supervisor e gerente. Tudo funciona pelo teclado (leitor de código de barras
incluído) e também por toque.

## Atalhos (seção 41)

| Tecla | Ação | Tecla | Ação |
|---|---|---|---|
| F2 | Cliente (CPF ou cadastro rápido) | F8 | Suprimento |
| F3 | Desconto (item selecionado ou venda) | F9 | Finalizar (ir ao pagamento) |
| F4 | Cancelar item selecionado | F10 | Cancelar a venda em andamento |
| F5 | Consultar produto (nome, SKU, referência) | F11 | Minhas vendas / reimprimir |
| F6 | Quantidade (do próximo produto ou do item selecionado) | F12 | Menu |
| F7 | Sangria | ESC | Voltar / fechar a janela |
| ↑ ↓ | Selecionar item do carrinho | ENTER | Confirmar |

No Menu (F12), as opções têm teclas numéricas: 1 Vendas, 2 Devolução, 3 Fechar caixa,
4 Painel, 5 Status, 6 Sincronizar, 7 Parâmetros e 0 Sair.

## Turno

1. **Login** com usuário e PIN. Depois de 5 PINs errados, o usuário fica bloqueado por 5 minutos.
   A sessão expira por inatividade, conforme os parâmetros do ERP.
2. **Abertura do caixa** com o fundo de troco. Só existe um caixa aberto por terminal.
3. **Vendas** (abaixo).
4. **Sangria (F7)** quando a gaveta passa do limite que o ERP define (a barra avisa) e
   **suprimento (F8)** para reforçar o troco. Os dois pedem o supervisor quando o ERP exige e
   abrem a gaveta.
5. **Fechamento** (Menu → 3). O fechamento é **cego**: conte e informe o valor de cada forma
   de pagamento sem ver o esperado. O gerente autoriza. O resultado mostra, por forma, o
   esperado, o informado e a diferença (sobra ou falta). Nenhuma diferença é apagada. Ela vai
   para o ERP, que lança no financeiro e na contabilidade. Se for preciso corrigir, o gerente
   reabre o caixa, e a reabertura também fica registrada.

## Venda

- **Leitura:** passe o código. O campo aceita código de barras, SKU, referência e GTIN da
  embalagem (que entra com a quantidade da caixa). Para quantidade, use `3*código` ou F6 antes
  da leitura. Ler de novo o mesmo produto soma na linha.
- **Pesáveis:** a etiqueta da balança (EAN-13 começando com 2) já traz o preço ou o peso. Sem
  etiqueta, o PDV lê a balança do caixa e recusa o peso enquanto ele estiver instável.
- **Produto não encontrado:** aparece o aviso e a venda continua. Use F5 para procurar pelo nome.
- **Estoque:** o ERP decide se produto sem estoque só avisa ou bloqueia.
- **Desconto (F3):** em percentual ou valor, no item selecionado ou na venda. Acima da sua
  alçada, aparece a tela do supervisor, que digita o login e o PIN dele ali mesmo. Acima da
  alçada do supervisor, o desconto é negado. Tudo fica na auditoria.
- **Cliente (F2):** pelo CPF/CNPJ (do cadastro do ERP) ou por cadastro rápido. O cliente novo vai
  para o ERP pela fila. Acima do valor definido pelo ERP, a NFC-e exige o consumidor identificado.
- **Cancelar item (F4):** selecione o item (↑ ↓ ou toque) e escolha o motivo. O item fica riscado
  como CANCELADO e sai do total.
- **Cancelar a venda (F10):** pede o motivo. Uma venda em andamento é descartada e fica registrada.

## Pagamento (F9)

| Forma | Como funciona |
|---|---|
| Dinheiro | Digite o valor recebido. O troco aparece na hora e a gaveta abre no fim |
| Pix | O QR Code aparece na tela. **A venda só conclui quando o banco confirma.** Mostrar o QR não confirma nada. A cobrança expira no tempo definido pelo ERP. Dá para cancelar e gerar outra |
| Débito / Crédito (TEF) | O cliente usa o pinpad. Recusa, cancelamento no pinpad e falta de resposta aparecem com o motivo, e a venda continua em aberto para outra forma. O crédito permite parcelar até o máximo do ERP, respeitando a parcela mínima |
| Débito / Crédito (maquininha) | Passe na maquininha avulsa e digite o NSU e a autorização impressos no comprovante dela |
| Várias formas | Pague parte em uma forma e o restante em outra. O PDV mostra o que falta e conclui quando o total fecha |

Nenhum dado do cartão é digitado ou guardado no PDV. Um duplo clique em "Receber" não cobra duas vezes.

Ao concluir, a NFC-e é emitida e o comprovante é impresso com o QR Code. Sem papel, a venda não
se perde: troque o papel e reimprima em F11 (a reimpressão pede o supervisor e é auditada).

## Depois da venda

- **Minhas vendas (F11):** número, total, situação da NFC-e e se já chegou ao ERP ("no ERP" ou
  "na fila"). O gerente vê as vendas de todos.
- **Cancelar uma venda concluída:** dentro do prazo do ERP para a NFC-e, com o supervisor. A NFC-e
  é cancelada na SEFAZ, o Pix e o TEF são estornados e o ERP desfaz estoque, financeiro e
  contabilidade. Fora do prazo, use devolução.
- **Devolução** (Menu → 2): informe a venda, os itens e as quantidades (no máximo o que foi
  vendido), o motivo e os dados do cliente. O supervisor autoriza. O ERP emite a nota de entrada,
  devolve o estoque e registra o reembolso.

## Quando algo cai

| Situação | O que acontece | O que fazer |
|---|---|---|
| Internet ou ERP fora do ar | A barra mostra **Offline** e a quantidade de pendentes. A venda segue normalmente e fica na fila | Nada. Ao voltar, a fila envia na ordem e sem duplicar. O ERP limita quantas horas o caixa pode vender offline |
| SEFAZ fora do ar | A NFC-e sai em **contingência offline** (o comprovante indica) e é transmitida quando a SEFAZ volta | Nada, se o ERP permite contingência. Acompanhe na tela de status |
| NFC-e rejeitada | A venda fica registrada como rejeitada e não vai ao ERP | Corrija o cadastro no ERP (por exemplo, o NCM do produto) e reprocesse em Minhas vendas, com o mesmo número |
| Falta de energia ou travamento | Ao voltar, o PDV oferece **continuar a venda** que estava aberta, consulta o pagamento e a NFC-e pendentes antes de repetir qualquer coisa | Fazer o login e escolher continuar ou descartar |
| Impressora sem papel | A venda conclui e o aviso aparece | Trocar o papel e reimprimir (F11) |
| Atualização do sistema | O caixa termina a venda atual e então mostra "Atualização em andamento" | Aguardar o reinício (não acontece no meio de uma venda) |

**Tela de status** (Menu → 5): mostra ERP, fiscal, pagamento, impressora, banco local e balança,
além da fila (pendentes e com falha). Os botões **Sincronizar agora** e **Reenviar falhas**
ficam ali. Quando há integrações simuladas, elas aparecem listadas numa caixa amarela "homologação".

## Painel do gerente (Menu → 4)

Vendas do dia, total, ticket médio, caixa aberto e operadores do terminal. Com o ERP online,
mostra também os números da loja inteira (todos os terminais).
