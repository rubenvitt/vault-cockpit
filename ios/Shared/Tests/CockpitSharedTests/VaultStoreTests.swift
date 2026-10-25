import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// Notiz, Graph, Suche, Wissen und Zustand gegen eine Attrappe mit den echten Antworten.
final class VaultStoreTests: XCTestCase {
    /// Antwortet je Pfad mit einer Fixture; sonst `{ok, message}`.
    private func server(_ routes: [String: String] = [:]) -> FakeTransport {
        FakeTransport { request in
            let p = path(of: request)
            if let name = routes[p] { return (200, try fixture(name)) }
            switch p {
            case "/api/notiz": return (200, try fixture("rest-notiz"))
            case "/api/graph": return (200, try fixture("rest-graph"))
            default: return (200, json(#"{"ok":true,"message":"Erledigt"}"#))
            }
        }
    }

    @MainActor
    private func setup(_ transport: FakeTransport) throws -> CockpitContext {
        makeContext(transport, directory: try temporaryDirectory())
    }

    // MARK: Notiz

    @MainActor
    func testNoteLoadsSnapshotThenRefreshes() async throws {
        let transport = server()
        let context = try setup(transport)
        try context.snapshots.save(try fixture("rest-notiz"), for: "notiz/00-inbox/Idee.md", at: Date(timeIntervalSince1970: 1_700_000_000))
        let store = NoteStore(context: context, path: "00-inbox/Idee.md")
        transport.hold = true
        let loading = Task { await store.load() }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertEqual(store.model?.title, "Idee")
        XCTAssertTrue(store.state.isStale)
        transport.release()
        await loading.value
        XCTAssertFalse(store.state.isStale)
        XCTAssertEqual(queryValue(transport.requests[0], "pfad"), "00-inbox/Idee.md")
        XCTAssertTrue(store.canWrite)
        XCTAssertEqual(store.tagsText, "idee")
    }

    @MainActor
    func testNoteNotFound() async throws {
        let transport = FakeTransport { _ in (404, try fixture("rest-notiz-fehlt")) }
        let store = NoteStore(context: try setup(transport), path: "privat/Geheim.md")
        await store.load()
        XCTAssertNil(store.model)
        XCTAssertEqual(store.state.error, .failed(status: 404, code: "not_found", message: "„privat/Geheim.md“ gibt es nicht, oder sie liegt in einem vertraulichen oder ausgeschlossenen Ordner."))
    }

    @MainActor
    func testCheckboxIsOptimisticWithUndo() async throws {
        let transport = server(["/aktion/notiz/checkbox": "rest-aktion-notiz-checkbox"])
        let context = try setup(transport)
        let store = NoteStore(context: context, path: "00-inbox/Idee.md")
        await store.load()
        let box = try XCTUnwrap(store.model?.checkboxes.first)
        XCTAssertFalse(box.done)

        transport.hold = true
        let ticking = Task { await store.toggle(box) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertEqual(store.model?.checkboxes.first?.done, true)
        XCTAssertTrue(store.isBusy(.checkbox(0)))
        transport.hold = false
        transport.release()
        let ok = await ticking.value
        XCTAssertTrue(ok)
        let sent = formFields(transport.requests[1])
        XCTAssertEqual(sent, ["pfad": "00-inbox/Idee.md", "n": "0", "line": "- [ ] Preise vergleichen", "erledigt": "1"])
        XCTAssertEqual(transport.requests[1].value(forHTTPHeaderField: "Accept"), "application/json")
        // Die neue Zeile laut Server gilt für das nächste Abhaken.
        XCTAssertEqual(store.model?.checkboxes.first?.line, "- [x] Preise vergleichen")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Abgehakt")
        XCTAssertEqual(context.toasts.haptic?.intent, .success)

        // Rückgängig: wieder offen, mit den Feldern aus `undo`.
        transport.respond { _ in (200, json(#"{"ok":true,"message":"Wieder offen","path":"00-inbox/Idee.md","n":0,"line":"- [ ] Preise vergleichen","done":false}"#)) }
        context.toasts.perform(try XCTUnwrap(context.toasts.toasts.last?.id))
        await waitUntil { transport.requests.count == 3 && store.busy.isEmpty }
        XCTAssertEqual(formFields(transport.requests[2])["erledigt"], "0")
        XCTAssertEqual(formFields(transport.requests[2])["line"], "- [x] Preise vergleichen")
        await waitUntil { store.model?.checkboxes.first?.done == false }
        XCTAssertEqual(store.model?.checkboxes.first?.line, "- [ ] Preise vergleichen")
    }

    @MainActor
    func testStaleCheckboxRevertsAndReloads() async throws {
        let transport = server()
        let context = try setup(transport)
        let store = NoteStore(context: context, path: "00-inbox/Idee.md")
        await store.load()
        transport.respond { request in
            if path(of: request) == "/aktion/notiz/checkbox" { return (400, try fixture("rest-aktion-notiz-checkbox-veraltet")) }
            return (200, try fixture("rest-notiz"))
        }
        let ok = await store.toggle(try XCTUnwrap(store.model?.checkboxes.first))
        XCTAssertFalse(ok)
        XCTAssertEqual(store.model?.checkboxes.first?.done, false)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Die Checkbox steht nicht mehr an dieser Stelle. Bitte neu laden.")
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)
        // Neu geladen, damit Nummern und Zeilen wieder stimmen.
        XCTAssertEqual(path(of: transport.requests.last!), "/api/notiz")
    }

    @MainActor
    func testCalloutCheckboxIsDisplayOnly() async throws {
        let transport = server()
        let store = NoteStore(context: try setup(transport), path: "00-inbox/Idee.md")
        await store.load()
        let ok = await store.toggle(NoteCheckbox(done: false, n: nil, line: nil))
        XCTAssertFalse(ok)
        XCTAssertEqual(transport.requests.count, 1)
    }

    @MainActor
    func testFileMovesToNewPathAndUndoMovesBack() async throws {
        let transport = FakeTransport { request in
            switch (path(of: request), queryValue(request, "pfad")) {
            case ("/aktion/notiz/ablegen", _):
                let fields = formFields(request)
                if fields["ordner"] == "00-inbox" { return (200, json(#"{"ok":true,"message":"Abgelegt in 00-inbox/","path":"00-inbox/Idee.md","from":"wiki/Idee.md","folder":"00-inbox","redirect":"/notiz?pfad=00-inbox%2FIdee.md","undo":null}"#)) }
                return (200, try fixture("rest-aktion-notiz-ablegen"))
            default: return (200, try fixture("rest-notiz"))
            }
        }
        let context = try setup(transport)
        let store = NoteStore(context: context, path: "00-inbox/Idee.md")
        await store.load()
        let ok = await store.file(to: " wiki/ ")
        XCTAssertTrue(ok)
        XCTAssertEqual(formFields(transport.requests[1]), ["pfad": "00-inbox/Idee.md", "ordner": "wiki", "back": "/notiz?pfad=00-inbox%2FIdee.md"])
        XCTAssertEqual(store.path, "wiki/Idee.md")
        XCTAssertEqual(store.movedFrom, "00-inbox/Idee.md")
        XCTAssertEqual(queryValue(transport.requests[2], "pfad"), "wiki/Idee.md")
        XCTAssertEqual(context.toasts.toasts.last?.action?.label, "Rückgängig")

        context.toasts.perform(try XCTUnwrap(context.toasts.toasts.last?.id))
        await waitUntil { store.path == "00-inbox/Idee.md" }
        XCTAssertEqual(formFields(transport.requests[3])["ordner"], "00-inbox")
        XCTAssertEqual(formFields(transport.requests[3])["pfad"], "wiki/Idee.md")
    }

    @MainActor
    func testFileNeedsFolderAndArchiveUsesArchive() async throws {
        let transport = server(["/aktion/notiz/ablegen": "rest-aktion-notiz-ablegen"])
        let context = try setup(transport)
        let store = NoteStore(context: context, path: "00-inbox/Idee.md")
        await store.load()
        let empty = await store.file(to: "  ")
        XCTAssertFalse(empty)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Bitte einen Zielordner angeben.")
        XCTAssertEqual(transport.requests.count, 1)
        _ = await store.archive()
        XCTAssertEqual(formFields(transport.requests[1])["ordner"], "40-archiv")
    }

    @MainActor
    func testForbiddenFolderKeepsNote() async throws {
        let transport = server()
        let context = try setup(transport)
        let store = NoteStore(context: context, path: "00-inbox/Idee.md")
        await store.load()
        transport.respond { request in
            if path(of: request) == "/aktion/notiz/ablegen" { return (403, try fixture("rest-aktion-notiz-ablegen-verboten")) }
            return (200, try fixture("rest-notiz"))
        }
        let ok = await store.file(to: "privat")
        XCTAssertFalse(ok)
        XCTAssertEqual(store.path, "00-inbox/Idee.md")
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)
    }

    @MainActor
    func testTagsAppendLinkTasksEvidence() async throws {
        let transport = server([
            "/aktion/notiz/tags": "rest-aktion-notiz-tags",
            "/aktion/notiz/anhaengen": "rest-aktion-notiz-anhaengen",
            "/aktion/verlinken": "rest-aktion-verlinken",
        ])
        let context = try setup(transport)
        let store = NoteStore(context: context, path: "00-inbox/Idee.md")
        await store.load()

        let tagged = await store.addTags(["hund", "idee"])
        XCTAssertTrue(tagged)
        XCTAssertEqual(formFields(transport.requests[1]), ["pfad": "00-inbox/Idee.md", "tags": "idee, hund"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "Tags: #idee #hund")

        store.appendDraft = "  Noch ein Gedanke  "
        let appended = await store.append()
        XCTAssertTrue(appended)
        let appendRequest = try XCTUnwrap(transport.requests.first { path(of: $0) == "/aktion/notiz/anhaengen" })
        XCTAssertEqual(formFields(appendRequest)["text"], "Noch ein Gedanke")
        XCTAssertEqual(store.appendDraft, "")
        let tooLong = await store.append(String(repeating: "x", count: NoteStore.appendLimit + 1))
        XCTAssertFalse(tooLong)

        let linked = await store.link(to: "wiki/Training.md")
        XCTAssertTrue(linked)
        let linkRequest = try XCTUnwrap(transport.requests.first { path(of: $0) == "/aktion/verlinken" })
        XCTAssertEqual(formFields(linkRequest), ["pfad": "00-inbox/Idee.md", "ziel": "wiki/Training.md"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "Verlinkt: Training")

        // Keine Synthese: „Als Aufgaben nach Zunder“ gibt es nicht.
        let tasks = await store.createTasks()
        XCTAssertFalse(tasks)
    }

    @MainActor
    func testSynthesisTasksAndEvidenceWithUndo() async throws {
        let transport = server([
            "/api/notiz": "rest-notiz-synthese",
            "/aktion/synthese/aufgaben": "rest-aktion-synthese-aufgaben",
            "/aktion/synthese/beleg": "rest-aktion-synthese-beleg",
            "/aktion/synthese/beleg/entfernen": "rest-aktion-synthese-beleg-entfernen",
        ])
        let context = try setup(transport)
        let store = NoteStore(context: context, path: "wiki/synthesis/Selbstkontrolle.md")
        await store.load()
        let created = await store.createTasks()
        XCTAssertTrue(created)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Nach Zunder: 1 Aufgabe, 1 schon dort")
        let evidence = try XCTUnwrap(store.model?.evidence?.first)
        let attached = await store.attachEvidence(evidence)
        XCTAssertTrue(attached)
        let attach = try XCTUnwrap(transport.requests.first { path(of: $0) == "/aktion/synthese/beleg" })
        XCTAssertEqual(formFields(attach), ["pfad": "wiki/synthesis/Selbstkontrolle.md", "markierung": "hl-1"])
        context.toasts.perform(try XCTUnwrap(context.toasts.toasts.last { $0.action != nil }?.id))
        await waitUntil { transport.requests.contains { path(of: $0) == "/aktion/synthese/beleg/entfernen" } }
        let remove = try XCTUnwrap(transport.requests.first { path(of: $0) == "/aktion/synthese/beleg/entfernen" })
        XCTAssertEqual(formFields(remove)["markierung"], "hl-1")
        await waitUntil { context.toasts.toasts.last?.message == "Beleg entfernt" }
    }

    @MainActor
    func testImageDataUsesTokenAndCaches() async throws {
        let transport = FakeTransport { request in
            if path(of: request) == "/notiz/bild" { return (200, Data([1, 2, 3])) }
            return (200, try fixture("rest-notiz"))
        }
        let store = NoteStore(context: try setup(transport), path: "00-inbox/Idee.md")
        let first = await store.imageData("/notiz/bild?pfad=00-inbox%2Ffoto.png")
        let second = await store.imageData("/notiz/bild?pfad=00-inbox%2Ffoto.png")
        XCTAssertEqual(first, Data([1, 2, 3]))
        XCTAssertEqual(second, first)
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(queryValue(transport.requests[0], "pfad"), "00-inbox/foto.png")
        XCTAssertEqual(transport.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
    }

    // MARK: Graph

    @MainActor
    func testGraphLoadsAndFilters() async throws {
        let transport = server()
        let store = GraphStore(context: try setup(transport), path: "2026-10-25.md")
        await store.load()
        XCTAssertEqual(store.center, "note:2026-10-25.md")
        XCTAssertEqual(store.nodes.count, 8)
        XCTAssertEqual(store.edges.count, 7)
        XCTAssertTrue(store.loaded.contains("note:2026-10-25.md"))
        XCTAssertEqual(store.visibleNodes.count, 8)
        XCTAssertEqual(store.similarity(of: "note:wiki/synthesis/Gewohnheit.md"), 0.734)
        XCTAssertTrue(store.canLink("note:wiki/synthesis/Gewohnheit.md"))
        XCTAssertFalse(store.canLink("note:wiki/Training.md"))
        XCTAssertEqual(store.cardMeta("note:wiki/synthesis/Gewohnheit.md"), "wiki/synthesis/Gewohnheit.md · ähnlich, 73 %")
        XCTAssertEqual(store.cardMeta("task:t1"), "HUN-3 · in Arbeit")
        XCTAssertEqual(store.cardMeta("event:1", timeZone: TimeZone(identifier: "Europe/Berlin")!), "10:00–11:00 · Privat")
        XCTAssertEqual(store.cardMeta("event:2"), "ganztägig")

        store.filters.task = false
        XCTAssertFalse(store.isVisible("task:t1"))
        XCTAssertFalse(store.visibleEdges.contains { $0.kind == .task })
        store.filters[.semantic] = false
        XCTAssertFalse(store.isVisible("note:wiki/synthesis/Gewohnheit.md"))
        XCTAssertTrue(store.isVisible("note:2026-10-25.md"))
        store.filters = GraphFilters()
        XCTAssertEqual(store.visibleNodes.count, 8)
    }

    @MainActor
    func testGraphSelectExpandsNeighbours() async throws {
        let transport = FakeTransport { request in
            if queryValue(request, "pfad") == "wiki/Training.md" {
                return (200, json(#"""
                {"center":"note:wiki/Training.md","nodes":[
                  {"id":"note:wiki/Training.md","kind":"note","path":"wiki/Training.md","level":0,"label":"Training"},
                  {"id":"note:2026-10-25.md","kind":"note","path":"2026-10-25.md","level":1,"label":"2026-10-25"},
                  {"id":"note:wiki/Hund.md","kind":"note","path":"wiki/Hund.md","level":1,"label":"Hund"},
                  {"id":"task:t2","kind":"task","taskId":"t2","label":"Tierarzt","status":"done","level":1}],
                 "edges":[{"from":"note:2026-10-25.md","to":"note:wiki/Training.md","kind":"link"},
                          {"from":"note:wiki/Training.md","to":"note:wiki/Hund.md","kind":"link"},
                          {"from":"note:wiki/Training.md","to":"task:t2","kind":"task"}],
                 "problems":[]}
                """#))
            }
            return (200, try fixture("rest-graph"))
        }
        let store = GraphStore(context: try setup(transport), path: "2026-10-25.md")
        await store.load()
        await store.select("note:wiki/Training.md")
        XCTAssertEqual(store.selected, "note:wiki/Training.md")
        XCTAssertTrue(store.loaded.contains("note:wiki/Training.md"))
        XCTAssertEqual(store.nodes.count, 9)
        XCTAssertEqual(store.edges.count, 8)
        XCTAssertEqual(store.addedNear["note:wiki/Hund.md"], "note:wiki/Training.md")
        XCTAssertEqual(store.node("note:wiki/Hund.md")?.level, 2)
        // Bekannte Knoten bekommen den neuen Stand, die Stufe bleibt.
        XCTAssertEqual(store.node("task:t2")?.status, .done)
        XCTAssertEqual(store.node("note:2026-10-25.md")?.level, 0)
        XCTAssertEqual(store.neighbours(of: "note:wiki/Training.md"), ["note:2026-10-25.md", "note:wiki/Hund.md", "task:t2"])
        // Ein zweites Antippen lädt nicht noch einmal.
        await store.select("task:t1")
        await store.select("note:wiki/Training.md")
        XCTAssertEqual(transport.requests.count, 2)
        // Ausgeblendet verliert die Auswahl.
        await store.select("task:t1")
        store.filters.task = false
        XCTAssertNil(store.selected)
    }

    @MainActor
    func testGraphLinkTurnsEdgeIntoLink() async throws {
        let transport = server(["/aktion/verlinken": "rest-aktion-verlinken"])
        let context = try setup(transport)
        let store = GraphStore(context: context, path: "2026-10-25.md")
        await store.load()
        let ok = await store.link(node: "note:wiki/synthesis/Gewohnheit.md")
        XCTAssertTrue(ok)
        let request = try XCTUnwrap(transport.requests.first { path(of: $0) == "/aktion/verlinken" })
        XCTAssertEqual(formFields(request), ["pfad": "2026-10-25.md", "ziel": "wiki/synthesis/Gewohnheit.md"])
        let edge = try XCTUnwrap(store.edgeToCenter("note:wiki/synthesis/Gewohnheit.md"))
        XCTAssertEqual(edge.kind, .link)
        XCTAssertNil(edge.score)
        XCTAssertFalse(store.canLink("note:wiki/synthesis/Gewohnheit.md"))
        XCTAssertEqual(context.toasts.toasts.last?.message, "Verlinkt: Training")
        // Danach die Listen neu (die Attrappe liefert wieder den alten Stand, der Link bleibt).
        XCTAssertEqual(path(of: transport.requests.last!), "/api/graph")
        XCTAssertEqual(store.edgeToCenter("note:wiki/synthesis/Gewohnheit.md")?.kind, .link)
    }

    @MainActor
    func testGraphRecenterResets() async throws {
        let transport = server()
        let store = GraphStore(context: try setup(transport), path: "2026-10-25.md")
        await store.load()
        await store.select("task:t1")
        transport.respond { _ in (404, try fixture("rest-graph-fehlt")) }
        await store.load(path: "weg.md")
        XCTAssertEqual(store.path, "weg.md")
        XCTAssertNil(store.selected)
        XCTAssertEqual(store.nodes, [])
        XCTAssertEqual(store.state.error?.message, "Notiz nicht im Index")
    }

    // MARK: Suche

    @MainActor
    func testLiveSearchDebouncesAndLastWins() async throws {
        let transport = FakeTransport { request in
            if queryValue(request, "alle") == "1" { return (200, try fixture("rest-suche-alle")) }
            return (200, try fixture("rest-suche"))
        }
        let store = SearchStore(context: try setup(transport), debounce: 0.05)
        store.query = "H"
        XCTAssertFalse(store.isActive)
        XCTAssertFalse(store.isSearching)
        store.query = "Hu"
        store.query = "Hun"
        store.query = "Hund"
        XCTAssertTrue(store.isSearching)
        await waitUntil { store.live != nil && !store.isSearching }
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(queryValue(transport.requests[0], "q"), "Hund")
        XCTAssertNil(queryValue(transport.requests[0], "alle"))
        XCTAssertEqual(store.results.count, 8)
        XCTAssertTrue(store.hasMore)
        XCTAssertEqual(store.total, 12)
        XCTAssertEqual(store.degraded, "Bedeutungssuche gerade nicht verfügbar, nur Volltext")

        await store.showAll()
        XCTAssertEqual(queryValue(transport.requests[1], "alle"), "1")
        XCTAssertEqual(store.results.count, 12)
        XCTAssertFalse(store.hasMore)

        // Unter zwei Zeichen: nichts mehr.
        store.query = "H"
        XCTAssertNil(store.live)
        XCTAssertNil(store.full)
        XCTAssertEqual(store.results, [])
        store.clear()
        XCTAssertEqual(store.query, "")
    }

    @MainActor
    func testSlowOlderSearchIsDropped() async throws {
        let transport = FakeTransport { request in
            if queryValue(request, "q") == "Hu" { return (200, try fixture("rest-suche-leer")) }
            return (200, try fixture("rest-suche"))
        }
        let store = SearchStore(context: try setup(transport), debounce: 0)
        transport.hold = true
        store.query = "Hu"
        await waitUntil { transport.heldCount == 1 }
        store.query = "Hund"
        await waitUntil { transport.heldCount == 2 }
        transport.release()
        await waitUntil { !store.isSearching }
        XCTAssertEqual(store.live?.query, "Hund")
    }

    @MainActor
    func testSearchOfflineShowsError() async throws {
        let transport = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
        let store = SearchStore(context: try setup(transport), debounce: 0)
        await store.open(query: "Hund")
        XCTAssertEqual(store.error?.isOffline, true)
        XCTAssertFalse(store.isLoadingAll)
    }

    // MARK: Wissen, Zustand, Woche

    @MainActor
    func testWissenFilters() async throws {
        let transport = FakeTransport { request in
            (200, try fixture(queryValue(request, "q") == nil ? "rest-wissen" : "rest-wissen-frage"))
        }
        let context = try setup(transport)
        let store = WissenStore(context: context)
        await store.load()
        XCTAssertNil(transport.requests[0].url?.query)
        XCTAssertNil(store.model?.hits)
        await store.load(WissenQuery(q: " Willen ", status: "entwurf"))
        XCTAssertEqual(store.query.q, "Willen")
        XCTAssertEqual(transport.requests[1].url?.query, "q=Willen&status=entwurf")
        XCTAssertEqual(store.model?.hits?.count, 1)
        XCTAssertNotNil(context.snapshots.load("wissen"))
    }

    @MainActor
    func testHealthRecheck() async throws {
        let transport = FakeTransport { _ in (200, try fixture("rest-zustand")) }
        let store = HealthStore(context: try setup(transport))
        await store.load()
        XCTAssertEqual(store.failing.map(\.name), ["Kalender"])
        XCTAssertEqual(store.model?.services.count, 3)
        await store.recheck()
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertFalse(store.isChecking)
    }

    @MainActor
    func testWeekStoreExposesAlert() async throws {
        let transport = FakeTransport { _ in (200, try fixture("rest-woche-stoerung")) }
        let store = WeekStore(context: try setup(transport))
        await store.load()
        XCTAssertEqual(store.alert, [ServiceAlert(id: "calendars", name: "Kalender")])
    }
}
