#!/usr/bin/env bash
# Atualização controlada (seção 51): nunca no meio de uma venda. Rode de dentro do pacote novo:
#   sudo ./update.sh [--wait 600]
# 1) pede a atualização ao agente e espera não haver venda, pagamento nem NFC-e em andamento
#    (a partir daí o caixa não começa venda nova); 2) faz backup do banco local; 3) troca a
#    versão e reinicia. Se a versão nova não subir, volta para a anterior.
set -euo pipefail
WAIT=600
[ "${1:-}" = "--wait" ] && WAIT="$2"
[ "$(id -u)" = 0 ] || { echo "Rode como root (sudo)" >&2; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$SRC/VERSION")"
PREVIOUS="$(readlink -f /opt/vortex-pdv/current)"
set -a; . /etc/vortex-pdv/pdv.env; set +a
export NODE_ENV=production

cd /var/lib/vortex-pdv
node /opt/vortex-pdv/current/dist/src/cli/update-gate.js --version "$VERSION" --wait "$WAIT"
systemctl stop vortex-pdv
STAMP="$(date +%Y%m%d%H%M%S)"
install -d /var/lib/vortex-pdv/data/backup
for f in "$PDV_DB_PATH" "$PDV_DB_PATH-wal" "$PDV_DB_PATH-shm"; do
  [ -f "$f" ] && cp "$f" "/var/lib/vortex-pdv/data/backup/pre-update-$VERSION-$STAMP-$(basename "$f")"
done
chown -R vortex-pdv:vortex-pdv /var/lib/vortex-pdv

rm -rf "/opt/vortex-pdv/releases/$VERSION" && cp -r "$SRC" "/opt/vortex-pdv/releases/$VERSION"
ln -sfn "/opt/vortex-pdv/releases/$VERSION" /opt/vortex-pdv/current
sed -i "s/^PDV_APP_VERSION=.*/PDV_APP_VERSION=$VERSION/" /etc/vortex-pdv/pdv.env
systemctl start vortex-pdv

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PDV_PORT:-4545}/api/health" | grep -q "\"version\":\"$VERSION\""; then
    echo "✓ Vortex PDV atualizado para $VERSION"; exit 0
  fi
  sleep 1
done
echo "✗ A versão $VERSION não subiu; voltando para $(basename "$PREVIOUS")" >&2
ln -sfn "$PREVIOUS" /opt/vortex-pdv/current
sed -i "s/^PDV_APP_VERSION=.*/PDV_APP_VERSION=$(basename "$PREVIOUS")/" /etc/vortex-pdv/pdv.env
systemctl restart vortex-pdv
exit 1
