import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// Ingest ins Wiki: Modelle, Übersicht und Prüfansicht gegen echte Antworten des Servers
/// (test/lesen-ingest-web.test.js mit `COCKPIT_FIXTURES`).
final class IngestTests: XCTestCase {
    private let ready = "079f3c9f-5e4a-42a7-949c-71a3d342b7ee"
    private let halted = "be81701e-cc17-4c80-a4f5-c0c63dd94db0"
    private let busyDoc = "cc058468-93ce-468d-b9d5-8de646abe167"
    private let failedDoc = "83bd8f90-6467-4119-8548-850000ede5dd"
    private let noDraft = "011adf2b-9e03-489a-8231-bc58dc08bea3"

    /// Übersicht und Prüfansicht je `id` mit ihrer Fixture, Aktionen mit `actions[path]`.
    private func server(docs: [String: String]? = nil, overview: String = "lesen-ingest", actions: [String: String] = [:]) -> FakeTransport {
        let docs = docs ?? [ready: "lesen-ingest-doc", halted: "lesen-ingest-doc-halb", busyDoc: "lesen-ingest-doc-wartet", noDraft: "lesen-ingest-doc-ohne"]
        return FakeTransport { request in
            let p = path(of: request)
            switch p {
            case "/api/lesen/ingest": return (200, try fixture(overview))
            case "/api/lesen/ingest/doc":
                guard let name = queryValue(request, "id").flatMap({ docs[$0] }) else { return (404, json(#"{"error":"not_found","message":"Für diesen Text gibt es keinen Entwurf."}"#)) }
                return (200, try fixture(name))
            default:
                if let name = actions[p] { return (200, try fixture(name)) }
                return (200, json(#"{"ok":true,"message":"Gespeichert"}"#))
            }
        }
    }

    @MainActor
    private func context(_ transport: FakeTransport) throws -> CockpitContext {
        makeContext(transport, directory: try temporaryDirectory())
    }

    /// Formularpaare in Reihenfolge, auch wiederholte (`item`).
    private func pairs(_ request: URLRequest) -> [(String, String)] {
        guard let body = request.httpBody, let text = String(data: body, encoding: .utf8), !text.isEmpty else { return [] }
        return text.split(separator: "&").map { pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map { String($0).removingPercentEncoding ?? String($0) }
            return (parts[0], parts.count > 1 ? parts[1] : "")
        }
    }

    // MARK: Modelle

    func testOverviewDecodes() throws {
        let model = try CockpitAPI.decode(IngestOverviewModel.self, from: try fixture("lesen-ingest"))
        XCTAssertTrue(model.enabled)
        XCTAssertTrue(model.available)
        XCTAssertEqual(model.counts, IngestCounts(wartet: 0, entwirft: 1, bereit: 2, fehler: 1))
        XCTAssertEqual(model.openLabel, "2 Texte auf dem Stapel haben noch keinen fertigen Entwurf.")
        let card = try XCTUnwrap(model.ready.first { $0.id == ready })
        XCTAssertEqual(card.title, "Bereit")
        XCTAssertEqual(card.kern.count, 3)
        XCTAssertEqual(NoteInline.plainText(card.kern[0]), "Erste Aussage über Bereit")
        XCTAssertEqual(card.tallyLabel, "1 Verknüpfung · 1 Bestätigung · 1 Synthese · 1 Synthese-Ergänzung · 1 Frage · 1 neue Seite · 1 Relation")
        XCTAssertEqual(card.tally.ergaenzung, 1)
        XCTAssertEqual(card.tally.offerLabel, "Synthese angeboten")
        XCTAssertEqual(card.meta(timeZone: TimeZone(identifier: "Europe/Berlin")!), "Blatt · 7 Min. · nachts entworfen · 25. Okt., 03:10")
        XCTAssertEqual(model.busy.map(\.id), [busyDoc])
        XCTAssertTrue(model.busy[0].isBusy)
        XCTAssertTrue(model.busy[0].busyLabel.hasPrefix("Claude entwirft"))
        XCTAssertEqual(model.failed.map(\.error), ["Claude hat nicht geantwortet"])
        XCTAssertEqual(model.status(of: busyDoc), IngestStatus.drafting)
        XCTAssertEqual(model.status(of: failedDoc), IngestStatus.failed)
        XCTAssertNil(model.status(of: noDraft))

        let off = try CockpitAPI.decode(IngestOverviewModel.self, from: try fixture("lesen-ingest-aus"))
        XCTAssertFalse(off.enabled)
        XCTAssertTrue(off.isEmpty)
        let noClaude = try CockpitAPI.decode(IngestOverviewModel.self, from: try fixture("lesen-ingest-ohne-claude"))
        XCTAssertEqual([noClaude.available ? "ja" : "nein", noClaude.reason ?? ""], ["nein", "Kein Token"])
        XCTAssertEqual(noClaude.openLabel, "Ein Text auf dem Stapel hat noch keinen fertigen Entwurf.")
    }

    func testReviewModelCarriesTreesGroupsAndLocks() throws {
        let doc = try CockpitAPI.decode(IngestDocModel.self, from: try fixture("lesen-ingest-doc"))
        XCTAssertTrue(doc.isReady)
        XCTAssertTrue(doc.available)
        XCTAssertEqual(doc.selected, ["v1", "b1", "r1"])
        XCTAssertEqual(doc.groups.map(\.key), ["verknuepfen", "bestaetigung", "synthese", "neu", "relation"])
        XCTAssertEqual(doc.groups.first { $0.featured }?.ids, ["s1", "q1", "e1"])
        XCTAssertEqual([doc.position, doc.total], [2, 2])
        XCTAssertEqual(doc.prev, halted)
        let view = try XCTUnwrap(doc.view)
        XCTAssertEqual(view.kernaussagen.count, 4)
        // Wikilinks wie im Web: bekannte Seite als Link mit Titel, unbekannte als Text.
        guard case .wikilink(let link)? = view.neu[0].first(where: { if case .wikilink = $0 { true } else { false } }) else { return XCTFail("kein Wikilink") }
        XCTAssertEqual([link.text, link.path], ["Claude Code", "wiki/entities/claude-code.md"])
        XCTAssertEqual(NoteInline.plainText(view.neu[0]), "Ergänzt Claude Code und gibt es nicht im wiki")
        XCTAssertEqual(NoteInline.plainText(view.hinweise[0]), "Widerspruch zu RAG – Auflösung per /wiki-lint")
        XCTAssertEqual(view.bestaetigt.map(\.page), [IngestPageRef(path: "wiki/concepts/context-engineering.md", title: "Context Engineering")])
        XCTAssertEqual(view.widerspricht.first.flatMap { $0.vorschlag.map(NoteInline.plainText) }, "Als Gegenposition aufnehmen")
        XCTAssertEqual(view.docktAn.first?.text.map(NoteInline.plainText), "Beispiel im Text")
        XCTAssertEqual(view.source.slug, "glaser-agenten-gedaechtnis")
        XCTAssertEqual(view.source.meta, "Konfidenz: mittel · wiki/sources/glaser-agenten-gedaechtnis.md")
        XCTAssertFalse(view.source.locked)
        XCTAssertEqual(view.source.body?.count, 3)
        XCTAssertNil(view.halted)
        let v1 = try XCTUnwrap(view.item("v1"))
        XCTAssertEqual([v1.label, v1.title, v1.open], ["Konzept", "Context Engineering", "wiki/concepts/context-engineering.md"])
        XCTAssertTrue(v1.isDefault)
        let r1 = try XCTUnwrap(view.item("r1"))
        XCTAssertEqual(r1.relation, "verfasst von")
        XCTAssertNil(r1.open, "Relation auf eine Seite, die erst entsteht: kein Link")
        XCTAssertFalse(r1.showsLabel)
        let s1 = try XCTUnwrap(view.item("s1"))
        XCTAssertEqual([s1.label, s1.slug], ["Synthese · Vergleich", "gedaechtnis-vs-rag"])
        XCTAssertEqual(s1.beteiligte, [IngestPageRef(path: "wiki/concepts/rag.md", title: "RAG")])
        XCTAssertNotNil(s1.body)
        XCTAssertFalse(s1.isExtension)
        XCTAssertEqual(s1.bodyLabel(featured: true), "Ganzen Text lesen")
        XCTAssertNil(s1.extendedSlug)
        // Ergänzung einer bestehenden Synthese: Kennzeichen, Titel und Öffnen der Synthese, eigener Aufklapptext.
        let e1 = try XCTUnwrap(view.item("e1"))
        XCTAssertEqual([e1.kind, e1.action, e1.label, e1.title], ["synthesis", "ergaenzen", "Synthese ergänzen", "Gedächtnis und Kontext"])
        XCTAssertEqual(e1.open, "wiki/synthesis/gedaechtnis-und-kontext.md")
        XCTAssertNil(e1.slug)
        XCTAssertTrue(e1.isExtension)
        XCTAssertEqual(e1.extendedSlug, "gedaechtnis-und-kontext")
        XCTAssertEqual(e1.bodyLabel(featured: true), "Was ergänzt wird")
        XCTAssertFalse(e1.isDefault)
        XCTAssertNotNil(e1.body)

        let halb = try CockpitAPI.decode(IngestDocModel.self, from: try fixture("lesen-ingest-doc-halb"))
        XCTAssertEqual(halb.view?.halted?.source, "wiki/sources/halb-1234.md")
        XCTAssertEqual(halb.view?.source.slug, "halb-1234")
        XCTAssertEqual([halb.view?.source.locked, halb.view?.source.slugLocked], [true, true])
        XCTAssertEqual(halb.error, #""wiki/concepts/rag.md" wurde gerade anderweitig geändert."#)
        XCTAssertEqual(halb.appliedSource, "wiki/sources/halb-1234.md")

        let busy = try CockpitAPI.decode(IngestDocModel.self, from: try fixture("lesen-ingest-doc-wartet"))
        XCTAssertEqual(busy.status, IngestStatus.drafting)
        XCTAssertNil(busy.view)
        XCTAssertFalse(busy.isReady)
        let none = try CockpitAPI.decode(IngestDocModel.self, from: try fixture("lesen-ingest-doc-ohne"))
        XCTAssertNil(none.status)
        XCTAssertEqual(none.ingest?.title, "Ohne Entwurf")
        XCTAssertTrue(none.groups.isEmpty)
    }

    func testActionResponsesAndBadgesInStackAndReader() throws {
        let applied = try CockpitAPI.decode(IngestActionResponse.self, from: try fixture("lesen-ingest-aktion-uebernehmen"))
        XCTAssertEqual(applied.message, "Im Wiki: Bereit + 1 Seite, 1 verknüpft, 1 Synthese ergänzt")
        XCTAssertEqual(applied.link, IngestLink(href: "/notiz?pfad=wiki%2Fsources%2Fbereit.md", label: "Source-Page öffnen"))
        XCTAssertEqual(applied.redirect, "/lesen/ingest/doc?id=\(halted)")
        XCTAssertEqual(applied.result?.source, "wiki/sources/bereit.md")
        XCTAssertEqual(applied.result?.linked, ["wiki/concepts/context-engineering.md"])
        XCTAssertEqual(applied.result?.confirmed, [])
        XCTAssertEqual(applied.result?.extended, ["wiki/synthesis/gedaechtnis-und-kontext.md"])
        let done = try CockpitAPI.decode(IngestActionResponse.self, from: try fixture("lesen-ingest-aktion-erledigt"))
        XCTAssertEqual(done.undo, UndoAction(action: "/aktion/lesen/doc/status", fields: ["id": halted, "status": "stapel"]))
        let drafted = try CockpitAPI.decode(IngestActionResponse.self, from: try fixture("lesen-ingest-aktion-entwerfen"))
        XCTAssertEqual(drafted.ingest?.status, IngestStatus.waiting)
        XCTAssertEqual(try CockpitAPI.decode(IngestActionResponse.self, from: try fixture("lesen-ingest-aktion-stapel")).count, 1)

        let stack = try CockpitAPI.decode(ReadingStackModel.self, from: try fixture("lesen-stapel-ingest"))
        XCTAssertEqual([stack.ingest, stack.ingestAvailable], [true, true])
        XCTAssertEqual(stack.items.map(\.ingest), [nil, IngestStatus.ready, IngestStatus.failed, IngestStatus.drafting, IngestStatus.ready])
        // Ältere Fixture ohne Ingest: Felder fehlen, nichts bricht.
        let old = try CockpitAPI.decode(ReadingStackModel.self, from: try fixture("lesen-stapel"))
        XCTAssertNil(old.ingest)
        XCTAssertNil(old.items.first?.ingest)

        let reader = try CockpitAPI.decode(ReadingDocModel.self, from: try fixture("lesen-doc-ingest"))
        XCTAssertEqual(reader.ingest, ReaderIngest(status: IngestStatus.ready, available: true))
        XCTAssertNil(try CockpitAPI.decode(ReadingDocModel.self, from: try fixture("lesen-doc")).ingest)
    }

    /// Ältere Server (ohne `ergaenzung`, `extended`) und unbekannte Arten vom Server: nichts bricht.
    func testUnknownKindsAndOlderServersDecode() throws {
        let item = try CockpitAPI.decode(IngestItemView.self, from: json(#"{"id":"x1","kind":"etwas-neues","action":"umbauen","label":"Neu","title":"T","default":true}"#))
        XCTAssertEqual([item.kind, item.action], ["etwas-neues", "umbauen"])
        XCTAssertFalse(item.isExtension)
        XCTAssertEqual(item.bodyLabel(featured: false), "Text der Seite ansehen")
        let tally = try CockpitAPI.decode(IngestTally.self, from: json(#"{"verknuepfen":1,"frage":1}"#))
        XCTAssertEqual(tally.ergaenzung, 0)
        XCTAssertEqual(tally.offerLabel, "Frage angeboten")
        XCTAssertEqual(IngestTally(ergaenzung: 2, frage: 1).offerLabel, "Ergänzungen angeboten")
        XCTAssertEqual(IngestTally(synthese: 1, ergaenzung: 1).offerLabel, "Synthese angeboten")
        let result = try CockpitAPI.decode(IngestApplyResult.self, from: json(#"{"source":"wiki/sources/a.md","written":[],"linked":[]}"#))
        XCTAssertEqual([result.confirmed, result.extended], [[], []])
    }

    func testRoutesFormatsAndSlugs() {
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/ingest"), .ingest)
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/ingest/doc?id=a%20b"), .ingestReview(id: "a b"))
        XCTAssertNil(ReadingRoute(webPath: "/lesen/ingest/doc"))
        XCTAssertEqual(ReadingRoute.ingestReview(id: "x1").webPath, "/lesen/ingest/doc?id=x1")
        XCTAssertEqual(ReadingRoute.ingest.webPath, "/lesen/ingest")
        XCTAssertEqual(CockpitFormat.ingestApplySummary(0), "Nur die Source-Page")
        XCTAssertEqual(CockpitFormat.ingestApplySummary(1), "Source-Page und 1 Vorschlag")
        XCTAssertEqual(CockpitFormat.ingestApplySummary(3), "Source-Page und 3 Vorschläge")
        let date = CockpitFormat.date(from: "2026-05-03T07:04:00Z")!
        XCTAssertEqual(CockpitFormat.dayTime(date, timeZone: TimeZone(identifier: "Europe/Berlin")!), "3. Mai, 09:04")
        for good in ["", "a", "glaser-the-elastic-loop", "x2-y3"] { XCTAssertTrue(IngestReviewStore.isValidSlug(good), good) }
        for bad in ["-a", "a-", "a--b", "Über", "a b", "a_b"] { XCTAssertFalse(IngestReviewStore.isValidSlug(bad), bad) }
        XCTAssertTrue(IngestStatus.isBusy("wartet"))
        XCTAssertFalse(IngestStatus.isActive("verworfen"))
    }

    // MARK: Prüfansicht

    @MainActor
    func testReviewSelectsDefaultsAndTogglesByGroup() async throws {
        let transport = server()
        let context = try context(transport)
        let store = IngestReviewStore(context: context, docID: ready)
        await store.load()
        XCTAssertEqual(store.selection, ["v1", "b1", "r1"])
        XCTAssertEqual(store.applyCount, 4)
        XCTAssertEqual(store.applySummary, "Source-Page und 3 Vorschläge")
        XCTAssertEqual([store.title, store.slug, store.tags], ["Bereit", "glaser-agenten-gedaechtnis", "agents, memory"])
        XCTAssertEqual(store.summaryCount, "Wie Agenten sich erinnern, ohne den Kontext zu füllen".utf16.count)
        XCTAssertFalse(store.isSummaryOver)
        XCTAssertTrue(store.canApply)

        let featured = try XCTUnwrap(store.model?.groups.first { $0.featured })
        XCTAssertTrue(store.noneSelected(featured))
        store.selectAll(featured)
        XCTAssertTrue(store.allSelected(featured))
        XCTAssertEqual(store.chosen, ["v1", "b1", "s1", "q1", "r1", "e1"])
        store.toggle("q1")
        XCTAssertFalse(store.isSelected("q1"))
        store.toggle("gibt-es-nicht")
        XCTAssertFalse(store.isSelected("gibt-es-nicht"))
        store.selectNone(try XCTUnwrap(store.model?.groups.first { $0.key == "verknuepfen" }))
        XCTAssertEqual(store.chosen, ["b1", "s1", "r1", "e1"])
        XCTAssertEqual(context.toasts.haptic?.intent, .selection)

        // Neu laden desselben Entwurfs lässt Auswahl und Felder stehen.
        store.title = "Eigener Titel"
        await store.refresh()
        XCTAssertEqual(store.chosen, ["b1", "s1", "r1", "e1"])
        XCTAssertEqual(store.title, "Eigener Titel")

        store.summary = String(repeating: "x", count: 81)
        XCTAssertTrue(store.isSummaryOver)
        store.slug = "Mit Umlaut ä"
        XCTAssertEqual(store.slugProblem, "Kleinbuchstaben, Ziffern und Bindestriche")
        XCTAssertFalse(store.canApply)
        store.slug = ""
        XCTAssertTrue(store.canApply, "leerer Slug: der Server nimmt den aus dem Entwurf")
        store.title = "  "
        XCTAssertFalse(store.canApply)
    }

    @MainActor
    func testApplySendsChosenItemsAndFieldsAndGoesOn() async throws {
        let transport = server(actions: [IngestAction.apply: "lesen-ingest-aktion-uebernehmen"])
        let context = try context(transport)
        var opened: [String] = []
        context.openPath = { opened.append($0) }
        let overview = IngestStore(context: context)
        let store = IngestReviewStore(context: context, docID: ready, overview: overview)
        await store.load()
        store.toggle("s1")
        store.title = " Bereit, besser "
        store.tags = "agents, memory, neu"

        let next = await store.apply()
        XCTAssertEqual(next, "/lesen/ingest/doc?id=\(halted)")
        let request = try XCTUnwrap(transport.requests.first { path(of: $0) == IngestAction.apply })
        let sent = pairs(request)
        XCTAssertEqual(sent.filter { $0.0 == "item" }.map(\.1), ["v1", "b1", "s1", "r1"], "Reihenfolge des Entwurfs")
        let fields = Dictionary(sent.filter { $0.0 != "item" }, uniquingKeysWith: { a, _ in a })
        XCTAssertEqual(fields["id"], ready)
        XCTAssertEqual(fields["title"], "Bereit, besser")
        XCTAssertEqual(fields["slug"], "glaser-agenten-gedaechtnis")
        XCTAssertEqual(fields["tags"], "agents, memory, neu")
        XCTAssertEqual(fields["back"], "/lesen/ingest/doc?id=\(ready)")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")

        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.message, "Im Wiki: Bereit + 1 Seite, 1 verknüpft, 1 Synthese ergänzt")
        XCTAssertEqual(toast.action?.label, "Source-Page öffnen")
        context.toasts.perform(toast.id)
        XCTAssertEqual(opened, ["/notiz?pfad=wiki%2Fsources%2Fbereit.md"])
        XCTAssertEqual(context.toasts.haptic?.intent, .success)
        XCTAssertEqual(store.model?.status, IngestStatus.applied)
        XCTAssertEqual(overview.status(of: ready, fallback: IngestStatus.ready, loadedAt: nil), IngestStatus.applied)
    }

    @MainActor
    func testApplyWithoutNetworkSavesNothing() async throws {
        let transport = server()
        let context = try context(transport)
        let store = IngestReviewStore(context: context, docID: ready)
        await store.load()
        transport.respond { request in
            if path(of: request) == IngestAction.apply { throw URLError(.notConnectedToInternet) }
            return (200, try fixture("lesen-ingest-doc"))
        }
        let before = transport.requests.count
        let next = await store.apply()
        XCTAssertNil(next)
        XCTAssertEqual(transport.requests.count, before + 1, "ohne Netz kein Neuladen")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Keine Verbindung zum Cockpit. Nichts gespeichert.")
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)
        XCTAssertEqual(store.model?.status, IngestStatus.ready)
        XCTAssertEqual(store.selection, ["v1", "b1", "r1"])
    }

    @MainActor
    func testRejectedApplyReloadsAndLocksTheWrittenSourcePage() async throws {
        let transport = server()
        let context = try context(transport)
        let store = IngestReviewStore(context: context, docID: ready)
        await store.load()
        store.title = "Mein Titel"
        transport.respond { request in
            switch path(of: request) {
            case IngestAction.apply: return (409, try fixture("lesen-ingest-aktion-fehler"))
            default: return (200, try fixture("lesen-ingest-doc-halb"))
            }
        }
        let next = await store.apply()
        XCTAssertNil(next)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Die Seite wiki/sources/hakt.md gibt es schon")
        // Neu geladen: Abbruch mit gesperrten Feldern, die Werte des Servers gelten.
        XCTAssertEqual(store.view?.halted?.source, "wiki/sources/halb-1234.md")
        XCTAssertTrue(store.fieldsLocked)
        XCTAssertTrue(store.slugLocked)
        XCTAssertEqual(store.slug, "halb-1234")
        XCTAssertTrue(store.canApply)
    }

    @MainActor
    func testHaltedApplySendsTheLockedFields() async throws {
        let transport = server(actions: [IngestAction.apply: "lesen-ingest-aktion-uebernehmen"])
        let context = try context(transport)
        let store = IngestReviewStore(context: context, docID: halted)
        await store.load()
        store.title = "Wird ignoriert"
        store.slug = "anders"
        _ = await store.apply()
        let request = try XCTUnwrap(transport.requests.first { path(of: $0) == IngestAction.apply })
        let fields = Dictionary(pairs(request).filter { $0.0 != "item" }, uniquingKeysWith: { a, _ in a })
        XCTAssertEqual(fields["title"], "Halb")
        XCTAssertEqual(fields["slug"], "halb-1234")
    }

    @MainActor
    func testFinishWithoutWikiOffersUndoAndDiscardGoesOn() async throws {
        let transport = server(actions: [IngestAction.discard: "lesen-ingest-aktion-erledigt"])
        let context = try context(transport)
        let store = IngestReviewStore(context: context, docID: halted)
        await store.load()
        let next = await store.finishWithoutWiki()
        XCTAssertEqual(next, "/lesen/ingest")
        let request = try XCTUnwrap(transport.requests.last { path(of: $0) == IngestAction.discard })
        XCTAssertEqual(formFields(request), ["id": halted, "done": "1", "back": "/lesen/ingest/doc?id=\(halted)"])
        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.message, "Erledigt, ohne Wiki: Halb")
        XCTAssertEqual(toast.action?.label, "Rückgängig")
        context.toasts.perform(toast.id)
        await waitUntil { transport.requests.contains { path(of: $0) == "/aktion/lesen/doc/status" } }
        let undo = try XCTUnwrap(transport.requests.last { path(of: $0) == "/aktion/lesen/doc/status" })
        XCTAssertEqual(formFields(undo), ["id": halted, "status": "stapel"])

        let plain = IngestReviewStore(context: context, docID: ready)
        await plain.load()
        transport.respond { request in
            path(of: request) == IngestAction.discard ? (200, json(#"{"ok":true,"message":"Entwurf verworfen: Bereit","redirect":"/lesen/ingest/doc?id=x"}"#)) : (200, try fixture("lesen-ingest-doc"))
        }
        let after = await plain.discardDraft()
        XCTAssertEqual(after, "/lesen/ingest/doc?id=x")
        XCTAssertNil(formFields(transport.requests.last { path(of: $0) == IngestAction.discard }!)["done"])
        XCTAssertNil(context.toasts.toasts.last?.action)
    }

    @MainActor
    func testReviewPollsWhileDraftingAndAdoptsTheNewDraft() async throws {
        let transport = server(docs: [busyDoc: "lesen-ingest-doc-wartet"])
        let context = try context(transport)
        let store = IngestReviewStore(context: context, docID: busyDoc, pollInterval: 0.01)
        await store.load()
        XCTAssertEqual(store.model?.status, IngestStatus.drafting)
        XCTAssertFalse(store.canApply)
        store.startPolling()
        XCTAssertTrue(store.isPolling)
        transport.respond { _ in (200, try fixture("lesen-ingest-doc")) }
        await waitUntil { store.model?.isReady == true }
        XCTAssertEqual(store.selection, ["v1", "b1", "r1"], "Vorauswahl des neuen Entwurfs")
        XCTAssertEqual(store.title, "Bereit")
        await waitUntil { !store.isPolling }
        XCTAssertEqual(context.toasts.haptic?.intent, .success)
        store.stopPolling()
    }

    @MainActor
    func testDraftWithoutDraftAndUnknownText() async throws {
        let transport = server(actions: [IngestAction.draft: "lesen-ingest-aktion-entwerfen"])
        let context = try context(transport)
        let store = IngestReviewStore(context: context, docID: noDraft)
        await store.load()
        XCTAssertNil(store.model?.status)
        let ok = await store.draft()
        XCTAssertTrue(ok)
        XCTAssertEqual(formFields(try XCTUnwrap(transport.requests.first { path(of: $0) == IngestAction.draft })), ["id": noDraft])
        XCTAssertEqual(context.toasts.toasts.last?.message, "Wird entworfen: Ohne Entwurf")

        let missing = IngestReviewStore(context: context, docID: "gibt-es-nicht")
        await missing.load()
        XCTAssertTrue(missing.isNotFound)
    }

    // MARK: Übersicht

    @MainActor
    func testOverviewRetriesFailedDraftOptimistically() async throws {
        let transport = server()
        let context = try context(transport)
        let store = IngestStore(context: context)
        await store.load()
        XCTAssertEqual(store.readyCount, 2)
        XCTAssertEqual(store.isEnabled, true)

        transport.hold = true
        let retry = Task { await store.draft(failedDoc, force: true) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertTrue(store.model?.failed.isEmpty ?? false)
        XCTAssertEqual(store.model?.busy.last?.id, failedDoc)
        XCTAssertEqual(store.model?.busy.last?.busyLabel, "Wartet, bis Claude frei ist")
        XCTAssertEqual(store.status(of: failedDoc, fallback: IngestStatus.failed, loadedAt: nil), IngestStatus.waiting)
        transport.respond { request in
            path(of: request) == IngestAction.draft ? (409, json(#"{"error":"action_failed","message":"Übernehmen angefangen – erst fortsetzen"}"#)) : (200, try fixture("lesen-ingest"))
        }
        transport.hold = false
        transport.release()
        let ok = await retry.value
        XCTAssertFalse(ok)
        XCTAssertEqual(store.model?.failed.map(\.id), [failedDoc], "abgelehnt: zurück unter Fehler")
        XCTAssertEqual(formFields(try XCTUnwrap(transport.requests.first { path(of: $0) == IngestAction.draft })), ["id": failedDoc, "force": "1"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "Übernehmen angefangen – erst fortsetzen")
        XCTAssertEqual(store.status(of: failedDoc, fallback: IngestStatus.failed, loadedAt: nil), IngestStatus.failed)
    }

    @MainActor
    func testStatusPrefersWhatIsNewer() async throws {
        let transport = server()
        let context = try context(transport)
        let store = IngestStore(context: context)
        // Ohne Übersicht gilt die Liste des Bildschirms.
        XCTAssertEqual(store.status(of: ready, fallback: "bereit", loadedAt: nil), "bereit")
        await store.load()
        let older = context.now().addingTimeInterval(-60)
        let newer = context.now().addingTimeInterval(60)
        XCTAssertEqual(store.status(of: busyDoc, fallback: nil, loadedAt: older), IngestStatus.drafting, "Übersicht neuer als die Liste")
        XCTAssertNil(store.status(of: noDraft, fallback: IngestStatus.waiting, loadedAt: older), "nicht mehr offen")
        XCTAssertEqual(store.status(of: noDraft, fallback: IngestStatus.applied, loadedAt: older), IngestStatus.applied)
        XCTAssertNil(store.status(of: busyDoc, fallback: nil, loadedAt: newer), "Liste neuer als die Übersicht")
    }

    @MainActor
    func testOverviewPollsAndAnnouncesReadyDrafts() async throws {
        let transport = FakeTransport { _ in
            (200, json(#"{"ok":true,"enabled":true,"available":true,"counts":{"entwirft":1},"openOnStack":0,"ready":[],"busy":[{"id":"d1","status":"entwirft","title":"Langer Text"}],"failed":[]}"#))
        }
        let context = try context(transport)
        let store = IngestStore(context: context, pollInterval: 0.01)
        var reviewed: [String] = []
        store.onReview = { reviewed.append($0) }
        await store.load()
        XCTAssertFalse(store.isPolling)
        store.startPolling("uebersicht")
        XCTAssertTrue(store.isPolling)
        transport.respond { _ in
            (200, json(#"{"ok":true,"enabled":true,"available":true,"counts":{"bereit":1},"openOnStack":0,"ready":[{"id":"d1","status":"bereit","title":"Langer Text"}],"busy":[],"failed":[]}"#))
        }
        await waitUntil { store.readyCount == 1 }
        await waitUntil { !store.isPolling }
        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.message, "Entwurf bereit: Langer Text")
        context.toasts.perform(toast.id)
        XCTAssertEqual(reviewed, ["d1"])

        store.setActive(false)
        store.stopPolling("uebersicht")
        XCTAssertFalse(store.isPolling)
    }

    @MainActor
    func testDraftStackAndDiscardFailed() async throws {
        let transport = server(actions: [IngestAction.draft: "lesen-ingest-aktion-stapel"])
        let context = try context(transport)
        let store = IngestStore(context: context)
        await store.load()
        let ok = await store.draftStack()
        XCTAssertTrue(ok)
        XCTAssertEqual(formFields(try XCTUnwrap(transport.requests.first { path(of: $0) == IngestAction.draft })), ["stapel": "1"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "1 Text wird entworfen, einer nach dem anderen.")

        transport.respond { request in
            path(of: request) == IngestAction.discard ? (200, json(#"{"ok":true,"message":"Entwurf verworfen: Kaputt"}"#)) : (200, try fixture("lesen-ingest"))
        }
        let discarded = await store.discard(failedDoc)
        XCTAssertTrue(discarded)
        XCTAssertEqual(formFields(try XCTUnwrap(transport.requests.last { path(of: $0) == IngestAction.discard })), ["id": failedDoc])
        XCTAssertEqual(store.status(of: failedDoc, fallback: IngestStatus.failed, loadedAt: nil), IngestStatus.discarded, "eigene Aktion gilt, auch wenn die Attrappe ihn noch nennt")

        // Ohne Claude geht „Ganzen Stapel entwerfen“ nicht.
        let offline = IngestStore(context: context)
        transport.respond { _ in (200, try fixture("lesen-ingest-ohne-claude")) }
        await offline.load()
        let none = await offline.draftStack()
        XCTAssertFalse(none)
    }
}
