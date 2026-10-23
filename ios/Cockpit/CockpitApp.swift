import CockpitShared
import SwiftUI

@main
struct CockpitApp: App {
    var body: some Scene {
        WindowGroup {
            StartView(serverURL: AppConfiguration().serverURL)
        }
    }
}

/// Platzhalter bis zur Web-Hülle (VCP-92).
struct StartView: View {
    let serverURL: URL

    var body: some View {
        VStack(spacing: 16) {
            Image("Logo")
                .resizable()
                .frame(width: 120, height: 120)
                .accessibilityHidden(true)
            Text("Cockpit")
                .font(.largeTitle.bold())
            Text(serverURL.absoluteString)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .accessibilityLabel("Server: \(serverURL.absoluteString)")
        }
        .padding()
    }
}

#Preview {
    StartView(serverURL: URL(string: "https://vault.rubeen.dev")!)
}
