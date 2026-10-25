import Foundation

// Modelle für `/api/suche`, `/api/graph`, `/api/wissen` und `/api/zustand` (src/web/http.js,
// src/web/graph-render.js `graphJson`, src/web/wissen-page.js `wissenView`, src/health).

// MARK: Suche

/// Treffer der Suche: Volltext, Bedeutung und Graph zusammengeführt.
public struct SearchModel: Decodable, Equatable, Sendable {
    public let query: String
    public let results: [SearchHit]
    /// Alle Treffer; mehr als `results`, wenn nur die besten acht kamen.
    public let total: Int
    /// „Bedeutungssuche gerade nicht verfügbar, nur Volltext“, sonst nil.
    public let degraded: String?
    /// Notizseiten verfügbar (sonst führen Treffer zum Graphen).
    public let notes: Bool

    enum CodingKeys: String, CodingKey { case query, results, total, degraded, notes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = try c.decodeIfPresent(String.self, forKey: .query) ?? ""
        results = try c.decodeIfPresent([SearchHit].self, forKey: .results) ?? []
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? results.count
        degraded = try c.decodeIfPresent(String.self, forKey: .degraded)
        notes = try c.decodeIfPresent(Bool.self, forKey: .notes) ?? true
    }

    /// Es gibt mehr Treffer als gezeigt („Alle N Treffer zeigen“).
    public var hasMore: Bool { total > results.count }
}

public struct SearchHit: Decodable, Equatable, Identifiable, Sendable {
    public let path: String
    public let title: String
    public let snippet: String?
    /// `text`, `semantic`, `graph`.
    public let streams: [String]

    public var id: String { path }

    /// „Volltext“, „Bedeutung“, „Graph“.
    public var streamLabels: [String] {
        streams.map { SearchHit.streamLabel($0) }
    }

    public static func streamLabel(_ stream: String) -> String {
        switch stream {
        case "text": "Volltext"
        case "semantic": "Bedeutung"
        case "graph": "Graph"
        default: stream
        }
    }
}

// MARK: Graph

public enum GraphNodeKind: String, Decodable, Equatable, Hashable, Sendable {
    case note, task, event
}

/// Art einer Kante; zugleich die Filter der Legende.
public enum GraphEdgeKind: String, Decodable, Equatable, Hashable, Sendable, CaseIterable {
    case link, semantic, task, event

    /// Beschriftung in der Legende.
    public var label: String {
        switch self {
        case .link: "Link"
        case .semantic: "ähnlich, nicht verlinkt"
        case .task: "Aufgabe"
        case .event: "Termin"
        }
    }
}

/// Knoten: Notiz, Zunder-Aufgabe oder Termin. `level`: Abstand zur Mitte (0 = Mitte).
public struct GraphNode: Decodable, Equatable, Identifiable, Sendable {
    /// `note:<pfad>`, `task:<id>`, `event:<n>`.
    public let id: String
    public let kind: GraphNodeKind
    public internal(set) var level: Int
    public let label: String
    // Notiz
    public let path: String?
    public let type: String?
    public let sensitivity: String?
    // Aufgabe
    public let taskId: String?
    public let url: String?
    public let status: TaskStatus?
    public let ref: String?
    // Termin
    public let start: String?
    public let end: String?
    public let allDay: Bool
    public let calendar: String?

    enum CodingKeys: String, CodingKey { case id, kind, level, label, path, type, sensitivity, taskId, url, status, ref, start, end, allDay, calendar }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(GraphNodeKind.self, forKey: .kind)
        level = try c.decodeIfPresent(Int.self, forKey: .level) ?? 1
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? id
        path = try c.decodeIfPresent(String.self, forKey: .path)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        sensitivity = try c.decodeIfPresent(String.self, forKey: .sensitivity)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        status = try c.decodeIfPresent(TaskStatus.self, forKey: .status)
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        start = try c.decodeIfPresent(String.self, forKey: .start)
        end = try c.decodeIfPresent(String.self, forKey: .end)
        allDay = try c.decodeIfPresent(Bool.self, forKey: .allDay) ?? false
        calendar = try c.decodeIfPresent(String.self, forKey: .calendar)
    }

    public var link: URL? { url.flatMap(URL.init(string:)) }
    public var startDate: Date? { start.flatMap(CockpitFormat.date(from:)) }
    public var endDate: Date? { end.flatMap(CockpitFormat.date(from:)) }

    /// Status einer Aufgabe in der Karte: „erledigt“, „in Arbeit“ … (wie graph.js).
    public var statusText: String? {
        guard kind == .task else { return nil }
        return GraphNode.statusText(status)
    }

    static func statusText(_ status: TaskStatus?) -> String {
        switch status {
        case .done?: "erledigt"
        case .inProgress?: "in Arbeit"
        case .blocked?: "blockiert"
        case .review?: "in Review"
        case .dropped?: "verworfen"
        default: "offen"
        }
    }
}

/// Kante zwischen zwei Knoten; `score` nur bei `semantic`.
public struct GraphEdge: Decodable, Equatable, Identifiable, Sendable {
    public let from: String
    public let to: String
    public var kind: GraphEdgeKind
    public var score: Double?

    public init(from: String, to: String, kind: GraphEdgeKind, score: Double? = nil) {
        self.from = from
        self.to = to
        self.kind = kind
        self.score = score
    }

    /// Ungerichtet: `a|b` mit sortierten Enden (wie graph.js).
    public var id: String { GraphEdge.key(from, to) }

    public static func key(_ a: String, _ b: String) -> String {
        a < b ? "\(a)|\(b)" : "\(b)|\(a)"
    }

    public func connects(_ node: String) -> Bool { from == node || to == node }
    public func other(than node: String) -> String { from == node ? to : from }
}

/// Notiz in den Listen unter dem Graphen.
public struct GraphNoteRef: Decodable, Equatable, Identifiable, Sendable {
    public let path: String
    public let label: String
    public let type: String?
    /// Nur „Ähnlich, nicht verlinkt“.
    public let score: Double?

    public var id: String { path }
}

public struct GraphTaskRef: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let url: String?
    public let status: TaskStatus
    public let ref: String?
    /// Name der Notiz, aus der die Aufgabe kommt; nil = aus der Mitte.
    public let from: String?

    enum CodingKeys: String, CodingKey { case id, label, url, status, ref, from }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? id
        url = try c.decodeIfPresent(String.self, forKey: .url)
        status = try c.decodeIfPresent(TaskStatus.self, forKey: .status) ?? .open
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        from = try c.decodeIfPresent(String.self, forKey: .from)
    }

    public var link: URL? { url.flatMap(URL.init(string:)) }
    /// ✓ ◐ ⏸ ◑ ✕ ○
    public var mark: String { status == .dropped ? "✕" : status.mark }
}

public struct GraphEventRef: Decodable, Equatable, Sendable {
    public let label: String
    public let start: String
    public let end: String?
    public let allDay: Bool
    public let calendar: String?

    public var startDate: Date? { CockpitFormat.date(from: start) }
    public var endDate: Date? { end.flatMap(CockpitFormat.date(from:)) }
}

/// Listen unter dem Graphen.
public struct GraphLists: Decodable, Equatable, Sendable {
    /// „Verlinkt von hier“
    public let outgoing: [GraphNoteRef]
    /// „Verweist hierher“
    public let incoming: [GraphNoteRef]
    /// „Ähnlich, nicht verlinkt“ (mit Verlinken)
    public var similar: [GraphNoteRef]
    public let tasks: [GraphTaskRef]
    /// Nur bei Tagesnotizen, nach Beginn sortiert.
    public let events: [GraphEventRef]

    enum CodingKeys: String, CodingKey { case outgoing, incoming, similar, tasks, events }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        outgoing = try c.decodeIfPresent([GraphNoteRef].self, forKey: .outgoing) ?? []
        incoming = try c.decodeIfPresent([GraphNoteRef].self, forKey: .incoming) ?? []
        similar = try c.decodeIfPresent([GraphNoteRef].self, forKey: .similar) ?? []
        tasks = try c.decodeIfPresent([GraphTaskRef].self, forKey: .tasks) ?? []
        events = try c.decodeIfPresent([GraphEventRef].self, forKey: .events) ?? []
    }

    public init() {
        outgoing = []
        incoming = []
        similar = []
        tasks = []
        events = []
    }
}

public struct GraphCapabilities: Decodable, Equatable, Sendable {
    /// „Verlinken“ anbieten.
    public let link: Bool
    /// Notizseiten verfügbar („Notiz ansehen“).
    public let notes: Bool
}

/// Antwort von `/api/graph`: Nachbarschaft einer Notiz (Tiefe 1) mit den Listen der Graphseite.
public struct GraphModel: Decodable, Equatable, Sendable {
    /// Id der Mitte (`note:<pfad>`).
    public let center: String
    public let nodes: [GraphNode]
    public let edges: [GraphEdge]
    /// Hinweise wie „Embeddings aus“ oder Zunder-Fehler.
    public let problems: [String]
    public let path: String
    public let label: String
    public let obsidian: String?
    public var lists: GraphLists
    public let can: GraphCapabilities

    enum CodingKeys: String, CodingKey { case center, nodes, edges, problems, path, label, obsidian, lists, can }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let center = try c.decode(String.self, forKey: .center)
        let nodes = try c.decodeIfPresent([GraphNode].self, forKey: .nodes) ?? []
        self.center = center
        self.nodes = nodes
        edges = try c.decodeIfPresent([GraphEdge].self, forKey: .edges) ?? []
        problems = try c.decodeIfPresent([String].self, forKey: .problems) ?? []
        let centerPath = center.hasPrefix("note:") ? String(center.dropFirst(5)) : center
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? centerPath
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? nodes.first { $0.id == center }?.label ?? centerPath
        obsidian = try c.decodeIfPresent(String.self, forKey: .obsidian)
        lists = try c.decodeIfPresent(GraphLists.self, forKey: .lists) ?? GraphLists()
        can = try c.decodeIfPresent(GraphCapabilities.self, forKey: .can) ?? GraphCapabilities(link: false, notes: false)
    }

    public var obsidianURL: URL? { obsidian.flatMap(URL.init(string:)) }
}

// MARK: Wissen

/// Synthese in Wissen.
public struct WissenItem: Decodable, Equatable, Identifiable, Sendable {
    public let path: String
    public let title: String
    /// Querverbindung.
    public let art: String?
    public let status: String?
    /// Vertrauen.
    public let confidence: String?
    /// Zusammenfassung als Markdown-Text (Wikilinks roh).
    public let summary: String?
    /// `JJJJ-MM-TT`
    public let updated: String?

    public var id: String { path }
}

public struct WissenModel: Decodable, Equatable, Sendable {
    public let q: String
    public let art: String
    public let status: String
    public let lesen: Bool
    /// „Passt zu meinem Lesen“ verfügbar (Belege aus dem Lesestapel).
    public let reading: Bool
    /// Werte für die Auswahl „Querverbindung“ und „Status“.
    public let arts: [String]
    public let statuses: [String]
    /// „Treffer“, nil ohne Frage.
    public let hits: [WissenItem]?
    /// „Zuletzt bewegt“ (die 20 neuesten).
    public let recent: [WissenItem]
    public let degraded: String?
    /// Anzahl der Synthesen.
    public let total: Int

    enum CodingKeys: String, CodingKey { case q, art, status, lesen, reading, arts, statuses, hits, recent, degraded, total }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        q = try c.decodeIfPresent(String.self, forKey: .q) ?? ""
        art = try c.decodeIfPresent(String.self, forKey: .art) ?? ""
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        lesen = try c.decodeIfPresent(Bool.self, forKey: .lesen) ?? false
        reading = try c.decodeIfPresent(Bool.self, forKey: .reading) ?? false
        arts = try c.decodeIfPresent([String].self, forKey: .arts) ?? []
        statuses = try c.decodeIfPresent([String].self, forKey: .statuses) ?? []
        hits = try c.decodeIfPresent([WissenItem].self, forKey: .hits)
        recent = try c.decodeIfPresent([WissenItem].self, forKey: .recent) ?? []
        degraded = try c.decodeIfPresent(String.self, forKey: .degraded)
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
    }

    public var query: WissenQuery { WissenQuery(q: q, art: art, status: status, lesen: lesen) }
}

// MARK: Zustand

/// Dienst, der gerade nicht läuft (`failing` in `/api/zustand`, `alert` in `/api/woche`).
public struct ServiceAlert: Decodable, Equatable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public enum HealthState: String, Decodable, Equatable, Sendable {
    case ok, error, off, unknown

    public init(from decoder: Decoder) throws {
        self = HealthState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }

    /// Pille: „läuft“, „Fehler“, „aus“, „unbekannt“.
    public var label: String {
        switch self {
        case .ok: "läuft"
        case .error: "Fehler"
        case .off: "aus"
        case .unknown: "unbekannt"
        }
    }
}

/// Angabe in der Karte eines Dienstes: ein Wert oder ein Zeitpunkt (ISO 8601).
public struct HealthFact: Decodable, Equatable, Sendable {
    public let label: String
    public let value: String?
    public let at: String?

    enum CodingKeys: String, CodingKey { case label, value, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        at = try c.decodeIfPresent(String.self, forKey: .at)
        if let text = try? c.decodeIfPresent(String.self, forKey: .value) { value = text }
        else if let number = try? c.decodeIfPresent(Int.self, forKey: .value) { value = String(number) }
        else if let number = try? c.decodeIfPresent(Double.self, forKey: .value) { value = String(number) }
        else if let flag = try? c.decodeIfPresent(Bool.self, forKey: .value) { value = flag ? "ja" : "nein" }
        else { value = nil }
    }

    public var date: Date? { at.flatMap(CockpitFormat.date(from:)) }
}

/// Dienst auf der Seite Zustand; `items` je Kalender bzw. Teil der Brücke.
public struct HealthService: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let state: HealthState
    public let summary: String?
    public let lastOkAt: String?
    public let lastErrorAt: String?
    public let lastError: String?
    public let facts: [HealthFact]
    public let items: [HealthService]

    enum CodingKeys: String, CodingKey { case id, name, state, summary, lastOkAt, lastErrorAt, lastError, facts, items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        state = try c.decodeIfPresent(HealthState.self, forKey: .state) ?? .unknown
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        lastOkAt = try c.decodeIfPresent(String.self, forKey: .lastOkAt)
        lastErrorAt = try c.decodeIfPresent(String.self, forKey: .lastErrorAt)
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        facts = try c.decodeIfPresent([HealthFact].self, forKey: .facts) ?? []
        items = try c.decodeIfPresent([HealthService].self, forKey: .items) ?? []
    }

    public var lastOkDate: Date? { lastOkAt.flatMap(CockpitFormat.date(from:)) }
    public var lastErrorDate: Date? { lastErrorAt.flatMap(CockpitFormat.date(from:)) }
    /// Der Fehler ist aktuell (rot), nicht nur der letzte vor einem Erfolg (grau).
    public var errorIsCurrent: Bool { state == .error }
}

/// Antwort von `/api/zustand`.
public struct HealthModel: Decodable, Equatable, Sendable {
    public let checkedAt: String
    public let failing: [ServiceAlert]
    public let services: [HealthService]

    enum CodingKeys: String, CodingKey { case checkedAt, failing, services }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        checkedAt = try c.decodeIfPresent(String.self, forKey: .checkedAt) ?? ""
        failing = try c.decodeIfPresent([ServiceAlert].self, forKey: .failing) ?? []
        services = try c.decodeIfPresent([HealthService].self, forKey: .services) ?? []
    }

    public var checkedDate: Date? { CockpitFormat.date(from: checkedAt) }

    /// Übersichtszeile wie auf der Seite: „Alle eingerichteten Dienste laufen.“ oder
    /// „Ein Dienst meldet einen Fehler: Kalender“ (die Namen verweisen dort auf die Karten).
    public var overview: String {
        guard !failing.isEmpty else { return "Alle eingerichteten Dienste laufen." }
        let who = failing.count == 1 ? "Ein Dienst meldet" : "\(failing.count) Dienste melden"
        return "\(who) einen Fehler: \(failing.map(\.name).joined(separator: ", "))"
    }

    /// Zeitpunkt wie auf der Seite: „18.10. 14:32 · vor 5 min“ („gerade eben“, „vor 3 h“,
    /// „vor 4 Tagen“); „–“ ohne Zeitpunkt.
    public static func when(_ iso: String?, now: Date, timeZone: TimeZone) -> String {
        guard let iso, let date = CockpitFormat.date(from: iso) else { return "–" }
        let minutes = Int((now.timeIntervalSince(date) / 60).rounded())
        let ago: String
        if minutes < 1 { ago = "gerade eben" }
        else if minutes < 60 { ago = "vor \(minutes) min" }
        else if minutes < 48 * 60 { ago = "vor \(Int((Double(minutes) / 60).rounded())) h" }
        else { ago = "vor \(Int((Double(minutes) / 1440).rounded())) Tagen" }
        return "\(stamp(date, timeZone: timeZone)) · \(ago)"
    }

    /// „18.10. 14:32“
    public static func stamp(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let p = calendar.dateComponents([.day, .month, .hour, .minute], from: date)
        func pad(_ n: Int?) -> String { n.map { $0 < 10 ? "0\($0)" : "\($0)" } ?? "00" }
        return "\(pad(p.day)).\(pad(p.month)). \(pad(p.hour)):\(pad(p.minute))"
    }
}
