// main.js — Frontend de BeHEVC

const { invoke } = window.__TAURI__.core;
const { listen  } = window.__TAURI__.event;
const notif        = window.__TAURI__.notification;

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
  isPaused:           false,
  filesDone:          0,
  quality:            { crf: 28, preset: 'medium' },
  encoder:            'libx265',
  container:          'mkv',
  audio:              'copy',
  concurrency:        'auto',   // 'auto' | número de conversiones simultáneas
  lang:               'es',     // idioma de la UI: 'es' | 'en'
  jobIndexMap:        {},   // jobIdx → fileIdx en state.files
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
const btnOpenOutput     = $('btn-open-output');
const btnNewSession     = $('btn-new-session');
const btnCheckUpdate    = $('btn-check-update');
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
    if (payload.file_progress >= 0)
      progFile.style.width = (payload.file_progress * 100).toFixed(1) + '%';
    if (payload.global_progress >= 0)
      progGlobal.style.width = (payload.global_progress * 100).toFixed(1) + '%';

    // Velocidad + ETA en vivo del archivo actual
    if (payload.speed > 0 || payload.eta > 0) {
      const parts = [];
      if (payload.speed > 0) parts.push(`${payload.speed.toFixed(1)}×`);
      if (payload.eta   > 0) parts.push(`ETA ${formatEta(payload.eta)}`);
      fileMeta.textContent = parts.join(' · ');
    }

    // ── Actualizar fila en la lista de archivos ──────────────────────────
    const log = payload.log || '';
    const trimmed = log.trimStart();

    if (trimmed.startsWith('✔')) {
      setFileRowStatus(payload.file_index, 'done');
    } else if (trimmed.startsWith('❌')) {
      setFileRowStatus(payload.file_index, 'error');
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
      return;
    }

    progGlobal.classList.remove('active');
    btnStart.textContent = t('btn_start');

    if (payload === 'completed') {
      progGlobal.style.width = '100%';
      markAllDone();
      showCompletionBanner();
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
}

// ── Formato ─────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

function formatEta(seconds) {
  const s = Math.round(seconds);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60)   return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

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
      jobs.push({ input: f.path, output: f.output_path });
      state.jobIndexMap[jobIdx] = fileIdx;
      jobIdx++;
    }
  });
  if (!jobs.length) return;

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
      settings: { encoder: state.encoder, crf: q.crf, preset: q.preset, audio: state.audio },
      ffmpegPath:   state.ffmpegPath,
      ffprobePath:  state.ffprobePath,
      backupFolder: state.backupFolder,
      concurrency:  state.concurrency === 'auto' ? null : parseInt(state.concurrency),
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

btnNewSession.addEventListener('click', () => {
  state.files             = [];
  state.filesDone         = 0;
  state.jobIndexMap       = {};
  state.lastConvertingIdx = -1;
  state.totalOriginal     = 0;
  state.totalOutput       = 0;
  state.isPaused          = false;
  btnPause.hidden         = true;
  btnStart.textContent    = t('btn_start');
  fileMeta.textContent    = '';
  completionBanner.hidden = true;
  scanStatus.hidden       = true;
  progFile.style.width    = '0%';
  progGlobal.style.width  = '0%';
  logEl.textContent       = '';
  renderFileList();
  updateStats();
  updateButtonStates();
  appendLog(t('log_cleared'));
});

function showCompletionBanner() {
  // Contadores derivados del estado real por archivo
  const converted = state.files.filter(f => f.status === 'done').length;
  const skipped   = state.files.filter(f => f.status === 'skipped').length;
  const errors    = state.files.filter(f => f.status === 'error').length;

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
        state.files.push(f);
      }
    }

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
}

// ── Render ────────────────────────────────────────────────────────────────

function renderFileList() {
  if (!state.files.length) {
    emptyState.hidden = false;
    fileTable.hidden  = true;
    return;
  }
  emptyState.hidden = true;
  fileTable.hidden  = false;
  fileListBody.innerHTML = '';

  state.files.forEach((f, index) => {
    const tr = document.createElement('tr');
    tr.dataset.path      = f.path;
    tr.dataset.fileIndex = index;
    const codec = f.codec || '?';
    tr.innerHTML = `
      <td class="col-name" title="${f.path}">${f.name}</td>
      <td class="col-codec">${codec}</td>
      <td class="col-status">${badgeFor(f)}</td>
      <td class="col-savings">${f.savings || ''}</td>`;
    fileListBody.appendChild(tr);
  });
}

// Devuelve el HTML del badge de estado de un archivo (traducido).
function badgeFor(f) {
  switch (f.status) {
    case 'done':       return `<span class="badge badge-done">${t('badge_done')}</span>`;
    case 'error':      return `<span class="badge badge-error">${t('badge_error')}</span>`;
    case 'skipped':    return `<span class="badge badge-skip">${t('badge_skip')}</span>`;
    case 'queued':     return `<span class="badge badge-queue">${t('badge_queue')}</span>`;
    case 'converting': return `<span class="badge badge-converting">⟳ ${t('badge_converting')}</span>`;
    default:
      return f.needs_conversion
        ? `<span class="badge badge-convert">${t('badge_convert')}</span>`
        : `<span class="badge badge-skip">${t('badge_skip')}</span>`;
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
      const pct = progress > 0 ? ` ${(progress * 100).toFixed(0)}%` : ` ${t('badge_converting')}`;
      cell.innerHTML = `<span class="badge badge-converting">⟳${pct}</span>`;
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

function appendLog(text) {
  logEl.textContent += text;
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
      btnCheckUpdate.title = `BeHEVC ${latestApp}`;
      btnCheckUpdate.textContent = `↑ BeHEVC ${latestApp}`;
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

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      crf:          state.quality.crf,
      preset:       state.quality.preset,
      encoder:      state.encoder,
      container:    state.container,
      audio:        state.audio,
      concurrency:  state.concurrency,
      lang:         LANG,
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

  // Calidad
  if (s.crf && s.preset) {
    state.quality = { crf: s.crf, preset: s.preset };
    document.querySelectorAll('.quality-btn').forEach(b => {
      b.classList.toggle('active', +b.dataset.crf === s.crf && b.dataset.preset === s.preset);
    });
  }
  // Formato y audio
  if (s.container) {
    state.container = s.container;
    $('container-group').querySelectorAll('.opt-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.container === s.container));
  }
  if (s.audio) {
    state.audio = s.audio;
    $('audio-group').querySelectorAll('.opt-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.audio === s.audio));
  }
  if (s.concurrency) {
    state.concurrency = s.concurrency;
    $('concurrency-group').querySelectorAll('.opt-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.concurrency === String(s.concurrency)));
  }
  // Encoder por defecto (los de hardware se restauran tras detectarlos)
  if (s.encoder) state.encoder = s.encoder;
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

// ── Arranque ──────────────────────────────────────────────────────────────

loadSettings();
applyI18n();   // traduce la UI estática según el idioma activo
init();
