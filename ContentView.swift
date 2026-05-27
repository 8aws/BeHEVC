import SwiftUI
import UniformTypeIdentifiers
import UserNotifications
import Combine

struct ContentView: View {
    @StateObject private var vm = ConversionViewModel()
    @State private var selectedFiles: [URL] = []
    @State private var showFinishedAlert = false

    var body: some View {
        VStack(spacing: 16) {

            // HEADER
            HStack(spacing: 16) {

                VStack(alignment: .leading, spacing: 2) {
                    Text("BeHEVC")
                        .font(.system(size: 34, weight: .bold))
                        .foregroundColor(Color(hex: "#FF7A00"))

                    Text("Compresión inteligente. Calidad profesional.")
                        .font(.headline)
                        .foregroundColor(Color(hex: "#2E2F30"))
                }

                Spacer()

                Image("AppIcon")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 64, height: 64)
                    .padding(.trailing, 4)   // ← lo acerca al borde
            }


            // FILE SELECTION + OUTPUT FOLDER
            HStack(spacing: 12) {
                Button("Seleccionar vídeos…") {
                    openFileDialog()
                }
                .disabled(vm.isProcessing)
                .buttonStyle(.bordered)
                .tint(Color(hex: "#FF7A00"))

                Button("Carpeta de destino…") {
                    selectOutputFolder()
                }
                .buttonStyle(.bordered)
                .tint(Color(hex: "#FF7A00"))

                if let folder = vm.outputFolder {
                    Text(folder.path)
                        .foregroundColor(.white)
                        .font(.caption)
                }

                Spacer()
            }

            // COUNTERS
            if vm.totalFiles > 0 {
                HStack(spacing: 12) {
                    Text("Total: \(vm.totalFiles)").foregroundColor(.white)
                    Text("Convertir: \(vm.filesToConvert)").foregroundColor(Color(hex: "#FF7A00"))
                    Text("Saltados: \(vm.filesSkipped)").foregroundColor(.orange)
                    Text("Hechos: \(vm.filesDone)").foregroundColor(.green)
                    Spacer()
                }
            }

            // FILE LIST
            if !vm.items.isEmpty {
                List(vm.items) { item in
                    HStack {
                        Text(item.input.lastPathComponent)
                            .foregroundColor(Color(hex: "#E6E6E6"))

                        Spacer()

                        if item.willConvert {
                            Text("Convertir")
                                .foregroundColor(Color(hex: "#FF7A00"))
                        } else {
                            Text("Saltado")
                                .foregroundColor(.orange)
                        }
                    }
                    .listRowBackground(Color(hex: "#111111"))
                }
                .scrollContentBackground(.hidden)
                .frame(height: 180)
            }

            // PROGRESS BARS
            VStack(alignment: .leading, spacing: 8) {
                Text("Progreso archivo actual")
                    .foregroundColor(.white)

                ProgressView(value: vm.currentFileProgress)
                    .progressViewStyle(.linear)
                    .accentColor(Color(hex: "#FF7A00"))

                Text("Progreso global")
                    .foregroundColor(.white)

                ProgressView(value: vm.globalProgress)
                    .progressViewStyle(.linear)
                    .accentColor(Color(hex: "#FF7A00"))
            }

            // START BUTTON
            HStack {
                Button(vm.isProcessing ? "Procesando…" : "Convertir a HEVC") {
                    startConversion()
                }
                .disabled(vm.isProcessing || vm.filesToConvert == 0 || vm.outputFolder == nil)
                .buttonStyle(.borderedProminent)
                .tint(Color(hex: "#FF7A00"))
                .controlSize(.large)

                if vm.isProcessing {
                    Button("Cancelar") {
                        vm.cancelConversion()
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                }

                Spacer()
            }

            Divider()
                .background(Color(hex: "#333333"))

            // LOGS
            ScrollView {
                Text(vm.logText)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundColor(Color(hex: "#FF7A00"))
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color.black)
            .cornerRadius(8)
            .frame(height: 200)

        }
        .padding()
        .frame(minWidth: 800, minHeight: 600)
        .background(
            RadialGradient(
                gradient: Gradient(colors: [
                    Color(hex: "#8C9192"),
                    Color(hex: "#0D0D0D")
                ]),
                center: .topLeading,
                startRadius: 50,
                endRadius: 600
            )
        )
        .onAppear {
            vm.requestNotificationPermission()
            vm.onFinished = { showFinishedAlert = true }
        }
        .alert("Conversión completada", isPresented: $showFinishedAlert) {
            Button("OK", role: .cancel) { }
        }
    }

    // MARK: - File dialog

    func openFileDialog() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [UTType.movie, UTType.video]

        if panel.runModal() == .OK {
            selectedFiles = panel.urls
            vm.setSelectedFiles(panel.urls)
        }
    }

    func selectOutputFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false

        if panel.runModal() == .OK {
            if let url = panel.url {
                if url.startAccessingSecurityScopedResource() {
                    vm.outputFolder = url

                    // Recalcular rutas si ya había archivos seleccionados
                    if !selectedFiles.isEmpty {
                        vm.setSelectedFiles(selectedFiles)
                    }
                } else {
                    vm.logText += "ERROR: No se pudo acceder a la carpeta seleccionada.\n"
                }
            }
        }
    }

    // MARK: - Start

    func startConversion() {
        guard let ffmpeg = FFmpegPaths.shared.ffmpegPath else {
            vm.logText += "ERROR: ffmpeg no encontrado en el bundle\n"
            return
        }

        let ffprobe = FFmpegPaths.shared.ffprobePath ?? ffmpeg
        vm.startConversion(ffmpegPath: ffmpeg, ffprobePath: ffprobe)
    }
}
