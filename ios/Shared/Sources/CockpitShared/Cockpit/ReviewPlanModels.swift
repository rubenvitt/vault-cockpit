import Foundation

// Modelle für `GET /api/rueckblick` (`cockpit.review`, src/cockpit/data.js) und
// `GET /api/planen` (`plan.view`, src/cockpit/plan.js). Beide sind auf oberster Ebene
// `ok`/`error`/`unconfigured`: Ohne Zunder gibt es nur Kopf und Fehler.

/// `GET /api/rueckblick?woche=`: geplant gegen erledigt je Lebensbereich, Flammen-Zeit.
public struct ReviewModel: Decodable, Equatable, Sendable {
    public let tz: String
    public let week: WeekInfo
    public let content: SectionState<ReviewContent>

    enum CodingKeys: String, CodingKey { case tz, week }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tz = try c.decode(String.self, forKey: .tz)
        week = try c.decode(WeekInfo.self, forKey: .week)
        content = try SectionState<ReviewContent>(from: decoder)
    }
}

public struct ReviewContent: SectionBody, Equatable, Sendable {
    public let areas: [ReviewArea]
    public let totals: ReviewTotals
    /// Flammen, die in der Woche begonnen haben, mit `minutes`.
    public let flames: [ZunderTask]

    /// In dieser Woche war nichts geplant und nichts wurde erledigt.
    public var isEmpty: Bool { areas.isEmpty && flames.isEmpty }
    /// Größte Flammen-Zeit eines Bereichs (Maßstab der Balken).
    public var maxMinutes: Int { areas.map(\.minutes).max() ?? 0 }
}

public struct ReviewArea: Decodable, Equatable, Identifiable, Sendable {
    public let area: String
    public let planned: Int
    public let done: Int
    /// Erledigt, aber nicht geplant („+N außerdem“).
    public let extra: Int
    public let minutes: Int
    /// Offen geblieben, nach Fälligkeit.
    public let open: [ZunderTask]
    public var id: String { area }
}

public struct ReviewTotals: Decodable, Equatable, Sendable {
    public let planned: Int
    public let done: Int
    public let extra: Int
    public let minutes: Int

    /// Anteil geplant erledigt in Prozent (0 ohne Geplantes).
    public var percent: Int { planned > 0 ? Int((Double(done) / Double(planned) * 100).rounded()) : 0 }
}

/// Suche der Planungsseite: `q` (Text oder Kennung wie VCP-47), `area` (Bereichs-ID),
/// `from` (Aufgaben-ID für „Als Flamme“).
public struct PlanQuery: Equatable, Hashable, Sendable {
    public var q: String
    public var area: String
    public var from: String

    public init(q: String = "", area: String = "", from: String = "") {
        self.q = q
        self.area = area
        self.from = from
    }

    /// Ohne Suchbegriff und Bereich sucht der Server nicht.
    public var searches: Bool { !q.trimmingCharacters(in: .whitespaces).isEmpty || !area.isEmpty }
}

/// `GET /api/planen?woche=&q=&bereich=&aus=`
public struct PlanModel: Decodable, Equatable, Sendable {
    public struct Query: Decodable, Equatable, Sendable {
        public let q: String
        public let area: String
    }

    public let tz: String
    public let today: String
    /// Was der Server von der Anfrage übernommen hat (ungültige Werte fallen weg).
    public let query: Query
    /// Mit `days` (`today` markiert).
    public let week: WeekInfo
    public let content: SectionState<PlanContent>

    enum CodingKeys: String, CodingKey { case tz, today, query, week }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tz = try c.decode(String.self, forKey: .tz)
        today = try c.decode(String.self, forKey: .today)
        query = try c.decode(Query.self, forKey: .query)
        week = try c.decode(WeekInfo.self, forKey: .week)
        content = try SectionState<PlanContent>(from: decoder)
    }

    /// Vorgabe für „Tag“ einer neuen Flamme: heute, wenn es in der Woche liegt, sonst Montag.
    public var defaultFlameDay: String {
        week.days.first(where: \.today)?.date ?? week.monday
    }
}

public struct PlanContent: SectionBody, Equatable, Sendable {
    /// Bereiche für die Auswahl („Alle Bereiche“); nil, wenn Zunder die Struktur nicht liefert.
    public let areas: [PlanArea]?
    /// Treffer der Suche; nil ohne Suchbegriff und Bereich.
    public let results: SectionState<[ZunderTask]>?
    /// Je Bereich der Big Rocks: offene Aufgaben ohne Termin.
    public let suggestions: [PlanSuggestion]
    /// Was schon in der Woche steht.
    public let planned: PlannedWeek
    /// Aufgabe, aus der „Flamme einplanen“ eine Unteraufgabe macht.
    public let from: ZunderTask?
}

public struct PlanArea: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
}

public struct PlanSuggestion: Decodable, Equatable, Identifiable, Sendable {
    public let area: String
    public let areaId: String
    public let ok: Bool
    public let error: String?
    /// Höchstens fünf; `more` zählt den Rest („und N weitere“).
    public let tasks: [ZunderTask]
    public let more: Int
    public var id: String { areaId }
}

public struct PlanRockGroup: Decodable, Equatable, Identifiable, Sendable {
    public let area: String
    public let areaId: String?
    public let tasks: [ZunderTask]
    public var id: String { area }
}

/// „In KW n“: Flammen und Big Rocks der Woche.
public struct PlannedWeek: Decodable, Equatable, Sendable {
    public let ok: Bool
    /// Nur eine der beiden Zunder-Abfragen hat geantwortet.
    public let partial: Bool
    public let error: String?
    public let flames: [ZunderTask]
    public let rocks: [PlanRockGroup]
}

/// Warum eine Aufgabe in der Planung schon in der Woche steht (`planned`).
public enum PlanReason {
    public static let flame = PhoenixRole.flame
    public static let step = PhoenixRole.step
    public static let due = "faellig"

    /// Pille wie `candidate` in plan-page.js: „Flamme KW 42“, „Phönix-Schritt KW 42“, „fällig KW 42“.
    public static func label(_ reason: String, week: WeekInfo) -> String {
        let why = reason == flame ? "Flamme" : reason == step ? "Phönix-Schritt" : "fällig"
        return "\(why) \(week.label)"
    }
}

extension ZunderTask {
    /// Meta-Zeile der Planung (`meta` in plan-page.js): Kennung · Bereich / Projekt · Fälligkeit ·
    /// Status. Ohne Bereich (Vorschläge eines Bereichs) nur das Projekt.
    public func planMeta(timeZone: TimeZone, showArea: Bool = true) -> String {
        let place = showArea ? (project.map { "\(area) / \($0)" } ?? area) : project
        return CockpitFormat.meta([ref, place, CockpitFormat.dueLabel(due, timeZone: timeZone), planStatus])
    }

    /// „in Arbeit“ und „blockiert“ (`STATUS_LABEL`), sonst nichts.
    public var planStatus: String? {
        switch status {
        case .inProgress: "in Arbeit"
        case .blocked: "blockiert"
        default: nil
        }
    }

    /// Zeichen in „In KW n“: ✓ erledigt, 🕯️ Flamme, ○ sonst.
    public var planMark: String {
        isDone ? "✓" : isFlame ? "🕯️" : "○"
    }

    /// Erledigt oder verworfen: kein „Aus der Woche“ mehr.
    public var isClosed: Bool { status == .done || status == .dropped }
}

/// `GET /api/erfassen/vorschau?text=`: was beim Absenden entstünde.
public struct CapturePreview: Decodable, Equatable, Sendable {
    /// `note`, `task` oder `article`.
    public let kind: String
    /// „Aufgabe · morgen · Gesundheit · Phönix-Schritt KW 42“
    public let summary: String
    public let title: String?
    public let due: String?
    public let dueLabel: String?
    public let location: TaskLocation?
    public let phoenix: PhoenixMark?
    /// Hinweise, z. B. „#nirgends passt zu keinem Bereich und keinem Projekt.“
    public let notes: [String]

    enum CodingKeys: String, CodingKey { case kind, summary, title, due, dueLabel, location, phoenix, notes }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title)
        due = try c.decodeIfPresent(String.self, forKey: .due)
        dueLabel = try c.decodeIfPresent(String.self, forKey: .dueLabel)
        location = try c.decodeIfPresent(TaskLocation.self, forKey: .location)
        phoenix = try c.decodeIfPresent(PhoenixMark.self, forKey: .phoenix)
        notes = try c.decodeIfPresent([String].self, forKey: .notes) ?? []
    }

    /// Unter dem Feld steht nur etwas für Aufgaben und Artikel.
    public var isShown: Bool { kind == "task" || kind == "article" }
    /// Zeile wie im Web: Zusammenfassung, dahinter die Hinweise.
    public var line: String { notes.isEmpty ? summary : "\(summary) · \(notes.joined(separator: " "))" }
}
