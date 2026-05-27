// scanner.rs — escaneo de archivos de vídeo
//
// Acepta un path que puede ser un archivo suelto o una carpeta.
// Si es carpeta, recorre todo el árbol recursivamente buscando vídeos.

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Extensiones de vídeo reconocidas (en minúsculas)
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v",
    "mpg", "mpeg", "ts", "m2ts", "mts", "webm", "vob",
    "divx", "xvid", "3gp", "ogv", "rm", "rmvb",
];

/// Dado un path (archivo o carpeta), devuelve todos los archivos de vídeo encontrados.
pub fn scan_for_videos(path: &Path) -> Vec<PathBuf> {
    if path.is_file() {
        // Es un archivo suelto: comprobamos si es vídeo y lo devolvemos
        if is_video_file(path) {
            return vec![path.to_path_buf()];
        }
        return vec![];
    }

    if path.is_dir() {
        // Es una carpeta: recorremos todo su contenido recursivamente
        return WalkDir::new(path)
            .follow_links(false)          // No seguimos enlaces simbólicos (seguridad)
            .sort_by_file_name()          // Orden alfabético para reproducibilidad
            .into_iter()
            .filter_map(|entry| entry.ok())               // Ignoramos errores de permisos
            .filter(|entry| entry.file_type().is_file())  // Solo archivos, no carpetas
            .map(|entry| entry.into_path())
            .filter(|p| is_video_file(p))
            .collect();
    }

    vec![]
}

/// Comprueba si un archivo tiene extensión de vídeo conocida
fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| VIDEO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}
