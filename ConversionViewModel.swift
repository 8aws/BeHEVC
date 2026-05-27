import Foundation
import SwiftUI
import UserNotifications
import Combine

struct ConversionItem: Identifiable {
    let id = UUID()
    let input: URL
    let output: URL
    var willConvert: Bool
}

class ConversionViewModel: ObservableObject {

    // MARK: - Published state
    @Published var items: [ConversionItem] = []
    @Published var isProcessing = false
    @Published var logText = ""
    @Published var currentFileProgress: Double = 0.0
    @Published var globalProgress: Double = 0.0
    @Published var totalFiles: Int = 0
    @Published var filesToConvert: Int = 0
    @Published var filesSkipped: Int = 0
    @Published var filesDone: Int = 0
    @Published var outputFolder: URL?

    // Callback para ContentView
    var onFinished: (() -> Void)?

    // MARK: - Internals
    private let fileManager = FileManager.default
    private let queue = DispatchQueue(label: "behevc.conversion.queue")
    private var currentTask: Process?
    private var isCancelled = false

    // MARK: - File selection

    func setSelectedFiles(_ urls: [URL]) {
        logText = ""
        currentFileProgress = 0
        globalProgress = 0
        filesDone = 0
        filesSkipped = 0
        isCancelled = false

        guard let outputFolder else {
            appendLog("Selecciona una carpeta de destino antes de convertir.\n")
            return
        }

        try? fileManager.createDirectory(at: outputFolder, withIntermediateDirectories: true)

        var newItems: [ConversionItem] = []

        for url in urls {
            let output = outputURL(for: url, in: outputFolder)
            let exists = fileManager.fileExists(atPath: output.path)
            let item = ConversionItem(input: url, output: output, willConvert: !exists)
            newItems.append(item)
        }

        items = newItems
        totalFiles = items.count
        filesToConvert = items.filter { $0.willConvert }.count
        filesSkipped = items.filter { !$0.willConvert }.count

        appendLog("Total archivos: \(totalFiles)\nA convertir: \(filesToConvert)\nSaltados: \(filesSkipped)\n")
    }

    // MARK: - Paths

    private func outputURL(for input: URL, in folder: URL) -> URL {
        var output = folder.appendingPathComponent(
            input.deletingPathExtension().lastPathComponent + ".hevc.mp4"
        )

        var counter = 1
        while fileManager.fileExists(atPath: output.path) {
            let newName = "\(input.deletingPathExtension().lastPathComponent)-\(counter).hevc.mp4"
            output = folder.appendingPathComponent(newName)
            counter += 1
        }

        return output
    }

    // MARK: - Conversion

    func startConversion(ffmpegPath: String, ffprobePath: String) {
        guard !isProcessing else { return }
        guard filesToConvert > 0 else {
            appendLog("No hay archivos pendientes de conversión.\n")
            return
        }

        guard outputFolder != nil else {
            appendLog("Selecciona una carpeta de destino antes de convertir.\n")
            return
        }

        isProcessing = true
        isCancelled = false
        currentFileProgress = 0
        globalProgress = 0
        filesDone = 0

        queue.async { [weak self] in
            guard let self else { return }

            let itemsToProcess = self.items.filter { $0.willConvert }

            for (index, item) in itemsToProcess.enumerated() {
                if self.isCancelled { break }

                DispatchQueue.main.async {
                    self.appendLog("\n[\(index+1)/\(itemsToProcess.count)] \(item.input.lastPathComponent)\n")
                    self.currentFileProgress = 0
                }

                let duration = self.getDuration(of: item.input, ffprobePath: ffprobePath)

                self.convertOne(
                    input: item.input,
                    output: item.output,
                    ffmpegPath: ffmpegPath,
                    duration: duration
                )

                if self.isCancelled { break }

                DispatchQueue.main.async {
                    self.filesDone += 1
                    self.globalProgress = Double(self.filesDone) / Double(self.filesToConvert)
                }
            }

            DispatchQueue.main.async {
                self.isProcessing = false
                self.currentFileProgress = 0

                if self.isCancelled {
                    self.appendLog("\nConversión cancelada.\n")
                } else {
                    self.appendLog("\n✔ Conversión completada.\n")
                    self.sendNotification()
                    self.onFinished?()
                }
            }
        }
    }

    func cancelConversion() {
        isCancelled = true
        currentTask?.terminate()
        currentTask = nil
    }

    // MARK: - Duration

    private func getDuration(of input: URL, ffprobePath: String) -> Double {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: ffprobePath)
        task.arguments = [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            input.path
        ]

        let pipe = Pipe()
        task.standardOutput = pipe

        do {
            try task.run()
        } catch {
            appendLog("ERROR ejecutando ffprobe: \(error.localizedDescription)\n")
            return 0
        }

        task.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              let duration = Double(output) else {
            return 0
        }

        return duration
    }

    // MARK: - FFmpeg conversion

    private func convertOne(input: URL, output: URL, ffmpegPath: String, duration: Double) {
        let task = Process()
        currentTask = task

        task.executableURL = URL(fileURLWithPath: ffmpegPath)
        task.arguments = [
            "-i", input.path,
            "-c:v", "libx265",
            "-preset", "medium",
            "-crf", "28",
            output.path
        ]

        let pipe = Pipe()
        task.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty { return }

            if let line = String(data: data, encoding: .utf8) {
                DispatchQueue.main.async {
                    self.appendLog(line)

                    if let t = self.parseTime(from: line), duration > 0 {
                        let progress = min(t / duration, 1.0)
                        self.currentFileProgress = progress
                    }
                }
            }
        }

        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            DispatchQueue.main.async {
                self.appendLog("ERROR ejecutando ffmpeg: \(error.localizedDescription)\n")
            }
        }

        pipe.fileHandleForReading.readabilityHandler = nil
        currentTask = nil
    }

    private func parseTime(from line: String) -> Double? {
        guard let range = line.range(of: "time=") else { return nil }
        let substring = line[range.upperBound...]
        let components = substring.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard let timeString = components.first else { return nil }

        let parts = timeString.split(separator: ":")
        guard parts.count == 3 else { return nil }

        let h = Double(parts[0]) ?? 0
        let m = Double(parts[1]) ?? 0
        let s = Double(parts[2]) ?? 0

        return h * 3600 + m * 60 + s
    }

    // MARK: - Logs & notifications

    private func appendLog(_ text: String) {
        logText += text
    }

    private func sendNotification() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }

            let content = UNMutableNotificationContent()
            content.title = "BeHEVC"
            content.body = "Conversión finalizada"

            let request = UNNotificationRequest(
                identifier: UUID().uuidString,
                content: content,
                trigger: nil
            )

            center.add(request)
        }
    }

    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }
}
