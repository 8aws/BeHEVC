// main.rs — punto de entrada de la aplicación
//
// #![cfg_attr(...)] desactiva la ventana de consola en Windows
// cuando compilamos en modo release (el usuario no ve una terminal negra)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Toda la lógica real está en lib.rs
    // Esto permite que Tauri genere bindings para móvil si hace falta
    behevc_lib::run();
}
