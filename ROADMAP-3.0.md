# BeHEVC 3.0 — Roadmap

Tema central: **recompresión inteligente de archivos que ya son HEVC**, con precálculo
de calidad/tamaño para que el usuario decida si merece la pena recodificar.

Estado: ☐ pendiente · ◐ en curso · ☑ hecho.

> **Principio de diseño:** recomprimir HEVC→HEVC tiene pérdida generacional. La app no
> debe "recomprimir por recomprimir": debe **estimar ahorro y calidad** y recomendar solo
> cuando compense. El comportamiento actual (saltar los HEVC) sigue siendo el predeterminado.

---

## Fase 1 — Métricas de origen en el análisis (instantáneo)

Ampliar el escaneo (`detector.rs` / `scan_files`) para extraer de ffprobe, en la misma
pasada, datos del stream de vídeo: `bit_rate` (o `format.bit_rate`), `width`, `height`,
`r_frame_rate`, `pix_fmt`, `duration`, y el `tag`/encoder si está disponible.

- ☐ Calcular **BPP** (bits por píxel por frame) = `bitrate / (width·height·fps)`.
- ☐ Clasificar margen de recompresión por BPP (umbral orientativo para HEVC):
  - BPP ≳ 0.10 → **margen alto** (probable hardware-encode o bitrate excesivo)
  - 0.05–0.10 → **margen medio**
  - < 0.05 → **margen bajo** (ya eficiente)
- ☐ Añadir estos campos a `FileInfo` y enviarlos al frontend.
- ☐ Coste: cero (ffprobe ya se ejecuta). Solo lectura de metadatos.

## Fase 2 — Modo "Optimizar HEVC existentes" (UI/flujo)

- ☐ Toggle **apagado por defecto**. Con él, los HEVC dejan de saltarse y pasan a candidatos.
- ☐ En la lista, mostrar la etiqueta de margen (alto/medio/bajo) en los HEVC candidatos.
- ☐ Selección por archivo: el usuario decide cuáles entran al precálculo / recompresión.
- ☐ Persistir el toggle (localStorage, como el resto de ajustes).
- ☐ i18n ES/EN de todas las cadenas nuevas.

## Fase 3 — Precálculo por muestreo (tamaño estimado)

Command nuevo (p. ej. `estimate_savings`) que para cada archivo:

- ☐ Toma **N=3 muestras** de ~4 s en posiciones 10% / 50% / 90% de la duración
  (`ffmpeg -ss <pos> -t 4 -i in … out_muestra`), con los **ajustes objetivo** (CRF/preset/encoder).
- ☐ Suma bytes de las muestras y **extrapola**: `est_total = (bytes_muestras / seg_muestreados) · duración_total`.
- ☐ `ahorro% = 1 − est_total / tamaño_original`.
- ☐ Corre en el **pool en paralelo** ya existente; emite progreso por archivo.
- ☐ Limpieza de los temporales de muestra.
- ☐ Exactitud esperada ±10–15% (variación entre escenas) → etiquetar como *estimación*.

## Fase 4 — Calidad real con VMAF

- ☐ Detección runtime de `libvmaf` (como `list_hw_encoders`): `ffmpeg -filters | grep libvmaf`.
  Si no está, se omite la columna de calidad (degradación elegante).
- ☐ Por cada muestra, calcular **VMAF** del trozo recomprimido vs el trozo original
  (`-lavfi "[0:v][1:v]libvmaf"`), promediar.
- ☐ Mostrar el VMAF medio junto al ahorro.
- ☐ (Opcional) modo "rápido" sin VMAF para ir más ligero.

## Fase 5 — Veredicto y presentación

- ☐ Columnas nuevas: *Tamaño est.* · *Ahorro* · *VMAF* · *Veredicto*.
- ☐ Chip de veredicto automático:
  - **Recomendado**: ahorro ≥ 15% y VMAF ≥ 93.
  - **Marginal**: ahorro 10–15% o VMAF 90–93.
  - **No merece la pena**: ahorro < 10%.
  - **⚠ Pérdida notable**: VMAF < 90.
- ☐ Umbrales configurables (avanzado).
- ☐ Resumen de lote: "Recomprimibles: 12 · ahorro potencial estimado: 8,4 GB".

## Fase 6 — Recompresión segura

- ☐ Recodificar solo los archivos elegidos, reusando toda la maquinaria 2.0
  (paralelo, pausa, backup, validación, métricas reales).
- ☐ **Preservar 10-bit / HDR**: mantener `pix_fmt` y metadatos de color
  (`-pix_fmt`, transfer/primaries/matrix, `-color_*`) — crítico en HEVC HDR.
- ☐ Validación reforzada: si el resultado real es mayor que el original, descartarlo
  y conservar el original (nunca empeorar).
- ☐ Aviso claro de pérdida generacional antes de recomprimir en lote.

## Fase 7 — Calidad (tests)

- ☐ Tests de cálculo de BPP y clasificación de margen.
- ☐ Tests de extrapolación de tamaño (con datos sintéticos).
- ☐ Test de parseo de la salida de VMAF.
- ☐ Tests de los umbrales de veredicto.

---

### Notas técnicas
- Señal principal de "sobre-codificado": **BPP alto** y/o encoder de hardware
  (VideoToolbox/NVENC generan HEVC 2-3× más pesado que x265 a igual VMAF).
- El precálculo por muestreo es la única forma fiable de estimar tamaño sin codificar
  entero; VMAF es la única forma de cuantificar la pérdida. Ambos ya soportados por el
  ffmpeg incluido (libx265 + libvmaf verificados).
- Riesgo a vigilar: coste de tiempo del muestreo en lotes grandes → ejecutarlo bajo
  demanda y en paralelo, nunca en el escaneo inicial.

### Decisión de alcance (sesión 2026-06-15)
Elegido: **diseñar el plan ahora** (esta es la salida), implementación para la 3.0.
Alcance objetivo cuando se retome: **dos niveles con VMAF** (triaje instantáneo +
precálculo por muestreo con tamaño y calidad reales).

---

## Funciones adicionales acordadas para la 3.0+ (registro, NO implementar aún)

Acordadas el 2026-06-15. Quedan apuntadas para retomar más adelante; nada de código por ahora.

> **AV1: DESCARTADO.** Probado, la reproducción no es fluida por falta de potencia en los
> equipos de reproducción. **Se mantiene H265 hasta nuevo aviso.** No proponer AV1 de nuevo
> salvo que el usuario lo reabra.

### Núcleo recomendado (mayor valor, reusa muestreo/VMAF)
- ☐ ⭐ **Calidad objetivo por VMAF**: elegir "VMAF ≥ N" en vez de CRF; la app busca el CRF
  que lo cumple por búsqueda binaria sobre muestras.
- ☐ ⭐ **Reescalado opcional** (4K→1080p, etc.) con presets y `zscale` consciente de HDR/color.
- ☐ ⭐ **Carpeta vigilada (watch folder)**: auto-convertir lo que llegue a una carpeta (ideal NAS).
- ☐ ⭐ **Perfiles guardados**: ajustes con nombre ("Plex 1080p", "Archivo 4K HDR"), un clic.

### Flujo / automatización
- ☐ **Modo CLI / headless** para cron en el servidor sin abrir la ventana.
- ☐ **Cola persistente** (retomar al reabrir) + **programar** ejecución (p. ej. de madrugada).
- ☐ **Informe de biblioteca**: escanear una carpeta enorme y dar ranking de archivos más
  ineficientes/grandes + ahorro potencial total, sin convertir nada.

### Calidad / pistas
- ☐ **Selección de pistas**: elegir qué audios/subtítulos conservar por archivo.
- ☐ **Audio**: downmix 5.1→estéreo y/o recodificar a **Opus** (más eficiente que AAC).
- ☐ **Verificación VMAF post-conversión** del archivo completo, auto-conservar original si baja del umbral.

### Integración / UX
- ☐ **Auto-update real** (`tauri-plugin-updater` + `latest.json`) — requiere clave de firma de updates.
- ☐ **Acción de Finder / menú contextual** ("Convertir a HEVC" con clic derecho); equivalente en Windows.
- ☐ **Tema claro/oscuro** según el sistema (ahora solo oscuro).
- ☐ **Historial acumulado**: total ahorrado a lo largo del tiempo ("has ahorrado 240 GB").
- ☐ **Lista ordenable/filtrable** (tamaño, codec, ahorro) + **ETA total** del lote.
