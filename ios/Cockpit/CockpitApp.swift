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
                    WebShell(model: model)
                        .id(model.webViewID)
                        .ignoresSafeArea()
                case .loggedOut:
                    LoginView(model: model)
                }
            }
            // Geteiltes, das die Share Extension ohne Netz gepuffert hat, beim Start, im Vordergrund und nach dem Login nachsenden.
            .task(id: scenePhase == .active && model.phase == .loggedIn) {
                if scenePhase == .active, model.phase == .loggedIn { await model.sendPendingShares() }
            }
            .sheet(item: $model.listening) { PlayerView(minutes: $0.minutes) }
            .confirmationDialog("Cockpit", isPresented: $model.showsMenu) {
                Button("Abmelden", role: .destructive) { Task { await model.logout() } }
            } message: {
                Text("Angemeldet bei \(model.config.serverURL.host() ?? "")")
            }
        }
    }
}

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
