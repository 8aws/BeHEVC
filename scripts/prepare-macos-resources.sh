#!/bin/bash
# prepare-macos-resources.sh
# Descarga ffmpeg/ffprobe para macOS y los firma con hardened runtime
# para que pasen la notarización de Apple.
#
# Uso:
#   ./scripts/prepare-macos-resources.sh "Developer ID Application: Tu Nombre (TEAMID)" [arm64|x86_64]
#
# Si no pasas la identidad como argumento, usa APPLE_SIGNING_IDENTITY del entorno.
# La arquitectura por defecto es la del Mac actual (arm64 en Apple Silicon).

set -e

IDENTITY="${1:-$APPLE_SIGNING_IDENTITY}"
ARCH="${2:-$(uname -m)}"   # arm64 | x86_64
RESOURCES="$(dirname "$0")/../behevc-tauri/src-tauri/resources"

# Mapear la arquitectura al esquema de martin-riedl.de (arm64 / amd64)
case "$ARCH" in
  arm64|aarch64) MR_ARCH="arm64" ;;
  x86_64|amd64)  MR_ARCH="amd64" ;;
  *) echo "❌  Arquitectura no soportada: $ARCH (usa arm64 o x86_64)"; exit 1 ;;
esac

if [ -z "$IDENTITY" ]; then
  echo "❌  Falta la identidad de firma."
  echo "    Uso: $0 \"Developer ID Application: Tu Nombre (TEAMID)\""
  echo "    O bien: export APPLE_SIGNING_IDENTITY=\"...\" antes de ejecutar."
  exit 1
fi

mkdir -p "$RESOURCES"
cd "$RESOURCES"

BASE="https://ffmpeg.martin-riedl.de/redirect/latest/macos/$MR_ARCH/release"

echo "⬇  Descargando ffmpeg ($MR_ARCH)…"
curl -fsSL -L "$BASE/ffmpeg.zip" -o ffmpeg.zip
unzip -jo ffmpeg.zip ffmpeg && rm ffmpeg.zip

echo "⬇  Descargando ffprobe ($MR_ARCH)…"
curl -fsSL -L "$BASE/ffprobe.zip" -o ffprobe.zip
unzip -jo ffprobe.zip ffprobe && rm ffprobe.zip

chmod +x ffmpeg ffprobe

# Verificar que la arquitectura del binario es la esperada
if ! file ffmpeg | grep -q "$ARCH"; then
  echo "❌  El ffmpeg descargado no es $ARCH:"; file ffmpeg; exit 1
fi

echo "✍️  Firmando ffmpeg con hardened runtime…"
codesign --force --sign "$IDENTITY" --options runtime --timestamp ffmpeg

echo "✍️  Firmando ffprobe con hardened runtime…"
codesign --force --sign "$IDENTITY" --options runtime --timestamp ffprobe

echo ""
echo "✅  Listo. Verificación:"
codesign -dv ffmpeg 2>&1 | grep -E "Authority|flags|Timestamp"
echo ""
if [ "$MR_ARCH" = "amd64" ]; then TARGET="x86_64-apple-darwin"; else TARGET="aarch64-apple-darwin"; fi
echo "Ahora puedes lanzar el build:"
echo "  cd behevc-tauri && npm run tauri build -- --target $TARGET"
