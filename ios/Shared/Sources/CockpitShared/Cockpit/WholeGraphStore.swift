import Foundation
import Observation

/// Antwort von `/api/graph/alles` (VCP-40): alle eigenen, nicht vertraulichen Notizen mit ihren
/// Wikilinks und den Lagen, die der Server mit ForceAtlas2 vorberechnet hat. Knapp, weil sie aufs
/// iPhone geht: Knoten als `[pfad, titel, ordner, typ, x, y]` mit Indizes in `folders` und
/// `types` (`-1` ohne Typ), Links flach als Knotenindizes `[a, b, a, b, …]`.
public struct WholeGraphModel: Decodable, Equatable, Sendable {
    public struct Node: Decodable, Equatable, Sendable {
        public let path: String
        public let label: String
        /// Index in `folders` (oberster Ordner, „“ = oberste Ebene).
        public let folder: Int
        /// Index in `types`, -1 ohne Typ.
        public let type: Int
        public let x: Double
        public let y: Double

        public init(path: String, label: String, folder: Int, type: Int, x: Double, y: Double) {
            self.path = path
            self.label = label
            self.folder = folder
            self.type = type
            self.x = x
            self.y = y
        }

        public init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            path = try c.decode(String.self)
            label = try c.decode(String.self)
            folder = try c.decode(Int.self)
            type = try c.decode(Int.self)
            x = try c.decode(Double.self)
            y = try c.decode(Double.self)
        }
    }

    /// Stand des Layouts (wechselt mit Notizen, Links und Titeln).
    public let version: String?
    public let builtAt: String?
    public let folders: [String]
    public let types: [String]
    public let nodes: [Node]
    public let links: [Int]

    enum CodingKeys: String, CodingKey { case version, builtAt, folders, types, nodes, links }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        builtAt = try c.decodeIfPresent(String.self, forKey: .builtAt)
        folders = try c.decodeIfPresent([String].self, forKey: .folders) ?? []
        types = try c.decodeIfPresent([String].self, forKey: .types) ?? []
        nodes = try c.decodeIfPresent([Node].self, forKey: .nodes) ?? []
        links = try c.decodeIfPresent([Int].self, forKey: .links) ?? []
    }
}

/// Ausdehnung der Lagen (Einpassen der Ansicht).
public struct WholeGraphBounds: Equatable, Sendable {
    public var minX = 0.0
    public var minY = 0.0
    public var maxX = 0.0
    public var maxY = 0.0

    public init(minX: Double = 0, minY: Double = 0, maxX: Double = 0, maxY: Double = 0) {
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }

    public var width: Double { maxX - minX }
    public var height: Double { maxY - minY }
    public var midX: Double { (minX + maxX) / 2 }
    public var midY: Double { (minY + maxY) / 2 }
}

/// Färbung des ganzen Graphen: nach oberstem Ordner oder nach Notiztyp.
public enum WholeGraphColoring: String, CaseIterable, Sendable {
    case folder
    case type

    public var label: String {
        switch self {
        case .folder: "Ordner"
        case .type: "Typ"
        }
    }
}

/// Gruppe der Legende: Ordner bzw. Typ mit Zahl der Notizen. `color` ist der Platz in der
/// Palette (die ersten zehn nach Größe), nil = grau („ohne Typ“, „Sonstige“).
public struct WholeGraphGroup: Identifiable, Equatable, Sendable {
    public let id: Int
    public let label: String
    public let count: Int
    public let color: Int?
}

/// Ganzer Vault als Graph (`/graph/alles` im Web): lädt Knoten und fertige Lagen, färbt nach
/// Ordner oder Typ, hebt eine Gruppe der Legende, die Nachbarschaft der Auswahl oder die Treffer
/// der Suche im Graphen hervor. Das Zeichnen macht die Oberfläche; Knoten sind hier Indizes in
/// `model.nodes`.
@MainActor
@Observable
public final class WholeGraphStore {
    /// So viele Farben hat die Palette; weitere Gruppen werden „Sonstige“.
    public static let paletteSize = 10
    /// Ab so vielen Zeichen sucht die Suche im Graphen.
    public static let minQuery = 2

    /// Notiz, die nach dem Laden gewählt wird (`/graph/alles?pfad=…`).
    public let focus: String?
    public var coloring: WholeGraphColoring = .folder {
        didSet {
            guard coloring != oldValue else { return }
            computeGroups()
        }
    }
    /// Hervorgehobene Gruppe der Legende (Index in `groups`), nil = keine.
    public var picked: Int?
    /// Gewählter Knoten (Karte), nil = keiner.
    public private(set) var selected: Int?
    /// Suche im Graphen nach Titel und Pfad; Treffer treten hervor.
    public var query = "" {
        didSet {
            guard query != oldValue else { return }
            runQuery()
        }
    }
    /// Treffer der Suche, die besten zuerst; nil unter zwei Zeichen.
    public private(set) var found: [Int]?
    public private(set) var groups: [WholeGraphGroup] = []
    /// Knoten → Index in `groups`.
    public private(set) var groupOf: [Int] = []
    /// Kanten ohne Doppelte und Schleifen, je Paar einmal.
    public private(set) var edges: [(Int, Int)] = []
    public private(set) var degree: [Int] = []
    /// Ausdehnung der Lagen (Einpassen).
    public private(set) var bounds = WholeGraphBounds()

    @ObservationIgnored private var neighbors: [Set<Int>] = []
    @ObservationIgnored private var foundSet: Set<Int>?
    @ObservationIgnored private var keys: [(label: String, path: String)] = []
    @ObservationIgnored private var built: String?
    private let remote: RemoteModel<WholeGraphModel>
    private let context: CockpitContext

    public init(context: CockpitContext, focus: String? = nil) {
        self.context = context
        self.focus = focus.flatMap { $0.isEmpty ? nil : $0 }
        remote = RemoteModel(context: context, path: "api/graph/alles")
    }

    public var model: WholeGraphModel? { remote.model }
    public var state: LoadState { remote.state }
    public var nodes: [WholeGraphModel.Node] { model?.nodes ?? [] }

    // MARK: Laden

    /// Gespeicherter Stand zuerst, dann vom Server; die Fokus-Notiz wird gewählt.
    public func load() async {
        remote.select(key: Self.cacheKey, query: []) { _ in true }
        rebuild()
        selectFocus()
        await refresh()
        selectFocus()
    }

    /// Lädt neu; ein anderer Stand ersetzt Knoten und Kanten, Auswahl per Pfad bleibt.
    public func refresh() async {
        let path = selected.map { nodes[$0].path }
        await remote.refresh()
        guard rebuild() else { return }
        selected = path.flatMap(index(of:))
    }

    static let cacheKey = "graph/alles"

    /// Berechnet Kanten, Grade und Gruppen neu, wenn sich der Stand geändert hat.
    @discardableResult
    private func rebuild() -> Bool {
        guard let model else { return false }
        let stamp = model.version ?? "\(model.nodes.count)/\(model.links.count)"
        guard stamp != built else { return false }
        built = stamp
        let count = model.nodes.count
        var degree = [Int](repeating: 0, count: count)
        var neighbors = [Set<Int>](repeating: [], count: count)
        var edges: [(Int, Int)] = []
        var k = 0
        while k + 1 < model.links.count {
            let a = model.links[k]
            let b = model.links[k + 1]
            k += 2
            guard a != b, a >= 0, b >= 0, a < count, b < count, !neighbors[a].contains(b) else { continue }
            neighbors[a].insert(b)
            neighbors[b].insert(a)
            degree[a] += 1
            degree[b] += 1
            edges.append((a, b))
        }
        self.degree = degree
        self.neighbors = neighbors
        self.edges = edges
        keys = model.nodes.map { (Self.fold($0.label), Self.fold($0.path)) }
        if let first = model.nodes.first {
            var b = WholeGraphBounds(minX: first.x, minY: first.y, maxX: first.x, maxY: first.y)
            for node in model.nodes {
                b.minX = min(b.minX, node.x)
                b.maxX = max(b.maxX, node.x)
                b.minY = min(b.minY, node.y)
                b.maxY = max(b.maxY, node.y)
            }
            bounds = b
        } else {
            bounds = WholeGraphBounds()
        }
        selected = nil
        computeGroups()
        runQuery()
        return true
    }

    private func selectFocus() {
        guard selected == nil, let focus, let i = index(of: focus) else { return }
        selected = i
    }

    public func index(of path: String) -> Int? {
        nodes.firstIndex { $0.path == path }
    }

    // MARK: Gruppen

    /// Gruppen der Färbung nach Größe; die ersten zehn bekommen eine Farbe, „ohne Typ“ und der
    /// Rest („Sonstige“) sind grau. Ordner „“ heißt „Oberste Ebene“.
    private func computeGroups() {
        picked = nil
        guard let model else {
            groups = []
            groupOf = []
            return
        }
        let keyOf: (WholeGraphModel.Node) -> Int = coloring == .folder ? { $0.folder } : { $0.type }
        let names = coloring == .folder ? model.folders : model.types
        var counts: [Int: Int] = [:]
        for node in model.nodes { counts[keyOf(node), default: 0] += 1 }
        // Nach Größe, bei Gleichstand nach Index (stabil).
        let sorted = counts.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }
        var groups: [WholeGraphGroup] = []
        var slot: [Int: Int] = [:]
        var rest = 0
        for (key, count) in sorted where key != -1 {
            if groups.count < Self.paletteSize {
                let name = key < names.count ? names[key] : ""
                slot[key] = groups.count
                groups.append(WholeGraphGroup(id: groups.count, label: name.isEmpty ? "Oberste Ebene" : name, count: count, color: groups.count))
            } else {
                rest += count
            }
        }
        var untyped: Int?
        if let count = counts[-1] {
            untyped = groups.count
            groups.append(WholeGraphGroup(id: groups.count, label: "ohne Typ", count: count, color: nil))
        }
        var others: Int?
        if rest > 0 {
            others = groups.count
            groups.append(WholeGraphGroup(id: groups.count, label: "Sonstige", count: rest, color: nil))
        }
        self.groups = groups
        groupOf = model.nodes.map { node in
            let key = keyOf(node)
            if key == -1 { return untyped ?? 0 }
            return slot[key] ?? others ?? 0
        }
    }

    /// Gruppe der Legende an- oder abwählen.
    public func pick(_ group: Int?) {
        picked = picked == group ? nil : group
    }

    // MARK: Auswahl und Hervorhebung

    /// Wählt einen Knoten (nil = keiner).
    public func select(_ index: Int?) {
        guard let index, nodes.indices.contains(index) else {
            selected = nil
            return
        }
        selected = index
        context.toasts.signal(.selection)
    }

    public func neighbors(of index: Int) -> Set<Int> {
        neighbors.indices.contains(index) ? neighbors[index] : []
    }

    /// Was gerade hervortritt, wie im Web: Auswahl mit Nachbarn, sonst Treffer der Suche, sonst die
    /// Gruppe der Legende; nil = nichts hervorgehoben (alles normal).
    public func emphasis(_ index: Int) -> Bool? {
        if let selected { return index == selected || neighbors[selected].contains(index) }
        if let foundSet { return foundSet.contains(index) }
        if let picked { return groupOf.indices.contains(index) && groupOf[index] == picked }
        return nil
    }

    /// Ob überhaupt etwas hervorgehoben ist (sonst zeichnet die Oberfläche alles normal).
    public var hasEmphasis: Bool { selected != nil || foundSet != nil || picked != nil }

    /// Zweite Zeile der Karte: „wiki/Hund.md · 3 Links“.
    public func cardMeta(_ index: Int) -> String {
        let links = degree.indices.contains(index) ? degree[index] : 0
        return CockpitFormat.meta([nodes[index].path, links == 1 ? "1 Link" : "\(links) Links"])
    }

    /// Gruppe eines Knotens in der aktuellen Färbung.
    public func group(of index: Int) -> WholeGraphGroup? {
        guard groupOf.indices.contains(index), groups.indices.contains(groupOf[index]) else { return nil }
        return groups[groupOf[index]]
    }

    /// „1.234 Notizen · 5.678 Links · Stand Do 29.10. 09:00“.
    public func stats(timeZone: TimeZone = .current) -> String {
        guard model != nil else { return "" }
        let when = model?.builtAt.flatMap(CockpitFormat.date(from:)).map { "Stand \(CockpitFormat.savedAt($0, timeZone: timeZone))" }
        return CockpitFormat.meta([Self.count(nodes.count, "Notiz", "Notizen"), Self.count(edges.count, "Link", "Links"), when])
    }

    nonisolated static func count(_ n: Int, _ one: String, _ many: String) -> String {
        n == 1 ? "1 \(one)" : "\(grouped(n)) \(many)"
    }

    /// Tausender mit Punkt wie `toLocaleString('de-DE')`.
    nonisolated static func grouped(_ n: Int) -> String {
        let digits = String(n)
        var out = ""
        for (i, ch) in digits.enumerated() {
            if i > 0, (digits.count - i) % 3 == 0 { out.append(".") }
            out.append(ch)
        }
        return out
    }

    // MARK: Suche im Graphen

    /// Titel zuerst (Anfang vor Mitte), dann alle Wörter in Titel oder Pfad; Knoten mit mehr Links
    /// vorn. Wie die Suche auf `/graph/alles` im Web.
    private func runQuery() {
        let q = Self.fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard q.count >= Self.minQuery else {
            found = nil
            foundSet = nil
            return
        }
        let words = q.split(whereSeparator: \.isWhitespace).map(String.init)
        var scored: [(score: Int, degree: Int, index: Int)] = []
        for (i, key) in keys.enumerated() {
            let score: Int
            if key.label.hasPrefix(q) {
                score = 0
            } else if key.label.contains(q) {
                score = 1
            } else if words.allSatisfy({ key.label.contains($0) || key.path.contains($0) }) {
                score = 2
            } else {
                continue
            }
            scored.append((score, degree.indices.contains(i) ? degree[i] : 0, i))
        }
        scored.sort { $0.score != $1.score ? $0.score < $1.score : $0.degree != $1.degree ? $0.degree > $1.degree : $0.index < $1.index }
        found = scored.map(\.index)
        foundSet = Set(scored.map(\.index))
    }

    /// Treffer gewählt: Suche zu, Knoten gewählt.
    public func jump(to index: Int) {
        query = ""
        select(index)
    }

    /// Klein, ohne Akzente: „Übung“ findet „ubung“.
    public nonisolated static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "de_DE"))
    }
}
