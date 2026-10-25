import Foundation

// Modelle für `/api/einstellungen…` (src/web/settings-json.js): Abschnitte mit Feldern wie das
// HTML-Formular, Kalender, API-Tokens, Kurzbefehle und Sicherung. Geheimnisse kommen nie zurück:
// ein Geheimnisfeld ist immer leer, `set` sagt, ob ein eigener Wert gespeichert ist.

/// Stand eines Abschnitts als Punkt in der Navigation: Text und Ton.
public struct SettingsSectionState: Decodable, Equatable, Sendable {
    public enum Tone: String, Decodable, Equatable, Sendable {
        case ok, warn, off

        public init(from decoder: Decoder) throws {
            self = Tone(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .off
        }
    }

    public let text: String
    public let tone: Tone
}

/// Auswahlwert (`select`, Kalenderart, Token-Recht).
public struct SettingsOption: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public let value: String
    public let label: String

    public var id: String { value }
}

public enum SettingsFieldKind: String, Decodable, Equatable, Sendable {
    case text, number, list, select, secret

    public init(from decoder: Decoder) throws {
        self = SettingsFieldKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .text
    }
}

/// Ein Feld wie im Formular; `name` ist der Formularname (`tz`, `zunder.url`, `mail.pollMinutes`).
public struct SettingsField: Decodable, Equatable, Identifiable, Sendable {
    public let name: String
    public let label: String
    public let hint: String?
    public let kind: SettingsFieldKind
    /// Gespeicherter Wert als Text; bei Geheimnissen immer leer. Bei `select`: `''` = Standard.
    public let value: String
    public let placeholder: String
    public let options: [SettingsOption]
    /// Untergruppe (aufklappbar, z. B. „Ordner und Abstand“), nil = direkt im Abschnitt.
    public let group: String?
    /// Untergruppe anfangs zugeklappt.
    public let collapsed: Bool
    /// Geheimnis: ein eigener Wert ist gespeichert.
    public let isSet: Bool
    /// Geheimnis: Name des Häkchens zum Löschen (`zunder.clear`, `mail.clear`, `tts.clear`).
    public let clear: String?
    public let clearLabel: String?

    public var id: String { name }
    public var isSecret: Bool { kind == .secret }

    enum CodingKeys: String, CodingKey {
        case name, label, hint, kind, value, placeholder, options, group, collapsed, clear, clearLabel
        case isSet = "set"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? name
        hint = try c.decodeIfPresent(String.self, forKey: .hint)
        kind = try c.decodeIfPresent(SettingsFieldKind.self, forKey: .kind) ?? .text
        value = try c.decodeIfPresent(String.self, forKey: .value) ?? ""
        placeholder = try c.decodeIfPresent(String.self, forKey: .placeholder) ?? ""
        options = try c.decodeIfPresent([SettingsOption].self, forKey: .options) ?? []
        group = try c.decodeIfPresent(String.self, forKey: .group)
        collapsed = try c.decodeIfPresent(Bool.self, forKey: .collapsed) ?? false
        isSet = try c.decodeIfPresent(Bool.self, forKey: .isSet) ?? false
        clear = try c.decodeIfPresent(String.self, forKey: .clear)
        clearLabel = try c.decodeIfPresent(String.self, forKey: .clearLabel)
    }
}

/// Abschnitt der Einstellungen. `tokens`, `kurzbefehle` und `sicherung` haben keine Felder, ihr
/// Inhalt steht in `SettingsModel.tokens`, `.shortcuts`, `.backup`.
public struct SettingsSection: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let state: SettingsSectionState?
    public let intro: String?
    public let fields: [SettingsField]
    /// Erklärtext je Untergruppe (Titel → Text), z. B. „Folgen“.
    public let groups: [String: String]

    enum CodingKeys: String, CodingKey { case id, title, state, intro, fields, groups }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        state = try c.decodeIfPresent(SettingsSectionState.self, forKey: .state)
        intro = try c.decodeIfPresent(String.self, forKey: .intro)
        fields = try c.decodeIfPresent([SettingsField].self, forKey: .fields) ?? []
        groups = try c.decodeIfPresent([String: String].self, forKey: .groups) ?? [:]
    }

    /// Felder ohne Untergruppe, dann je Untergruppe in Reihenfolge des Servers.
    public var fieldGroups: [(title: String?, fields: [SettingsField])] {
        var order: [String?] = []
        var byGroup: [String?: [SettingsField]] = [:]
        for field in fields {
            if byGroup[field.group] == nil { order.append(field.group) }
            byGroup[field.group, default: []].append(field)
        }
        return order.map { ($0, byGroup[$0] ?? []) }
    }

    /// Bekannte Abschnitte (`id`).
    public static let calendars = "kalender"
    public static let tokens = "tokens"
    public static let shortcuts = "kurzbefehle"
    public static let backup = "sicherung"
}

/// Ergebnis der Prüfung eines Kalenders („✓ 3 Termine diese Woche“ oder der Fehler).
public struct CalendarCheck: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let count: Int?
    public let error: String?
    public let text: String
}

/// Gespeicherter Kalender; die Adresse ist gekürzt (`https://host/…`), Passwörter kommen nie zurück.
public struct CalendarEntry: Decodable, Equatable, Identifiable, Sendable {
    /// Nummer im Formular (`cal.<index>.…`).
    public let index: Int
    public let id: String
    public let name: String
    /// `ical` oder `caldav`.
    public let kind: String
    public let kindLabel: String
    public let host: String?
    public let address: String
    /// Mit Anmeldung (Benutzer gesetzt).
    public let auth: Bool
    public let username: String
    public let passwordSet: Bool
    /// CalDAV: nur diese Kalender.
    public let filter: [String]
    public let check: CalendarCheck?

    enum CodingKeys: String, CodingKey { case index, id, name, kind, kindLabel, host, address, auth, username, passwordSet, filter, check }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        index = try c.decode(Int.self, forKey: .index)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "ical"
        kindLabel = try c.decodeIfPresent(String.self, forKey: .kindLabel) ?? kind
        host = try c.decodeIfPresent(String.self, forKey: .host)
        address = try c.decodeIfPresent(String.self, forKey: .address) ?? ""
        auth = try c.decodeIfPresent(Bool.self, forKey: .auth) ?? false
        username = try c.decodeIfPresent(String.self, forKey: .username) ?? ""
        passwordSet = try c.decodeIfPresent(Bool.self, forKey: .passwordSet) ?? false
        filter = try c.decodeIfPresent([String].self, forKey: .filter) ?? []
        check = try c.decodeIfPresent(CalendarCheck.self, forKey: .check)
    }

    public var isCalDAV: Bool { kind == "caldav" }
}

public struct CalendarSettings: Decodable, Equatable, Sendable {
    public let items: [CalendarEntry]
    /// Nummer für einen neuen Kalender (`cal.<next>.…`).
    public let next: Int
    /// Höchstzahl (20).
    public let max: Int
    public let kinds: [SettingsOption]

    public var canAdd: Bool { items.count < max }
}

/// „Überall abmelden“: Weg, Knopf und Erklärung.
public struct SignOutEverywhere: Decodable, Equatable, Sendable {
    public let action: String
    public let label: String
    public let text: String
}

/// API-Token in der Liste (ohne Klartext).
public struct ApiToken: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    /// `search`, `capture`, `lesestapel`, `app`.
    public let scope: String
    public let scopeLabel: String
    public let createdAt: String?
    /// Der Geräte-Token dieser App (Widerrufen meldet sie ab).
    public let current: Bool

    enum CodingKeys: String, CodingKey { case id, name, scope, scopeLabel, createdAt, current }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        scope = try c.decodeIfPresent(String.self, forKey: .scope) ?? ""
        scopeLabel = try c.decodeIfPresent(String.self, forKey: .scopeLabel) ?? scope
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        current = try c.decodeIfPresent(Bool.self, forKey: .current) ?? false
    }

    public var createdDate: Date? { createdAt.flatMap(CockpitFormat.date(from:)) }
}

/// Recht eines Tokens mit Erklärung.
public struct TokenScope: Decodable, Equatable, Identifiable, Sendable {
    public let value: String
    public let label: String
    public let text: String

    public var id: String { value }
}

/// iOS-Kurzbefehl zum Herunterladen (`file` mit Geräte-Token, `CockpitAPI.download`).
public struct ShortcutInfo: Decodable, Equatable, Identifiable, Sendable {
    public let slug: String
    public let title: String
    public let text: String
    /// `/kurzbefehle/<slug>.shortcut`
    public let file: String
    public let filename: String

    public var id: String { slug }
}

/// Datei, die in die Sicherung gehört, und ob es sie gibt.
public struct BackupFileInfo: Decodable, Equatable, Identifiable, Sendable {
    public let name: String
    public let label: String
    public let present: Bool

    public var id: String { name }
}

/// Stand der Sicherung (`GET /api/einstellungen/sicherung`).
public struct BackupStatus: Decodable, Equatable, Sendable {
    /// Das Cockpit ist noch leer (Hinweis „Sicherung einspielen?“).
    public let empty: Bool
    public let files: [BackupFileInfo]
    /// Mindestlänge der Passphrase (12).
    public let minPassphrase: Int
    /// Vorhandenes würde ersetzt: „Vorhandenes ersetzen“ muss an sein.
    public let needsReplace: Bool
    public let intro: String
    /// Erklärung zum Wiederherstellen.
    public let restore: String

    enum CodingKeys: String, CodingKey { case empty, files, minPassphrase, needsReplace, intro, restore }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        empty = try c.decodeIfPresent(Bool.self, forKey: .empty) ?? false
        files = try c.decodeIfPresent([BackupFileInfo].self, forKey: .files) ?? []
        minPassphrase = try c.decodeIfPresent(Int.self, forKey: .minPassphrase) ?? 12
        needsReplace = try c.decodeIfPresent(Bool.self, forKey: .needsReplace) ?? !empty
        intro = try c.decodeIfPresent(String.self, forKey: .intro) ?? ""
        restore = try c.decodeIfPresent(String.self, forKey: .restore) ?? ""
    }
}

/// Antwort von `GET /api/einstellungen`.
public struct SettingsModel: Decodable, Equatable, Sendable {
    public let sections: [SettingsSection]
    public let calendars: CalendarSettings
    public let signOutEverywhere: SignOutEverywhere?
    /// nil, wenn es keine Token-Verwaltung gibt.
    public var tokens: [ApiToken]?
    public let scopes: [TokenScope]?
    public let shortcuts: [ShortcutInfo]
    public let captureEnabled: Bool
    public let backup: BackupStatus?
    /// „Leere Geheimnisfelder behalten den gespeicherten Wert.“
    public let secretHint: String

    enum CodingKeys: String, CodingKey { case sections, calendars, signOutEverywhere, tokens, scopes, shortcuts, captureEnabled, backup, secretHint }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sections = try c.decodeIfPresent([SettingsSection].self, forKey: .sections) ?? []
        calendars = try c.decode(CalendarSettings.self, forKey: .calendars)
        signOutEverywhere = try c.decodeIfPresent(SignOutEverywhere.self, forKey: .signOutEverywhere)
        tokens = try c.decodeIfPresent([ApiToken].self, forKey: .tokens)
        scopes = try c.decodeIfPresent([TokenScope].self, forKey: .scopes)
        shortcuts = try c.decodeIfPresent([ShortcutInfo].self, forKey: .shortcuts) ?? []
        captureEnabled = try c.decodeIfPresent(Bool.self, forKey: .captureEnabled) ?? false
        backup = try c.decodeIfPresent(BackupStatus.self, forKey: .backup)
        secretHint = try c.decodeIfPresent(String.self, forKey: .secretHint) ?? "Leere Geheimnisfelder behalten den gespeicherten Wert."
    }

    public func section(_ id: String) -> SettingsSection? {
        sections.first { $0.id == id }
    }

    /// Abschnitt, zu dem ein Formularfeld gehört (`cal.N.…` → Kalender).
    public func section(ofField name: String) -> SettingsSection? {
        if name.hasPrefix("cal.") { return section(SettingsSection.calendars) }
        return sections.first { section in section.fields.contains { $0.name == name || $0.clear == name } }
    }

    public func field(_ name: String) -> SettingsField? {
        for section in sections { if let field = section.fields.first(where: { $0.name == name }) { return field } }
        return nil
    }
}

/// `GET /api/einstellungen/tokens`
public struct TokensModel: Decodable, Equatable, Sendable {
    public var tokens: [ApiToken]
    public let scopes: [TokenScope]
}

/// Neuer Token mit Klartext; den gibt es nur in dieser Antwort.
public struct CreatedToken: Decodable, Equatable, Identifiable, Sendable {
    public let token: String
    public let id: String
    public let name: String
    public let scope: String
    public let scopeLabel: String
    public let createdAt: String?
}

/// Antwort von `POST /api/einstellungen/tokens` und `/tokens/widerrufen`.
public struct TokenReply: ActionReply, Equatable, Sendable {
    public let ok: Bool
    public let message: String
    /// Nur beim Anlegen.
    public let token: CreatedToken?
    /// Nur beim Widerrufen: die ID und ob es der Token dieser App war.
    public let id: String?
    public let isSelf: Bool
    public let tokens: [ApiToken]
    public let scopes: [TokenScope]

    enum CodingKeys: String, CodingKey {
        case ok, message, token, id, tokens, scopes
        case isSelf = "self"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        token = try c.decodeIfPresent(CreatedToken.self, forKey: .token)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        isSelf = try c.decodeIfPresent(Bool.self, forKey: .isSelf) ?? false
        tokens = try c.decodeIfPresent([ApiToken].self, forKey: .tokens) ?? []
        scopes = try c.decodeIfPresent([TokenScope].self, forKey: .scopes) ?? []
    }
}

/// `GET /api/einstellungen/kurzbefehle`
public struct ShortcutsModel: Decodable, Equatable, Sendable {
    public let shortcuts: [ShortcutInfo]
    /// Capture eingerichtet (sonst funktionieren Notiz und Sprachmemo nicht).
    public let captureEnabled: Bool
    public let intro: String

    enum CodingKeys: String, CodingKey { case shortcuts, captureEnabled, intro }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shortcuts = try c.decodeIfPresent([ShortcutInfo].self, forKey: .shortcuts) ?? []
        captureEnabled = try c.decodeIfPresent(Bool.self, forKey: .captureEnabled) ?? false
        intro = try c.decodeIfPresent(String.self, forKey: .intro) ?? ""
    }
}

/// Antwort nach dem Wiederherstellen; danach startet das Cockpit neu.
public struct BackupRestoreResult: ActionReply, Equatable, Sendable {
    public let ok: Bool
    public let message: String
    public let title: String
    public let createdAt: String?
    public let files: [String]
    public let skipped: [String]
    public let restart: Bool
    /// Sitzungs-Secret zurückgeschrieben: Cookies gelten nicht mehr (Browser).
    public let relogin: Bool
    /// API-Tokens zurückgeschrieben: Der Geräte-Token gilt nach dem Neustart nur, wenn er in der
    /// Sicherung stand; sonst muss die App sich neu anmelden.
    public let tokensReplaced: Bool

    enum CodingKeys: String, CodingKey { case ok, message, title, createdAt, files, skipped, restart, relogin, tokensReplaced }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Sicherung wiederhergestellt"
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
        skipped = try c.decodeIfPresent([String].self, forKey: .skipped) ?? []
        restart = try c.decodeIfPresent(Bool.self, forKey: .restart) ?? true
        relogin = try c.decodeIfPresent(Bool.self, forKey: .relogin) ?? false
        tokensReplaced = try c.decodeIfPresent(Bool.self, forKey: .tokensReplaced) ?? false
    }
}

/// Wege unter `/api/einstellungen`.
public enum SettingsPath {
    public static let settings = "api/einstellungen"
    public static let signOut = "api/einstellungen/abmelden"
    public static let tokens = "api/einstellungen/tokens"
    public static let revokeToken = "api/einstellungen/tokens/widerrufen"
    public static let backup = "api/einstellungen/sicherung"
    public static let restore = "api/einstellungen/sicherung/wiederherstellen"
    public static let shortcuts = "api/einstellungen/kurzbefehle"
}

extension CockpitAPI {
    public func settings() async throws -> SettingsModel {
        try await get(SettingsPath.settings)
    }

    public func tokens() async throws -> TokensModel {
        try await get(SettingsPath.tokens)
    }

    public func backupStatus() async throws -> BackupStatus {
        try await get(SettingsPath.backup)
    }

    public func shortcuts() async throws -> ShortcutsModel {
        try await get(SettingsPath.shortcuts)
    }
}
