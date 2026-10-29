# Homologação e integrações simuladas

A especificação pede que mocks fiquem "claramente identificados" (seção 57). No PDV, cada
integração externa tem uma implementação real e uma simulada, atrás da mesma interface. Os
simuladores:

- são o padrão em desenvolvimento e teste, e aparecem na barra de status ("Homologação") e na
  tela de status, com o nome de cada um numa caixa amarela;
- **não sobem em produção com emissão real** (`NODE_ENV=production` e `PDV_SEFAZ_AMBIENTE=1`):
  o agente se recusa a iniciar com fiscal, Pix ou TEF simulados (`apps/pdv/src/config.ts`, testado
  em `config.test.ts`);
- têm comandos de teste (`/api/dev/*`) que só existem fora de produção.

## O que é simulado e como provocar cada cenário

| Integração | Simulador (`apps/pdv/src/…`) | Real | Cenários |
|---|---|---|---|
| SEFAZ / NFC-e | `SimulatedSefaz` (`fiscal/providers.ts`) | `PartnerFiscalProvider` (`PDV_FISCAL_PROVIDER=partner`) | Autoriza com protocolo. Produto com **NCM 99999999** é rejeitado (778). Descrição com **REJEITAR** é rejeitada (999). **SEFAZ fora do ar**: botão na tela de status ou `POST /api/dev/sefaz {"online":false}`, e a NFC-e sai em contingência offline |
| Pix | `SimulatedPixPsp` (`payment/providers.ts`) | `ApiPixProvider` (`PDV_PIX_PROVIDER=psp`, API Pix do Bacen) | Gera BR Code EMV válido (CRC16). Só aprova quando o "pagador" paga: botão **Simular pagamento do cliente (homologação)** ou `POST /api/dev/pix/:txid/pay`. Sem pagamento, expira no tempo do ERP |
| TEF (pinpad) | `SimulatedTef` (`payment/providers.ts`) | Nenhum TEF integrado nesta versão. `PDV_TEF_PROVIDER=none` desliga e o cartão vai pela maquininha | Pelos centavos do valor: **,51** recusa, **,52** sem resposta (timeout após 90 s), **,53** cancelado no pinpad. Qualquer outro valor aprova, com NSU, autorização e bandeira |
| Impressora | `FilePrinter` (`printer/drivers.ts`), que grava o ESC/POS e o texto em `PDV_PRINTER_SPOOL` | `TcpPrinter` (`PDV_PRINTER=tcp`) | **Impressora sem papel**: botão na tela de status ou `POST /api/dev/printer {"status":"paper_out"}` (também `paper_low` e `offline`) |
| Balança | `SimulatedScale` (`hardware/devices.ts`) | `TcpToledoScale` (`PDV_SCALE=tcp`) | Botão **Balança 0,500 kg** ou `POST /api/dev/scale {"weight":"0.500","stable":true}`. Com `stable:false`, o peso é recusado |

A maquininha avulsa (`ExternalPosProvider`) e o dinheiro não são simulações: o operador confirma
com o comprovante da maquininha ou recebendo o dinheiro.

No ERP, o gateway fiscal e o bancário também começam em `simulated` (ADR-0006 do vortex-erp).
O teste de aceite e o e2e usam esses simuladores dos dois lados, com o ERP (projeto vortex-erp) e o Postgres reais.

## Roteiro de homologação com provedores reais

Use `PDV_SEFAZ_AMBIENTE=2` (homologação), o parceiro emissor de homologação, o CSC de homologação
da UF e o sandbox do PSP Pix. Registre a data, a UF, a versão e os protocolos.

| # | Fluxo | Como verificar | ☐ |
|---|---|---|---|
| 1 | Venda em dinheiro com troco | NFC-e `autorizada`, QR Code abre a consulta pública da UF, gaveta abre | ☐ |
| 2 | Venda com consumidor identificado (CPF) | CPF no XML e no comprovante | ☐ |
| 3 | Pix real no sandbox do PSP | Só conclui após o pagamento no app/sandbox; QR expirado não conclui | ☐ |
| 4 | Pagamento múltiplo (dinheiro + Pix + maquininha) | `tPag` de cada forma no XML; total fecha | ☐ |
| 5 | Cancelamento dentro do prazo | Evento 110111 homologado; ERP estorna estoque e financeiro | ☐ |
| 6 | Rejeição (produto com NCM inválido no ERP) | Corrigir no ERP e reprocessar com o mesmo número | ☐ |
| 7 | Contingência offline (desligue a rede da SEFAZ) | Emitida com tpEmis 9 e transmitida depois (até 24 h) | ☐ |
| 8 | Queda de energia no meio do pagamento | Ao voltar, o pagamento é consultado e a NFC-e não duplica | ☐ |
| 9 | Internet fora por 1 h vendendo | Fila zera ao voltar; ERP sem duplicidade (`/v1/pdv/sync/status`) | ☐ |
| 10 | Fechamento com diferença | Diferença no financeiro e no contábil do ERP | ☐ |
| 11 | Impressora real: sem papel, QR legível, corte e gaveta | Venda não se perde; reimpressão auditada | ☐ |
| 12 | Balança real: peso estável e instável; etiqueta com preço e com peso | Quantidade e valor corretos | ☐ |
| 13 | Atualização com venda aberta (`update.sh`) | Espera a venda terminar; volta à versão anterior se falhar | ☐ |
| 14 | Dois terminais na mesma loja | Séries diferentes; painel da loja soma os dois | ☐ |
