import Foundation

// Modelle für `GET /api/lesen/feeds` (src/lesen/feeds-page.js, `feedsJson`).

/// Zustand eines Feeds für Farbe und Symbol.
public enum FeedState: String, Decodable, Equatable, Sendable {
    case ok, new, error, paused, groupPaused

    public init(from decoder: Decoder) throws {
        self = FeedState(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .ok
    }
}

/// Abonnierter Feed mit Einstellungen und Abrufstand.
public struct ReadingFeed: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let url: String
    public let host: String
    public let siteUrl: String?
    public let title: String
    /// Favicon als `data:`-URI, sonst nil (dann `letter`).
    public let icon: String?
    public let letter: String
    public let paused: Bool
    /// Neue Einträge direkt auf den Stapel statt in den Eingang.
    public let toStack: Bool
    /// Stichwort-Filter, durch Komma getrennt; nil = alles.
    public let keywordFilter: String?
    public let intervalMinutes: Int
    public let groupId: String?
    public let groupPaused: Bool
    public let groupToStack: Bool
    public let lastFetchAt: String?
    public let nextFetchAt: String?
    public let errorCount: Int
    /// Letzter Fehler (Adresse gekürzt).
    public let lastError: String?
    public let state: FeedState
    /// Zeile wie auf der Seite: „abgerufen 25.10. 12:09 · vor 3 min“, „Fehler (2×): …“.
    public let status: String
    /// „kultur.test · alle 60 min · direkt auf den Stapel“
    public let meta: String

    enum CodingKeys: String, CodingKey {
        case id, url, host, siteUrl, title, icon, letter, paused, toStack, keywordFilter, intervalMinutes, groupId, groupPaused, groupToStack
        case lastFetchAt, nextFetchAt, errorCount, lastError, state, status, meta
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        url = try c.decode(String.self, forKey: .url)
        host = try c.decodeIfPresent(String.self, forKey: .host) ?? URL(string: url)?.host ?? url
        siteUrl = try c.decodeIfPresent(String.self, forKey: .siteUrl)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? host
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        letter = try c.decodeIfPresent(String.self, forKey: .letter) ?? String(title.prefix(1)).uppercased()
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        toStack = try c.decodeIfPresent(Bool.self, forKey: .toStack) ?? false
        keywordFilter = try c.decodeIfPresent(String.self, forKey: .keywordFilter)
        intervalMinutes = try c.decodeIfPresent(Int.self, forKey: .intervalMinutes) ?? 30
        groupId = try c.decodeIfPresent(String.self, forKey: .groupId)
        groupPaused = try c.decodeIfPresent(Bool.self, forKey: .groupPaused) ?? false
        groupToStack = try c.decodeIfPresent(Bool.self, forKey: .groupToStack) ?? false
        lastFetchAt = try c.decodeIfPresent(String.self, forKey: .lastFetchAt)
        nextFetchAt = try c.decodeIfPresent(String.self, forKey: .nextFetchAt)
        errorCount = try c.decodeIfPresent(Int.self, forKey: .errorCount) ?? 0
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        state = try c.decodeIfPresent(FeedState.self, forKey: .state) ?? .ok
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        meta = try c.decodeIfPresent(String.self, forKey: .meta) ?? host
    }

    /// Link auf die Website (nur http/https).
    public var siteLink: URL? {
        guard let siteUrl, siteUrl.lowercased().hasPrefix("http://") || siteUrl.lowercased().hasPrefix("https://") else { return nil }
        return URL(string: siteUrl)
    }

    /// Bytes des Favicons aus der `data:`-URI (Base64), sonst nil.
    public var iconData: Data? {
        guard let icon, icon.hasPrefix("data:"), let comma = icon.firstIndex(of: ","), icon[..<comma].hasSuffix(";base64") else { return nil }
        return Data(base64Encoded: String(icon[icon.index(after: comma)...]))
    }

    public var isFailing: Bool { errorCount > 0 }

    /// Einstellungen zum Bearbeiten, vorbelegt mit dem gespeicherten Stand.
    public var settings: FeedSettings {
        FeedSettings(paused: paused, toStack: toStack, filter: keywordFilter ?? "", intervalMinutes: intervalMinutes, groupId: groupId, url: url)
    }
}

/// Gruppe von Feeds; Pause und „direkt auf den Stapel“ gelten für alle ihre Feeds.
public struct FeedGroup: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let position: Int
    public let paused: Bool
    public let toStack: Bool
    /// „pausiert · direkt auf den Stapel“, nil ohne.
    public let flags: String?
    /// Neue Einträge der Gruppe im Eingang.
    public let inbox: Int
    public var canMoveUp: Bool
    public var canMoveDown: Bool
    public let feeds: [ReadingFeed]

    enum CodingKeys: String, CodingKey { case id, name, position, paused, toStack, flags, inbox, canMoveUp, canMoveDown, feeds }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        position = try c.decodeIfPresent(Int.self, forKey: .position) ?? 0
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        toStack = try c.decodeIfPresent(Bool.self, forKey: .toStack) ?? false
        flags = try c.decodeIfPresent(String.self, forKey: .flags)
        inbox = try c.decodeIfPresent(Int.self, forKey: .inbox) ?? 0
        canMoveUp = try c.decodeIfPresent(Bool.self, forKey: .canMoveUp) ?? false
        canMoveDown = try c.decodeIfPresent(Bool.self, forKey: .canMoveDown) ?? false
        feeds = try c.decodeIfPresent([ReadingFeed].self, forKey: .feeds) ?? []
    }

    /// „1 neuer Eintrag im Eingang“ / „3 neue Einträge im Eingang“
    public var inboxText: String {
        "\(inbox) \(inbox == 1 ? "neuer Eintrag" : "neue Einträge") im Eingang"
    }

    /// Eingang dieser Gruppe.
    public var inboxRoute: ReadingRoute { .inbox(group: id) }
}

/// Grenzen der Formulare.
public struct FeedLimits: Decodable, Equatable, Sendable {
    public let minInterval: Int
    public let maxInterval: Int
    public let defaultInterval: Int
    /// Höchstgröße einer OPML-Datei in Bytes.
    public let maxOpmlBytes: Int
}

/// `GET /api/lesen/feeds`
public struct FeedsModel: Decodable, Equatable, Sendable {
    public var groups: [FeedGroup]
    /// Feeds ohne Gruppe („Ohne Gruppe“, oder die ganze Liste, wenn es keine Gruppen gibt).
    public let ungrouped: [ReadingFeed]
    public let total: Int
    public let limits: FeedLimits
    /// Export-Weg (`/api/lesen/feeds.opml`).
    public let opml: String
    /// Sammeln (VCP-110): Weg und Werte der Aktion.
    public let bulk: FeedBulkInfo

    enum CodingKeys: String, CodingKey { case groups, ungrouped, total, limits, opml, bulk }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groups = try c.decodeIfPresent([FeedGroup].self, forKey: .groups) ?? []
        ungrouped = try c.decodeIfPresent([ReadingFeed].self, forKey: .ungrouped) ?? []
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? ungrouped.count + groups.reduce(0) { $0 + $1.feeds.count }
        limits = try c.decodeIfPresent(FeedLimits.self, forKey: .limits) ?? FeedLimits(minInterval: 5, maxInterval: 1440, defaultInterval: 30, maxOpmlBytes: 2 * 1024 * 1024)
        opml = try c.decodeIfPresent(String.self, forKey: .opml) ?? "/api/lesen/feeds.opml"
        bulk = try c.decodeIfPresent(FeedBulkInfo.self, forKey: .bulk) ?? .fallback
    }

    /// Noch nichts abonniert und keine Gruppe („Noch keine Feeds abonniert.“).
    public var isEmpty: Bool { groups.isEmpty && ungrouped.isEmpty }

    public var allFeeds: [ReadingFeed] { groups.flatMap(\.feeds) + ungrouped }

    public func feed(_ id: String) -> ReadingFeed? { allFeeds.first { $0.id == id } }

    /// Name der Gruppe eines Feeds, nil ohne (oder wenn es die Gruppe nicht mehr gibt).
    public func groupName(of feed: ReadingFeed) -> String? {
        guard let id = feed.groupId else { return nil }
        return groups.first { $0.id == id }?.name
    }

    /// Feeds aus `feeds`, die zu `filter` passen (Suche über Titel, Host und Gruppe).
    public func matching(_ feeds: [ReadingFeed], _ filter: FeedFilter) -> [ReadingFeed] {
        guard filter.isActive else { return feeds }
        return feeds.filter { filter.matches($0, groupName: groupName(of: $0)) }
    }

    /// Feeds mit Fehlern (für „Nur mit Fehlern“, wie auf der Seite nur, wenn es welche gibt).
    public var failingCount: Int { allFeeds.filter(\.isFailing).count }

    /// Überblick wie über der Liste im Web: „4 Feeds · 1 pausiert · 2 mit Fehlern“.
    public var summary: String {
        let feeds = allFeeds
        let paused = feeds.filter { $0.paused || $0.groupPaused }.count
        let failing = feeds.filter(\.isFailing).count
        return [FeedFilter.feedsWord(feeds.count), paused > 0 ? "\(paused) pausiert" : nil, failing > 0 ? "\(failing) mit Fehlern" : nil]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// Gruppen neu durchzählen (nach dem Verschieben).
    mutating func renumber() {
        for i in groups.indices {
            groups[i].canMoveUp = i > 0
            groups[i].canMoveDown = i < groups.count - 1
        }
    }
}

/// Einstellungen eines Feeds für `/aktion/lesen/feed/aendern`.
public struct FeedSettings: Equatable, Sendable {
    public var paused: Bool
    public var toStack: Bool
    /// Stichwort-Filter; leer = alles.
    public var filter: String
    public var intervalMinutes: Int
    /// nil = ohne Gruppe.
    public var groupId: String?
    /// Adresse des Feeds (oder einer Website, die auf ihn verweist); der Server prüft eine neue
    /// wie beim Abonnieren. Leer = unverändert.
    public var url: String

    public init(paused: Bool = false, toStack: Bool = false, filter: String = "", intervalMinutes: Int = 30, groupId: String? = nil, url: String = "") {
        self.paused = paused
        self.toStack = toStack
        self.filter = filter
        self.intervalMinutes = intervalMinutes
        self.groupId = groupId
        self.url = url
    }

    func fields(id: String) -> [String: String] {
        var fields = ["id": id, "filter": filter.trimmingCharacters(in: .whitespacesAndNewlines), "intervall": String(intervalMinutes), "gruppe": groupId ?? ""]
        let url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if !url.isEmpty { fields["url"] = url }
        if paused { fields["pausiert"] = "1" }
        if toStack { fields["stapel"] = "1" }
        return fields
    }
}

/// Suche und „Nur mit Fehlern“ über der Liste (src/web/static/lesen-feeds.js): Die Suche findet
/// Titel, Host und Namen der Gruppe, ohne Groß/klein; beides zusammen muss passen.
public struct FeedFilter: Equatable, Sendable {
    public var query: String
    public var onlyFailing: Bool

    public init(query: String = "", onlyFailing: Bool = false) {
        self.query = query
        self.onlyFailing = onlyFailing
    }

    /// Suchtext ohne Ränder, klein geschrieben.
    var needle: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(with: Self.locale)
    }

    /// Filtert gerade etwas (sonst sind alle Feeds sichtbar).
    public var isActive: Bool { onlyFailing || !needle.isEmpty }

    public func matches(_ feed: ReadingFeed, groupName: String?) -> Bool {
        if onlyFailing && !feed.isFailing { return false }
        let needle = needle
        guard !needle.isEmpty else { return true }
        // Wie `data-suche` im Web: Titel, Host und Gruppe in einer Zeile.
        let haystack = [feed.title, feed.host, groupName ?? ""].joined(separator: " ").lowercased(with: Self.locale)
        return haystack.contains(needle)
    }

    /// „3 Feeds gefunden“ / „Kein Feed passt.“
    public static func hits(_ count: Int) -> String {
        count > 0 ? "\(feedsWord(count)) gefunden" : "Kein Feed passt."
    }

    /// „1 Feed“ / „3 Feeds“
    public static func feedsWord(_ count: Int) -> String {
        "\(count) \(count == 1 ? "Feed" : "Feeds")"
    }

    private static let locale = Locale(identifier: "de_DE")
}

/// Sammeln (`bulk` in `/api/lesen/feeds`): Weg der Aktion, die Werte von `tun` und der Wert von
/// `ziel`, mit dem der Server eine neue Gruppe (Name in `neu`) anlegt.
public struct FeedBulkInfo: Decodable, Equatable, Sendable {
    public let action: String
    public let actions: [String]
    public let newGroup: String

    public init(action: String, actions: [String], newGroup: String) {
        self.action = action
        self.actions = actions
        self.newGroup = newGroup
    }

    /// Stand von feeds-page.js, falls ein älterer Server `bulk` nicht mitschickt.
    public static let fallback = FeedBulkInfo(
        action: FeedAction.bulk,
        actions: ["gruppe", "pausieren", "fortsetzen", "stapel-an", "stapel-aus", "abstand", "entfernen"],
        newGroup: "neu"
    )
}

/// Ziel von „In Gruppe verschieben“.
public enum FeedBulkTarget: Equatable, Sendable {
    /// „ohne Gruppe“
    case ungrouped
    /// Vorhandene Gruppe (ID).
    case group(String)
    /// „Neue Gruppe …“ mit Namen.
    case newGroup(String)
}

/// Eine Aktion für alle abgehakten Feeds (`tun` im Formular der Leiste unten).
public enum FeedBulkAction: Equatable, Sendable {
    case move(FeedBulkTarget)
    case pause
    case resume
    /// „Direkt auf den Stapel“
    case stackOn
    /// „In den Eingang“ (nicht mehr direkt auf den Stapel)
    case stackOff
    /// „Abstand ändern“ in Minuten.
    case interval(Int)
    /// „Entfernen“; die App fragt vorher selbst nach.
    case remove

    /// Wert von `tun`.
    public var verb: String {
        switch self {
        case .move: "gruppe"
        case .pause: "pausieren"
        case .resume: "fortsetzen"
        case .stackOn: "stapel-an"
        case .stackOff: "stapel-aus"
        case .interval: "abstand"
        case .remove: "entfernen"
        }
    }

    /// Formular für `/aktion/lesen/feeds/auswahl`: `tun`, dazu `ziel`/`neu`, `intervall` oder
    /// `bestaetigt=1`, dann je Feed ein `feed` (doppelte fallen weg, die Reihenfolge bleibt).
    public func pairs(feeds ids: [String], newGroup: String = FeedBulkInfo.fallback.newGroup) -> [(String, String)] {
        var pairs = [("tun", verb)]
        switch self {
        case .move(.ungrouped):
            pairs.append(("ziel", ""))
        case .move(.group(let id)):
            pairs.append(("ziel", id))
        case .move(.newGroup(let name)):
            pairs.append(("ziel", newGroup))
            pairs.append(("neu", name.trimmingCharacters(in: .whitespacesAndNewlines)))
        case .interval(let minutes):
            pairs.append(("intervall", String(minutes)))
        case .remove:
            pairs.append(("bestaetigt", "1"))
        case .pause, .resume, .stackOn, .stackOff:
            break
        }
        var seen = Set<String>()
        for id in ids where !id.isEmpty && seen.insert(id).inserted {
            pairs.append(("feed", id))
        }
        return pairs
    }
}

/// Wege der Feed-Aktionen.
public enum FeedAction {
    public static let subscribe = "/aktion/lesen/feed/abonnieren"
    public static let update = "/aktion/lesen/feed/aendern"
    public static let remove = "/aktion/lesen/feed/entfernen"
    public static let importOPML = "/aktion/lesen/feeds/import"
    /// Sammeln: viele Feeds auf einmal (VCP-110).
    public static let bulk = "/aktion/lesen/feeds/auswahl"
    public static let createGroup = "/aktion/lesen/gruppe/anlegen"
    public static let updateGroup = "/aktion/lesen/gruppe/aendern"
    public static let moveGroup = "/aktion/lesen/gruppe/verschieben"
    public static let removeGroup = "/aktion/lesen/gruppe/entfernen"
}

extension CockpitAPI {
    public func feeds() async throws -> FeedsModel {
        try await get("api/lesen/feeds")
    }

    /// OPML-Export (`feeds.opml`).
    public func feedsOPML() async throws -> DownloadedFile {
        try await download("api/lesen/feeds.opml")
    }
}
