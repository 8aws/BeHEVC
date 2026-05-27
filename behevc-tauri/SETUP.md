# BeHEVC — Guía de setup (macOS Silicon)

## 1. Prerrequisitos

### Xcode Command Line Tools
```bash
xcode-select --install
```

### Rust
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Cierra y abre el terminal, o ejecuta:
source ~/.cargo/env

# Verifica:
rustc --version   # rustc 1.xx.x
cargo --version   # cargo 1.xx.x
```

### Node.js
```bash
# Con Homebrew (recomendado):
brew install node

# O descarga desde https://nodejs.org (LTS)

# Verifica:
node --version   # v20.x.x
npm --version    # 10.x.x
```

### Tauri CLI
```bash
npm install -g @tauri-apps/cli@latest

# Verifica:
npx tauri --version   # tauri-cli x.x.x
```

---

## 2. Binarios de ffmpeg

Los binarios tienen que estar en `src-tauri/resources/` para que Tauri los incluya en el bundle.

### macOS Silicon (ARM64)

Descarga desde: https://evermeet.cx/ffmpeg/
- Descarga `ffmpeg` y `ffprobe` (versión "snapshot" o la más reciente)
- Son archivos zip con el binario dentro

```bash
# Copiar los binarios:
cp ~/Downloads/ffmpeg  behevc-tauri/src-tauri/resources/
cp ~/Downloads/ffprobe behevc-tauri/src-tauri/resources/

# Dar permisos de ejecución:
chmod +x behevc-tauri/src-tauri/resources/ffmpeg
chmod +x behevc-tauri/src-tauri/resources/ffprobe

# Quitar la cuarentena de macOS (obligatorio para binarios descargados):
xattr -d com.apple.quarantine behevc-tauri/src-tauri/resources/ffmpeg
xattr -d com.apple.quarantine behevc-tauri/src-tauri/resources/ffprobe

# Verificar que funcionan:
./behevc-tauri/src-tauri/resources/ffmpeg -version
./behevc-tauri/src-tauri/resources/ffprobe -version
```

---

## 3. Arrancar en modo desarrollo

```bash
cd behevc-tauri

# Instalar dependencias JS (solo la primera vez)
npm install

# Arrancar la app en modo dev (compila Rust + abre la ventana)
npm run dev
# O equivalentemente:
npx tauri dev
```

La primera compilación de Rust tarda varios minutos (descarga dependencias y compila ~300 crates).
Las siguientes son mucho más rápidas.

---

## 4. Compilar para distribución

```bash
npm run build
# O:
npx tauri build
```

El ejecutable final aparece en:
- **macOS:** `src-tauri/target/release/bundle/macos/BeHEVC.app`
- **macOS (dmg):** `src-tauri/target/release/bundle/dmg/BeHEVC_x.x.x_aarch64.dmg`

---

## 5. Para Windows y Linux

Necesitas compilar desde cada sistema operativo (o usar GitHub Actions).

### Windows
1. Instala Rust desde https://rustup.rs
2. Instala Visual Studio Build Tools 2022 (componente C++ necesario)
3. Instala Node.js desde https://nodejs.org
4. Descarga ffmpeg/ffprobe para Windows desde https://www.gyan.dev/ffmpeg/builds/
5. Copia `ffmpeg.exe` y `ffprobe.exe` en `src-tauri/resources/`
6. `npm install && npm run build`

### Linux (Ubuntu/Debian)
```bash
# Dependencias del sistema necesarias para Tauri
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev

# ffmpeg estático
# Descarga desde https://johnvansickle.com/ffmpeg/
chmod +x src-tauri/resources/ffmpeg src-tauri/resources/ffprobe

npm install && npm run build
```

---

## 6. Estructura del proyecto

```
behevc-tauri/
├── src/                     ← Frontend (HTML + CSS + JS)
│   ├── index.html
│   ├── styles.css
│   └── main.js
├── src-tauri/
│   ├── resources/           ← ¡Aquí van ffmpeg y ffprobe!
│   │   ├── ffmpeg
│   │   └── ffprobe
│   ├── src/                 ← Código Rust
│   │   ├── main.rs          ← Punto de entrada (5 líneas)
│   │   ├── lib.rs           ← Comandos Tauri + setup
│   │   ├── scanner.rs       ← Escaneo recursivo de carpetas
│   │   ├── detector.rs      ← Detección de codec con ffprobe
│   │   └── converter.rs     ← Conversión con ffmpeg
│   ├── Cargo.toml           ← Dependencias Rust
│   ├── build.rs             ← Script de build de Tauri
│   ├── tauri.conf.json      ← Configuración de la app
│   └── capabilities/
│       └── default.json     ← Permisos de seguridad
└── package.json             ← Dependencias JS (solo Tauri CLI)
```

---

## 7. Errores frecuentes

**"ffmpeg no encontrado en Resources/"**
→ Los binarios no están en `src-tauri/resources/` o no tienen permisos de ejecución.

**"Error: could not find `cargo` in PATH"**
→ Rust no está en el PATH. Ejecuta `source ~/.cargo/env` o reinicia el terminal.

**La primera compilación falla con error de linking**
→ Asegúrate de tener Xcode Command Line Tools: `xcode-select --install`

**macOS bloquea ffmpeg con "no se puede verificar el desarrollador"**
→ `xattr -d com.apple.quarantine src-tauri/resources/ffmpeg`
→ `xattr -d com.apple.quarantine src-tauri/resources/ffprobe`
