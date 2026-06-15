# BeHEVC — Publicar un release

El workflow `.github/workflows/build.yml` compila las 6 variantes (macOS arm64/Intel,
Windows x64/arm64, Linux x64/arm64), firma y notariza macOS si hay secrets, y al hacer
un **tag `vX.Y.Z`** crea un **Release en borrador** con todos los instaladores.

> Las firmas son **condicionales**: si no configuras los secrets, el build sale igual
> pero sin firmar (macOS mostrará Gatekeeper; Windows, SmartScreen). Nada se rompe.

---

## 1. Secrets para firma + notarización de macOS (recomendado)

Añádelos en GitHub → **Settings → Secrets and variables → Actions → New repository secret**.
Claude no puede introducirlos por ti: los gestionas tú y nunca los ve.

| Secret | Qué es / cómo obtenerlo |
|---|---|
| `APPLE_CERTIFICATE` | El certificado **Developer ID Application** en base64. En Keychain Access, exporta el certificado **con su clave privada** a un `.p12`, y luego: `base64 -i cert.p12 \| pbcopy`. Pega el resultado. |
| `APPLE_CERTIFICATE_PASSWORD` | La contraseña que pusiste al exportar el `.p12`. |
| `APPLE_SIGNING_IDENTITY` | El nombre exacto de la identidad, p. ej. `Developer ID Application: Tu Nombre (TEAMID)`. Lo ves con `security find-identity -v -p codesigning`. |
| `APPLE_ID` | El email de tu cuenta de Apple Developer. |
| `APPLE_PASSWORD` | Una **contraseña específica de app** (no la de tu Apple ID). Créala en appleid.apple.com → *Inicio de sesión y seguridad → Contraseñas específicas de app*. |
| `APPLE_TEAM_ID` | Tu Team ID de 10 caracteres (App Store Connect → Membership). |
| `KEYCHAIN_PASSWORD` | Cualquier cadena aleatoria; solo se usa para crear un llavero temporal en el runner. |

Con estos secrets, el job de macOS:
1. Importa el certificado en un llavero temporal.
2. Firma `ffmpeg`/`ffprobe` con *hardened runtime* (van en `resources/`, no son sidecars).
3. `tauri build` firma el `.app` y **notariza + grapa** el DMG automáticamente
   (lee `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`).

### Requisitos previos (una vez)
- Cuenta de **Apple Developer Program** (de pago).
- Un certificado **Developer ID Application** creado en developer.apple.com.

---

## 2. Firma de Windows (opcional)

Windows sin firmar **funciona** (SmartScreen pide confirmar una vez). Para firmarlo
necesitas un certificado de firma de código (OV/EV). Si lo tienes, se puede añadir un
paso de firma con `signtool` y configurar `bundle.windows` en `tauri.conf.json`.
Documentar/implementar cuando dispongas del certificado.

## 3. Linux

Las AppImage no se firman. Funcionan tal cual.

---

## 4. Cortar un release

1. Sube la versión en los 4 sitios (deben coincidir):
   `behevc-tauri/src-tauri/tauri.conf.json`, `behevc-tauri/package.json`,
   `behevc-tauri/src-tauri/Cargo.toml`, `website/version.json`.
2. Commit.
3. Crea y empuja el tag:
   ```bash
   git tag v2.0.0
   git push origin v2.0.0
   ```
4. El workflow compila las 6 variantes y crea un **Release en borrador** con los
   DMG / EXE / MSI / AppImage adjuntos.
5. Revisa el borrador (que los artefactos estén firmados/notarizados), edita las notas
   y publícalo.

### Verificar la firma/notarización de un DMG (en un Mac)
```bash
spctl -a -vvv -t install BeHEVC_2.0.0_aarch64.dmg   # debe decir "accepted / Notarized Developer ID"
codesign -dv --verbose=4 /Applications/BeHEVC.app
```

---

## 5. Build local firmado (sin CI)

Para un build local arm64 ya firmado, usa el helper (descarga ffmpeg arm64 y lo firma):
```bash
./scripts/prepare-macos-resources.sh "Developer ID Application: Tu Nombre (TEAMID)"
cd behevc-tauri && npm run tauri build -- --target aarch64-apple-darwin
```
Para notarizar localmente, exporta `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` y
`APPLE_SIGNING_IDENTITY` antes del `tauri build`.
