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
    pub optimal_crf:    Option<u8>,  // CRF óptimo encontrado por búsqueda VMAF (None si no se buscó)
    pub ok:             bool,        // false si no se pudo estimar
}

/// Progreso del precálculo de un lote.
#[derive(Debug, Clone, Serialize)]
struct EstimateProgress {
    current: usize,
    total:   usize,
}

pub(crate) const SAMPLE_POSITIONS: [f64; 3] = [0.10, 0.50, 0.90];
pub(crate) const SAMPLE_SECONDS:   f64       = 4.0;

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
    target_vmaf: Option<f64>,
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
                    target_vmaf,
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
    target_vmaf: Option<f64>,
) -> EstimateResult {
    let fail = EstimateResult {
        index, original_size: 0, estimated_size: 0, savings_pct: 0.0,
        vmaf: None, optimal_crf: None, ok: false,
    };

    let original_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let duration = get_duration(Path::new(path), ffprobe_path);
    if original_size == 0 || duration <= 0.0 {
        return fail;
    }

    if let Some(target) = target_vmaf {
        return search_crf(index, path, target, settings, ffmpeg_path, duration, original_size);
    }

    let tmp_dir = std::env::temp_dir();
    let mut sample_bytes = 0u64;
    let mut sampled_secs = 0.0f64;
    let mut vmaf_scores: Vec<f64> = Vec::new();

    // Igual que la conversión real: si el encoder de hardware falla, se cae a software.
    // Estimamos con el encoder que de verdad acabaría usándose.
    let mut fallback = settings.clone();
    fallback.encoder = "libx265".to_string();

    for (i, pos) in SAMPLE_POSITIONS.iter().enumerate() {
        let start = duration * pos;
        let dur = SAMPLE_SECONDS.min((duration - start).max(0.0));
        if dur < 0.5 { continue; }

        let tmp = tmp_dir.join(format!("behevc_sample_{}_{}.mkv", index, i));
        let tmp_str = tmp.to_string_lossy().to_string();

        // Intento 1: encoder configurado. Si falla y era hardware, intento 2: software.
        let mut sample_ok = encode_sample(ffmpeg_path, path, start, dur, settings, &tmp_str);
        if !sample_ok && settings.is_hardware() {
            sample_ok = encode_sample(ffmpeg_path, path, start, dur, &fallback, &tmp_str);
        }
        if sample_ok {
            if let Ok(m) = std::fs::metadata(&tmp) {
                sample_bytes += m.len();
                sampled_secs += dur;
            } else {
                sample_ok = false;
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
        optimal_crf: None,
        ok: true,
    }
}

/// Mide el VMAF de una muestra recomprimida (`distorted`) contra el trozo
/// equivalente del original. Extrae primero un clip de referencia con el mismo
/// seek que se usó para codificar la muestra, evitando desincronización de frames.
fn measure_vmaf(distorted: &str, original: &str, start: f64, dur: f64, ffmpeg_path: &str) -> Option<f64> {
    let tmp_ref = std::env::temp_dir().join("b265_vmaf_ref.mkv");
    let ref_str = tmp_ref.to_string_lossy().to_string();
    let ref_ok = Command::new(ffmpeg_path)
        .args(["-y", "-ss", &format!("{:.3}", start), "-t", &format!("{:.3}", dur),
               "-i", original, "-c", "copy", "-f", "matroska", &ref_str])
        .output()
        .map(|o| o.status.success()).unwrap_or(false);
    if !ref_ok {
        let _ = std::fs::remove_file(&tmp_ref);
        return None;
    }
    let result = measure_vmaf_nosync(distorted, &ref_str, ffmpeg_path);
    let _ = std::fs::remove_file(&tmp_ref);
    result
}

/// Extrae el score de la línea "VMAF score: NN.NN" de la salida de ffmpeg.
pub(crate) fn parse_vmaf(stderr: &str) -> Option<f64> {
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

/// Codifica un trozo de muestra; devuelve true si ffmpeg terminó con éxito.
fn encode_sample(ffmpeg_path: &str, input: &str, start: f64, dur: f64,
                 settings: &ConversionSettings, output: &str) -> bool {
    let args = build_sample_args(input, start, dur, settings, output);
    match Command::new(ffmpeg_path).args(&args).output() {
        Ok(out) => out.status.success(),
        Err(_)  => false,
    }
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

// ---------------------------------------------------------------------------
// Búsqueda binaria de CRF por VMAF objetivo
// ---------------------------------------------------------------------------

fn search_crf(
    index: usize,
    path: &str,
    target: f64,
    settings: &ConversionSettings,
    ffmpeg_path: &str,
    duration: f64,
    original_size: u64,
) -> EstimateResult {
    let fail = EstimateResult {
        index, original_size, estimated_size: 0, savings_pct: 0.0,
        vmaf: None, optimal_crf: None, ok: false,
    };

    let tmp_dir = std::env::temp_dir();
    let start = duration * 0.5;
    let dur = SAMPLE_SECONDS.min((duration - start).max(0.0));
    if dur < 0.5 { return fail; }

    // Paso 0: extraer un clip de referencia (copia sin recodificar).
    // Todas las muestras se codifican DESDE este clip, y el VMAF se mide
    // contra este clip — así los frames siempre coinciden exactamente.
    let ref_clip = tmp_dir.join(format!("b265_ref_{}.mkv", index));
    let ref_str = ref_clip.to_string_lossy().to_string();
    let ref_ok = Command::new(ffmpeg_path)
        .args(["-y", "-ss", &format!("{:.3}", start), "-t", &format!("{:.3}", dur),
               "-i", path, "-c", "copy", "-f", "matroska", &ref_str])
        .output()
        .map(|o| o.status.success()).unwrap_or(false);
    if !ref_ok {
        let _ = std::fs::remove_file(&ref_clip);
        return fail;
    }

    let mut lo: u8 = 18;
    let mut hi: u8 = 40;
    let mut best_crf: Option<u8> = None;
    let mut best_vmaf: Option<f64> = None;
    let mut best_size: u64 = 0;
    let mut highest_vmaf: Option<f64> = None;

    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        let mut test = settings.clone();
        test.crf = mid;

        let tmp = tmp_dir.join(format!("b265_search_{}_{}.mkv", index, mid));
        let tmp_str = tmp.to_string_lossy().to_string();

        let mut fallback = test.clone();
        fallback.encoder = "libx265".to_string();

        // Codificar desde el clip de referencia (no desde el original)
        let mut ok = encode_sample(ffmpeg_path, &ref_str, 0.0, dur, &test, &tmp_str);
        if !ok && test.is_hardware() {
            ok = encode_sample(ffmpeg_path, &ref_str, 0.0, dur, &fallback, &tmp_str);
        }

        // VMAF: comparar distorsionado vs referencia (ambos empiezan en t=0, sin seek)
        let vmaf = if ok {
            measure_vmaf_nosync(&tmp.to_string_lossy(), &ref_str, ffmpeg_path)
        } else {
            None
        };

        let sample_size = if ok {
            std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0)
        } else { 0 };
        let _ = std::fs::remove_file(&tmp);

        match vmaf {
            Some(v) if v >= target => {
                best_crf = Some(mid);
                best_vmaf = Some(v);
                if dur > 0.0 && sample_size > 0 {
                    best_size = ((sample_size as f64 / dur) * duration) as u64;
                }
                if highest_vmaf.map_or(true, |h| v > h) { highest_vmaf = Some(v); }
                lo = mid + 1;
            }
            Some(v) => {
                if highest_vmaf.map_or(true, |h| v > h) { highest_vmaf = Some(v); }
                if mid == 0 { break; }
                hi = mid - 1;
            }
            None => {
                let _ = std::fs::remove_file(&ref_clip);
                return fail;
            }
        }
    }

    if let Some(crf) = best_crf {
        let _ = std::fs::remove_file(&ref_clip);
        let savings = if original_size > 0 && best_size > 0 {
            (1.0 - best_size as f64 / original_size as f64) * 100.0
        } else { 0.0 };
        EstimateResult {
            index, original_size, estimated_size: best_size,
            savings_pct: savings, vmaf: best_vmaf, optimal_crf: Some(crf), ok: true,
        }
    } else {
        // No se alcanzó el objetivo: ofrecer CRF 18 (máxima calidad posible)
        // con el VMAF real para que el usuario decida.
        // Estimar tamaño con CRF 18 desde el ref_clip (frame-accurate).
        let mut est_size = 0u64;
        let mut test18 = settings.clone();
        test18.crf = 18;
        let tmp18 = tmp_dir.join(format!("b265_search_{}_18f.mkv", index));
        let tmp18_str = tmp18.to_string_lossy().to_string();
        let mut fb18 = test18.clone();
        fb18.encoder = "libx265".to_string();
        let mut ok18 = encode_sample(ffmpeg_path, &ref_str, 0.0, dur, &test18, &tmp18_str);
        if !ok18 && test18.is_hardware() {
            ok18 = encode_sample(ffmpeg_path, &ref_str, 0.0, dur, &fb18, &tmp18_str);
        }
        if ok18 {
            if let Ok(m) = std::fs::metadata(&tmp18) {
                est_size = ((m.len() as f64 / dur) * duration) as u64;
            }
        }
        let _ = std::fs::remove_file(&tmp18);
        let _ = std::fs::remove_file(&ref_clip);
        let savings = if original_size > 0 && est_size > 0 {
            (1.0 - est_size as f64 / original_size as f64) * 100.0
        } else { 0.0 };
        EstimateResult {
            index, original_size, estimated_size: est_size, savings_pct: savings,
            vmaf: highest_vmaf, optimal_crf: Some(18), ok: true,
        }
    }
}

/// VMAF entre dos clips que empiezan en t=0 (sin seeking — frame-accurate).
fn measure_vmaf_nosync(distorted: &str, reference: &str, ffmpeg_path: &str) -> Option<f64> {
    let out = Command::new(ffmpeg_path)
        .args([
            "-hide_banner",
            "-i", distorted,
            "-i", reference,
            "-lavfi", "[0:v][1:v]libvmaf",
            "-f", "null", "-",
        ])
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    parse_vmaf(&stderr)
}

// ---------------------------------------------------------------------------
// Verificación VMAF post-conversión (usado por converter.rs)
// ---------------------------------------------------------------------------

/// Mide el VMAF medio de un archivo convertido vs el original, muestreando en
/// 3 posiciones (10/50/90%). Devuelve None si libvmaf no está o todas las
/// mediciones fallan.
pub(crate) fn verify_vmaf(
    input: &str,
    output: &str,
    duration: f64,
    ffmpeg_path: &str,
) -> Option<f64> {
    let mut scores = Vec::new();
    for pos in &SAMPLE_POSITIONS {
        let start = duration * pos;
        let dur = SAMPLE_SECONDS.min((duration - start).max(0.0));
        if dur < 0.5 { continue; }
        if let Some(v) = measure_vmaf_full(output, input, start, dur, ffmpeg_path) {
            scores.push(v);
        }
    }
    if scores.is_empty() { None }
    else { Some(scores.iter().sum::<f64>() / scores.len() as f64) }
}

/// VMAF entre dos archivos completos: extrae clips alineados y compara sin seek.
fn measure_vmaf_full(
    distorted: &str,
    original: &str,
    start: f64,
    dur: f64,
    ffmpeg_path: &str,
) -> Option<f64> {
    let tmp_dir = std::env::temp_dir();
    let clip_d = tmp_dir.join("b265_vf_dist.mkv");
    let clip_r = tmp_dir.join("b265_vf_ref.mkv");
    let ss = format!("{:.3}", start);
    let t  = format!("{:.3}", dur);

    let extract = |input: &str, out: &str| -> bool {
        Command::new(ffmpeg_path)
            .args(["-y", "-ss", &ss, "-t", &t, "-i", input, "-c", "copy", "-f", "matroska", out])
            .output().map(|o| o.status.success()).unwrap_or(false)
    };

    let ok = extract(distorted, &clip_d.to_string_lossy())
          && extract(original, &clip_r.to_string_lossy());
    let result = if ok {
        measure_vmaf_nosync(&clip_d.to_string_lossy(), &clip_r.to_string_lossy(), ffmpeg_path)
    } else { None };

    let _ = std::fs::remove_file(&clip_d);
    let _ = std::fs::remove_file(&clip_r);
    result
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
