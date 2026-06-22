// lib.rs — núcleo de la aplicación Tauri
//
// Aquí se definen:
// 1. Los "commands" que el frontend (JS) puede llamar via invoke()
// 2. El estado compartido de la app (flag de cancelación)
// 3. El arranque de la aplicación

mod converter;
mod detector;
mod estimator;
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
    /// Flag de cancelación: cuando se pone a true, el converter para de inmediato
    /// (mata el ffmpeg en curso y descarta el archivo a medias).
    pub cancelled: Arc<Mutex<bool>>,
    /// Flag de pausa: los workers terminan el archivo activo pero NO toman más
    /// trabajos de la cola. Los archivos en curso NO se cortan.
    pub paused: Arc<Mutex<bool>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(Mutex::new(false)),
            paused: Arc::new(Mutex::new(false)),
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
    /// Tamaño del archivo en bytes
    pub size: u64,
    /// Bitrate del vídeo en bits/s (0 si desconocido)
    pub bitrate: u64,
    /// Bits por píxel por frame (None si faltan datos) — señal de sobre-codificación
    pub bpp: Option<f64>,
    /// Margen de recompresión para HEVC: "high" | "medium" | "low" (None si no aplica)
    pub margin: Option<String>,
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

/// Devuelve la versión de la app tomada del bundle (Cargo.toml / tauri.conf.json).
/// Fuente única de verdad: evita versiones hardcodeadas en el frontend.
#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Nº de conversiones simultáneas por defecto: la mitad de los núcleos lógicos,
/// mínimo 1. La codificación de vídeo ya usa muchos hilos, así que no conviene
/// lanzar tantas conversiones como núcleos.
fn default_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).max(1))
        .unwrap_or(1)
}

/// Núcleos lógicos del sistema y concurrencia recomendada (para la UI).
#[tauri::command]
fn get_cpu_info() -> (usize, usize) {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    (cores, default_concurrency())
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
    container: Option<String>,
) -> Vec<FileInfo> {
    let container = container.unwrap_or_else(|| "mkv".to_string());
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

            // Sonda única: codec + resolución + fps + bitrate + duración → BPP y margen.
            let info = detector::probe_media(&file, &ffprobe_path);
            let already_hevc = detector::is_hevc(info.codec.as_deref());
            let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);

            let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("output");
            let output_name = format!("{}.hevc.{}", stem, container);
            let output_path = output_dir.join(&output_name);

            results.push(FileInfo {
                path: file.to_string_lossy().to_string(),
                name: file.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string(),
                codec: info.codec,
                needs_conversion: !already_hevc,
                output_path: output_path.to_string_lossy().to_string(),
                size,
                bitrate: info.bitrate,
                bpp: info.bpp,
                margin: info.margin,
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
    concurrency: Option<usize>,
    lang: Option<String>,
) -> Result<(), String> {
    let lang = lang.unwrap_or_else(|| "es".to_string());
    // Resetear el flag de cancelación
    *state.cancelled.lock().unwrap() = false;
    *state.paused.lock().unwrap() = false;

    // Nº de conversiones en paralelo. Por defecto: la mitad de los núcleos
    // (la codificación de vídeo ya es muy multihilo), mínimo 1.
    let concurrency = concurrency.unwrap_or_else(default_concurrency).max(1);

    // Clonar los Arc para pasarlos al hilo de conversión
    let cancelled = Arc::clone(&state.cancelled);
    let paused    = Arc::clone(&state.paused);

    // Validar/crear la carpeta de destino ANTES de arrancar.
    // Tras reinicios o con discos externos/red desmontados, una carpeta recordada
    // puede ya no existir: damos un error claro en vez de un fallo críptico de ffmpeg.
    let en = lang == "en";
    if let Some(dir) = jobs.first().and_then(|j| Path::new(&j.output).parent()) {
        if let Err(e) = std::fs::create_dir_all(dir) {
            return Err(if en {
                format!("Cannot access the output folder:\n{}\n\n{}\n\nIs the disk connected/mounted?", dir.display(), e)
            } else {
                format!("No se puede acceder a la carpeta de destino:\n{}\n\n{}\n\n¿Está el disco conectado/montado?", dir.display(), e)
            });
        }
        // Comprobar que realmente se puede escribir (solo lectura, red, permisos…)
        let probe = dir.join(".behevc_write_test");
        match std::fs::File::create(&probe) {
            Ok(_) => { let _ = std::fs::remove_file(&probe); }
            Err(e) => {
                return Err(if en {
                    format!("The output folder is not writable:\n{}\n\n{}", dir.display(), e)
                } else {
                    format!("La carpeta de destino no permite escritura:\n{}\n\n{}", dir.display(), e)
                });
            }
        }
    }

    // Clonamos lo necesario para mover al hilo (Rust requiere que todo lo que entra
    // en un thread sea 'owned', no referencias)
    let app_clone = app.clone();
    let jobs_for_backup = jobs.clone();
    let lang_for_thread = lang.clone();

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
                paused,
                concurrency,
                lang.clone(),
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

            let en = lang_for_thread == "en";
            let err_note = if errors > 0 {
                if en { format!(" ({} not moved due to error)", errors) }
                else  { format!(" ({} sin mover por error)", errors) }
            } else { String::new() };
            let msg = if en {
                format!("✔ Backup: {} original(s) moved to {}{}\n", moved, backup_dir, err_note)
            } else {
                format!("✔ Backup: {} original(es) movido(s) a {}{}\n", moved, backup_dir, err_note)
            };
            let _ = app_clone.emit("backup-done", msg);
        }
    });

    Ok(())
}

/// Señala al hilo de conversión que debe parar lo antes posible
/// (mata el ffmpeg en curso y descarta el archivo a medias).
#[tauri::command]
fn cancel_conversion(state: State<'_, AppState>) {
    *state.cancelled.lock().unwrap() = true;
}

/// Pausa elegante: los workers terminan el archivo activo pero no toman más
/// trabajos de la cola. Las conversiones en curso NO se cortan.
#[tauri::command]
fn pause_conversion(state: State<'_, AppState>) {
    *state.paused.lock().unwrap() = true;
}

/// Precálculo de ahorro por muestreo (3.0). Lanza el análisis en un hilo aparte;
/// el progreso/resultados llegan por eventos `estimate-progress`/`estimate-result`/`estimate-done`.
#[tauri::command]
async fn estimate_savings(
    app: AppHandle,
    paths: Vec<String>,
    settings: converter::ConversionSettings,
    ffmpeg_path: String,
    ffprobe_path: String,
    concurrency: Option<usize>,
    vmaf: Option<bool>,
    target_vmaf: Option<f64>,
) -> Result<(), String> {
    let concurrency = concurrency.unwrap_or_else(default_concurrency).max(1);
    let with_vmaf = vmaf.unwrap_or(true);
    std::thread::spawn(move || {
        estimator::run_estimation(
            app, paths, settings, ffmpeg_path, ffprobe_path,
            concurrency, with_vmaf, target_vmaf,
        );
    });
    Ok(())
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

/// Información de un encoder de hardware disponible, enviada al frontend.
#[derive(Debug, Clone, Serialize)]
pub struct HwEncoder {
    /// Id del encoder para ffmpeg (ej: "hevc_videotoolbox")
    pub id: String,
    /// Etiqueta legible para la UI (ej: "Apple VideoToolbox")
    pub label: String,
}

/// Lista los encoders HEVC de hardware disponibles en el binario de ffmpeg.
///
/// Ejecuta `ffmpeg -encoders` y comprueba qué encoders de hardware están
/// compilados. Nota: que el encoder exista en el binario no garantiza que la
/// GPU/driver esté presente en la máquina; si falla en tiempo de conversión,
/// el reintento degrada a software automáticamente.
#[tauri::command]
fn list_hw_encoders(ffmpeg_path: String) -> Vec<HwEncoder> {
    let output = match std::process::Command::new(&ffmpeg_path)
        .args(["-hide_banner", "-encoders"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    let text = String::from_utf8_lossy(&output.stdout);

    // (id de ffmpeg, etiqueta para la UI) — solo se ofrecen los presentes
    // y que tengan sentido en la plataforma actual.
    let candidates: &[(&str, &str)] = &[
        ("hevc_videotoolbox", "Apple VideoToolbox"),
        ("hevc_nvenc",        "NVIDIA NVENC"),
        ("hevc_qsv",          "Intel Quick Sync"),
        ("hevc_amf",          "AMD AMF"),
        ("hevc_vaapi",        "VAAPI (Linux)"),
    ];

    candidates
        .iter()
        .filter(|(id, _)| text.contains(id))
        .map(|(id, label)| HwEncoder { id: id.to_string(), label: label.to_string() })
        .collect()
}

/// Persiste la cola de archivos en app_data_dir/queue.json.
/// Si queue_json está vacío, elimina el archivo (limpia la cola guardada).
#[tauri::command]
fn save_queue(app: AppHandle, queue_json: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("queue.json");
    if queue_json.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    std::fs::write(&path, queue_json).map_err(|e| e.to_string())
}

/// Carga la cola guardada. Devuelve None si no existe.
#[tauri::command]
fn load_queue(app: AppHandle) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    let path = dir.join("queue.json");
    std::fs::read_to_string(&path).ok()
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
        .plugin(tauri_plugin_notification::init())
        // Registrar todos los commands que el JS puede llamar
        .invoke_handler(tauri::generate_handler![
            get_ffmpeg_paths,
            get_ffmpeg_version,
            get_app_data_dir,
            get_app_version,
            get_cpu_info,
            pick_video_files,
            pick_folder,
            scan_files,
            start_conversion,
            cancel_conversion,
            pause_conversion,
            estimate_savings,
            open_folder,
            open_url,
            list_hw_encoders,
            save_queue,
            load_queue,
        ])
        .run(tauri::generate_context!())
        .expect("Error arrancando BeHEVC");
}
