// detector.rs — detección de codec de vídeo mediante ffprobe
//
// Esta es la pieza clave que faltaba en la versión Swift:
// preguntamos a ffprobe qué codec tiene el archivo antes de decidir si convertir.

use std::path::Path;
use std::process::Command;

/// Devuelve el nombre del codec de vídeo (ej: "hevc", "h264", "vp9", "av1")
/// Devuelve None si no puede leerlo (archivo corrupto, no es vídeo, etc.)
pub fn detect_video_codec(path: &Path, ffprobe_path: &str) -> Option<String> {
    let output = Command::new(ffprobe_path)
        .args([
            "-v", "error",                                    // Solo mostrar errores, no info extra
            "-select_streams", "v:0",                         // Solo el primer stream de vídeo
            "-show_entries", "stream=codec_name",             // Queremos: codec_name
            "-of", "default=noprint_wrappers=1:nokey=1",      // Formato limpio: solo el valor
            path.to_str()?,
        ])
        .output()
        .ok()?;

    let codec = String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .to_lowercase();

    if codec.is_empty() {
        None
    } else {
        Some(codec)
    }
}

/// Devuelve true si el archivo YA está en formato HEVC/H.265 (no hay que convertirlo)
pub fn is_hevc(path: &Path, ffprobe_path: &str) -> bool {
    match detect_video_codec(path, ffprobe_path) {
        // ffprobe devuelve "hevc" para H.265/HEVC
        Some(codec) => codec == "hevc",
        // Si no podemos detectarlo, asumimos que hay que convertirlo
        None => false,
    }
}

/// Obtiene la duración del vídeo en segundos (para calcular el progreso de conversión)
pub fn get_duration(path: &Path, ffprobe_path: &str) -> f64 {
    let output = Command::new(ffprobe_path)
        .args([
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path.to_str().unwrap_or(""),
        ])
        .output();

    match output {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            s.trim().parse::<f64>().unwrap_or(0.0)
        }
        Err(_) => 0.0,
    }
}
