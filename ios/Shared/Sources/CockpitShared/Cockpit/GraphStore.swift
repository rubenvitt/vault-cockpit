import Foundation
import Observation

/// Filter der Legende: welche Kantenarten (und damit Aufgaben und Termine) zu sehen sind.
public struct GraphFilters: Equatable, Sendable {
    public var link = true
    public var semantic = true
    public var task = true
    public var event = true

    public init() {}

    public subscript(kind: GraphEdgeKind) -> Bool {
        get {
            switch kind {
            case .link: link
            case .semantic: semantic
            case .task: task
            case .event: event
            }
        }
        set {
            switch kind {
            case .link: link = newValue
            case .semantic: semantic = newValue
            case .task: task = newValue
            case .event: event = newValue
            }
        }
    }
}

/// Graph einer Notiz: Mitte, Knoten und Kanten, Nachbarn aufklappen, Legende als Filter,
/// Verlinken ähnlicher Notizen und die Listen unter dem Graphen. Die Lage der Knoten (Physik)
/// macht die Oberfläche; neue Knoten sagen in `addedNear`, neben welchem Knoten sie entstanden.
@MainActor
@Observable
public final class GraphStore {
    /// Pfad der Mitte.
    public private(set) var path: String
    /// Alle bisher geladenen Knoten (Mitte und aufgeklappte Nachbarschaften), in Ladereihenfolge.
    public private(set) var nodes: [GraphNode] = []
    public private(set) var edges: [GraphEdge] = []
    /// Notizen (Knoten-IDs), deren Nachbarschaft schon geladen ist.
    public private(set) var loaded: Set<String> = []
    /// Notizen, deren Nachbarschaft gerade lädt.
    public private(set) var expanding: Set<String> = []
    /// Neuer Knoten → Knoten, aus dessen Nachbarschaft er kam (Startlage neben ihm).
    public private(set) var addedNear: [String: String] = [:]
    /// Gewählter Knoten (Karte), nil = keiner.
    public private(set) var selected: String?
    /// Legende; ein ausgeblendeter gewählter Knoten verliert die Auswahl.
    public var filters = GraphFilters() {
        didSet {
            if let selected, !isVisible(selected) { self.selected = nil }
        }
    }
    /// Verlinken läuft (Pfade).
    public private(set) var linking: Set<String> = []

    private let remote: RemoteModel<GraphModel>
    private let context: CockpitContext
    private var runner: ReplyRunner { ReplyRunner(context: context) }

    public init(context: CockpitContext, path: String) {
        self.context = context
        self.path = path
        remote = RemoteModel(context: context, path: "api/graph")
    }

    /// Antwort für die Mitte: Titel, Listen, Probleme, Rechte.
    public var model: GraphModel? { remote.model }
    public var state: LoadState { remote.state }
    /// Id der Mitte (`note:<pfad>`).
    public var center: String { model?.center ?? "note:\(path)" }

    // MARK: Laden

    /// Lädt den Graphen um `path` (gespeicherter Stand zuerst).
    public func load() async {
        await load(path: path)
    }

    /// „Zur Mitte“ / Doppeltipp: neuer Graph um diese Notiz.
    public func load(path: String) async {
        if path != self.path || nodes.isEmpty { reset() }
        self.path = path
        remote.select(key: Self.cacheKey(path), query: CockpitAPI.pathQuery(path)) { $0.path == path }
        if let model = remote.model { merge(model, near: nil) }
        await refresh()
    }

    /// Lädt die Mitte neu (Listen nach dem Verlinken, Ziehen zum Aktualisieren); der Graph bleibt.
    public func refresh() async {
        await remote.refresh()
        if let model = remote.model, model.path == path { merge(model, near: nil) }
    }

    static func cacheKey(_ path: String) -> String {
        "graph/\(path)"
    }

    private func reset() {
        nodes = []
        edges = []
        loaded = []
        expanding = []
        addedNear = [:]
        selected = nil
    }

    // MARK: Auswahl und Nachbarn

    public func node(_ id: String) -> GraphNode? {
        nodes.first { $0.id == id }
    }

    /// Wählt einen Knoten (nil = keiner); eine Notiz klappt dabei ihre Nachbarn auf.
    public func select(_ id: String?) async {
        guard let id, node(id) != nil else {
            selected = nil
            return
        }
        selected = id
        context.toasts.signal(.selection)
        if node(id)?.kind == .note, !loaded.contains(id) { await expand(id) }
    }

    /// „Nachbarn laden“: holt den Graphen der Notiz und fügt neue Knoten und Kanten hinzu.
    public func expand(_ id: String) async {
        guard let node = node(id), node.kind == .note, let notePath = node.path, !loaded.contains(id), !expanding.contains(id) else { return }
        expanding.insert(id)
        defer { expanding.remove(id) }
        do {
            let graph = try await context.api.graph(path: notePath)
            merge(graph, near: id)
            loaded.insert(id)
        } catch {
            context.report(error, action: false)
        }
    }

    /// Fügt eine Antwort hinzu: bekannte Knoten bekommen den neueren Stand, ein Link verdrängt
    /// „ähnlich“ (wie graph.js).
    func merge(_ graph: GraphModel, near: String?) {
        var index = Dictionary(uniqueKeysWithValues: nodes.enumerated().map { ($1.id, $0) })
        // Stufen der Antwort zählen ab der aufgeklappten Notiz; im Graphen ab der Mitte.
        let base = near.flatMap { index[$0] }.map { nodes[$0].level } ?? 0
        for node in graph.nodes {
            let level = base + node.level
            if let i = index[node.id] {
                // Neuer Stand (Status, Bezeichnung), die kleinere Stufe bleibt.
                nodes[i] = GraphNode.relevel(node, min(level, nodes[i].level))
            } else {
                index[node.id] = nodes.count
                nodes.append(GraphNode.relevel(node, level))
                if let near, node.id != graph.center { addedNear[node.id] = near }
            }
        }
        var edgeIndex = Dictionary(uniqueKeysWithValues: edges.enumerated().map { ($1.id, $0) })
        for edge in graph.edges where index[edge.from] != nil && index[edge.to] != nil {
            if let i = edgeIndex[edge.id] {
                if edge.kind == .link, edges[i].kind == .semantic {
                    edges[i].kind = .link
                    edges[i].score = nil
                }
                continue
            }
            edgeIndex[edge.id] = edges.count
            edges.append(edge)
        }
        loaded.insert(graph.center)
    }

    // MARK: Sichtbarkeit

    public func isVisible(_ edge: GraphEdge) -> Bool {
        filters[edge.kind]
    }

    /// Die Mitte immer; Aufgaben und Termine nur mit ihrem Filter; sonst mit mindestens einer
    /// sichtbaren Kante.
    public func isVisible(_ id: String) -> Bool {
        if id == center { return true }
        guard let node = node(id) else { return false }
        if node.kind == .task, !filters.task { return false }
        if node.kind == .event, !filters.event { return false }
        return edges.contains { $0.connects(id) && isVisible($0) }
    }

    public var visibleNodes: [GraphNode] { nodes.filter { isVisible($0.id) } }
    public var visibleEdges: [GraphEdge] { edges.filter { isVisible($0) && isVisible($0.from) && isVisible($0.to) } }

    /// Nachbarn eines Knotens (Hervorheben beim Antippen).
    public func neighbours(of id: String) -> Set<String> {
        Set(edges.filter { $0.connects(id) }.map { $0.other(than: id) })
    }

    // MARK: Karte

    /// Kante zwischen Mitte und Knoten.
    public func edgeToCenter(_ id: String) -> GraphEdge? {
        edges.first { $0.id == GraphEdge.key(center, id) }
    }

    /// „ähnlich, 73 %“ für Notizen mit einer ähnlich-Kante zur Mitte.
    public func similarity(of id: String) -> Double? {
        guard let edge = edgeToCenter(id), edge.kind == .semantic else { return nil }
        return edge.score ?? 0
    }

    /// „Verlinken“ in der Karte: nur ähnliche Notizen und wenn der Server es anbietet.
    public func canLink(_ id: String) -> Bool {
        (model?.can.link ?? false) && similarity(of: id) != nil
    }

    /// Text der Karte unter dem Titel, wie graph.js: Pfad · „ähnlich, 73 %“, „HUN-3 · in Arbeit“,
    /// „09:00–10:00 · Privat“ (Zeit in `timeZone`).
    public func cardMeta(_ id: String, timeZone: TimeZone = .current) -> String {
        guard let node = node(id) else { return "" }
        var parts: [String] = []
        switch node.kind {
        case .note:
            if let path = node.path { parts.append(path) }
            if let score = similarity(of: id) { parts.append("ähnlich, \(Int((score * 100).rounded())) %") }
        case .task:
            parts.append([node.ref, node.statusText].compactMap { $0 }.joined(separator: " · "))
        case .event:
            if node.allDay {
                parts.append("ganztägig")
            } else if let start = node.startDate {
                let end = node.endDate.map { "–\(Self.clock($0, timeZone))" } ?? ""
                parts.append("\(Self.clock(start, timeZone))\(end)")
            }
            if let calendar = node.calendar { parts.append(calendar) }
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    static func clock(_ date: Date, _ timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let p = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", p.hour ?? 0, p.minute ?? 0)
    }

    // MARK: Verlinken

    /// Verlinkt die Notiz eines Knotens mit der Mitte (Karte): die Kante wird sofort ein Link.
    @discardableResult
    public func link(node id: String) async -> Bool {
        guard let target = node(id)?.path else { return false }
        return await link(path: target)
    }

    /// „Verlinken“ in der Liste „Ähnlich, nicht verlinkt“; hängt `- [[Ziel]]` an die Mitte an.
    @discardableResult
    public func link(path target: String) async -> Bool {
        guard model?.can.link ?? false, !linking.contains(target) else { return false }
        linking.insert(target)
        defer { linking.remove(target) }
        let centerPath = path
        guard await runner.run(NoteAction.link, ["pfad": centerPath, "ziel": target], as: NoteActionResponse.self, undo: nil) != nil else { return false }
        context.toasts.signal(.success)
        guard path == centerPath else { return true }
        let key = GraphEdge.key(center, "note:\(target)")
        if let i = edges.firstIndex(where: { $0.id == key }) {
            edges[i].kind = .link
            edges[i].score = nil
        }
        remote.model?.lists.similar.removeAll { $0.path == target }
        await refresh()
        return true
    }
}

extension GraphNode {
    /// Knoten mit anderem Abstand zur Mitte (aufgeklappte Nachbarn liegen eine Stufe weiter weg).
    static func relevel(_ node: GraphNode, _ level: Int) -> GraphNode {
        var copy = node
        copy.level = level
        return copy
    }
}
