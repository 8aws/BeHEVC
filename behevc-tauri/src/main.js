// main.js — Frontend de BeHEVC

const { invoke } = window.__TAURI__.core;
const { listen  } = window.__TAURI__.event;

// ── Estado ───────────────────────────────────────────────────────────────

const state = {
  files:        [],
  outputFolder: null,
  backupFolder: null,
  ffmpegPath:   null,
  ffprobePath:  null,
  isProcessing: false,
  isScanning:   false,
  filesDone:    0,
};

// ── DOM ───────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const btnAddFiles       = $('btn-add-files');
const btnAddFolder      = $('btn-add-folder');
const btnOutput         = $('btn-output');
const btnBackup         = $('btn-backup');
const btnStart          = $('btn-start');
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
  const hasBackup    = !!state.backupFolder;
  const busy         = state.isProcessing || state.isScanning;

  // Orden del workflow: destino → añadir archivos → backup → convertir
  btnOutput.disabled    = busy;
  btnAddFiles.disabled  = !hasOutput || busy;
  btnAddFolder.disabled = !hasOutput || busy;
  btnBackup.disabled    = !hasFiles  || busy;

  // El backup es obligatorio: sin él no se puede convertir
  btnStart.disabled = !hasOutput || !hasToConvert || !state.ffmpegPath || !hasBackup || busy;

  // Aviso "todo ya es HEVC" — visible cuando hay archivos pero ninguno necesita conversión
  const allHevc = hasFiles && !hasToConvert && !busy;
  allHevcNotice.hidden = !allHevc;

  // Hint: explicar por qué el botón Convertir está desactivado
  const hint = $('start-hint');
  if (!busy && !allHevc) {
    const missing = [];
    if (!hasOutput)    missing.push('carpeta destino');
    if (!hasFiles)     missing.push('vídeos');
    if (!hasToConvert && hasFiles) missing.push(''); // cubierto por allHevc
    if (!hasBackup)    missing.push('carpeta backup');
    if (!state.ffmpegPath) missing.push('ffmpeg');
    const filtered = missing.filter(Boolean);
    hint.textContent  = filtered.length ? `Falta: ${filtered.join(', ')}` : '';
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

  try {
    const [ffmpeg, ffprobe] = await invoke('get_ffmpeg_paths');
    state.ffmpegPath  = ffmpeg;
    state.ffprobePath = ffprobe;

    if (ffmpeg && ffprobe) {
      ffmpegStatus.textContent = '✔ ffmpeg listo';
      ffmpegStatus.className   = 'ok';
      appendLog('✔ ffmpeg y ffprobe detectados\n');

      // Mostrar versión de ffmpeg
      try {
        const ver = await invoke('get_ffmpeg_version', { ffmpegPath: ffmpeg });
        if (ver) {
          ffmpegVersion.textContent = `v${ver}`;
          ffmpegVersion.hidden = false;
          appendLog(`   ffmpeg ${ver}\n`);
          if (appDataDir) appendLog(`   Para actualizar ffmpeg: ${appDataDir}\n`);

          // Comprobación de actualizaciones: solo una vez cada 24 h
          checkForUpdates(ver);
        }
      } catch (_) { /* versión no crítica, ignorar */ }

    } else {
      ffmpegStatus.textContent = '✗ ffmpeg no encontrado';
      ffmpegStatus.className   = 'error';
      appendLog('⚠ Copia ffmpeg y ffprobe en src-tauri/resources/\n');
    }
  } catch (e) {
    appendLog(`Error buscando ffmpeg: ${e}\n`);
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

    if (payload.log) {
      // Filtrar líneas de métricas internas de ffmpeg
      const l = payload.log;
      const noise = l.startsWith('frame=') || l.startsWith('size=')
        || l.startsWith('fps=')  || l.startsWith('stream_')
        || l.startsWith('bitrate=') || l.startsWith('speed=')
        || l.startsWith('out_time') || l.startsWith('total_size')
        || l.startsWith('dup_frames') || l.startsWith('drop_frames')
        || l.startsWith('progress=');
      if (!noise) appendLog(l);
    }
  });

  // ── conversion-done ───────────────────────────────────────────────────
  await listen('conversion-done', ({ payload }) => {
    state.isProcessing = false;
    progFile.style.width = '0%';
    progFile.classList.remove('active');
    progGlobal.classList.remove('active');
    btnCancel.hidden     = true;
    btnStart.textContent = 'Convertir a HEVC';

    if (payload === 'completed') {
      progGlobal.style.width = '100%';
      markAllDone();
      showCompletionBanner();
    } else if (payload === 'cancelled') {
      appendLog('\n⛔ Conversión cancelada.\n');
      progGlobal.style.width = '0%';
    } else {
      appendLog('\n⚠ La conversión terminó con un error inesperado.\n');
    }
    updateStats();
    updateButtonStates();
  });

  // ── backup-done ───────────────────────────────────────────────────────
  await listen('backup-done', ({ payload }) => {
    appendLog(payload);
  });
}

// ── Carpeta destino ───────────────────────────────────────────────────────

btnOutput.addEventListener('click', async () => {
  const folder = await invoke('pick_folder');
  if (!folder) return;
  state.outputFolder = folder;
  $('output-path').textContent = '→ destino: ' + folder;
  if (state.files.length) recalcOutputPaths();
  updateButtonStates();
  appendLog(`Carpeta destino: ${folder}\n`);
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
  $('backup-path').textContent = '🗂 backup: ' + folder;
  appendLog(`Carpeta backup: ${folder}\n`);
  updateButtonStates();
});

// ── Iniciar ───────────────────────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
  const jobs = state.files
    .filter(f => f.needs_conversion)
    .map(f => ({ input: f.path, output: f.output_path }));
  if (!jobs.length) return;

  // Ocultar banner si había uno de sesión anterior
  completionBanner.hidden = true;

  state.isProcessing     = true;
  state.filesDone        = 0;
  progFile.style.width   = '0%';
  progGlobal.style.width = '0%';
  progFile.classList.add('active');
  progGlobal.classList.add('active');
  btnStart.textContent   = 'Procesando…';
  btnCancel.hidden       = false;
  updateButtonStates();

  appendLog(`\nIniciando: ${jobs.length} archivo(s)…\n`);

  try {
    await invoke('start_conversion', {
      jobs,
      settings: { use_hardware: false, crf: 28, preset: 'medium' },
      ffmpegPath:   state.ffmpegPath,
      ffprobePath:  state.ffprobePath,
      backupFolder: state.backupFolder,
    });
  } catch (e) {
    appendLog(`\nERROR: ${e}\n`);
    state.isProcessing = false;
    btnCancel.hidden   = true;
    updateButtonStates();
  }
});

// ── Cancelar ─────────────────────────────────────────────────────────────

btnCancel.addEventListener('click', async () => {
  await invoke('cancel_conversion');
  appendLog('\nCancelando…\n');
});

// ── Banner de completado ──────────────────────────────────────────────────

btnOpenOutput.addEventListener('click', () => {
  if (state.outputFolder) invoke('open_folder', { path: state.outputFolder });
});

btnNewSession.addEventListener('click', () => {
  // Resetear todo
  state.files        = [];
  state.filesDone    = 0;
  completionBanner.hidden  = true;
  scanStatus.hidden        = true;
  progFile.style.width     = '0%';
  progGlobal.style.width   = '0%';
  logEl.textContent        = '';
  renderFileList();
  updateStats();
  updateButtonStates();
  appendLog('Lista limpiada. Lista para nueva sesión.\n');
});

function showCompletionBanner() {
  const toConvert = state.files.filter(f => f._wasQueued);
  const converted = state.files.filter(f => f.codec === 'done').length;
  const skipped   = state.files.filter(f => f.codec === 'hevc').length;
  const errors    = state.files.filter(f => f._error).length;
  const queuedCount = state.files.filter(f => f.needs_conversion === false && f.codec !== 'hevc').length;

  const lines = [];
  lines.push(`📁 Convertidos (${queuedCount}) → ${state.outputFolder}`);
  lines.push(`🗂  Originales convertidos → ${state.backupFolder}`);
  if (skipped > 0)
    lines.push(`⏭  Ya eran HEVC (${skipped}) → intactos en ubicación original`);
  if (errors > 0)
    lines.push(`❌ Con errores (${errors}) → intactos en ubicación original`);

  completionSummary.textContent = lines.join('\n');
  completionBanner.hidden = false;

  appendLog('\n─────────────────────────────\n');
  appendLog('✅ Proceso completo\n');
  lines.forEach(l => appendLog(l + '\n'));
  appendLog('─────────────────────────────\n');
}

// ── Análisis ──────────────────────────────────────────────────────────────

async function analyzeFiles(paths) {
  if (!state.ffprobePath) {
    appendLog('⚠ ffprobe no disponible.\n');
    return;
  }

  state.isScanning = true;
  scanStatus.hidden = false;
  progScan.style.width = '0%';
  scanLabel.textContent = 'Analizando…';
  scanCounter.textContent = '';
  updateButtonStates();
  appendLog(`\nAnalizando…\n`);

  try {
    const files = await invoke('scan_files', {
      paths,
      outputFolder: state.outputFolder,
      ffprobePath:  state.ffprobePath,
    });

    for (const f of files) {
      if (!state.files.find(e => e.path === f.path)) state.files.push(f);
    }

    const n = files.filter(f => f.needs_conversion).length;
    const s = files.length - n;
    appendLog(`${files.length} archivos — ${n} a convertir, ${s} ya HEVC\n`);
  } catch (e) {
    appendLog(`ERROR: ${e}\n`);
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

  for (const f of state.files) {
    const tr = document.createElement('tr');
    tr.dataset.path = f.path;
    const codec = f.codec || '?';
    const badge = f.needs_conversion
      ? '<span class="badge badge-convert">Convertir</span>'
      : '<span class="badge badge-skip">Ya HEVC</span>';
    tr.innerHTML = `
      <td class="col-name" title="${f.path}">${f.name}</td>
      <td class="col-codec">${codec}</td>
      <td class="col-status">${badge}</td>`;
    fileListBody.appendChild(tr);
  }
}

function markAllDone() {
  fileListBody.querySelectorAll('.badge-convert').forEach(el => {
    el.textContent = '✔ Hecho';
    el.className   = 'badge badge-done';
  });
  state.files.forEach(f => { if (f.needs_conversion) f.needs_conversion = false; });
}

// ── Stats ─────────────────────────────────────────────────────────────────

function updateStats() {
  const total = state.files.length;
  const conv  = state.files.filter(f => f.needs_conversion).length;
  statsEl.hidden = total === 0;
  $('stat-total').textContent   = total;
  $('stat-convert').textContent = conv;
  $('stat-skip').textContent    = total - conv;
  $('stat-done').textContent    = state.filesDone;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function appendLog(text) {
  logEl.textContent += text;
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

function recalcOutputPaths() {
  for (const f of state.files) {
    const name = f.name.replace(/\.[^.]+$/, '');
    f.output_path = state.outputFolder + '/' + name + '.hevc.mkv';
  }
}

// ── Comprobación de actualizaciones de ffmpeg ─────────────────────────────
//
// Estrategia: comparamos la versión instalada con la última publicada en
// evermeet.cx (fuente de las builds estáticas macOS que usa la app).
// La comprobación solo se hace una vez cada 24 h para no molestar.

const VERSION_URL         = 'https://b265.uverse.es/version.json';
const APP_VERSION         = '0.1.0';
const UPDATE_CHECK_KEY    = 'behevc_last_update_check';
const UPDATE_INTERVAL_MS  = 24 * 60 * 60 * 1000; // 24 horas

// Ruta de datos de usuario — se rellena al arrancar
let appDataDir = null;

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
    if (latestApp && latestApp !== APP_VERSION) {
      appendLog(`\n💡 Nueva versión de BeHEVC disponible: ${latestApp} (instalada: ${APP_VERSION})\n`);
      appendLog(`   Descárgala en https://b265.uverse.es\n`);
      btnCheckUpdate.title = `BeHEVC ${latestApp} disponible`;
      btnCheckUpdate.textContent = `↑ BeHEVC ${latestApp}`;
      btnCheckUpdate.hidden = false;
      btnCheckUpdate.dataset.updateUrl = 'https://b265.uverse.es/#downloads';
    }

    // ── Comprobar versión de ffmpeg ───────────────────────────────────────
    const latestFfmpeg = data?.ffmpeg?.recommended_version;
    if (latestFfmpeg && installedFfmpegVersion && latestFfmpeg !== installedFfmpegVersion) {
      appendLog(`\n💡 Nueva versión de ffmpeg recomendada: ${latestFfmpeg} (instalada: ${installedFfmpegVersion})\n`);
      if (appDataDir) {
        appendLog(`   Descarga ffmpeg + ffprobe de https://evermeet.cx/ffmpeg/\n`);
        appendLog(`   y colócalos en: ${appDataDir}\n`);
        appendLog(`   (clic en "↑ Actualizar ffmpeg" para abrir esa carpeta)\n`);
      }
      // Solo mostrar el botón de ffmpeg si no hay actualización de la app
      if (btnCheckUpdate.hidden) {
        btnCheckUpdate.textContent = '↑ Actualizar ffmpeg';
        btnCheckUpdate.title = 'Abrir carpeta y página de descarga de ffmpeg';
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

// ── Arranque ──────────────────────────────────────────────────────────────

init();
