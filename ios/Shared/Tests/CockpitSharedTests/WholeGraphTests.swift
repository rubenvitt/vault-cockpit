import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// Ganzer Vault als Graph (VCP-113): Antwort von `/api/graph/alles`, Gruppen, Hervorhebung, Suche.
final class WholeGraphTests: XCTestCase {
    /// Wie `createWholeGraph` in src/graph/whole.js: Knoten `[pfad, titel, ordner, typ, x, y]`,
    /// Links flach; ein doppelter Link, eine Schleife und ein Index außerhalb fallen weg.
    static let body = #"""
    {"version":"abc123","builtAt":"2026-10-29T08:00:00.000Z","seconds":1.2,
     "folders":["wiki","","00-inbox"],"types":["synthesis","person"],
     "nodes":[["wiki/Hund.md","Hund",0,0,-10,5],
              ["wiki/Übung.md","Übung macht den Meister",0,-1,10,-5],
              ["Start.md","Start",1,1,0,0],
              ["00-inbox/Idee.md","Idee zum Hund",2,-1,30,20],
              ["wiki/Leine.md","Leine",0,0,-20,-15]],
     "links":[0,1,1,0,0,2,3,0,2,2,0,9,4,0]}
    """#

    @MainActor
    private func setup(_ transport: FakeTransport) throws -> CockpitContext {
        makeContext(transport, directory: try temporaryDirectory())
    }

    private func server() -> FakeTransport {
        FakeTransport { request in
            XCTAssertEqual(path(of: request), "/api/graph/alles")
            return (200, json(Self.body))
        }
    }

    func testDecodesCompactNodes() throws {
        let model = try CockpitAPI.decode(WholeGraphModel.self, from: json(Self.body))
        XCTAssertEqual(model.nodes.count, 5)
        XCTAssertEqual(model.nodes[1], WholeGraphModel.Node(path: "wiki/Übung.md", label: "Übung macht den Meister", folder: 0, type: -1, x: 10, y: -5))
        XCTAssertEqual(model.links.count, 14)
        XCTAssertEqual(model.version, "abc123")
    }

    @MainActor
    func testLoadBuildsEdgesGroupsAndFocus() async throws {
        let transport = server()
        let store = WholeGraphStore(context: try setup(transport), focus: "wiki/Hund.md")
        await store.load()
        XCTAssertEqual(store.edges.count, 4)
        XCTAssertEqual(store.degree, [4, 1, 1, 1, 1])
        XCTAssertEqual(store.neighbors(of: 0), [1, 2, 3, 4])
        XCTAssertEqual(store.bounds, WholeGraphBounds(minX: -20, minY: -15, maxX: 30, maxY: 20))
        XCTAssertEqual(store.bounds.midX, 5)
        XCTAssertEqual(store.selected, 0)
        XCTAssertEqual(store.cardMeta(0), "wiki/Hund.md · 4 Links")
        XCTAssertEqual(store.cardMeta(2), "Start.md · 1 Link")
        XCTAssertEqual(store.stats(timeZone: TimeZone(identifier: "Europe/Berlin")!), "5 Notizen · 4 Links · Stand Do 29.10. 09:00")

        // Ordner nach Größe: wiki (3), dann gleich groß „“ und 00-inbox in Reihenfolge der Indizes.
        XCTAssertEqual(store.groups.map(\.label), ["wiki", "Oberste Ebene", "00-inbox"])
        XCTAssertEqual(store.groups.map(\.count), [3, 1, 1])
        XCTAssertEqual(store.groupOf, [0, 0, 1, 2, 0])
        XCTAssertEqual(store.group(of: 3)?.label, "00-inbox")

        store.coloring = .type
        XCTAssertEqual(store.groups.map(\.label), ["synthesis", "person", "ohne Typ"])
        XCTAssertEqual(store.groups.map(\.color), [0, 1, nil])
        XCTAssertEqual(store.groupOf, [0, 2, 1, 2, 0])
    }

    @MainActor
    func testFocusMissingSelectsNothing() async throws {
        let store = WholeGraphStore(context: try setup(server()), focus: "fehlt.md")
        await store.load()
        XCTAssertNil(store.selected)
        XCTAssertFalse(store.hasEmphasis)
        XCTAssertNil(store.emphasis(0))
    }

    @MainActor
    func testEmphasisSelectionThenSearchThenGroup() async throws {
        let store = WholeGraphStore(context: try setup(server()))
        await store.load()

        store.pick(2)
        XCTAssertEqual(store.emphasis(3), true)
        XCTAssertEqual(store.emphasis(0), false)
        store.pick(2)
        XCTAssertNil(store.picked)

        store.query = "hund"
        XCTAssertEqual(store.found, [0, 3])
        XCTAssertEqual(store.emphasis(3), true)
        XCTAssertEqual(store.emphasis(1), false)

        store.select(1)
        XCTAssertEqual(store.emphasis(0), true)
        XCTAssertEqual(store.emphasis(4), false)
        store.select(nil)

        store.jump(to: 3)
        XCTAssertEqual(store.query, "")
        XCTAssertNil(store.found)
        XCTAssertEqual(store.selected, 3)
    }

    @MainActor
    func testSearchFoldsAccentsAndRanks() async throws {
        let store = WholeGraphStore(context: try setup(server()))
        await store.load()
        store.query = "ub"
        XCTAssertEqual(store.found, [1])
        store.query = "meister ubung"
        XCTAssertEqual(store.found, [1])
        // Pfad zählt mit, wenn alle Wörter passen; Titel-Anfang vor Mitte.
        store.query = "wiki le"
        XCTAssertEqual(store.found, [4])
        store.query = "i"
        XCTAssertNil(store.found)
        store.query = "xyz"
        XCTAssertEqual(store.found, [])
    }

    @MainActor
    func testRefreshKeepsSelectionByPath() async throws {
        let transport = server()
        let context = try setup(transport)
        let store = WholeGraphStore(context: context)
        await store.load()
        store.select(3)
        // Neuer Stand: Idee rückt nach vorn.
        transport.respond { _ in
            (200, json(#"{"version":"neu","folders":["00-inbox"],"types":[],"nodes":[["00-inbox/Idee.md","Idee",0,-1,0,0],["wiki/Hund.md","Hund",0,-1,1,1]],"links":[0,1]}"#))
        }
        await store.refresh()
        XCTAssertEqual(store.selected, 0)
        XCTAssertEqual(store.edges.count, 1)
    }

    @MainActor
    func testShowsSavedStateFirst() async throws {
        let transport = server()
        let context = try setup(transport)
        try context.snapshots.save(json(Self.body), for: "graph/alles", at: Date(timeIntervalSince1970: 1_700_000_000))
        let store = WholeGraphStore(context: context)
        transport.hold = true
        let loading = Task { await store.load() }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertEqual(store.nodes.count, 5)
        XCTAssertTrue(store.state.isStale)
        transport.release()
        await loading.value
        XCTAssertFalse(store.state.isStale)
    }

    func testGroupedCount() {
        XCTAssertEqual(WholeGraphStore.grouped(7), "7")
        XCTAssertEqual(WholeGraphStore.grouped(1234), "1.234")
        XCTAssertEqual(WholeGraphStore.grouped(1234567), "1.234.567")
    }

    func testRoute() {
        XCTAssertEqual(PageRoute(webPath: "/graph/alles"), .wholeGraph(focus: nil))
        XCTAssertEqual(PageRoute(webPath: "/graph/alles?pfad=wiki%2FHund.md"), .wholeGraph(focus: "wiki/Hund.md"))
        XCTAssertEqual(PageRoute.wholeGraph(focus: "wiki/Hund.md").webPath, "/graph/alles?pfad=wiki%2FHund.md")
        XCTAssertEqual(PageRoute.wholeGraph(focus: nil).webPath, "/graph/alles")
        XCTAssertNil(NativeRoute(webPath: "/graph/alles"))
        XCTAssertNil(ReadingRoute(webPath: "/graph/alles"))
    }
}
