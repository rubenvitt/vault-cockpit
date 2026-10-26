import Foundation

// Modelle für die JSON-Wege des Lesens (`/api/lesen/…`, src/lesen/json.js und die Seiten daneben).
// Felder heißen wie beim Server (camelCase); Zeiten bleiben Text (ISO wie in der Datenbank),
// `CockpitFormat.date(from:)` macht daraus `Date`.

/// Status eines Dokuments: `eingang`, `stapel`, `archiv`, `abgelegt` oder `weg`. Offen für Werte,
/// die die App noch nicht kennt.
public struct ReadingStatus: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { rawValue = value }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let inbox: ReadingStatus = "eingang"
    public static let stack: ReadingStatus = "stapel"
    public static let archive: ReadingStatus = "archiv"
    public static let filed: ReadingStatus = "abgelegt"
    public static let gone: ReadingStatus = "weg"

    /// Bereich in der Leseansicht („Bereiche“): Eingang, Stapel, Archiv, Abgelegt, Weg.
    public var label: String {
        switch self {
        case .inbox: "Eingang"
        case .stack: "Stapel"
        case .archive: "Archiv"
        case .filed: "Abgelegt"
        case .gone: "Weg"
        default: rawValue
        }
    }
}

/// Dokument im Lesestapel (`docJson`), ohne Inhalt.
public struct ReadingDoc: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let url: String
    public let canonicalUrl: String?
    /// Diskussion zum Feed-Eintrag (Hacker News, Reddit); ältere Server schicken sie nicht.
    public let commentsUrl: String?
    public let title: String?
    public let author: String?
    public let site: String?
    /// `artikel`, `newsletter`, `feed` oder `pdf`.
    public let kind: String
    /// „Artikel“, „Newsletter“, „Feed-Eintrag“, „PDF“.
    public let kindLabel: String
    /// `kurzbefehl`, `mail`, `import`, `feed:<id>` oder `formular`.
    public let origin: String?
    public let excerpt: String?
    public let wordCount: Int
    public let readingMinutes: Int
    public var status: ReadingStatus
    public let previousStatus: ReadingStatus?
    /// Gelesener Anteil 0…1.
    public var progress: Double
    /// Lesestelle: Zeichen im Lesetext (UTF-16).
    public var scrollAnchor: Int
    public let topics: [String]
    public let savedAt: String
    public let statusChangedAt: String?
    public let readAt: String?
    public let archivedAt: String?
    public let updatedAt: String?

    /// Titel, sonst die Adresse (`name` auf dem Server).
    public var displayTitle: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? url }
    /// Angefangen, aber nicht fertig („Weiterlesen“).
    public var isStarted: Bool { progress > 0 && progress < 1 }

    /// Restzeit in Minuten wie `remainingMinutes` in src/lesen/stack.js: aufgerundet, mindestens 1.
    public var remainingMinutes: Int {
        max(1, Int((Double(readingMinutes) * (1 - progress)).rounded(.up)))
    }
}

/// Wo ein Dokument steht, kurz: `{id, title, url}` (zuletzt gesichtet im Eingang).
public struct ReadingDocRef: Decodable, Equatable, Hashable, Sendable {
    public let id: String
    public let title: String?
    public let url: String

    public init(id: String, title: String?, url: String) {
        self.id = id
        self.title = title
        self.url = url
    }

    public var displayTitle: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? url }
}

/// Feed-Gruppe für die Chips „Alle · Gruppe · Ohne Feed“; im Eingang mit Zähler.
public struct ReadingGroup: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    /// Dokumente im Eingang (nur `/api/lesen/eingang`).
    public let count: Int?
}

/// Aktiver Gruppenfilter: Gruppen-ID, `ohne` (ohne Feed) oder nil (alle).
public struct ReadingGroupFilter: Decodable, Equatable, Sendable {
    public let gruppe: String?

    /// Wert für „Ohne Feed“.
    public static let noFeed = "ohne"
}

// MARK: Eingang

/// Feed, aus dem eine Karte im Eingang stammt.
public struct ReadingFeedRef: Decodable, Equatable, Hashable, Sendable {
    public let id: String
    public let title: String?
    public let url: String
    public let siteUrl: String?
    public let groupId: String?
}

/// Oberste Karte im Eingang: Dokument mit Herkunft in einem Satz.
@dynamicMemberLookup
public struct InboxCard: Decodable, Equatable, Identifiable, Sendable {
    public var doc: ReadingDoc
    /// Quelle für die Meta-Zeile (Seite oder Host).
    public let siteLabel: String?
    /// „Warum hier?“, z. B. „Feed Beispiel-Blog, abonniert im Oktober 2026“.
    public let why: String
    /// Gespeichert am, z. B. „23. Okt.“
    public let savedLabel: String
    public let feed: ReadingFeedRef?

    public var id: String { doc.id }

    public subscript<T>(dynamicMember keyPath: KeyPath<ReadingDoc, T>) -> T { doc[keyPath: keyPath] }

    enum CodingKeys: String, CodingKey { case siteLabel, why, savedLabel, feed }

    public init(from decoder: Decoder) throws {
        doc = try ReadingDoc(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        siteLabel = try c.decodeIfPresent(String.self, forKey: .siteLabel)
        why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
        savedLabel = try c.decodeIfPresent(String.self, forKey: .savedLabel) ?? ""
        feed = try c.decodeIfPresent(ReadingFeedRef.self, forKey: .feed)
    }
}

/// „Heute x von y gesichtet“ und die letzte Entscheidung von heute.
public struct InboxToday: Decodable, Equatable, Sendable {
    public var seen: Int
    public var total: Int
    public var last: ReadingDocRef?
}

/// `GET /api/lesen/eingang?gruppe=`
public struct ReadingInboxModel: Decodable, Equatable, Sendable {
    /// Oberste Karte, nil = „Eingang leer“.
    public var doc: InboxCard?
    /// Dokumente im Eingang (mit Filter).
    public var left: Int
    /// Mehr als eine Karte: gestapelter Look.
    public var more: Bool
    public var today: InboxToday
    /// Rückgängig der letzten Entscheidung von heute („↶ Rückgängig“, Z).
    public var undo: UndoAction?
    public let filter: ReadingGroupFilter
    public let groups: [ReadingGroup]
    /// Dokumente ohne Feed im Eingang.
    public let noFeedCount: Int
    /// Chips zeigen, wenn es Gruppen gibt oder ein Filter aktiv ist.
    public let showGroups: Bool
    /// „Im Vault ablegen“ geht.
    public let vault: Bool

    /// „Heute 1 von 2 gesichtet“
    public var progressLabel: String { "Heute \(today.seen) von \(today.total) gesichtet" }
}

// MARK: Stapel

/// Dokument auf dem Stapel mit Restzeit (`stackItemJson`); bei „Neue Folge“ mit `chars`.
@dynamicMemberLookup
public struct StackItem: Decodable, Equatable, Identifiable, Sendable {
    public var doc: ReadingDoc
    /// Restzeit in Minuten, nil ohne Lesezeit.
    public let remaining: Int?
    /// Angefangen („Weiterlesen“).
    public let started: Bool
    /// Zeichen fürs Vorlesen (nur „Neue Folge“; 0 = schon gehört, kostet nichts).
    public let chars: Int?
    /// Stand des Ingest-Entwurfs (`bereit`, `entwirft` …), nil ohne Entwurf oder ohne Ingest.
    public var ingest: String?

    public var id: String { doc.id }

    public subscript<T>(dynamicMember keyPath: KeyPath<ReadingDoc, T>) -> T { doc[keyPath: keyPath] }

    /// Meta wie im Web: „Weiterlesen · noch 8 Min. · Blatt“ bzw. „7 Min. · Zeit“.
    public var meta: String {
        var parts: [String?] = []
        if started { parts.append("Weiterlesen") }
        if let remaining { parts.append("\(started ? "noch " : "")\(remaining) Min.") }
        parts.append(doc.site)
        return CockpitFormat.meta(parts)
    }

    enum CodingKeys: String, CodingKey { case remaining, started, chars, ingest }

    public init(from decoder: Decoder) throws {
        doc = try ReadingDoc(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        remaining = try c.decodeIfPresent(Int.self, forKey: .remaining)
        started = try c.decodeIfPresent(Bool.self, forKey: .started) ?? doc.isStarted
        chars = try c.decodeIfPresent(Int.self, forKey: .chars)
        ingest = try? c.decodeIfPresent(String.self, forKey: .ingest)
    }
}

/// Sortierung ohne Zeitfenster: `passt` (Passt jetzt), `neu` (Neueste), `kurz` (Kürzeste).
public struct StackSort: Decodable, Equatable, Hashable, Sendable {
    public let key: String
    public let label: String
}

/// Zeitfenster: „x von y Min.“, „n weitere warten“; `fits == false`: „Nichts passt ganz“.
public struct StackWindow: Decodable, Equatable, Sendable {
    public let used: Int
    public let of: Int
    public let more: Int
    public let fits: Bool
}

/// `GET /api/lesen/stapel?zeit=&sort=&gruppe=`
public struct ReadingStackModel: Decodable, Equatable, Sendable {
    /// Zeitfenster in Minuten, nil = alle.
    public let zeit: Int?
    public let sort: String
    /// 5, 15, 30, 60
    public let windows: [Int]
    public let sorts: [StackSort]
    public let filter: ReadingGroupFilter
    public let groups: [ReadingGroup]
    public let showGroups: Bool
    /// Alles auf dem Stapel (mit Gruppenfilter).
    public var count: Int
    public var items: [StackItem]
    public let window: StackWindow?
    /// „Im Vault ablegen“ geht.
    public let vault: Bool
    /// Folgen sind eingerichtet („Folge erzeugen“).
    public let episodes: Bool
    /// Zeitfenster für „Unterwegs hören“ und „Folge erzeugen“.
    public let listenZeit: Int
    public let episodeZeit: Int
    /// Ingest ist eingerichtet (dann trägt jeder Eintrag `ingest`); fehlt bei älteren Servern.
    public let ingest: Bool?
    /// Claude ist angebunden: „Ingest entwerfen“ geht.
    public let ingestAvailable: Bool?
    /// Gelesen oder gehört, wartet unter „Weiter“ auf die Entscheidung (nicht in `items`).
    public let decide: Int?
}

// MARK: Leseansicht

/// Ein Stück Text eines Blocks mit Auszeichnung. `start` ist die Stelle im Lesetext (UTF-16);
/// `text` ist genau so lang wie das Stück dort (Leerraum als Leerzeichen). Läufe mit `extra`
/// (`"\n"` für `<br>`, `"\t"` zwischen Tabellenzellen) stehen nicht im Lesetext.
public struct ReaderRun: Decodable, Equatable, Hashable, Sendable {
    public let text: String
    public let start: Int
    public let bold: Bool
    public let italic: Bool
    public let code: Bool
    public let strike: Bool
    /// Ziel eines Links (absolut).
    public let link: String?
    public let extra: Bool

    public init(text: String, start: Int, bold: Bool = false, italic: Bool = false, code: Bool = false, strike: Bool = false, link: String? = nil, extra: Bool = false) {
        self.text = text
        self.start = start
        self.bold = bold
        self.italic = italic
        self.code = code
        self.strike = strike
        self.link = link
        self.extra = extra
    }

    enum CodingKeys: String, CodingKey { case text, start, bold, italic, code, strike, link, extra }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        start = try c.decode(Int.self, forKey: .start)
        bold = try c.decodeIfPresent(Bool.self, forKey: .bold) ?? false
        italic = try c.decodeIfPresent(Bool.self, forKey: .italic) ?? false
        code = try c.decodeIfPresent(Bool.self, forKey: .code) ?? false
        strike = try c.decodeIfPresent(Bool.self, forKey: .strike) ?? false
        link = try c.decodeIfPresent(String.self, forKey: .link)
        extra = try c.decodeIfPresent(Bool.self, forKey: .extra) ?? false
    }

    /// Länge im Lesetext (UTF-16), 0 für `extra`.
    public var length: Int { extra ? 0 : text.utf16.count }
}

/// Art eines Blocks; Unbekanntes zeigt die App als Absatz.
public enum ReaderBlockKind: String, Sendable {
    case heading, paragraph, listItem, quote, code, caption, row, image, rule
}

/// Block des Lesetexts (src/lesen/blocks.js). `start`/`end`: erstes sichtbares Zeichen und
/// dahinter, als UTF-16-Stellen im Lesetext wie die Anker der Markierungen.
public struct ReaderBlock: Decodable, Equatable, Hashable, Sendable {
    public let kind: ReaderBlockKind
    public let start: Int
    public let end: Int
    public let runs: [ReaderRun]
    /// Überschrift 1…6.
    public let level: Int?
    /// Listenpunkt: nummeriert, Tiefe ab 1, Nummer.
    public let ordered: Bool?
    public let depth: Int?
    public let number: Int?
    /// Block in einem Zitat, der selbst kein Zitat ist.
    public let quoted: Bool
    /// Tabellenzeile mit Kopfzellen.
    public let header: Bool
    /// Bild: Adresse des Originals (direkt laden) und Beschreibung.
    public let src: String?
    public let alt: String?

    public init(kind: ReaderBlockKind, start: Int, end: Int, runs: [ReaderRun], level: Int? = nil, ordered: Bool? = nil, depth: Int? = nil, number: Int? = nil, quoted: Bool = false, header: Bool = false, src: String? = nil, alt: String? = nil) {
        self.kind = kind
        self.start = start
        self.end = end
        self.runs = runs
        self.level = level
        self.ordered = ordered
        self.depth = depth
        self.number = number
        self.quoted = quoted
        self.header = header
        self.src = src
        self.alt = alt
    }

    enum CodingKeys: String, CodingKey { case kind, start, end, runs, level, ordered, depth, number, quoted, header, src, alt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = ReaderBlockKind(rawValue: try c.decode(String.self, forKey: .kind)) ?? .paragraph
        start = try c.decode(Int.self, forKey: .start)
        end = try c.decode(Int.self, forKey: .end)
        runs = try c.decodeIfPresent([ReaderRun].self, forKey: .runs) ?? []
        level = try c.decodeIfPresent(Int.self, forKey: .level)
        ordered = try c.decodeIfPresent(Bool.self, forKey: .ordered)
        depth = try c.decodeIfPresent(Int.self, forKey: .depth)
        number = try c.decodeIfPresent(Int.self, forKey: .number)
        quoted = try c.decodeIfPresent(Bool.self, forKey: .quoted) ?? false
        header = try c.decodeIfPresent(Bool.self, forKey: .header) ?? false
        src = try c.decodeIfPresent(String.self, forKey: .src)
        alt = try c.decodeIfPresent(String.self, forKey: .alt)
    }

    /// Text, wie die App ihn zeigt: alle Läufe hintereinander, auch `extra`.
    public var displayText: String { runs.map(\.text).joined() }

    /// Stelle im Lesetext zu einer Stelle (UTF-16) in `displayText`, für die Auswahl. Jeder Lauf
    /// zählt ab seiner eigenen `start` (zusammengefasster Leerraum lässt Lücken), `extra`-Läufe
    /// haben keine Länge. Genau zwischen zwei Läufen nimmt `preferNext` den Anfang des nächsten
    /// (Anfang einer Auswahl), sonst das Ende des vorigen (Ende einer Auswahl).
    public func documentOffset(atDisplay offset: Int, preferNext: Bool = true) -> Int {
        var local = 0
        var previousEnd: Int?
        for run in runs {
            let count = run.text.utf16.count
            if offset <= local {
                if !preferNext, let previousEnd { return previousEnd }
                return run.start
            }
            if offset < local + count {
                return run.start + (run.extra ? 0 : offset - local)
            }
            local += count
            if !run.extra { previousEnd = run.start + count }
        }
        return previousEnd ?? start
    }

    /// Bereich im Lesetext zu einer Auswahl in `displayText` (UTF-16).
    public func documentRange(forDisplay range: Range<Int>) -> Range<Int> {
        let lower = documentOffset(atDisplay: range.lowerBound, preferNext: true)
        let upper = documentOffset(atDisplay: range.upperBound, preferNext: false)
        return lower..<max(lower, upper)
    }

    /// Stelle in `displayText` (UTF-16) zu einer Stelle im Lesetext; in einer Lücke (zusammengefasster
    /// Leerraum) der Anfang des nächsten Laufs. Genau am Ende eines Laufs nimmt `preferNext` den
    /// Anfang des nächsten (hinter einem Tab oder Umbruch). nil außerhalb des Blocks.
    public func displayOffset(atDocument offset: Int, preferNext: Bool = false) -> Int? {
        guard offset >= start, offset <= end else { return nil }
        var local = 0
        for run in runs {
            let count = run.text.utf16.count
            if !run.extra {
                if offset < run.start { return local }
                if offset < run.start + count || (offset == run.start + count && !preferNext) { return local + (offset - run.start) }
            }
            local += count
        }
        return local
    }

    /// Bereich in `displayText` (UTF-16) zu einem Bereich im Lesetext, auf den Block gekürzt;
    /// nil, wenn er den Block nicht trifft (z. B. um Markierungen zu malen).
    public func displayRange(for range: Range<Int>) -> Range<Int>? {
        let lower = max(range.lowerBound, start)
        let upper = min(range.upperBound, end)
        guard lower < upper,
              let from = displayOffset(atDocument: lower, preferNext: true),
              let to = displayOffset(atDocument: upper, preferNext: false),
              from < to
        else { return nil }
        return from..<to
    }
}

/// Markierung (`highlightJson`). In Listen (Markiert, Wiedersehen) mit Titel, Adresse, Quelle und
/// Themen des Dokuments; in der Leseansicht mit ihrer Stelle (`start`/`end`, nil wenn `lost`).
public struct ReadingHighlight: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let docId: String
    public let quote: String
    public let prefix: String
    public let suffix: String
    public let startHint: Int?
    public var note: String?
    public let createdAt: String
    public let updatedAt: String?
    public let reviewBox: Int
    public let reviewDue: String?
    /// `aktiv` oder `losgelassen`.
    public let reviewState: String
    public let docTitle: String?
    public let docUrl: String?
    public let docSite: String?
    public let docTopics: [String]
    /// Stelle im Lesetext (nur Leseansicht), ungekürzt.
    public var start: Int?
    public var end: Int?
    /// „Stelle nicht mehr im Text“
    public var lost: Bool
    /// Wartet im Puffer auf Netz (nur in der App, nicht vom Server).
    public var isPending: Bool

    public init(id: String, docId: String, quote: String, prefix: String = "", suffix: String = "", startHint: Int? = nil, note: String? = nil, createdAt: String, updatedAt: String? = nil, reviewBox: Int = 0, reviewDue: String? = nil, reviewState: String = "aktiv", docTitle: String? = nil, docUrl: String? = nil, docSite: String? = nil, docTopics: [String] = [], start: Int? = nil, end: Int? = nil, lost: Bool = false, isPending: Bool = false) {
        self.id = id
        self.docId = docId
        self.quote = quote
        self.prefix = prefix
        self.suffix = suffix
        self.startHint = startHint
        self.note = note
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.reviewBox = reviewBox
        self.reviewDue = reviewDue
        self.reviewState = reviewState
        self.docTitle = docTitle
        self.docUrl = docUrl
        self.docSite = docSite
        self.docTopics = docTopics
        self.start = start
        self.end = end
        self.lost = lost
        self.isPending = isPending
    }

    enum CodingKeys: String, CodingKey {
        case id, docId, quote, prefix, suffix, startHint, note, createdAt, updatedAt, reviewBox, reviewDue, reviewState
        case docTitle, docUrl, docSite, docTopics, start, end, lost
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        docId = try c.decode(String.self, forKey: .docId)
        quote = try c.decode(String.self, forKey: .quote)
        prefix = try c.decodeIfPresent(String.self, forKey: .prefix) ?? ""
        suffix = try c.decodeIfPresent(String.self, forKey: .suffix) ?? ""
        startHint = try c.decodeIfPresent(Int.self, forKey: .startHint)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        reviewBox = try c.decodeIfPresent(Int.self, forKey: .reviewBox) ?? 0
        reviewDue = try c.decodeIfPresent(String.self, forKey: .reviewDue)
        reviewState = try c.decodeIfPresent(String.self, forKey: .reviewState) ?? "aktiv"
        docTitle = try c.decodeIfPresent(String.self, forKey: .docTitle)
        docUrl = try c.decodeIfPresent(String.self, forKey: .docUrl)
        docSite = try c.decodeIfPresent(String.self, forKey: .docSite)
        docTopics = try c.decodeIfPresent([String].self, forKey: .docTopics) ?? []
        start = try c.decodeIfPresent(Int.self, forKey: .start)
        end = try c.decodeIfPresent(Int.self, forKey: .end)
        lost = try c.decodeIfPresent(Bool.self, forKey: .lost) ?? false
        isPending = false
    }

    /// Stelle im Lesetext, wenn bekannt.
    public var range: Range<Int>? {
        guard let start, let end, end > start else { return nil }
        return start..<end
    }

    /// Titel des Dokuments, sonst seine Adresse (Listen).
    public var docDisplayTitle: String { docTitle.flatMap { $0.isEmpty ? nil : $0 } ?? docUrl ?? "" }
}

/// Markierung, wie sie im Text erscheint: Überlappungen gekürzt, in Lesereihenfolge (die
/// `<mark>` des Webs). Eine Markierung ganz innerhalb einer anderen hat keinen Bereich.
public struct HighlightRange: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public var start: Int
    public var end: Int
    public var note: String?
    /// Wartet im Puffer auf Netz (nur in der App).
    public var isPending: Bool

    public init(id: String, start: Int, end: Int, note: String? = nil, isPending: Bool = false) {
        self.id = id
        self.start = start
        self.end = end
        self.note = note
        self.isPending = isPending
    }

    enum CodingKeys: String, CodingKey { case id, start, end, note }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        start = try c.decode(Int.self, forKey: .start)
        end = try c.decode(Int.self, forKey: .end)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        isPending = false
    }

    public var range: Range<Int> { start..<max(start, end) }

    /// Bereiche wie `placeHighlights` in src/lesen/anchor.js: nach Anfang sortiert (stabil),
    /// jede Stelle gehört höchstens einer Markierung, ganz verdeckte fallen weg.
    public static func placed(_ highlights: [ReadingHighlight]) -> [HighlightRange] {
        let found = highlights.enumerated().compactMap { index, h -> (Int, HighlightRange)? in
            guard let start = h.start, let end = h.end, !h.lost else { return nil }
            return (index, HighlightRange(id: h.id, start: start, end: end, note: h.note, isPending: h.isPending))
        }
        let sorted = found.sorted { $0.1.start != $1.1.start ? $0.1.start < $1.1.start : $0.0 < $1.0 }.map(\.1)
        var edge = 0
        var out: [HighlightRange] = []
        for var r in sorted {
            r.start = max(r.start, edge)
            edge = max(edge, r.end)
            if r.end > r.start { out.append(r) }
        }
        return out
    }
}

/// Dokumente je Bereich (Eingang, Stapel, Archiv, Abgelegt, Weg).
public struct ReadingCounts: Decodable, Equatable, Sendable {
    public var eingang: Int
    public var stapel: Int
    public var archiv: Int
    public var abgelegt: Int
    public var weg: Int
}

/// Eintrag der Stapel-Liste neben dem Text (höchstens 30), das offene mit `current`.
public struct ReaderStackEntry: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let title: String?
    public let url: String
    public let site: String?
    public let progress: Double
    public let readingMinutes: Int
    /// „noch 8 min“, „gelesen“ oder leer.
    public let rest: String
    public let started: Bool
    public let current: Bool

    public var displayTitle: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? url }
}

/// Knöpfe nach dem Lesen: „Fertig, weg“, „In den Vault“, „Zurück auf den Stapel“.
public struct ReaderDecisions: Decodable, Equatable, Sendable {
    public let fertig: Bool
    public let vault: Bool
    public let zurueck: Bool

    public init(fertig: Bool, vault: Bool, zurueck: Bool) {
        self.fertig = fertig
        self.vault = vault
        self.zurueck = zurueck
    }

    /// Wie `decisions` in src/lesen/doc.js.
    public static func of(status: ReadingStatus, vault: Bool) -> ReaderDecisions {
        ReaderDecisions(fertig: status != .gone, vault: vault, zurueck: [.archive, .filed, .gone].contains(status))
    }
}

/// Dokument der Leseansicht mit Restzeit.
@dynamicMemberLookup
public struct ReaderDoc: Decodable, Equatable, Sendable {
    public var doc: ReadingDoc
    /// „noch 8 min“, „gelesen“ oder leer (ohne Lesezeit).
    public var rest: String
    public var remaining: Int?

    public subscript<T>(dynamicMember keyPath: KeyPath<ReadingDoc, T>) -> T { doc[keyPath: keyPath] }

    public subscript<T>(dynamicMember keyPath: WritableKeyPath<ReadingDoc, T>) -> T {
        get { doc[keyPath: keyPath] }
        set { doc[keyPath: keyPath] = newValue }
    }

    enum CodingKeys: String, CodingKey { case rest, remaining }

    public init(from decoder: Decoder) throws {
        doc = try ReadingDoc(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rest = try c.decodeIfPresent(String.self, forKey: .rest) ?? ""
        remaining = try c.decodeIfPresent(Int.self, forKey: .remaining)
    }
}

/// `GET /api/lesen/doc?id=`
public struct ReadingDocModel: Decodable, Equatable, Sendable {
    public var doc: ReaderDoc
    /// Ohne Lesetext zeigen die Blöcke den Anriss oder „Für diesen Artikel gibt es keinen Lesetext.“
    public let hasText: Bool
    /// Länge des Lesetexts (UTF-16).
    public let length: Int
    /// Gespeicherte Lesestelle.
    public let anchor: Int
    /// Erstes sichtbares Zeichen ab `anchor` (Sprungmarke „Weiterlesen“).
    public let weiter: Int
    public let blocks: [ReaderBlock]
    /// Alle Markierungen (Seitenleiste), auch verlorene.
    public var highlights: [ReadingHighlight]
    /// Markierungen im Text, gekürzt (wie die `<mark>` im Web).
    public var ranges: [HighlightRange]
    public var counts: ReadingCounts
    public let stack: [ReaderStackEntry]
    /// Aus welchem Bereich das Dokument kommt (`eingang`, `stapel`), sonst nil.
    public let nav: String?
    public let vault: Bool
    public var decisions: ReaderDecisions
    /// Ingest: Stand des Entwurfs und ob „Ingest entwerfen“ geht; nil ohne Ingest-Dienst.
    public var ingest: ReaderIngest?

    public func highlight(_ id: String) -> ReadingHighlight? {
        highlights.first { $0.id == id }
    }

    /// Markierung, die `range` ganz abdeckt (H auf einem ganz markierten Absatz entfernt sie).
    public func highlight(covering range: Range<Int>) -> ReadingHighlight? {
        highlights.first { h in
            guard let r = h.range else { return false }
            return r.lowerBound <= range.lowerBound && r.upperBound >= range.upperBound
        }
    }

    /// Ändert eine Markierung und rechnet die Bereiche neu.
    mutating func updateHighlights(_ change: (inout [ReadingHighlight]) -> Void) {
        change(&highlights)
        ranges = HighlightRange.placed(highlights)
    }
}

// MARK: Markiert

/// Filter von Markiert: Quelle (`quelle`) und Thema (`thema`).
public struct HighlightFilter: Decodable, Equatable, Sendable {
    public let quelle: String?
    public let thema: String?
}

/// Werte für die Filter: Quellen und Themen.
public struct HighlightFacets: Decodable, Equatable, Sendable {
    public let sites: [String]
    public let topics: [String]
}

/// `GET /api/lesen/markiert?quelle=&thema=` (neueste zuerst, höchstens 200).
public struct HighlightListModel: Decodable, Equatable, Sendable {
    public let filter: HighlightFilter
    public let facets: HighlightFacets
    public var items: [ReadingHighlight]
}

// MARK: Wiedersehen

/// Fällige Karte: Markierung mit Box 1…5 und Fälligkeit.
@dynamicMemberLookup
public struct ReviewCard: Decodable, Equatable, Identifiable, Sendable {
    public let highlight: ReadingHighlight
    /// Box für die Anzeige („Box b von 5“).
    public let box: Int
    public let dueAt: String?

    public var id: String { highlight.id }

    public subscript<T>(dynamicMember keyPath: KeyPath<ReadingHighlight, T>) -> T { highlight[keyPath: keyPath] }

    enum CodingKeys: String, CodingKey { case box, dueAt }

    public init(from decoder: Decoder) throws {
        highlight = try ReadingHighlight(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        box = try c.decodeIfPresent(Int.self, forKey: .box) ?? max(1, highlight.reviewBox)
        dueAt = try c.decodeIfPresent(String.self, forKey: .dueAt)
    }
}

/// Nachbarwoche im Blätterer („‹ KW 42“).
public struct ReadingWeekRef: Decodable, Equatable, Hashable, Sendable {
    public let id: String
    public let week: Int
}

/// Zahlen der Woche: Markierungen, Texte, Themen und Quellen.
public struct ReadingWeekStats: Decodable, Equatable, Sendable {
    public let highlights: Int
    public let texts: Int
    public let topics: Int
}

/// Balken je Thema (sonst Quelle).
public struct TopicCount: Decodable, Equatable, Hashable, Sendable {
    public let label: String
    public let count: Int
}

/// „Querverbindung entdeckt“: ähnliche Markierungen aus verschiedenen Texten.
public struct HighlightCluster: Decodable, Equatable, Identifiable, Sendable {
    public let ids: [String]
    public let items: [ReadingHighlight]

    /// Kennung für Listen und „schon angelegt“: die IDs, sortiert wie beim Server.
    public var id: String { ids.sorted().joined(separator: ",") }
}

/// Woche im Wiedersehen.
public struct ReadingWeek: Decodable, Equatable, Sendable {
    public let id: String
    public let year: Int
    public let week: Int
    public let monday: String
    public let sunday: String
    public let start: String
    public let end: String
    /// „19.10. – 25.10.“
    public let label: String
    public let prev: ReadingWeekRef
    public let next: ReadingWeekRef
    public let stats: ReadingWeekStats
    public let topics: [TopicCount]
    public let clusters: [HighlightCluster]
    /// Pfad des Markdown-Exports (`/api/lesen/wiedersehen.md?woche=…`), nil ohne Markierungen.
    public let export: String?
}

/// `GET /api/lesen/wiedersehen?woche=`
public struct ReviewCardsModel: Decodable, Equatable, Sendable {
    /// Heute schon gesehen.
    public var seen: Int
    /// Heute noch dran (= `cards.count`).
    public var left: Int
    /// Fällig, aber erst morgen (Tagesgrenze).
    public let later: Int
    public var total: Int
    /// Höchstens so viele Karten am Tag.
    public let limit: Int
    public let maxBox: Int
    /// „In eigenen Worten“ und „Als eigene Notiz anlegen“ gehen.
    public let canCapture: Bool
    public var cards: [ReviewCard]
    public let week: ReadingWeek

    /// „Heute 1 von 4 gesehen · 2 weitere morgen“, leer ohne Karten heute.
    public var progressLabel: String {
        guard total > 0 else { return "" }
        return "Heute \(seen) von \(total) gesehen\(later > 0 ? " · \(later) weitere morgen" : "")"
    }

    /// Keine Karte mehr: „Für heute reicht es“ (es kommen morgen welche) oder „Nichts fällig“.
    public var emptyTitle: String { later > 0 ? "Für heute reicht es" : "Nichts fällig" }

    public var emptyDetail: String {
        later > 0
            ? "\(later) \(later == 1 ? "Markierung kommt" : "Markierungen kommen") morgen dran."
            : "Neue Markierungen kommen einen Tag später wieder."
    }
}

// MARK: Folgen

/// Wo eine entstehende Folge steht (`progressOf`): Schritte, aktueller Schritt, Anteil (nil =
/// unbestimmt, solange Claude schreibt), geschätzte Restzeit und ein Satz dazu.
public struct EpisodeProgress: Decodable, Equatable, Sendable {
    public let steps: [String]
    public let step: Int
    public let percent: Int?
    public let fraction: Double?
    public let restMinutes: Int?
    public let label: String
}

/// „Fortsetzen“ oder „Erneut versuchen“ mit Erklärung.
public struct EpisodeRetry: Decodable, Equatable, Sendable {
    public let label: String
    public let hint: String
}

/// Ingest der Texte einer Folge (`episodeIngest`): wie viele Texte, wie viele „Texte ingesten“
/// noch anstößt, wie viele bereit zum Prüfen sind, der Stand in einem Satz und die Texte selbst
/// zum Auswählen.
public struct EpisodeIngest: Decodable, Equatable, Sendable {
    public let total: Int
    public let open: Int
    public let ready: Int
    /// Claude ist angebunden (sonst kein Knopf).
    public let available: Bool
    /// „Ingest: 1 bereit zum Prüfen · 1 im Wiki“, nil, solange nichts angestoßen ist.
    public let label: String?
    /// Die Texte der Folge; leer bei einem älteren Server (dann gehen alle zusammen).
    public let texts: [EpisodeIngestText]

    /// „Texte ingesten“ geht.
    public var canRequest: Bool { open > 0 && available }
    /// Texte, die sich noch anstoßen lassen (ohne Entwurf, fehlgeschlagen oder verworfen).
    public var openTexts: [EpisodeIngestText] { texts.filter(\.open) }
    /// Mehrere Texte und der Server nennt sie: erst auswählen, dann ingesten.
    public var choosable: Bool { total > 1 && !texts.isEmpty }

    private enum CodingKeys: String, CodingKey { case total, open, ready, available, label, texts }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = try c.decode(Int.self, forKey: .total)
        open = try c.decode(Int.self, forKey: .open)
        ready = try c.decode(Int.self, forKey: .ready)
        available = try c.decode(Bool.self, forKey: .available)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        texts = try c.decodeIfPresent([EpisodeIngestText].self, forKey: .texts) ?? []
    }
}

/// Ein Text einer Folge für die Auswahl beim Ingest.
public struct EpisodeIngestText: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let site: String?
    /// Ingest-Status (`bereit`, `wartet`, `uebernommen` …), nil ohne Entwurf.
    public let status: String?
    /// „im Wiki“, „bereit zum Prüfen“ …, nil ohne Entwurf.
    public let statusLabel: String?
    /// Lässt sich (wieder) anstoßen.
    public let open: Bool
}

/// Status einer Folge: `wartet`, `schreibt`, `spricht`, `transkript` (erst nur das Transkript,
/// Audio auf Knopfdruck), `fertig`, `fehler`.
public enum EpisodeStatus {
    public static let waiting = "wartet"
    public static let writing = "schreibt"
    public static let speaking = "spricht"
    public static let transcript = "transkript"
    public static let done = "fertig"
    public static let failed = "fehler"
}

/// Folge (`episodeJson`). Die MP3 liegt unter `/api/app/folge?id=`.
public struct Episode: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    /// `vorlesen`, `podcast` oder `report`.
    public let kind: String
    public let kindLabel: String
    public let title: String
    /// Gewünschte Länge (Podcast, Report), nil beim Vorlesen.
    public let minutes: Int?
    public let status: String
    /// Entsteht gerade (`wartet`, `schreibt`, `spricht`).
    public let busy: Bool
    /// IDs der Dokumente.
    public let docs: [String]
    public let chars: Int
    public let createdAt: String
    public let updatedAt: String?
    public let finishedAt: String?
    /// Dauer der fertigen MP3 in Sekunden.
    public let seconds: Int?
    public let bytes: Int?
    /// Vault-Pfad des Transkripts (Podcast, Report).
    public let note: String?
    /// false: erst nur das Transkript, Audio auf Knopfdruck (`speak`).
    public let audio: Bool
    /// Sprache, in der Claude geschrieben hat (`de`, `en` …), nil beim Vorlesen.
    public let language: String?
    /// Ton (`kritisch` …) und sein Name, nil beim Vorlesen.
    public let style: String?
    public let styleLabel: String?
    /// Schwerpunkt: Themen der Texte und eigener Wunsch.
    public let topics: [String]
    public let focus: String?
    /// Ton und Schwerpunkt in einer Zeile („Kritisch · Schwerpunkt: KI“), nil ohne Wünsche.
    public let wishes: String?
    /// „Audio erzeugen“ mit Erklärung, nur bei einem fertigen Transkript.
    public let speak: EpisodeRetry?
    /// Ingest der Texte, bei fertigen Folgen und Transkripten (nil ohne Ingest-Dienst).
    public let ingest: EpisodeIngest?
    public let error: String?
    public let resumable: Bool
    public let retry: EpisodeRetry?
    public let progress: EpisodeProgress?
    /// Hörstand einer fertigen Folge: `neu`, `angefangen` oder `gehoert`; nil, solange sie entsteht
    /// (und bei älteren Servern).
    public var listen: String?
    /// Wann die Folge gehört wurde (zu Ende gespielt oder von Hand markiert).
    public var heardAt: String?
    /// Gemeldete Stelle in Sekunden („angefangen, bei 3:05“).
    public var position: Int?

    public var isDone: Bool { status == EpisodeStatus.done }
    /// Fertig und gehört: steht unter „Gehört“, eingeklappt.
    public var isHeard: Bool { isDone && (listen == EpisodeListen.heard || (listen == nil && heardAt != nil)) }
    /// Fertig, angefangen, aber nicht zu Ende.
    public var isStarted: Bool { isDone && !isHeard && (position ?? 0) > 0 }

    /// Hörstand als Satz: „noch nicht gehört“, „angefangen, bei 3:05“, „gehört am 24. Okt.“.
    public func listenLabel(timeZone: TimeZone = .current) -> String? {
        guard isDone, listen != nil || heardAt != nil else { return nil }
        if isHeard { return heardAt.flatMap { WeiterFormat.day($0, timeZone: timeZone) }.map { "gehört am \($0)" } ?? "gehört" }
        if let position, position > 0 { return "angefangen, bei \(Self.clock(position))" }
        return "noch nicht gehört"
    }
    public var isFailed: Bool { status == EpisodeStatus.failed }
    /// Erst nur das Transkript ist fertig; Audio entsteht auf Knopfdruck.
    public var isTranscript: Bool { status == EpisodeStatus.transcript }

    /// Dauer wie im Web: `5:12`, `1:02:05`; sonst „10 Min.“ oder leer.
    public var durationLabel: String {
        if let seconds { return Self.clock(seconds) }
        if let minutes { return "\(minutes) Min." }
        return ""
    }

    /// `75` → `1:15`, `3725` → `1:02:05` (`clock` in src/lesen/folgen-page.js).
    public static func clock(_ seconds: Int) -> String {
        let t = max(0, seconds)
        let (h, m, s) = (t / 3600, (t % 3600) / 60, t % 60)
        let ss = s < 10 ? "0\(s)" : "\(s)"
        if h > 0 { return "\(h):\(m < 10 ? "0\(m)" : "\(m)"):\(ss)" }
        return "\(m):\(ss)"
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, kindLabel, title, minutes, status, busy, docs, chars, createdAt, updatedAt, finishedAt, seconds, bytes, note, audio, language, style, styleLabel, topics, focus, wishes, speak, ingest, error, resumable, retry, progress, listen, heardAt, position
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(String.self, forKey: .kind)
        kindLabel = try c.decodeIfPresent(String.self, forKey: .kindLabel) ?? kind
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        minutes = try c.decodeIfPresent(Int.self, forKey: .minutes)
        status = try c.decode(String.self, forKey: .status)
        busy = try c.decodeIfPresent(Bool.self, forKey: .busy) ?? [EpisodeStatus.waiting, EpisodeStatus.writing, EpisodeStatus.speaking].contains(status)
        docs = try c.decodeIfPresent([String].self, forKey: .docs) ?? []
        chars = try c.decodeIfPresent(Int.self, forKey: .chars) ?? 0
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        finishedAt = try c.decodeIfPresent(String.self, forKey: .finishedAt)
        seconds = try c.decodeIfPresent(Int.self, forKey: .seconds)
        bytes = try c.decodeIfPresent(Int.self, forKey: .bytes)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        audio = try c.decodeIfPresent(Bool.self, forKey: .audio) ?? true
        language = try c.decodeIfPresent(String.self, forKey: .language)
        style = try c.decodeIfPresent(String.self, forKey: .style)
        styleLabel = try c.decodeIfPresent(String.self, forKey: .styleLabel)
        topics = try c.decodeIfPresent([String].self, forKey: .topics) ?? []
        focus = try c.decodeIfPresent(String.self, forKey: .focus)
        wishes = try c.decodeIfPresent(String.self, forKey: .wishes)
        speak = try c.decodeIfPresent(EpisodeRetry.self, forKey: .speak)
        ingest = try c.decodeIfPresent(EpisodeIngest.self, forKey: .ingest)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        resumable = try c.decodeIfPresent(Bool.self, forKey: .resumable) ?? false
        retry = try c.decodeIfPresent(EpisodeRetry.self, forKey: .retry)
        progress = try c.decodeIfPresent(EpisodeProgress.self, forKey: .progress)
        listen = try c.decodeIfPresent(String.self, forKey: .listen)
        heardAt = try c.decodeIfPresent(String.self, forKey: .heardAt)
        position = try c.decodeIfPresent(Int.self, forKey: .position)
    }
}

/// Hörstand einer fertigen Folge (`listenOf` in src/lesen/folgen-page.js).
public enum EpisodeListen {
    public static let new = "neu"
    public static let started = "angefangen"
    public static let heard = "gehoert"
}

/// Folgen in Gruppen wie im Web (`episodeGroups`): Zum Hören (angefangene zuerst), Entsteht (auch
/// fehlgeschlagene), Nur Transkript und Gehört.
public struct EpisodeGroups: Equatable, Sendable {
    public let toHear: [Episode]
    public let inProgress: [Episode]
    public let transcripts: [Episode]
    public let heard: [Episode]

    public init(_ items: [Episode]) {
        let done = items.filter(\.isDone)
        let open = done.filter { !$0.isHeard }
        toHear = open.filter(\.isStarted) + open.filter { !$0.isStarted }
        inProgress = items.filter { $0.busy || $0.isFailed }
        transcripts = items.filter(\.isTranscript)
        heard = done.filter(\.isHeard)
    }
}

/// Was einer Art fehlt (z. B. ElevenLabs oder Claude), nil = geht.
public struct EpisodeAvailability: Decodable, Equatable, Sendable {
    public let vorlesen: String?
    public let podcast: String?
    public let report: String?

    public subscript(kind: String) -> String? {
        switch kind {
        case "vorlesen": vorlesen
        case "podcast": podcast
        case "report": report
        default: "Unbekannte Art"
        }
    }
}

/// Art einer Folge für „Was soll daraus werden?“.
public struct EpisodeKindInfo: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let kind: String
    public let label: String
    public let description: String
    /// „Kosten nach Textlänge, Gehörtes ist gratis“ bzw. „900 Zeichen je Minute, dazu Claude“.
    public let cost: String
    /// Warum die Art gerade nicht geht, nil = geht.
    public let missing: String?

    public var id: String { kind }
    public var isAvailable: Bool { missing == nil }
}

/// Ton von Podcast und Report (`STYLES` in src/lesen/folgen.js).
public struct EpisodeStyleInfo: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let style: String
    public let label: String
    public let description: String

    public var id: String { style }
}

/// Thema der Texte für den Schwerpunkt, mit der Zahl der Texte dazu.
public struct EpisodeTopic: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let label: String
    public let count: Int

    public var id: String { label }
}

/// `GET /api/lesen/folgen`; ohne Folgen `enabled: false`.
public struct EpisodeListModel: Decodable, Equatable, Sendable {
    public let enabled: Bool
    public var items: [Episode]
    public let availability: EpisodeAvailability?
    public let kinds: [EpisodeKindInfo]

    enum CodingKeys: String, CodingKey { case enabled, items, availability, kinds }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        items = try c.decodeIfPresent([Episode].self, forKey: .items) ?? []
        availability = try c.decodeIfPresent(EpisodeAvailability.self, forKey: .availability)
        kinds = try c.decodeIfPresent([EpisodeKindInfo].self, forKey: .kinds) ?? []
    }

    /// Eine Folge entsteht gerade (dann fragt die Liste alle 3 s nach).
    public var hasBusy: Bool { items.contains(where: \.busy) }
}

/// Satz am Knopf von „Neue Folge“: `main` (Art, Texte, Dauer) und `cost`.
public struct EpisodeSummary: Decodable, Equatable, Sendable {
    public let main: String
    public let cost: String

    public init(main: String, cost: String) {
        self.main = main
        self.cost = cost
    }
}

/// `GET /api/lesen/folgen/neu?zeit=`; ohne Folgen `enabled: false`.
public struct NewEpisodeModel: Decodable, Equatable, Sendable {
    public let enabled: Bool
    public let zeit: Int?
    public let windows: [Int]
    /// Texte des Zeitfensters (alle vorausgewählt) mit Zeichen fürs Vorlesen.
    public let docs: [StackItem]
    public let chars: Int
    public let availability: EpisodeAvailability?
    public let kinds: [EpisodeKindInfo]
    /// Erste mögliche Art, nil = keine geht.
    public let defaultKind: String?
    /// 5, 10, 20 Minuten (Podcast, Report).
    public let lengths: [Int]
    public let defaultLength: Int
    public let maxDocs: Int
    public let spokenCharsPerMinute: Int
    /// Podcast und Report: Ton (leer = Server kennt keinen), Themen der Texte, Grenzen und ob
    /// „erst nur Transkript“ geht.
    public let styles: [EpisodeStyleInfo]
    public let defaultStyle: String?
    public let topics: [EpisodeTopic]
    public let maxTopics: Int
    public let maxFocus: Int
    public let transcriptOnly: Bool
    /// Sprache aus den Einstellungen, in der Claude schreibt („Deutsch“), nil bei älteren Servern.
    public let languageLabel: String?
    public let summary: EpisodeSummary?
    public let summaries: [String: EpisodeSummary]

    enum CodingKeys: String, CodingKey {
        case enabled, zeit, windows, docs, chars, availability, kinds, defaultKind, lengths, defaultLength, maxDocs, spokenCharsPerMinute, styles, defaultStyle, topics, maxTopics, maxFocus, transcriptOnly, languageLabel, summary, summaries
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        zeit = try c.decodeIfPresent(Int.self, forKey: .zeit)
        windows = try c.decodeIfPresent([Int].self, forKey: .windows) ?? [5, 15, 30, 60]
        docs = try c.decodeIfPresent([StackItem].self, forKey: .docs) ?? []
        chars = try c.decodeIfPresent(Int.self, forKey: .chars) ?? 0
        availability = try c.decodeIfPresent(EpisodeAvailability.self, forKey: .availability)
        kinds = try c.decodeIfPresent([EpisodeKindInfo].self, forKey: .kinds) ?? []
        defaultKind = try c.decodeIfPresent(String.self, forKey: .defaultKind)
        lengths = try c.decodeIfPresent([Int].self, forKey: .lengths) ?? [5, 10, 20]
        defaultLength = try c.decodeIfPresent(Int.self, forKey: .defaultLength) ?? 10
        maxDocs = try c.decodeIfPresent(Int.self, forKey: .maxDocs) ?? 20
        spokenCharsPerMinute = try c.decodeIfPresent(Int.self, forKey: .spokenCharsPerMinute) ?? 900
        styles = try c.decodeIfPresent([EpisodeStyleInfo].self, forKey: .styles) ?? []
        defaultStyle = try c.decodeIfPresent(String.self, forKey: .defaultStyle)
        topics = try c.decodeIfPresent([EpisodeTopic].self, forKey: .topics) ?? []
        maxTopics = try c.decodeIfPresent(Int.self, forKey: .maxTopics) ?? 5
        maxFocus = try c.decodeIfPresent(Int.self, forKey: .maxFocus) ?? 200
        transcriptOnly = try c.decodeIfPresent(Bool.self, forKey: .transcriptOnly) ?? false
        languageLabel = try c.decodeIfPresent(String.self, forKey: .languageLabel)
        summary = try c.decodeIfPresent(EpisodeSummary.self, forKey: .summary)
        summaries = try c.decodeIfPresent([String: EpisodeSummary].self, forKey: .summaries) ?? [:]
    }
}

// MARK: Verbinden

/// Ähnliche Markierung aus einem anderen Text.
public struct ConnectionHighlight: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let id: String
    public let docId: String
    public let title: String?
    public let text: String
    public let note: String?
    /// Web-Pfad `/lesen/doc?id=…#h-…`.
    public let href: String
    public let score: Double?
    public let linked: Bool
}

/// Passende Notiz im Vault (Synthese, Konzept; im Volltext auch andere).
public struct ConnectionNote: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let path: String
    public let title: String?
    public let type: String?
    public let heading: String?
    public let text: String?
    public let href: String?
    public let score: Double?
    public let linked: Bool

    public var id: String { "\(path)#\(heading ?? "")" }
}

/// Schon verknüpftes Ziel (Wikilink), mit Web-Pfad, wenn das Cockpit es zeigen darf.
public struct LinkedTarget: Decodable, Equatable, Hashable, Sendable {
    public let target: String
    public let href: String?
}

/// `GET /api/lesen/verbindungen?markierung=` bzw. `?doc=&text=`.
public struct ConnectionsModel: Decodable, Equatable, Sendable {
    public let highlightId: String?
    public let docId: String
    /// `semantic` oder `text` (nur Volltext).
    public let source: String
    /// Warum nur Volltext.
    public let problem: String?
    public let highlights: [ConnectionHighlight]
    public let notes: [ConnectionNote]
    public let linked: [LinkedTarget]

    /// „Synthesen und Konzepte“, im Volltext „Aus dem Vault“.
    public var notesTitle: String { source == "text" ? "Aus dem Vault" : "Synthesen und Konzepte" }
    public var isEmpty: Bool { highlights.isEmpty && notes.isEmpty }
}

// MARK: Antworten der Aktionen

/// Dokument in der Antwort einer Aktion (`speichern`, `pdf`, `sortieren`, Entscheidungen).
public struct ReadingActionDoc: Decodable, Equatable, Sendable {
    public let id: String
    public let title: String?
    public let status: ReadingStatus?
}

/// Antwort einer Aktion unter `/aktion/lesen/…`: `ActionResponse` plus `doc`, `highlight`
/// (neue Markierung), `duplicate`, `progress`, `link` (Verbinden) und `result` (In Inbox).
public struct ReadingActionResponse: ActionReply, Equatable, Sendable {
    public struct HighlightRef: Decodable, Equatable, Sendable {
        public let id: String
    }

    public struct Link: Decodable, Equatable, Sendable {
        public let target: String
        public let path: String?
    }

    public let ok: Bool
    public let message: String
    public let undo: UndoAction?
    public let redirect: String?
    public let doc: ReadingActionDoc?
    public let highlight: HighlightRef?
    /// Schon vorhanden (gleiche `cid`): nichts Neues angelegt.
    public let duplicate: Bool
    public let progress: Double?
    public let link: Link?
    public let result: CaptureResult?

    enum CodingKeys: String, CodingKey { case ok, message, undo, redirect, doc, highlight, duplicate, progress, link, result }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        undo = try c.decodeIfPresent(UndoAction.self, forKey: .undo)
        redirect = try c.decodeIfPresent(String.self, forKey: .redirect)
        doc = try c.decodeIfPresent(ReadingActionDoc.self, forKey: .doc)
        highlight = try c.decodeIfPresent(HighlightRef.self, forKey: .highlight)
        duplicate = try c.decodeIfPresent(Bool.self, forKey: .duplicate) ?? false
        progress = try c.decodeIfPresent(Double.self, forKey: .progress)
        link = try c.decodeIfPresent(Link.self, forKey: .link)
        result = try c.decodeIfPresent(CaptureResult.self, forKey: .result)
    }
}
