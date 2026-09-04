#!/usr/bin/env bash
# make_update_json.sh — Genera el update.json que consume el updater de Tauri.
#
# Uso: ./scripts/make_update_json.sh <version>
# Ejemplo: ./scripts/make_update_json.sh 3.3.0
#
# Descarga los archivos .sig del release de GitHub y construye un update.json
# con la estructura que espera tauri-plugin-updater. Guarda el resultado en
# website/update.json (deploy.sh lo copia al servidor).

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Uso: $0 <version>  (ej: $0 3.3.0)" >&2
  exit 1
fi

BASE_URL="https://b265.uverse.es/downloads"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "→ Bajando firmas (.sig) de v$VERSION desde GitHub…"
gh release download "v$VERSION" --repo 8aws/BeHEVC \
  --dir "$TMP" --pattern '*.sig'

echo "→ Construyendo update.json…"

read_sig() {
  local file="$TMP/$1"
  [[ -f "$file" ]] && cat "$file" || echo ""
}

# Tauri 2 genera: <app>.app.tar.gz.sig (macOS), <setup>.nsis.zip.sig (Windows),
# <app>.AppImage.tar.gz.sig (Linux).
SIG_MAC_ARM=$(read_sig "B265.app.tar.gz.sig")
SIG_MAC_X64=$(read_sig "B265.app.tar.gz.sig")  # mismo nombre, distinto job
SIG_WIN_X64=$(read_sig "B265_${VERSION}_x64-setup.exe.nsis.zip.sig")
SIG_WIN_ARM=$(read_sig "B265_${VERSION}_arm64-setup.exe.nsis.zip.sig")
SIG_LIN_X64=$(read_sig "B265_${VERSION}_amd64.AppImage.tar.gz.sig")
SIG_LIN_ARM=$(read_sig "B265_${VERSION}_aarch64.AppImage.tar.gz.sig")

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Leer changelog de version.json como notas del update
NOTES=$(python3 -c "
import json, sys
d = json.load(open('website/version.json'))
print(d['app']['changelog'])
" 2>/dev/null || echo "B265 $VERSION")

cat > website/update.json << EOF
{
  "version": "$VERSION",
  "notes": $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$NOTES"),
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIG_MAC_ARM",
      "url": "$BASE_URL/B265_${VERSION}_aarch64.dmg"
    },
    "darwin-x86_64": {
      "signature": "$SIG_MAC_X64",
      "url": "$BASE_URL/B265_${VERSION}_x64.dmg"
    },
    "windows-x86_64": {
      "signature": "$SIG_WIN_X64",
      "url": "$BASE_URL/B265_${VERSION}_x64-setup.exe"
    },
    "windows-aarch64": {
      "signature": "$SIG_WIN_ARM",
      "url": "$BASE_URL/B265_${VERSION}_arm64-setup.exe"
    },
    "linux-x86_64": {
      "signature": "$SIG_LIN_X64",
      "url": "$BASE_URL/B265_${VERSION}_amd64.AppImage"
    },
    "linux-aarch64": {
      "signature": "$SIG_LIN_ARM",
      "url": "$BASE_URL/B265_${VERSION}_aarch64.AppImage"
    }
  }
}
EOF

echo "✔ website/update.json generado para v$VERSION"
