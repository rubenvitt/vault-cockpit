import Foundation
import Observation

/// Kalender zum Bearbeiten oder Anlegen (`cal.<index>.…` im Formular). Adresse und Passwort
/// sind leer: leer heißt unverändert, bei einem neuen Kalender ist die Adresse nötig.
public struct CalendarDraft: Equatable, Identifiable, Sendable {
    /// Nummer im Formular; bei einem neuen Kalender `calendars.next`.
    public let index: Int
    /// ID des gespeicherten Kalenders, nil = neu.
    public let entryID: String?
    public var name: String
    /// `ical` oder `caldav`.
    public var kind: String
    public var url: String
    /// iCal „Mit Anmeldung“ (CalDAV meldet sich immer an).
    public var auth: Bool
    public var username: String
    public var password: String
    /// CalDAV „Nur diese Kalender“, durch Komma getrennt.
    public var filter: String

    public var id: Int { index }
    public var isNew: Bool { entryID == nil }
    public var isCalDAV: Bool { kind == "caldav" }
    /// Benutzer und Passwort werden geschickt.
    public var usesLogin: Bool { isCalDAV || auth }

    public init(index: Int, entryID: String? = nil, name: String = "", kind: String = "ical", url: String = "", auth: Bool = false, username: String = "", password: String = "", filter: String = "") {
        self.index = index
        self.entryID = entryID
        self.name = name
        self.kind = kind
        self.url = url
        self.auth = auth
        self.username = username
        self.password = password
        self.filter = filter
    }

    /// Formularname eines Felds, z. B. `cal.1.url` (Schlüssel für `SettingsStore.error(for:)`).
    public func fieldName(_ key: String) -> String { "cal.\(index).\(key)" }

    func fields() -> [String: String] {
        var fields: [String: String] = [
            fieldName("name"): name.trimmingCharacters(in: .whitespacesAndNewlines),
            fieldName("kind"): kind,
            fieldName("auth"): auth ? "1" : "0",
            fieldName("username"): usesLogin ? username.trimmingCharacters(in: .whitespacesAndNewlines) : "",
            fieldName("filter"): isCalDAV ? filter : "",
        ]
        if let entryID { fields[fieldName("id")] = entryID }
        let url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if !url.isEmpty { fields[fieldName("url")] = url }
        if usesLogin, !password.isEmpty { fields[fieldName("password")] = password }
        return fields
    }
}

/// Einstellungen: alle Abschnitte mit Entwurf je Feld, Speichern je Abschnitt (abgelehnte Felder
/// stehen in `fieldErrors`), Kalender anlegen, ändern, entfernen und prüfen, „Überall abmelden“.
///
/// Gespeichert wird mit denselben Feldnamen wie das Formular im Web; Felder, die nicht
/// geschickt werden, behält der Server. Geheimnisse kommen nie zurück: ein leeres Geheimnisfeld
/// heißt unverändert, das Häkchen `clear` löscht den eigenen Wert.
@MainActor
@Observable
public final class SettingsStore {
    /// Geänderte Werte je Feldname.
    public private(set) var drafts: [String: String] = [:]
    /// Gesetzte Häkchen zum Löschen (`zunder.clear`, `mail.clear`, `tts.clear`).
    public private(set) var clears: Set<String> = []
    /// Abgelehnte Felder (Formularname → Meldung des Servers), z. B. `tz`, `cal.1.url`.
    public private(set) var fieldErrors: [String: String] = [:]
    /// Abschnitte (`id`) bzw. Kalender (`cal.N`), die gerade speichern.
    public private(set) var saving: Set<String> = []
    public private(set) var isSigningOut = false

    private let remote: RemoteModel<SettingsModel>
    private let context: CockpitContext
    private var runner: ReplyRunner { ReplyRunner(context: context) }

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: SettingsPath.settings)
    }

    public var model: SettingsModel? { remote.model }
    public var state: LoadState { remote.state }

    // MARK: Laden

    /// Zeigt den gespeicherten Stand und lädt neu (dabei prüft der Server die Kalender).
    public func load() async {
        remote.select(key: "einstellungen", query: []) { _ in true }
        await remote.refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    /// „Prüfen“: lädt neu, der Server ruft dabei jeden Kalender ab.
    public func checkCalendars() async {
        await remote.refresh()
    }

    // MARK: Entwurf

    /// Wert im Feld: Entwurf oder gespeichert (Geheimnisse: nur der Entwurf).
    public func value(of field: SettingsField) -> String {
        drafts[field.name] ?? (field.isSecret ? "" : field.value)
    }

    public func setValue(_ value: String, for field: SettingsField) {
        if !field.isSecret, value == field.value { drafts[field.name] = nil }
        else if field.isSecret, value.isEmpty { drafts[field.name] = nil }
        else { drafts[field.name] = value }
        fieldErrors[field.name] = nil
    }

    /// Häkchen „eigenen … löschen“ eines Geheimnisfelds.
    public func isCleared(_ field: SettingsField) -> Bool {
        field.clear.map { clears.contains($0) } ?? false
    }

    public func setCleared(_ on: Bool, for field: SettingsField) {
        guard let name = field.clear else { return }
        if on { clears.insert(name) } else { clears.remove(name) }
    }

    /// Meldung zu einem Feld (Formularname), nil ohne Fehler.
    public func error(for name: String) -> String? {
        fieldErrors[name]
    }

    /// Der Abschnitt hat ungespeicherte Änderungen.
    public func isDirty(_ section: SettingsSection) -> Bool {
        section.fields.contains { drafts[$0.name] != nil || ($0.clear.map { clears.contains($0) } ?? false) }
    }

    /// Änderungen eines Abschnitts verwerfen.
    public func discard(_ section: SettingsSection) {
        forget(section)
    }

    private func forget(_ section: SettingsSection) {
        for field in section.fields {
            drafts[field.name] = nil
            fieldErrors[field.name] = nil
            if let clear = field.clear {
                clears.remove(clear)
                fieldErrors[clear] = nil
            }
        }
    }

    /// Formular eines Abschnitts: alle Felder mit Entwurf oder gespeichertem Wert, Geheimnisse
    /// nur wenn etwas eingetragen ist, Häkchen zum Löschen nur wenn gesetzt.
    func fields(of section: SettingsSection) -> [String: String] {
        var fields: [String: String] = [:]
        for field in section.fields {
            if field.isSecret {
                if let secret = drafts[field.name], !secret.isEmpty { fields[field.name] = secret }
            } else {
                fields[field.name] = value(of: field)
            }
            if let clear = field.clear, clears.contains(clear) { fields[clear] = "1" }
        }
        return fields
    }

    // MARK: Speichern

    /// „Speichern“ eines Abschnitts. Lehnt der Server ein Feld ab, steht die Meldung in
    /// `fieldErrors` und nichts ist gespeichert; sonst lädt der Stand neu.
    @discardableResult
    public func save(_ section: SettingsSection) async -> Bool {
        let fields = fields(of: section)
        guard !fields.isEmpty else { return true }
        return await submit(fields, key: section.id) { [weak self] in self?.forget(section) }
    }

    /// Kalender anlegen oder ändern.
    @discardableResult
    public func saveCalendar(_ draft: CalendarDraft) async -> Bool {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if draft.isNew, draft.url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return reject(draft.fieldName("url"), "Bitte die Adresse des Kalenders angeben.")
        }
        if name.isEmpty { return reject(draft.fieldName("name"), "Bitte einen Namen angeben.") }
        return await submit(draft.fields(), key: "cal.\(draft.index)") { [weak self] in self?.forgetCalendar(draft.index) }
    }

    /// „Kalender entfernen“
    @discardableResult
    public func removeCalendar(_ entry: CalendarEntry) async -> Bool {
        await submit(["cal.\(entry.index).id": entry.id, "cal.\(entry.index).remove": "1"], key: "cal.\(entry.index)") { [weak self] in self?.forgetCalendar(entry.index) }
    }

    /// Entwurf zum Bearbeiten eines gespeicherten Kalenders.
    public func calendarDraft(for entry: CalendarEntry) -> CalendarDraft {
        CalendarDraft(index: entry.index, entryID: entry.id, name: entry.name, kind: entry.kind, auth: entry.auth, username: entry.username, filter: entry.filter.joined(separator: ", "))
    }

    /// Entwurf für „＋ Neuer Kalender“; nil, wenn schon 20 eingerichtet sind.
    public func newCalendarDraft() -> CalendarDraft? {
        guard let calendars = model?.calendars, calendars.canAdd else { return nil }
        return CalendarDraft(index: calendars.next)
    }

    private func forgetCalendar(_ index: Int) {
        let prefix = "cal.\(index)."
        for key in fieldErrors.keys where key.hasPrefix(prefix) { fieldErrors[key] = nil }
    }

    private func reject(_ field: String, _ message: String) -> Bool {
        fieldErrors[field] = message
        context.toasts.signal(.error)
        context.toasts.error(message)
        return false
    }

    private func submit(_ fields: [String: String], key: String, onSuccess: @escaping @MainActor () -> Void) async -> Bool {
        guard !saving.contains(key) else { return false }
        saving.insert(key)
        defer { saving.remove(key) }
        do {
            let response = try await context.api.action(SettingsPath.settings, fields: fields, as: MessageReply.self)
            onSuccess()
            context.toasts.signal(.success)
            context.toasts.show(response.message.isEmpty ? "Gespeichert." : response.message)
            await remote.refresh()
            return true
        } catch {
            if let field = runner.reportForm(error) { fieldErrors[field] = (error as? FieldRejection)?.message }
            return false
        }
    }

    // MARK: Überall abmelden

    /// „Überall abmelden“: beendet alle Browser-Sitzungen; Geräte-Tokens bleiben gültig.
    @discardableResult
    public func signOutEverywhere() async -> Bool {
        guard !isSigningOut else { return false }
        isSigningOut = true
        defer { isSigningOut = false }
        return await runner.run(SettingsPath.signOut, [:], as: MessageReply.self) != nil
    }
}

/// API-Tokens: Liste, anlegen (Klartext nur einmal, `created`) und widerrufen. Widerruft die App
/// ihren eigenen Token, meldet sie sich ab (`CockpitContext.onUnauthorized`).
@MainActor
@Observable
public final class TokensStore {
    /// Gerade angelegt, mit Klartext; bis `dismissCreated()`. Wird nie gespeichert.
    public private(set) var created: CreatedToken?
    /// Abgelehnte Felder (`name`, `scope`).
    public private(set) var fieldErrors: [String: String] = [:]
    public private(set) var isCreating = false
    /// Token-IDs, die gerade widerrufen werden.
    public private(set) var revoking: Set<String> = []

    private let remote: RemoteModel<TokensModel>
    private let context: CockpitContext
    private var runner: ReplyRunner { ReplyRunner(context: context) }

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: SettingsPath.tokens)
    }

    public var model: TokensModel? { remote.model }
    public var state: LoadState { remote.state }

    public func load() async {
        remote.select(key: "einstellungen/tokens", query: []) { _ in true }
        await remote.refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    /// „＋ Neuer Token“ mit Name (höchstens 80 Zeichen) und Recht. Liefert den Klartext.
    @discardableResult
    public func create(name: String, scope: String = "search") async -> CreatedToken? {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        fieldErrors = [:]
        guard !name.isEmpty else {
            fieldErrors["name"] = "Der Token braucht einen Namen"
            context.toasts.signal(.error)
            context.toasts.error("Der Token braucht einen Namen")
            return nil
        }
        guard !isCreating else { return nil }
        isCreating = true
        defer { isCreating = false }
        do {
            let reply = try await context.api.action(SettingsPath.tokens, fields: ["name": name, "scope": scope], as: TokenReply.self)
            remote.model = TokensModel(tokens: reply.tokens, scopes: reply.scopes)
            created = reply.token
            context.toasts.signal(.success)
            context.toasts.show(reply.message)
            return reply.token
        } catch {
            if let field = runner.reportForm(error) { fieldErrors[field] = (error as? FieldRejection)?.message }
            return nil
        }
    }

    /// Klartext ausblenden (nach dem Kopieren).
    public func dismissCreated() {
        created = nil
    }

    /// „Widerrufen“; beim eigenen Token (`current`) meldet die App danach ab.
    @discardableResult
    public func revoke(_ token: ApiToken) async -> Bool {
        guard !revoking.contains(token.id) else { return false }
        revoking.insert(token.id)
        defer { revoking.remove(token.id) }
        guard let reply = await runner.run(SettingsPath.revokeToken, ["id": token.id], as: TokenReply.self) else { return false }
        remote.model = TokensModel(tokens: reply.tokens, scopes: reply.scopes)
        if created?.id == token.id { created = nil }
        if reply.isSelf { context.onUnauthorized() }
        return true
    }
}

/// Sicherung: Stand, verschlüsselte Datei erzeugen (für das Teilen-Blatt) und wiederherstellen.
@MainActor
@Observable
public final class BackupStore {
    /// Abgelehnte Felder (`passphrase`, `passphrase2`, `datei`).
    public private(set) var fieldErrors: [String: String] = [:]
    public private(set) var isCreating = false
    public private(set) var isRestoring = false
    /// Zuletzt erzeugte Sicherung (Datei im temporären Ordner).
    public private(set) var file: URL?
    /// Ergebnis des Wiederherstellens; das Cockpit startet danach neu.
    public private(set) var restored: BackupRestoreResult?

    /// Höchstgröße einer Sicherung beim Hochladen (32 MB wie der Server).
    nonisolated public static let maxBytes = 32 * 1024 * 1024

    private let remote: RemoteModel<BackupStatus>
    private let context: CockpitContext
    private var runner: ReplyRunner { ReplyRunner(context: context) }

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: SettingsPath.backup)
    }

    public var model: BackupStatus? { remote.model }
    public var state: LoadState { remote.state }
    public var minPassphrase: Int { model?.minPassphrase ?? 12 }

    public func load() async {
        remote.select(key: "einstellungen/sicherung", query: []) { _ in true }
        await remote.refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    /// „Sicherung herunterladen“: prüft die Passphrase wie der Server und legt die Datei
    /// (`cockpit-sicherung-JJJJ-MM-TT.json`) zum Teilen ab.
    @discardableResult
    public func create(passphrase: String, repeat repeated: String) async -> URL? {
        fieldErrors = [:]
        guard passphrase.count >= minPassphrase else {
            return reject("passphrase", "Die Passphrase braucht mindestens \(minPassphrase) Zeichen")
        }
        guard passphrase == repeated else {
            return reject("passphrase2", "Die beiden Passphrasen stimmen nicht überein")
        }
        guard !isCreating else { return nil }
        isCreating = true
        defer { isCreating = false }
        do {
            let download = try await context.api.download(SettingsPath.backup, fields: ["passphrase": passphrase, "passphrase2": repeated])
            let url = try download.write(to: ShareFiles.directory("Sicherung"), name: download.filename ?? "cockpit-sicherung.json")
            file = url
            context.toasts.signal(.success)
            return url
        } catch {
            if let field = runner.reportForm(error) { fieldErrors[field] = (error as? FieldRejection)?.message }
            return nil
        }
    }

    /// „Wiederherstellen“ aus einer Datei (vom Dokumenten-Picker; Zugriff vorher freigeben).
    @discardableResult
    public func restore(file url: URL, passphrase: String, replace: Bool) async -> BackupRestoreResult? {
        guard let data = try? Data(contentsOf: url) else {
            fieldErrors = ["datei": "Die Datei lässt sich nicht lesen."]
            context.toasts.signal(.error)
            context.toasts.error("Die Datei lässt sich nicht lesen.")
            return nil
        }
        return await restore(data: data, filename: url.lastPathComponent, passphrase: passphrase, replace: replace)
    }

    /// Spielt eine Sicherung ein. `replace` ist nötig, wenn `needsReplace`; danach startet das
    /// Cockpit neu (`restored`, mit `tokensReplaced`: der Geräte-Token gilt dann nur, wenn er in
    /// der Sicherung stand).
    @discardableResult
    public func restore(data: Data, filename: String, passphrase: String, replace: Bool) async -> BackupRestoreResult? {
        fieldErrors = [:]
        guard !data.isEmpty else { return reject("datei", "Bitte eine Sicherung (.json) auswählen") }
        guard data.count <= Self.maxBytes else { return reject("datei", "Die Datei ist zu groß (höchstens 32 MB).") }
        guard !passphrase.isEmpty else { return reject("passphrase", "Bitte die Passphrase der Sicherung eingeben") }
        guard !isRestoring else { return nil }
        isRestoring = true
        defer { isRestoring = false }
        do {
            var fields = ["passphrase": passphrase]
            if replace { fields["ersetzen"] = "1" }
            let upload = UploadFile(filename: filename.isEmpty ? "sicherung.json" : filename, contentType: "application/json", data: data)
            let result = try await context.api.upload(SettingsPath.restore, fields: fields, file: upload, as: BackupRestoreResult.self)
            restored = result
            context.toasts.signal(.success)
            context.toasts.show(result.message)
            return result
        } catch {
            if let field = runner.reportForm(error) { fieldErrors[field] = (error as? FieldRejection)?.message }
            return nil
        }
    }

    private func reject<T>(_ field: String, _ message: String) -> T? {
        fieldErrors[field] = message
        context.toasts.signal(.error)
        context.toasts.error(message)
        return nil
    }
}

/// Kurzbefehle: Liste und Download der `.shortcut`-Dateien (zum Öffnen oder Teilen).
@MainActor
@Observable
public final class ShortcutsStore {
    /// Geladene Dateien je `slug`.
    public private(set) var files: [String: URL] = [:]
    /// `slug`s, die gerade laden.
    public private(set) var downloading: Set<String> = []

    private let remote: RemoteModel<ShortcutsModel>
    private let context: CockpitContext

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: SettingsPath.shortcuts)
    }

    public var model: ShortcutsModel? { remote.model }
    public var state: LoadState { remote.state }

    public func load() async {
        remote.select(key: "einstellungen/kurzbefehle", query: []) { _ in true }
        await remote.refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    /// Lädt den Kurzbefehl (mit Geräte-Token) als `<Titel>.shortcut` zum Öffnen oder Teilen.
    @discardableResult
    public func download(_ shortcut: ShortcutInfo) async -> URL? {
        guard !downloading.contains(shortcut.slug) else { return nil }
        downloading.insert(shortcut.slug)
        defer { downloading.remove(shortcut.slug) }
        do {
            let download = try await context.api.resource(shortcut.file)
            let url = try download.write(to: ShareFiles.directory("Kurzbefehle"), name: shortcut.filename.isEmpty ? "\(shortcut.slug).shortcut" : shortcut.filename)
            files[shortcut.slug] = url
            return url
        } catch {
            context.report(error, action: false)
            return nil
        }
    }
}
