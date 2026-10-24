@testable import Cockpit
import WebKit
import XCTest

final class WebShellTests: XCTestCase {
    private let server = URL(string: "https://vault.test")!

    private func decide(_ url: String, method: String = "GET", mainFrame: Bool = true) -> NavigationDecision {
        NavigationDecision.decide(URL(string: url)!, method: method, server: server, isMainFrame: mainFrame)
    }

    func testOwnPagesStayInWebView() {
        XCTAssertEqual(decide("https://vault.test/lesen/stapel?zeit=15"), .allow)
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

    func testBridgeMessage() {
        XCTAssertEqual(BridgeMessage(["type": "hoeren", "zeit": NSNumber(value: 30)]), .listen(minutes: 30))
        XCTAssertEqual(BridgeMessage(["type": "hoeren"]), .listen(minutes: 15))
        XCTAssertEqual(BridgeMessage(["type": "folge", "id": "f1", "titel": "Podcast: Vom Lesen", "art": "Podcast"]), .episode(id: "f1", title: "Podcast: Vom Lesen", kind: "Podcast"))
        XCTAssertEqual(BridgeMessage(["type": "folge", "id": "f1"]), .episode(id: "f1", title: "Folge", kind: "Folge"))
        XCTAssertNil(BridgeMessage(["type": "folge"]), "ohne ID nichts abzuspielen")
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
}
