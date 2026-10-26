import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// Eingang, Stapel, Markiert, Wiedersehen, Folgen und „Neue Folge“ gegen die Fixtures des Servers.
final class ReadingStoreTests: XCTestCase {
    /// Lesewege antworten mit ihrer Fixture, Aktionen ohne eigene Antwort mit `{ok, message}`.
    private func server(_ routes: [String: String] = [:]) -> FakeTransport {
        FakeTransport { request in
            let p = path(of: request)
            if let name = routes[p] { return (200, try fixture(name)) }
            switch p {
            case "/api/lesen/eingang": return (200, try fixture("lesen-eingang"))
            case "/api/lesen/stapel": return (200, try fixture("lesen-stapel"))
            case "/api/lesen/markiert": return (200, try fixture("lesen-markiert"))
            case "/api/lesen/wiedersehen": return (200, try fixture("lesen-wiedersehen"))
            case "/api/lesen/folgen": return (200, try fixture("lesen-folgen"))
            case "/api/lesen/folgen/neu": return (200, try fixture("lesen-folgen-neu"))
            default: return (200, json(#"{"ok":true,"message":"Gespeichert"}"#))
            }
        }
    }

    private let failure = json(#"{"error":"action_failed","message":"Liegt nicht mehr im Eingang: Neu im Blog"}"#)

    @MainActor
    private func context(_ transport: FakeTransport) throws -> CockpitContext {
        makeContext(transport, directory: try temporaryDirectory())
    }

    // MARK: Eingang

    @MainActor
    func testInboxDecisionMovesOnBeforeTheServerAnswers() async throws {
        let transport = server(["/aktion/lesen/sortieren": "lesen-aktion-sortieren"])
        let context = try context(transport)
        let store = InboxStore(context: context)
        await store.load()
        let card = try XCTUnwrap(store.card)

        transport.hold = true
        let deciding = Task { await store.decide(.weg) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertNil(store.card)
        XCTAssertTrue(store.isDeciding)
        XCTAssertEqual(store.model?.left, 0)
        XCTAssertEqual(store.model?.today.seen, 2)
        XCTAssertEqual(store.model?.today.last?.id, card.id)
        XCTAssertEqual(store.model?.undo?.fields, ["id": card.id, "ziel": "eingang"])

        transport.respond { request in
            path(of: request) == "/api/lesen/eingang" ? (200, try fixture("lesen-eingang-leer")) : (200, try fixture("lesen-aktion-sortieren"))
        }
        transport.hold = false
        transport.release()
        let ok = await deciding.value
        XCTAssertTrue(ok)
        XCTAssertFalse(store.isDeciding)
        let action = transport.requests[1]
        XCTAssertEqual(path(of: action), "/aktion/lesen/sortieren")
        XCTAssertEqual(formFields(action), ["id": card.id, "ziel": "weg"])
        XCTAssertEqual(action.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
        XCTAssertEqual(path(of: transport.requests[2]), "/api/lesen/eingang")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Weg: Newsletter Oktober")
        XCTAssertEqual(context.toasts.toasts.last?.action?.label, "Rückgängig")
        XCTAssertEqual(context.toasts.haptic?.intent, .selection)
    }

    @MainActor
    func testInboxDecisionComesBackWhenRejected() async throws {
        let transport = server()
        let context = try context(transport)
        let store = InboxStore(context: context)
        await store.load()
        let before = store.model
        transport.respond { [failure] request in
            path(of: request) == "/api/lesen/eingang" ? (200, try fixture("lesen-eingang")) : (409, failure)
        }
        let ok = await store.decide(.stapel)
        XCTAssertFalse(ok)
        XCTAssertEqual(store.model, before)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Liegt nicht mehr im Eingang: Neu im Blog")
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)
        // Keine Karte geladen, solange die alte zurück ist.
        XCTAssertEqual(transport.requests.count, 2)
    }

    @MainActor
    func testInboxUndoLastAndFile() async throws {
        let transport = server()
        let context = try context(transport)
        let store = InboxStore(context: context)
        await store.load()
        let undone = await store.undoLast()
        XCTAssertTrue(undone)
        XCTAssertEqual(formFields(transport.requests[1]), ["id": "2f94c7c3-f257-413a-be3a-365c29ddcb50", "ziel": "eingang"])
        XCTAssertEqual(path(of: transport.requests[2]), "/api/lesen/eingang")

        let filed = await store.file()
        XCTAssertTrue(filed)
        XCTAssertEqual(path(of: transport.requests[3]), "/aktion/lesen/ablegen")
        XCTAssertEqual(formFields(transport.requests[3]), ["id": "64e6253f-0e9a-4a0b-8b7b-ea1e7ec0575d"])
    }

    @MainActor
    func testSaveAddressKeepsItsIDUntilItArrives() async throws {
        let transport = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
        let context = try context(transport)
        let store = InboxStore(context: context)

        let empty = await store.save(url: "   ")
        XCTAssertNil(empty)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Bitte eine Adresse eingeben")
        XCTAssertTrue(transport.requests.isEmpty)

        let cid = store.saveCID
        let offline = await store.save(url: " https://blatt.example.org/neu ")
        XCTAssertNil(offline)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Keine Verbindung zum Cockpit. Nichts gespeichert.")
        XCTAssertEqual(store.saveCID, cid)

        transport.respond { request in
            path(of: request) == "/api/lesen/eingang" ? (200, try fixture("lesen-eingang")) : (200, try fixture("lesen-aktion-speichern"))
        }
        let saved = await store.save(url: "https://blatt.example.org/neu")
        XCTAssertEqual(saved?.title, "Vom Speichern")
        XCTAssertEqual(formFields(transport.requests[1]), ["url": "https://blatt.example.org/neu", "cid": cid])
        XCTAssertNotEqual(store.saveCID, cid)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Gespeichert: Vom Speichern")
        // Im Eingang gelandet: die Karte lädt neu.
        XCTAssertEqual(path(of: transport.requests[2]), "/api/lesen/eingang")
    }

    @MainActor
    func testUploadPDFAsMultipart() async throws {
        let transport = server(["/aktion/lesen/pdf": "lesen-aktion-speichern"])
        let context = try context(transport)
        let store = InboxStore(context: context)

        let tooBig = await store.uploadPDF(Data(count: InboxStore.maxPDFBytes + 1), filename: "gross.pdf")
        XCTAssertNil(tooBig)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Die Datei ist zu groß (höchstens 20 MB).")
        XCTAssertTrue(transport.requests.isEmpty)

        let cid = store.uploadCID
        let doc = await store.uploadPDF(Data("%PDF-1.4 Inhalt".utf8), filename: "Stapel \"neu\".pdf")
        XCTAssertEqual(doc?.id, "115f92b3-95af-49e6-bca1-9a2500467316")
        let request = transport.requests[0]
        XCTAssertEqual(path(of: request), "/aktion/lesen/pdf")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        let type = try XCTUnwrap(request.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertTrue(type.hasPrefix("multipart/form-data; boundary="))
        let boundary = String(type.dropFirst("multipart/form-data; boundary=".count))
        let body = String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self)
        XCTAssertEqual(body, "--\(boundary)\r\nContent-Disposition: form-data; name=\"cid\"\r\n\r\n\(cid)\r\n--\(boundary)\r\nContent-Disposition: form-data; name=\"datei\"; filename=\"Stapel neu.pdf\"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 Inhalt\r\n--\(boundary)--\r\n")
        XCTAssertNotEqual(store.uploadCID, cid)
    }

    // MARK: Stapel

    @MainActor
    func testStackQueryAndFile() async throws {
        let transport = server(["/aktion/lesen/ablegen": "lesen-aktion-sortieren"])
        let context = try context(transport)
        let store = StackStore(context: context)
        await store.load(StackQuery(zeit: 15, sort: "kurz", group: "ohne"))
        XCTAssertEqual(queryValue(transport.requests[0], "zeit"), "15")
        XCTAssertEqual(queryValue(transport.requests[0], "sort"), "kurz")
        XCTAssertEqual(queryValue(transport.requests[0], "gruppe"), "ohne")
        XCTAssertNotNil(context.snapshots.load("lesen/stapel/15/kurz/ohne"))

        await store.setZeit(nil)
        XCTAssertNil(queryValue(transport.requests[1], "zeit"))
        XCTAssertEqual(store.query, StackQuery(sort: "kurz", group: "ohne"))

        let item = try XCTUnwrap(store.model?.items.first)
        transport.hold = true
        let filing = Task { await store.file(item) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertFalse(store.model?.items.contains { $0.id == item.id } ?? true)
        XCTAssertEqual(store.model?.count, 3)
        XCTAssertTrue(store.busy.contains(item.id))
        transport.hold = false
        transport.release()
        let ok = await filing.value
        XCTAssertTrue(ok)
        XCTAssertEqual(formFields(transport.requests[2]), ["id": item.id])
        XCTAssertEqual(context.toasts.toasts.last?.action?.label, "Rückgängig")
        XCTAssertEqual(path(of: transport.requests[3]), "/api/lesen/stapel")
    }

    @MainActor
    func testPrefetchDocsForOfflineReading() async throws {
        let transport = server(["/api/lesen/doc": "lesen-doc"])
        let context = try context(transport)
        let store = StackStore(context: context)
        await store.load()
        let ids = try XCTUnwrap(store.model?.items.prefix(2).map(\.id))
        let loaded = await store.prefetchDocs(limit: 2)
        XCTAssertEqual(loaded, 2)
        XCTAssertEqual(transport.requests.dropFirst().map { queryValue($0, "id") }, ids)
        for id in ids { XCTAssertNotNil(context.snapshots.load("lesen/doc/\(id)")) }
        // Frisch gespeichert: nichts neu.
        let again = await store.prefetchDocs(limit: 2)
        XCTAssertEqual(again, 0)
        XCTAssertEqual(transport.requests.count, 3)
        // Ohne Netz öffnet die Leseansicht den gespeicherten Stand.
        transport.respond { _ in throw URLError(.notConnectedToInternet) }
        let reader = ReaderStore(context: context, docID: ids[0], buffer: ReadingBuffer(context: context))
        await reader.load()
        XCTAssertNotNil(reader.model)
        XCTAssertTrue(reader.state.isStale)
        XCTAssertTrue(reader.state.isOffline)
        let offline = await store.prefetchDocs(limit: 4, maxAge: 0)
        XCTAssertEqual(offline, 0)
    }

    // MARK: Markiert

    @MainActor
    func testHighlightFilters() async throws {
        let transport = server(["/api/lesen/markiert": "lesen-markiert-filter"])
        let store = HighlightsStore(context: try context(transport))
        await store.load(HighlightQuery(topic: "Gewohnheit"))
        XCTAssertEqual(queryValue(transport.requests[0], "thema"), "Gewohnheit")
        XCTAssertNil(queryValue(transport.requests[0], "quelle"))
        XCTAssertEqual(store.model?.filter.thema, "Gewohnheit")
        XCTAssertEqual(store.model?.items.count, 4)
    }

    // MARK: Wiedersehen

    @MainActor
    func testReviewDecisionWithUndo() async throws {
        let transport = server(["/aktion/lesen/wiedersehen": "lesen-aktion-wiedersehen"])
        let context = try context(transport)
        let store = ReviewCardsStore(context: context)
        await store.load()
        let card = try XCTUnwrap(store.current)

        let ok = await store.decide(card, .behalten)
        XCTAssertTrue(ok)
        XCTAssertNotEqual(store.current?.id, card.id)
        XCTAssertEqual(store.model?.seen, 1)
        XCTAssertEqual(store.model?.left, 3)
        XCTAssertEqual(store.model?.progressLabel, "Heute 1 von 4 gesehen")
        XCTAssertEqual(formFields(transport.requests[1]), ["id": card.id, "ziel": "behalten"])
        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.message, "Behalten")
        XCTAssertEqual(toast.action?.label, "Rückgängig")

        context.toasts.perform(toast.id)
        await waitUntil { transport.requests.count == 4 }
        XCTAssertEqual(path(of: transport.requests[2]), "/aktion/lesen/wiedersehen/zurueck")
        XCTAssertEqual(formFields(transport.requests[2]), ["id": card.id, "box": "0", "faellig": "2026-10-24T09:07:32.037Z", "zustand": "aktiv"])
        XCTAssertEqual(path(of: transport.requests[3]), "/api/lesen/wiedersehen")
    }

    @MainActor
    func testReviewRollsBackAndOwnWordsKeepTheirID() async throws {
        let transport = server()
        let context = try context(transport)
        let store = ReviewCardsStore(context: context)
        await store.load()
        let card = try XCTUnwrap(store.current)

        let empty = await store.ownWords(card, "  ")
        XCTAssertFalse(empty)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Bitte in eigenen Worten etwas schreiben")
        let long = await store.ownWords(card, String(repeating: "x", count: 4001))
        XCTAssertFalse(long)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Der Text ist zu lang (höchstens 4000 Zeichen)")
        XCTAssertEqual(transport.requests.count, 1)

        transport.respond { _ in throw URLError(.timedOut) }
        let offline = await store.ownWords(card, "Stapel ist ein Versprechen")
        XCTAssertFalse(offline)
        XCTAssertEqual(store.current?.id, card.id)
        XCTAssertEqual(store.model?.seen, 0)
        let first = formFields(transport.requests[1])
        XCTAssertEqual(first["ziel"], "worte")
        XCTAssertEqual(first["worte"], "Stapel ist ein Versprechen")

        transport.respond { _ in (200, json(#"{"ok":true,"message":"In der Inbox: Inbox/Worte.md"}"#)) }
        let sent = await store.ownWords(card, "Stapel ist ein Versprechen")
        XCTAssertTrue(sent)
        XCTAssertEqual(formFields(transport.requests[2])["cid"], first["cid"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "In der Inbox: Inbox/Worte.md")
    }

    @MainActor
    func testReviewWeekClusterAndExport() async throws {
        let transport = FakeTransport { request in
            switch path(of: request) {
            case "/api/lesen/wiedersehen": return (200, try fixture("lesen-wiedersehen"))
            case "/api/lesen/wiedersehen.md": return (200, json("# Markierungen KW 43\n"))
            default: return (200, json(#"{"ok":true,"message":"In der Inbox: Inbox/Querverbindung.md"}"#))
            }
        }
        let store = ReviewCardsStore(context: try context(transport))
        await store.load(week: "2026-W43")
        XCTAssertEqual(queryValue(transport.requests[0], "woche"), "2026-W43")
        let cluster = try XCTUnwrap(store.model?.week.clusters.first)
        let created = await store.createNote(for: cluster)
        XCTAssertTrue(created)
        XCTAssertEqual(formFields(transport.requests[1]), ["ids": cluster.ids.joined(separator: ",")])
        XCTAssertTrue(store.linkedClusters.contains(cluster.id))
        let again = await store.createNote(for: cluster)
        XCTAssertFalse(again)

        let markdown = await store.exportMarkdown()
        XCTAssertEqual(markdown, "# Markierungen KW 43\n")
        XCTAssertEqual(queryValue(transport.requests[2], "woche"), "2026-W43")
        XCTAssertEqual(store.exportFilename, "markierungen-2026-W43.md")

        await store.showPrevious()
        XCTAssertEqual(queryValue(transport.requests[3], "woche"), "2026-W42")
    }

    // MARK: Folgen

    /// `lesen-folgen.json`, aber alle entstehenden Folgen fertig.
    private func allDone() throws -> Data {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("lesen-folgen")) as? [String: Any])
        let items = try XCTUnwrap(root["items"] as? [[String: Any]])
        root["items"] = items.map { item -> [String: Any] in
            guard item["busy"] as? Bool == true else { return item }
            var done = item
            done["status"] = "fertig"
            done["busy"] = false
            done["progress"] = NSNull()
            done["seconds"] = 60
            return done
        }
        return try JSONSerialization.data(withJSONObject: root)
    }

    @MainActor
    func testEpisodesPollWhileBusyAndAnnounceFinished() async throws {
        let done = try allDone()
        let transport = server()
        let context = try context(transport)
        let store = EpisodesStore(context: context, pollInterval: 0.01)
        var played: [String] = []
        store.onPlay = { played.append($0.id) }
        await store.load()
        XCTAssertTrue(store.model?.hasBusy ?? false)

        transport.respond { _ in (200, done) }
        store.startPolling()
        XCTAssertTrue(store.isPolling)
        await waitUntil { store.model?.hasBusy == false }
        await waitUntil { !store.isPolling }
        let finished = context.toasts.toasts.map(\.message)
        XCTAssertTrue(finished.contains("Fertig: Vorlesen: Kurze Notiz"))
        XCTAssertTrue(finished.contains("Fertig: Podcast: Warum der Stapel wächst und 2 weitere"))
        let toast = try XCTUnwrap(context.toasts.toasts.first { $0.message == "Fertig: Vorlesen: Kurze Notiz" })
        XCTAssertEqual(toast.action?.label, "Abspielen")
        context.toasts.perform(toast.id)
        XCTAssertEqual(played, ["ep-spricht"])
        // Nichts entsteht mehr: keine weiteren Anfragen.
        let count = transport.requests.count
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(transport.requests.count, count)
    }

    @MainActor
    func testEpisodesPauseInBackground() async throws {
        let transport = server()
        let store = EpisodesStore(context: try context(transport), pollInterval: 0.02)
        await store.load()
        store.startPolling()
        XCTAssertTrue(store.isPolling)
        store.setActive(false)
        XCTAssertFalse(store.isPolling)
        let count = transport.requests.count
        try await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(transport.requests.count, count)
        store.setActive(true)
        await waitUntil { transport.requests.count > count }
        XCTAssertTrue(store.isPolling)
        store.stopPolling()
        XCTAssertFalse(store.isPolling)
    }

    @MainActor
    func testEpisodeDeleteComesBackWhenRejected() async throws {
        let transport = server()
        let context = try context(transport)
        let store = EpisodesStore(context: context)
        await store.load()
        let episode = try XCTUnwrap(store.model?.items.first { $0.id == "ep-fertig" })
        transport.respond { request in
            path(of: request) == "/api/lesen/folgen" ? (200, try fixture("lesen-folgen")) : (409, json(#"{"error":"action_failed","message":"Diese Folge entsteht gerade"}"#))
        }
        let ok = await store.delete(episode)
        XCTAssertFalse(ok)
        XCTAssertEqual(store.model?.items.map(\.id), try JSONDecoder().decode(EpisodeListModel.self, from: try fixture("lesen-folgen")).items.map(\.id))
        XCTAssertEqual(context.toasts.toasts.last?.message, "Diese Folge entsteht gerade")

        transport.respond { request in
            path(of: request) == "/api/lesen/folgen" ? (200, try fixture("lesen-folgen")) : (200, json(#"{"ok":true,"message":"Geht weiter: Podcast","redirect":"/lesen/folgen"}"#))
        }
        let failed = try XCTUnwrap(store.model?.items.first { $0.resumable })
        let resumed = await store.resume(failed)
        XCTAssertTrue(resumed)
        XCTAssertEqual(path(of: transport.requests[2]), "/aktion/lesen/folge/fortsetzen")
        XCTAssertEqual(formFields(transport.requests[2]), ["id": failed.id])
    }

    // MARK: Neue Folge

    @MainActor
    func testNewEpisodeSelectionAndSummary() async throws {
        let transport = server()
        let store = NewEpisodeStore(context: try context(transport))
        await store.load(zeit: 30)
        XCTAssertEqual(queryValue(transport.requests[0], "zeit"), "30")
        let model = try XCTUnwrap(store.model)
        XCTAssertEqual(store.selection, Set(model.docs.map(\.id)))
        XCTAssertEqual(store.kind, "vorlesen")
        XCTAssertEqual(store.length, 10)
        XCTAssertEqual(store.summary, model.summary)
        XCTAssertFalse(store.usesLength)

        // Schon gehört (0 Zeichen) abwählen ändert die Kosten nicht.
        store.toggle(model.docs[1].id)
        XCTAssertEqual(store.summary, EpisodeSummary(main: "Vorlesen · 2 Texte · etwa 10 Min.", cost: "rund 8.642 Zeichen bei ElevenLabs"))
        store.toggle(model.docs[0].id)
        XCTAssertEqual(store.summary, EpisodeSummary(main: "Vorlesen · 1 Text · etwa 5 Min.", cost: "rund 4.321 Zeichen bei ElevenLabs"))
        store.toggle(model.docs[2].id)
        XCTAssertEqual(store.summary, EpisodeSummary(main: "Bitte mindestens einen Text wählen", cost: ""))
        XCTAssertFalse(store.canSubmit)
        store.toggle(model.docs[0].id)
        store.toggle(model.docs[1].id)

        // Report fehlt Claude: nicht wählbar.
        store.select(kind: "report")
        XCTAssertEqual(store.kind, "vorlesen")
        store.select(kind: "podcast")
        store.select(length: 20)
        store.select(length: 7)
        XCTAssertEqual(store.length, 20)
        XCTAssertTrue(store.usesLength)
        XCTAssertEqual(store.summary, EpisodeSummary(main: "Podcast · 2 Texte · 20 Min.", cost: "rund 18.000 Zeichen bei ElevenLabs, dazu dein Claude-Abo"))

        // Neu geladen (gleiches Zeitfenster): Auswahl bleibt.
        await store.refresh()
        XCTAssertEqual(store.selection.count, 2)
        // Anderes Zeitfenster: wieder alle Texte.
        transport.respond { _ in (200, try fixture("lesen-folgen-neu-leer")) }
        await store.load(zeit: 5)
        XCTAssertEqual(store.selection, ["01d00131-4abf-4b27-b88a-e32b8ec3498a"])
        XCTAssertEqual(store.kind, "podcast")
    }

    @MainActor
    func testNewEpisodeSubmitsOnce() async throws {
        let transport = server()
        let context = try context(transport)
        let store = NewEpisodeStore(context: context)
        var created = 0
        store.onCreated = { created += 1 }
        await store.load()
        store.select(kind: "podcast")
        XCTAssertTrue(store.canSubmit)

        transport.respond { _ in (200, json(#"{"ok":true,"message":"Podcast entsteht im Hintergrund, rund 9.000 Zeichen.","redirect":"/lesen/folgen"}"#)) }
        transport.hold = true
        let first = Task { await store.submit() }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertTrue(store.isSubmitting)
        XCTAssertFalse(store.canSubmit)
        let second = await store.submit()
        XCTAssertFalse(second)
        transport.hold = false
        transport.release()
        let ok = await first.value
        XCTAssertTrue(ok)
        XCTAssertEqual(transport.requests.count, 2)
        let request = transport.requests[1]
        XCTAssertEqual(path(of: request), "/aktion/lesen/folge/neu")
        let ids = try XCTUnwrap(store.model?.docs.map(\.id))
        XCTAssertEqual(String(decoding: try XCTUnwrap(request.httpBody), as: UTF8.self), "art=podcast&" + ids.map { "doc=\($0)" }.joined(separator: "&") + "&laenge=10&stil=ausgewogen&audio=1")
        XCTAssertTrue(store.didSubmit)
        XCTAssertFalse(store.canSubmit)
        XCTAssertEqual(created, 1)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Podcast entsteht im Hintergrund, rund 9.000 Zeichen.")
        let third = await store.submit()
        XCTAssertFalse(third)
        XCTAssertEqual(transport.requests.count, 2)
    }

    @MainActor
    func testNewEpisodeOptions() async throws {
        let transport = server()
        let store = NewEpisodeStore(context: try context(transport))
        await store.load()
        XCTAssertEqual(store.style, "ausgewogen")
        XCTAssertTrue(store.audio)
        XCTAssertEqual(store.styleHint, "Einordnen, erklären, Querverbindungen")
        store.select(kind: "podcast")
        store.select(style: "kritisch")
        store.select(style: "gibtsnicht")
        XCTAssertEqual(store.style, "kritisch")
        XCTAssertEqual(store.styleHint, "Argumente prüfen, Lücken und Widersprüche benennen")
        store.toggle(topic: "Medien")
        store.toggle(topic: "Lesen")
        store.toggle(topic: "Unbekannt")
        XCTAssertEqual(store.selectedTopics, ["Lesen", "Medien"], "Reihenfolge der Liste")
        store.set(focus: "  Alltag  ")
        store.set(focus: String(repeating: "x", count: 250))
        XCTAssertEqual(store.focus.count, 200)
        store.set(focus: "  Alltag  ")
        store.select(audio: false)
        XCTAssertEqual(store.summary, EpisodeSummary(main: "Podcast · 3 Texte · 10 Min. · erst Transkript", cost: "Nur dein Claude-Abo; Audio später auf Knopfdruck"))

        transport.respond { _ in (200, json(#"{"ok":true,"message":"Podcast: Claude schreibt das Transkript, Audio danach auf Knopfdruck.","redirect":"/lesen/folgen"}"#)) }
        let ok = await store.submit()
        XCTAssertTrue(ok)
        let body = String(decoding: try XCTUnwrap(transport.requests.last?.httpBody), as: UTF8.self)
        XCTAssertTrue(body.hasSuffix("&laenge=10&stil=kritisch&thema=Lesen&thema=Medien&fokus=Alltag&audio=0"), body)

        // Vorlesen: keine Wünsche, immer mit Audio.
        let reading = NewEpisodeStore(context: try context(server()))
        await reading.load()
        reading.select(audio: false)
        XCTAssertEqual(reading.summary.main, "Vorlesen · 3 Texte · etwa 10 Min.")
    }

    @MainActor
    func testEpisodeSpeakTranscript() async throws {
        let transport = server()
        let store = EpisodesStore(context: try context(transport), pollInterval: 0)
        await store.load()
        let transcript = try JSONDecoder().decode(Episode.self, from: json(#"{"id":"ep-transkript","kind":"report","title":"Report: Stapel","minutes":5,"status":"transkript","createdAt":"2026-10-25T09:00:00.000Z","note":"30-ressourcen/audio-reports/x.md","audio":false,"style":"tiefgang","styleLabel":"Tiefgang","topics":["Lesen"],"focus":null,"wishes":"Tiefgang · Schwerpunkt: Lesen","speak":{"label":"Audio erzeugen","hint":"rund 4.500 Zeichen bei ElevenLabs."}}"#))
        XCTAssertTrue(transcript.isTranscript)
        XCTAssertFalse(transcript.busy)
        XCTAssertFalse(transcript.audio)
        XCTAssertEqual(transcript.wishes, "Tiefgang · Schwerpunkt: Lesen")
        XCTAssertEqual(transcript.speak?.label, "Audio erzeugen")
        transport.respond { request in
            path(of: request) == "/api/lesen/folgen" ? (200, try fixture("lesen-folgen")) : (200, json(#"{"ok":true,"message":"Audio entsteht: Report","redirect":"/lesen/folgen"}"#))
        }
        let ok = await store.speak(transcript)
        XCTAssertTrue(ok)
        let request = try XCTUnwrap(transport.requests.first { path(of: $0) == "/aktion/lesen/folge/sprechen" })
        XCTAssertEqual(formFields(request), ["id": "ep-transkript"])

        // Älterer Server ohne die Felder: mit Audio, ohne Wünsche.
        let old = try JSONDecoder().decode(Episode.self, from: json(#"{"id":"a","kind":"podcast","status":"fertig","createdAt":"2026-10-25T09:00:00.000Z"}"#))
        XCTAssertTrue(old.audio)
        XCTAssertNil(old.wishes)
        let fertig = await store.speak(old)
        XCTAssertFalse(fertig, "nur zu einem Transkript")
    }

    @MainActor
    func testEpisodeIngestTexts() async throws {
        let transport = server()
        let store = EpisodesStore(context: try context(transport), pollInterval: 0)
        await store.load()
        let episode = try JSONDecoder().decode(Episode.self, from: json(#"{"id":"ep-fertig-2","kind":"vorlesen","title":"Vorlesen: Stapel","status":"fertig","createdAt":"2026-10-25T09:00:00.000Z","ingest":{"total":2,"open":1,"ready":0,"available":true,"label":"Ingest: 1 im Wiki"}}"#))
        XCTAssertEqual(episode.ingest?.label, "Ingest: 1 im Wiki")
        XCTAssertTrue(episode.ingest?.canRequest ?? false)
        transport.respond { request in
            path(of: request) == "/api/lesen/folgen" ? (200, try fixture("lesen-folgen")) : (200, json(#"{"ok":true,"message":"Ingest für 1 Text angestoßen; prüfen unter Lesen → Ingest.","redirect":"/lesen/folgen"}"#))
        }
        let ok = await store.ingest(episode)
        XCTAssertTrue(ok)
        let request = try XCTUnwrap(transport.requests.first { path(of: $0) == "/aktion/lesen/folge/ingest" })
        XCTAssertEqual(formFields(request), ["id": "ep-fertig-2"])
        XCTAssertEqual(episode.ingest?.texts, [], "älterer Server ohne Texte")
        XCTAssertFalse(episode.ingest?.choosable ?? true)

        // Mit Texten: nur die gewählten, als `docs` mit Kommas.
        let picking = try JSONDecoder().decode(Episode.self, from: json(#"{"id":"ep-3","kind":"podcast","title":"Podcast","status":"fertig","createdAt":"2026-10-25T09:00:00.000Z","ingest":{"total":3,"open":2,"ready":0,"available":true,"label":"Ingest: 1 im Wiki","texts":[{"id":"d1","title":"Eins","site":"a.test","status":null,"statusLabel":null,"open":true},{"id":"d2","title":"Zwei","site":null,"status":"fehler","statusLabel":"mit Fehler","open":true},{"id":"d3","title":"Drei","site":null,"status":"uebernommen","statusLabel":"im Wiki","open":false}]}}"#))
        XCTAssertTrue(picking.ingest?.choosable ?? false)
        XCTAssertEqual(picking.ingest?.openTexts.map(\.id), ["d1", "d2"])
        let empty = await store.ingest(picking, docIDs: [])
        XCTAssertFalse(empty, "ohne Auswahl nichts")
        let picked = await store.ingest(picking, docIDs: ["d2"])
        XCTAssertTrue(picked)
        let chosen = try XCTUnwrap(transport.requests.last { path(of: $0) == "/aktion/lesen/folge/ingest" })
        XCTAssertEqual(formFields(chosen), ["id": "ep-3", "docs": "d2", "auswahl": "1"])

        // Alles entworfen oder im Wiki: nichts anzustoßen.
        let done = try JSONDecoder().decode(Episode.self, from: json(#"{"id":"x","kind":"report","status":"fertig","createdAt":"2026-10-25T09:00:00.000Z","ingest":{"total":1,"open":0,"ready":1,"available":true,"label":"Ingest: 1 bereit zum Prüfen"}}"#))
        XCTAssertFalse(done.ingest?.canRequest ?? true)
        let none = await store.ingest(done)
        XCTAssertFalse(none)
    }

    @MainActor
    func testNewEpisodeWithoutEpisodes() async throws {
        let transport = server(["/api/lesen/folgen/neu": "lesen-folgen-neu-aus"])
        let store = NewEpisodeStore(context: try context(transport))
        await store.load()
        XCTAssertNil(queryValue(transport.requests[0], "zeit"))
        XCTAssertEqual(store.model?.enabled, false)
        XCTAssertNil(store.kind)
        XCTAssertFalse(store.canSubmit)
    }

    // MARK: Formular

    func testRepeatedFormFields() {
        XCTAssertEqual(CockpitAPI.formBody(pairs: [("doc", "b"), ("art", "C++ & mehr"), ("doc", "a")]), "doc=b&art=C%2B%2B%20%26%20mehr&doc=a")
    }
}
