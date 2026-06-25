# B265

Smart HEVC video converter — reduce file sizes with no visible quality loss.

Built with [Tauri 2](https://tauri.app/) (Rust + JavaScript). Native on macOS, Windows, and Linux.

## Features

- **HEVC/H.265 conversion** — hardware-accelerated (VideoToolbox, NVENC, QSV, AMF, VAAPI) with software fallback
- **VMAF quality target** — select a desired quality score and the app finds the optimal CRF automatically
- **Post-conversion verification** — measures VMAF after each file and warns if quality drops below threshold
- **Batch processing** — drag & drop folders, parallel encoding, persistent queue across restarts
- **Smart recompression** — detects already-encoded HEVC files, skips if re-encoding wouldn't save space
- **Savings estimation** — quick sample-based preview of expected file size reduction before converting
- **Flexible output** — rescale (1080p/720p/480p), audio codec (copy/AAC/Opus), track selection, subtitle handling
- **HDR preservation** — color primaries, transfer characteristics, and colorspace metadata carried through
- **Profiles** — save and restore your preferred settings
- **Bilingual** — full Spanish and English interface

## Downloads

Installers for all platforms are available at **[b265.uverse.es](https://b265.uverse.es)**.

| Platform | Architectures |
|----------|---------------|
| macOS    | Apple Silicon, Intel |
| Windows  | x64, ARM64 |
| Linux    | x64, ARM64 (AppImage) |

## Build from source

```bash
cd behevc-tauri
npm install
npm run tauri build
```

Requires [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/), and the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/).

## License

[GPL v3](LICENSE) — free to use, modify, and redistribute. Derivatives must remain open source under the same license.
