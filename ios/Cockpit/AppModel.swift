import AuthenticationServices
import CockpitShared
import Observation
import OSLog
import UIKit
import WebKit

/// Reiter nach dem Login, alle nativ.
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

/// Ziele im Stapel des Reiters „Einstellungen“.
enum SettingsDestination: Hashable {
    /// Ein Abschnitt (`kalender`, `zunder`, …, `tokens`, `kurzbefehle`, `sicherung`).
    case section(String)
    /// „Zustand der Dienste“ (`/zustand`).
    case health
}

/// Seite als Blatt über den Reitern (Notiz, Graph, Suche, Wissen mit Frage, Zustand): eigener
/// Stapel, Links darin legen die nächste Seite obendrauf.
struct PageSheet: Identifiable, Equatable {
    let id = UUID()
    let root: PageRoute
}

/// Anmeldestand der App: Login, Abmelden, Reiter, Wunsch nach dem Player.
@MainActor
@Observable
final class AppModel {
    enum Phase { case loggedOut, loggedIn }

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
    /// Pfad, den die App nach dem nächsten Login öffnet (dort, wo die Sitzung ablief).
    var startPath = "/"
    /// Wunsch nach „Unterwegs hören“; startet den Player (`nowPlaying`) und zeigt ihn groß.
    var listening: ListenRequest? {
        didSet { if let listening { play(listening) } }
    }
    /// Wunsch nach einer Folge; startet den Player (`nowPlaying`) und zeigt ihn groß.
    var episode: EpisodeRequest? {
        didSet { if let episode { play(episode) } }
    }
    /// Was spielt oder angehalten bereitliegt. Bleibt, wenn man den großen Player schließt, und
    /// steht als Leiste über den Reitern (`NowPlayingBar`), bis man ihn beendet (`closePlayer()`).
    private(set) var nowPlaying: NowPlaying?
    /// Großer Player als Blatt über allem.
    var showsPlayer = false
    /// Baut die Player; Tests setzen eigene ein, damit kein Ton und kein Netz anläuft.
    @ObservationIgnored var players = PlayerFactory.live

    /// Gewählter Reiter.
    var tab: AppTab = .week
    /// Stapel des Reiters „Woche“ (Planen).
    var weekPath: [WeekDestination] = []
    /// Bereich des Reiters „Lesen“ (Unternavigation) und sein Stapel (Leseansicht, Neue Folge).
    var readingSection: LesenSection = .eingang
    var readingPath: [ReadingRoute] = []
    /// Woche für „Wiedersehen“ (`/lesen/wiedersehen?woche=`), nil = laufende Woche.
    var reviewWeek: String?
    /// Filter für „Markiert“ (`/lesen/markiert?quelle=&thema=`).
    var highlightQuery = HighlightQuery()
    /// Auswahl für „Wissen“ (`/wissen?q=&art=&status=&lesen=1`).
    var wissenQuery = WissenQuery()
    /// Zeitfenster für „Neue Folge“ (`/lesen/folgen/neu?zeit=`), nil = 30 Min.
    var newEpisodeZeit: Int?
    /// Blatt „Hinzufügen“ (Adresse oder PDF) im Reiter „Lesen“.
    var showsAdd = false
    /// Stapel des Reiters „Einstellungen“ (Abschnitt, Zustand).
    var settingsPath: [SettingsDestination] = []
    /// Notiz, Graph, Suche, Wissen mit Frage oder Zustand als Blatt, mit eigenem Stapel.
    var pageSheet: PageSheet?
    var pageSheetPath: [PageRoute] = []
    /// Zählt hoch, wenn die Schnelleingabe den Fokus bekommen soll (`/?erfassen=1`).
    var captureFocusRequest = 0
    /// Stores der nativen Bildschirme mit dem Geräte-Token; nil ohne Anmeldung.
    private(set) var cockpit: CockpitSession?
    /// Ein Link hat den Rückblick mit eigener Woche geöffnet (`open(_:)`), `tabChanged` lässt sie stehen.
    @ObservationIgnored private var reviewRouted = false

    init(config: AppConfiguration = AppConfiguration()) {
        self.config = config
        keychain = KeychainStore(accessGroup: config.keychainGroup)
        // Ohne Token gleich der Login; lehnt der Server den Token ab (401), meldet die App neu an.
        let token = (try? keychain.token()) ?? nil
        phase = token == nil ? .loggedOut : .loggedIn
        if let token { startCockpit(token: token) }
        #if DEBUG
        // Player ohne Anmeldung im Simulator vorführen (`-PlayerDemo`, siehe ios/README.md).
        // Im `init` läuft `didSet` nicht, deshalb ausdrücklich.
        if DemoListenService.isRequested { play(ListenRequest(minutes: 15)) }
        #endif
    }

    // MARK: Player

    /// „Unterwegs hören“: Läuft dasselbe Zeitfenster schon, nur den großen Player zeigen.
    private func play(_ request: ListenRequest) {
        if case .listening(let player) = nowPlaying, player.minutes == request.minutes {
            showsPlayer = true
            return
        }
        let player = players.listening(request.minutes)
        replacePlayer(with: .listening(player))
        Task { await player.start() }
    }

    /// Folge: Ist es dieselbe, nur den großen Player zeigen (er spielt weiter oder steht auf Pause).
    private func play(_ request: EpisodeRequest) {
        if case .episode(let player) = nowPlaying, player.id == request.episodeID {
            showsPlayer = true
            return
        }
        let player = players.episode(request)
        replacePlayer(with: .episode(player))
        Task { await player.start() }
    }

    /// Immer nur ein Player: Der alte hält an und meldet sich beim System ab.
    private func replacePlayer(with next: NowPlaying) {
        nowPlaying?.close()
        nowPlaying = next
        showsPlayer = true
    }

    /// Wiedergabe beenden (× in der Leiste, „Beenden“ im großen Player, Abmelden).
    func closePlayer() {
        nowPlaying?.close()
        nowPlaying = nil
        showsPlayer = false
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
            // Das Cookie braucht die App nicht mehr (kein WKWebView); sie arbeitet mit dem Geräte-Token.
            do {
                try keychain.save(token: result.token.token)
            } catch {
                // Die Bildschirme laufen auch so (Token aus der Antwort); Share Extension und Player
                // brauchen ihn aus der Keychain. Im Simulator ohne Signieren fehlt die Keychain-Gruppe (-34018).
                log.error("Geräte-Token nicht gespeichert: \(error.localizedDescription, privacy: .public)")
            }
            // Die nativen Bildschirme nehmen den Token aus der Antwort, auch wenn die Keychain fehlt.
            startCockpit(token: result.token.token)
            open(afterLogin: startPath)
            startPath = "/"
            phase = .loggedIn
        } catch {
            let host = config.serverURL.host() ?? ""
            let code = (error as NSError).code
            log.error("Login: \((error as NSError).domain, privacy: .public) \(code) für \(host, privacy: .public): \(error.localizedDescription, privacy: .public)")
            // nil: vom Nutzer abgebrochen, der Login-Knopf bleibt stehen.
            loginError = LoginError.shown(error, elapsed: Date.now.timeIntervalSince(started), host: host)?.localizedDescription
        }
    }

    /// Sitzung abgelaufen: nativ neu anmelden, danach weiter auf `next`.
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
        session.context.openURL = { [weak self] url in self?.open(url: url) }
        session.context.openPath = { [weak self] path in self?.open(path: path) }
        session.ingest.onReview = { [weak self] id in self?.open(reading: .ingestReview(id: id)) }
        session.start()
        cockpit = session
    }

    /// Link auf eine Seite, die nativ ist: Reiter wechseln, Woche oder Rückblick laden, Planen öffnen.
    func open(_ route: NativeRoute) {
        closePageSheet()
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
        open(path: path)
    }

    /// Link auf eine Seite des Lesens: Bereich wählen und laden, Leseansicht oder „Neue Folge“
    /// auf den Stapel legen, „Hinzufügen“ als Blatt, „Unterwegs hören“ im nativen Player.
    func open(reading route: ReadingRoute) {
        closePageSheet()
        let wasReading = tab == .reading
        switch route {
        case .listen(let zeit):
            // Der Player liegt über allen Reitern; der Reiter bleibt.
            listening = ListenRequest(minutes: zeit ?? 15)
            return
        case .inbox(let group):
            show(.eingang)
            if let cockpit { Task { await cockpit.inbox.load(group: group) } }
        case .stack(let query):
            show(.stapel)
            if let cockpit { Task { await cockpit.stack.load(query) } }
        case .highlights(let query):
            highlightQuery = query
            show(.markiert)
        case .review(let week):
            reviewWeek = week
            show(.wiedersehen)
        case .episodes:
            show(.folgen)
        case .ingest:
            // Lädt beim Erscheinen (`IngestScreen`).
            show(.ingest)
        case .add:
            showsAdd = true
        case .reader, .newEpisode, .ingestReview:
            if case .newEpisode(let zeit) = route { newEpisodeZeit = zeit }
            // Aus dem Lesen heraus obendrauf (zurück führt dorthin), aus anderen Reitern frisch.
            if wasReading, readingPath.last != route {
                readingPath.append(route)
            } else if !wasReading {
                readingPath = [route]
            }
        }
        tab = .reading
    }

    /// Notiz, Graph, Suche, Wissen, Zustand, Einstellungen oder Feeds. Einstellungen, Feeds und
    /// Wissen wechseln den Reiter; die übrigen kommen als Blatt, und ist schon eines offen, auf
    /// dessen Stapel (zurück führt zur Seite, von der der Link kam).
    func open(page route: PageRoute) {
        switch route {
        case .settings(let section):
            closePageSheet()
            tab = .settings
            settingsPath = section.map { [.section($0)] } ?? []
        case .feeds:
            closePageSheet()
            show(.feeds)
            tab = .reading
        case .wissen(let query):
            closePageSheet()
            wissenQuery = query
            show(.wissen)
            tab = .reading
        case .health where tab == .settings && pageSheet == nil:
            // Aus den Einstellungen heraus auf deren Stapel.
            if settingsPath.last != .health { settingsPath.append(.health) }
        case .note, .graph, .search, .health:
            if let sheet = pageSheet {
                if (pageSheetPath.last ?? sheet.root) != route { pageSheetPath.append(route) }
            } else {
                pageSheetPath = []
                pageSheet = PageSheet(root: route)
            }
        }
    }

    /// Blatt mit Seiten schließen (ein Link führt in einen Reiter).
    func closePageSheet() {
        pageSheet = nil
        pageSheetPath = []
    }

    /// Bereich der Unternavigation wählen; der Stapel (Leseansicht …) geht zu.
    private func show(_ section: LesenSection) {
        readingPath = []
        readingSection = section
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

    /// Web-Pfad aus einem nativen Bildschirm (`redirect`, Links in Notizen, Rückblick): der
    /// passende Bildschirm (`NavigationDecision`). Was die App nicht kennt (andere Seiten des
    /// Servers), öffnet sich im `SFSafariViewController`.
    func open(path: String) {
        if let decision = NavigationDecision.decide(path: path, server: config.serverURL) { follow(decision) }
    }

    /// Adresse aus einem nativen Bildschirm: eigene Seiten nativ, fremde im `SFSafariViewController`,
    /// `mailto:`, `obsidian://` usw. an das System.
    func open(url: URL) {
        follow(NavigationDecision.decide(url, server: config.serverURL))
    }

    /// Führt eine Entscheidung aus: Reiter, Abschnitt, Blatt oder raus aus der App.
    func follow(_ decision: NavigationDecision) {
        switch decision {
        case .native(let route): open(route)
        case .reading(let route): open(reading: route)
        case .page(let route): open(page: route)
        case .browser(let url), .external(let url): ExternalLink.present(url)
        case .system(let url): ExternalLink.system(url)
        }
    }

    /// Nach dem Login dorthin, wo die Sitzung ablief (Reiter, Abschnitt oder Seite); sonst bleibt
    /// die Woche.
    private func open(afterLogin path: String) {
        switch NavigationDecision.decide(path: path, server: config.serverURL) {
        case .native(let route)?: open(route)
        case .reading(let route)?: open(reading: route)
        case .page(let route)?: open(page: route)
        default: break
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

    /// Geräte-Token auf dem Server widerrufen, dann Website-Daten (Cookies, Service Worker und
    /// Offline-Puffer früherer Versionen mit Web-Hülle) und Token löschen. Ohne Netz wird
    /// trotzdem lokal gelöscht, mit Hinweis.
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
        closePlayer()
        SnapshotStore.applicationSupport().removeAll()
        tab = .week
        weekPath = []
        readingSection = .eingang
        readingPath = []
        reviewWeek = nil
        highlightQuery = HighlightQuery()
        wissenQuery = WissenQuery()
        newEpisodeZeit = nil
        showsAdd = false
        settingsPath = []
        closePageSheet()
        startPath = "/"
        loginError = nil
        self.notice = notice
        phase = .loggedOut
    }
}
