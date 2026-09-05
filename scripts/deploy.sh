#!/usr/bin/env bash
# deploy.sh — Desplegar un release de B265 al servidor web.
#
# Uso: ./scripts/deploy.sh <version> [webroot]
# Ejemplo: ./scripts/deploy.sh 3.3.0
#
# Si no se pasa webroot, se usa BEHEVC_WEBROOT del entorno o el valor por defecto.
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

WEBROOT="${2:-${BEHEVC_WEBROOT:-/Volumes/HDD-Storage/AppData/webserver/be265}}"
DOWNLOADS="$WEBROOT/downloads"

if [[ ! -d "$DOWNLOADS" ]]; then
  echo "❌ Directorio de descargas no encontrado: $DOWNLOADS" >&2
  echo "   Usa: $0 <version> <webroot>  o define BEHEVC_WEBROOT" >&2
  exit 1
fi

echo "→ Bajando assets de v$VERSION desde GitHub…"
gh release download "v$VERSION" \
  --dir "$DOWNLOADS" \
  --pattern '*.dmg' \
  --pattern '*-setup.exe' \
  --pattern '*.AppImage' \
  --pattern '*.app.tar.gz' \
  --pattern '*.AppImage.tar.gz' \
  --pattern '*.nsis.zip'

echo "→ Limpiando builds antiguas…"
# Extraer todas las versiones presentes en el directorio
declare -A versions_seen=()
for f in "$DOWNLOADS"/B265_* "$DOWNLOADS"/BeHEVC_*; do
  [[ -f "$f" ]] || continue
  fname="$(basename "$f")"
  # Formato: B265_X.Y.Z_<resto> o B265_arch.app.tar.gz (updater, sin versión en nombre)
  ver=$(echo "$fname" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  [[ -n "$ver" ]] && versions_seen["$ver"]=1
done

# Ordenar versiones de mayor a menor
sorted_versions=$(printf '%s\n' "${!versions_seen[@]}" | sort -t. -k1,1rn -k2,2rn -k3,3rn)

# Reglas: mantener las 2 más recientes + la primera de cada rama mayor (X.0.0)
keep_versions=()
count=0
declare -A major_kept=()
while IFS= read -r ver; do
  major=$(echo "$ver" | cut -d. -f1)
  if [[ $count -lt 2 ]]; then
    keep_versions+=("$ver")
    ((count++))
    major_kept["$major"]=1
  elif [[ -z "${major_kept[$major]:-}" ]]; then
    keep_versions+=("$ver")
    major_kept["$major"]=1
  fi
done <<< "$sorted_versions"

echo "   conservando: ${keep_versions[*]:-ninguna}"

for f in "$DOWNLOADS"/B265_* "$DOWNLOADS"/BeHEVC_*; do
  [[ -f "$f" ]] || continue
  fname="$(basename "$f")"
  ver=$(echo "$fname" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  # Archivos sin versión en el nombre (e.g. updater bundles): conservar si son del version actual
  if [[ -z "$ver" ]]; then
    keep=true  # los updater bundles actuales no tienen versión en el nombre, conservar
  else
    keep=false
    for kv in "${keep_versions[@]}"; do
      [[ "$ver" == "$kv" ]] && keep=true && break
    done
  fi
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
