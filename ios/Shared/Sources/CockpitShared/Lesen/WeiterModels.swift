import Foundation

/// „Weiter“ (`GET /api/lesen/weiter`, src/lesen/weiter.js): wo jeder Text im Ablauf steht und was
/// als Nächstes geht. Oben `next` (der eine Schritt), darunter die Stufen in fester Reihenfolge
/// (Prüfen · Anhören · Entscheiden · Fehler · Weiterlesen · Läuft), dazu Zahlen für Eingang und
/// ungelesenen Stapel. Unbekannte Stufen oder Felder brechen nichts.
public struct WeiterModel: Decodable, Equatable, Sendable {
    public let next: WeiterNext
    public let counts: WeiterCounts
    public var stages: [WeiterStage]
    /// Claude ist angebunden: „Ins Wiki: entwerfen“ geht.
    public let ingestAvailable: Bool
    /// Einpflanzen geht („Erneut einpflanzen“).
    public let plantAvailable: Bool
    /// So viele Texte reiht „Alle entwerfen lassen“ ein.
    public let draftable: Int
    /// „Nur in den Vault“ geht (Lesestapel-Notizen angebunden).
    public let vault: Bool
    /// Folgen sind eingerichtet.
    public let episodes: Bool

    enum CodingKeys: String, CodingKey { case next, counts, stages, ingestAvailable, plantAvailable, draftable, vault, episodes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        next = try c.decode(WeiterNext.self, forKey: .next)
        counts = try c.decodeIfPresent(WeiterCounts.self, forKey: .counts) ?? WeiterCounts()
        stages = try c.decodeIfPresent([WeiterStage].self, forKey: .stages) ?? []
        ingestAvailable = try c.decodeIfPresent(Bool.self, forKey: .ingestAvailable) ?? false
        plantAvailable = try c.decodeIfPresent(Bool.self, forKey: .plantAvailable) ?? false
        draftable = try c.decodeIfPresent(Int.self, forKey: .draftable) ?? 0
        vault = try c.decodeIfPresent(Bool.self, forKey: .vault) ?? false
        episodes = try c.decodeIfPresent(Bool.self, forKey: .episodes) ?? false
    }

    /// Stufen mit Einträgen, in der Reihenfolge des Servers.
    public var visibleStages: [WeiterStage] { stages.filter { !$0.items.isEmpty } }

    /// Nichts wartet: keine Stufe mit Einträgen, kein Eingang, kein Stapel.
    public var isClear: Bool { visibleStages.isEmpty && counts.eingang == 0 && counts.stapel == 0 }

    /// Eintrag entfernen (nach „Fertig, weg“ usw., bis der neue Stand da ist).
    public mutating func remove(itemID: String) {
        for index in stages.indices { stages[index].items.removeAll { $0.id == itemID } }
    }
}

/// „Als Nächstes“: Satz und Knopf. `href` ist ein Web-Pfad (`/lesen/folgen#hoeren`, `#entscheiden`),
/// `action` eine Aktion („Alle entwerfen lassen“); ohne beides ist alles erledigt.
public struct WeiterNext: Decodable, Equatable, Sendable {
    /// `pruefen`, `anhoeren`, `entscheiden`, `fehler`, `weiterlesen`, `eingang`, `stapel`, `laeuft`, nil.
    public let stage: String?
    public let text: String
    public let href: String?
    public let action: String?
    public let label: String?

    public init(stage: String?, text: String, href: String? = nil, action: String? = nil, label: String? = nil) {
        self.stage = stage
        self.text = text
        self.href = href
        self.action = action
        self.label = label
    }

    /// Sprungmarke auf eine Stufe dieser Seite (`#entscheiden`).
    public var anchor: String? {
        guard let href, href.hasPrefix("#") else { return nil }
        return String(href.dropFirst())
    }
}

/// Zahlen je Stufe, dazu ungelesener Eingang und Stapel (mit Minuten).
public struct WeiterCounts: Decodable, Equatable, Sendable {
    public var eingang = 0
    public var stapel = 0
    public var stapelMinutes = 0

    public init() {}

    enum CodingKeys: String, CodingKey { case eingang, stapel, stapelMinutes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        eingang = try c.decodeIfPresent(Int.self, forKey: .eingang) ?? 0
        stapel = try c.decodeIfPresent(Int.self, forKey: .stapel) ?? 0
        stapelMinutes = try c.decodeIfPresent(Int.self, forKey: .stapelMinutes) ?? 0
    }
}

/// Eine Stufe mit Name, Erklärung und Einträgen.
public struct WeiterStage: Decodable, Equatable, Identifiable, Sendable {
    public let key: String
    public let label: String
    public let hint: String
    public var items: [WeiterItem]

    public var id: String { key }

    enum CodingKeys: String, CodingKey { case key, label, hint, items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        hint = try c.decodeIfPresent(String.self, forKey: .hint) ?? ""
        items = try c.decodeIfPresent([WeiterItem].self, forKey: .items) ?? []
    }
}

/// Ein Eintrag: ein Text (`doc`) oder, unter „Anhören“, eine Folge (`episode`) mit ihren Texten.
public struct WeiterItem: Decodable, Equatable, Identifiable, Sendable {
    public let stage: String
    /// Der Text (alle Stufen außer „Anhören“).
    public let doc: ReadingDoc?
    /// Restzeit in Minuten (nur „Weiterlesen“).
    public let remaining: Int?
    public let read: WeiterRead?
    public let ingest: WeiterIngest?
    /// Was läuft oder schiefging, als Satz („Claude entwirft“, „Entwurf fehlgeschlagen: …“).
    public let state: String?
    /// Gelesen/Gehört · Entwurf · Im Wiki · Eingepflanzt.
    public let track: [WeiterStep]
    /// Die Folge (nur „Anhören“).
    public let episode: WeiterEpisode?
    /// Texte der Folge (nur „Anhören“).
    public let docs: [WeiterEpisodeDoc]

    public var id: String { episode.map { "folge:\($0.id)" } ?? doc?.id ?? stage }
    public var title: String { episode?.title ?? doc?.title ?? doc?.url ?? "Ohne Titel" }

    enum CodingKeys: String, CodingKey { case stage, remaining, read, ingest, state, track, episode, docs }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stage = try c.decode(String.self, forKey: .stage)
        episode = try c.decodeIfPresent(WeiterEpisode.self, forKey: .episode)
        doc = episode == nil ? try ReadingDoc(from: decoder) : nil
        remaining = try c.decodeIfPresent(Int.self, forKey: .remaining)
        read = try c.decodeIfPresent(WeiterRead.self, forKey: .read)
        ingest = try c.decodeIfPresent(WeiterIngest.self, forKey: .ingest)
        state = try c.decodeIfPresent(String.self, forKey: .state)
        track = try c.decodeIfPresent([WeiterStep].self, forKey: .track) ?? []
        docs = try c.decodeIfPresent([WeiterEpisodeDoc].self, forKey: .docs) ?? []
    }

    /// Die Spur meldet einen Fehler beim Einpflanzen (dann „Erneut einpflanzen“ statt „Erneut entwerfen“).
    public var isPlantFailure: Bool { ingest?.plant?.status == "fehler" }

    /// Meta wie im Web: „Blatt · 12 Min. · gehört am 24. Okt. in „Podcast: …““.
    public func meta(timeZone: TimeZone = .current, now: Date = .now) -> String {
        if let episode {
            var parts: [String?] = [episode.kindLabel, episode.durationLabel]
            if let position = episode.position, position > 0 { parts.append("angefangen, bei \(Episode.clock(position))") }
            return CockpitFormat.meta(parts)
        }
        guard let doc else { return "" }
        let minutes: String? = if stage == "weiterlesen", let remaining {
            "noch \(remaining) Min."
        } else if doc.readingMinutes > 0 {
            "\(doc.readingMinutes) Min."
        } else {
            nil
        }
        return CockpitFormat.meta([doc.site, minutes, read?.label(timeZone: timeZone)])
    }
}

/// Wie der Text gelesen wurde: `gehoert` (mit Folge, falls bekannt) oder `gelesen`.
public struct WeiterRead: Decodable, Equatable, Sendable {
    public struct EpisodeRef: Decodable, Equatable, Sendable {
        public let id: String
        public let title: String
    }

    public let how: String
    public let at: String?
    public let episode: EpisodeRef?

    public var isHeard: Bool { how == "gehoert" }

    /// „gehört am 24. Okt. in „Podcast: …““, „gelesen am 25. Okt.“ oder „zu Ende gelesen“.
    public func label(timeZone: TimeZone = .current) -> String {
        let day = at.flatMap { WeiterFormat.day($0, timeZone: timeZone) }
        if isHeard {
            var text = "gehört"
            if let day { text += " am \(day)" }
            if let episode { text += " in „\(episode.title)“" }
            return text
        }
        return day.map { "gelesen am \($0)" } ?? "zu Ende gelesen"
    }
}

/// Stand des Ingests eines Textes und des Einpflanzens danach.
public struct WeiterIngest: Decodable, Equatable, Sendable {
    public struct Plant: Decodable, Equatable, Sendable {
        public let status: String
        public let error: String?
    }

    public let status: String
    public let error: String?
    public let plant: Plant?
}

/// Ein Schritt der Spur: `done`, `busy`, `failed` oder `todo`.
public struct WeiterStep: Decodable, Equatable, Identifiable, Sendable {
    public let key: String
    public let label: String
    public let state: String

    public var id: String { key }
}

/// Ungehörte Folge unter „Anhören“.
public struct WeiterEpisode: Decodable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let kindLabel: String
    public let title: String
    /// Länge der MP3 in Sekunden.
    public let seconds: Int?
    /// Gemeldete Stelle in Sekunden („angefangen“).
    public let position: Int?
    /// Größe der MP3 (der Player erkennt daran eine erneuerte Datei im Cache).
    public let bytes: Int?

    enum CodingKeys: String, CodingKey { case id, kind, kindLabel, title, seconds, position, bytes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        kindLabel = try c.decodeIfPresent(String.self, forKey: .kindLabel) ?? kind
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        seconds = try c.decodeIfPresent(Int.self, forKey: .seconds)
        position = try c.decodeIfPresent(Int.self, forKey: .position)
        bytes = try c.decodeIfPresent(Int.self, forKey: .bytes)
    }

    public var durationLabel: String? { seconds.map(Episode.clock) }
    public var isStarted: Bool { (position ?? 0) > 0 }
}

/// Text einer ungehörten Folge (Titel zum Antippen).
public struct WeiterEpisodeDoc: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String?
    public let url: String

    public var label: String { title ?? url }
}

enum WeiterFormat {
    /// „24. Okt.“ wie `Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' })`.
    static func day(_ iso: String, timeZone: TimeZone) -> String? {
        guard let date = CockpitFormat.date(from: iso) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.day, .month], from: date)
        guard let day = parts.day, let month = parts.month, (1...12).contains(month) else { return nil }
        return "\(day). \(months[month - 1])"
    }

    static let months = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."]
}
