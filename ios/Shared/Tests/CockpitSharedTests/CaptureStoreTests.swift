import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

final class CaptureStoreTests: XCTestCase {
    @MainActor
    func testOfflineCaptureWaitsAndResendsWithSameCID() async throws {
        let transport = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
        let directory = try temporaryDirectory()
        let context = makeContext(transport, directory: directory)
        let capture = CaptureStore(context: context, retryInterval: 3600)
        capture.text = "! Zahnarzt anrufen"
        XCTAssertEqual(capture.buttonTitle, "Aufgabe anlegen")
        let cid = capture.cid
        await capture.submit()

        // Feld frei, neue ID, Eintrag mit der alten ID im Puffer.
        XCTAssertEqual(capture.text, "")
        XCTAssertNotEqual(capture.cid, cid)
        XCTAssertEqual(capture.entries.map(\.id), [cid])
        XCTAssertEqual(capture.entries.first?.kind, "Aufgabe")
        XCTAssertEqual(capture.outboxSummary, "1 Eintrag wartet auf Netz")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Aufgabe wartet auf Netz und geht automatisch raus.")
        XCTAssertEqual(context.toasts.toasts.last?.kind, .ok)

        // Der Puffer übersteht einen Neustart der App.
        XCTAssertEqual(CaptureStore(context: makeContext(transport, directory: directory)).entries.map(\.id), [cid])

        // Netz wieder da: Nachsenden mit derselben ID.
        transport.respond { _ in (200, try fixture("aktion-erfassen-aufgabe")) }
        var flushed = false
        capture.onFlushed = { flushed = true }
        await capture.flush()
        let resent = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(path(of: resent), "/aktion/erfassen")
        XCTAssertEqual(formFields(resent), ["text": "! Zahnarzt anrufen", "cid": cid])
        XCTAssertTrue(capture.entries.isEmpty)
        XCTAssertTrue(context.outbox.all().isEmpty)
        XCTAssertTrue(flushed)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Nachgesendet: Aufgabe angelegt: INB-7 liegt in Gesundheit, fällig morgen")
    }

    @MainActor
    func testRejectedEntryStaysUntilRetry() async throws {
        let transport = FakeTransport { _ in (400, json(#"{"error":"action_failed","message":"Ungültige Capture-ID"}"#)) }
        let context = makeContext(transport, directory: try temporaryDirectory())
        try context.outbox.put(CaptureOutbox.Entry(id: "cid-1", text: "Notiz", created: context.now()))
        let capture = CaptureStore(context: context, retryInterval: 3600)
        await capture.flush()
        XCTAssertEqual(capture.entries.first?.error, "Ungültige Capture-ID")
        XCTAssertEqual(capture.failedCount, 1)
        XCTAssertEqual(capture.outboxSummary, "1 nicht gesendet")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Ein Eintrag ließ sich nicht nachsenden. Er bleibt im Puffer, siehe Liste.")

        // Ohne `retry` bleibt der abgelehnte Eintrag liegen, mit geht er noch einmal raus.
        let sent = transport.requests.count
        await capture.flush()
        XCTAssertEqual(transport.requests.count, sent)
        transport.respond { _ in (200, json(#"{"ok":true,"message":"Notiz angelegt: inbox/x.md","result":{"kind":"note","path":"inbox/x.md","duplicate":false}}"#)) }
        await capture.flush(retry: true)
        XCTAssertEqual(formFields(transport.requests.last!)["cid"], "cid-1")
        XCTAssertTrue(capture.entries.isEmpty)

        // Zurück ins Feld und Verwerfen.
        try context.outbox.put(CaptureOutbox.Entry(id: "cid-2", text: "Zurück", created: context.now(), error: "abgelehnt"))
        try context.outbox.put(CaptureOutbox.Entry(id: "cid-3", text: "Weg", created: context.now().addingTimeInterval(1)))
        let again = CaptureStore(context: context, retryInterval: 3600)
        again.backToField(again.entries[0])
        XCTAssertEqual(again.text, "Zurück")
        again.discard(again.entries[0])
        XCTAssertTrue(again.entries.isEmpty)
    }

    @MainActor
    func testUnauthorizedParksTextAndAsksForLogin() async throws {
        let transport = FakeTransport { _ in (401, json(#"{"error":"unauthorized","message":"Die Anmeldung ist abgelaufen. Bitte neu anmelden."}"#)) }
        let context = makeContext(transport, directory: try temporaryDirectory())
        var loggedOut = false
        context.onUnauthorized = { loggedOut = true }
        let capture = CaptureStore(context: context, retryInterval: 3600)
        capture.text = "Nicht verlieren"
        await capture.submit()
        XCTAssertTrue(loggedOut)
        XCTAssertTrue(capture.loginNeeded)
        XCTAssertEqual(capture.entries.map(\.text), ["Nicht verlieren"])
    }

    @MainActor
    func testServerRejectionKeepsTextAndCID() async throws {
        let transport = FakeTransport { _ in (503, json(#"{"error":"action_failed","message":"Für Aufgaben mit ! fehlt der Zunder-Zugang (Einstellungen → Zunder)"}"#)) }
        let context = makeContext(transport, directory: try temporaryDirectory())
        let capture = CaptureStore(context: context, retryInterval: 3600)
        capture.text = "! Aufgabe"
        let cid = capture.cid
        await capture.submit()
        XCTAssertEqual(capture.text, "! Aufgabe")
        XCTAssertEqual(capture.cid, cid)
        XCTAssertTrue(capture.entries.isEmpty)
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)
    }

    @MainActor
    func testEmptySubmitOnlyNudges() async throws {
        let transport = FakeTransport()
        let capture = CaptureStore(context: makeContext(transport, directory: try temporaryDirectory()))
        capture.text = "  \n "
        await capture.submit()
        XCTAssertEqual(capture.nudge, 1)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    @MainActor
    func testTaskSuccessOffersOpen() async throws {
        let transport = FakeTransport { _ in (200, try fixture("aktion-erfassen-aufgabe")) }
        let context = makeContext(transport, directory: try temporaryDirectory())
        var opened: URL?
        context.openURL = { opened = $0 }
        let capture = CaptureStore(context: context)
        capture.text = "! Zahnarzt anrufen morgen #gesundheit"
        await capture.submit()
        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.action?.label, "Öffnen")
        context.toasts.perform(toast.id)
        XCTAssertEqual(opened?.absoluteString, "https://zunder.test/#/aufgabe/c2")
    }

    // MARK: Vorschau

    @MainActor
    func testPreviewIsDebouncedAndOnlyForTasksAndArticles() async throws {
        let transport = FakeTransport { _ in (200, try fixture("vorschau-aufgabe")) }
        let capture = CaptureStore(context: makeContext(transport, directory: try temporaryDirectory()), previewDelay: 0.05)
        capture.text = "!"
        capture.text = "! Zahn"
        capture.text = "! Zahnarzt anrufen morgen"
        XCTAssertTrue(transport.requests.isEmpty)
        await waitUntil { capture.preview != nil }
        try await Task.sleep(nanoseconds: 100_000_000)
        // Nur der letzte Stand nach der Pause geht zum Server.
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(queryValue(transport.requests[0], "text"), "! Zahnarzt anrufen morgen")
        XCTAssertEqual(path(of: transport.requests[0]), "/api/erfassen/vorschau")
        XCTAssertEqual(capture.preview?.summary, "Aufgabe · morgen · Gesundheit · Phönix-Schritt KW 42")

        // Notizen bekommen keine Vorschau und fragen nicht.
        capture.text = "Eine Notiz"
        XCTAssertNil(capture.preview)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(transport.requests.count, 1)
    }

    @MainActor
    func testPreviewHidesWhenOfflineAndDropsStaleAnswers() async throws {
        let transport = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
        let capture = CaptureStore(context: makeContext(transport, directory: try temporaryDirectory()), previewDelay: 3600)
        capture.text = "! Aufgabe"
        await capture.refreshPreview()
        XCTAssertNil(capture.preview)

        // Eine langsame Antwort zu altem Text darf die neue Lage nicht überschreiben.
        transport.respond { _ in (200, try fixture("vorschau-aufgabe")) }
        transport.hold = true
        let slow = Task { await capture.refreshPreview() }
        await waitUntil { transport.heldCount == 1 }
        capture.text = "Notiz"
        transport.release()
        await slow.value
        XCTAssertNil(capture.preview)
    }
}

final class ReviewAndPlanStoreTests: XCTestCase {
    @MainActor
    func testReviewLoadsAndPages() async throws {
        let transport = FakeTransport { _ in (200, try fixture("rueckblick")) }
        let context = makeContext(transport, directory: try temporaryDirectory())
        let store = ReviewStore(context: context)
        await store.load()
        XCTAssertEqual(store.model?.content.value?.totals.done, 2)
        XCTAssertNotNil(context.snapshots.load("rueckblick/aktuell"))
        await store.showPrevious()
        XCTAssertEqual(path(of: transport.requests[1]), "/api/rueckblick")
        XCTAssertEqual(queryValue(transport.requests[1], "woche"), "2026-W41")
    }

    @MainActor
    func testPlanActions() async throws {
        let transport = FakeTransport { request in
            switch path(of: request) {
            case "/api/planen": (200, try fixture("planen"))
            case "/aktion/woche/flamme": (200, try fixture("aktion-woche-flamme"))
            case "/aktion/woche/holen": (200, try fixture("aktion-woche-holen"))
            default: (200, json(#"{"ok":true,"message":"Zurückgesetzt: Belege sortieren"}"#))
            }
        }
        let context = makeContext(transport, directory: try temporaryDirectory())
        let store = PlanStore(context: context)
        await store.load(week: "2026-W42", query: PlanQuery(q: "steuer"))
        XCTAssertEqual(queryValue(transport.requests[0], "q"), "steuer")
        let t1 = try XCTUnwrap(store.model?.content.value?.suggestions.first?.tasks.first)

        await store.add(t1, when: .step)
        XCTAssertEqual(formFields(transport.requests[1]), ["id": "t1", "woche": "2026-W42", "wann": "schritt"])
        XCTAssertEqual(path(of: transport.requests[2]), "/api/planen")
        await store.add(t1, when: .day("2026-10-15"))
        XCTAssertEqual(formFields(transport.requests[3])["wann"], "2026-10-15")

        // Rückgängig aus dem Toast setzt zurück und lädt neu.
        let undo = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(undo.action?.label, "Rückgängig")
        context.toasts.perform(undo.id)
        await waitUntil { transport.requests.count == 7 }
        XCTAssertEqual(path(of: transport.requests[5]), "/aktion/woche/zuruecksetzen")
        XCTAssertEqual(formFields(transport.requests[5]), ["id": "t1", "phoenix": ""])

        // „Als Flamme“: Formular mit Wurzelaufgabe, danach wieder leer.
        await store.planFlame(from: t1)
        XCTAssertEqual(queryValue(transport.requests[7], "aus"), "t1")
        var draft = store.flameDraft()
        XCTAssertEqual(draft.day, "2026-10-14")
        draft.title = "Folien bauen"
        draft.time = "09:00"
        await store.createFlame(draft)
        XCTAssertEqual(formFields(transport.requests[8]), ["woche": "2026-W42", "titel": "Folien bauen", "tag": "2026-10-14", "zeit": "09:00", "aus": "t1"])
        XCTAssertEqual(store.query.from, "")
        XCTAssertNil(queryValue(transport.requests[9], "aus"))
        XCTAssertEqual(queryValue(transport.requests[9], "q"), "steuer")

        // „Holen“ und „Aus der Woche“ stehen sofort da, bis die Seite neu geladen ist.
        let count = transport.requests.count
        transport.hold = true
        let adding = Task { await store.add(t1, when: .day("2026-10-15")) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertEqual(store.plannedReason(t1), PlanReason.due)
        XCTAssertTrue(store.busy.contains("t1"))
        transport.hold = false
        transport.release()
        _ = await adding.value
        XCTAssertNil(store.plannedReason(t1))
        XCTAssertTrue(store.pending.isEmpty)
        XCTAssertEqual(transport.requests.count, count + 2)

        let flame = try XCTUnwrap(store.model?.content.value?.planned.flames.last)
        transport.respond { _ in (409, json(#"{"error":"action_failed","message":"Zunder antwortet nicht"}"#)) }
        transport.hold = true
        let removing = Task { await store.remove(flame) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertNil(store.plannedReason(flame))
        transport.hold = false
        transport.release()
        let removed = await removing.value
        XCTAssertFalse(removed)
        XCTAssertEqual(store.plannedReason(flame), PlanReason.flame)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Zunder antwortet nicht")
        transport.respond { request in
            switch path(of: request) {
            case "/api/planen": (200, try fixture("planen"))
            default: (200, try fixture("aktion-woche-flamme"))
            }
        }

        // Ohne Wurzelaufgabe zählt der Ort.
        draft.place = .area("a2")
        await store.createFlame(draft)
        let last = try XCTUnwrap(transport.requests.last { path(of: $0) == "/aktion/woche/flamme" })
        XCTAssertEqual(formFields(last)["ort"], "area:a2")
        XCTAssertNil(formFields(last)["aus"])
    }
}
