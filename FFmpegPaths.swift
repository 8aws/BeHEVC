//
//  FFmpegPaths.swift
//  BeHEVC
//
//  Created by Manuel Rodriguez Alonso on 21/1/26.
//

import Foundation
import Combine

class FFmpegPaths: ObservableObject {
    static let shared = FFmpegPaths()

    @Published var ffmpegPath: String?
    @Published var ffprobePath: String?

    private init() {
        detectPaths()
    }

    func detectPaths() {
        // Busca ffmpeg y ffprobe dentro del bundle de la app
        ffmpegPath = Bundle.main.path(forResource: "ffmpeg", ofType: nil)
        ffprobePath = Bundle.main.path(forResource: "ffprobe", ofType: nil)

        print("ffmpeg en bundle:", ffmpegPath ?? "NO ENCONTRADO")
        print("ffprobe en bundle:", ffprobePath ?? "NO ENCONTRADO")
    }

    var ffmpegAvailable: Bool { ffmpegPath != nil }
    var ffprobeAvailable: Bool { ffprobePath != nil }
}
