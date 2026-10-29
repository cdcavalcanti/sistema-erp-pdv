#!/usr/bin/env bash
# Gera o pacote do terminal: agente compilado + dependências de produção + interface.
#   infra/release.sh [versão]   →   dist-pdv/vortex-pdv-<versão>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-$(node -p "require('./apps/pdv/package.json').version")}"
OUT="dist-pdv/vortex-pdv-$VERSION"
rm -rf "$OUT" && mkdir -p dist-pdv
pnpm --filter "./packages/*" build
pnpm --filter @vortex/pdv build
pnpm --filter @vortex/pdv-web build
pnpm --filter @vortex/pdv deploy --prod --legacy "$OUT" >/dev/null
cp -r apps/pdv-web/dist "$OUT/ui"
cp infra/vortex-pdv.service infra/install.sh infra/update.sh "$OUT/"
echo "$VERSION" > "$OUT/VERSION"
tar -C dist-pdv -czf "$OUT.tar.gz" "vortex-pdv-$VERSION"
echo "✓ $OUT.tar.gz"
