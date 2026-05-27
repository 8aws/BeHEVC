// lib.rs — núcleo de la aplicación Tauri
//
// Aquí se definen:
// 1. Los "commands" que el frontend (JS) puede llamar via invoke()
// 2. El estado compartido de la app (flag de cancelación)
// 3. El arranque de la aplicación

mod converter;
mod detector;
mod scanner;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use converter::{ConversionJob, ConversionSettings};

// ---------------------------------------------------------------------------
// Estado global de la app
// ---------------------------------------------------------------------------

/// Estado compartido entre el hilo principal y el hilo de conversión
pub struct AppState {
    /// Flag de cancelación: cuando se pone a true, el converter para
    pub cancelled: Arc<Mutex<bool>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(Mutex::new(false)),
        }
    }
}

// ---------------------------------------------------------------------------
// Estructuras de datos del frontend
// ---------------------------------------------------------------------------

/// Información de un archivo analizado, enviada al frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    /// Ruta absoluta del archivo de entrada
    pub path: String,
    /// Solo el nombre del archivo (para mostrar en la lista)
    pub name: String,
    /// Codec detectado por ffprobe (ej: "h264", "hevc", "vp9")
    pub codec: Option<String>,
    /// true = hay que convertir; false = ya es HEVC, saltamos
    pub needs_conversion: bool,
    /// Ruta donde se guardará el archivo convertido
    pub output_path: String,
}

// ---------------------------------------------------------------------------
// Commands Tauri — son funciones Rust que el JS puede llamar
// ---------------------------------------------------------------------------

/// Detecta las rutas de ffmpeg y ffprobe.
///
/// Orden de búsqueda:
///   1. Carpeta de datos de la app (~/.../Application Support/com.behevc.app/)
///      → el usuario puede colocar aquí versiones actualizadas de ffmpeg/ffprobe
///   2. Carpeta Resources del bundle (binarios incluidos al compilar)
#[tauri::command]
fn get_ffmpeg_paths(app: AppHandle) -> (Option<String>, Option<String>) {
    // 1. Carpeta de datos de usuario (actualizable sin tocar el .app)
    let user_dir = app.path().app_data_dir().ok();

    // 2. Carpeta Resources del bundle
    let resource_dir = app.path().resource_dir().ok();

    let ffmpeg = user_dir.as_deref()
        .and_then(|d| find_binary(d, "ffmpeg"))
        .or_else(|| resource_dir.as_deref().and_then(|d| find_binary(d, "ffmpeg")));

    let ffprobe = user_dir.as_deref()
        .and_then(|d| find_binary(d, "ffprobe"))
        .or_else(|| resource_dir.as_deref().and_then(|d| find_binary(d, "ffprobe")));

    (ffmpeg, ffprobe)
}

/// Devuelve la ruta de la carpeta de datos de usuario de la app
/// (donde el usuario puede colocar versiones actualizadas de ffmpeg/ffprobe)
#[tauri::command]
fn get_app_data_dir(app: AppHandle) -> Option<String> {
    app.path().app_data_dir().ok()
        .map(|p| p.to_string_lossy().to_string())
}

/// Busca un binario (con o sin .exe en Windows) en un directorio
fn find_binary(dir: &Path, name: &str) -> Option<String> {
    // En Windows los ejecutables tienen extensión .exe
    let candidates = if cfg!(windows) {
        vec![format!("{}.exe", name), name.to_string()]
    } else {
        vec![name.to_string()]
    };

    for candidate in candidates {
        let path = dir.join(&candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

/// Abre el diálogo nativo de selección de archivos de vídeo
#[tauri::command]
async fn pick_video_files(app: AppHandle) -> Vec<String> {
    tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;

        app.dialog()
            .file()
            .add_filter(
                "Archivos de vídeo",
                &["mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v",
                  "mpg", "mpeg", "ts", "m2ts", "mts", "webm", "vob"],
            )
            .blocking_pick_files()  // Bloquea hasta que el usuario elige o cancela
            .map(|files| {
                files
                    .into_iter()
                    .filter_map(|f| f.into_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Abre el diálogo nativo de selección de carpeta
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;

        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .unwrap_or(None)
}

/// Progreso del análisis previo: emitido por scan_files para cada archivo detectado
#[derive(Debug, Clone, Serialize)]
struct ScanProgress {
    current: usize,
    total:   usize,
    file:    String,
}

/// Escanea una lista de paths (archivos o carpetas) y analiza el codec de cada vídeo.
/// Emite eventos "scan-progress" para que el frontend pueda mostrar avance en tiempo real.
#[tauri::command]
async fn scan_files(
    app: AppHandle,
    paths: Vec<String>,
    output_folder: String,
    ffprobe_path: String,
) -> Vec<FileInfo> {
    tokio::task::spawn_blocking(move || {
        let output_dir = PathBuf::from(&output_folder);
        let mut results: Vec<FileInfo> = Vec::new();

        // Primero recogemos todos los archivos de vídeo (rápido, solo sistema de archivos)
        let mut all_files: Vec<PathBuf> = Vec::new();
        for path_str in &paths {
            all_files.extend(scanner::scan_for_videos(Path::new(path_str)));
        }
        let total = all_files.len();

        for (index, file) in all_files.into_iter().enumerate() {
            // Emitir progreso ANTES de llamar a ffprobe (que es lo lento)
            let _ = app.emit("scan-progress", ScanProgress {
                current: index + 1,
                total,
                file: file.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string(),
            });

            // Preguntamos a ffprobe qué codec tiene
            let codec = detector::detect_video_codec(&file, &ffprobe_path);
            let already_hevc = detector::is_hevc(&file, &ffprobe_path);

            let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
            let output_name = format!("{}.hevc.mkv", stem);
            let output_path = output_dir.join(&output_name);

            results.push(FileInfo {
                path: file.to_string_lossy().to_string(),
                name: file.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string(),
                codec,
                needs_conversion: !already_hevc,
                output_path: output_path.to_string_lossy().to_string(),
            });
        }

        results
    })
    .await
    .unwrap_or_default()
}

/// Inicia la conversión de todos los trabajos en un hilo secundario.
/// Retorna inmediatamente; el progreso llega por eventos "conversion-progress" y "conversion-done".
#[tauri::command]
async fn start_conversion(
    app: AppHandle,
    state: State<'_, AppState>,
    jobs: Vec<ConversionJob>,
    settings: ConversionSettings,
    ffmpeg_path: String,
    ffprobe_path: String,
    backup_folder: Option<String>,
) -> Result<(), String> {
    // Resetear el flag de cancelación
    *state.cancelled.lock().unwrap() = false;

    // Clonar el Arc para pasarlo al hilo de conversión
    let cancelled = Arc::clone(&state.cancelled);

    // Crear la carpeta de destino si no existe
    if let Some(output_dir) = jobs.first().map(|j| Path::new(&j.output).parent()) {
        if let Some(dir) = output_dir {
            let _ = std::fs::create_dir_all(dir);
        }
    }

    // Clonamos lo necesario para mover al hilo (Rust requiere que todo lo que entra
    // en un thread sea 'owned', no referencias)
    let app_clone = app.clone();
    let jobs_for_backup = jobs.clone();

    // std::thread::spawn: lanza un hilo del SO (no async, no bloquea el runtime de Tauri)
    std::thread::spawn(move || {
        // catch_unwind captura panics de Rust para que el hilo no muera silenciosamente
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            converter::run_conversion(
                app_clone.clone(),
                jobs,
                settings,
                ffmpeg_path,
                ffprobe_path,
                cancelled,
            )
        }));

        // successes[i] = true solo si ese archivo se convirtió correctamente
        let successes = match result {
            Ok(s) => s,
            Err(_) => {
                // El hilo de conversión tuvo un panic inesperado
                let _ = app_clone.emit("conversion-done", "error");
                vec![false; jobs_for_backup.len()]
            }
        };

        // Mover a backup SOLO los archivos convertidos con éxito
        if let Some(backup_dir) = backup_folder {
            let backup_path = PathBuf::from(&backup_dir);
            let _ = std::fs::create_dir_all(&backup_path);

            let mut moved = 0usize;
            let mut errors = 0usize;

            for (job, &ok) in jobs_for_backup.iter().zip(successes.iter()) {
                if !ok { continue; } // No mover originales de conversiones fallidas

                let input = PathBuf::from(&job.input);
                if let Some(file_name) = input.file_name() {
                    let dest = backup_path.join(file_name);
                    // Intentar rename primero; si falla (distintos volúmenes) hacer copy+delete
                    let move_ok = std::fs::rename(&input, &dest).is_ok()
                        || (std::fs::copy(&input, &dest).is_ok()
                            && std::fs::remove_file(&input).is_ok());

                    if move_ok { moved += 1; } else { errors += 1; }
                }
            }

            let msg = format!(
                "✔ Backup: {} original(es) movido(s) a {}{}\n",
                moved,
                backup_dir,
                if errors > 0 { format!(" ({} sin mover por error)", errors) } else { String::new() }
            );
            let _ = app_clone.emit("backup-done", msg);
        }
    });

    Ok(())
}

/// Señala al hilo de conversión que debe parar lo antes posible
#[tauri::command]
fn cancel_conversion(state: State<'_, AppState>) {
    *state.cancelled.lock().unwrap() = true;
}

/// Abre una carpeta en el explorador de archivos nativo del sistema
#[tauri::command]
fn open_folder(path: String) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&path).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
}

/// Obtiene la versión de ffmpeg ejecutando `ffmpeg -version` y parseando la primera línea.
/// Devuelve algo como "7.1.1" o None si no se puede determinar.
#[tauri::command]
fn get_ffmpeg_version(ffmpeg_path: String) -> Option<String> {
    let output = std::process::Command::new(&ffmpeg_path)
        .arg("-version")
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Primera línea: "ffmpeg version 7.1.1 Copyright ..."
    let first_line = stdout.lines().next()?;
    // Extraer el token que sigue a "version "
    let version = first_line
        .split_whitespace()
        .skip_while(|&t| t != "version")
        .nth(1)?;

    Some(version.to_string())
}

/// Abre una URL en el navegador por defecto del sistema operativo
#[tauri::command]
fn open_url(url: String) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/c", "start", &url]).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
}

// ---------------------------------------------------------------------------
// Arranque de la aplicación
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        // Registrar el estado global (accesible en todos los commands via State<AppState>)
        .manage(AppState::default())
        // Registrar plugins
        .plugin(tauri_plugin_dialog::init())
        // Registrar todos los commands que el JS puede llamar
        .invoke_handler(tauri::generate_handler![
            get_ffmpeg_paths,
            get_ffmpeg_version,
            get_app_data_dir,
            pick_video_files,
            pick_folder,
            scan_files,
            start_conversion,
            cancel_conversion,
            open_folder,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("Error arrancando BeHEVC");
}
