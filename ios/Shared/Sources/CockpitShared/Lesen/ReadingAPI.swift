import Foundation

/// Auswahl des Stapels: Zeitfenster (5, 15, 30, 60 Min.), Sortierung ohne Zeitfenster
/// (`passt`, `neu`, `kurz`) und Gruppe (ID oder `ohne`).
public struct StackQuery: Equatable, Hashable, Sendable {
    public var zeit: Int?
    public var sort: String?
    public var group: String?

    public init(zeit: Int? = nil, sort: String? = nil, group: String? = nil) {
        self.zeit = zeit
        self.sort = sort
        self.group = group
    }
}

/// Filter von Markiert: Quelle (Seite) und Thema.
public struct HighlightQuery: Equatable, Hashable, Sendable {
    public var site: String?
    public var topic: String?

    public init(site: String? = nil, topic: String? = nil) {
        self.site = site
        self.topic = topic
    }
}

/// Lesewege des Bereichs Lesen (`/api/lesen/…`, src/lesen/json.js). Schreiben geht über die
/// Aktionen unter `/aktion/lesen/…` (`action(_:fields:as:)` mit `ReadingActionResponse`).
extension CockpitAPI {
    /// Eingang: oberste Karte, Zähler, Gruppen; `group` = Gruppen-ID oder `ohne`.
    public func readingInbox(group: String? = nil) async throws -> ReadingInboxModel {
        try await get("api/lesen/eingang", query: Self.groupQuery(group))
    }

    public func readingStack(_ query: StackQuery = StackQuery()) async throws -> ReadingStackModel {
        try await get("api/lesen/stapel", query: Self.stackQuery(query))
    }

    /// Leseansicht; 404 wirft `CockpitError.failed(status: 404, code: "not_found", …)`.
    public func readingDoc(id: String) async throws -> ReadingDocModel {
        try await get("api/lesen/doc", query: Self.docQuery(id))
    }

    public func readingHighlights(_ query: HighlightQuery = HighlightQuery()) async throws -> HighlightListModel {
        try await get("api/lesen/markiert", query: Self.highlightQuery(query))
    }

    /// Wiedersehen; `week` wie `2026-W43`, nil = laufende Woche.
    public func reviewCards(week: String? = nil) async throws -> ReviewCardsModel {
        try await get("api/lesen/wiedersehen", query: Self.weekQuery(week))
    }

    /// Markdown der Woche (`Als Markdown exportieren`).
    public func reviewMarkdown(week: String) async throws -> String {
        let data = try await data("api/lesen/wiedersehen.md", query: Self.weekQuery(week))
        return String(decoding: data, as: UTF8.self)
    }

    public func episodes() async throws -> EpisodeListModel {
        try await get("api/lesen/folgen")
    }

    /// Vorschau für „Neue Folge“; `zeit` nil = 30 Min.
    public func newEpisode(zeit: Int? = nil) async throws -> NewEpisodeModel {
        try await get("api/lesen/folgen/neu", query: Self.zeitQuery(zeit))
    }

    /// Querverbindungen zu einer Markierung.
    public func connections(highlightID: String) async throws -> ConnectionsModel {
        try await get("api/lesen/verbindungen", query: [URLQueryItem(name: "markierung", value: highlightID)])
    }

    /// Querverbindungen zu einer Auswahl, die noch keine Markierung ist.
    public func connections(docID: String, text: String) async throws -> ConnectionsModel {
        try await get("api/lesen/verbindungen", query: [URLQueryItem(name: "doc", value: docID), URLQueryItem(name: "text", value: text)])
    }

    // MARK: Query

    static func groupQuery(_ group: String?) -> [URLQueryItem] {
        guard let group, !group.isEmpty else { return [] }
        return [URLQueryItem(name: "gruppe", value: group)]
    }

    static func stackQuery(_ query: StackQuery) -> [URLQueryItem] {
        var items: [URLQueryItem] = []
        if let zeit = query.zeit { items.append(URLQueryItem(name: "zeit", value: String(zeit))) }
        if let sort = query.sort, !sort.isEmpty { items.append(URLQueryItem(name: "sort", value: sort)) }
        return items + groupQuery(query.group)
    }

    static func docQuery(_ id: String) -> [URLQueryItem] {
        [URLQueryItem(name: "id", value: id)]
    }

    static func highlightQuery(_ query: HighlightQuery) -> [URLQueryItem] {
        var items: [URLQueryItem] = []
        if let site = query.site, !site.isEmpty { items.append(URLQueryItem(name: "quelle", value: site)) }
        if let topic = query.topic, !topic.isEmpty { items.append(URLQueryItem(name: "thema", value: topic)) }
        return items
    }

    static func zeitQuery(_ zeit: Int?) -> [URLQueryItem] {
        zeit.map { [URLQueryItem(name: "zeit", value: String($0))] } ?? []
    }
}

/// Seiten des Lesens im Reiter „Lesen“. Wie `NativeRoute` für Links (aus Notizen, Wissen, Feeds)
/// und `redirect` aus Aktionen (`/lesen/doc?id=…` nach „Jetzt lesen“).
public enum ReadingRoute: Equatable, Hashable, Sendable {
    /// `/lesen`, `/lesen/eingang?gruppe=`
    case inbox(group: String?)
    /// `/lesen/stapel?zeit=&sort=&gruppe=`
    case stack(StackQuery)
    /// `/lesen/doc?id=…`, mit `#h-<id>` (Markierung) oder `#weiter` (Lesestelle).
    case reader(id: String, highlight: String?, resume: Bool)
    /// `/lesen/markiert?quelle=&thema=`
    case highlights(HighlightQuery)
    /// `/lesen/wiedersehen?woche=`
    case review(week: String?)
    /// `/lesen/folgen`
    case episodes
    /// `/lesen/folgen/neu?zeit=`
    case newEpisode(zeit: Int?)
    /// `/lesen/hinzufuegen`
    case add
    /// `/lesen/hoeren?zeit=` (nativer Player „Unterwegs hören“).
    case listen(zeit: Int?)

    public init?(webPath: String) {
        guard webPath.hasPrefix("/"), !webPath.hasPrefix("//"), let components = URLComponents(string: webPath) else { return nil }
        self.init(path: components.path, query: components.queryItems ?? [], fragment: components.fragment)
    }

    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        self.init(path: components.path, query: components.queryItems ?? [], fragment: components.fragment)
    }

    public init?(path: String, query: [URLQueryItem], fragment: String? = nil) {
        func value(_ name: String) -> String? {
            guard let v = query.first(where: { $0.name == name })?.value, !v.isEmpty else { return nil }
            return v
        }
        let path = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        switch path {
        case "/lesen", "/lesen/eingang":
            self = .inbox(group: value("gruppe"))
        case "/lesen/stapel":
            self = .stack(StackQuery(zeit: value("zeit").flatMap { Int($0) }, sort: value("sort"), group: value("gruppe")))
        case "/lesen/doc":
            guard let id = value("id") else { return nil }
            let highlight = fragment.flatMap { $0.hasPrefix("h-") ? String($0.dropFirst(2)) : nil }
            self = .reader(id: id, highlight: highlight, resume: fragment == "weiter")
        case "/lesen/markiert":
            self = .highlights(HighlightQuery(site: value("quelle"), topic: value("thema")))
        case "/lesen/wiedersehen":
            self = .review(week: value("woche"))
        case "/lesen/folgen":
            self = .episodes
        case "/lesen/folgen/neu":
            self = .newEpisode(zeit: value("zeit").flatMap { Int($0) })
        case "/lesen/hinzufuegen":
            self = .add
        case "/lesen/hoeren":
            self = .listen(zeit: value("zeit").flatMap { Int($0) })
        default:
            return nil
        }
    }

    /// Pfad mit Query (und Sprungmarke) wie im Web.
    public var webPath: String {
        var components = URLComponents()
        var items: [URLQueryItem] = []
        switch self {
        case .inbox(let group):
            components.path = "/lesen/eingang"
            items = CockpitAPI.groupQuery(group)
        case .stack(let query):
            components.path = "/lesen/stapel"
            items = CockpitAPI.stackQuery(query)
        case .reader(let id, let highlight, let resume):
            components.path = "/lesen/doc"
            items = CockpitAPI.docQuery(id)
            if let highlight { components.fragment = "h-\(highlight)" } else if resume { components.fragment = "weiter" }
        case .highlights(let query):
            components.path = "/lesen/markiert"
            items = CockpitAPI.highlightQuery(query)
        case .review(let week):
            components.path = "/lesen/wiedersehen"
            items = CockpitAPI.weekQuery(week)
        case .episodes:
            components.path = "/lesen/folgen"
        case .newEpisode(let zeit):
            components.path = "/lesen/folgen/neu"
            items = CockpitAPI.zeitQuery(zeit)
        case .add:
            components.path = "/lesen/hinzufuegen"
        case .listen(let zeit):
            components.path = "/lesen/hoeren"
            items = CockpitAPI.zeitQuery(zeit)
        }
        components.queryItems = items.isEmpty ? nil : items
        return components.string ?? components.path
    }
}
