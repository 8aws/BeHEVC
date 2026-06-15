# BeHEVC 2.0 — Roadmap

Plan por fases para la versión 2.0. Cada fase es entregable de forma independiente.
Orden de menor a mayor riesgo. Estado: ☐ pendiente · ◐ en curso · ☑ hecho.

> **Notas de diseño que NO se rompen:**
> - El selector de **calidad** (Alta calidad / Equilibrado / Más compresión = CRF 22/28/34)
>   introducido en v0.1.2 se mantiene. El toggle de hardware es **independiente** de él.
> - ffmpeg debe empaquetarse **según arquitectura** (x86_64 / arm64) en cada plataforma.
> - Los binarios y la app deben quedar **firmados y notarizados** donde corresponda (macOS).

---

## Fase 0 — Saneamiento  ☑
Base para todo lo demás. Una sola fuente de verdad para la versión y arreglar lo roto.

- ☑ Versión única `2.0.0` en `tauri.conf.json`, `package.json`, `Cargo.toml`, `version.json`.
- ☑ Eliminar `APP_VERSION` hardcodeado en `main.js`; leerlo vía command `get_app_version`.
- ☑ Modelo de estado por archivo (`pending|queued|converting|done|skipped|error`)
  y reescribir `showCompletionBanner` sobre estado real (hoy usa campos fantasma).
- ☑ Unificar `detector::is_hevc` + `detect_video_codec` en una sola llamada a ffprobe.

## Fase 1 — Aceleración por hardware  ☑
- ☑ Command `list_hw_encoders` (parsea `ffmpeg -encoders`).
- ☑ Selector Software (libx265) / Hardware en la UI, independiente del selector de calidad.
- ☑ macOS → `hevc_videotoolbox`; Win/Linux → `hevc_nvenc`/`hevc_qsv`/`hevc_amf`/`hevc_vaapi`.
- ☑ Mapeo de CRF a la escala de calidad de cada encoder.
- ☑ Fallback automático a software libx265 si el intento de hardware falla.
- ☑ Conectar el encoder real (eliminado el `use_hardware: false` fijo).

## Fase 2 — Métricas  ☑
- ☑ Ahorro de espacio por archivo (columna "Ahorro") y total (banner).
- ☑ ETA y velocidad en vivo (parseo de `speed=` de `-progress`).

## Fase 3 — UX y flexibilidad  ☑
- ☑ Backup opcional (ya no bloquea la conversión).
- ☑ Contenedor de salida `.mkv` / `.mp4` (con `mov_text` para subs en MP4).
- ☑ Audio: copy vs transcodificar a AAC 192k.
- ☑ Drag & drop de archivos/carpetas (`tauri://drag-drop`).
- ☑ Persistencia de carpetas y ajustes (localStorage del webview, sin dependencia extra).

## Fase 4 — Rendimiento  ☑
- ☑ Conversiones en paralelo (pool de trabajadores con cola compartida, N configurable).
- ☑ Progreso global = media del progreso de todos los archivos.
- ☑ Progreso por fila en vivo (varias filas a la vez) + selector Auto/1/2/4 con pista de CPU.
- ☑ **Pausa elegante (drain) para lotes:** botón Pausar que NO corta las conversiones
  activas; deja terminar las que están en marcha y NO arranca las pendientes. Estado
  "Pausado" → reajustar opciones → Continuar con el resto.
  - Backend: `AppState.paused`; los workers dejan de tomar trabajos al pausar (sin matar
    el ffmpeg en curso); al drenar emite `paused:<nº restante>`.
  - Frontend: botón Pausar (solo con >1 archivo); al pausar reactiva selectores y muestra
    "Continuar (N)". Continuar reconstruye jobs de los pendientes con las opciones actuales
    vía `start_conversion` (reusa máquina + backup; contadores y ahorro se acumulan).

## Fase 5 — Integración de sistema  ◐
- ☑ Notificación nativa al terminar (`tauri-plugin-notification`) con resumen de ahorro.
- ☐ Auto-update real (`tauri-plugin-updater` + `latest.json`). *(pendiente: clave de firma del usuario)*
- ☑ i18n ES/EN: diccionario `src/i18n.js` (93 claves, paridad ES/EN), selector ES/EN en
  cabecera, detecta idioma del sistema y se persiste. Cubre toda la UI del frontend
  (botones, etiquetas, badges, banner, stats, hints, notificaciones, logs del frontend).
  *Pendiente 2ª pasada: las líneas de log que emite el backend (Rust) siguen en ES;
  la detección de estado por fila usa los emojis ✔/❌, así que no afecta a la lógica.*

## Fase 6 — Distribución  ◐
- ☑ ffmpeg por arquitectura (x86_64 / arm64) en el bundle de cada plataforma.
  > Resuelto: macOS arm64 e Intel ahora descargan builds **nativos** de
  > martin-riedl.de (firmados+notarizados), con verificación `file | grep <arch>`
  > que falla el build si la arquitectura no coincide. Linux/Windows ya eran por
  > arquitectura. También corregido el script local `prepare-macos-resources.sh`.
- ☑ Pipeline de firma + notarización macOS montado en CI (condicional a secrets):
  importa el certificado, firma ffmpeg/ffprobe con hardened runtime, y `tauri build`
  firma+notariza el DMG. Documentado en `behevc-tauri/RELEASE.md`.
  *Pendiente: que el usuario añada los secrets de Apple en GitHub.*
- ☑ GitHub Release automático: job `release` que en tag `v*.*.*` publica un borrador
  con todos los instaladores (DMG/EXE/MSI/AppImage).
- ☐ Firma de Windows (opcional, requiere certificado OV/EV del usuario) — documentada.
- ☐ Actualización automática de `version.json` en cada release (de momento, manual).

## Fase 7 — Calidad  ◐
- ☑ Tests Rust: `scanner`, `detector`, `build_ffmpeg_args`, mapeo de calidad, `human_size`, `aggregate_global` (14 tests, todos verdes).
- ☐ Smoke test en CI con clip de muestra.
