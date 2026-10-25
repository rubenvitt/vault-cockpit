import Foundation

/// Filter von Wissen: Frage, Querverbindung (`art`), Status und „Passt zu meinem Lesen“.
public struct WissenQuery: Equatable, Hashable, Sendable {
    public var q: String
    public var art: String
    public var status: String
    public var lesen: Bool

    public init(q: String = "", art: String = "", status: String = "", lesen: Bool = false) {
        self.q = q
        self.art = art
        self.status = status
        self.lesen = lesen
    }

    /// Ohne Frage und Filter (die Seite, die das Web offline vorhält).
    public var isEmpty: Bool { q.trimmingCharacters(in: .whitespaces).isEmpty && art.isEmpty && status.isEmpty && !lesen }
}

/// Lesewege für Vault, Suche, Graph, Wissen und Zustand (`/api/notiz`, `/api/suche`,
/// `/api/graph`, `/api/wissen`, `/api/zustand`).
extension CockpitAPI {
    /// Notizseite als Baum; 404 wirft `CockpitError.failed(status: 404, code: "not_found", …)`.
    public func note(path: String) async throws -> NoteModel {
        try await get("api/notiz", query: Self.pathQuery(path))
    }

    /// Suche im Vault: die besten acht, mit `all` alle Treffer. `type` grenzt ein (z. B. `synthesis`).
    public func search(_ query: String, all: Bool = false, type: String? = nil) async throws -> SearchModel {
        try await get("api/suche", query: Self.searchQuery(query, all: all, type: type))
    }

    /// Graph einer Notiz mit den Listen der Graphseite; 404, wenn sie nicht im Index ist.
    public func graph(path: String) async throws -> GraphModel {
        try await get("api/graph", query: Self.pathQuery(path))
    }

    public func wissen(_ query: WissenQuery = WissenQuery()) async throws -> WissenModel {
        try await get("api/wissen", query: Self.wissenQuery(query))
    }

    /// Zustand der Dienste; der Server prüft Zunder und Kalender dabei frisch.
    public func health() async throws -> HealthModel {
        try await get("api/zustand")
    }

    // MARK: Query

    static func pathQuery(_ path: String) -> [URLQueryItem] {
        [URLQueryItem(name: "pfad", value: path)]
    }

    static func searchQuery(_ query: String, all: Bool, type: String?) -> [URLQueryItem] {
        var items = [URLQueryItem(name: "q", value: query)]
        if let type, !type.isEmpty { items.append(URLQueryItem(name: "type", value: type)) }
        if all { items.append(URLQueryItem(name: "alle", value: "1")) }
        return items
    }

    static func wissenQuery(_ query: WissenQuery) -> [URLQueryItem] {
        var items: [URLQueryItem] = []
        let q = query.q.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty { items.append(URLQueryItem(name: "q", value: q)) }
        if !query.art.isEmpty { items.append(URLQueryItem(name: "art", value: query.art)) }
        if !query.status.isEmpty { items.append(URLQueryItem(name: "status", value: query.status)) }
        if query.lesen { items.append(URLQueryItem(name: "lesen", value: "1")) }
        return items
    }
}

/// Die übrigen Seiten des Cockpits, die die App nativ zeigt: Notiz, Graph, Suche, Wissen,
/// Zustand, Einstellungen und Feeds. Wie `NativeRoute` und `ReadingRoute` für Links und
/// `redirect` aus Aktionen (`/notiz?pfad=…` nach dem Ablegen).
public enum PageRoute: Equatable, Hashable, Sendable {
    /// `/notiz?pfad=…`, optional mit Sprungmarke `#h-…`.
    case note(path: String, anchor: String?)
    /// `/graph?pfad=…`
    case graph(path: String)
    /// `/graph?q=…` (Suchseite), auch ohne Begriff.
    case search(String)
    /// `/wissen?q=&art=&status=&lesen=1`
    case wissen(WissenQuery)
    /// `/zustand`
    case health
    /// `/einstellungen#abschnitt` (`kalender`, `tokens`, `sicherung` …), nil = oben.
    case settings(section: String?)
    /// `/lesen/feeds`
    case feeds

    public init?(webPath: String) {
        guard webPath.hasPrefix("/"), !webPath.hasPrefix("//"), let components = URLComponents(string: webPath) else { return nil }
        self.init(path: components.path, query: components.queryItems ?? [], fragment: components.fragment)
    }

    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        self.init(path: components.path, query: components.queryItems ?? [], fragment: components.fragment)
    }

    public init?(path: String, query: [URLQueryItem], fragment: String? = nil) {
        func value(_ name: String) -> String {
            query.first { $0.name == name }?.value ?? ""
        }
        let path = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        let fragment = fragment.flatMap { $0.isEmpty ? nil : $0 }
        switch path {
        case "/notiz":
            guard !value("pfad").isEmpty else { return nil }
            self = .note(path: value("pfad"), anchor: fragment)
        case "/graph":
            self = value("pfad").isEmpty ? .search(value("q")) : .graph(path: value("pfad"))
        case "/wissen":
            self = .wissen(WissenQuery(q: value("q"), art: value("art"), status: value("status"), lesen: value("lesen") == "1"))
        case "/zustand":
            self = .health
        case "/einstellungen":
            self = .settings(section: fragment)
        case "/lesen/feeds":
            self = .feeds
        default:
            return nil
        }
    }

    /// Pfad mit Query (und Sprungmarke) wie im Web.
    public var webPath: String {
        var components = URLComponents()
        var items: [URLQueryItem] = []
        switch self {
        case .note(let path, let anchor):
            components.path = "/notiz"
            items = CockpitAPI.pathQuery(path)
            components.fragment = anchor
        case .graph(let path):
            components.path = "/graph"
            items = CockpitAPI.pathQuery(path)
        case .search(let q):
            components.path = "/graph"
            if !q.isEmpty { items = [URLQueryItem(name: "q", value: q)] }
        case .wissen(let query):
            components.path = "/wissen"
            items = CockpitAPI.wissenQuery(query)
        case .health:
            components.path = "/zustand"
        case .settings(let section):
            components.path = "/einstellungen"
            components.fragment = section
        case .feeds:
            components.path = "/lesen/feeds"
        }
        components.queryItems = items.isEmpty ? nil : items
        // Wie `encodeURIComponent` im Web: `/` im Pfad bleibt kodiert (`00-inbox%2FIdee.md`).
        components.percentEncodedQuery = items.isEmpty ? nil : items.map { "\(CockpitAPI.formEncode($0.name))=\(CockpitAPI.formEncode($0.value ?? ""))" }.joined(separator: "&")
        return components.string ?? components.path
    }
}
