import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

final class WeekStoreTests: XCTestCase {
    /// Antwortet je Pfad mit einer Fixture; Aktionen ohne eigene Antwort mit `{ok, message}`.
    private func server(_ routes: [String: String] = [:]) -> FakeTransport {
        FakeTransport { request in
            let p = path(of: request)
            if let name = routes[p] { return (200, try fixture(name)) }
            if p == "/api/woche" { return (200, try fixture("woche")) }
            return (200, json(#"{"ok":true,"message":"Gespeichert"}"#))
        }
    }

    @MainActor
    private func makeStore(_ transport: FakeTransport) throws -> (WeekStore, CockpitContext) {
        let context = makeContext(transport, directory: try temporaryDirectory())
        let capture = CaptureStore(context: context, previewDelay: 0.01, retryInterval: 3600)
        return (WeekStore(context: context, capture: capture), context)
    }

    @MainActor
    private func task(_ store: WeekStore, _ id: String) throws -> ZunderTask {
        try XCTUnwrap(store.model?.tasks(withID: id).first)
    }

    // MARK: Laden

    @MainActor
    func testShowsSnapshotFirstThenRefreshes() async throws {
        let transport = server()
        let (store, context) = try makeStore(transport)
        let saved = Date(timeIntervalSince1970: 1_700_000_000)
        try context.snapshots.save(try fixture("woche-ohne-zunder"), for: "woche/aktuell", at: saved)

        transport.hold = true
        let loading = Task { await store.load() }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertEqual(store.model?.week.id, "2026-W43")
        XCTAssertTrue(store.state.isStale)
        XCTAssertTrue(store.state.isRefreshing)
        XCTAssertEqual(store.state.lastUpdated, saved)

        transport.release()
        await loading.value
        XCTAssertEqual(store.model?.week.id, "2026-W42")
        XCTAssertFalse(store.state.isStale)
        XCTAssertFalse(store.state.isRefreshing)
        XCTAssertEqual(store.state.lastUpdated, context.now())
        XCTAssertNil(transport.requests[0].url?.query)
        // Der neue Stand liegt jetzt im Zwischenspeicher.
        XCTAssertEqual(context.snapshots.load("woche/aktuell")?.data, try fixture("woche"))
    }

    @MainActor
    func testOfflineKeepsSnapshot() async throws {
        let transport = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
        let (store, context) = try makeStore(transport)
        try context.snapshots.save(try fixture("woche"), for: "woche/aktuell", at: Date(timeIntervalSince1970: 1_700_000_000))
        await store.load()
        XCTAssertEqual(store.model?.week.id, "2026-W42")
        XCTAssertTrue(store.state.isStale)
        XCTAssertTrue(store.state.isOffline)
        XCTAssertEqual(store.state.error?.message, "Keine Verbindung zum Cockpit.")
    }

    @MainActor
    func testCancelledLoadIsNoError() async throws {
        // `.task` des Bildschirms abgebrochen (Reiter gewechselt): nicht „offline“.
        let transport = FakeTransport { _ in throw URLError(.cancelled) }
        let (store, context) = try makeStore(transport)
        try context.snapshots.save(try fixture("woche"), for: "woche/aktuell", at: Date(timeIntervalSince1970: 1_700_000_000))
        await store.load()
        XCTAssertEqual(store.model?.week.id, "2026-W42")
        XCTAssertNil(store.state.error)
        XCTAssertFalse(store.state.isOffline)
        XCTAssertFalse(store.state.isRefreshing)
    }

    @MainActor
    func testUnauthorizedAsksForLogin() async throws {
        let transport = FakeTransport { _ in (401, json(#"{"error":"unauthorized"}"#)) }
        let (store, context) = try makeStore(transport)
        var loggedOut = false
        context.onUnauthorized = { loggedOut = true }
        await store.load()
        XCTAssertTrue(loggedOut)
        XCTAssertNil(store.model)
        XCTAssertEqual(store.state.error?.isUnauthorized, true)
    }

    @MainActor
    func testNavigation() async throws {
        let transport = server()
        let (store, _) = try makeStore(transport)
        await store.load()
        await store.showNext()
        XCTAssertEqual(store.requestedWeek, "2026-W43")
        XCTAssertEqual(queryValue(transport.requests[1], "woche"), "2026-W43")
        await store.showPrevious()
        // Die Attrappe liefert immer KW 42, also geht es von dort zurück.
        XCTAssertEqual(queryValue(transport.requests[2], "woche"), "2026-W41")
        await store.showCurrent()
        XCTAssertNil(store.requestedWeek)
        XCTAssertNil(transport.requests[3].url?.query)
    }

    // MARK: Abhaken

    @MainActor
    func testTickIsOptimisticAndRecountsRocks() async throws {
        let transport = server(["/aktion/status": "aktion-status"])
        let (store, context) = try makeStore(transport)
        await store.load()
        let t2 = try task(store, "t2")
        XCTAssertEqual(store.model?.rocks.value?.groups[0].done, 1)

        transport.hold = true
        let ticking = Task { await store.toggle(t2) }
        await waitUntil { transport.heldCount == 1 }
        // Sofort abgehakt und neu gezählt, bevor der Server antwortet.
        XCTAssertEqual(try task(store, "t2").status, .done)
        XCTAssertEqual(store.model?.rocks.value?.groups[0].done, 2)
        XCTAssertEqual(store.model?.rocks.value?.groups[0].allDone, true)
        XCTAssertTrue(store.busy.contains("t2"))
        XCTAssertEqual(context.toasts.haptic?.intent, .success)

        transport.hold = false
        transport.release()
        await ticking.value
        XCTAssertFalse(store.busy.contains("t2"))
        let request = transport.requests[1]
        XCTAssertEqual(path(of: request), "/aktion/status")
        XCTAssertEqual(formFields(request), ["id": "t2", "status": "done", "prev": "open"])
        // Wie im Web: nach dem Abhaken wird nicht neu geladen.
        XCTAssertEqual(transport.requests.count, 2)
        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.message, "Erledigt: FIN-2 Steuererklärung abgeben")
        XCTAssertEqual(toast.action?.label, "Rückgängig")

        // Rückgängig: wieder optimistisch, mit dem Status aus `undo`.
        transport.respond { _ in (200, json(#"{"ok":true,"message":"Wieder offen: FIN-2 Steuererklärung abgeben","task":{"id":"t2","title":"Steuererklärung abgeben","status":"open"}}"#)) }
        context.toasts.perform(toast.id)
        await waitUntil { transport.requests.count == 3 && !store.busy.contains("t2") }
        XCTAssertEqual(formFields(transport.requests[2]), ["id": "t2", "status": "open", "prev": "done"])
        XCTAssertEqual(try task(store, "t2").status, .open)
        XCTAssertEqual(store.model?.rocks.value?.groups[0].done, 1)
    }

    @MainActor
    func testTickRollsBackWhenServerRejects() async throws {
        let transport = server()
        let (store, context) = try makeStore(transport)
        await store.load()
        transport.respond { _ in (502, json(#"{"error":"action_failed","message":"Zunder antwortet mit HTTP 502"}"#)) }
        await store.toggle(try task(store, "t3"))
        XCTAssertEqual(try task(store, "t3").status, .done)
        XCTAssertEqual(store.model?.rocks.value?.groups[0].done, 1)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Zunder antwortet mit HTTP 502")
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)
        XCTAssertEqual(context.toasts.haptic?.intent, .error)
    }

    @MainActor
    func testTickOfflineRollsBack() async throws {
        let transport = server()
        let (store, context) = try makeStore(transport)
        await store.load()
        transport.respond { _ in throw URLError(.timedOut) }
        await store.toggle(try task(store, "i1"))
        XCTAssertEqual(try task(store, "i1").status, .open)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Keine Verbindung zum Cockpit. Nichts gespeichert.")
    }

    // MARK: Menü und Rückgängig

    @MainActor
    func testMenuActionReloadsAndUndoReplays() async throws {
        let transport = server(["/aktion/faellig": "aktion-faellig"])
        let (store, context) = try makeStore(transport)
        await store.load()
        let ok = await store.setDue(try task(store, "t2"), .date("2026-10-20"))
        XCTAssertTrue(ok)
        XCTAssertEqual(transport.requests.map(path(of:)), ["/api/woche", "/aktion/faellig", "/api/woche"])
        XCTAssertEqual(formFields(transport.requests[1]), ["id": "t2", "due": "datum", "date": "2026-10-20", "prev": "2026-10-16"])

        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.message, "Fällig Do 15.10.: Zahnarzt Termin")
        context.toasts.perform(toast.id)
        await waitUntil { transport.requests.count == 5 }
        XCTAssertEqual(path(of: transport.requests[3]), "/aktion/faellig")
        XCTAssertEqual(formFields(transport.requests[3]), ["id": "t5", "due": "keine"])
        XCTAssertEqual(path(of: transport.requests[4]), "/api/woche")
        // Die Meldung nach Rückgängig hat kein weiteres Rückgängig.
        await waitUntil { context.toasts.toasts.count == 1 && context.toasts.toasts[0].id != toast.id }
        XCTAssertNil(context.toasts.toasts.last?.action)
    }

    @MainActor
    func testMenuFields() async throws {
        let transport = server()
        let (store, _) = try makeStore(transport)
        await store.load()
        let t6 = try task(store, "t6")
        XCTAssertTrue(store.isStepOfShownWeek(t6))
        await store.togglePhoenix(t6)
        XCTAssertEqual(formFields(transport.requests[1]), ["id": "t6", "fire": "", "prev": "2026-W42"])
        await store.togglePhoenix(try task(store, "t2"))
        XCTAssertEqual(formFields(transport.requests[3]), ["id": "t2", "fire": "2026-W42", "prev": ""])
        await store.setStatus(t6, to: .inProgress)
        XCTAssertEqual(formFields(transport.requests[5]), ["id": "t6", "status": "in_progress", "prev": "blocked"])
        await store.move(try task(store, "i1"), to: .project("p1"))
        XCTAssertEqual(formFields(transport.requests[7]), ["id": "i1", "ziel": "project:p1", "prev": "inbox"])
        await store.stopBurning()
        XCTAssertEqual(formFields(transport.requests[9]), ["id": "t9", "an": "0"])
        await store.toggleFlame(try task(store, "t7"))
        XCTAssertEqual(formFields(transport.requests[11]), ["id": "t7", "an": "1"])
        await store.removeFromWeek(try task(store, "t9"))
        XCTAssertEqual(path(of: transport.requests[13]), "/aktion/woche/raus")
        await store.saveFeuer(.firstMove, text: "Kaffee.")
        XCTAssertEqual(formFields(transport.requests[15]), ["pfad": "phoenix/Feuer W3.md", "feld": "zug", "text": "Kaffee."])
        XCTAssertFalse(store.canCreateFeuer)
    }

    @MainActor
    func testCreateFeuerNeedsGoal() async throws {
        let transport = FakeTransport { request in
            path(of: request) == "/api/woche" ? (200, try fixture("woche-ohne-zunder")) : (200, json(#"{"ok":true,"message":"Feuer W4 - 2026-Q4 angelegt","path":"phoenix/Feuer W4.md"}"#))
        }
        let (store, context) = try makeStore(transport)
        await store.load(week: "2026-W43")
        XCTAssertTrue(store.canCreateFeuer)
        let empty = await store.createFeuer(goal: "  ", firstMove: "")
        XCTAssertFalse(empty)
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)
        let created = await store.createFeuer(goal: "Workshop halten", firstMove: "Laptop auf")
        XCTAssertTrue(created)
        XCTAssertEqual(formFields(transport.requests[1]), ["woche": "2026-W43", "ziel": "Workshop halten", "zug": "Laptop auf"])
    }

    // MARK: Schnelleingabe

    @MainActor
    func testCapturedNoteAndInboxTaskAppearInInbox() async throws {
        let transport = server(["/aktion/erfassen": "aktion-erfassen-notiz"])
        let (store, _) = try makeStore(transport)
        await store.load()
        store.capture.text = "Gedanke für später"
        await store.capture.submit()
        XCTAssertEqual(store.model?.inbox.vault.value?.first?.title, "Web-Cockpit")
        XCTAssertEqual(store.capture.text, "")

        transport.respond { _ in (200, json(#"{"ok":true,"message":"Aufgabe angelegt: INB-8 liegt in der Zunder-Inbox","result":{"kind":"task","id":"c9","ref":"INB-8","url":"https://zunder.test/#/aufgabe/c9","title":"Milch","due":null,"dueLabel":"","location":{"kind":"inbox"},"phoenix":null,"notes":[]}}"#)) }
        store.capture.text = "! Milch"
        await store.capture.submit()
        XCTAssertEqual(store.model?.inbox.zunder.value?.first?.title, "Milch")
        XCTAssertEqual(store.model?.inbox.count, 5)

        // Aufgabe mit Ziel (`#gesundheit`) landet nicht in der Inbox.
        transport.respond { _ in (200, try fixture("aktion-erfassen-aufgabe")) }
        store.capture.text = "! Zahnarzt anrufen morgen #gesundheit"
        await store.capture.submit()
        XCTAssertEqual(store.model?.inbox.count, 5)
    }
}
