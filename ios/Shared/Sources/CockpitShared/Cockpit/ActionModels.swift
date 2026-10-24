import Foundation

// Teile der Antworten auf `/aktion/…` (src/web/http.js, src/web/plan-page.js).

/// Formular, das den alten Stand wiederherstellt: `{action: '/aktion/…', fields}`.
public struct UndoAction: Decodable, Equatable, Hashable, Sendable {
    public let action: String
    public let fields: [String: String]

    public init(action: String, fields: [String: String]) {
        self.action = action
        self.fields = fields
    }

    enum CodingKeys: String, CodingKey { case action, fields }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        action = try c.decode(String.self, forKey: .action)
        // Formularwerte sind Text; Zahlen (z. B. `line`) kommen als Zahl und werden Text.
        let raw = try c.decodeIfPresent([String: FormValue].self, forKey: .fields) ?? [:]
        fields = raw.mapValues(\.text)
    }
}

/// Ein Wert in `undo.fields`: Text, Zahl, Wahrheitswert oder null.
private struct FormValue: Decodable {
    let text: String

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { text = "" }
        else if let s = try? c.decode(String.self) { text = s }
        else if let i = try? c.decode(Int.self) { text = String(i) }
        else if let d = try? c.decode(Double.self) { text = String(d) }
        else if let b = try? c.decode(Bool.self) { text = b ? "1" : "0" }
        else { text = "" }
    }
}

/// Phönix-Markierung als Objekt, wie Zunder sie liefert (in Aktionen und der Vorschau).
public struct PhoenixMark: Decodable, Equatable, Hashable, Sendable {
    /// `feuer_schritt` oder `flamme`.
    public let role: String
    /// Woche, z. B. `2026-W42`.
    public let fire: String

    /// „Phönix-Schritt KW 42“
    public var label: String {
        let week = Int(fire.suffix(2)) ?? 0
        return role == PhoenixRole.flame ? "Flamme KW \(week)" : "Phönix-Schritt KW \(week)"
    }
}

/// Stelle einer Aufgabe in Zunder: `inbox`, `loose`, `area` oder `project`.
public struct TaskLocation: Decodable, Equatable, Hashable, Sendable {
    public let kind: String
    public let id: String?
    public let name: String?
    public let areaID: String?
    public let areaName: String?

    enum CodingKeys: String, CodingKey {
        case kind, id, name
        case areaID = "area_id"
        case areaName = "area_name"
    }

    /// Ort wie in den Meldungen (`placeName` in http.js): „Inbox“, „Lose“, „Finanzen / Steuer 2026“.
    public var label: String {
        switch kind {
        case "inbox": "Inbox"
        case "loose": "Lose"
        case "project": areaName.map { "\($0) / \(name ?? "Projekt")" } ?? name ?? "Projekt"
        default: name ?? areaName ?? "Bereich"
        }
    }
}

/// Ob Timing eine Flamme mitmisst: ja, nein oder die Fehlermeldung von Timing.
public enum FlameTiming: Decodable, Equatable, Sendable {
    case measured
    case notMeasured
    case failed(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let used = try? c.decode(Bool.self) { self = used ? .measured : .notMeasured }
        else { self = .failed(try c.decode(String.self)) }
    }
}

/// Aufgabe in der Antwort einer Aktion (`summary` in src/cockpit/actions.js); `phoenix` ist
/// hier ein Objekt. `/aktion/flamme` ergänzt `running`, `startedAt`, `endedAt`, `timing`.
public struct TaskSummary: Decodable, Equatable, Sendable {
    public let id: String
    public let ref: String?
    public let title: String
    public let status: TaskStatus
    public let due: String?
    public let phoenix: PhoenixMark?
    public let location: TaskLocation?
    public let running: Bool?
    public let startedAt: String?
    public let endedAt: String?
    public let timing: FlameTiming?
}

/// Ergebnis der Schnelleingabe: Aufgabe in Zunder, Notiz im Vault oder Artikel im Lesestapel.
public struct CaptureResult: Decodable, Equatable, Sendable {
    /// `task`, `note` oder `article`.
    public let kind: String
    /// Aufgabe oder Artikel.
    public let id: String?
    public let ref: String?
    /// Link in die Zunder-Oberfläche (Aufgabe).
    public let url: String?
    public let title: String?
    public let due: String?
    public let dueLabel: String?
    public let location: TaskLocation?
    public let phoenix: PhoenixMark?
    public let notes: [String]
    /// Pfad der neuen Notiz.
    public let path: String?
    /// Schon einmal erfasst (gleiche `cid`): nichts Neues angelegt.
    public let duplicate: Bool

    enum CodingKeys: String, CodingKey { case kind, id, ref, url, title, due, dueLabel, location, phoenix, notes, path, duplicate }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        due = try c.decodeIfPresent(String.self, forKey: .due)
        dueLabel = try c.decodeIfPresent(String.self, forKey: .dueLabel)
        location = try c.decodeIfPresent(TaskLocation.self, forKey: .location)
        phoenix = try c.decodeIfPresent(PhoenixMark.self, forKey: .phoenix)
        notes = try c.decodeIfPresent([String].self, forKey: .notes) ?? []
        path = try c.decodeIfPresent(String.self, forKey: .path)
        duplicate = try c.decodeIfPresent(Bool.self, forKey: .duplicate) ?? false
    }

    public var link: URL? { url.flatMap(URL.init(string:)) }
    /// Neue Aufgabe liegt in der Zunder-Inbox (ohne Ziel wie `#gesundheit`).
    public var landsInInbox: Bool { kind == "task" && (location == nil || location?.kind == "inbox") }
}
