@testable import Cockpit
import CockpitShared
import XCTest

/// Links aus nativen Bildschirmen (`NavigationDecision`, `AppModel.open(path:)`): jede Seite des
/// Cockpits hat einen nativen Bildschirm, es gibt keinen WKWebView mehr.
final class RoutingTests: XCTestCase {
    private let server = URL(string: "https://vault.test")!

    private func decide(_ url: String) -> NavigationDecision {
        NavigationDecision.decide(URL(string: url)!, server: server)
    }

    @MainActor
    private func app() -> AppModel {
        AppModel(config: AppConfiguration(info: ["CockpitServerURL": "https://vault.test"]))
    }

    func testOwnPagesOpenNatively() {
        XCTAssertEqual(decide("https://vault.test/lesen/feeds"), .page(.feeds))
        XCTAssertEqual(decide("https://vault.test/wissen?q=lesen"), .page(.wissen(WissenQuery(q: "lesen"))))
        XCTAssertEqual(decide("https://vault.test/einstellungen"), .page(.settings(section: nil)))
        XCTAssertEqual(decide("https://vault.test/einstellungen#tokens"), .page(.settings(section: "tokens")))
        XCTAssertEqual(decide("https://vault.test/zustand"), .page(.health))
        XCTAssertEqual(decide("https://vault.test/notiz?pfad=inbox%2Fa.md#h-idee"), .page(.note(path: "inbox/a.md", anchor: "h-idee")))
        XCTAssertEqual(decide("https://vault.test/graph?pfad=a.md"), .page(.graph(path: "a.md")))
        XCTAssertEqual(decide("https://vault.test/graph?q=Hund"), .page(.search("Hund")))
        XCTAssertEqual(decide("https://VAULT.test/zustand"), .page(.health), "Host ohne Groß und klein")
        // Ohne nativen Bildschirm: im SFSafariViewController.
        XCTAssertEqual(decide("https://vault.test/static/app.css"), .browser(URL(string: "https://vault.test/static/app.css")!))
        XCTAssertEqual(decide("https://vault.test/notiz"), .browser(URL(string: "https://vault.test/notiz")!), "Notiz ohne Pfad")
    }

    func testForeignHostsLeaveTheApp() {
        XCTAssertEqual(decide("https://blatt.test/a"), .external(URL(string: "https://blatt.test/a")!))
        XCTAssertEqual(decide("https://vault.test.evil/zustand"), .external(URL(string: "https://vault.test.evil/zustand")!))
        XCTAssertEqual(decide("mailto:ich@example.org"), .system(URL(string: "mailto:ich@example.org")!))
        XCTAssertEqual(decide("obsidian://open?vault=V&file=a"), .system(URL(string: "obsidian://open?vault=V&file=a")!))
        let local = URL(string: "http://localhost:3000")!
        XCTAssertEqual(NavigationDecision.decide(URL(string: "http://localhost:3000/zustand")!, server: local), .page(.health))
        XCTAssertEqual(NavigationDecision.decide(URL(string: "http://localhost:8080/")!, server: local), .external(URL(string: "http://localhost:8080/")!))
    }

    func testNativePagesSwitchTabs() {
        XCTAssertEqual(decide("https://vault.test/"), .native(.week(nil)))
        XCTAssertEqual(decide("https://vault.test"), .native(.week(nil)))
        XCTAssertEqual(decide("https://vault.test/?woche=2026-W42"), .native(.week("2026-W42")))
        XCTAssertEqual(decide("https://vault.test/rueckblick?woche=2026-W41"), .native(.review("2026-W41")))
        XCTAssertEqual(decide("https://vault.test/planen?woche=2026-W42&aus=t1#flamme"), .native(.plan("2026-W42", PlanQuery(from: "t1"))))
    }

    func testReadingPagesOpenNatively() {
        XCTAssertEqual(decide("https://vault.test/lesen"), .reading(.inbox(group: nil)))
        XCTAssertEqual(decide("https://vault.test/lesen/eingang?gruppe=ohne"), .reading(.inbox(group: "ohne")))
        XCTAssertEqual(decide("https://vault.test/lesen/stapel?zeit=15"), .reading(.stack(StackQuery(zeit: 15))))
        XCTAssertEqual(decide("https://vault.test/lesen/stapel?sort=kurz&gruppe=g1"), .reading(.stack(StackQuery(sort: "kurz", group: "g1"))))
        XCTAssertEqual(decide("https://vault.test/lesen/doc?id=d1#weiter"), .reading(.reader(id: "d1", highlight: nil, resume: true)))
        XCTAssertEqual(decide("https://vault.test/lesen/doc?id=d1#h-m7"), .reading(.reader(id: "d1", highlight: "m7", resume: false)))
        XCTAssertEqual(decide("https://vault.test/lesen/markiert?quelle=Blatt"), .reading(.highlights(HighlightQuery(site: "Blatt"))))
        XCTAssertEqual(decide("https://vault.test/lesen/wiedersehen?woche=2026-W43"), .reading(.review(week: "2026-W43")))
        XCTAssertEqual(decide("https://vault.test/lesen/folgen"), .reading(.episodes))
        XCTAssertEqual(decide("https://vault.test/lesen/folgen/neu?zeit=15"), .reading(.newEpisode(zeit: 15)))
        XCTAssertEqual(decide("https://vault.test/lesen/hinzufuegen"), .reading(.add))
        XCTAssertEqual(decide("https://vault.test/lesen/hoeren?zeit=30"), .reading(.listen(zeit: 30)))
        XCTAssertEqual(decide("https://vault.test/lesen/ingest"), .reading(.ingest))
        XCTAssertEqual(decide("https://vault.test/lesen/ingest/doc?id=d1"), .reading(.ingestReview(id: "d1")))
        XCTAssertEqual(decide("https://blatt.test/lesen/stapel"), .external(URL(string: "https://blatt.test/lesen/stapel")!))
    }

    func testPaths() {
        XCTAssertEqual(NavigationDecision.decide(path: "/notiz?pfad=00-inbox%2FIdee.md", server: server), .page(.note(path: "00-inbox/Idee.md", anchor: nil)))
        XCTAssertEqual(NavigationDecision.decide(path: "/planen?woche=2026-W42", server: server), .native(.plan("2026-W42", PlanQuery())))
        XCTAssertEqual(NavigationDecision.decide(path: "/static/x", server: server), .browser(URL(string: "https://vault.test/static/x")!))
        XCTAssertNil(NavigationDecision.decide(path: "//evil.test/notiz", server: server), "nur eigene Pfade")
        XCTAssertNil(NavigationDecision.decide(path: "https://evil.test/", server: server))
    }

    @MainActor
    func testReadingLinksSwitchToTheReadingTab() {
        let model = app()
        model.open(path: "/lesen/stapel?zeit=15")
        XCTAssertEqual(model.tab, .reading)
        XCTAssertEqual(model.readingSection, .stapel)
        XCTAssertEqual(model.readingPath, [])

        model.open(path: "/lesen/doc?id=d1#weiter")
        XCTAssertEqual(model.readingPath, [.reader(id: "d1", highlight: nil, resume: true)])
        model.open(path: "/lesen/doc?id=d2")
        XCTAssertEqual(model.readingPath.count, 2, "aus dem Lesen heraus obendrauf")
        model.open(path: "/lesen/doc?id=d2")
        XCTAssertEqual(model.readingPath.count, 2, "derselbe Text nicht zweimal")

        model.openReading(path: "/lesen/wiedersehen?woche=2026-W43")
        XCTAssertEqual(model.readingSection, .wiedersehen)
        XCTAssertEqual(model.reviewWeek, "2026-W43")
        XCTAssertEqual(model.readingPath, [], "Bereich wechseln schließt die Leseansicht")

        model.tab = .week
        model.open(path: "/lesen/doc?id=d3#h-m1")
        XCTAssertEqual(model.tab, .reading)
        XCTAssertEqual(model.readingPath, [.reader(id: "d3", highlight: "m1", resume: false)], "aus einem anderen Reiter frisch")

        model.open(path: "/lesen/hoeren?zeit=30")
        XCTAssertEqual(model.listening?.minutes, 30)
        model.open(path: "/lesen/hinzufuegen")
        XCTAssertTrue(model.showsAdd)
        model.open(path: "/lesen/feeds")
        XCTAssertEqual(model.readingSection, .feeds, "Feeds als Bereich des Lesens")
        XCTAssertNil(model.pageSheet)
        model.open(path: "/wissen?q=Lesen&lesen=1")
        XCTAssertEqual(model.readingSection, .wissen)
        XCTAssertEqual(model.wissenQuery, WissenQuery(q: "Lesen", lesen: true))
        model.open(path: "/lesen/folgen/neu?zeit=15")
        XCTAssertEqual(model.newEpisodeZeit, 15)
        XCTAssertEqual(model.readingPath.last, .newEpisode(zeit: 15))
        model.open(path: "/lesen/markiert?thema=Technik")
        XCTAssertEqual(model.readingSection, .markiert)
        XCTAssertEqual(model.highlightQuery, HighlightQuery(topic: "Technik"))
        model.open(path: "/lesen/ingest")
        XCTAssertEqual(model.readingSection, .ingest)
        XCTAssertEqual(model.readingPath, [])
        model.open(path: "/lesen/ingest/doc?id=d4")
        XCTAssertEqual(model.readingPath, [.ingestReview(id: "d4")], "Prüfansicht auf den Stapel des Lesens")
    }

    @MainActor
    func testPagesOpenAsSheetWithOwnStack() {
        let model = app()
        model.open(path: "/notiz?pfad=inbox%2Fa.md")
        XCTAssertEqual(model.pageSheet?.root, .note(path: "inbox/a.md", anchor: nil))
        XCTAssertEqual(model.pageSheetPath, [])
        model.open(path: "/graph?pfad=b.md")
        XCTAssertEqual(model.pageSheetPath, [.graph(path: "b.md")], "im offenen Blatt obendrauf")
        model.open(path: "/graph?pfad=b.md")
        XCTAssertEqual(model.pageSheetPath.count, 1, "dieselbe Seite nicht zweimal")
        model.open(path: "/zustand")
        XCTAssertEqual(model.pageSheetPath.last, .health)

        model.open(path: "/")
        XCTAssertNil(model.pageSheet, "ein Reiter schließt das Blatt")
        XCTAssertEqual(model.pageSheetPath, [])
        XCTAssertEqual(model.tab, .week)

        model.open(page: .health)
        XCTAssertEqual(model.pageSheet?.root, .health, "Störung aus der Woche: Zustand als Blatt")
        model.closePageSheet()
        XCTAssertNil(model.pageSheet)

        model.open(page: .search(""))
        XCTAssertEqual(model.pageSheet?.root, .search(""), "Suche aus der Woche als Blatt")
        XCTAssertEqual(model.tab, .week)
    }

    @MainActor
    func testSettingsLinks() {
        let model = app()
        model.open(path: "/einstellungen#tokens")
        XCTAssertEqual(model.tab, .settings)
        XCTAssertEqual(model.settingsPath, [.section("tokens")])
        model.open(page: .health)
        XCTAssertNil(model.pageSheet, "aus den Einstellungen auf deren Stapel")
        XCTAssertEqual(model.settingsPath, [.section("tokens"), .health])
        model.open(page: .health)
        XCTAssertEqual(model.settingsPath.count, 2)
        model.open(path: "/einstellungen")
        XCTAssertEqual(model.settingsPath, [], "zurück zur Übersicht")

        model.open(path: "/notiz?pfad=a.md")
        XCTAssertNotNil(model.pageSheet)
        model.open(path: "/einstellungen#sicherung")
        XCTAssertNil(model.pageSheet)
        XCTAssertEqual(model.settingsPath, [.section("sicherung")])
    }

    func testReadingSections() {
        XCTAssertEqual(LesenSection.allCases.map(\.label), ["Eingang", "Stapel", "Ingest", "Folgen", "Markiert", "Wiedersehen", "Wissen", "Feeds"])
    }

    func testInboxSwipe() {
        let card = CGSize(width: 300, height: 400)
        var swipe = EingangSwipe(startX: 100, width: 390)
        swipe.update(CGSize(width: 20, height: 5))
        XCTAssertEqual(swipe.offset, .zero, "erst ab 32 pt steht die Richtung fest")
        swipe.update(CGSize(width: 60, height: 10))
        XCTAssertEqual(swipe.axis, .horizontal)
        XCTAssertEqual(swipe.offset, CGSize(width: 60, height: 0), "nur entlang der Achse")
        XCTAssertNil(swipe.target(card: card), "unter 30 % der Breite")
        swipe.update(CGSize(width: 95, height: 40))
        XCTAssertEqual(swipe.target(card: card), .lesen)
        XCTAssertEqual(swipe.rotation, 95.0 / 30, accuracy: 0.001)
        swipe.update(CGSize(width: -95, height: 0))
        XCTAssertEqual(swipe.target(card: card), .weg)

        var down = EingangSwipe(startX: 100, width: 390)
        down.update(CGSize(width: 5, height: 40))
        XCTAssertEqual(down.axis, .vertical)
        down.update(CGSize(width: 5, height: 130))
        XCTAssertEqual(down.target(card: card), .stapel)
        down.update(CGSize(width: 0, height: -50))
        XCTAssertEqual(down.offset, .zero, "nach oben bleibt die Karte liegen")

        var diagonal = EingangSwipe(startX: 100, width: 390)
        diagonal.update(CGSize(width: 30, height: 30))
        XCTAssertTrue(diagonal.isRejected, "schräg zählt nicht")
        diagonal.update(CGSize(width: 200, height: 0))
        XCTAssertEqual(diagonal.offset, .zero)
        XCTAssertNil(diagonal.target(card: card))

        XCTAssertTrue(EingangSwipe(startX: 10, width: 390).isRejected, "Rand gehört der Zurück-Geste")
        XCTAssertTrue(EingangSwipe(startX: 380, width: 390).isRejected)
    }

    func testHealthFacts() {
        let now = Date(timeIntervalSince1970: 1_761_380_000)
        let berlin = TimeZone(identifier: "Europe/Berlin")!
        let json = """
        {"id":"kalender","name":"Kalender","state":"error","summary":"1 von 2","lastOkAt":"2025-10-25T08:00:00.000Z","lastErrorAt":"2025-10-25T08:10:00.000Z","lastError":"401",
         "facts":[{"label":"Kalender","value":2},{"label":"Letzter Abruf","at":"2025-10-25T08:00:00.000Z"}]}
        """
        let service = try! JSONDecoder().decode(HealthService.self, from: Data(json.utf8))
        let facts = HealthServiceCard.facts(of: service, timeZone: berlin, now: now)
        XCTAssertEqual(facts.map(\.label), ["Kalender", "Letzter Abruf"], "„Letzter Erfolg“ steht schon als Angabe da")
        XCTAssertEqual(facts.first?.value, "2")
        XCTAssertTrue(facts[1].value.hasPrefix("25.10. 10:00 · vor "), facts[1].value)
    }

    func testEpisodeFileAndClock() {
        XCTAssertEqual(EpisodePlayer.file(for: "3f2a-b9").lastPathComponent, "3f2a-b9.mp3")
        XCTAssertEqual(EpisodePlayer.file(for: "../../etwas").lastPathComponent, "etwas.mp3", "nur sichere Zeichen")
        XCTAssertEqual(EpisodePlayer.file(for: "x").deletingLastPathComponent().lastPathComponent, "Folgen")
        XCTAssertEqual(EpisodePlayer.clock(75), "1:15")
        XCTAssertEqual(EpisodePlayer.clock(3725), "1:02:05")
        XCTAssertEqual(EpisodePlayer.clock(.nan), "0:00")
    }

    func testCachedEpisodeIsReloadedWhenServerSizeChanged() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID().uuidString).mp3")
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertFalse(EpisodePlayer.isCached(file, bytes: 0), "nichts im Cache")
        try Data(count: 10).write(to: file)
        XCTAssertTrue(EpisodePlayer.isCached(file, bytes: 10))
        XCTAssertTrue(EpisodePlayer.isCached(file, bytes: 0), "Größe unbekannt: Cache nehmen")
        XCTAssertFalse(EpisodePlayer.isCached(file, bytes: 8), "bereinigt auf dem Server: neu laden")
    }
}
