//
//  PreferencesView.swift
//  BeHEVC
//
//  Created by Manuel Rodriguez Alonso on 21/1/26.
//

import SwiftUI

struct PreferencesView: View {
    @ObservedObject var paths = FFmpegPaths.shared

    var body: some View {
        Form {
            Section(header: Text("Rutas detectadas en el bundle")) {
                HStack {
                    Text("ffmpeg")
                    Spacer()
                    Text(paths.ffmpegPath ?? "No encontrado")
                        .foregroundColor(paths.ffmpegAvailable ? .green : .red)
                        .textSelection(.enabled)
                }

                HStack {
                    Text("ffprobe")
                    Spacer()
                    Text(paths.ffprobePath ?? "No encontrado")
                        .foregroundColor(paths.ffprobeAvailable ? .green : .red)
                        .textSelection(.enabled)
                }
            }
        }
        .padding()
        .frame(width: 550, height: 200)
    }
}
