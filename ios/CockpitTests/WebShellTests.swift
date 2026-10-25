@testable import Cockpit
import CockpitShared
import WebKit
import XCTest

final class WebShellTests: XCTestCase {
    private let server = URL(string: "https://vault.test")!

    private func decide(_ url: String, method: String = "GET", mainFrame: Bool = true) -> NavigationDecision {
        NavigationDecision.decide(URL(string: url)!, method: method, server: server, isMainFrame: mainFrame)
    }

    func testOwnPagesStayInWebView() {
        XCTAssertEqual(decide("https://vault.test/lesen/feeds"), .allow, "Feeds bleiben Web")
        XCTAssertEqual(decide("https://vault.test/wissen?q=lesen"), .allow, "Wissen bleibt Web")
        XCTAssertEqual(decide("https://vault.test/einstellungen"), .allow)
        XCTAssertEqual(decide("https://vault.test/logout"), .allow, "nur POST meldet ab")
        XCTAssertEqual(decide("about:blank"), .allow)
    }

    func testLoginStartsNativeLogin() {
        XCTAssertEqual(decide("https://vault.test/login?next=%2Flesen%2Fstapel"), .login(next: "/lesen/stapel"))
        XCTAssertEqual(decide("https://vault.test/login"), .login(next: "/"))
        XCTAssertEqual(decide("https://vault.test/login?next=%2F%2Fevil.test"), .login(next: "/"))
        XCTAssertEqual(decide("https://vault.test/login?next=https%3A%2F%2Fevil.test"), .login(next: "/"))
        XCTAssertEqual(decide("https://vault.test/logout", method: "POST"), .logout)
    }

    func testForeignHostsLeaveTheApp() {
        XCTAssertEqual(decide("https://blatt.test/a"), .external(URL(string: "https://blatt.test/a")!))
        XCTAssertEqual(decide("https://vault.test.evil/login"), .external(URL(string: "https://vault.test.evil/login")!))
        XCTAssertEqual(decide("https://blatt.test/a", mainFrame: false), .allow)
        XCTAssertEqual(decide("mailto:ich@example.org"), .system(URL(string: "mailto:ich@example.org")!))
        let local = URL(string: "http://localhost:3000")!
        XCTAssertEqual(NavigationDecision.decide(URL(string: "http://localhost:3000/login")!, method: "GET", server: local, isMainFrame: true), .login(next: "/"))
        XCTAssertEqual(NavigationDecision.decide(URL(string: "http://localhost:8080/")!, method: "GET", server: local, isMainFrame: true), .external(URL(string: "http://localhost:8080/")!))
    }

    func testNativePagesSwitchTabs() {
        XCTAssertEqual(decide("https://vault.test/"), .native(.week(nil)))
        XCTAssertEqual(decide("https://vault.test"), .native(.week(nil)))
        XCTAssertEqual(decide("https://vault.test/?woche=2026-W42"), .native(.week("2026-W42")))
        XCTAssertEqual(decide("https://vault.test/rueckblick?woche=2026-W41"), .native(.review("2026-W41")))
        XCTAssertEqual(decide("https://vault.test/planen?woche=2026-W42&aus=t1#flamme"), .native(.plan("2026-W42", PlanQuery(from: "t1"))))
        XCTAssertEqual(decide("https://vault.test/", method: "POST"), .allow, "nur Seitenaufrufe")
        XCTAssertEqual(decide("https://vault.test/", mainFrame: false), .allow)
        XCTAssertEqual(decide("https://vault.test/notiz?pfad=inbox%2Fa.md"), .allow)
        // Die Web-Ansicht, die einen nativen Bildschirm vertritt, blättert in sich selbst.
        let review = NavigationDecision.decide(URL(string: "https://vault.test/rueckblick?woche=2026-W40")!, method: "GET", server: server, isMainFrame: true, webOnly: "/rueckblick")
        XCTAssertEqual(review, .allow)
        let week = NavigationDecision.decide(URL(string: "https://vault.test/?woche=2026-W40")!, method: "GET", server: server, isMainFrame: true, webOnly: "/rueckblick")
        XCTAssertEqual(week, .native(.week("2026-W40")))
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
        // Ohne ID keine Leseansicht; Formulare und Rahmen bleiben in der Seite.
        XCTAssertEqual(decide("https://vault.test/lesen/doc"), .allow)
        XCTAssertEqual(decide("https://vault.test/lesen/stapel", method: "POST"), .allow)
        XCTAssertEqual(decide("https://vault.test/lesen/stapel", mainFrame: false), .allow)
        XCTAssertEqual(decide("https://blatt.test/lesen/stapel"), .external(URL(string: "https://blatt.test/lesen/stapel")!))
    }

    @MainActor
    func testReadingLinksSwitchToTheReadingTab() {
        let model = AppModel(config: AppConfiguration(info: ["CockpitServerURL": "https://vault.test"]))
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
        XCTAssertEqual(model.webSheet?.path, "/lesen/feeds", "Feeds als Blatt")
        model.open(path: "/lesen/folgen/neu?zeit=15")
        XCTAssertNil(model.webSheet)
        XCTAssertEqual(model.newEpisodeZeit, 15)
        XCTAssertEqual(model.readingPath.last, .newEpisode(zeit: 15))
        model.open(path: "/lesen/markiert?thema=Technik")
        XCTAssertEqual(model.readingSection, .markiert)
        XCTAssertEqual(model.highlightQuery, HighlightQuery(topic: "Technik"))
    }

    func testReadingSections() {
        XCTAssertEqual(LesenSection.allCases.map(\.label), ["Eingang", "Stapel", "Folgen", "Markiert", "Wiedersehen", "Wissen", "Feeds"])
        XCTAssertEqual(LesenSection.wissen.webPath, "/wissen")
        XCTAssertEqual(LesenSection.feeds.webPath, "/lesen/feeds")
        XCTAssertNil(LesenSection.stapel.webPath, "nativ")
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

    @MainActor
    func testWebTabsHideTheirOwnTabBar() {
        XCTAssertTrue(WebViewController.hideTabBarScript.contains("nav.tabbar"))
        XCTAssertTrue(WebViewController.hideTabBarScript.contains("--tabbar"))
    }

    func testBridgeMessage() {
        XCTAssertEqual(BridgeMessage(["type": "hoeren", "zeit": NSNumber(value: 30)]), .listen(minutes: 30))
        XCTAssertEqual(BridgeMessage(["type": "hoeren"]), .listen(minutes: 15))
        XCTAssertEqual(
            BridgeMessage(["type": "folge", "id": "f1", "titel": "Podcast: Vom Lesen", "art": "Podcast", "dauer": NSNumber(value: 642), "groesse": NSNumber(value: 10_272_000)]),
            .episode(id: "f1", title: "Podcast: Vom Lesen", kind: "Podcast", seconds: 642, bytes: 10_272_000)
        )
        XCTAssertEqual(BridgeMessage(["type": "folge", "id": "f1"]), .episode(id: "f1", title: "Folge", kind: "Folge", seconds: 0, bytes: 0))
        XCTAssertNil(BridgeMessage(["type": "folge"]), "ohne ID nichts abzuspielen")
        XCTAssertEqual(BridgeMessage(["type": "haptik", "art": "auswahl"]), .haptic(.selection))
        XCTAssertEqual(BridgeMessage(["type": "haptik", "art": "erfolg"]), .haptic(.success))
        XCTAssertNil(BridgeMessage(["type": "haptik", "art": "laut"]), "unbekannte Art")
        XCTAssertNil(BridgeMessage(["type": "haptik"]))
        XCTAssertNil(BridgeMessage(["type": "anders"]))
        XCTAssertNil(BridgeMessage("hoeren"))
    }

    func testHandlesJavaScriptDialogs() {
        // Fehlt eine dieser Methoden, gilt confirm()/prompt() in WebKit als abgebrochen.
        let selectors = [
            #selector(WKUIDelegate.webView(_:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:)),
            #selector(WKUIDelegate.webView(_:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:)),
            #selector(WKUIDelegate.webView(_:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:)),
        ]
        for selector in selectors {
            XCTAssertTrue(WebViewController.instancesRespond(to: selector), "\(selector)")
        }
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
