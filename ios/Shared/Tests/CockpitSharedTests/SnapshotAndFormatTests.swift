import Foundation
import XCTest
@testable import CockpitShared

final class SnapshotStoreTests: XCTestCase {
    func testRoundTrip() throws {
        let store = SnapshotStore(directory: try temporaryDirectory())
        XCTAssertNil(store.load("woche/aktuell"))
        let data = try fixture("woche")
        let at = Date(timeIntervalSince1970: 1_792_000_000)
        try store.save(data, for: "woche/aktuell", at: at)
        XCTAssertEqual(store.load("woche/aktuell"), Snapshot(data: data, savedAt: at))
        // Neuer Stand ersetzt den alten.
        try store.save(json("{}"), for: "woche/aktuell", at: at.addingTimeInterval(60))
        XCTAssertEqual(store.load("woche/aktuell")?.data, json("{}"))
        store.remove("woche/aktuell")
        XCTAssertNil(store.load("woche/aktuell"))
    }

    func testKeysBecomeSafeDistinctFileNames() throws {
        let store = SnapshotStore(directory: try temporaryDirectory())
        let long = "planen/2026-W42?q=" + String(repeating: "Steuer ", count: 60)
        for (i, key) in ["planen/aktuell?q=a b", "planen/aktuell?q=a_b", "../../etc", long, long + "x"].enumerated() {
            try store.save(json("[\(i)]"), for: key)
        }
        XCTAssertEqual(store.load("planen/aktuell?q=a b")?.data, json("[0]"))
        XCTAssertEqual(store.load("planen/aktuell?q=a_b")?.data, json("[1]"))
        XCTAssertEqual(store.load("../../etc")?.data, json("[2]"))
        XCTAssertEqual(store.load(long)?.data, json("[3]"))
        XCTAssertEqual(store.load(long + "x")?.data, json("[4]"))
        XCTAssertLessThan(store.file(for: long).lastPathComponent.count, 140)
        XCTAssertEqual(store.file(for: "../../etc").deletingLastPathComponent().standardizedFileURL, store.directory.standardizedFileURL)
    }

    func testBrokenFileCountsAsMissingAndRemoveAllClears() throws {
        let store = SnapshotStore(directory: try temporaryDirectory())
        try store.save(json("{}"), for: "rueckblick/aktuell")
        try json("kaputt").write(to: store.file(for: "rueckblick/aktuell"))
        XCTAssertNil(store.load("rueckblick/aktuell"))
        try store.save(json("{}"), for: "woche/aktuell")
        store.removeAll()
        XCTAssertNil(store.load("woche/aktuell"))
    }
}

final class CockpitFormatTests: XCTestCase {
    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    func testDueLabel() {
        XCTAssertEqual(CockpitFormat.dueLabel("2026-10-16", timeZone: berlin), "Fr 16.10.")
        XCTAssertEqual(CockpitFormat.dueLabel("2026-10-14T06:00:00Z", timeZone: berlin), "Mi 14.10. 08:00")
        XCTAssertEqual(CockpitFormat.dueLabel("2026-10-14T23:30:00.000Z", timeZone: berlin), "Do 15.10. 01:30")
        XCTAssertEqual(CockpitFormat.dueLabel(nil, timeZone: berlin), "")
        XCTAssertEqual(CockpitFormat.dueLabel("kaputt", timeZone: berlin), "")
    }

    func testDueTag() {
        func tag(_ due: String?, _ status: TaskStatus = .open, overdue: Bool = false, today: String? = "2026-10-14") -> DueTag? {
            CockpitFormat.dueTag(ZunderTask(id: "x", title: "X", status: status, due: due, overdue: overdue), today: today, timeZone: berlin)
        }
        XCTAssertNil(tag(nil))
        XCTAssertEqual(tag("2026-10-14"), DueTag(text: "Heute", label: "Mi 14.10.", tone: .today))
        XCTAssertEqual(tag("2026-10-15T07:30:00Z"), DueTag(text: "Morgen 09:30", label: "Do 15.10. 09:30", tone: .plain))
        XCTAssertEqual(tag("2026-10-16")?.text, "Fr 16.10.")
        XCTAssertEqual(tag("2026-10-12")?.tone, .overdue)
        XCTAssertEqual(tag("2026-10-12")?.accessibilityText, "Überfällig seit Mo 12.10.")
        XCTAssertEqual(tag("2026-10-12", .done)?.tone, .plain)
        // Ohne heutiges Datum zählt `overdue` vom Server.
        XCTAssertEqual(tag("2026-07-05", overdue: true, today: nil)?.tone, .overdue)
        XCTAssertEqual(CockpitFormat.localDay("2026-10-14T23:30:00Z", timeZone: berlin), "2026-10-15")
    }

    func testDurations() {
        XCTAssertEqual(CockpitFormat.hours(45), "45 min")
        XCTAssertEqual(CockpitFormat.hours(60), "1 h")
        XCTAssertEqual(CockpitFormat.hours(90), "1 h 30 min")
        let start = Date(timeIntervalSince1970: 0)
        XCTAssertEqual(CockpitFormat.elapsed(since: start, now: start.addingTimeInterval(245)), "04:05")
        XCTAssertEqual(CockpitFormat.elapsed(since: start, now: start.addingTimeInterval(3845)), "1:04:05")
        XCTAssertEqual(CockpitFormat.elapsed(since: start, now: start.addingTimeInterval(-5)), "00:00")
    }

    func testWeekRangeAndDays() throws {
        let week = try JSONDecoder().decode(WeekModel.self, from: try fixture("woche")).week
        XCTAssertEqual(CockpitFormat.weekRange(week), "12.–18. Oktober 2026")
        XCTAssertEqual(week.label, "KW 42")
        XCTAssertEqual(CockpitFormat.weekLabel("2027-W01"), "KW 1")
        XCTAssertEqual(CockpitFormat.shortDay("2026-10-12"), "12.10.")
        XCTAssertEqual(CockpitFormat.reviewRange(week), "12.10.2026 – 18.10.2026")
        XCTAssertEqual(CockpitFormat.planRange(week), "12.10.–18.10.")
        let day = try XCTUnwrap(CockpitFormat.day(from: "2026-10-25", in: berlin))
        XCTAssertEqual(CockpitFormat.dayString(day, in: berlin), "2026-10-25")
        XCTAssertEqual(CockpitFormat.time(try XCTUnwrap(CockpitFormat.date(from: "2026-10-14T12:00:00.000Z")), timeZone: berlin), "14:00")
    }

    func testCaptureText() {
        XCTAssertTrue(CaptureText.isTask("  ! Zahnarzt"))
        XCTAssertEqual(CaptureText.kind(of: "> https://example.com/a"), "Artikel")
        XCTAssertEqual(CaptureText.kind(of: "> Ein kluger Satz"), "Notiz")
        XCTAssertTrue(CaptureText.wantsPreview("> Ein kluger Satz"))
        XCTAssertFalse(CaptureText.wantsPreview("!   "))
        XCTAssertFalse(CaptureText.wantsPreview("Notiz"))
        XCTAssertEqual(CaptureText.firstLine("! Erste Zeile\nZweite"), "Erste Zeile")
        XCTAssertEqual(CaptureText.noteLabel(path: "inbox/2026-10-24 1427 - Web-Cockpit.md"), "Web-Cockpit")
        XCTAssertEqual(CaptureText.noteLabel(path: "inbox/Idee.md"), "Idee")
    }
}

final class ToastCenterTests: XCTestCase {
    @MainActor
    func testAtMostFourAndErrorsStay() async {
        let toasts = ToastCenter(okLifetime: 0.05)
        toasts.error("Fehler bleibt")
        for i in 1...4 { toasts.show("Meldung \(i)") }
        XCTAssertEqual(toasts.toasts.map(\.message), ["Meldung 1", "Meldung 2", "Meldung 3", "Meldung 4"])
        toasts.error("Noch ein Fehler")
        await waitUntil { toasts.toasts.allSatisfy { $0.kind == .error } }
        XCTAssertEqual(toasts.toasts.map(\.message), ["Noch ein Fehler"])
    }

    @MainActor
    func testActionDismissesAndRuns() {
        let toasts = ToastCenter()
        var ran = false
        let toast = toasts.show("Erledigt", action: Toast.Action(label: "Rückgängig") { ran = true })
        toasts.perform(toast.id)
        XCTAssertTrue(ran)
        XCTAssertTrue(toasts.toasts.isEmpty)
    }

    @MainActor
    func testPauseKeepsToastAndHapticsAreDistinct() async throws {
        let toasts = ToastCenter(okLifetime: 0.05, resumeLifetime: 0.05)
        let toast = toasts.show("Angehalten")
        toasts.pause(toast.id)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(toasts.toasts.count, 1)
        toasts.resume(toast.id)
        await waitUntil { toasts.toasts.isEmpty }

        toasts.signal(.success)
        let first = toasts.haptic
        toasts.signal(.success)
        XCTAssertNotEqual(first, toasts.haptic)
        XCTAssertEqual(toasts.haptic?.intent, .success)
    }
}
