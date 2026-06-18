// converter.rs — conversión a HEVC con ffmpeg, gestión de errores y progreso

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::detector::get_duration;

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionJob {
    pub input: String,
    pub output: String,
    /// true si es una recompresión de un HEVC existente (3.0). En ese caso, si el
    /// resultado no es más pequeño que el original, se descarta y se conserva el original.
    #[serde(default)]
    pub recompress: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionSettings {
    /// Encoder a usar. Software: "libx265". Hardware (según plataforma):
    /// "hevc_videotoolbox" (macOS), "hevc_nvenc" (NVIDIA), "hevc_qsv" (Intel),
    /// "hevc_amf" (AMD/Windows), "hevc_vaapi" (Linux).
    #[serde(default = "default_encoder")]
    pub encoder: String,
    /// Calidad en escala CRF (menor = mejor). Se mapea a la escala de cada encoder.
    pub crf: u8,
    /// Preset de velocidad/compresión ("slow" | "medium" | "fast").
    pub preset: String,
    /// Tratamiento del audio: "copy" (sin recodificar) o "aac" (recodificar a AAC).
    #[serde(default = "default_audio")]
    pub audio: String,
}

fn default_encoder() -> String { "libx265".to_string() }
fn default_audio() -> String { "copy".to_string() }

impl ConversionSettings {
    /// true si el encoder seleccionado es de hardware (no libx265).
    pub fn is_hardware(&self) -> bool {
        self.encoder != "libx265"
    }
}

impl Default for ConversionSettings {
    fn default() -> Self {
        Self {
            encoder: default_encoder(),
            crf: 28,
            preset: "medium".to_string(),
            audio: default_audio(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub file_index:      usize,
    pub total_files:     usize,
    pub file_name:       String,
    pub file_progress:   f64,
    pub global_progress: f64,
    /// Velocidad de codificación reportada por ffmpeg (ej: 2.5 = 2.5×). 0 si desconocida.
    pub speed:           f64,
    /// Segundos estimados restantes para el archivo actual. 0 si desconocido.
    pub eta:             f64,
    pub log:             String,
}

/// Emitido al terminar cada archivo con éxito: tamaños para calcular el ahorro.
#[derive(Debug, Clone, Serialize)]
pub struct FileDoneEvent {
    pub file_index:    usize,
    pub original_size: u64,
    pub output_size:   u64,
}

// ---------------------------------------------------------------------------
// Modo de mapeo de streams
// ---------------------------------------------------------------------------

/// Estrategia de mapeo de streams usada al construir los argumentos de ffmpeg.
pub enum MappingMode {
    /// Intento 1: todo menos cover art, con metadata completa.
    Full,
    /// Intento 2 (fallback): solo vídeo principal + audio. Sin subtítulos ni datos.
    PrimaryOnly,
}

// ---------------------------------------------------------------------------
// Estado de progreso compartido entre trabajadores en paralelo
// ---------------------------------------------------------------------------

/// Progreso (0..1) de cada archivo, indexado por su posición en `jobs`.
/// El progreso global es la media de todos los archivos.
type ProgressVec = Arc<Mutex<Vec<f64>>>;

fn set_progress(progresses: &ProgressVec, index: usize, value: f64) {
    if let Ok(mut v) = progresses.lock() {
        if index < v.len() { v[index] = value; }
    }
}

/// Progreso global = media del progreso de todos los archivos.
fn aggregate_global(progresses: &ProgressVec) -> f64 {
    match progresses.lock() {
        Ok(v) if !v.is_empty() => v.iter().sum::<f64>() / v.len() as f64,
        _ => 0.0,
    }
}

// ---------------------------------------------------------------------------
// Función principal — pool de trabajadores, devuelve Vec<bool> (true = éxito)
// ---------------------------------------------------------------------------

pub fn run_conversion(
    app: AppHandle,
    jobs: Vec<ConversionJob>,
    settings: ConversionSettings,
    ffmpeg_path: String,
    ffprobe_path: String,
    cancelled: Arc<Mutex<bool>>,
    paused: Arc<Mutex<bool>>,
    concurrency: usize,
) -> Vec<bool> {
    let total = jobs.len();
    if total == 0 {
        let _ = app.emit("conversion-done", "completed");
        return Vec::new();
    }

    // Estado compartido entre trabajadores
    let successes:  Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(vec![false; total]));
    let progresses: ProgressVec           = Arc::new(Mutex::new(vec![0.0_f64; total]));
    let queue = Arc::new(Mutex::new((0..total).collect::<VecDeque<usize>>()));

    // Datos de solo-lectura compartidos
    let jobs         = Arc::new(jobs);
    let settings     = Arc::new(settings);
    let ffmpeg_path  = Arc::new(ffmpeg_path);
    let ffprobe_path = Arc::new(ffprobe_path);

    // Nº de trabajadores: al menos 1, nunca más que archivos
    let workers = concurrency.max(1).min(total);

    let handles: Vec<_> = (0..workers).map(|_| {
        let app          = app.clone();
        let successes    = Arc::clone(&successes);
        let progresses   = Arc::clone(&progresses);
        let queue        = Arc::clone(&queue);
        let jobs         = Arc::clone(&jobs);
        let settings     = Arc::clone(&settings);
        let ffmpeg_path  = Arc::clone(&ffmpeg_path);
        let ffprobe_path = Arc::clone(&ffprobe_path);
        let cancelled    = Arc::clone(&cancelled);
        let paused       = Arc::clone(&paused);

        std::thread::spawn(move || {
            loop {
                if *cancelled.lock().unwrap() { break; }
                // Pausa elegante: no tomamos más trabajos, pero NO cortamos los
                // que ya estén en curso (cada worker simplemente deja de pedir).
                if *paused.lock().unwrap() { break; }
                // Tomar el siguiente índice de la cola compartida
                let index = match queue.lock().unwrap().pop_front() {
                    Some(i) => i,
                    None    => break, // no quedan trabajos
                };
                let ok = process_one_file(
                    &app, index, total, &jobs[index],
                    settings.as_ref(), ffmpeg_path.as_str(), ffprobe_path.as_str(),
                    &cancelled, &progresses,
                );
                successes.lock().unwrap()[index] = ok;
            }
        })
    }).collect();

    for h in handles { let _ = h.join(); }

    // Determinar el estado final con el que avisamos al frontend
    let status = if *cancelled.lock().unwrap() {
        "cancelled".to_string()
    } else if *paused.lock().unwrap() {
        // Pausado: quedan trabajos en la cola sin empezar
        let remaining = queue.lock().unwrap().len();
        format!("paused:{}", remaining)
    } else {
        "completed".to_string()
    };
    let _ = app.emit("conversion-done", status);

    Arc::try_unwrap(successes).ok()
        .and_then(|m| m.into_inner().ok())
        .unwrap_or_else(|| vec![false; total])
}

// ---------------------------------------------------------------------------
// Procesar un único archivo (dos intentos: completo → fallback software)
// ---------------------------------------------------------------------------

fn process_one_file(
    app:          &AppHandle,
    index:        usize,
    total:        usize,
    job:          &ConversionJob,
    settings:     &ConversionSettings,
    ffmpeg_path:  &str,
    ffprobe_path: &str,
    cancelled:    &Arc<Mutex<bool>>,
    progresses:   &ProgressVec,
) -> bool {
    if *cancelled.lock().unwrap() { return false; }

    let input_path = Path::new(&job.input);
    let file_name  = input_path.file_name()
        .and_then(|n| n.to_str()).unwrap_or("?").to_string();

    set_progress(progresses, index, 0.0);
    emit_log(app, progresses, index, total, &file_name, 0.0,
        &format!("\n[{}/{}] {}\n", index + 1, total, file_name));

    let duration = get_duration(input_path, ffprobe_path);

    if let Some(parent) = Path::new(&job.output).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // ── Intento 1: mapeo completo (sin cover art) ──────────────────────────
    let (exit_ok, was_cancelled) = run_ffmpeg_pass(
        app, index, total, &file_name, duration,
        &job.input, &job.output,
        settings, ffmpeg_path,
        &MappingMode::Full,
        cancelled, progresses,
    );
    if was_cancelled {
        let _ = std::fs::remove_file(&job.output);
        return false;
    }

    let output_valid = exit_ok && validate_output(&job.output, ffprobe_path, duration);

    // ── Intento 2 (fallback): solo vídeo + audio, en software ──────────────
    let (exit_ok2, was_cancelled2) = if !output_valid {
        let _ = std::fs::remove_file(&job.output);

        let mut fallback_settings = settings.clone();
        let note = if fallback_settings.is_hardware() {
            fallback_settings.encoder = "libx265".to_string();
            "reintentando en software (libx265) sin subtítulos/datos"
        } else {
            "reintentando sin subtítulos/datos"
        };
        emit_log(app, progresses, index, total, &file_name, 0.0,
            &format!("⚠ {} — intento 1 fallido, {}…\n", file_name, note));

        run_ffmpeg_pass(
            app, index, total, &file_name, duration,
            &job.input, &job.output,
            &fallback_settings, ffmpeg_path,
            &MappingMode::PrimaryOnly,
            cancelled, progresses,
        )
    } else {
        (true, false)
    };
    if was_cancelled2 {
        let _ = std::fs::remove_file(&job.output);
        return false;
    }

    // ── Evaluar resultado final ────────────────────────────────────────────
    let final_valid = if !output_valid { validate_output(&job.output, ffprobe_path, duration) } else { true };

    if output_valid || final_valid {
        set_progress(progresses, index, 1.0);

        // Tamaños para calcular el ahorro de espacio
        let original_size = std::fs::metadata(input_path).map(|m| m.len()).unwrap_or(0);
        let output_size   = std::fs::metadata(&job.output).map(|m| m.len()).unwrap_or(0);

        // Seguridad de recompresión (3.0): si recomprimir un HEVC NO encoge, descartar
        // el resultado y conservar el original intacto. Nunca empeorar un archivo.
        if job.recompress && original_size > 0 && output_size >= original_size {
            let _ = std::fs::remove_file(&job.output);
            let _ = app.emit("file-optimal", index);
            emit_log(app, progresses, index, total, &file_name, 1.0,
                &format!("↔ {} ya estaba óptimo: recomprimir no ahorra ({} → {}); original conservado\n",
                    file_name, human_size(original_size), human_size(output_size)));
            return false; // no cuenta como convertido; el original no se mueve a backup
        }

        let _ = app.emit("file-done", FileDoneEvent {
            file_index: index, original_size, output_size,
        });

        let saved = if original_size > 0 && output_size > 0 && output_size < original_size {
            format!(" · {} → {} (−{:.0}%)",
                human_size(original_size), human_size(output_size),
                (1.0 - output_size as f64 / original_size as f64) * 100.0)
        } else {
            String::new()
        };
        emit_log(app, progresses, index, total, &file_name, 1.0,
            &format!("✔ {} convertido correctamente{}\n", file_name, saved));
        true
    } else {
        let _ = std::fs::remove_file(&job.output);
        let reason = if !exit_ok && !exit_ok2 {
            "ffmpeg terminó con error en ambos intentos"
        } else if exit_ok || exit_ok2 {
            "ffmpeg terminó sin error pero el archivo de salida está truncado o es demasiado pequeño \
             (posible error de disco, espacio insuficiente, o fallo de memoria durante la codificación)"
        } else {
            "archivo de salida vacío o inválido tras ambos intentos"
        };
        emit_log(app, progresses, index, total, &file_name, 0.0,
            &format!("❌ {} — {}\n   → original intacto, no se moverá a backup\n",
                file_name, reason));
        false
    }
}

// ---------------------------------------------------------------------------
// Lanzar un único pase de ffmpeg y esperar su resultado
// ---------------------------------------------------------------------------

/// Retorna `(exit_ok, was_cancelled)`.
fn run_ffmpeg_pass(
    app:        &AppHandle,
    index:      usize,
    total:      usize,
    file_name:  &str,
    duration:   f64,
    input:      &str,
    output:     &str,
    settings:   &ConversionSettings,
    ffmpeg_path: &str,
    mode:       &MappingMode,
    cancelled:  &Arc<Mutex<bool>>,
    progresses: &ProgressVec,
) -> (bool, bool) {
    let args = build_ffmpeg_args(input, output, settings, mode);

    let mut child = match Command::new(ffmpeg_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            emit_log(app, progresses, index, total, file_name, 0.0,
                &format!("❌ Error lanzando ffmpeg: {}\n   → original intacto en su ubicación\n", e));
            return (false, false);
        }
    };

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Canal mpsc: ambos hilos envían (file_progress, speed, log_line).
    // fp >= 0 → mensaje de progreso; fp == -1 → línea de log.
    let (tx, rx) = mpsc::channel::<(f64, f64, String)>();

    // Hilo 1: stdout → progreso estructurado (out_time_us=..., speed=...)
    let tx1        = tx.clone();
    let duration_c = duration;
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut last_speed = 0.0_f64; // ffmpeg emite speed en líneas separadas
        for line in reader.lines().filter_map(|l| l.ok()) {
            if let Some(v) = line.strip_prefix("speed=") {
                // formato "speed=2.53x" (o "N/A" al arrancar)
                last_speed = v.trim().trim_end_matches('x').parse::<f64>().unwrap_or(last_speed);
            } else if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<f64>() {
                    if us > 0.0 {
                        let fp = if duration_c > 0.0 {
                            (us / 1_000_000.0 / duration_c).min(1.0)
                        } else {
                            0.0
                        };
                        let _ = tx1.send((fp, last_speed, String::new()));
                    }
                }
            }
        }
    });

    // Hilo 2: stderr → info/warnings/errores
    let tx2         = tx;
    let cancelled_c = cancelled.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().filter_map(|l| l.ok()) {
            if *cancelled_c.lock().unwrap() { break; }
            if !line.is_empty() {
                let _ = tx2.send((-1.0, 0.0, line));
            }
        }
    });

    // Hilo principal: recibir y emitir eventos
    let mut user_cancelled = false;
    for (fp, speed, log) in &rx {
        if *cancelled.lock().unwrap() {
            let _ = child.kill();
            for _ in rx.try_iter() {} // vaciar el canal para liberar los hilos
            user_cancelled = true;
            break;
        }
        // Actualizar el progreso de este archivo y recalcular el global (media)
        if fp >= 0.0 { set_progress(progresses, index, fp); }
        let gp = aggregate_global(progresses);
        // ETA del archivo: segundos restantes / velocidad de codificación
        let eta = if fp >= 0.0 && speed > 0.0 && duration > 0.0 {
            (duration * (1.0 - fp) / speed).max(0.0)
        } else {
            0.0
        };
        let _ = app.emit("conversion-progress", ProgressEvent {
            file_index: index, total_files: total,
            file_name: file_name.to_string(),
            file_progress: fp, global_progress: gp,
            speed, eta,
            log,
        });
    }

    if user_cancelled {
        return (false, true);
    }

    let exit_ok = child.wait().map(|s| s.success()).unwrap_or(false);
    (exit_ok, false)
}

// ---------------------------------------------------------------------------
// Validación del archivo de salida
// ---------------------------------------------------------------------------

/// Valida que el archivo de salida es un vídeo real y completo.
///
/// Realiza dos comprobaciones:
///
/// 1. **Tamaño mínimo proporcional**: si conocemos la duración del original,
///    el archivo debe pesar al menos 5 KB/s (≈ 40 kbps — límite absurdamente
///    bajo para HEVC, pero suficiente para detectar archivos casi vacíos).
///    Para archivos < 60 s o duración desconocida se exige mínimo 512 KB.
///
/// 2. **Duración real** (ffprobe sobre la salida): debe ser ≥ 90 % de la
///    duración original. Detecta casos en que el contenedor MKV/MP4 contiene
///    un header correcto pero el cuerpo del vídeo está truncado.
fn validate_output(path: &str, ffprobe_path: &str, expected_duration: f64) -> bool {
    let p = Path::new(path);
    if !p.exists() { return false; }

    let size = match std::fs::metadata(p) {
        Ok(m) => m.len(),
        Err(_) => return false,
    };

    // ── 1. Tamaño mínimo ──────────────────────────────────────────────────
    if expected_duration > 60.0 {
        // 5 KB/s × duración esperada en segundos
        let min_bytes = (expected_duration * 5_000.0) as u64;
        if size < min_bytes {
            return false;
        }
    } else {
        // Sin duración fiable: mínimo absoluto de 512 KB
        if size < 512_000 {
            return false;
        }
    }

    // ── 2. Duración real por ffprobe ──────────────────────────────────────
    if expected_duration > 0.0 {
        let actual = get_duration(p, ffprobe_path);
        // Si ffprobe devuelve algo, debe ser ≥ 90 % del original
        if actual > 0.0 && actual < expected_duration * 0.90 {
            return false;
        }
    }

    true
}

// ---------------------------------------------------------------------------
// Construcción de argumentos ffmpeg
// ---------------------------------------------------------------------------

fn build_ffmpeg_args(
    input: &str,
    output: &str,
    settings: &ConversionSettings,
    mode: &MappingMode,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    args.push("-y".into());

    // VAAPI necesita inicializar el dispositivo GPU ANTES del input.
    if settings.encoder == "hevc_vaapi" {
        args.extend(["-vaapi_device".into(), "/dev/dri/renderD128".into()]);
    }

    args.extend(["-i".into(), input.to_string()]);
    args.extend(["-progress".into(), "pipe:1".into()]);
    args.extend(["-nostats".into()]);

    match mode {
        MappingMode::Full => {
            // Mapeo selectivo: solo el PRIMER stream de vídeo (evita cover art/thumbnail
            // embebidos en MOV/MP4 que fallan al intentar recodificarlos como HEVC),
            // más todos los streams de audio, subtítulos y datos.
            args.extend(["-map".into(), "0:v:0".into()]);   // primer vídeo
            args.extend(["-map".into(), "0:a?".into()]);    // todos los audios (opcional)
            args.extend(["-map".into(), "0:s?".into()]);    // todos los subtítulos (opcional)
            args.extend(["-map".into(), "0:d?".into()]);    // datos/adjuntos (opcional)
            args.extend(["-map_metadata".into(), "0".into()]);  // metadatos (título, fecha…)
            args.extend(["-map_chapters".into(), "0".into()]);  // capítulos
            args.extend(["-ignore_unknown".into()]);
        }
        MappingMode::PrimaryOnly => {
            // Fallback mínimo: solo vídeo principal + audio. Sin subtítulos ni datos
            // para evitar conflictos de contenedor o streams incompatibles.
            args.extend(["-map".into(), "0:v:0".into()]);
            args.extend(["-map".into(), "0:a?".into()]);
            args.extend(["-map_metadata".into(), "0".into()]);
            args.extend(["-map_chapters".into(), "0".into()]);
        }
    }

    // Codec de vídeo — args específicos según el encoder seleccionado.
    append_video_codec_args(&mut args, settings);

    // Audio: copiar tal cual o recodificar a AAC (máxima compatibilidad).
    if settings.audio == "aac" {
        args.extend(["-c:a".into(), "aac".into()]);
        args.extend(["-b:a".into(), "192k".into()]);
    } else {
        args.extend(["-c:a".into(), "copy".into()]);
    }

    if matches!(mode, MappingMode::Full) {
        // Subtítulos: MP4 solo admite mov_text; MKV copia cualquier formato.
        if output.to_lowercase().ends_with(".mp4") {
            args.extend(["-c:s".into(), "mov_text".into()]);
        } else {
            args.extend(["-c:s".into(), "copy".into()]);
            args.extend(["-c:d".into(), "copy".into()]);
        }
    }

    args.push(output.to_string());
    args
}

/// Añade los argumentos del codec de vídeo según el encoder elegido.
///
/// El usuario elige la calidad en escala CRF (22/28/34 ≈ alta/equilibrado/más
/// compresión). Cada encoder de hardware usa su propia escala de calidad, así
/// que mapeamos el CRF al parámetro equivalente de cada uno.
pub(crate) fn append_video_codec_args(args: &mut Vec<String>, s: &ConversionSettings) {
    let crf = s.crf.to_string();

    match s.encoder.as_str() {
        // ── Apple Silicon / Intel Mac ──────────────────────────────────────
        "hevc_videotoolbox" => {
            args.extend(["-c:v".into(), "hevc_videotoolbox".into()]);
            // q:v 0-100 (mayor = mejor). Invertimos el CRF a esa escala.
            let q = (118i32 - 2 * s.crf as i32).clamp(20, 90);
            args.extend(["-q:v".into(), q.to_string()]);
        }
        // ── NVIDIA ─────────────────────────────────────────────────────────
        "hevc_nvenc" => {
            args.extend(["-c:v".into(), "hevc_nvenc".into()]);
            args.extend(["-rc".into(), "vbr".into()]);
            args.extend(["-cq".into(), crf]); // misma escala 0-51 que CRF
            args.extend(["-preset".into(), nvenc_preset(&s.preset).into()]);
        }
        // ── Intel Quick Sync ───────────────────────────────────────────────
        "hevc_qsv" => {
            args.extend(["-c:v".into(), "hevc_qsv".into()]);
            args.extend(["-global_quality".into(), crf]);
            args.extend(["-preset".into(), s.preset.clone()]);
        }
        // ── AMD (Windows) ──────────────────────────────────────────────────
        "hevc_amf" => {
            args.extend(["-c:v".into(), "hevc_amf".into()]);
            args.extend(["-rc".into(), "cqp".into()]);
            args.extend(["-qp_i".into(), crf.clone()]);
            args.extend(["-qp_p".into(), crf]);
        }
        // ── Linux VAAPI (el device se inicializó antes del -i) ──────────────
        "hevc_vaapi" => {
            args.extend(["-vf".into(), "format=nv12,hwupload".into()]);
            args.extend(["-c:v".into(), "hevc_vaapi".into()]);
            args.extend(["-qp".into(), crf]);
        }
        // ── Software (por defecto) ─────────────────────────────────────────
        _ => {
            args.extend(["-c:v".into(), "libx265".into()]);
            args.extend(["-crf".into(), crf]);
            args.extend(["-preset".into(), s.preset.clone()]);
        }
    }

    // Tag hvc1 para máxima compatibilidad con reproductores Apple.
    args.extend(["-tag:v".into(), "hvc1".into()]);
}

/// Formatea un tamaño en bytes a una cadena legible (KB/MB/GB).
fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB      { format!("{:.2} GB", b / GB) }
    else if b >= MB { format!("{:.0} MB", b / MB) }
    else            { format!("{:.0} KB", b / KB) }
}

/// Traduce el preset genérico (slow/medium/fast) al esquema p1-p7 de NVENC.
fn nvenc_preset(preset: &str) -> &'static str {
    match preset {
        "slow" => "p6",
        "fast" => "p2",
        _      => "p4", // medium
    }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/// Emite un mensaje de log/estado. El progreso global se calcula como la media
/// del progreso de todos los archivos (coherente con la ejecución en paralelo).
fn emit_log(app: &AppHandle, progresses: &ProgressVec, fi: usize, tf: usize,
            name: &str, fp: f64, log: &str) {
    let _ = app.emit("conversion-progress", ProgressEvent {
        file_index: fi, total_files: tf,
        file_name: name.to_string(),
        file_progress: fp, global_progress: aggregate_global(progresses),
        speed: 0.0, eta: 0.0,
        log: log.to_string(),
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(encoder: &str, audio: &str) -> ConversionSettings {
        ConversionSettings {
            encoder: encoder.to_string(),
            crf: 28,
            preset: "medium".to_string(),
            audio: audio.to_string(),
        }
    }

    /// Devuelve el valor que sigue inmediatamente a `flag` en los args.
    fn value_after(args: &[String], flag: &str) -> Option<String> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1).cloned())
    }

    fn contains(args: &[String], v: &str) -> bool {
        args.iter().any(|a| a == v)
    }

    #[test]
    fn software_uses_crf_and_preset() {
        let s = settings("libx265", "copy");
        let args = build_ffmpeg_args("in.mp4", "out.mkv", &s, &MappingMode::Full);
        assert_eq!(value_after(&args, "-c:v").as_deref(), Some("libx265"));
        assert_eq!(value_after(&args, "-crf").as_deref(), Some("28"));
        assert_eq!(value_after(&args, "-preset").as_deref(), Some("medium"));
        assert_eq!(value_after(&args, "-tag:v").as_deref(), Some("hvc1"));
    }

    #[test]
    fn videotoolbox_maps_crf_to_quality() {
        let s = settings("hevc_videotoolbox", "copy");
        let args = build_ffmpeg_args("in.mp4", "out.mkv", &s, &MappingMode::Full);
        assert_eq!(value_after(&args, "-c:v").as_deref(), Some("hevc_videotoolbox"));
        // q:v = 118 - 2*28 = 62
        assert_eq!(value_after(&args, "-q:v").as_deref(), Some("62"));
        assert!(!contains(&args, "-crf"));
    }

    #[test]
    fn nvenc_uses_cq_and_mapped_preset() {
        let mut s = settings("hevc_nvenc", "copy");
        s.preset = "slow".to_string();
        let args = build_ffmpeg_args("in.mp4", "out.mkv", &s, &MappingMode::Full);
        assert_eq!(value_after(&args, "-c:v").as_deref(), Some("hevc_nvenc"));
        assert_eq!(value_after(&args, "-cq").as_deref(), Some("28"));
        assert_eq!(value_after(&args, "-preset").as_deref(), Some("p6"));
    }

    #[test]
    fn vaapi_inits_device_before_input() {
        let s = settings("hevc_vaapi", "copy");
        let args = build_ffmpeg_args("in.mp4", "out.mkv", &s, &MappingMode::Full);
        let dev = args.iter().position(|a| a == "-vaapi_device").unwrap();
        let inp = args.iter().position(|a| a == "-i").unwrap();
        assert!(dev < inp, "el device VAAPI debe inicializarse antes del input");
    }

    #[test]
    fn audio_copy_vs_aac() {
        let copy = build_ffmpeg_args("in.mp4", "out.mkv", &settings("libx265", "copy"), &MappingMode::Full);
        assert_eq!(value_after(&copy, "-c:a").as_deref(), Some("copy"));

        let aac = build_ffmpeg_args("in.mp4", "out.mkv", &settings("libx265", "aac"), &MappingMode::Full);
        assert_eq!(value_after(&aac, "-c:a").as_deref(), Some("aac"));
        assert_eq!(value_after(&aac, "-b:a").as_deref(), Some("192k"));
    }

    #[test]
    fn mp4_uses_mov_text_subtitles() {
        let s = settings("libx265", "copy");
        let mp4 = build_ffmpeg_args("in.mkv", "out.mp4", &s, &MappingMode::Full);
        assert_eq!(value_after(&mp4, "-c:s").as_deref(), Some("mov_text"));
        assert!(!contains(&mp4, "-c:d"), "MP4 no debe copiar streams de datos");

        let mkv = build_ffmpeg_args("in.mkv", "out.mkv", &s, &MappingMode::Full);
        assert_eq!(value_after(&mkv, "-c:s").as_deref(), Some("copy"));
        assert!(contains(&mkv, "-c:d"));
    }

    #[test]
    fn primary_only_drops_subtitles() {
        let s = settings("libx265", "copy");
        let args = build_ffmpeg_args("in.mkv", "out.mkv", &s, &MappingMode::PrimaryOnly);
        assert!(!contains(&args, "-c:s"));
        assert!(!contains(&args, "0:s?"));
    }

    #[test]
    fn nvenc_preset_mapping() {
        assert_eq!(nvenc_preset("slow"), "p6");
        assert_eq!(nvenc_preset("medium"), "p4");
        assert_eq!(nvenc_preset("fast"), "p2");
        assert_eq!(nvenc_preset("desconocido"), "p4");
    }

    #[test]
    fn human_size_units() {
        assert_eq!(human_size(2048), "2 KB");
        assert_eq!(human_size(5 * 1024 * 1024), "5 MB");
        assert_eq!(human_size(2 * 1024 * 1024 * 1024), "2.00 GB");
    }

    #[test]
    fn aggregate_global_is_mean() {
        let p: ProgressVec = Arc::new(Mutex::new(vec![0.0, 0.5, 1.0]));
        assert!((aggregate_global(&p) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn settings_hardware_detection() {
        assert!(!settings("libx265", "copy").is_hardware());
        assert!(settings("hevc_nvenc", "copy").is_hardware());
    }
}
