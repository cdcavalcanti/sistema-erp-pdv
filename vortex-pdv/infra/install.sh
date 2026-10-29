#!/usr/bin/env bash
# Instala o agente do PDV num terminal Linux (Debian/Ubuntu) com systemd e Node 22.
# Rode de dentro do pacote extraído (vortex-pdv-<versão>/), como root:
#
#   sudo ./install.sh --erp https://erp.suaempresa.com.br --store <id do estabelecimento> \
#        --terminal 03 [--key vx_...] [--csc-id 000001 --csc <CSC>] [--homologacao]
#
# Sem --key, pareie depois (docs/instalacao.md). A chave do terminal vem do ERP (POST /v1/pdv/terminals ou /rotate-key) e é mostrada uma
# única vez: ela vai só para /etc/vortex-pdv/pdv.env (0600) e nunca para o repositório.
set -euo pipefail
ERP= STORE= TERMINAL= KEY= CSC_ID=000001 CSC= AMBIENTE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --erp) ERP="$2"; shift 2 ;;
    --store) STORE="$2"; shift 2 ;;
    --terminal) TERMINAL="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --csc-id) CSC_ID="$2"; shift 2 ;;
    --csc) CSC="$2"; shift 2 ;;
    --homologacao) AMBIENTE=2; shift ;;
    *) echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "Rode como root (sudo)" >&2; exit 1; }
[ -n "$ERP" ] && [ -n "$STORE" ] && [ -n "$TERMINAL" ] || { sed -n 2,10p "$0"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node 22+ é necessário" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION")"
id vortex-pdv >/dev/null 2>&1 || useradd --system --home /var/lib/vortex-pdv --shell /usr/sbin/nologin vortex-pdv
install -d -o vortex-pdv -g vortex-pdv -m 0750 /var/lib/vortex-pdv /var/lib/vortex-pdv/data
install -d -m 0755 /opt/vortex-pdv/releases
rm -rf "/opt/vortex-pdv/releases/$VERSION" && cp -r "$SRC" "/opt/vortex-pdv/releases/$VERSION"
ln -sfn "/opt/vortex-pdv/releases/$VERSION" /opt/vortex-pdv/current

install -d -m 0750 /etc/vortex-pdv
if [ ! -f /etc/vortex-pdv/pdv.env ]; then
  umask 077
  cat > /etc/vortex-pdv/pdv.env <<ENV
PDV_PORT=4545
PDV_HOST=127.0.0.1
PDV_DB_PATH=/var/lib/vortex-pdv/data/pdv.sqlite
PDV_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
PDV_ERP_URL=$ERP
PDV_ERP_API_KEY=$KEY
PDV_STORE_ID=$STORE
PDV_TERMINAL_CODE=$TERMINAL
PDV_APP_VERSION=$VERSION
PDV_SEFAZ_AMBIENTE=$AMBIENTE
PDV_NFCE_CSC_ID=$CSC_ID
PDV_NFCE_CSC=$CSC
# Ajuste os provedores reais antes de emitir em produção (ver .env.example e docs/instalacao.md)
PDV_FISCAL_PROVIDER=partner
PDV_FISCAL_PARTNER_URL=
PDV_FISCAL_PARTNER_TOKEN=
PDV_PIX_PROVIDER=psp
PDV_PIX_PSP_URL=
PDV_PIX_PSP_TOKEN=
PDV_TEF_PROVIDER=none
PDV_PRINTER=tcp
PDV_PRINTER_HOST=192.168.0.50
PDV_PRINTER_PORT=9100
PDV_SCALE=none
ENV
  chown root:vortex-pdv /etc/vortex-pdv/pdv.env && chmod 0640 /etc/vortex-pdv/pdv.env
  echo "→ Configuração criada em /etc/vortex-pdv/pdv.env: preencha os provedores fiscal e Pix, a impressora e a balança."
else
  sed -i "s/^PDV_APP_VERSION=.*/PDV_APP_VERSION=$VERSION/" /etc/vortex-pdv/pdv.env
fi

install -m 0644 "$SRC/vortex-pdv.service" /etc/systemd/system/vortex-pdv.service
systemctl daemon-reload
systemctl enable vortex-pdv
echo "✓ Vortex PDV $VERSION instalado. Depois de revisar /etc/vortex-pdv/pdv.env: systemctl start vortex-pdv"
echo "  Interface: http://127.0.0.1:4545 (abra no navegador do terminal em tela cheia/quiosque)"
