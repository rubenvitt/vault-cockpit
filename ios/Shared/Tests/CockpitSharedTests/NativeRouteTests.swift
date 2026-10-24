import Foundation
import XCTest
@testable import CockpitShared

final class NativeRouteTests: XCTestCase {
    func testPathsThatAreNative() {
        XCTAssertEqual(NativeRoute(webPath: "/"), .week(nil))
        XCTAssertEqual(NativeRoute(webPath: "/?woche=2026-W42"), .week("2026-W42"))
        XCTAssertEqual(NativeRoute(webPath: "/?woche="), .week(nil), "leer = laufende Woche")
        XCTAssertEqual(NativeRoute(webPath: "/?erfassen=1"), .week(nil, focusCapture: true))
        XCTAssertEqual(NativeRoute(webPath: "/rueckblick?woche=2026-W41"), .review("2026-W41"))
        XCTAssertEqual(NativeRoute(webPath: "/planen?woche=2026-W42#flamme"), .plan("2026-W42", PlanQuery()))
        XCTAssertEqual(NativeRoute(webPath: "/planen?q=Steuer&bereich=a1&aus=t1"), .plan(nil, PlanQuery(q: "Steuer", area: "a1", from: "t1")))
        XCTAssertEqual(NativeRoute(url: URL(string: "https://vault.test")!), .week(nil))
        XCTAssertEqual(NativeRoute(url: URL(string: "https://vault.test/rueckblick")!), .review(nil))
    }

    func testOtherPathsStayWeb() {
        for path in ["/lesen", "/notiz?pfad=inbox%2Fa.md", "/graph", "/einstellungen", "/planen/x", "//evil.test/", "rueckblick"] {
            XCTAssertNil(NativeRoute(webPath: path), path)
        }
    }

    func testWebPathRoundTrip() {
        XCTAssertEqual(NativeRoute.week(nil).webPath, "/")
        XCTAssertEqual(NativeRoute.week("2026-W42", focusCapture: true).webPath, "/?woche=2026-W42&erfassen=1")
        XCTAssertEqual(NativeRoute.review("2026-W41").webPath, "/rueckblick?woche=2026-W41")
        let plan = NativeRoute.plan("2026-W42", PlanQuery(q: "a b", from: "t1"))
        XCTAssertEqual(NativeRoute(webPath: plan.webPath), plan)
    }
}

final class WeekFormatTests: XCTestCase {
    func testInlineMarkdownDropsWikilinks() {
        XCTAssertEqual(CockpitFormat.inlineMarkdown("**Workshop** mit [[Folien]] und [[Kunde A|Kunde]]."), "**Workshop** mit Folien und Kunde.")
        XCTAssertEqual(CockpitFormat.inlineMarkdown("offen [[ohne Ende"), "offen [[ohne Ende")
    }

    func testObsidianURL() {
        XCTAssertEqual(CockpitFormat.obsidianURL(path: "phoenix/Feuer W3.md", vault: "RNotes")?.absoluteString, "obsidian://open?vault=RNotes&file=phoenix%2FFeuer%20W3")
        XCTAssertNil(CockpitFormat.obsidianURL(path: "a.md", vault: nil))
        XCTAssertNil(CockpitFormat.obsidianURL(path: "a.md", vault: ""))
    }

    func testNotePath() {
        XCTAssertEqual(CockpitFormat.notePath("inbox/2026-10-24 1427 - Web & Cockpit.md"), "/notiz?pfad=inbox%2F2026-10-24%201427%20-%20Web%20%26%20Cockpit.md")
    }

    func testMetaAndSavedAt() throws {
        XCTAssertEqual(CockpitFormat.meta(["VCP-47", nil, "", "Fr 16.10."]), "VCP-47 · Fr 16.10.")
        let berlin = try XCTUnwrap(TimeZone(identifier: "Europe/Berlin"))
        let date = try XCTUnwrap(CockpitFormat.date(from: "2026-10-24T12:27:00Z"))
        XCTAssertEqual(CockpitFormat.savedAt(date, timeZone: berlin), "Sa 24.10. 14:27")
    }

    func testCalendarToday() throws {
        let model = try JSONDecoder().decode(WeekModel.self, from: try fixture("woche"))
        let calendar = try XCTUnwrap(model.calendar.value)
        XCTAssertEqual(calendar.todayIndex, 2)
        XCTAssertTrue(calendar.isPast(calendar.days[1]))
        XCTAssertFalse(calendar.isPast(calendar.days[2]))
        XCTAssertEqual(calendar.todayHint, "heute \(CockpitFormat.events(calendar.days[2].events.count))")
        XCTAssertEqual(CockpitFormat.events(1), "1 Termin")
        XCTAssertEqual(CockpitFormat.events(3), "3 Termine")
    }
}
