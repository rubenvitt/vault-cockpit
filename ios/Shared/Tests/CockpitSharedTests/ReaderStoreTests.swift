import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// Leseansicht: Markieren, Notizen, Fortschritt, Entscheidungen, Verbinden und der Puffer ohne Netz.
final class ReaderStoreTests: XCTestCase {
    private let docID = "1031d266-e30f-4163-af2c-483c2fe68816"
    private let offline: FakeTransport.Handler = { _ in throw URLError(.notConnectedToInternet) }

    private func server(_ routes: [String: String] = [:]) -> FakeTransport {
        FakeTransport { request in
            let p = path(of: request)
            if let name = routes[p] { return (200, try fixture(name)) }
            switch p {
            case "/api/lesen/doc": return (200, try fixture("lesen-doc"))
            case "/aktion/lesen/markierung/neu": return (200, try fixture("lesen-aktion-markierung-neu"))
            case "/aktion/lesen/doc/fortschritt": return (200, try fixture("lesen-aktion-fortschritt"))
            default: return (200, json(#"{"ok":true,"message":"Gespeichert","undo":{"action":"/aktion/lesen/doc/status","fields":{"id":"x","status":"stapel"}}}"#))
            }
        }
    }

    @MainActor
    private func make(_ transport: FakeTransport, saveDelay: TimeInterval = 0.02) throws -> (ReaderStore, ReadingBuffer, CockpitContext) {
        let context = makeContext(transport, directory: try temporaryDirectory())
        let buffer = ReadingBuffer(context: context, retryInterval: 3600)
        return (ReaderStore(context: context, docID: docID, buffer: buffer, saveDelay: saveDelay), buffer, context)
    }

    private func requests(_ transport: FakeTransport, _ p: String) -> [URLRequest] {
        transport.requests.filter { path(of: $0) == p }
    }

    // MARK: Laden

    @MainActor
    func testLoadBuildsTextAndProgress() async throws {
        let transport = server()
        let (store, _, context) = try make(transport)
        await store.load()
        XCTAssertEqual(queryValue(transport.requests[0], "id"), docID)
        XCTAssertEqual(store.text?.length, 501)
        XCTAssertEqual(store.progress, 0.35)
        XCTAssertEqual(store.restLabel, "noch 8 min")
        XCTAssertTrue(store.canMark)
        XCTAssertNotNil(context.snapshots.load("lesen/doc/\(docID)"))
        XCTAssertFalse(store.isNotFound)
    }

    @MainActor
    func testNotFound() async throws {
        let transport = FakeTransport { _ in (404, try fixture("lesen-doc-fehlt")) }
        let (store, _, _) = try make(transport)
        await store.load()
        XCTAssertNil(store.model)
        XCTAssertTrue(store.isNotFound)
        XCTAssertEqual(store.state.error?.message, "Diesen Artikel gibt es nicht (mehr).")
    }

    // MARK: Markieren

    @MainActor
    func testMarkShowsAtOnceAndSendsTheWebAnchor() async throws {
        let transport = server()
        let (store, _, context) = try make(transport)
        await store.load()
        let text = try XCTUnwrap(store.text)

        transport.hold = true
        let marking = Task { await store.mark(131..<142, note: "Quelle prüfen") }
        await waitUntil { transport.heldCount == 1 }
        let fresh = try XCTUnwrap(store.model?.highlights.last)
        XCTAssertEqual(fresh.quote, "eine Studie")
        XCTAssertEqual(fresh.note, "Quelle prüfen")
        XCTAssertEqual(fresh.range, 131..<142)
        XCTAssertTrue(store.model?.ranges.contains { $0.id == fresh.id && $0.start == 131 } ?? false)
        XCTAssertEqual(context.toasts.haptic?.intent, .success)

        transport.hold = false
        transport.release()
        let id = await marking.value
        XCTAssertEqual(id, "6f1c0b0e-1111-4c4c-9d9d-000000000001")
        let sent = formFields(requests(transport, "/aktion/lesen/markierung/neu")[0])
        XCTAssertEqual(sent["id"], docID)
        XCTAssertEqual(sent["quote"], "eine Studie")
        XCTAssertEqual(sent["prefix"], text.slice(99..<131))
        XCTAssertEqual(sent["suffix"], text.slice(142..<174))
        XCTAssertEqual(sent["start"], "131")
        XCTAssertEqual(sent["notiz"], "Quelle prüfen")
        XCTAssertEqual(sent["cid"], fresh.id)
        XCTAssertEqual(sent["cid"], sent["cid"]?.lowercased())
        XCTAssertEqual(context.toasts.toasts.last?.message, "Markiert")
        XCTAssertEqual(context.toasts.toasts.last?.action?.label, "Rückgängig")
        // Danach der Stand vom Server.
        XCTAssertEqual(path(of: transport.requests.last!), "/api/lesen/doc")
    }

    @MainActor
    func testMarkRejectedIsTakenBack() async throws {
        let transport = server()
        let (store, buffer, context) = try make(transport)
        await store.load()
        transport.respond { _ in (400, json(#"{"error":"action_failed","message":"Die Auswahl ist zu lang"}"#)) }
        let id = await store.mark(24..<143)
        XCTAssertNil(id)
        XCTAssertEqual(store.model?.highlights.count, 3)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Die Auswahl ist zu lang")
        XCTAssertTrue(buffer.entries.isEmpty)
        let nothing = await store.mark(23..<24)
        XCTAssertNil(nothing)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Nichts ausgewählt")
    }

    @MainActor
    func testMarkWithoutNetworkWaitsInBufferAndIsSentLater() async throws {
        let transport = server()
        let (store, buffer, context) = try make(transport)
        await store.load()
        transport.respond(offline)

        let marked = await store.mark(131..<142)
        let cid = try XCTUnwrap(marked)
        let pending = try XCTUnwrap(store.model?.highlight(cid))
        XCTAssertTrue(pending.isPending)
        XCTAssertTrue(store.model?.ranges.first { $0.id == cid }?.isPending ?? false)
        XCTAssertEqual(buffer.entries.map(\.id), [cid])
        XCTAssertEqual(buffer.entries.first?.action, ReadingAction.markNew)
        XCTAssertEqual(buffer.entries.first?.label, "Markierung: Warum der Stapel wächst")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Markierung wartet auf Netz und geht automatisch raus.")

        // Eine Notiz an der wartenden Markierung geht mit ihr raus.
        let noted = await store.setNote("Später lesen", for: cid)
        XCTAssertTrue(noted)
        XCTAssertEqual(buffer.entries.first?.fields["notiz"], "Später lesen")

        // Neu geöffnet (ohne Netz): die wartende Markierung steht wieder im Text.
        let reopened = ReaderStore(context: context, docID: docID, buffer: buffer)
        await reopened.load()
        let again = try XCTUnwrap(reopened.model?.highlight(cid))
        XCTAssertTrue(again.isPending)
        XCTAssertEqual(again.range, 131..<142)
        XCTAssertEqual(again.note, "Später lesen")

        // Netz zurück: der Puffer sendet, die Leseansicht lädt neu.
        transport.respond { request in
            path(of: request) == "/api/lesen/doc" ? (200, try fixture("lesen-doc")) : (200, try fixture("lesen-aktion-markierung-neu"))
        }
        let loads = requests(transport, "/api/lesen/doc").count
        await buffer.flush()
        XCTAssertTrue(buffer.entries.isEmpty)
        let sent = formFields(try XCTUnwrap(requests(transport, "/aktion/lesen/markierung/neu").last))
        XCTAssertEqual(sent["cid"], cid)
        XCTAssertEqual(sent["notiz"], "Später lesen")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Nachgesendet: Markiert")
        await waitUntil { self.requests(transport, "/api/lesen/doc").count >= loads + 2 }
        await waitUntil { store.model?.highlight(cid) == nil }
        _ = reopened
    }

    @MainActor
    func testToggleMarkOnBlock() async throws {
        let transport = server()
        let (store, _, _) = try make(transport)
        await store.load()
        // Das Zitat ist ganz markiert: H entfernt die Markierung.
        XCTAssertEqual(store.highlight(coveringBlock: 10)?.id, "2a2cb0a5-a618-46f6-9d58-2561f594f970")
        let removed = await store.toggleMark(block: 10)
        XCTAssertTrue(removed)
        XCTAssertEqual(formFields(try XCTUnwrap(requests(transport, "/aktion/lesen/markierung/loeschen").first)), ["id": "2a2cb0a5-a618-46f6-9d58-2561f594f970"])
        XCTAssertNil(store.model?.highlight("2a2cb0a5-a618-46f6-9d58-2561f594f970"))

        // Die Bildunterschrift ist frei: H markiert sie.
        let marked = await store.toggleMark(block: 3)
        XCTAssertTrue(marked)
        XCTAssertEqual(formFields(try XCTUnwrap(requests(transport, "/aktion/lesen/markierung/neu").first))["quote"], "Bücher, die warten.")

        // Bild: kein Text.
        let image = await store.toggleMark(block: 2)
        XCTAssertFalse(image)
    }

    // MARK: Notizen, Entfernen, In Inbox

    @MainActor
    func testNoteDeleteAndInbox() async throws {
        let id = "de8f6b53-f1c2-4992-9657-69f54f1173a5"
        let transport = server()
        let (store, _, context) = try make(transport)
        await store.load()

        transport.respond { _ in (200, json(#"{"ok":true,"message":"Notiz gespeichert","highlight":{"id":"de8f6b53-f1c2-4992-9657-69f54f1173a5"},"undo":{"action":"/aktion/lesen/markierung/notiz","fields":{"id":"de8f6b53-f1c2-4992-9657-69f54f1173a5","notiz":"Kern des Arguments"}}}"#)) }
        let noted = await store.setNote("Neuer Gedanke", for: id)
        XCTAssertTrue(noted)
        XCTAssertEqual(store.model?.highlight(id)?.note, "Neuer Gedanke")
        XCTAssertEqual(store.model?.ranges.first { $0.id == id }?.note, "Neuer Gedanke")
        XCTAssertEqual(formFields(transport.requests.last!), ["id": id, "notiz": "Neuer Gedanke"])
        XCTAssertEqual(context.toasts.toasts.last?.action?.label, "Rückgängig")

        transport.respond { _ in (409, json(#"{"error":"action_failed","message":"Diese Markierung gibt es nicht"}"#)) }
        let failed = await store.deleteNote(for: id)
        XCTAssertFalse(failed)
        XCTAssertEqual(store.model?.highlight(id)?.note, "Neuer Gedanke")

        let index = try XCTUnwrap(store.model?.highlights.firstIndex { $0.id == id })
        let deleted = await store.deleteHighlight(id)
        XCTAssertFalse(deleted)
        XCTAssertEqual(store.model?.highlights.firstIndex { $0.id == id }, index)
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)

        transport.respond { _ in (200, json(#"{"ok":true,"message":"In der Inbox: Inbox/Zitat.md","result":{"kind":"note","path":"Inbox/Zitat.md","notes":[],"duplicate":false}}"#)) }
        let inboxed = await store.sendToInbox(highlight: id)
        XCTAssertTrue(inboxed)
        XCTAssertEqual(formFields(transport.requests.last!), ["markierung": id])
        let selection = await store.sendToInbox(0..<5)
        XCTAssertTrue(selection)
        let fields = formFields(transport.requests.last!)
        XCTAssertEqual(fields["quote"], "Warum")
        XCTAssertEqual(fields["id"], docID)
        XCTAssertNotNil(fields["cid"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "In der Inbox: Inbox/Zitat.md")
    }

    // MARK: Fortschritt

    @MainActor
    func testProgressIsDebouncedAndNeverDecreases() async throws {
        let transport = server()
        let (store, _, _) = try make(transport, saveDelay: 0.05)
        await store.load()
        store.scrolled(progress: 0.5, firstVisibleBlock: 4)
        store.scrolled(progress: 0.6, firstVisibleBlock: 5)
        XCTAssertEqual(store.progress, 0.6)
        XCTAssertEqual(store.restLabel, "noch 5 min")
        XCTAssertTrue(requests(transport, "/aktion/lesen/doc/fortschritt").isEmpty)
        await waitUntil { self.requests(transport, "/aktion/lesen/doc/fortschritt").count == 1 }
        XCTAssertEqual(formFields(requests(transport, "/aktion/lesen/doc/fortschritt")[0]), ["id": docID, "fortschritt": "0.600", "anker": "199"])

        // Zurückblättern: Fortschritt bleibt, die Stelle wandert.
        store.scrolled(progress: 0.2, firstVisibleBlock: 1)
        XCTAssertEqual(store.progress, 0.6)
        await store.flushProgress()
        XCTAssertEqual(formFields(requests(transport, "/aktion/lesen/doc/fortschritt")[1]), ["id": docID, "fortschritt": "0.600", "anker": "24"])
        XCTAssertEqual(store.model?.doc.scrollAnchor, 24)
        // Nichts Neues: nichts zu senden.
        await store.flushProgress()
        try await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(requests(transport, "/aktion/lesen/doc/fortschritt").count, 2)

        store.scrolled(progress: 1.4, anchor: 409)
        XCTAssertEqual(store.restLabel, "gelesen")
        await store.stop()
        XCTAssertEqual(formFields(requests(transport, "/aktion/lesen/doc/fortschritt")[2])["fortschritt"], "1.000")
    }

    @MainActor
    func testProgressWithoutNetworkKeepsOnlyTheLatest() async throws {
        let transport = server()
        let (store, buffer, context) = try make(transport)
        await store.load()
        transport.respond(offline)
        let toasts = context.toasts.toasts.count
        store.scrolled(progress: 0.5, anchor: 199)
        await store.flushProgress()
        store.scrolled(progress: 0.7, anchor: 287)
        await store.flushProgress()
        XCTAssertEqual(buffer.entries.count, 1)
        XCTAssertEqual(buffer.entries[0].id, "/aktion/lesen/doc/fortschritt:\(docID)")
        XCTAssertEqual(buffer.entries[0].fields, ["id": docID, "fortschritt": "0.700", "anker": "287"])
        XCTAssertTrue(buffer.entries[0].quiet)
        // Still: keine Meldung.
        XCTAssertEqual(context.toasts.toasts.count, toasts)

        // Gerät meldet „offline“: gleich in den Puffer, ohne Versuch.
        buffer.setOnline(false)
        let count = transport.requests.count
        store.scrolled(progress: 0.8, anchor: 334)
        await store.flushProgress()
        XCTAssertEqual(transport.requests.count, count)
        XCTAssertEqual(buffer.entries[0].fields["fortschritt"], "0.800")

        // Zurück online: der Puffer geht raus, ohne „Nachgesendet“ für den stillen Eintrag.
        transport.respond { request in
            path(of: request) == "/api/lesen/doc" ? (200, try fixture("lesen-doc")) : (200, try fixture("lesen-aktion-fortschritt"))
        }
        buffer.setOnline(true)
        await waitUntil { buffer.entries.isEmpty }
        XCTAssertEqual(formFields(requests(transport, "/aktion/lesen/doc/fortschritt").last!)["fortschritt"], "0.800")
        XCTAssertFalse(context.toasts.toasts.contains { $0.message.hasPrefix("Nachgesendet") })
    }

    func testDecimal() {
        XCTAssertEqual(ReaderStore.decimal(0.42), "0.420")
        XCTAssertEqual(ReaderStore.decimal(0.0004), "0.000")
        XCTAssertEqual(ReaderStore.decimal(0.0456), "0.046")
        XCTAssertEqual(ReaderStore.decimal(1), "1.000")
        XCTAssertEqual(ReaderStore.decimal(2), "1.000")
    }

    // MARK: Entscheidungen

    @MainActor
    func testFinishIsOptimisticAndUndoable() async throws {
        let transport = server()
        let (store, _, context) = try make(transport)
        await store.load()
        transport.hold = true
        let finishing = Task { await store.finish() }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertEqual(store.model?.doc.status, .gone)
        XCTAssertEqual(store.model?.decisions, ReaderDecisions(fertig: false, vault: true, zurueck: true))
        XCTAssertTrue(store.busy.contains("fertig"))
        transport.respond { request in
            path(of: request) == "/api/lesen/doc" ? (200, try fixture("lesen-doc")) : (200, json(#"{"ok":true,"message":"Fertig, weg: Warum der Stapel wächst","doc":{"id":"1031d266-e30f-4163-af2c-483c2fe68816","status":"weg"},"undo":{"action":"/aktion/lesen/doc/status","fields":{"id":"1031d266-e30f-4163-af2c-483c2fe68816","status":"stapel"}}}"#))
        }
        transport.hold = false
        transport.release()
        let ok = await finishing.value
        XCTAssertTrue(ok)
        XCTAssertEqual(formFields(requests(transport, "/aktion/lesen/doc/fertig")[0]), ["id": docID])
        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.message, "Fertig, weg: Warum der Stapel wächst")
        context.toasts.perform(toast.id)
        await waitUntil { !self.requests(transport, "/aktion/lesen/doc/status").isEmpty }
        XCTAssertEqual(formFields(requests(transport, "/aktion/lesen/doc/status")[0]), ["id": docID, "status": "stapel"])
    }

    @MainActor
    func testDecisionsWithoutNetworkAndRejected() async throws {
        let transport = server()
        let (store, buffer, context) = try make(transport)
        await store.load()

        transport.respond(offline)
        let vault = await store.moveToVault(fullText: true)
        XCTAssertTrue(vault)
        XCTAssertEqual(store.model?.doc.status, .archive)
        XCTAssertEqual(buffer.entries.map(\.id), ["/aktion/lesen/doc/vault:\(docID)"])
        XCTAssertEqual(buffer.entries[0].fields, ["id": docID, "volltext": "1"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "In den Vault wartet auf Netz und geht automatisch raus.")

        transport.respond { _ in (409, json(#"{"error":"action_failed","message":"Nicht in den Vault geschrieben"}"#)) }
        let back = await store.setStatus(.stack)
        XCTAssertFalse(back)
        XCTAssertEqual(store.model?.doc.status, .archive)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Nicht in den Vault geschrieben")

        // Abgelehnt beim Nachsenden: bleibt mit Fehler im Puffer.
        await buffer.flush()
        XCTAssertEqual(buffer.entries.first?.error, "Nicht in den Vault geschrieben")
        XCTAssertEqual(buffer.failedCount, 1)
        XCTAssertEqual(buffer.summary, "1 nicht gesendet")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Ein Eintrag ließ sich nicht nachsenden. Er bleibt im Puffer, siehe Liste.")
        let sends = requests(transport, "/aktion/lesen/doc/vault").count
        await buffer.flush()
        XCTAssertEqual(requests(transport, "/aktion/lesen/doc/vault").count, sends)
        transport.respond { _ in (200, json(#"{"ok":true,"message":"Mit Volltext im Vault: Warum der Stapel wächst"}"#)) }
        await buffer.flush(retry: true)
        XCTAssertTrue(buffer.entries.isEmpty)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Nachgesendet: Mit Volltext im Vault: Warum der Stapel wächst")
    }

    // MARK: Verbinden

    private let connections = json(#"{"highlightId":null,"docId":"1031d266-e30f-4163-af2c-483c2fe68816","source":"semantic","problem":null,"highlights":[{"id":"h9","docId":"d9","title":"Anderer Text","text":"Wer speichert, liest nicht.","note":null,"href":"/lesen/doc?id=d9#h-h9","score":0.81,"linked":false}],"notes":[{"path":"Synthesen/Lesen.md","title":"Lesen","type":"synthese","heading":"Stapel","text":"Über den Stapel","href":"/notiz?pfad=Synthesen%2FLesen.md","score":0.7,"linked":false}],"linked":[]}"#)

    @MainActor
    func testLinkSelectionMarksFirst() async throws {
        let transport = server()
        let (store, _, context) = try make(transport)
        await store.load()
        transport.respond { [connections] request in
            switch path(of: request) {
            case "/api/lesen/doc": return (200, try fixture("lesen-doc"))
            case "/api/lesen/verbindungen": return (200, connections)
            case "/aktion/lesen/markierung/neu": return (200, try fixture("lesen-aktion-markierung-neu"))
            default: return (200, json(#"{"ok":true,"message":"Verknüpft mit Lesen","link":{"target":"Lesen#Stapel","path":"Lesestapel/Warum.md"}}"#))
            }
        }
        await store.loadConnections(for: 0..<5)
        let search = try XCTUnwrap(requests(transport, "/api/lesen/verbindungen").first)
        XCTAssertEqual(queryValue(search, "doc"), docID)
        XCTAssertEqual(queryValue(search, "text"), "Warum")
        guard case .loaded(let found) = store.connections else { return XCTFail("nicht geladen") }
        XCTAssertEqual(found.notesTitle, "Synthesen und Konzepte")
        let note = try XCTUnwrap(found.notes.first)

        let linked = await store.link(note: note)
        XCTAssertTrue(linked)
        let marked = formFields(try XCTUnwrap(requests(transport, "/aktion/lesen/markierung/neu").first))
        XCTAssertEqual(marked["quote"], "Warum")
        let link = formFields(try XCTUnwrap(requests(transport, "/aktion/lesen/verbinden").first))
        XCTAssertEqual(link, ["markierung": "6f1c0b0e-1111-4c4c-9d9d-000000000001", "pfad": "Synthesen/Lesen.md", "abschnitt": "Stapel"])
        XCTAssertEqual(store.connectionTarget, .highlight("6f1c0b0e-1111-4c4c-9d9d-000000000001"))
        XCTAssertEqual(queryValue(requests(transport, "/api/lesen/verbindungen").last!, "markierung"), "6f1c0b0e-1111-4c4c-9d9d-000000000001")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Verknüpft mit Lesen")

        // Eine schon markierte Stelle sucht mit der Markierung.
        await store.loadConnections(for: 48..<80)
        XCTAssertEqual(queryValue(requests(transport, "/api/lesen/verbindungen").last!, "markierung"), "de8f6b53-f1c2-4992-9657-69f54f1173a5")
        let other = await store.link(highlight: found.highlights[0])
        XCTAssertTrue(other)
        XCTAssertEqual(formFields(requests(transport, "/aktion/lesen/verbinden").last!), ["markierung": "de8f6b53-f1c2-4992-9657-69f54f1173a5", "zu": "h9"])

        store.closeConnections()
        XCTAssertEqual(store.connections, .idle)
        XCTAssertNil(store.connectionTarget)
    }

    @MainActor
    func testConnectionsOffline() async throws {
        let transport = server()
        let (store, _, _) = try make(transport)
        await store.load()
        transport.respond(offline)
        await store.loadConnections(for: .highlight("de8f6b53-f1c2-4992-9657-69f54f1173a5"))
        XCTAssertEqual(store.connections, .failed("Ohne Netz keine Querverbindungen"))
    }

    // MARK: Puffer

    func testOutboxSettlesOnlyTheSentVersion() throws {
        let outbox = ReadingOutbox(file: try temporaryDirectory().appending(path: "lesen.json"))
        let first = ReadingOutbox.Entry(id: "k", action: ReadingAction.progress, fields: ["fortschritt": "0.1"], label: "Lesefortschritt: A", quiet: true, docID: "a", created: Date(timeIntervalSince1970: 1))
        try outbox.put(first)
        var newer = first
        newer.fields["fortschritt"] = "0.2"
        newer.rev = "neu"
        try outbox.put(newer)
        // Die gesendete alte Fassung räumt die neuere nicht weg.
        outbox.settle(first)
        XCTAssertEqual(outbox.all().map(\.fields), [["fortschritt": "0.2"]])
        outbox.settle(newer)
        XCTAssertTrue(outbox.all().isEmpty)
    }

    @MainActor
    func testBufferKeysAndSummary() async throws {
        let transport = FakeTransport(offline)
        let context = makeContext(transport, directory: try temporaryDirectory())
        let buffer = ReadingBuffer(context: context, retryInterval: 3600)
        XCTAssertTrue(buffer.queue(ReadingAction.markNew, fields: ["id": "d", "cid": "c1", "quote": "a"], docID: "d", title: "Doc"))
        XCTAssertTrue(buffer.queue(ReadingAction.markNew, fields: ["id": "d", "cid": "c2", "quote": "b"], docID: "d", title: "Doc"))
        XCTAssertTrue(buffer.queue(ReadingAction.status, fields: ["id": "d", "status": "weg"], docID: "d", title: "Doc"))
        XCTAssertTrue(buffer.queue(ReadingAction.status, fields: ["id": "d", "status": "stapel"], docID: "d", title: "Doc"))
        XCTAssertEqual(buffer.entries.map(\.id), ["c1", "c2", "/aktion/lesen/doc/status:d"])
        XCTAssertEqual(buffer.entries.last?.fields["status"], "stapel")
        XCTAssertEqual(buffer.pendingHighlights(docID: "d").map(\.id), ["c1", "c2"])
        XCTAssertEqual(buffer.summary, "3 Einträge warten auf Netz")
        // Ohne Netz: nichts geht raus, nichts geht verloren.
        await buffer.flush()
        XCTAssertEqual(buffer.entries.count, 3)
        // Übersteht einen Neustart.
        let reloaded = ReadingBuffer(context: context, retryInterval: 3600)
        XCTAssertEqual(reloaded.entries.map(\.id), buffer.entries.map(\.id))
        reloaded.discard(reloaded.entries[0])
        XCTAssertEqual(reloaded.entries.count, 2)
    }
}
