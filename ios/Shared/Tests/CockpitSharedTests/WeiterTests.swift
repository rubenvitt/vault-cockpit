import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// „Weiter“ und der Hörstand der Folgen gegen die Fixtures des Servers (src/lesen/weiter.js,
/// src/lesen/folgen-page.js).
final class WeiterTests: XCTestCase {
    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: try fixture(name))
    }

    private func server(_ routes: [String: String] = [:]) -> FakeTransport {
        FakeTransport { request in
            let p = path(of: request)
            if let name = routes[p] { return (200, try fixture(name)) }
            switch p {
            case "/api/lesen/weiter": return (200, try fixture("lesen-weiter"))
            case "/api/lesen/folgen": return (200, try fixture("lesen-folgen-gehoert"))
            default: return (200, json(#"{"ok":true,"message":"Erledigt","undo":{"action":"/aktion/lesen/doc/status","fields":{"id":"x","status":"stapel"}}}"#))
            }
        }
    }

    @MainActor
    private func context(_ transport: FakeTransport) throws -> CockpitContext {
        makeContext(transport, directory: try temporaryDirectory())
    }

    // MARK: Modell

    func testWeiterDecodesStagesTrackAndNext() throws {
        let model = try decode(WeiterModel.self, "lesen-weiter")
        XCTAssertEqual(model.stages.map(\.key), ["pruefen", "anhoeren", "entscheiden", "fehler", "weiterlesen", "laeuft"])
        XCTAssertEqual(model.visibleStages.map(\.key), ["pruefen", "anhoeren", "entscheiden", "fehler", "weiterlesen"])
        XCTAssertEqual(model.next.stage, "pruefen")
        XCTAssertEqual(model.next.label, "Prüfen")
        XCTAssertTrue(model.next.href?.hasPrefix("/lesen/ingest/doc?id=") ?? false)
        XCTAssertNil(model.next.anchor)
        XCTAssertEqual(model.counts.eingang, 1)
        XCTAssertEqual(model.counts.stapel, 1)
        XCTAssertEqual(model.draftable, 2)
        XCTAssertTrue(model.ingestAvailable)
        XCTAssertTrue(model.vault)
        XCTAssertFalse(model.isClear)

        // Anhören: ungehörte Folgen mit ihren Texten, angefangene zuerst.
        let hear = try XCTUnwrap(model.stages.first { $0.key == "anhoeren" })
        let started = try XCTUnwrap(hear.items.first)
        XCTAssertEqual(started.episode?.id, "ep-neu")
        XCTAssertEqual(started.id, "folge:ep-neu")
        XCTAssertNil(started.doc)
        XCTAssertEqual(started.docs.map(\.label), ["Warum Agenten ein Gedächtnis brauchen", "Local-first Software"])
        XCTAssertEqual(started.meta(timeZone: berlin), "Podcast · 10:12 · angefangen, bei 3:05")
        XCTAssertEqual(hear.items.last?.meta(timeZone: berlin), "Vorlesen · 6:20")

        // Entscheiden: gelesen oder gehört, mit Spur.
        let decide = try XCTUnwrap(model.stages.first { $0.key == "entscheiden" })
        XCTAssertEqual(Set(decide.items.compactMap(\.doc?.title)), ["Die Kunst des langsamen Lesens", "Gehört im alten Podcast"])
        let heard = try XCTUnwrap(decide.items.first { $0.doc?.title == "Gehört im alten Podcast" })
        XCTAssertEqual(heard.read?.isHeard, true)
        XCTAssertEqual(heard.read?.label(timeZone: berlin), "gehört am 24. Okt. in „Report: Gehört im alten Podcast“")
        XCTAssertEqual(heard.meta(timeZone: berlin), "blog.test · 8 Min. · gehört am 24. Okt. in „Report: Gehört im alten Podcast“")
        XCTAssertEqual(heard.track.map(\.label), ["Gehört", "Entwurf", "Im Wiki", "Eingepflanzt"])
        XCTAssertEqual(heard.track.map(\.state), ["done", "todo", "todo", "todo"])
        let read = try XCTUnwrap(decide.items.first { $0.doc?.title == "Die Kunst des langsamen Lesens" })
        XCTAssertEqual(read.read?.label(timeZone: berlin), "zu Ende gelesen")

        // Fehler und Weiterlesen.
        let failed = try XCTUnwrap(model.stages.first { $0.key == "fehler" }?.items.first)
        XCTAssertEqual(failed.ingest?.status, "fehler")
        XCTAssertFalse(failed.isPlantFailure)
        XCTAssertEqual(failed.state, "Entwurf fehlgeschlagen: Claude hat nicht rechtzeitig geantwortet")
        let reading = try XCTUnwrap(model.stages.first { $0.key == "weiterlesen" }?.items.first)
        XCTAssertEqual(reading.remaining, 27)
        XCTAssertEqual(reading.meta(timeZone: berlin), "paulgraham.com · noch 27 Min.")
    }

    func testEmptyWeiterIsClear() throws {
        let model = try decode(WeiterModel.self, "lesen-weiter-leer")
        XCTAssertTrue(model.isClear)
        XCTAssertNil(model.next.stage)
        XCTAssertEqual(model.next.text, "Alles erledigt. Nichts wartet auf dich.")
        XCTAssertNil(model.next.label)
    }

    func testNextAnchorPointsIntoThePage() throws {
        let next = WeiterNext(stage: "entscheiden", text: "…", href: "#entscheiden", label: "Entscheiden")
        XCTAssertEqual(next.anchor, "entscheiden")
    }

    func testWeiterRouteFromWebPaths() {
        XCTAssertEqual(ReadingRoute(webPath: "/lesen"), .weiter)
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/weiter#entscheiden"), .weiter)
        XCTAssertEqual(ReadingRoute.weiter.webPath, "/lesen/weiter")
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/eingang"), .inbox(group: nil))
    }

    func testStackKnowsWhatWaitsUnderWeiter() throws {
        let stack = try decode(ReadingStackModel.self, "lesen-stapel-weiter")
        XCTAssertEqual(stack.decide, 4, "alles Gelesene oder Gehörte, auch was unter „Anhören“ auf die Folge wartet")
        XCTAssertFalse(stack.items.contains { $0.doc.title == "Die Kunst des langsamen Lesens" }, "Gelesenes steht nicht mehr auf dem Stapel")
        XCTAssertNil(try decode(ReadingStackModel.self, "lesen-stapel").decide, "ältere Server")
    }

    // MARK: Folgen

    func testEpisodesListenStateAndGroups() throws {
        let list = try decode(EpisodeListModel.self, "lesen-folgen-gehoert")
        let groups = EpisodeGroups(list.items)
        XCTAssertEqual(groups.toHear.map(\.id), ["ep-neu", "ep-vor"], "angefangene zuerst")
        XCTAssertEqual(groups.inProgress.map(\.id), ["ep-busy"])
        XCTAssertEqual(groups.transcripts, [])
        XCTAssertEqual(groups.heard.map(\.id), ["ep-alt"])
        let started = try XCTUnwrap(list.items.first { $0.id == "ep-neu" })
        XCTAssertTrue(started.isStarted)
        XCTAssertFalse(started.isHeard)
        XCTAssertEqual(started.listenLabel(timeZone: berlin), "angefangen, bei 3:05")
        XCTAssertEqual(list.items.first { $0.id == "ep-vor" }?.listenLabel(timeZone: berlin), "noch nicht gehört")
        let old = try XCTUnwrap(list.items.first { $0.id == "ep-alt" })
        XCTAssertTrue(old.isHeard)
        XCTAssertEqual(old.listenLabel(timeZone: berlin), "gehört am 11. Okt.")
        XCTAssertNil(list.items.first { $0.id == "ep-busy" }?.listenLabel(), "entsteht noch")
        // Ältere Server ohne Hörstand: alles zum Hören, nichts eingeklappt.
        let legacy = EpisodeGroups(try decode(EpisodeListModel.self, "lesen-folgen").items)
        XCTAssertTrue(legacy.heard.isEmpty)
    }

    // MARK: Stores

    @MainActor
    func testWeiterFinishLeavesAtOnceAndOffersUndo() async throws {
        let transport = server()
        let context = try context(transport)
        let store = WeiterStore(context: context)
        await store.load()
        let item = try XCTUnwrap(store.model?.stages.first { $0.key == "entscheiden" }?.items.first)
        transport.hold = true
        let finishing = Task { await store.finish(item) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertFalse(store.model?.stages.flatMap(\.items).contains { $0.id == item.id } ?? true, "sofort weg")
        XCTAssertTrue(store.busy.contains(item.id))
        transport.hold = false
        transport.release()
        let ok = await finishing.value
        XCTAssertTrue(ok)
        let request = try XCTUnwrap(transport.requests.first { path(of: $0) == "/aktion/lesen/doc/fertig" })
        XCTAssertEqual(formFields(request)["id"], item.doc?.id)
        let toast = try XCTUnwrap(context.toasts.toasts.last)
        XCTAssertEqual(toast.action?.label, "Rückgängig")
    }

    @MainActor
    func testWeiterActionComesBackWhenRejected() async throws {
        let transport = server()
        let context = try context(transport)
        let store = WeiterStore(context: context)
        await store.load()
        let item = try XCTUnwrap(store.model?.stages.first { $0.key == "entscheiden" }?.items.first)
        transport.respond { request in
            if path(of: request) == "/api/lesen/weiter" { return (200, try fixture("lesen-weiter")) }
            return (409, json(#"{"error":"action_failed","message":"Nicht in den Vault geschrieben"}"#))
        }
        let ok = await store.toVault(item)
        XCTAssertFalse(ok)
        XCTAssertTrue(store.model?.stages.flatMap(\.items).contains { $0.id == item.id } ?? false, "wieder da")
        XCTAssertEqual(context.toasts.toasts.last?.message, "Nicht in den Vault geschrieben")
    }

    @MainActor
    func testWeiterSendsTheRightFields() async throws {
        let transport = server()
        let store = WeiterStore(context: try context(transport))
        await store.load()
        let model = try XCTUnwrap(store.model)
        let decide = try XCTUnwrap(model.stages.first { $0.key == "entscheiden" }?.items.first)
        let failed = try XCTUnwrap(model.stages.first { $0.key == "fehler" }?.items.first)
        let hear = try XCTUnwrap(model.stages.first { $0.key == "anhoeren" }?.items.first)
        await store.draft(decide)
        await store.toVault(decide)
        await store.draft(failed, force: true)
        await store.markHeard(hear)
        await store.draftAll()
        let sent = transport.requests.filter { $0.httpMethod == "POST" }.map { (path(of: $0), formFields($0)) }
        XCTAssertEqual(sent.map(\.0), ["/aktion/lesen/ingest/entwerfen", "/aktion/lesen/doc/vault", "/aktion/lesen/ingest/entwerfen", "/aktion/lesen/folge/gehoert", "/aktion/lesen/weiter/entwerfen"])
        XCTAssertEqual(sent[0].1, ["id": try XCTUnwrap(decide.doc?.id)])
        XCTAssertEqual(sent[1].1["volltext"], "1")
        XCTAssertEqual(sent[2].1["force"], "1")
        XCTAssertEqual(sent[3].1, ["id": "ep-neu", "gehoert": "1"])
    }

    @MainActor
    func testEpisodeMarkHeardMovesBetweenGroups() async throws {
        let transport = server(["/aktion/lesen/folge/gehoert": "lesen-aktion-folge-gehoert"])
        let context = try context(transport)
        let store = EpisodesStore(context: context)
        await store.load()
        let episode = try XCTUnwrap(store.model?.items.first { $0.id == "ep-vor" })
        transport.hold = true
        let marking = Task { await store.markHeard(episode) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertTrue(store.groups.heard.contains { $0.id == "ep-vor" }, "sofort unter Gehört")
        transport.hold = false
        transport.release()
        let ok = await marking.value
        XCTAssertTrue(ok)
        let toast = try XCTUnwrap(context.toasts.toasts.first { $0.message == "Gehört: Vorlesen: Hundetraining ohne Druck" })
        XCTAssertEqual(toast.action?.label, "Rückgängig")
    }
}
