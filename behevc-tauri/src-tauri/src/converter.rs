// converter.rs — conversión a HEVC con ffmpeg, gestión de errores y progreso

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionSettings {
    pub use_hardware: bool,
    pub crf: u8,
    pub preset: String,
}

impl Default for ConversionSettings {
    fn default() -> Self {
        Self { use_hardware: false, crf: 28, preset: "medium".to_string() }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub file_index:      usize,
    pub total_files:     usize,
    pub file_name:       String,
    pub file_progress:   f64,
    pub global_progress: f64,
    pub log:             String,
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
// Función principal — devuelve Vec<bool> (true = convertido con éxito)
// ---------------------------------------------------------------------------

pub fn run_conversion(
    app: AppHandle,
    jobs: Vec<ConversionJob>,
    settings: ConversionSettings,
    ffmpeg_path: String,
    ffprobe_path: String,
    cancelled: Arc<Mutex<bool>>,
) -> Vec<bool> {
    let total = jobs.len();
    let mut successes = vec![false; total];

    for (index, job) in jobs.iter().enumerate() {

        // Comprobar cancelación al inicio de cada archivo
        if *cancelled.lock().unwrap() {
            emit_log(&app, index, total, "", 0.0, 0.0, "\nConversión cancelada.\n");
            let _ = app.emit("conversion-done", "cancelled");
            return successes;
        }

        let input_path = Path::new(&job.input);
        let file_name  = input_path.file_name()
            .and_then(|n| n.to_str()).unwrap_or("?").to_string();

        emit_log(&app, index, total, &file_name, 0.0,
            index as f64 / total as f64,
            &format!("\n[{}/{}] {}\n", index + 1, total, file_name));

        // Obtener duración para la barra de archivo
        let duration = get_duration(input_path, &ffprobe_path);

        // Crear carpeta de salida si no existe
        if let Some(parent) = Path::new(&job.output).parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        // ── Intento 1: mapeo completo (sin cover art) ──────────────────────
        let (exit_ok, was_cancelled) = run_ffmpeg_pass(
            &app, index, total, &file_name, duration,
            &job.input, &job.output,
            &settings, &ffmpeg_path,
            &MappingMode::Full,
            &cancelled,
        );

        if was_cancelled {
            let _ = std::fs::remove_file(&job.output);
            let _ = app.emit("conversion-done", "cancelled");
            return successes;
        }

        let output_valid = exit_ok && validate_output(&job.output);

        // ── Intento 2 (fallback): solo vídeo + audio ───────────────────────
        let (exit_ok2, was_cancelled2) = if !output_valid {
            // Limpiar el intento fallido antes del retry
            let _ = std::fs::remove_file(&job.output);
            emit_log(&app, index, total, &file_name, 0.0,
                index as f64 / total as f64,
                &format!("⚠ {} — intento 1 fallido, reintentando sin subtítulos/datos…\n", file_name));

            run_ffmpeg_pass(
                &app, index, total, &file_name, duration,
                &job.input, &job.output,
                &settings, &ffmpeg_path,
                &MappingMode::PrimaryOnly,
                &cancelled,
            )
        } else {
            (true, false)
        };

        if was_cancelled2 {
            let _ = std::fs::remove_file(&job.output);
            let _ = app.emit("conversion-done", "cancelled");
            return successes;
        }

        // ── Evaluar resultado final ────────────────────────────────────────
        // output_valid: el intento 1 produjo un archivo bueno
        // final_valid:  el intento 2 (fallback) produjo un archivo bueno
        let final_valid = if !output_valid { validate_output(&job.output) } else { true };

        if output_valid || final_valid {
            successes[index] = true;
            emit_log(&app, index, total, &file_name, 1.0,
                (index + 1) as f64 / total as f64,
                &format!("✔ {} convertido correctamente\n", file_name));
        } else {
            // Ambos intentos fallaron — limpiar salida parcial
            let _ = std::fs::remove_file(&job.output);
            let reason = if !exit_ok && !exit_ok2 {
                "ffmpeg terminó con error en ambos intentos"
            } else {
                "archivo de salida vacío o inválido tras ambos intentos"
            };
            emit_log(&app, index, total, &file_name, 0.0,
                index as f64 / total as f64,
                &format!("❌ {} — {}\n   → original intacto, no se moverá a backup\n",
                    file_name, reason));
        }
    }

    let _ = app.emit("conversion-done", "completed");
    successes
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
            emit_log(app, index, total, file_name, 0.0, 0.0,
                &format!("❌ Error lanzando ffmpeg: {}\n   → original intacto en su ubicación\n", e));
            return (false, false);
        }
    };

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Canal mpsc: ambos hilos envían (file_progress, log_line)
    let (tx, rx) = mpsc::channel::<(f64, String)>();

    // Hilo 1: stdout → progreso estructurado (out_time_us=...)
    let tx1        = tx.clone();
    let duration_c = duration;
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().filter_map(|l| l.ok()) {
            if line.starts_with("out_time_us=") {
                if let Ok(us) = line["out_time_us=".len()..].trim().parse::<f64>() {
                    if us > 0.0 {
                        let fp = if duration_c > 0.0 {
                            (us / 1_000_000.0 / duration_c).min(1.0)
                        } else {
                            0.0
                        };
                        let _ = tx1.send((fp, String::new()));
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
                let _ = tx2.send((-1.0, line));
            }
        }
    });

    // Hilo principal: recibir y emitir eventos
    let mut user_cancelled = false;
    for (fp, log) in &rx {
        if *cancelled.lock().unwrap() {
            let _ = child.kill();
            for _ in rx.try_iter() {} // vaciar el canal para liberar los hilos
            user_cancelled = true;
            break;
        }
        let gp = (index as f64 + fp.max(0.0)) / total as f64;
        let _ = app.emit("conversion-progress", ProgressEvent {
            file_index: index, total_files: total,
            file_name: file_name.to_string(),
            file_progress: fp, global_progress: gp,
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

/// Comprueba que el archivo existe y tiene un tamaño mínimo razonable (> 10 KB)
fn validate_output(path: &str) -> bool {
    let p = Path::new(path);
    if !p.exists() { return false; }
    std::fs::metadata(p)
        .map(|m| m.len() > 10_240) // > 10 KB
        .unwrap_or(false)
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

    args.extend(["-y".into(), "-i".into(), input.to_string()]);
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

    // Codec de vídeo
    if settings.use_hardware {
        #[cfg(target_os = "macos")]
        {
            args.extend(["-c:v".into(), "hevc_videotoolbox".into()]);
            args.extend(["-q:v".into(), "65".into()]);
            args.extend(["-tag:v".into(), "hvc1".into()]);
        }
        #[cfg(not(target_os = "macos"))]
        {
            args.extend(["-c:v".into(), "libx265".into()]);
            args.extend(["-crf".into(), settings.crf.to_string()]);
            args.extend(["-preset".into(), settings.preset.clone()]);
            args.extend(["-tag:v".into(), "hvc1".into()]);
        }
    } else {
        args.extend(["-c:v".into(), "libx265".into()]);
        args.extend(["-crf".into(), settings.crf.to_string()]);
        args.extend(["-preset".into(), settings.preset.clone()]);
        args.extend(["-tag:v".into(), "hvc1".into()]);
    }

    args.extend(["-c:a".into(), "copy".into()]);
    if matches!(mode, MappingMode::Full) {
        args.extend(["-c:s".into(), "copy".into()]);
        args.extend(["-c:d".into(), "copy".into()]);
    }

    args.push(output.to_string());
    args
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

fn emit_log(app: &AppHandle, fi: usize, tf: usize, name: &str, fp: f64, gp: f64, log: &str) {
    let _ = app.emit("conversion-progress", ProgressEvent {
        file_index: fi, total_files: tf,
        file_name: name.to_string(),
        file_progress: fp, global_progress: gp,
        log: log.to_string(),
    });
}
