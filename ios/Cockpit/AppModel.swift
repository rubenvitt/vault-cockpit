import AuthenticationServices
import CockpitShared
import Observation
import OSLog
import UIKit
import WebKit

/// Reiter nach dem Login. Woche und Rückblick sind nativ, Lesen und Einstellungen (noch) Web.
enum AppTab: Hashable {
    case week, reading, review, settings

    /// Web-Pfad, auf den nach einem abgelaufenen Login zurückgesprungen wird.
    var path: String {
        switch self {
        case .week: "/"
        case .reading: "/lesen"
        case .review: "/rueckblick"
        case .settings: "/einstellungen"
        }
    }
}

/// Ziele im Stapel des Reiters „Woche“.
enum WeekDestination: Hashable {
    /// „Woche planen“ bzw. „Einplanen“: Woche und Vorbelegung wie `/planen?woche=…&aus=…`;
    /// `flame` springt zu „Flamme einplanen“ (`#flamme`).
    case plan(String?, PlanQuery, flame: Bool = false)
}

/// Anmeldestand der App: Login, Abmelden, Reiter, Wunsch nach dem Player.
@MainActor
@Observable
final class AppModel {
    enum Phase { case loggedOut, loggedIn }

    /// Web-Seite als Blatt über den nativen Reitern (Suche, Notiz, …).
    struct WebPage: Identifiable {
        let id = UUID()
        let path: String
    }

    /// Wunsch der Seite `/lesen/hoeren`, den nativen Player zu öffnen.
    struct ListenRequest: Identifiable {
        let id = UUID()
        let minutes: Int
    }

    /// Wunsch der Seite `/lesen/folgen`, eine fertige Folge im nativen Player abzuspielen.
    struct EpisodeRequest: Identifiable {
        let id = UUID()
        let episodeID: String
        let title: String
        let kind: String
        /// Laut Server, 0 = unbekannt.
        var seconds: Double = 0
        var bytes: Int = 0
    }

    let config: AppConfiguration
    private let keychain: KeychainStore
    private let authenticator = WebAuthenticator()
    private let log = Logger(subsystem: "dev.rubeen.cockpit", category: "login")

    var phase: Phase
    var isLoggingIn = false
    var loginError: String?
    /// Hinweis nach dem Abmelden, z. B. wenn der Token ohne Netz nicht widerrufen wurde.
    var notice: String?
    /// Pfad, den die Web-Hülle nach dem nächsten Login öffnet.
    var startPath = "/"
    /// Neue Web-Hülle nach jedem Login, damit sie mit dem frischen Cookie startet.
    var webViewID = UUID()
    var listening: ListenRequest?
    var episode: EpisodeRequest?
    var showsMenu = false

    /// Gewählter Reiter.
    var tab: AppTab = .week
    /// Stapel des Reiters „Woche“ (Planen).
    var weekPath: [WeekDestination] = []
    /// Startpfade der Web-Reiter; nach dem Login z. B. die Seite, auf der die Sitzung ablief.
    var readingPath = AppTab.reading.path
    var settingsPath = AppTab.settings.path
    /// Zählt hoch, wenn ein nativer Bildschirm den Reiter „Lesen“ auf `readingPath` schickt (neu laden).
    var readingLoads = 0
    var webSheet: WebPage?
    /// Zählt hoch, wenn die Schnelleingabe den Fokus bekommen soll (`/?erfassen=1`).
    var captureFocusRequest = 0
    /// Stores der nativen Bildschirme mit dem Geräte-Token; nil ohne Anmeldung.
    private(set) var cockpit: CockpitSession?
    /// Ein Link hat den Rückblick mit eigener Woche geöffnet (`open(_:)`), `tabChanged` lässt sie stehen.
    @ObservationIgnored private var reviewRouted = false

    init(config: AppConfiguration = AppConfiguration()) {
        self.config = config
        keychain = KeychainStore(accessGroup: config.keychainGroup)
        // Ohne Token gleich der Login; ist nur das Cookie abgelaufen, fängt die Web-Hülle `/login` ab.
        let token = (try? keychain.token()) ?? nil
        phase = token == nil ? .loggedOut : .loggedIn
        if let token { startCockpit(token: token) }
        #if DEBUG
        // Player ohne Anmeldung im Simulator vorführen (`-PlayerDemo`, siehe ios/README.md).
        if DemoListenService.isRequested { listening = ListenRequest(minutes: 15) }
        #endif
    }

    /// Adresse eines Pfads auf dem Server, z. B. `/lesen`.
    func url(for path: String) -> URL {
        URL(string: path, relativeTo: config.serverURL)?.absoluteURL ?? config.serverURL
    }

    func login() async {
        guard !isLoggingIn else { return }
        isLoggingIn = true
        loginError = nil
        notice = nil
        defer { isLoggingIn = false }
        let started = Date.now
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
            // Die nativen Bildschirme nehmen den Token aus der Antwort, auch wenn die Keychain fehlt.
            startCockpit(token: result.token.token)
            open(afterLogin: startPath)
            startPath = "/"
            webViewID = UUID()
            phase = .loggedIn
        } catch {
            let host = config.serverURL.host() ?? ""
            let code = (error as NSError).code
            log.error("Login: \((error as NSError).domain, privacy: .public) \(code) für \(host, privacy: .public): \(error.localizedDescription, privacy: .public)")
            // nil: vom Nutzer abgebrochen, der Login-Knopf bleibt stehen.
            loginError = LoginError.shown(error, elapsed: Date.now.timeIntervalSince(started), host: host)?.localizedDescription
        }
    }

    /// Die Web-Hülle wollte auf `/login`: Sitzung abgelaufen, nativ neu anmelden.
    func sessionExpired(next: String) {
        startPath = next
        phase = .loggedOut
        Task { await login() }
    }

    /// Die API hat den Geräte-Token abgelehnt (401): wie eine abgelaufene Sitzung, zurück auf den Reiter.
    func apiUnauthorized() {
        guard phase == .loggedIn, !isLoggingIn else { return }
        sessionExpired(next: tab.path)
    }

    // MARK: Native Bildschirme

    /// Neue Stores mit `token`; die alten (vorige Anmeldung) halten an.
    private func startCockpit(token: String) {
        cockpit?.stop()
        let session = CockpitSession(serverURL: config.serverURL, token: token)
        session.context.onUnauthorized = { [weak self] in self?.apiUnauthorized() }
        session.context.openURL = { url in ExternalLink.open(url) }
        session.context.openPath = { [weak self] path in self?.open(path: path) }
        session.start()
        cockpit = session
    }

    /// Link auf eine Seite, die nativ ist: Reiter wechseln, Woche oder Rückblick laden, Planen öffnen.
    func open(_ route: NativeRoute) {
        webSheet = nil
        switch route {
        case .week(let week, let focusCapture):
            tab = .week
            weekPath = []
            if focusCapture { captureFocusRequest += 1 }
            if let cockpit { Task { await cockpit.week.load(week: week) } }
        case .review(let week):
            reviewRouted = tab != .review
            tab = .review
            if let cockpit { Task { await cockpit.review.load(week: week) } }
        case .plan(let week, let query):
            tab = .week
            weekPath = [.plan(week, query)]
        }
    }

    /// Reiter „Lesen“ auf einer Seite öffnen, z. B. „Markierungen dieser Woche wiedersehen“ aus dem Rückblick.
    func openReading(path: String) {
        webSheet = nil
        readingPath = path
        readingLoads += 1
        tab = .reading
    }

    /// Reiter gewechselt (Leiste oder Link). Wie der Link „Rückblick“ im Web zeigt der Rückblick
    /// die Woche, die gerade offen ist; ein Link mit eigener Woche geht vor.
    func tabChanged(from old: AppTab, to new: AppTab) {
        defer { reviewRouted = false }
        guard new == .review, old == .week, !reviewRouted, let cockpit, let shown = cockpit.week.model?.week else { return }
        let week = shown.current ? nil : shown.id
        if cockpit.review.requestedWeek != week {
            Task { await cockpit.review.load(week: week) }
        }
    }

    /// Web-Pfad aus einem nativen Bildschirm (`redirect`, Notiz, Suche): nativ, wenn es geht, sonst als Blatt.
    func open(path: String) {
        if let route = NativeRoute(webPath: path) {
            open(route)
        } else {
            webSheet = WebPage(path: path)
        }
    }

    /// Nach dem Login dorthin, wo die Sitzung ablief: nativer Bildschirm, Web-Reiter oder Blatt.
    private func open(afterLogin path: String) {
        if NativeRoute(webPath: path) != nil {
            open(path: path)
        } else if path.hasPrefix(AppTab.reading.path) {
            readingPath = path
            tab = .reading
        } else if path.hasPrefix(AppTab.settings.path) {
            settingsPath = path
            tab = .settings
        } else {
            webSheet = WebPage(path: path)
        }
    }

    /// Sendet, was die Share Extension gepuffert hat (kein Netz, Extension beendet, abgemeldet).
    func sendPendingShares() async {
        guard let token = (try? keychain.token()) ?? nil,
              let pending = PendingShares(appGroup: config.appGroup)
        else { return }
        for (share, error) in await pending.flush(using: APIClient(baseURL: config.serverURL, token: token)) {
            log.error("Geteiltes verworfen (\(share.id, privacy: .public)): \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Geräte-Token auf dem Server widerrufen, dann Cookies, Website-Daten (auch Service Worker und
    /// Offline-Puffer) und Token löschen. Ohne Netz wird trotzdem lokal gelöscht, mit Hinweis.
    func logout() async {
        var notice: String?
        if let token = (try? keychain.token()) ?? nil {
            do {
                try await APIClient(baseURL: config.serverURL, token: token).signOut()
            } catch let error as APIError where error.isUnauthorized {
                // Schon widerrufen.
            } catch {
                notice = "Abgemeldet, aber der Server war nicht erreichbar. Den Geräte-Token unter Einstellungen → API-Tokens widerrufen."
            }
        }
        await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        do {
            try keychain.deleteToken()
        } catch {
            log.error("Geräte-Token nicht gelöscht: \(error.localizedDescription, privacy: .public)")
        }
        // Gespeicherte Stände gehören zum Konto. Der Puffer der Schnelleingabe bleibt und geht nach dem nächsten Login raus.
        cockpit?.stop()
        cockpit = nil
        SnapshotStore.applicationSupport().removeAll()
        tab = .week
        weekPath = []
        readingPath = AppTab.reading.path
        readingLoads = 0
        settingsPath = AppTab.settings.path
        webSheet = nil
        startPath = "/"
        loginError = nil
        self.notice = notice
        phase = .loggedOut
    }
}
