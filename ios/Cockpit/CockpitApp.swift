import CockpitShared
import SwiftUI

@main
struct CockpitApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                switch model.phase {
                case .loggedIn:
                    if let session = model.cockpit {
                        MainView(model: model, session: session)
                    } else {
                        // Ohne Stores (kommt nach dem Login nicht vor, dort gibt es immer einen Token): neu anmelden.
                        LoginView(model: model)
                    }
                case .loggedOut:
                    LoginView(model: model)
                }
            }
            // Geteiltes, das die Share Extension ohne Netz gepuffert hat, beim Start, im Vordergrund und nach dem Login nachsenden;
            // ebenso die Puffer von „Unterwegs hören“ und der Schnelleingabe.
            .task(id: scenePhase == .active && model.phase == .loggedIn) {
                if scenePhase == .active, model.phase == .loggedIn {
                    await model.sendPendingShares()
                    await model.sendPendingListening()
                    await model.cockpit?.foreground()
                }
            }
            // Der große Player; geschlossen spielt er weiter, als Leiste über den Reitern (`nowPlayingBar`).
            .sheet(isPresented: $model.showsPlayer) { NowPlayingSheet(model: model) }
            #if targetEnvironment(macCatalyst)
            .onAppear { MacWindow.configure() }
            // Direktvertrieb: sucht neue Versionen auf GitHub (aus in TestFlight/App Store).
            .macUpdates(MacUpdater.shared)
            #endif
        }
        #if targetEnvironment(macCatalyst)
        .commands { MacUpdateCommands(updater: MacUpdater.shared) }
        #endif
    }
}

#if targetEnvironment(macCatalyst)
/// Fenster der Mac-App (Mac Catalyst): Die Oberfläche ist fürs iPhone gebaut, darunter wird sie eng.
enum MacWindow {
    static let minimumSize = CGSize(width: 420, height: 640)

    @MainActor
    static func configure() {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            scene.sizeRestrictions?.minimumSize = minimumSize
        }
    }
}
#endif

struct LoginView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 16) {
            Image("Logo")
                .resizable()
                .frame(width: 120, height: 120)
                .accessibilityHidden(true)
            Text("Cockpit")
                .font(.largeTitle.bold())
            Text(model.config.serverURL.absoluteString)
                .font(.footnote.monospaced())
                .foregroundStyle(.secondary)
                .accessibilityLabel("Server: \(model.config.serverURL.absoluteString)")
            Button {
                Task { await model.login() }
            } label: {
                if model.isLoggingIn { ProgressView() } else { Text(model.loginError == nil ? "Anmelden" : "Erneut versuchen") }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isLoggingIn)
            .padding(.top)
            if let notice = model.notice {
                Text(notice)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let error = model.loginError {
                Text(error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
        .padding()
    }
}

#Preview {
    LoginView(model: AppModel(config: AppConfiguration(info: ["CockpitServerURL": "https://vault.rubeen.dev"])))
}
