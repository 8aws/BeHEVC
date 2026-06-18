// detector.rs — detección de codec de vídeo mediante ffprobe
//
// Esta es la pieza clave que faltaba en la versión Swift:
// preguntamos a ffprobe qué codec tiene el archivo antes de decidir si convertir.

use std::path::Path;
use std::process::Command;

/// Devuelve true si el codec detectado YA es HEVC/H.265 (no hay que convertirlo).
/// Opera sobre el codec ya detectado para no repetir la llamada a ffprobe.
/// Si no se pudo detectar (None), asumimos que hay que convertirlo.
pub fn is_hevc(codec: Option<&str>) -> bool {
    codec == Some("hevc")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hevc_detection() {
        assert!(is_hevc(Some("hevc")));
        assert!(!is_hevc(Some("h264")));
        assert!(!is_hevc(Some("av1")));
        // Codec desconocido → conviene convertir (no es HEVC)
        assert!(!is_hevc(None));
    }

    #[test]
    fn fps_parsing() {
        assert!((parse_fps("25/1") - 25.0).abs() < 1e-9);
        assert!((parse_fps("30000/1001") - 29.970).abs() < 0.01);
        assert_eq!(parse_fps(""), 0.0);
        assert_eq!(parse_fps("24"), 24.0);
    }

    #[test]
    fn margin_classification() {
        assert_eq!(recompress_margin(0.20), "high");   // muy sobre-codificado (p. ej. hardware)
        assert_eq!(recompress_margin(0.10), "high");
        assert_eq!(recompress_margin(0.07), "medium");
        assert_eq!(recompress_margin(0.05), "medium");
        assert_eq!(recompress_margin(0.03), "low");    // ya eficiente
    }
}

// ---------------------------------------------------------------------------
// Sonda de medios (3.0): métricas de origen para evaluar recompresión
// ---------------------------------------------------------------------------

/// Métricas del stream de vídeo, obtenidas en una sola llamada a ffprobe.
#[derive(Debug, Clone, Default)]
pub struct MediaInfo {
    pub codec:    Option<String>,
    pub width:    u32,
    pub height:   u32,
    pub fps:      f64,
    pub bitrate:  u64,  // bits/s (del stream, o del formato como fallback)
    pub duration: f64,  // segundos
    pub pix_fmt:  Option<String>,
    /// Bits por píxel por frame: bitrate / (ancho·alto·fps). None si faltan datos.
    pub bpp:      Option<f64>,
    /// Margen de recompresión para HEVC: "high" | "medium" | "low". None si no aplica.
    pub margin:   Option<String>,
}

/// Analiza un archivo y devuelve sus métricas de vídeo en UNA sola llamada a ffprobe.
/// Sustituye a detect_video_codec + get_duration cuando se necesita todo junto.
pub fn probe_media(path: &Path, ffprobe_path: &str) -> MediaInfo {
    let mut info = MediaInfo::default();
    let path_str = match path.to_str() { Some(s) => s, None => return info };

    let output = Command::new(ffprobe_path)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,r_frame_rate,bit_rate,pix_fmt",
            "-show_entries", "format=duration,bit_rate",
            "-of", "json",
            path_str,
        ])
        .output();

    let out = match output { Ok(o) => o, Err(_) => return info };
    let json: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(_) => return info,
    };

    if let Some(s) = json["streams"].get(0) {
        info.codec   = s["codec_name"].as_str().map(|c| c.to_lowercase());
        info.width   = s["width"].as_u64().unwrap_or(0) as u32;
        info.height  = s["height"].as_u64().unwrap_or(0) as u32;
        info.pix_fmt = s["pix_fmt"].as_str().map(|p| p.to_string());
        info.fps     = parse_fps(s["r_frame_rate"].as_str().unwrap_or(""));
        // bit_rate viene como string en el JSON de ffprobe (o "N/A")
        info.bitrate = s["bit_rate"].as_str().and_then(|b| b.parse::<u64>().ok()).unwrap_or(0);
    }

    info.duration = json["format"]["duration"].as_str()
        .and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);

    // Muchos MKV no guardan bit_rate por stream → usar el del contenedor como aproximación
    if info.bitrate == 0 {
        info.bitrate = json["format"]["bit_rate"].as_str()
            .and_then(|b| b.parse::<u64>().ok()).unwrap_or(0);
    }

    // BPP y margen (solo tiene sentido el margen en HEVC)
    if info.width > 0 && info.height > 0 && info.fps > 0.0 && info.bitrate > 0 {
        let bpp = info.bitrate as f64 / (info.width as f64 * info.height as f64 * info.fps);
        info.bpp = Some(bpp);
        if is_hevc(info.codec.as_deref()) {
            info.margin = Some(recompress_margin(bpp).to_string());
        }
    }

    info
}

/// Convierte "30000/1001" o "25/1" a fps decimal.
fn parse_fps(r: &str) -> f64 {
    let mut parts = r.split('/');
    let num = parts.next().and_then(|n| n.parse::<f64>().ok()).unwrap_or(0.0);
    let den = parts.next().and_then(|d| d.parse::<f64>().ok()).unwrap_or(1.0);
    if den != 0.0 { num / den } else { 0.0 }
}

/// Clasifica el margen de recompresión de un HEVC según su BPP (bits/píxel/frame).
/// Umbral orientativo: HEVC "bien" comprimido suele estar por debajo de ~0.05 BPP.
pub fn recompress_margin(bpp: f64) -> &'static str {
    if bpp >= 0.10 { "high" }
    else if bpp >= 0.05 { "medium" }
    else { "low" }
}

/// Etiquetas de color del stream (para preservar HDR al recomprimir).
#[derive(Debug, Clone, Default)]
pub struct ColorTags {
    pub primaries: Option<String>,  // ej: bt2020
    pub transfer:  Option<String>,  // ej: smpte2084 (PQ) / arib-std-b67 (HLG)
    pub space:     Option<String>,  // ej: bt2020nc
}

/// Lee las etiquetas de color del vídeo. Solo devuelve valores "señalables"
/// (descarta unknown/reserved/N/A) para no forzar metadatos inválidos.
pub fn probe_color(path: &Path, ffprobe_path: &str) -> ColorTags {
    let mut tags = ColorTags::default();
    let path_str = match path.to_str() { Some(s) => s, None => return tags };

    let output = Command::new(ffprobe_path)
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=color_primaries,color_transfer,color_space",
            "-of", "json",
            path_str,
        ])
        .output();

    let out = match output { Ok(o) => o, Err(_) => return tags };
    let json: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v, Err(_) => return tags,
    };
    if let Some(s) = json["streams"].get(0) {
        tags.primaries = clean_color(s["color_primaries"].as_str());
        tags.transfer  = clean_color(s["color_transfer"].as_str());
        tags.space     = clean_color(s["color_space"].as_str());
    }
    tags
}

fn clean_color(v: Option<&str>) -> Option<String> {
    match v {
        Some(s) if !s.is_empty()
            && s != "unknown" && s != "reserved" && s != "N/A" => Some(s.to_string()),
        _ => None,
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
