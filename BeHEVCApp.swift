//
//  BeHEVCApp.swift
//  BeHEVC
//
//  Created by Manuel Rodriguez Alonso on 21/1/26.
//

import SwiftUI

@main
struct BeHEVCApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }

        Settings {
            PreferencesView()
        }
    }
}
