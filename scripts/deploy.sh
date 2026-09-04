#!/usr/bin/env bash
# deploy.sh — Desplegar un release de B265 al servidor web.
#
# Uso: ./scripts/deploy.sh <version>
# Ejemplo: ./scripts/deploy.sh 3.3.0
#
# Hace tres cosas:
#   1. Baja los assets del release de GitHub al directorio de descargas
#   2. Limpia builds antiguas (conserva las 2 últimas + la primera de cada rama mayor)
#   3. Actualiza version.json, update.json e index.html en el servidor

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Uso: $0 <version>  (ej: $0 3.3.0)" >&2
  exit 1
fi

WEBROOT="/Volumes/HDD-Storage/AppData/webserver/be265"
DOWNLOADS="$WEBROOT/downloads"

echo "→ Bajando assets de v$VERSION desde GitHub…"
gh release download "v$VERSION" \
  --dir "$DOWNLOADS" \
  --pattern '*.dmg' \
  --pattern '*-setup.exe' \
  --pattern '*.AppImage'

echo "→ Limpiando builds antiguas (conservar 2 últimas + primeras de cada rama mayor)…"
# Mantener siempre: las 2 versiones más recientes de cada plataforma,
# y la primera versión de cada rama mayor (2.x, 3.x…) como referencia histórica.
# El resto se elimina para recuperar espacio.
keep_patterns=(
  "B265_${VERSION}_"         # la nueva
  "B265_3.1.0_"              # anterior inmediata (penúltima)
  "B265_3.0.0_"              # primera de rama 3.x
  "B265_2.0.0_"              # primera de rama 2.x (referencia histórica)
)
for f in "$DOWNLOADS"/B265_* "$DOWNLOADS"/BeHEVC_*; do
  [[ -f "$f" ]] || continue
  fname="$(basename "$f")"
  keep=false
  for pat in "${keep_patterns[@]}"; do
    [[ "$fname" == $pat* ]] && keep=true && break
  done
  if [[ "$keep" == false ]]; then
    echo "   eliminando $fname"
    rm "$f"
  fi
done

echo "→ Generando update.json con firmas del updater…"
./scripts/make_update_json.sh "$VERSION"

echo "→ Desplegando web…"
cp website/version.json "$WEBROOT/version.json"
cp website/index.html   "$WEBROOT/index.html"
cp website/update.json  "$WEBROOT/update.json"

echo "✔ Despliegue de v$VERSION completado."
