import CockpitShared
import SwiftUI

@main
struct CockpitApp: App {
    @State private var model = AppModel()

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
                if model.isLoggingIn { ProgressView() } else { Text("Anmelden") }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isLoggingIn)
            .padding(.top)
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
