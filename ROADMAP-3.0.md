# BeHEVC 3.0 — Roadmap

Tema central: **recompresión inteligente de archivos que ya son HEVC**, con precálculo
de calidad/tamaño para que el usuario decida si merece la pena recodificar.

Estado: ☐ pendiente · ◐ en curso · ☑ hecho.

> ## Pendientes para subversiones (3.0.x / 3.1) — anotado 2026-06-18
>
> **Bugs**
> - ◐ **Cola larga colapsa** (>400 archivos, paraba a ~280): mitigado en frontend (cap del
>   log, throttle de barras ~100ms, sin reescrituras de fila redundantes). **Falta repro real**
>   de 400+ para confirmar; si persiste, sería backend (pool/cola).
>
> **UX / gestión de cola**
> - ☑ **Vaciar/purgar la cola** con botón "Vaciar lista" disponible en cualquier momento.
>
> **Rebranding**
> - ☑ **Renombrado a `B265`**: `productName`, título de ventana, UI (h1/title), web
>   (título/branding/meta/features), i18n (notif/updates). **`identifier` se mantiene en
>   `com.behevc.app`** (preserva updates/firma y los ajustes guardados del usuario).
>   El repo, el crate (`behevc`) y las URLs de GitHub siguen igual.
>   > ⚠️ **Efecto en el próximo release:** los artefactos pasarán a llamarse `B265_X.Y.Z_*`
>   > (tauri usa productName). Hay que actualizar las URLs de `website/version.json` a ese
>   > patrón AL publicar, y subir los instaladores `B265_*` al servidor.
>   > La web renombrada **no se ha desplegado aún** (la 3.0.0 live sigue siendo BeHEVC):
>   > se desplegará con el próximo release para no desencajar nombres.
>
> **Web**
> - ☑ Logo de Windows: emoji 🪟 sustituido por SVG de 4 paneles (tarjeta principal + alt).
>   *(Pendiente de desplegar con el próximo release.)*

> **Principio de diseño:** recomprimir HEVC→HEVC tiene pérdida generacional. La app no
> debe "recomprimir por recomprimir": debe **estimar ahorro y calidad** y recomendar solo
> cuando compense. El comportamiento actual (saltar los HEVC) sigue siendo el predeterminado.

---

## Fase 1 — Métricas de origen en el análisis (instantáneo)  ☑

- ☑ `detector::probe_media`: una sola llamada a ffprobe (JSON) saca codec, width, height,
  r_frame_rate, bit_rate (stream o formato), pix_fmt y duración. Sustituye a las 2 llamadas
  previas (codec + duración) en el escaneo.
- ☑ Calcular **BPP** = `bitrate / (width·height·fps)`.
- ☑ Clasificar margen (`recompress_margin`): ≥0.10 alto · 0.05–0.10 medio · <0.05 bajo.
- ☑ Campos `size`, `bitrate`, `bpp`, `margin` añadidos a `FileInfo` y enviados al frontend.
- ☑ Frontend: chip de margen (alto/medio/bajo) en los HEVC, con tooltip de BPP/bitrate.
- ☑ Tests de `parse_fps` y `recompress_margin` (16 tests verdes en total).
- Coste: cero (ffprobe ya se ejecutaba); sin cambios de comportamiento de conversión.

## Fase 2 — Modo "Optimizar HEVC existentes" (UI/flujo)  ☑

- ☑ Toggle **apagado por defecto**; al activarlo los HEVC dejan de saltarse y pasan a candidatos.
- ☑ Etiqueta de margen (chip) ya visible desde la Fase 1.
- ☑ **Selección por archivo con checkbox**: marcados por defecto los de margen alto/medio,
  desmarcados los de bajo; no-HEVC siempre marcados (deshabilitado).
- ☑ Reutiliza `needs_conversion` como bandera única de "se convertirá" (vía `applyHevcSelection`),
  así el pipeline 2.0 (jobs, stats, badges, pausa) funciona sin cambios; badge "Recomprimir".
- ☑ Persistido en localStorage; i18n ES/EN de las cadenas nuevas.

> Nota: ya se pueden recomprimir HEVC seleccionados, pero **basado solo en el margen BPP**
> (rápido pero orientativo). El tamaño/calidad estimados (Fases 3-4) y el resguardo
> "descartar si no encoge / VMAF bajo" (Fase 6) son los siguientes pasos.

## Fase 3 — Precálculo por muestreo (tamaño estimado)  ☑

- ☑ Módulo `estimator.rs` + command `estimate_savings`.
- ☑ **N=3 muestras** de ~4 s al 10/50/90% con los ajustes objetivo (reusa
  `converter::append_video_codec_args`); seek de entrada rápido (`-ss` antes de `-i`).
- ☑ Extrapola `est_total = (bytes_muestras / seg_muestreados) · duración_total`; calcula `ahorro%`.
- ☑ Pool de trabajadores en paralelo; eventos `estimate-progress` / `estimate-result` / `estimate-done`.
- ☑ Limpieza de temporales.
- ☑ Frontend: botón **"Estimar ahorro"** (visible con modo HEVC + selección), chips de ahorro
  estimado en la columna Ahorro (verde/amarillo/rojo según %, y "no encoge" si saldría mayor).
- ☑ Test de `build_sample_args` (seek antes del input). i18n ES/EN.
- Exactitud ±10–15% (variación entre escenas) → mostrado como estimación (`≈`).

## Fase 4 — Calidad real con VMAF  ☑

- ☑ Por cada muestra, VMAF del trozo recomprimido vs el original (`-lavfi "[0:v][1:v]libvmaf"`),
  promediado. Score leído de stderr ("VMAF score:") para evitar escapes de rutas (Windows).
- ☑ Degradación elegante: si libvmaf no está/falla, `vmaf = None` y se muestra tamaño en su lugar.
- ☑ Parámetro `vmaf: bool` en el command (modo rápido sin VMAF disponible para el futuro).
- ☑ Mostrado junto al ahorro en el chip; test de `parse_vmaf`.

## Fase 5 — Veredicto y presentación  ◐

- ☑ Chip de ahorro+VMAF en la columna Ahorro, coloreado por **veredicto** (`estVerdict`):
  - **Recomendado** (verde): ahorro ≥ 15% y VMAF ≥ 93 (o sin VMAF).
  - **Marginal** (amarillo): ahorro 10–15% o VMAF 90–93.
  - **No merece la pena** (gris): ahorro < 10%.
  - **Pérdida de calidad** (rojo): VMAF < 90; y "no encoge" si saldría más grande.
  - Tooltip con `orig → est · VMAF · veredicto`.
- ☑ **Umbrales configurables**: inputs "VMAF ≥" y "Ahorro ≥" (persistidos); recalculan los
  chips al vuelo vía `verdictKey` en `logic.js`.
- ☑ **Resumen de lote** tras estimar: "N recomprimibles · ahorro potencial ≈ X".

## Fase 6 — Recompresión segura  ◐

- ☑ Recodifica solo los elegidos reusando toda la maquinaria 2.0 (paralelo, pausa, backup,
  validación, métricas reales). `ConversionJob.recompress` marca los HEVC.
- ☑ **Resguardo "nunca empeorar"**: si una recompresión NO encoge (`output ≥ original`),
  se descarta el resultado y se conserva el original. Evento `file-optimal` → badge
  "↔ Ya óptimo" + línea de resumen; no se mueve a backup.
- ☑ **10-bit preservado**: no se fuerza `-pix_fmt`, libx265 mantiene la profundidad del origen.
- ☑ **HDR**: `detector::probe_color` lee primaries/transfer/colorspace del origen y se fuerzan
  explícitamente en la salida (`-color_primaries/-color_trc/-colorspace`) cuando son señalables.
- ☑ **Aviso de pérdida generacional** antes de recomprimir (diálogo nativo `ask`, una vez por sesión).

## Fase 7 — Calidad (tests)  ☑

- ☑ Tests Rust: BPP/margen, `parse_fps`, `build_sample_args`, `parse_vmaf` (18 tests).
- ☑ Tests JS (`logic.js` + `test/logic.test.cjs`, 14 tests): `formatBytes`, `formatEta`,
  `verdictKey` (incl. umbrales personalizados).
- ☑ Smoke test en CI: el ffmpeg incluido codifica HEVC (libx265) en cada plataforma antes del build.

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
- ☐ ⭐ **Carpeta(s) vigilada(s) (watch folder)**: monitorizar **una o varias carpetas** y
  **auto-convertir** los nuevos elementos compatibles, **solo si la ganancia estimada > 50%**
  (reusa el precálculo por muestreo/VMAF de la 3.0). Ideal para NAS/servidor de medios.
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
