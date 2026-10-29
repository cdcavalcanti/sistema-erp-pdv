# Instalação e implantação do Vortex PDV

## 1. Desenvolvimento (ERP e PDV na mesma máquina)

O PDV e o ERP são projetos separados. Extraia os dois lado a lado:

```
projetos/
  vortex-erp/   ERP (API em :3333 e web em :5173)
  vortex-pdv/   este projeto (agente em :4545 e frente de caixa em :5174)
```

No **vortex-erp** (veja o README dele), com o Postgres no ar:

```bash
pnpm db:seed          # tenant demo + terminal 03 e operadores do PDV; grava ../vortex-pdv/apps/pdv/.env
pnpm dev:api          # ERP em http://localhost:3333
```

No **vortex-pdv**:

```bash
pnpm install
pnpm build:packages
pnpm dev              # agente em http://127.0.0.1:4545 (carga inicial do ERP em segundos)
pnpm dev:web          # frente de caixa em http://localhost:5174
```

Operadores do tenant `demo` (login e PIN de 6 dígitos):

| Login | PIN | Papel no ERP | O que pode |
|---|---|---|---|
| `ana` | 482913 | operador_caixa | vender, abrir caixa, identificar cliente, ver as próprias vendas; desconto até 5 % |
| `sup` | 730184 | supervisor_caixa | o do operador mais autorizar desconto (até 15 %), cancelamento de item, de venda e devolução, sangria, suprimento e reimpressão |
| `ger` | 915372 | gerente | tudo do PDV, incluindo fechar e reabrir caixa, painel e parâmetros locais; desconto até 30 % |

O seed do ERP grava `apps/pdv/.env` (chave do terminal, loja e endereço do ERP) quando encontra
o vortex-pdv na pasta vizinha e o arquivo ainda não existe. Esse arquivo está no `.gitignore`.
Com o PDV em outro lugar, o seed mostra a chave e as linhas para colar. Também é possível
escolher o caminho com `SEED_PDV_ENV=/caminho/apps/pdv/.env pnpm db:seed`, o que gera uma chave nova.
Para trocar a chave depois, use `POST /v1/pdv/terminals/:id/rotate-key` e atualize `PDV_ERP_API_KEY`.

## 2. Preparar o ERP para a loja

Tudo pela API do ERP (OpenAPI em `/docs`, tag **PDV**), com um usuário que tenha
`pdv.terminal.gerenciar`:

1. **Parâmetros da loja:** `PUT /v1/pdv/settings?establishmentId=…`. Inclui a conta financeira
   do caixa e do cofre, o limite de dinheiro na gaveta, se o fechamento é cego, o comportamento
   sem estoque (`allow`/`warn`/`block`), o prazo de cancelamento da NFC-e, as horas máximas
   offline, as formas de pagamento, as parcelas, o Pix, o comprovante, as etiquetas de balança, a
   sessão e quais parâmetros o gerente pode mudar no terminal (`localOverridable`).
   O esquema completo está em `packages/contracts/src/pdv.ts` (`pdvSettingsSchema`).
2. **Operadores:** dê ao usuário o papel `operador_caixa`, `supervisor_caixa` ou `gerente`.
   Depois habilite o PDV com `PUT /v1/users/:id/pdv-operator` `{ "pdvLogin": "ana", "pin": "482913" }`.
   O PIN vai em hash (scrypt) para o terminal na próxima carga.
3. **Terminal:** `POST /v1/pdv/terminals` `{ "establishmentId": "…", "code": "03", "name": "Caixa 3" }`.
   A resposta traz a **chave de API do terminal uma única vez**. O código do terminal também é a
   série da NFC-e desse caixa.
   - Chave perdida ou exposta: `POST /v1/pdv/terminals/:id/rotate-key`. Gera outra e revoga a anterior.
   - Terminal roubado ou desativado: `POST /v1/pdv/terminals/:id/block`.

A chave só tem os escopos `pdv.sincronizacao.executar`, `cadastros.pessoa.ler` e
`cadastros.pessoa.criar`, e só vale para o estabelecimento do terminal.

## 3. Instalar no terminal (Linux com systemd)

Requisitos: Debian/Ubuntu, Node 22+ e um navegador em modo quiosque.

```bash
# na máquina de build (projeto vortex-pdv)
pnpm release 1.0.0                         # → dist-pdv/vortex-pdv-1.0.0.tar.gz

# no terminal
tar xzf vortex-pdv-1.0.0.tar.gz && cd vortex-pdv-1.0.0
sudo ./install.sh --erp https://erp.suaempresa.com.br --store <id do estabelecimento> \
     --terminal 03 --key vx_... --csc-id 000001 --csc <CSC da SEFAZ>
sudo nano /etc/vortex-pdv/pdv.env          # provedor fiscal, PSP Pix, impressora e balança
sudo systemctl start vortex-pdv
chromium --kiosk http://127.0.0.1:4545     # interface servida pelo próprio agente
```

O instalador:

- cria o usuário de sistema `vortex-pdv`;
- instala em `/opt/vortex-pdv/releases/<versão>`, com o link `current`;
- cria `/var/lib/vortex-pdv` para o banco, os backups e o spool;
- gera `PDV_SECRET_KEY` aleatória em `/etc/vortex-pdv/pdv.env` (permissão 0640);
- instala a unidade `vortex-pdv.service` com `Restart=always` e o sistema de arquivos protegido.

Por padrão, o instalador configura produção (`PDV_SEFAZ_AMBIENTE=1`). Com essa configuração o
agente **recusa subir** com qualquer simulador de fiscal, Pix ou TEF. Use `--homologacao` para
instalar em ambiente de homologação.

Sem `--key`, o terminal é pareado depois. A chave fica cifrada no banco local, e não no `pdv.env`:

```bash
sudo -u vortex-pdv sh -c 'cd /var/lib/vortex-pdv && set -a && . /etc/vortex-pdv/pdv.env && NODE_ENV=production \
  node /opt/vortex-pdv/current/dist/src/cli/pair.js --key vx_... --store <id do estabelecimento>'
```

## 4. Atualizar (seção 51)

```bash
tar xzf vortex-pdv-1.1.0.tar.gz && cd vortex-pdv-1.1.0 && sudo ./update.sh --wait 600
```

1. `update-gate` pede a atualização ao agente e espera até não haver venda, pagamento ou NFC-e
   em andamento. A partir daí, nenhuma venda nova começa (o caixa mostra "Atualização em andamento").
   Se a janela não abrir no tempo dado, o pedido é retirado e nada muda.
2. O serviço para e o banco local é copiado para `data/backup/pre-update-…`.
3. O link `current` passa para a versão nova e o serviço sobe. As migrations do banco local são
   aplicadas na subida.
4. Se `/api/health` não responder com a versão nova em 30 s, o script volta para a versão
   anterior e reinicia.

## 5. Backup (seção 52)

- O agente faz uma cópia consistente do banco (`VACUUM INTO`) a cada hora em
  `/var/lib/vortex-pdv/data/backup` e guarda as 48 últimas. O gerente pode pedir uma cópia na hora
  pela API local (`POST /api/system/backup`). A lista fica em `GET /api/system/backups`.
- O que já sincronizou também está no ERP. O backup local protege o que ainda está na fila.
  Antes de trocar um terminal, veja na tela de status se a fila está zerada.
- Para restaurar: pare o serviço, copie o backup para `PDV_DB_PATH` (apagando `-wal` e `-shm`) e
  suba de novo. A sincronização é idempotente, então o que já foi enviado não duplica.

## 6. Periféricos

| Periférico | Configuração |
|---|---|
| Leitor de código de barras | Modo teclado (HID) com sufixo Enter. Nada a configurar no agente |
| Impressora térmica ESC/POS | Rede: `PDV_PRINTER=tcp`, `PDV_PRINTER_HOST`, `PDV_PRINTER_PORT=9100`. O status de papel vem por DLE EOT. Largura do papel em `receipt.columns` (32, 42 ou 48) |
| Gaveta | Ligada na impressora (RJ11). Abre pelo pulso ESC/POS ao receber em dinheiro, na sangria e no suprimento |
| Balança Toledo (Prix e compatíveis) | `PDV_SCALE=tcp`, `PDV_SCALE_HOST` e `PDV_SCALE_PORT`. Use um conversor serial-Ethernet ou exponha a serial local com o **ser2net**: `4001:raw:0:/dev/ttyUSB0:9600 8DATABITS NONE 1STOPBIT`, com `PDV_SCALE_HOST=127.0.0.1` e `PDV_SCALE_PORT=4001` |
| Etiquetas de balança (EAN-13 com prefixo 2) | Nos parâmetros do ERP: `scale.prefixes`, `scale.pluDigits` e `scale.valueKind` (`price` ou `weight`). O código do produto na etiqueta é o SKU sem zeros à esquerda |
| Cartão | Sem TEF integrado (`PDV_TEF_PROVIDER=none`), o operador usa "Débito/Crédito (maquininha)" e digita NSU e autorização do comprovante. Um TEF real (SiTef, PayGo…) entra como outra implementação de `PaymentProvider` (`apps/pdv/src/payment/providers.ts`) |
| Pix | `PDV_PIX_PROVIDER=psp` com a API Pix do Bacen no PSP da loja (`PDV_PIX_PSP_URL` e `PDV_PIX_PSP_TOKEN`). A cobrança é `/cob`, e a confirmação vem da consulta da cobrança, nunca da exibição do QR |
| NFC-e | `PDV_FISCAL_PROVIDER=partner` com o parceiro emissor (o mesmo modelo do ERP, ADR-0006 do vortex-erp). O parceiro assina o XML com o certificado da loja. O CSC fica em `PDV_NFCE_CSC_ID` e `PDV_NFCE_CSC` |

## 7. Monitoramento (seção 50)

- Cada terminal manda heartbeat ao ERP (`PDV_HEARTBEAT_MS`) com a versão, a fila, as vendas
  pendentes, os erros e a saúde de cada serviço. A lista com situação online/offline fica em
  `GET /v1/pdv/terminals` no ERP.
- A auditoria dos terminais chega em lote em `/v1/pdv/events` e é consultada com `GET /v1/pdv/events`.
- No terminal, os logs vão para o journal em JSON: `journalctl -u vortex-pdv -f`.
- Webhooks do ERP para o terminal (`POST /webhooks/erp`, assinados com `PDV_WEBHOOK_SECRET`)
  pedem carga imediata. O agente só escuta em 127.0.0.1. Para recebê-los, publique **apenas**
  essa rota por um proxy reverso na rede da loja. Sem webhook, a carga periódica
  (`PDV_SYNC_INTERVAL_MS`) traz as mudanças.
