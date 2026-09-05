#!/usr/bin/env bash
# deploy.sh — Desplegar un release de B265 al servidor web.
#
# Uso: ./scripts/deploy.sh <version>
# Ejemplo: ./scripts/deploy.sh 3.3.0
#
# Variables de entorno opcionales:
#   BEHEVC_SSH_HOST  — host del servidor (default: marodal@192.168.100.98)
#   BEHEVC_WEBROOT   — ruta remota del webroot (default: /vol2/apps/web/be265)
#
# Hace tres cosas:
#   1. Baja los assets del release de GitHub y los sube al servidor (rsync)
#   2. Limpia builds antiguas en el servidor (conserva las 2 últimas + primera de cada rama mayor)
#   3. Actualiza version.json, update.json e index.html en el servidor

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Uso: $0 <version>  (ej: $0 3.3.0)" >&2
  exit 1
fi

SSH_HOST="${BEHEVC_SSH_HOST:-marodal@192.168.100.98}"
WEBROOT="${BEHEVC_WEBROOT:-/vol2/apps/web/be265}"
REMOTE_DL="$WEBROOT/downloads"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOCAL_DL="$TMP/downloads"
mkdir -p "$LOCAL_DL"

echo "→ Bajando assets de v$VERSION desde GitHub…"
gh release download "v$VERSION" \
  --dir "$LOCAL_DL" \
  --pattern '*.dmg' \
  --pattern '*-setup.exe' \
  --pattern '*.AppImage' \
  --pattern '*.app.tar.gz' \
  --pattern '*.AppImage.tar.gz' \
  --pattern '*.nsis.zip'

echo "→ Subiendo assets al servidor…"
rsync -av --ignore-existing "$LOCAL_DL"/ "$SSH_HOST:$REMOTE_DL/"

echo "→ Limpiando builds antiguas en el servidor…"
# Script de limpieza ejecutado remotamente
ssh "$SSH_HOST" bash <<REMOTE
set -euo pipefail
DOWNLOADS="$REMOTE_DL"

declare -A versions_seen=()
for f in "\$DOWNLOADS"/B265_* "\$DOWNLOADS"/BeHEVC_*; do
  [[ -f "\$f" ]] || continue
  ver=\$(basename "\$f" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [[ -n "\$ver" ]] && versions_seen["\$ver"]=1
done

sorted_versions=\$(printf '%s\n' "\${!versions_seen[@]}" | sort -t. -k1,1rn -k2,2rn -k3,3rn)

keep_versions=()
count=0
declare -A major_kept=()
while IFS= read -r ver; do
  major=\$(echo "\$ver" | cut -d. -f1)
  if [[ \$count -lt 2 ]]; then
    keep_versions+=("\$ver")
    ((count++))
    major_kept["\$major"]=1
  elif [[ -z "\${major_kept[\$major]:-}" ]]; then
    keep_versions+=("\$ver")
    major_kept["\$major"]=1
  fi
done <<< "\$sorted_versions"

echo "   conservando: \${keep_versions[*]:-ninguna}"

for f in "\$DOWNLOADS"/B265_* "\$DOWNLOADS"/BeHEVC_*; do
  [[ -f "\$f" ]] || continue
  fname=\$(basename "\$f")
  ver=\$(echo "\$fname" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [[ -z "\$ver" ]]; then
    keep=true
  else
    keep=false
    for kv in "\${keep_versions[@]}"; do
      [[ "\$ver" == "\$kv" ]] && keep=true && break
    done
  fi
  if [[ "\$keep" == false ]]; then
    echo "   eliminando \$fname"
    rm "\$f"
  fi
done
REMOTE

echo "→ Generando update.json con firmas del updater…"
./scripts/make_update_json.sh "$VERSION"

echo "→ Desplegando web al servidor…"
scp website/version.json "$SSH_HOST:$WEBROOT/version.json"
scp website/index.html   "$SSH_HOST:$WEBROOT/index.html"
scp website/update.json  "$SSH_HOST:$WEBROOT/update.json"

echo "✔ Despliegue de v$VERSION completado."
