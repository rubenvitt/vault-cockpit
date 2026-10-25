import Foundation

// Modelle für `GET /api/woche` (src/cockpit/data.js, `cockpit.week`). Datumsangaben bleiben
// Text wie vom Server (`2026-10-16` oder RFC 3339), `CockpitFormat` macht daraus Anzeige und `Date`.

/// Abschnitt, den der Server für sich holt: `{ok: true, data}` oder `{ok: false, error, unconfigured}`.
/// Fällt eine Quelle aus, zeigt nur ihr Abschnitt den Fehler. (Nicht `Section`: so heißt eine SwiftUI-Ansicht.)
public enum SectionState<Value> {
    case ok(Value)
    case failed(SectionError)

    public var value: Value? {
        if case .ok(let value) = self { value } else { nil }
    }

    public var error: SectionError? {
        if case .failed(let error) = self { error } else { nil }
    }

    /// Ändert den Inhalt, wenn es einen gibt (optimistische Änderungen).
    public mutating func update(_ change: (inout Value) -> Void) {
        guard case .ok(var value) = self else { return }
        change(&value)
        self = .ok(value)
    }
}

/// Fehler eines Abschnitts. `unconfigured`: Zunder bzw. Kalender ist nicht eingerichtet
/// (dann mit Verweis auf die Einstellungen).
public struct SectionError: Decodable, Equatable, Sendable {
    public let error: String
    public let unconfigured: Bool

    public init(error: String, unconfigured: Bool = false) {
        self.error = error
        self.unconfigured = unconfigured
    }
}

/// Inhalt, der neben `ok` steht statt unter `data` (Big Rocks mit `partial`, Termine mit
/// `errors`, Rückblick und Planung auf oberster Ebene).
public protocol SectionBody: Decodable {}

extension SectionState: Decodable where Value: Decodable {
    private enum Keys: String, CodingKey { case ok, data, error, unconfigured }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        if try container.decode(Bool.self, forKey: .ok) {
            if let body = Value.self as? SectionBody.Type {
                // swiftlint:disable:next force_cast
                self = .ok(try body.init(from: decoder) as! Value)
            } else {
                self = .ok(try container.decode(Value.self, forKey: .data))
            }
        } else {
            let error = try container.decodeIfPresent(String.self, forKey: .error) ?? "Unbekannter Fehler"
            let unconfigured = try container.decodeIfPresent(Bool.self, forKey: .unconfigured) ?? false
            self = .failed(SectionError(error: error, unconfigured: unconfigured))
        }
    }
}

extension SectionState: Equatable where Value: Equatable {}
extension SectionState: Sendable where Value: Sendable {}

/// Status einer Zunder-Aufgabe. Offen für Werte, die die App noch nicht kennt.
public struct TaskStatus: RawRepresentable, Codable, Hashable, Sendable, ExpressibleByStringLiteral {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { rawValue = value }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static let open: TaskStatus = "open"
    public static let inProgress: TaskStatus = "in_progress"
    public static let review: TaskStatus = "review"
    public static let blocked: TaskStatus = "blocked"
    public static let done: TaskStatus = "done"
    public static let dropped: TaskStatus = "dropped"

    /// Status, die das Cockpit setzen darf (`SETTABLE` in src/cockpit/actions.js).
    public static let settable: [TaskStatus] = [.open, .inProgress, .blocked, .done, .dropped]

    /// Zeichen ohne Schreibrecht: ✓ ◐ ⏸ ◑ ○.
    public var mark: String {
        switch self {
        case .done: "✓"
        case .inProgress: "◐"
        case .blocked: "⏸"
        case .review: "◑"
        default: "○"
        }
    }

    /// Bezeichnung wie die Knöpfe im Menü.
    public var label: String {
        switch self {
        case .open: "Offen"
        case .inProgress: "In Arbeit"
        case .blocked: "Blockiert"
        case .review: "Review"
        case .done: "Erledigt"
        case .dropped: "Verworfen"
        default: rawValue
        }
    }
}

/// Phönix-Rolle als Text, so wie sie im Wochenmodell steht.
public enum PhoenixRole {
    public static let flame = "flamme"
    public static let step = "feuer_schritt"
}

/// Aufgabe aus Zunder, wie Wochenansicht, Rückblick und Planung sie liefern (`make` in
/// src/cockpit/data.js). Je nach Liste kommen Felder dazu: Flammen mit `startedAt`, `endedAt`,
/// `minutes`, „Aufgaben“ mit `overdue`, Planung mit `planned`.
public struct ZunderTask: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public var ref: String?
    public var title: String
    public var status: TaskStatus
    /// `2026-10-16` oder RFC 3339 (Flammen mit Uhrzeit).
    public var due: String?
    /// Lebensbereich (über das Projekt), „Inbox“ oder „Ohne Bereich“.
    public var area: String
    public var project: String?
    /// `flamme`, `feuer_schritt` oder nil (`PhoenixRole`).
    public var phoenix: String?
    /// Woche der Phönix-Markierung, z. B. `2026-W42`.
    public var fire: String?
    /// Flamme läuft gerade.
    public var running: Bool
    /// Link in die Zunder-Oberfläche.
    public var url: String?
    public var startedAt: String?
    public var endedAt: String?
    /// Gemessene Minuten einer beendeten Flamme.
    public var minutes: Int?
    public var overdue: Bool
    /// Planung: warum die Aufgabe in der Woche steht (`flamme`, `feuer_schritt`, `faellig`).
    public var planned: String?

    public init(id: String, ref: String? = nil, title: String, status: TaskStatus = .open, due: String? = nil, area: String = "Ohne Bereich", project: String? = nil, phoenix: String? = nil, fire: String? = nil, running: Bool = false, url: String? = nil, startedAt: String? = nil, endedAt: String? = nil, minutes: Int? = nil, overdue: Bool = false, planned: String? = nil) {
        self.id = id
        self.ref = ref
        self.title = title
        self.status = status
        self.due = due
        self.area = area
        self.project = project
        self.phoenix = phoenix
        self.fire = fire
        self.running = running
        self.url = url
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.minutes = minutes
        self.overdue = overdue
        self.planned = planned
    }

    enum CodingKeys: String, CodingKey {
        case id, ref, title, status, due, area, project, phoenix, fire, running, url, startedAt, endedAt, minutes, overdue, planned
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        title = try c.decode(String.self, forKey: .title)
        status = try c.decodeIfPresent(TaskStatus.self, forKey: .status) ?? .open
        due = try c.decodeIfPresent(String.self, forKey: .due)
        area = try c.decodeIfPresent(String.self, forKey: .area) ?? "Ohne Bereich"
        project = try c.decodeIfPresent(String.self, forKey: .project)
        phoenix = try c.decodeIfPresent(String.self, forKey: .phoenix)
        fire = try c.decodeIfPresent(String.self, forKey: .fire)
        running = try c.decodeIfPresent(Bool.self, forKey: .running) ?? false
        url = try c.decodeIfPresent(String.self, forKey: .url)
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        endedAt = try c.decodeIfPresent(String.self, forKey: .endedAt)
        minutes = try c.decodeIfPresent(Int.self, forKey: .minutes)
        overdue = try c.decodeIfPresent(Bool.self, forKey: .overdue) ?? false
        planned = try c.decodeIfPresent(String.self, forKey: .planned)
    }

    public var link: URL? { url.flatMap(URL.init(string:)) }
    public var isDone: Bool { status == .done }
    public var isFlame: Bool { phoenix == PhoenixRole.flame }
    /// Phönix-Schritt einer Woche (Wert für `prev` bei `/aktion/phoenix`), sonst leer.
    public var stepWeek: String { phoenix == PhoenixRole.step ? (fire ?? "") : "" }
    /// „VCP-47 Titel“ wie in den Meldungen.
    public var name: String { ref.map { "\($0) \(title)" } ?? title }
    /// Fälligkeit als Tag (`JJJJ-MM-TT`), für das Datumsfeld und `prev` bei `/aktion/faellig`.
    public var dueDay: String { due.map { String($0.prefix(10)) } ?? "" }
    public var startedDate: Date? { startedAt.flatMap(CockpitFormat.date(from:)) }
    /// Flamme starten oder stoppen geht, solange sie nicht erledigt oder verworfen ist.
    public var canFlame: Bool { status != .done && status != .dropped }
}

/// Kopf jeder Woche (`describeWeek`): Kennung, Montag bis Sonntag, Nachbarn.
public struct WeekInfo: Decodable, Equatable, Sendable {
    public let id: String
    public let year: Int
    public let week: Int
    public let monday: String
    public let sunday: String
    public let prev: String
    public let next: String
    public let current: Bool
    /// Woche ist vorbei (Rückblick liefert das nicht, dann false).
    public let past: Bool
    /// Nur Planung: die sieben Tage mit `today`.
    public let days: [WeekDay]

    enum CodingKeys: String, CodingKey { case id, year, week, monday, sunday, prev, next, current, past, days }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        year = try c.decode(Int.self, forKey: .year)
        week = try c.decode(Int.self, forKey: .week)
        monday = try c.decode(String.self, forKey: .monday)
        sunday = try c.decode(String.self, forKey: .sunday)
        prev = try c.decode(String.self, forKey: .prev)
        next = try c.decode(String.self, forKey: .next)
        current = try c.decodeIfPresent(Bool.self, forKey: .current) ?? false
        past = try c.decodeIfPresent(Bool.self, forKey: .past) ?? false
        days = try c.decodeIfPresent([WeekDay].self, forKey: .days) ?? []
    }

    /// „KW 42“
    public var label: String { "KW \(week)" }
}

public struct WeekDay: Decodable, Equatable, Identifiable, Sendable {
    public let date: String
    /// „Mo 12.10.“
    public let label: String
    public let today: Bool
    public var id: String { date }
}

/// Feuer-Notiz der Woche (src/cockpit/feuer.js).
public struct Feuer: Decodable, Equatable, Sendable {
    public let path: String
    public let title: String
    public let status: String?
    public let zeitraum: String?
    public let alignment: String?
    /// Erster Absatz unter „Feuer-Ziel“ mit leichtem Markdown; nil ohne den Abschnitt.
    public var goal: String?
    /// Erster Absatz unter „Erster Zug“.
    public var firstMove: String?
}

/// Big Rocks eines Lebensbereichs; `done` zählt die erledigten Aufgaben.
public struct RockGroup: Decodable, Equatable, Identifiable, Sendable {
    public let area: String
    public var tasks: [ZunderTask]
    public var done: Int
    public var id: String { area }
    public var allDone: Bool { !tasks.isEmpty && done == tasks.count }
    /// Zählt neu, wie `recount` in cockpit.js nach dem Abhaken.
    public mutating func recount() { done = tasks.filter(\.isDone).count }
}

/// Big Rocks: `partial`, wenn nur eine der beiden Zunder-Abfragen geantwortet hat.
public struct Rocks: SectionBody, Equatable, Sendable {
    public var groups: [RockGroup]
    public let partial: Bool

    enum CodingKeys: String, CodingKey { case data, partial }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groups = try c.decodeIfPresent([RockGroup].self, forKey: .data) ?? []
        partial = try c.decodeIfPresent(Bool.self, forKey: .partial) ?? false
    }
}

public struct CalendarEvent: Decodable, Equatable, Identifiable, Sendable {
    public let title: String
    /// ISO 8601 mit Millisekunden.
    public let start: String
    public let end: String
    public let allDay: Bool
    public let location: String?
    /// Name des Kalenders, aus dem der Termin kommt.
    public let calendar: String?
    public var id: String { "\(calendar ?? "")|\(start)|\(title)" }
    public var startDate: Date? { CockpitFormat.date(from: start) }
    public var endDate: Date? { CockpitFormat.date(from: end) }
}

public struct CalendarDay: Decodable, Equatable, Identifiable, Sendable {
    public let date: String
    public let label: String
    public let today: Bool
    public let events: [CalendarEvent]
    public var id: String { date }
}

/// Fehler eines einzelnen Kalenders; die anderen liefern weiter.
public struct CalendarFailure: Decodable, Equatable, Sendable {
    public let calendar: String
    public let error: String
}

/// Termine der Woche je Tag, dazu die Kalender, die nicht geantwortet haben.
public struct WeekCalendar: SectionBody, Equatable, Sendable {
    public let days: [CalendarDay]
    public let errors: [CalendarFailure]

    enum CodingKeys: String, CodingKey { case data, errors }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        days = try c.decodeIfPresent([CalendarDay].self, forKey: .data) ?? []
        errors = try c.decodeIfPresent([CalendarFailure].self, forKey: .errors) ?? []
    }

    /// Stelle von heute; Tage davor sind vorbei (nur in der laufenden Woche).
    public var todayIndex: Int? { days.firstIndex(where: \.today) }

    /// Tag vor heute: tritt zurück und zeigt nur die Zahl seiner Termine.
    public func isPast(_ day: CalendarDay) -> Bool {
        guard let today = todayIndex, let index = days.firstIndex(where: { $0.date == day.date }) else { return false }
        return index < today
    }

    /// Hinweis neben „Termine“: „heute 2 Termine“, „heute frei“; nil, wenn heute nicht in der Woche liegt.
    public var todayHint: String? {
        guard let today = todayIndex else { return nil }
        let count = days[today].events.count
        return count > 0 ? "heute \(CockpitFormat.events(count))" : "heute frei"
    }
}

/// Notiz im Inbox-Ordner des Vaults.
public struct InboxNote: Decodable, Equatable, Identifiable, Sendable {
    public let path: String
    public let title: String
    public let type: String?
    public let updated: String?
    public var id: String { path }

    public init(path: String, title: String, type: String? = nil, updated: String? = nil) {
        self.path = path
        self.title = title
        self.type = type
        self.updated = updated
    }

    enum CodingKeys: String, CodingKey { case path, title, type, updated }

    /// Notizen ohne Titel im Index (`title` null) heißen wie die Datei, wie in render.js.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        let file = path.split(separator: "/").last.map(String.init) ?? path
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? (file.lowercased().hasSuffix(".md") ? String(file.dropLast(3)) : file)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        updated = try c.decodeIfPresent(String.self, forKey: .updated)
    }
}

/// Ziel für „Zuordnen“: ein Bereich mit seinen aktiven Projekten.
public struct MoveTarget: Decodable, Equatable, Identifiable, Sendable {
    public struct Project: Decodable, Equatable, Identifiable, Sendable {
        public let id: String
        public let name: String
    }

    public let id: String
    public let name: String
    public let projects: [Project]
}

public struct Inbox: Decodable, Equatable, Sendable {
    public var vault: SectionState<[InboxNote]>
    public var zunder: SectionState<[ZunderTask]>
    /// Ziele für „Zuordnen“; nil, wenn Zunder die Struktur gerade nicht liefert.
    public let targets: [MoveTarget]?
    /// Inbox-Ordner aus den Einstellungen.
    public let folder: String?

    /// Zahl im Abzeichen: Notizen und Zunder-Aufgaben.
    public var count: Int { (vault.value?.count ?? 0) + (zunder.value?.count ?? 0) }
}

/// Was das Cockpit auf der Wochenseite anbietet (`can` in `/api/woche`, wie `writeContext` der
/// HTML-Seite): Aktionen überhaupt, Feuer-Notiz bearbeiten und anlegen, Planen.
public struct WeekCapabilities: Decodable, Equatable, Sendable {
    public let actions: Bool
    public let notes: Bool
    public let plan: Bool

    public init(actions: Bool, notes: Bool, plan: Bool) {
        self.actions = actions
        self.notes = notes
        self.plan = plan
    }

    /// Ältere Server ohne `can`: alles anbieten, der Server lehnt ab, was er nicht kann.
    public static let all = WeekCapabilities(actions: true, notes: true, plan: true)
}

/// `GET /api/woche?woche=`: alles, was die Wochenseite zeigt.
public struct WeekModel: Decodable, Equatable, Sendable {
    public let tz: String
    public let vaultName: String?
    public let week: WeekInfo
    /// Heute in der Zeitzone des Cockpits (`JJJJ-MM-TT`).
    public let today: String
    /// `.ok(nil)`: Für diese Woche gibt es keine Feuer-Notiz.
    public var feuer: SectionState<Feuer?>
    /// Die gerade laufende Flamme, egal aus welcher Woche.
    public var burning: ZunderTask?
    public var flames: SectionState<[ZunderTask]>
    public var rocks: SectionState<Rocks>
    public var calendar: SectionState<WeekCalendar>
    /// In Arbeit und überfällig.
    public var tasks: SectionState<[ZunderTask]>
    public var inbox: Inbox
    /// Fehlt bei Servern vor der nativen Woche; `capabilities` setzt dann alles.
    public let can: WeekCapabilities?
    /// Dienste mit Fehler (roter Hinweis „Störung“ im Kopf, führt zum Zustand); fehlt bei
    /// älteren Servern.
    public let alert: [ServiceAlert]?

    /// Gestörte Dienste, leer wenn alles läuft.
    public var failingServices: [ServiceAlert] { alert ?? [] }

    public var timeZone: TimeZone { TimeZone(identifier: tz) ?? .current }
    /// Wie `writeContext` im Web: Notizen und Planen gibt es nur zusammen mit den Aktionen.
    public var capabilities: WeekCapabilities {
        guard let can else { return .all }
        return WeekCapabilities(actions: can.actions, notes: can.actions && can.notes, plan: can.actions && can.plan)
    }

    /// Alle Aufgaben mit dieser ID, in allen Listen (eine Aufgabe kann in mehreren stehen).
    public func tasks(withID id: String) -> [ZunderTask] {
        var found: [ZunderTask] = []
        if let burning, burning.id == id { found.append(burning) }
        found += flames.value?.filter { $0.id == id } ?? []
        found += rocks.value?.groups.flatMap(\.tasks).filter { $0.id == id } ?? []
        found += tasks.value?.filter { $0.id == id } ?? []
        found += inbox.zunder.value?.filter { $0.id == id } ?? []
        return found
    }

    /// Ändert jede Kopie der Aufgabe und zählt die Big Rocks neu.
    public mutating func updateTask(id: String, _ change: (inout ZunderTask) -> Void) {
        func apply(_ list: inout [ZunderTask]) {
            for i in list.indices where list[i].id == id { change(&list[i]) }
        }
        if burning?.id == id, var task = burning {
            change(&task)
            burning = task
        }
        flames.update(apply)
        tasks.update(apply)
        inbox.zunder.update(apply)
        rocks.update { rocks in
            for g in rocks.groups.indices {
                apply(&rocks.groups[g].tasks)
                rocks.groups[g].recount()
            }
        }
    }
}
