// estimator.rs — precálculo de ahorro por muestreo (3.0)
//
// Para estimar cuánto pesaría un archivo recomprimido SIN codificarlo entero,
// codificamos 3 trozos cortos (al 10/50/90% de la duración) con los ajustes
// objetivo, sumamos su tamaño y extrapolamos al total. Es una estimación
// (±10-15% por variación entre escenas), no una garantía.

use std::collections::VecDeque;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::converter::{append_video_codec_args, ConversionSettings};
use crate::detector::get_duration;

/// Resultado del precálculo de un archivo, enviado al frontend.
#[derive(Debug, Clone, Serialize)]
pub struct EstimateResult {
    pub index:          usize,
    pub original_size:  u64,
    pub estimated_size: u64,
    pub savings_pct:    f64,         // puede ser negativo si saldría más grande
    pub vmaf:           Option<f64>, // calidad media de las muestras (None si no medida)
    pub ok:             bool,        // false si no se pudo estimar
}

/// Progreso del precálculo de un lote.
#[derive(Debug, Clone, Serialize)]
struct EstimateProgress {
    current: usize,
    total:   usize,
}

const SAMPLE_POSITIONS: [f64; 3] = [0.10, 0.50, 0.90];
const SAMPLE_SECONDS:   f64       = 4.0;

/// Estima en paralelo el ahorro de cada archivo. Emite `estimate-result` por
/// archivo, `estimate-progress` para avance, y `estimate-done` al terminar.
pub fn run_estimation(
    app: AppHandle,
    paths: Vec<String>,
    settings: ConversionSettings,
    ffmpeg_path: String,
    ffprobe_path: String,
    concurrency: usize,
    with_vmaf: bool,
) {
    let total = paths.len();
    if total == 0 {
        let _ = app.emit("estimate-done", ());
        return;
    }

    let paths        = Arc::new(paths);
    let settings     = Arc::new(settings);
    let ffmpeg_path  = Arc::new(ffmpeg_path);
    let ffprobe_path = Arc::new(ffprobe_path);
    let queue = Arc::new(Mutex::new((0..total).collect::<VecDeque<usize>>()));
    let done  = Arc::new(Mutex::new(0usize));

    let workers = concurrency.max(1).min(total);

    let handles: Vec<_> = (0..workers).map(|_| {
        let app          = app.clone();
        let paths        = Arc::clone(&paths);
        let settings     = Arc::clone(&settings);
        let ffmpeg_path  = Arc::clone(&ffmpeg_path);
        let ffprobe_path = Arc::clone(&ffprobe_path);
        let queue        = Arc::clone(&queue);
        let done         = Arc::clone(&done);

        std::thread::spawn(move || {
            loop {
                let index = match queue.lock().unwrap().pop_front() {
                    Some(i) => i,
                    None    => break,
                };
                let result = estimate_one(
                    index, &paths[index], settings.as_ref(),
                    ffmpeg_path.as_str(), ffprobe_path.as_str(), with_vmaf,
                );
                let _ = app.emit("estimate-result", &result);

                let mut d = done.lock().unwrap();
                *d += 1;
                let _ = app.emit("estimate-progress", EstimateProgress { current: *d, total });
            }
        })
    }).collect();

    for h in handles { let _ = h.join(); }
    let _ = app.emit("estimate-done", ());
}

fn estimate_one(
    index: usize,
    path: &str,
    settings: &ConversionSettings,
    ffmpeg_path: &str,
    ffprobe_path: &str,
    with_vmaf: bool,
) -> EstimateResult {
    let fail = EstimateResult {
        index, original_size: 0, estimated_size: 0, savings_pct: 0.0, vmaf: None, ok: false,
    };

    let original_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let duration = get_duration(Path::new(path), ffprobe_path);
    if original_size == 0 || duration <= 0.0 {
        return fail;
    }

    let tmp_dir = std::env::temp_dir();
    let mut sample_bytes = 0u64;
    let mut sampled_secs = 0.0f64;
    let mut vmaf_scores: Vec<f64> = Vec::new();

    for (i, pos) in SAMPLE_POSITIONS.iter().enumerate() {
        let start = duration * pos;
        let dur = SAMPLE_SECONDS.min((duration - start).max(0.0));
        if dur < 0.5 { continue; }

        let tmp = tmp_dir.join(format!("behevc_sample_{}_{}.mkv", index, i));
        let args = build_sample_args(path, start, dur, settings, &tmp.to_string_lossy());

        let ran = Command::new(ffmpeg_path).args(&args).output();
        let mut sample_ok = false;
        if let Ok(out) = ran {
            if out.status.success() {
                if let Ok(m) = std::fs::metadata(&tmp) {
                    sample_bytes += m.len();
                    sampled_secs += dur;
                    sample_ok = true;
                }
            }
        }

        // Calidad: VMAF de la muestra recomprimida vs el trozo original
        if with_vmaf && sample_ok {
            if let Some(v) = measure_vmaf(&tmp.to_string_lossy(), path, start, dur, ffmpeg_path) {
                vmaf_scores.push(v);
            }
        }

        let _ = std::fs::remove_file(&tmp);
    }

    if sample_bytes == 0 || sampled_secs <= 0.0 {
        return fail;
    }

    // Extrapolar: bytes por segundo de muestra × duración total
    let estimated = ((sample_bytes as f64 / sampled_secs) * duration) as u64;
    let savings = (1.0 - estimated as f64 / original_size as f64) * 100.0;
    let vmaf = if vmaf_scores.is_empty() {
        None
    } else {
        Some(vmaf_scores.iter().sum::<f64>() / vmaf_scores.len() as f64)
    };

    EstimateResult {
        index,
        original_size,
        estimated_size: estimated,
        savings_pct: savings,
        vmaf,
        ok: true,
    }
}

/// Mide el VMAF de una muestra recomprimida (`distorted`) contra el trozo
/// equivalente del original. Devuelve None si libvmaf no está o falla.
/// Lee el score de stderr ("VMAF score: NN.NN") para evitar rutas de log con
/// caracteres a escapar (problemático en Windows).
fn measure_vmaf(distorted: &str, original: &str, start: f64, dur: f64, ffmpeg_path: &str) -> Option<f64> {
    let out = Command::new(ffmpeg_path)
        .args([
            "-hide_banner",
            "-i", distorted,                          // [0:v] = distorsionado
            "-ss", &format!("{:.3}", start),
            "-t",  &format!("{:.3}", dur),
            "-i", original,                           // [1:v] = referencia
            "-lavfi", "[0:v][1:v]libvmaf",
            "-f", "null", "-",
        ])
        .output()
        .ok()?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    parse_vmaf(&stderr)
}

/// Extrae el score de la línea "VMAF score: NN.NN" de la salida de ffmpeg.
fn parse_vmaf(stderr: &str) -> Option<f64> {
    for line in stderr.lines() {
        if let Some(idx) = line.find("VMAF score:") {
            let rest = &line[idx + "VMAF score:".len()..];
            if let Ok(v) = rest.trim().parse::<f64>() {
                return Some(v);
            }
        }
    }
    None
}

/// Argumentos de ffmpeg para codificar UN trozo de muestra con los ajustes objetivo.
/// Mismo codec/calidad que la conversión real (para que el tamaño sea representativo);
/// solo vídeo + audio principal, sin subtítulos/datos (irrelevantes para el tamaño).
fn build_sample_args(input: &str, start: f64, dur: f64,
                     settings: &ConversionSettings, output: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    args.push("-y".into());

    // VAAPI necesita el device antes del -i (igual que en la conversión real)
    if settings.encoder == "hevc_vaapi" {
        args.extend(["-vaapi_device".into(), "/dev/dri/renderD128".into()]);
    }

    // Seek de entrada (rápido) + duración del trozo
    args.extend(["-ss".into(), format!("{:.3}", start)]);
    args.extend(["-t".into(),  format!("{:.3}", dur)]);
    args.extend(["-i".into(), input.to_string()]);

    args.extend(["-map".into(), "0:v:0".into()]);
    args.extend(["-map".into(), "0:a?".into()]);

    // Mismo codec de vídeo que la conversión real
    append_video_codec_args(&mut args, settings);

    // Audio coherente con el ajuste elegido
    if settings.audio == "aac" {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    } else {
        args.extend(["-c:a".into(), "copy".into()]);
    }

    args.extend(["-f".into(), "matroska".into()]);
    args.push(output.to_string());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::converter::ConversionSettings;

    #[test]
    fn sample_args_seek_before_input() {
        let s = ConversionSettings::default();
        let a = build_sample_args("in.mkv", 12.5, 4.0, &s, "out.mkv");
        let ss = a.iter().position(|x| x == "-ss").unwrap();
        let i  = a.iter().position(|x| x == "-i").unwrap();
        assert!(ss < i, "el -ss debe ir antes del -i (seek de entrada rápido)");
        assert!(a.iter().any(|x| x == "0:v:0"));
        assert!(a.iter().any(|x| x == "matroska"));
    }

    #[test]
    fn vmaf_parsing() {
        let log = "frame=  100 fps=...\n[libvmaf @ 0x..] VMAF score: 96.512345\n";
        assert!((parse_vmaf(log).unwrap() - 96.512345).abs() < 1e-4);
        assert_eq!(parse_vmaf("sin score aquí"), None);
    }
}
