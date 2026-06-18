#!/bin/bash
# smoke-encode.sh — prueba end-to-end de la receta de conversión a HEVC.
# Genera un clip de muestra y lo convierte con los MISMOS flags que usa la app
# (libx265 software, mkv, audio copy), verificando que la salida es HEVC y no está
# truncada. Además prueba cada encoder de hardware detectado (no fatal).
#
# Uso: ./scripts/smoke-encode.sh [ruta_ffmpeg] [ruta_ffprobe]
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
FF="${1:-$DIR/behevc-tauri/src-tauri/resources/ffmpeg}"
FP="${2:-$DIR/behevc-tauri/src-tauri/resources/ffprobe}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "ffmpeg: $("$FF" -version 2>/dev/null | head -1)"

# 1) Generar clip de muestra (5s, vídeo + audio)
SRC="$TMP/src.mkv"
"$FF" -y -v error -f lavfi -i testsrc2=size=1280x720:rate=24 \
  -f lavfi -i sine=frequency=440 -t 5 -c:v libx264 -c:a aac -shortest "$SRC"

# 2) Conversión con la receta real (software libx265, mkv, audio copy)
OUT="$TMP/out.hevc.mkv"
"$FF" -y -v error -i "$SRC" \
  -map 0:v:0 -map "0:a?" -map "0:s?" -map "0:d?" \
  -map_metadata 0 -map_chapters 0 -ignore_unknown \
  -c:v libx265 -crf 28 -preset medium -tag:v hvc1 \
  -c:a copy -c:s copy -c:d copy "$OUT"

# 3) Verificar: codec hevc y duración ≥ 90% del original
CODEC=$("$FP" -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "$OUT")
DUR=$("$FP" -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
SIZE=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
[ "$CODEC" = "hevc" ] || { echo "❌ codec de salida no es hevc: $CODEC"; exit 1; }
awk "BEGIN{exit !($DUR >= 4.5)}" || { echo "❌ duración sospechosa: $DUR"; exit 1; }
[ "$SIZE" -gt 10000 ] || { echo "❌ salida demasiado pequeña: $SIZE B"; exit 1; }
echo "✔ software libx265 → hevc OK (dur ${DUR}s, ${SIZE} B)"

# 4) Probar encoders de hardware detectados (informativo, no fatal)
for enc in hevc_videotoolbox hevc_nvenc hevc_qsv hevc_amf hevc_vaapi; do
  if "$FF" -hide_banner -encoders 2>/dev/null | grep -q "$enc"; then
    if "$FF" -y -v error -i "$SRC" -map 0:v:0 -an -c:v "$enc" -t 2 -f null - 2>/dev/null; then
      echo "✔ hardware $enc OK"
    else
      echo "⚠ hardware $enc presente pero no codifica aquí (driver/GPU/entorno)"
    fi
  fi
done

echo "✅ smoke-encode completado"
