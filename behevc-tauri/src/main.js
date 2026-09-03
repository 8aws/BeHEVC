// main.js — Frontend de B265

const { invoke } = window.__TAURI__.core;
const { listen  } = window.__TAURI__.event;
const notif        = window.__TAURI__.notification;
const appWindow    = window.__TAURI__.window?.getCurrentWindow?.();

// Actualiza el progreso en el icono del dock (macOS) / taskbar (Windows).
function setDockProgress(pct) {
  try {
    if (!appWindow) return;
    if (pct == null) {
      appWindow.setProgressBar({ status: 'none' });
    } else {
      appWindow.setProgressBar({ status: 'normal', progress: Math.round(pct) });
    }
  } catch (_) {}
}

// Envía una notificación nativa si el usuario concedió permiso.
async function notify(title, body) {
  try {
    if (!notif) return;
    let granted = await notif.isPermissionGranted();
    if (!granted) granted = (await notif.requestPermission()) === 'granted';
    if (granted) notif.sendNotification({ title, body });
  } catch (_) { /* sin permiso o no disponible — silenciar */ }
}

// ── Estado ───────────────────────────────────────────────────────────────

const state = {
  files:              [],
  outputFolder:       null,
  backupFolder:       null,
  ffmpegPath:         null,
  ffprobePath:        null,
  isProcessing:       false,
  isScanning:         false,
  isEstimating:       false,
  isPaused:           false,
  filesDone:          0,
  quality:            { crf: 28, preset: 'medium' },
  encoder:            'libx265',
  container:          'mkv',
  audio:              'copy',
  scale:              'none',   // 'none' | altura destino ('1080','720','480')
  audioTracks:        'all',    // 'all' | 'first'
  subs:               'keep',   // 'keep' | 'none'
  concurrency:        'auto',   // 'auto' | número de conversiones simultáneas
  theme:              'dark',   // 'dark' | 'light'
  sortKey:            null,     // columna de orden de la lista
  sortDir:            1,        // 1 asc, -1 desc
  filter:             '',       // filtro por nombre
  lang:               'es',     // idioma de la UI: 'es' | 'en'
  optimizeHevc:       false,    // recomprimir HEVC existentes (3.0)
  estMinVmaf:         93,       // umbral VMAF para veredicto "Recomendado"
  estMinSavings:      15,       // umbral % ahorro para veredicto "Recomendado"
  genWarned:          false,    // aviso de pérdida generacional ya mostrado (sesión)
  vmafTarget:         null,     // null = CRF manual, número = VMAF objetivo (búsqueda CRF)
  verifyVmaf:         false,    // verificar VMAF tras cada conversión
  jobIndexMap:        {},   // jobIdx → fileIdx en state.files
  estimateIndexMap:   {},   // estIdx → fileIdx (precálculo 3.0)
  lastConvertingIdx:  -1,   // último file_index visto en conversion-progress
  totalOriginal:      0,    // bytes acumulados de originales convertidos
  totalOutput:        0,    // bytes acumulados de salidas convertidas
};

// ── DOM ───────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const btnAddFiles       = $('btn-add-files');
const btnAddFolder      = $('btn-add-folder');
const btnOutput         = $('btn-output');
const btnBackup         = $('btn-backup');
const btnStart          = $('btn-start');
const btnPause          = $('btn-pause');
const btnCancel         = $('btn-cancel');
const btnClear          = $('btn-clear');
const btnOpenOutput     = $('btn-open-output');
const btnNewSession     = $('btn-new-session');
const btnCheckUpdate    = $('btn-check-update');
const btnEstimate       = $('btn-estimate');
const estimateStatus    = $('estimate-status');
const ffmpegVersion     = $('ffmpeg-version');
const allHevcNotice     = $('all-hevc-notice');
const ffmpegStatus      = $('ffmpeg-status');
const statsEl           = $('stats');
const scanStatus        = $('scan-status');
const scanLabel         = $('scan-label');
const scanCounter       = $('scan-counter');
const progScan          = $('prog-scan');
const emptyState        = $('empty-state');
const fileTable         = $('file-table');
const fileListBody      = $('file-list-body');
const progFile          = $('prog-file');
const fileMeta          = $('file-meta');
const progGlobal        = $('prog-global');
const completionBanner  = $('completion-banner');
const completionSummary = $('completion-summary');
const logEl             = $('log');

// ── Estado de botones ─────────────────────────────────────────────────────
//
// Orden del workflow:
//   1. Carpeta destino  (siempre activa)
//   2. Añadir vídeos / carpeta  (requiere destino)
//   3. Carpeta backup  (requiere tener archivos cargados)
//   4. Convertir  (requiere destino + archivos pendientes + ffmpeg)

function updateButtonStates() {
  const hasOutput    = !!state.outputFolder;
  const hasFiles     = state.files.length > 0;
  const hasToConvert = state.files.filter(f => f.needs_conversion).length > 0;
  const busy         = state.isProcessing || state.isScanning;

  // Orden del workflow: destino → añadir archivos → backup → convertir
  btnOutput.disabled    = busy;
  btnAddFiles.disabled  = !hasOutput || busy;
  btnAddFolder.disabled = !hasOutput || busy;
  btnBackup.disabled    = !hasFiles  || busy;

  // El backup es opcional: sin él, los originales se quedan en su sitio
  btnStart.disabled = !hasOutput || !hasToConvert || !state.ffmpegPath || busy;

  // Aviso "todo ya es HEVC" — visible cuando hay archivos pero ninguno necesita conversión
  const allHevc = hasFiles && !hasToConvert && !busy;
  allHevcNotice.hidden = !allHevc;

  // Hint: explicar por qué el botón Convertir está desactivado
  const hint = $('start-hint');
  if (!busy && !allHevc) {
    const missing = [];
    if (!hasOutput)    missing.push(t('miss_output'));
    if (!hasFiles)     missing.push(t('miss_files'));
    if (!hasToConvert && hasFiles) missing.push(''); // cubierto por allHevc
    if (!state.ffmpegPath) missing.push(t('miss_ffmpeg'));
    const filtered = missing.filter(Boolean);
    hint.textContent  = filtered.length ? t('hint_missing', { items: filtered.join(', ') }) : '';
    hint.hidden       = filtered.length === 0;
  } else {
    hint.hidden = true;
  }

  [btnOutput, btnAddFiles, btnAddFolder, btnBackup].forEach(btn => {
    btn.style.opacity = btn.disabled ? '0.28' : '1';
  });

  // Botón "Estimar ahorro":
  //  - Con VMAF target activo: visible si hay archivos pendientes (cualquier codec)
  //  - Con optimizeHevc activo: visible si hay algún HEVC
  const anyHevc = state.files.some(f => f.isHevc);
  const anyToConvert = state.files.some(f => f.needs_conversion);
  const showEstimate = (state.vmafTarget && anyToConvert) || (state.optimizeHevc && anyHevc);
  btnEstimate.hidden   = !showEstimate;
  btnEstimate.disabled = busy;
  $('verdict-thresholds').hidden = !state.optimizeHevc;

  // Botón "Vaciar lista": disponible si hay archivos y no se está procesando (pausa OK)
  btnClear.hidden = !(hasFiles && !state.isProcessing);
}

// ── Inicialización ────────────────────────────────────────────────────────

async function init() {
  updateButtonStates();

  // Obtener la carpeta de datos de usuario (para actualizaciones de ffmpeg)
  try {
    appDataDir = await invoke('get_app_data_dir');
  } catch (_) {}

  // Versión de la app (fuente única: el bundle) — cabecera + aviso de updates
  try {
    appVersion = await invoke('get_app_version');
    if (appVersion) $('app-version').textContent = 'v' + appVersion;
  } catch (_) {}

  // Info de CPU para la pista del selector de paralelismo
  try {
    const [cores, auto] = await invoke('get_cpu_info');
    cpuInfo = { cores, auto };
    $('cpu-hint').textContent = t('cpu_hint', { cores, auto });
  } catch (_) {}

  try {
    const [ffmpeg, ffprobe] = await invoke('get_ffmpeg_paths');
    state.ffmpegPath  = ffmpeg;
    state.ffprobePath = ffprobe;

    if (ffmpeg && ffprobe) {
      ffmpegStatus.dataset.i18n = 'ffmpeg_ready';
      ffmpegStatus.textContent  = t('ffmpeg_ready');
      ffmpegStatus.className     = 'ok';
      appendLog(t('log_ff_detected'));

      // Detectar encoders de hardware disponibles y ofrecerlos en la UI
      loadHwEncoders(ffmpeg);

      // Mostrar versión de ffmpeg
      try {
        const ver = await invoke('get_ffmpeg_version', { ffmpegPath: ffmpeg });
        if (ver) {
          ffmpegVersion.textContent = `v${ver}`;
          ffmpegVersion.hidden = false;
          appendLog(t('log_ff_version', { ver }));
          if (appDataDir) appendLog(t('log_ff_updatedir', { dir: appDataDir }));

          // Comprobación de actualizaciones: solo una vez cada 24 h
          checkForUpdates(ver);
        }
      } catch (_) { /* versión no crítica, ignorar */ }

    } else {
      ffmpegStatus.dataset.i18n = 'ffmpeg_missing';
      ffmpegStatus.textContent  = t('ffmpeg_missing');
      ffmpegStatus.className     = 'error';
      appendLog(t('log_ff_copy'));
    }
  } catch (e) {
    appendLog(t('log_ff_search_err', { e }));
  }
  updateButtonStates();

  // ── scan-progress: feedback durante el análisis previo ────────────────
  await listen('scan-progress', ({ payload }) => {
    scanStatus.hidden  = false;
    scanLabel.textContent   = payload.file.length > 30
      ? '…' + payload.file.slice(-28) : payload.file;
    scanCounter.textContent = `${payload.current}/${payload.total}`;
    const pct = payload.total > 0 ? payload.current / payload.total : 0;
    progScan.style.width = (pct * 100).toFixed(1) + '%';
  });

  // ── conversion-progress: progreso en tiempo real ──────────────────────
  await listen('conversion-progress', ({ payload }) => {
    // Throttle de las barras/meta: en lotes grandes llegan miles de eventos;
    // refrescar el DOM en cada uno satura el hilo. Como mucho cada ~100 ms.
    const now = performance.now();
    if (now - lastBarUpdate > 100) {
      lastBarUpdate = now;
      if (payload.file_progress >= 0)
        progFile.style.width = (payload.file_progress * 100).toFixed(1) + '%';
      if (payload.global_progress >= 0) {
        progGlobal.style.width = (payload.global_progress * 100).toFixed(1) + '%';
        setDockProgress(payload.global_progress * 100);
      }
      if (payload.speed > 0 || payload.eta > 0) {
        const parts = [];
        if (payload.speed > 0) parts.push(`${payload.speed.toFixed(1)}×`);
        if (payload.eta   > 0) parts.push(`ETA ${formatEta(payload.eta)}`);
        fileMeta.textContent = parts.join(' · ');
      }
    }

    // ── Actualizar fila en la lista de archivos ──────────────────────────
    const log = payload.log || '';
    const trimmed = log.trimStart();

    if (trimmed.startsWith('✔')) {
      setFileRowStatus(payload.file_index, 'done');
    } else if (trimmed.startsWith('❌')) {
      setFileRowStatus(payload.file_index, 'error');
    } else if (trimmed.startsWith('↔')) {
      // "ya óptimo" — lo gestiona el evento file-optimal; no tocar la fila aquí
    } else if (payload.file_progress >= 0) {
      // Progreso en vivo — soporta varias filas a la vez (modo paralelo)
      setFileRowStatus(payload.file_index, 'converting', payload.file_progress);
    }

    if (log) {
      // Filtrar líneas de métricas internas de ffmpeg
      const noise = log.startsWith('frame=') || log.startsWith('size=')
        || log.startsWith('fps=')  || log.startsWith('stream_')
        || log.startsWith('bitrate=') || log.startsWith('speed=')
        || log.startsWith('out_time') || log.startsWith('total_size')
        || log.startsWith('dup_frames') || log.startsWith('drop_frames')
        || log.startsWith('progress=');
      if (!noise) appendLog(log);
    }
  });

  // ── conversion-done ───────────────────────────────────────────────────
  await listen('conversion-done', ({ payload }) => {
    state.isProcessing = false;
    progFile.style.width = '0%';
    fileMeta.textContent = '';
    progFile.classList.remove('active');
    setDockProgress(null);
    btnCancel.hidden     = true;
    btnPause.hidden      = true;

    // Pausado: el backend manda "paused:<nº restantes>"
    if (typeof payload === 'string' && payload.startsWith('paused:')) {
      const remaining = parseInt(payload.split(':')[1]) || 0;
      state.isPaused = true;
      progGlobal.classList.remove('active');
      // Las que quedaron en cola (sin empezar) vuelven a pendiente
      revertQueuedToPending();
      btnStart.textContent = t('btn_continue', { n: remaining });
      appendLog(t('log_paused', { n: remaining }));
      updateStats();
      updateButtonStates();
      saveQueue();
      return;
    }

    progGlobal.classList.remove('active');
    btnStart.textContent = t('btn_start');

    if (payload === 'completed') {
      progGlobal.style.width = '100%';
      markAllDone();
      showCompletionBanner();
      saveQueue();
      // Historial: acumular el ahorro real de esta sesión
      if (state.totalOriginal > state.totalOutput) {
        addTotalSaved(state.totalOriginal - state.totalOutput);
      }
      // Notificación nativa con el resumen
      const done = state.files.filter(f => f.status === 'done').length;
      let body = t('notif_body', { n: done });
      if (state.totalOriginal > 0 && state.totalOutput > 0) {
        const pct = ((1 - state.totalOutput / state.totalOriginal) * 100).toFixed(0);
        body += t('notif_savings', { pct });
      }
      notify(t('notif_title'), body);
    } else if (payload === 'cancelled') {
      appendLog(t('log_cancelled'));
      progGlobal.style.width = '0%';
    } else {
      appendLog(t('log_unexpected'));
    }
    updateStats();
    updateButtonStates();
  });

  // ── file-done: tamaños para el ahorro de espacio ──────────────────────
  await listen('file-done', ({ payload }) => {
    const fileIdx = state.jobIndexMap[payload.file_index];
    const { original_size: orig, output_size: out } = payload;
    if (orig > 0 && out > 0) {
      state.totalOriginal += orig;
      state.totalOutput   += out;
    }
    if (fileIdx === undefined) return;

    const savings = (orig > 0 && out > 0 && out < orig)
      ? `${formatBytes(orig)} → ${formatBytes(out)} (−${((1 - out / orig) * 100).toFixed(0)}%)`
      : '';
    if (state.files[fileIdx]) state.files[fileIdx].savings = savings;

    const row = fileListBody.querySelector(`tr[data-file-index="${fileIdx}"]`);
    const cell = row?.querySelector('.col-savings');
    if (cell) cell.textContent = savings;
  });

  // ── backup-done ───────────────────────────────────────────────────────
  await listen('backup-done', ({ payload }) => {
    appendLog(payload);
  });

  // ── Precálculo de ahorro (3.0) ─────────────────────────────────────────
  await listen('estimate-progress', ({ payload }) => {
    estimateStatus.textContent = t('btn_estimating', { current: payload.current, total: payload.total });
  });

  await listen('estimate-result', ({ payload }) => {
    const fileIdx = state.estimateIndexMap[payload.index];
    if (fileIdx === undefined) return;
    const f = state.files[fileIdx];
    if (!f) return;
    if (payload.ok) {
      f.estSavings = payload.savings_pct;
      f.estSize    = payload.estimated_size;
      f.estVmaf    = payload.vmaf;
      f.estFail    = false;
      if (payload.optimal_crf != null) f.optimalCrf = payload.optimal_crf;
    } else {
      f.estSavings = null;
      f.estFail    = true;
      f.estVmaf    = payload.vmaf;  // mejor VMAF alcanzado (aunque no llegue al objetivo)
      if (state.vmafTarget) f.optimalCrf = null;
    }
    const row = fileListBody.querySelector(`tr[data-file-index="${fileIdx}"]`);
    if (row) row.querySelector('.col-savings').innerHTML = estChip(f) || marginChip(f);
  });

  await listen('estimate-done', () => {
    state.isEstimating = false;
    btnEstimate.disabled = false;
    appendLog(t('log_estimate_done'));
    // Resumen de ahorro potencial del lote (sobre los estimados que encogen)
    let n = 0, saved = 0;
    state.files.forEach(f => {
      if (f.estSavings > 0 && f.estSize > 0 && f.size > 0) { n++; saved += f.size - f.estSize; }
    });
    if (n > 0) {
      const txt = t('est_summary', { n, size: formatBytes(saved) });
      estimateStatus.textContent = txt;
      appendLog(txt + '\n');
    } else {
      estimateStatus.textContent = '';
    }
    updateButtonStates();
  });

  // ── file-skipped: destino ya existía → saltado sin pisar ───────────────
  await listen('file-skipped', ({ payload }) => {
    setFileRowStatus(payload, 'skipped');
  });

  // ── file-optimal: recompresión que no encogía → original conservado ────
  await listen('file-optimal', ({ payload }) => {
    setFileRowStatus(payload, 'optimal');
  });

  // ── vmaf-verify: resultado VMAF post-conversión ───────────────────────
  await listen('vmaf-verify', ({ payload }) => {
    const fileIdx = state.jobIndexMap[payload.file_index];
    if (fileIdx === undefined) return;
    const f = state.files[fileIdx];
    if (!f) return;
    f.verifiedVmaf = payload.vmaf;
    const row = fileListBody.querySelector(`tr[data-file-index="${fileIdx}"]`);
    const cell = row?.querySelector('.col-savings');
    if (cell && payload.vmaf != null) {
      const v = payload.vmaf.toFixed(0);
      const isLow = payload.vmaf < state.estMinVmaf;
      const chip = isLow
        ? `<span class="est est-bad" title="VMAF ${payload.vmaf.toFixed(1)}">${t('vmaf_warn', { v, min: state.estMinVmaf })}</span>`
        : `<span class="est est-good" title="VMAF ${payload.vmaf.toFixed(1)}">${t('vmaf_ok', { v })}</span>`;
      const existing = f.savings ? f.savings + ' ' : '';
      cell.innerHTML = existing + chip;
    }
  });

  // ── Aviso al cerrar si hay tareas en marcha + guardar cola ──────────
  try {
    const win = window.__TAURI__.window.getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      saveQueue();
      if (state.isProcessing || state.isScanning || state.isEstimating) {
        let ok = false;
        try {
          const dlg = window.__TAURI__.dialog;
          ok = dlg && dlg.ask ? await dlg.ask(t('close_warn'), { title: 'B265', kind: 'warning' }) : true;
        } catch (_) { ok = true; }
        if (!ok) event.preventDefault();
      }
    });
  } catch (_) { /* API de ventana no disponible — sin aviso */ }

  // Restaurar cola de la sesión anterior (si existe)
  await tryRestoreQueue();

  // Comprobar actualizaciones en background (silencioso hasta que hay algo)
  checkForUpdates();
}

// ── Auto-update ───────────────────────────────────────────────────────────────

async function checkForUpdates() {
  try {
    const { check } = window.__TAURI__?.updater || {};
    if (!check) return;
    const update = await check();
    if (!update?.available) return;

    // Hay actualización — mostrar aviso discreto en la cabecera
    const chip = document.createElement('span');
    chip.id        = 'update-chip';
    chip.className = 'update-chip';
    chip.textContent = t('update_available', { v: update.version });
    chip.title     = update.body || '';
    chip.addEventListener('click', () => installUpdate(update, chip));
    $('app-version')?.after(chip);
  } catch (_) { /* sin red o sin clave configurada — silenciar */ }
}

async function installUpdate(update, chip) {
  if (state.isProcessing) {
    alert(t('update_busy'));
    return;
  }
  chip.textContent = t('update_downloading');
  chip.style.pointerEvents = 'none';
  try {
    await update.downloadAndInstall();
    // El instalador reinicia la app — no llegamos aquí en condiciones normales
  } catch (e) {
    chip.textContent = t('update_error');
    chip.style.pointerEvents = 'auto';
  }
}

// formatBytes / formatEta / verdictKey viven en logic.js (cargado antes que main.js)

// ── Carpeta destino ───────────────────────────────────────────────────────

btnOutput.addEventListener('click', async () => {
  const folder = await invoke('pick_folder');
  if (!folder) return;
  state.outputFolder = folder;
  $('output-path').textContent = t('dest_prefix') + folder;
  if (state.files.length) recalcOutputPaths();
  saveSettings();
  updateButtonStates();
  appendLog(t('log_dest', { f: folder }));
});

// ── Añadir archivos / carpeta ─────────────────────────────────────────────

btnAddFiles.addEventListener('click', async () => {
  const paths = await invoke('pick_video_files');
  if (paths?.length) await analyzeFiles(paths);
});

btnAddFolder.addEventListener('click', async () => {
  const folder = await invoke('pick_folder');
  if (folder) await analyzeFiles([folder]);
});

// ── Carpeta backup ────────────────────────────────────────────────────────

btnBackup.addEventListener('click', async () => {
  const folder = await invoke('pick_folder');
  if (!folder) return;
  state.backupFolder = folder;
  $('backup-path').textContent = t('backup_prefix') + folder;
  saveSettings();
  appendLog(t('log_backup', { f: folder }));
  updateButtonStates();
});

// ── Iniciar / Continuar ─────────────────────────────────────────────────────
//
// launchConversion sirve tanto para arrancar de cero como para reanudar tras una
// pausa: en ambos casos construye los jobs solo con los archivos que aún faltan
// (needs_conversion y estado ≠ done/error). En una reanudación no se reinician los
// contadores acumulados (archivos hechos y ahorro total).

// Revierte a "pendiente" las filas que quedaron en cola o a medias (sin tocar
// las ya hechas / con error). Se usa al pausar y al fallar el arranque.
function revertQueuedToPending() {
  state.files.forEach((f, fi) => {
    if (f.status === 'queued' || f.status === 'converting') {
      f.status = 'pending';
      const row = fileListBody.querySelector(`tr[data-file-index="${fi}"]`);
      if (row) row.querySelector('.col-status').innerHTML =
        `<span class="badge badge-convert">${t('badge_convert')}</span>`;
    }
  });
}

// Aviso nativo de pérdida generacional al recomprimir HEVC. Si el diálogo no está
// disponible, no bloquea (devuelve true).
async function confirmGenerational(n) {
  try {
    const dlg = window.__TAURI__.dialog;
    if (dlg && dlg.ask) {
      return await dlg.ask(t('gen_warn', { n }), { title: 'B265', kind: 'warning' });
    }
  } catch (_) {}
  return true;
}

async function launchConversion() {
  const resume = state.isPaused;
  state.isPaused          = false;
  state.jobIndexMap       = {};
  state.lastConvertingIdx = -1;
  if (!resume) {
    state.filesDone     = 0;
    state.totalOriginal = 0;
    state.totalOutput   = 0;
  }

  const jobs = [];
  let jobIdx = 0;
  state.files.forEach((f, fileIdx) => {
    if (f.needs_conversion && f.status !== 'done' && f.status !== 'error') {
      const job = { input: f.path, output: f.output_path, recompress: !!f.isHevc };
      if (f.optimalCrf != null) job.crf_override = f.optimalCrf;
      jobs.push(job);
      state.jobIndexMap[jobIdx] = fileIdx;
      jobIdx++;
    }
  });
  if (!jobs.length) return;

  // Aviso de pérdida generacional al recomprimir HEVC (una vez por sesión)
  const recompressCount = jobs.filter(j => j.recompress).length;
  if (recompressCount > 0 && !state.genWarned) {
    const ok = await confirmGenerational(recompressCount);
    if (!ok) return;
    state.genWarned = true;
  }

  // Marcar los de este lote como "en cola"
  Object.values(state.jobIndexMap).forEach(fi => {
    state.files[fi].status = 'queued';
    const row = fileListBody.querySelector(`tr[data-file-index="${fi}"]`);
    if (row) {
      row.querySelector('.col-status').innerHTML =
        `<span class="badge badge-queue">${t('badge_queue')}</span>`;
    }
  });

  completionBanner.hidden = true;
  state.isProcessing      = true;
  progFile.style.width    = '0%';
  if (!resume) progGlobal.style.width = '0%';
  progFile.classList.add('active');
  progGlobal.classList.add('active');
  btnStart.textContent = t('btn_processing');
  btnCancel.hidden     = false;
  // El botón Pausar solo tiene sentido con más de un archivo en el lote
  btnPause.hidden    = jobs.length <= 1;
  btnPause.disabled  = false;
  btnPause.textContent = t('btn_pause');
  updateButtonStates();

  const q = state.quality;
  const enc = state.encoder === 'libx265' ? t('enc_sw_word') : t('enc_hw_word');
  appendLog(t(resume ? 'log_continuing' : 'log_starting',
    { n: jobs.length, crf: q.crf, preset: q.preset, enc }));

  try {
    await invoke('start_conversion', {
      jobs,
      settings: { encoder: state.encoder, crf: q.crf, preset: q.preset, audio: state.audio, scale: state.scale, audioTracks: state.audioTracks, subs: state.subs, verifyVmaf: state.verifyVmaf },
      ffmpegPath:   state.ffmpegPath,
      ffprobePath:  state.ffprobePath,
      backupFolder: state.backupFolder,
      concurrency:  state.concurrency === 'auto' ? null : parseInt(state.concurrency),
      lang:         LANG,
    });
  } catch (e) {
    appendLog(t('log_start_fail', { e }));
    state.isProcessing   = false;
    btnCancel.hidden     = true;
    btnPause.hidden      = true;
    btnStart.textContent = resume ? t('btn_continue', { n: jobs.length }) : t('btn_start');
    progFile.classList.remove('active');
    progGlobal.classList.remove('active');
    revertQueuedToPending();
    updateStats();
    updateButtonStates();
  }
}

btnStart.addEventListener('click', launchConversion);

// ── Pausar (drain) ───────────────────────────────────────────────────────────

btnPause.addEventListener('click', async () => {
  btnPause.disabled = true;
  btnPause.textContent = t('btn_pausing');
  appendLog(t('log_pausing'));
  await invoke('pause_conversion');
});

// ── Cancelar ─────────────────────────────────────────────────────────────

btnCancel.addEventListener('click', async () => {
  await invoke('cancel_conversion');
  appendLog(t('log_cancelling'));
});

// ── Banner de completado ──────────────────────────────────────────────────

btnOpenOutput.addEventListener('click', () => {
  if (state.outputFolder) invoke('open_folder', { path: state.outputFolder });
});

// ── Cola persistente ─────────────────────────────────────────────────────

function saveQueue() {
  if (!state.files.length) {
    invoke('save_queue', { queueJson: '' }).catch(() => {});
    return;
  }
  const data = {
    files: state.files.map(f => ({
      path: f.path, name: f.name, codec: f.codec,
      needs_conversion: f.needs_conversion, output_path: f.output_path,
      size: f.size, bitrate: f.bitrate, bpp: f.bpp, margin: f.margin,
      status: f.status, isHevc: f.isHevc, recompress: f.recompress,
      savings: f.savings || null,
      estSavings: f.estSavings ?? null, estSize: f.estSize ?? null,
      estVmaf: f.estVmaf ?? null, estFail: f.estFail || false,
      optimalCrf: f.optimalCrf ?? null,
    })),
    outputFolder: state.outputFolder,
    backupFolder: state.backupFolder,
    totalOriginal: state.totalOriginal,
    totalOutput: state.totalOutput,
    filesDone: state.filesDone,
  };
  invoke('save_queue', { queueJson: JSON.stringify(data) }).catch(() => {});
}

async function tryRestoreQueue() {
  try {
    const json = await invoke('load_queue');
    if (!json) return;
    const data = JSON.parse(json);
    if (!data?.files?.length) return;
    const pending = data.files.filter(f =>
      f.status === 'pending' || f.status === 'queued' || f.status === 'converting');
    if (!pending.length) {
      invoke('save_queue', { queueJson: '' }).catch(() => {});
      return;
    }
    let ok = true;
    try {
      const dlg = window.__TAURI__.dialog;
      if (dlg && dlg.ask) {
        ok = await dlg.ask(t('queue_restore', { n: data.files.length }), { title: 'B265' });
      }
    } catch (_) {}
    if (!ok) {
      invoke('save_queue', { queueJson: '' }).catch(() => {});
      return;
    }
    state.files = data.files.map(f => {
      if (f.status === 'queued' || f.status === 'converting') f.status = 'pending';
      return f;
    });
    if (data.outputFolder) {
      state.outputFolder = data.outputFolder;
      $('output-path').textContent = t('dest_prefix') + data.outputFolder;
    }
    if (data.backupFolder) {
      state.backupFolder = data.backupFolder;
      $('backup-path').textContent = t('backup_prefix') + data.backupFolder;
    }
    state.totalOriginal = data.totalOriginal || 0;
    state.totalOutput   = data.totalOutput || 0;
    state.filesDone     = data.filesDone || 0;
    renderFileList();
    updateStats();
    updateButtonStates();
    appendLog(t('queue_restored', { n: data.files.length }));
  } catch (_) {}
}

// Vacía la lista/cola y deja la app lista para un lote nuevo.
function clearList() {
  state.files             = [];
  state.filesDone         = 0;
  state.jobIndexMap       = {};
  state.estimateIndexMap  = {};
  state.lastConvertingIdx = -1;
  state.totalOriginal     = 0;
  state.totalOutput       = 0;
  state.isPaused          = false;
  saveQueue();
  btnPause.hidden         = true;
  btnStart.textContent    = t('btn_start');
  fileMeta.textContent    = '';
  estimateStatus.textContent = '';
  completionBanner.hidden = true;
  scanStatus.hidden       = true;
  progFile.style.width    = '0%';
  progGlobal.style.width  = '0%';
  logEl.textContent       = '';
  renderFileList();
  updateStats();
  updateButtonStates();
  appendLog(t('log_cleared'));
}

btnNewSession.addEventListener('click', clearList);

// Botón "Vaciar lista": disponible en cualquier momento mientras no se esté procesando
btnClear.addEventListener('click', () => {
  if (state.isProcessing) return;
  clearList();
});

function showCompletionBanner() {
  // Contadores derivados del estado real por archivo
  const converted = state.files.filter(f => f.status === 'done').length;
  const skipped   = state.files.filter(f => f.status === 'skipped').length;
  const errors    = state.files.filter(f => f.status === 'error').length;
  const optimal   = state.files.filter(f => f.status === 'optimal').length;

  const lines = [];
  lines.push(t('sum_converted', { n: converted, dir: state.outputFolder }));
  if (state.totalOriginal > 0 && state.totalOutput > 0) {
    const pct = ((1 - state.totalOutput / state.totalOriginal) * 100).toFixed(0);
    lines.push(t('sum_savings', {
      orig: formatBytes(state.totalOriginal), out: formatBytes(state.totalOutput), pct }));
  }
  if (state.backupFolder && converted > 0)
    lines.push(t('sum_backup', { dir: state.backupFolder }));
  if (skipped > 0)
    lines.push(t('sum_skipped', { n: skipped }));
  if (optimal > 0)
    lines.push(t('sum_optimal', { n: optimal }));
  if (errors > 0)
    lines.push(t('sum_errors', { n: errors }));

  completionSummary.textContent = lines.join('\n');
  completionBanner.hidden = false;

  appendLog('\n─────────────────────────────\n');
  appendLog(t('sum_complete') + '\n');
  lines.forEach(l => appendLog(l + '\n'));
  appendLog('─────────────────────────────\n');
}

// ── Análisis ──────────────────────────────────────────────────────────────

async function analyzeFiles(paths) {
  if (!state.ffprobePath) {
    appendLog(t('log_no_ffprobe'));
    return;
  }

  state.isScanning = true;
  scanStatus.hidden = false;
  progScan.style.width = '0%';
  scanLabel.textContent = t('scanning');
  scanCounter.textContent = '';
  updateButtonStates();
  appendLog(t('log_analyzing'));

  try {
    const files = await invoke('scan_files', {
      paths,
      outputFolder: state.outputFolder,
      ffprobePath:  state.ffprobePath,
      container:    state.container,
    });

    for (const f of files) {
      if (!state.files.find(e => e.path === f.path)) {
        // Estado por archivo: pending | queued | converting | done | skipped | error
        f.status = f.needs_conversion ? 'pending' : 'skipped';
        // 3.0: HEVC con margen alto/medio se marcan para recomprimir por defecto
        f.isHevc = f.codec === 'hevc';
        f.recompress = f.isHevc && (f.margin === 'high' || f.margin === 'medium');
        state.files.push(f);
      }
    }
    applyHevcSelection();

    const n = files.filter(f => f.needs_conversion).length;
    const s = files.length - n;
    appendLog(t('log_analyzed', { n: files.length, a: n, s }));
  } catch (e) {
    appendLog(t('log_error', { e }));
  }

  state.isScanning = false;
  scanStatus.hidden = true;
  renderFileList();
  updateStats();
  updateButtonStates();
  saveQueue();
}

// ── Selección de recompresión HEVC (3.0) ───────────────────────────────────
//
// Reutiliza `needs_conversion` como bandera única de "se convertirá": un HEVC
// pasa a needs_conversion=true solo si el modo está activo y está marcado.

function applyHevcSelection() {
  state.files.forEach(f => {
    if (!f.isHevc) return;
    // No tocar archivos ya en marcha o finalizados
    if (['done', 'error', 'converting', 'queued'].includes(f.status)) return;
    const on = state.optimizeHevc && f.recompress;
    f.needs_conversion = on;
    f.status = on ? 'pending' : 'skipped';
  });
}

// ── Render ────────────────────────────────────────────────────────────────

function renderFileList() {
  if (!state.files.length) {
    emptyState.hidden = false;
    fileTable.hidden  = true;
    $('file-filter').hidden = true;
    return;
  }
  emptyState.hidden = true;
  fileTable.hidden  = false;
  fileListBody.innerHTML = '';
  $('file-filter').hidden = false;

  // Vista ordenada/filtrada; se conserva el índice ORIGINAL en data-file-index
  // para que jobIndexMap y setFileRowStatus sigan funcionando durante la conversión.
  let view = state.files.map((f, index) => ({ f, index }));
  const q = state.filter.trim().toLowerCase();
  if (q) view = view.filter(v => v.f.name.toLowerCase().includes(q));
  if (state.sortKey) {
    const dir = state.sortDir;
    view.sort((a, b) => sortVal(a.f) > sortVal(b.f) ? dir : sortVal(a.f) < sortVal(b.f) ? -dir : 0);
    function sortVal(f) {
      if (state.sortKey === 'name')  return f.name.toLowerCase();
      if (state.sortKey === 'codec') return f.codec || '';
      // savings: ahorro estimado si existe, si no por tamaño
      return f.estSavings != null ? f.estSavings : (f.size || 0);
    }
  }

  view.forEach(({ f, index }) => {
    const tr = document.createElement('tr');
    tr.dataset.path      = f.path;
    tr.dataset.fileIndex = index;
    const codec = f.codec || '?';
    tr.innerHTML = `
      <td class="col-sel">${selCell(f)}</td>
      <td class="col-name" title="${f.path}">${f.name}</td>
      <td class="col-codec">${codec}</td>
      <td class="col-status">${badgeFor(f)}</td>
      <td class="col-savings">${f.savings || estChip(f) || marginChip(f)}</td>`;
    fileListBody.appendChild(tr);
  });
}

// Veredicto del precálculo (usa verdictKey de logic.js con los umbrales del usuario).
const VERDICT_STYLE = {
  recommended: { cls: 'est-good', key: 'verdict_recommended' },
  marginal:    { cls: 'est-mid',  key: 'verdict_marginal' },
  notworth:    { cls: 'est-low',  key: 'verdict_notworth' },
  loss:        { cls: 'est-bad',  key: 'verdict_loss' },
  bad:         { cls: 'est-bad',  key: 'verdict_notworth' },
};
function estVerdict(f) {
  const k = verdictKey(f.estSavings, f.estVmaf, state.estMinVmaf, state.estMinSavings);
  const st = VERDICT_STYLE[k] || VERDICT_STYLE.marginal;
  return { cls: st.cls, label: t(st.key) };
}

// Chip de ahorro estimado por muestreo + VMAF + veredicto (precálculo 3.0).
function estChip(f) {
  if (f.estFail) {
    if (state.vmafTarget && f.optimalCrf == null) {
      const best = f.estVmaf != null ? ` (max VMAF ${f.estVmaf.toFixed(0)})` : '';
      return `<span class="est est-bad" title="${t('vmaf_crf_fail')}${best}">${t('vmaf_crf_fail')}${best}</span>`;
    }
    return `<span class="margin margin-low">${t('est_fail')}</span>`;
  }
  if (f.estSavings === null || f.estSavings === undefined) return '';

  // CRF search result (VMAF target mode)
  if (f.optimalCrf != null) {
    const vmaf = f.estVmaf != null ? f.estVmaf.toFixed(0) : '?';
    const pct = f.estSavings > 0 ? f.estSavings.toFixed(0) : '0';
    const tip = `${formatBytes(f.size || 0)} → ${formatBytes(f.estSize || 0)} · VMAF ${f.estVmaf != null ? f.estVmaf.toFixed(1) : '?'}`;
    const meetsTarget = !state.vmafTarget || f.estVmaf == null || f.estVmaf >= state.vmafTarget;
    const cls = meetsTarget ? 'est-good' : 'est-mid';
    const warn = meetsTarget ? '' : ` ⚠ < ${state.vmafTarget}`;
    return `<span class="est ${cls}" title="${tip}">${t('vmaf_crf_chip', { crf: f.optimalCrf, vmaf, pct })}${warn}</span>`;
  }

  // Caso "no encoge": saldría más grande
  if (f.estSavings < 0) {
    const tip = `${formatBytes(f.size || 0)} → ${formatBytes(f.estSize || 0)} · ${t('verdict_notworth')}`;
    return `<span class="est est-bad" title="${tip}">${t('est_bigger', { pct: Math.abs(f.estSavings).toFixed(0) })}</span>`;
  }

  const verdict = estVerdict(f);
  const main = `≈ −${f.estSavings.toFixed(0)}%`;
  const extra = (f.estVmaf != null) ? ` · VMAF ${f.estVmaf.toFixed(0)}` : ` · ${formatBytes(f.estSize || 0)}`;
  const vmafTxt = (f.estVmaf != null) ? ` · VMAF ${f.estVmaf.toFixed(1)}` : '';
  const tip = `${formatBytes(f.size || 0)} → ${formatBytes(f.estSize || 0)}${vmafTxt} · ${verdict.label}`;
  return `<span class="est ${verdict.cls}" title="${tip}">${main}${extra}</span>`;
}

// Casilla de selección por fila. Los HEVC son elegibles solo con el modo activo;
// los no-HEVC siempre se convierten (casilla marcada y deshabilitada).
function selCell(f) {
  if (f.isHevc) {
    if (!state.optimizeHevc) return '';   // modo apagado → sin casilla
    return `<input type="checkbox" class="sel-box" ${f.recompress ? 'checked' : ''}>`;
  }
  return `<input type="checkbox" checked disabled title="${t('badge_convert')}">`;
}

// Chip de "margen de recompresión" para archivos HEVC (señal de sobre-codificación).
function marginChip(f) {
  if (!f.margin) return '';
  const br  = f.bitrate ? (f.bitrate / 1e6).toFixed(1) + ' Mbps' : '?';
  const bpp = f.bpp ? f.bpp.toFixed(3) : '?';
  return `<span class="margin margin-${f.margin}" title="${t('margin_title', { bpp, br })}">${t('margin_' + f.margin)}</span>`;
}

// Devuelve el HTML del badge de estado de un archivo (traducido).
function badgeFor(f) {
  switch (f.status) {
    case 'done':       return `<span class="badge badge-done">${t('badge_done')}</span>`;
    case 'error':      return `<span class="badge badge-error">${t('badge_error')}</span>`;
    case 'skipped':    return `<span class="badge badge-skip">${t('badge_skip')}</span>`;
    case 'optimal':    return `<span class="badge badge-skip">${t('badge_optimal')}</span>`;
    case 'queued':     return `<span class="badge badge-queue">${t('badge_queue')}</span>`;
    case 'converting': return `<span class="badge badge-converting">⟳ ${t('badge_converting')}</span>`;
    default:
      if (f.needs_conversion) {
        // HEVC marcado para recomprimir → badge distinto
        return f.isHevc
          ? `<span class="badge badge-convert">${t('badge_recompress')}</span>`
          : `<span class="badge badge-convert">${t('badge_convert')}</span>`;
      }
      return `<span class="badge badge-skip">${t('badge_skip')}</span>`;
  }
}

// Actualiza el badge de una fila a partir del índice de job (no de archivo)
function setFileRowStatus(jobIndex, status, progress) {
  const fileIdx = state.jobIndexMap[jobIndex];
  if (fileIdx === undefined) return;
  const row = fileListBody.querySelector(`tr[data-file-index="${fileIdx}"]`);
  if (!row) return;
  const cell = row.querySelector('.col-status');
  if (!cell) return;

  // Una fila ya finalizada no vuelve atrás a "convirtiendo"
  const current = state.files[fileIdx]?.status;
  if (status === 'converting' && (current === 'done' || current === 'error')) return;

  // Mantener el modelo de datos sincronizado con el badge mostrado
  if (state.files[fileIdx]) state.files[fileIdx].status = status;

  switch (status) {
    case 'converting': {
      const pctInt = progress > 0 ? Math.round(progress * 100) : -1;
      // Evitar reescrituras de DOM redundantes: solo si cambió el % entero
      if (current === 'converting' && state.files[fileIdx]._pct === pctInt) break;
      if (state.files[fileIdx]) state.files[fileIdx]._pct = pctInt;
      const label = pctInt >= 0 ? ` ${pctInt}%` : ` ${t('badge_converting')}`;
      cell.innerHTML = `<span class="badge badge-converting">⟳${label}</span>`;
      if (current !== 'converting') row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    }
    case 'done':
      cell.innerHTML = `<span class="badge badge-done">${t('badge_done')}</span>`;
      state.filesDone++;
      updateStats();
      break;
    case 'error':
      cell.innerHTML = `<span class="badge badge-error">${t('badge_error')}</span>`;
      break;
    case 'optimal':
      cell.innerHTML = `<span class="badge badge-skip">${t('badge_optimal')}</span>`;
      break;
  }
}

function markAllDone() {
  // Solo marcar las que aún no tienen estado final (done/error)
  fileListBody.querySelectorAll('.badge-convert, .badge-queue, .badge-converting').forEach(el => {
    el.textContent = t('badge_done');
    el.className   = 'badge badge-done';
  });
  state.files.forEach(f => {
    // Las que estaban en proceso y no acabaron en error pasan a "done"
    if (f.status === 'queued' || f.status === 'converting' || f.status === 'pending') {
      if (f.needs_conversion) f.status = 'done';
    }
    if (f.needs_conversion) f.needs_conversion = false;
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────

function updateStats() {
  const total = state.files.length;
  // Basado en el estado real: "A convertir" no cuenta los ya hechos
  const remaining = state.files.filter(f =>
    f.status === 'pending' || f.status === 'queued' || f.status === 'converting').length;
  const skip = state.files.filter(f => f.status === 'skipped').length;
  const done = state.files.filter(f => f.status === 'done').length;
  statsEl.hidden = total === 0;
  $('stat-total').textContent   = total;
  $('stat-convert').textContent = remaining;
  $('stat-skip').textContent    = skip;
  $('stat-done').textContent    = done;
}

// ── Helpers ───────────────────────────────────────────────────────────────

// Cap del log: en lotes grandes (cientos de archivos) el texto crece sin límite y
// `textContent +=` se vuelve cuadrático, saturando el hilo del webview. Recortamos
// por el principio cuando supera el umbral.
const LOG_MAX_CHARS  = 400000;
const LOG_KEEP_CHARS = 300000;

function appendLog(text) {
  let s = logEl.textContent + text;
  if (s.length > LOG_MAX_CHARS) {
    s = '…\n' + s.slice(s.length - LOG_KEEP_CHARS);
  }
  logEl.textContent = s;
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

function recalcOutputPaths() {
  for (const f of state.files) {
    const name = f.name.replace(/\.[^.]+$/, '');
    f.output_path = state.outputFolder + '/' + name + '.hevc.' + state.container;
  }
}

// ── Comprobación de actualizaciones de ffmpeg ─────────────────────────────
//
// Estrategia: comparamos la versión instalada con la última publicada en
// evermeet.cx (fuente de las builds estáticas macOS que usa la app).
// La comprobación solo se hace una vez cada 24 h para no molestar.

const VERSION_URL         = 'https://b265.uverse.es/version.json';
const UPDATE_CHECK_KEY    = 'behevc_last_update_check';
const UPDATE_INTERVAL_MS  = 24 * 60 * 60 * 1000; // 24 horas

// Ruta de datos de usuario, versión de la app e info de CPU — al arrancar
let appDataDir = null;
let appVersion = null;
let cpuInfo    = null;
let lastBarUpdate = 0;   // throttle de las barras de progreso (ms)

async function checkForUpdates(installedFfmpegVersion) {
  // Throttle: no comprobar si ya lo hicimos en las últimas 24 h
  const lastCheck = parseInt(localStorage.getItem(UPDATE_CHECK_KEY) || '0', 10);
  if (Date.now() - lastCheck < UPDATE_INTERVAL_MS) return;

  try {
    const res  = await fetch(VERSION_URL);
    if (!res.ok) return;
    const data = await res.json();

    localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));

    // ── Comprobar versión de la propia app ────────────────────────────────
    const latestApp = data?.app?.version;
    if (latestApp && appVersion && latestApp !== appVersion) {
      appendLog(t('upd_app', { latest: latestApp, current: appVersion }));
      appendLog(t('upd_app_dl'));
      btnCheckUpdate.removeAttribute('data-i18n');      // texto dinámico, no traducir
      btnCheckUpdate.removeAttribute('data-i18n-title');
      btnCheckUpdate.title = `B265 ${latestApp}`;
      btnCheckUpdate.textContent = `↑ B265 ${latestApp}`;
      btnCheckUpdate.hidden = false;
      btnCheckUpdate.dataset.updateUrl = 'https://b265.uverse.es/#downloads';
    }

    // ── Comprobar versión de ffmpeg ───────────────────────────────────────
    const latestFfmpeg = data?.ffmpeg?.recommended_version;
    if (latestFfmpeg && installedFfmpegVersion && latestFfmpeg !== installedFfmpegVersion) {
      appendLog(t('upd_ffmpeg', { latest: latestFfmpeg, current: installedFfmpegVersion }));
      // Solo mostrar el botón de ffmpeg si no hay actualización de la app
      if (btnCheckUpdate.hidden) {
        btnCheckUpdate.dataset.i18n = 'update_ffmpeg';
        btnCheckUpdate.dataset.i18nTitle = 'update_ffmpeg_title';
        btnCheckUpdate.textContent = t('update_ffmpeg');
        btnCheckUpdate.title = t('update_ffmpeg_title');
        btnCheckUpdate.hidden = false;
        btnCheckUpdate.dataset.updateUrl = '';
      }
    }

  } catch (_) { /* red no disponible — silenciar */ }
}

btnCheckUpdate.addEventListener('click', async () => {
  const target = btnCheckUpdate.dataset.updateUrl;
  if (target) {
    // Actualización de la app → abrir web
    invoke('open_url', { url: target });
  } else {
    // Actualización de ffmpeg → abrir carpeta + evermeet.cx
    if (appDataDir) await invoke('open_folder', { path: appDataDir });
    invoke('open_url', { url: 'https://evermeet.cx/ffmpeg/' });
  }
});

// ── Selector de calidad ───────────────────────────────────────────────────

document.querySelectorAll('.quality-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (state.isProcessing) return;
    document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.quality = { crf: parseInt(btn.dataset.crf), preset: btn.dataset.preset };
  });
});

// ── Selector de codificador (software / hardware) ──────────────────────────

const encoderGroup = $('encoder-group');

// Click en cualquier botón de encoder (delegación, cubre los inyectados)
encoderGroup.addEventListener('click', e => {
  const btn = e.target.closest('.encoder-btn');
  if (!btn || state.isProcessing) return;
  encoderGroup.querySelectorAll('.encoder-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.encoder = btn.dataset.encoder;
});

// Detecta la aceleración por hardware y ofrece un botón genérico "Hardware".
// El nombre técnico del módulo (VideoToolbox, NVENC…) va solo en el tooltip:
// el usuario no necesita conocerlo.
async function loadHwEncoders(ffmpegPath) {
  try {
    const encoders = await invoke('list_hw_encoders', { ffmpegPath });
    if (!encoders?.length) {
      // Sin hardware: si había un encoder de HW persistido, volver a software
      if (state.encoder !== 'libx265') {
        state.encoder = 'libx265';
        encoderGroup.querySelector('[data-encoder="libx265"]')?.classList.add('active');
      }
      return;
    }

    // Usamos el primer (mejor) encoder detectado para la plataforma
    const hw = encoders[0];
    const btn = document.createElement('button');
    btn.className = 'encoder-btn';
    btn.dataset.encoder = hw.id;
    btn.dataset.i18n = 'enc_hardware';   // se re-traduce al cambiar idioma
    btn.textContent = t('enc_hardware');
    btn.title = `${hw.label}`;
    encoderGroup.appendChild(btn);

    // Restaurar la selección persistida (cualquier id de HW → este botón)
    if (state.encoder !== 'libx265') {
      state.encoder = hw.id; // normalizar al hw disponible
      encoderGroup.querySelector('[data-encoder="libx265"]').classList.remove('active');
      btn.classList.add('active');
    }
    appendLog(t('log_hw_avail', { label: hw.label }));
  } catch (_) { /* sin hardware o ffmpeg no disponible — solo software */ }
}

// ── Selectores de formato y audio ──────────────────────────────────────────

$('container-group').addEventListener('click', e => {
  const btn = e.target.closest('.opt-btn');
  if (!btn || state.isProcessing) return;
  $('container-group').querySelectorAll('.opt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.container = btn.dataset.container;
  // Cambiar el contenedor cambia la extensión de salida
  if (state.files.length) { recalcOutputPaths(); }
  saveSettings();
});

$('audio-group').addEventListener('click', e => {
  const btn = e.target.closest('.opt-btn');
  if (!btn || state.isProcessing) return;
  $('audio-group').querySelectorAll('.opt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.audio = btn.dataset.audio;
  saveSettings();
});

$('concurrency-group').addEventListener('click', e => {
  const btn = e.target.closest('.opt-btn');
  if (!btn || state.isProcessing) return;
  $('concurrency-group').querySelectorAll('.opt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.concurrency = btn.dataset.concurrency;
  saveSettings();
});

$('scale-group').addEventListener('click', e => {
  const btn = e.target.closest('.opt-btn');
  if (!btn || state.isProcessing) return;
  $('scale-group').querySelectorAll('.opt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.scale = btn.dataset.scale;
  saveSettings();
});

$('tracks-audio-group').addEventListener('click', e => {
  const btn = e.target.closest('.opt-btn');
  if (!btn || state.isProcessing) return;
  $('tracks-audio-group').querySelectorAll('.opt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.audioTracks = btn.dataset.tracks;
  saveSettings();
});

$('subs-group').addEventListener('click', e => {
  const btn = e.target.closest('.opt-btn');
  if (!btn || state.isProcessing) return;
  $('subs-group').querySelectorAll('.opt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.subs = btn.dataset.subs;
  saveSettings();
});

// ── Lista: filtro y orden ───────────────────────────────────────────────────

$('file-filter').addEventListener('input', e => {
  state.filter = e.target.value;
  renderFileList();
});

fileTable.querySelector('thead').addEventListener('click', e => {
  const th = e.target.closest('.col-sortable');
  if (!th) return;
  const key = th.dataset.sort;
  if (state.sortKey === key) state.sortDir *= -1;
  else { state.sortKey = key; state.sortDir = 1; }
  // Indicador visual de orden
  fileTable.querySelectorAll('.col-sortable').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
  th.classList.add(state.sortDir > 0 ? 'sort-asc' : 'sort-desc');
  renderFileList();
});

// ── Historial acumulado de ahorro ───────────────────────────────────────────

const TOTAL_SAVED_KEY = 'behevc_total_saved';

function getTotalSaved() {
  return parseInt(localStorage.getItem(TOTAL_SAVED_KEY) || '0', 10) || 0;
}
function showTotalSaved() {
  const total = getTotalSaved();
  const el = $('total-saved');
  if (total > 0) { el.textContent = t('total_saved', { size: formatBytes(total) }); el.hidden = false; }
  else el.hidden = true;
}
function addTotalSaved(bytes) {
  if (bytes > 0) {
    localStorage.setItem(TOTAL_SAVED_KEY, String(getTotalSaved() + bytes));
    showTotalSaved();
  }
}

// ── Modo "Optimizar HEVC existentes" (3.0) ──────────────────────────────────

$('opt-hevc').addEventListener('change', e => {
  if (state.isProcessing) { e.target.checked = state.optimizeHevc; return; }
  state.optimizeHevc = e.target.checked;
  applyHevcSelection();
  renderFileList();
  updateStats();
  updateButtonStates();
  saveSettings();
});

// ── VMAF objetivo (búsqueda binaria de CRF) ────────────────────────────────

$('vmaf-target-toggle').addEventListener('change', e => {
  if (state.isProcessing) { e.target.checked = !!state.vmafTarget; return; }
  if (e.target.checked) {
    state.vmafTarget = parseInt($('vmaf-target-value').value) || 95;
    $('vmaf-target-value').hidden = false;
    $('quality-group').classList.add('dimmed');
  } else {
    state.vmafTarget = null;
    $('vmaf-target-value').hidden = true;
    $('quality-group').classList.remove('dimmed');
  }
  saveSettings();
});

$('vmaf-target-value').addEventListener('change', e => {
  const v = parseInt(e.target.value);
  if (!isNaN(v)) state.vmafTarget = Math.max(80, Math.min(99, v));
  e.target.value = state.vmafTarget;
  saveSettings();
});

// ── Verificar calidad VMAF post-conversión ──────────────────────────────────

$('verify-vmaf').addEventListener('change', e => {
  if (state.isProcessing) { e.target.checked = state.verifyVmaf; return; }
  state.verifyVmaf = e.target.checked;
  saveSettings();
});

// Umbrales de veredicto configurables (recalculan los chips al vuelo)
$('th-vmaf').addEventListener('change', e => {
  const v = parseInt(e.target.value);
  if (!isNaN(v)) state.estMinVmaf = Math.max(50, Math.min(100, v));
  e.target.value = state.estMinVmaf;
  renderFileList(); saveSettings();
});
$('th-savings').addEventListener('change', e => {
  const v = parseInt(e.target.value);
  if (!isNaN(v)) state.estMinSavings = Math.max(0, Math.min(90, v));
  e.target.value = state.estMinSavings;
  renderFileList(); saveSettings();
});

// Botón "Estimar ahorro": muestrea los HEVC seleccionados y rellena la columna Ahorro
btnEstimate.addEventListener('click', async () => {
  if (state.isProcessing || btnEstimate.disabled) return;
  // Con VMAF target: estimar todos los que se van a convertir (cualquier codec).
  // Sin VMAF target: solo los HEVC (para evaluar recompresión).
  state.estimateIndexMap = {};
  const paths = [];
  let estIdx = 0;
  state.files.forEach((f, fileIdx) => {
    const include = state.vmafTarget
      ? f.needs_conversion   // VMAF target: todo lo que se va a convertir
      : f.isHevc;            // Sin target: solo HEVC (estimación de recompresión)
    if (include) {
      paths.push(f.path);
      state.estimateIndexMap[estIdx++] = fileIdx;
    }
  });
  if (!paths.length) return;

  state.isEstimating = true;
  btnEstimate.disabled = true;
  estimateStatus.textContent = t('btn_estimating', { current: 0, total: paths.length });
  if (state.vmafTarget) {
    appendLog(t('log_vmaf_search', { target: state.vmafTarget, n: paths.length }));
  } else {
    appendLog(t('log_estimating', { n: paths.length }));
  }

  const q = state.quality;
  try {
    await invoke('estimate_savings', {
      paths,
      settings:    { encoder: state.encoder, crf: q.crf, preset: q.preset, audio: state.audio, scale: state.scale },
      ffmpegPath:  state.ffmpegPath,
      ffprobePath: state.ffprobePath,
      concurrency: state.concurrency === 'auto' ? null : parseInt(state.concurrency),
      vmaf:        true,
      targetVmaf:  state.vmafTarget || null,
    });
  } catch (e) {
    appendLog(t('log_error', { e }));
    state.isEstimating = false;
    btnEstimate.disabled = false;
    estimateStatus.textContent = '';
  }
});

// Casillas de selección por fila (delegación; sobreviven a los re-render)
fileListBody.addEventListener('change', e => {
  const box = e.target.closest('.sel-box');
  if (!box || state.isProcessing) return;
  const row = box.closest('tr');
  const fi  = parseInt(row?.dataset.fileIndex);
  const f   = state.files[fi];
  if (!f) return;
  f.recompress = box.checked;
  applyHevcSelection();
  row.querySelector('.col-status').innerHTML  = badgeFor(f);
  row.querySelector('.col-savings').innerHTML = f.savings || marginChip(f);
  updateStats();
  updateButtonStates();
});

// ── Tema claro/oscuro ───────────────────────────────────────────────────────

function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', state.theme === 'light');
  $('theme-toggle').textContent = state.theme === 'light' ? '☀️' : '🌙';
}

$('theme-toggle').addEventListener('click', () => {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
  saveSettings();
});

// ── Selector de idioma ──────────────────────────────────────────────────────

document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setLang(btn.dataset.lang);
    state.lang = LANG;
    applyI18n();        // traduce todos los elementos estáticos
    refreshDynamicI18n(); // y los textos dinámicos (badges, botones, pista CPU…)
    saveSettings();
  });
});

// Re-traduce los textos que se generan por JS (no llevan data-i18n).
function refreshDynamicI18n() {
  // Tabla de archivos (badges) y stats
  renderFileList();
  updateStats();
  // Pista de CPU
  if (cpuInfo) $('cpu-hint').textContent = t('cpu_hint', cpuInfo);
  // Botón principal según el estado actual
  if (!state.isProcessing) {
    if (state.isPaused) {
      const remaining = state.files.filter(f =>
        f.needs_conversion && f.status !== 'done' && f.status !== 'error').length;
      btnStart.textContent = t('btn_continue', { n: remaining });
    } else {
      btnStart.textContent = t('btn_start');
    }
  } else {
    btnStart.textContent = t('btn_processing');
  }
  if (!btnPause.hidden) btnPause.textContent = btnPause.disabled ? t('btn_pausing') : t('btn_pause');
  // Banner de completado, si está visible
  if (!completionBanner.hidden) showCompletionBanner();
}

// Persistir también calidad y encoder al cambiarlos
document.querySelectorAll('.quality-btn').forEach(b => b.addEventListener('click', saveSettings));
encoderGroup.addEventListener('click', saveSettings);

// ── Drag & drop de archivos/carpetas sobre la ventana ───────────────────────

listen('tauri://drag-drop', async ({ payload }) => {
  const paths = payload?.paths;
  if (!paths?.length || state.isProcessing || state.isScanning) return;
  if (!state.outputFolder) {
    appendLog(t('log_drop_nodest'));
    return;
  }
  await analyzeFiles(paths);
});

// ── Persistencia de ajustes (localStorage del webview) ──────────────────────

const SETTINGS_KEY = 'behevc_settings';

// Conjunto de ajustes que forman un "perfil" (sin carpetas/idioma).
function currentProfile() {
  return {
    crf: state.quality.crf, preset: state.quality.preset,
    encoder: state.encoder, container: state.container, audio: state.audio,
    scale: state.scale, audioTracks: state.audioTracks, subs: state.subs,
    concurrency: state.concurrency,
    optimizeHevc: state.optimizeHevc,
    estMinVmaf: state.estMinVmaf, estMinSavings: state.estMinSavings,
    vmafTarget: state.vmafTarget, verifyVmaf: state.verifyVmaf,
  };
}

// Aplica un objeto de ajustes al estado (no toca carpetas/idioma).
function applyProfileObject(p) {
  if (p.crf && p.preset) state.quality = { crf: p.crf, preset: p.preset };
  if (p.encoder)   state.encoder = p.encoder;
  if (p.container) state.container = p.container;
  if (p.audio)     state.audio = p.audio;
  if (p.scale)     state.scale = p.scale;
  if (p.audioTracks) state.audioTracks = p.audioTracks;
  if (p.subs)      state.subs = p.subs;
  if (p.concurrency) state.concurrency = p.concurrency;
  state.optimizeHevc = !!p.optimizeHevc;
  if (typeof p.estMinVmaf === 'number')    state.estMinVmaf = p.estMinVmaf;
  if (typeof p.estMinSavings === 'number') state.estMinSavings = p.estMinSavings;
  state.vmafTarget  = typeof p.vmafTarget === 'number' ? p.vmafTarget : null;
  state.verifyVmaf  = !!p.verifyVmaf;
}

// Sincroniza TODOS los controles de la UI con el estado actual.
function syncControlsFromState() {
  document.querySelectorAll('.quality-btn').forEach(b =>
    b.classList.toggle('active', +b.dataset.crf === state.quality.crf && b.dataset.preset === state.quality.preset));
  const grp = (id, attr, val) => $(id).querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset[attr] === String(val)));
  grp('container-group', 'container', state.container);
  grp('audio-group', 'audio', state.audio);
  grp('scale-group', 'scale', state.scale);
  grp('tracks-audio-group', 'tracks', state.audioTracks);
  grp('subs-group', 'subs', state.subs);
  grp('concurrency-group', 'concurrency', state.concurrency);
  encoderGroup.querySelectorAll('.encoder-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.encoder === state.encoder));
  // Si el encoder (p. ej. HW) no está disponible aún, caer a software
  if (!encoderGroup.querySelector('.encoder-btn.active')) {
    state.encoder = 'libx265';
    encoderGroup.querySelector('[data-encoder="libx265"]')?.classList.add('active');
  }
  $('opt-hevc').checked = state.optimizeHevc;
  $('th-vmaf').value    = state.estMinVmaf;
  $('th-savings').value = state.estMinSavings;
  $('vmaf-target-toggle').checked = !!state.vmafTarget;
  $('vmaf-target-value').value    = state.vmafTarget || 95;
  $('vmaf-target-value').hidden   = !state.vmafTarget;
  if (state.vmafTarget) $('quality-group').classList.add('dimmed');
  else                  $('quality-group').classList.remove('dimmed');
  $('verify-vmaf').checked = state.verifyVmaf;
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      ...currentProfile(),
      lang: LANG,
      theme: state.theme,
      outputFolder: state.outputFolder,
      backupFolder: state.backupFolder,
    }));
  } catch (_) {}
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (_) {}
  if (!s || typeof s !== 'object') s = {};

  // Idioma: el guardado, o el del sistema (es* → es, resto → en)
  const sysLang = (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
  setLang(s.lang || sysLang);
  state.lang = LANG;

  applyProfileObject(s);
  syncControlsFromState();

  // Tema: el guardado, o el del sistema en el primer arranque
  const sysDark = !window.matchMedia || !window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(s.theme || (sysDark ? 'dark' : 'light'));

  // Carpetas
  if (s.outputFolder) {
    state.outputFolder = s.outputFolder;
    $('output-path').textContent = t('dest_prefix') + s.outputFolder;
  }
  if (s.backupFolder) {
    state.backupFolder = s.backupFolder;
    $('backup-path').textContent = t('backup_prefix') + s.backupFolder;
  }
}

// ── Perfiles guardados ──────────────────────────────────────────────────────

const PROFILES_KEY = 'behevc_profiles';

function readProfiles() {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function writeProfiles(p) { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(p)); } catch (_) {} }

function refreshProfileSelect(selected) {
  const sel = $('profile-select');
  const names = Object.keys(readProfiles()).sort();
  sel.innerHTML = `<option value="">${t('profile_pick')}</option>` +
    names.map(n => `<option value="${n}">${n}</option>`).join('');
  sel.value = selected && names.includes(selected) ? selected : '';
  $('profile-del').hidden = !sel.value;
}

$('profile-select').addEventListener('change', e => {
  const name = e.target.value;
  $('profile-del').hidden = !name;
  if (!name || state.isProcessing) return;
  const p = readProfiles()[name];
  if (!p) return;
  applyProfileObject(p);
  syncControlsFromState();
  applyHevcSelection();
  if (state.files.length) recalcOutputPaths();
  renderFileList(); updateStats(); updateButtonStates(); saveSettings();
  appendLog(t('profile_applied', { n: name }));
});

$('profile-save').addEventListener('click', () => {
  const name = ($('profile-name').value || $('profile-select').value).trim();
  if (!name) { $('profile-name').focus(); return; }
  const p = readProfiles(); p[name] = currentProfile(); writeProfiles(p);
  $('profile-name').value = '';
  refreshProfileSelect(name);
  appendLog(t('profile_saved', { n: name }));
});

$('profile-del').addEventListener('click', () => {
  const name = $('profile-select').value;
  if (!name) return;
  const p = readProfiles(); delete p[name]; writeProfiles(p);
  refreshProfileSelect('');
});

// ── Arranque ──────────────────────────────────────────────────────────────

loadSettings();
refreshProfileSelect('');
showTotalSaved();
applyI18n();   // traduce la UI estática según el idioma activo
init();
