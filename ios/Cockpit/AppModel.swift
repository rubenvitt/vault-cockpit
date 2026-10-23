import AuthenticationServices
import CockpitShared
import Observation
import OSLog
import WebKit

/// Anmeldestand der App: Login, Abmelden, Wunsch nach dem Player.
@MainActor
@Observable
final class AppModel {
    enum Phase { case loggedOut, loggedIn }

    /// Wunsch der Seite `/lesen/hoeren`, den nativen Player zu öffnen.
    struct ListenRequest: Identifiable {
        let id = UUID()
        let minutes: Int
    }

    let config: AppConfiguration
    private let keychain: KeychainStore
    private let authenticator = WebAuthenticator()
    private let log = Logger(subsystem: "dev.rubeen.cockpit", category: "login")

    var phase: Phase
    var isLoggingIn = false
    var loginError: String?
    /// Pfad, den die Web-Hülle nach dem nächsten Login öffnet.
    var startPath = "/"
    /// Neue Web-Hülle nach jedem Login, damit sie mit dem frischen Cookie startet.
    var webViewID = UUID()
    var listening: ListenRequest?
    var showsMenu = false

    init(config: AppConfiguration = AppConfiguration()) {
        self.config = config
        keychain = KeychainStore(accessGroup: config.keychainGroup)
        // Ohne Token gleich der Login; ist nur das Cookie abgelaufen, fängt die Web-Hülle `/login` ab.
        phase = ((try? keychain.token()) ?? nil) == nil ? .loggedOut : .loggedIn
    }

    var startURL: URL {
        URL(string: startPath, relativeTo: config.serverURL)?.absoluteURL ?? config.serverURL
    }

    func login() async {
        guard !isLoggingIn else { return }
        isLoggingIn = true
        loginError = nil
        defer { isLoggingIn = false }
        do {
            let request = LoginRequest(serverURL: config.serverURL)
            let callback = try await authenticator.authenticate(url: request.url, callback: request.callback)
            let code = try request.code(from: callback)
            let result = try await APIClient.redeem(baseURL: config.serverURL, code: code, verifier: request.pkce.verifier, device: LoginRequest.currentDeviceName)
            guard let cookie = result.cookie.httpCookie else { throw LoginError.invalidCookie }
            await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
            do {
                try keychain.save(token: result.token.token)
            } catch {
                // Die Web-Hülle läuft über das Cookie auch so; Share Extension und Player brauchen den Token.
                // Im Simulator ohne Signieren fehlt die Keychain-Gruppe (-34018).
                log.error("Geräte-Token nicht gespeichert: \(error.localizedDescription, privacy: .public)")
            }
            webViewID = UUID()
            phase = .loggedIn
        } catch ASWebAuthenticationSessionError.canceledLogin {
            // Abgebrochen: Login-Knopf bleibt stehen.
        } catch {
            loginError = error.localizedDescription
        }
    }

    /// Die Web-Hülle wollte auf `/login`: Sitzung abgelaufen, nativ neu anmelden.
    func sessionExpired(next: String) {
        startPath = next
        phase = .loggedOut
        Task { await login() }
    }

    /// Cookies, Website-Daten (auch Service Worker und Offline-Puffer) und Token löschen. Den Token
    /// widerruft man bei Bedarf unter Einstellungen → API-Tokens.
    func logout() async {
        await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        do {
            try keychain.deleteToken()
        } catch {
            log.error("Geräte-Token nicht gelöscht: \(error.localizedDescription, privacy: .public)")
        }
        startPath = "/"
        loginError = nil
        phase = .loggedOut
    }
}
