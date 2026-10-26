import Foundation
import Observation

/// Puffer der Leseansicht ohne Netz (wie die Aktionen in `cockpit-puffer`, static/offline.js):
/// Markieren, Notiz, Fortschritt, Status, „Fertig, weg“ und „In den Vault“. Der Schlüssel eines
/// Eintrags ist bei einer neuen Markierung ihre `cid`, sonst Aktion und Ziel
/// (`/aktion/lesen/doc/fortschritt:<id>`), damit nur der letzte Stand rausgeht. Liegt als eine
/// JSON-Datei auf der Platte und übersteht Neustarts und Abmelden.
public struct ReadingOutbox: Sendable {
    public struct Entry: Codable, Equatable, Identifiable, Sendable {
        /// Schlüssel: `cid` der Markierung oder `<aktion>:<id>`.
        public let id: String
        public let action: String
        public var fields: [String: String]
        /// „Markierung: Warum der Stapel wächst“
        public let label: String
        /// Ohne Meldung beim Nachsenden (Fortschritt).
        public let quiet: Bool
        /// Dokument, zu dem der Eintrag gehört (wartende Markierungen zeigen).
        public let docID: String
        public let created: Date
        /// Fassung: Nach dem Senden fällt der Eintrag nur weg, wenn noch genau diese Fassung liegt.
        public var rev: String
        /// Ablehnung des Servers; solche Einträge gehen nur mit „Erneut senden“ wieder raus.
        public var error: String?
        public var failedAt: Date?

        public init(id: String, action: String, fields: [String: String], label: String, quiet: Bool = false, docID: String, created: Date, rev: String = UUID().uuidString, error: String? = nil, failedAt: Date? = nil) {
            self.id = id
            self.action = action
            self.fields = fields
            self.label = label
            self.quiet = quiet
            self.docID = docID
            self.created = created
            self.rev = rev
            self.error = error
            self.failedAt = failedAt
        }

        /// Wartende neue Markierung.
        public var isNewHighlight: Bool { action == ReadingAction.markNew }
    }

    public let file: URL

    public init(file: URL) {
        self.file = file
    }

    /// `Application Support/Puffer/lesen.json`.
    public static func applicationSupport() -> ReadingOutbox {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return ReadingOutbox(file: base.appending(path: "Puffer", directoryHint: .isDirectory).appending(path: "lesen.json"))
    }

    /// Alle Einträge, ältester zuerst.
    public func all() -> [Entry] {
        guard let data = try? Data(contentsOf: file),
              let entries = try? JSONDecoder().decode([Entry].self, from: data)
        else { return [] }
        return entries.sorted { $0.created < $1.created }
    }

    /// Legt ab oder ersetzt den Eintrag mit demselben Schlüssel.
    public func put(_ entry: Entry) throws {
        var entries = all().filter { $0.id != entry.id }
        entries.append(entry)
        try write(entries)
    }

    public func remove(_ id: String) {
        try? write(all().filter { $0.id != id })
    }

    /// Nach dem Senden: entfernt bzw. ersetzt nur, wenn noch genau die gesendete Fassung liegt.
    public func settle(_ entry: Entry, replacement: Entry? = nil) {
        var entries = all()
        guard let index = entries.firstIndex(where: { $0.id == entry.id }), entries[index].rev == entry.rev else { return }
        if let replacement { entries[index] = replacement } else { entries.remove(at: index) }
        try? write(entries)
    }

    private func write(_ entries: [Entry]) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(entries).write(to: file, options: .atomic)
    }
}

/// Aktionen der Leseansicht (`/aktion/lesen/…`).
public enum ReadingAction {
    public static let markNew = "/aktion/lesen/markierung/neu"
    public static let note = "/aktion/lesen/markierung/notiz"
    public static let markDelete = "/aktion/lesen/markierung/loeschen"
    public static let markInbox = "/aktion/lesen/markierung/inbox"
    public static let progress = "/aktion/lesen/doc/fortschritt"
    public static let status = "/aktion/lesen/doc/status"
    public static let finish = "/aktion/lesen/doc/fertig"
    public static let vault = "/aktion/lesen/doc/vault"
    public static let link = "/aktion/lesen/verbinden"
    public static let sort = "/aktion/lesen/sortieren"
    public static let file = "/aktion/lesen/ablegen"
    public static let save = "/aktion/lesen/speichern"
    public static let pdf = "/aktion/lesen/pdf"
    public static let review = "/aktion/lesen/wiedersehen"
    public static let reviewLink = "/aktion/lesen/wiedersehen/verbindung"
    public static let episodeNew = "/aktion/lesen/folge/neu"
    public static let episodeResume = "/aktion/lesen/folge/fortsetzen"
    public static let episodeSpeak = "/aktion/lesen/folge/sprechen"
    public static let episodeIngest = "/aktion/lesen/folge/ingest"
    public static let episodeDelete = "/aktion/lesen/folge/loeschen"
    /// `id`, `gehoert` (`1` gehört, `0` doch nicht), mit Rückgängig.
    public static let episodeHeard = "/aktion/lesen/folge/gehoert"
    /// `id`, `stelle` und `dauer` in Sekunden (der Player, still); kurz vor Schluss gehört.
    public static let episodeSpot = "/aktion/lesen/folge/stelle"
    /// Ingest für alle gelesenen Texte unter „Weiter → Entscheiden“ ohne Entwurf.
    public static let draftAllRead = "/aktion/lesen/weiter/entwerfen"

    /// Aktionen, die ohne Netz in den Puffer gehen, mit ihrem Namen (`BUFFERED` in lesen-doc.js).
    public static let buffered: [String: String] = [
        markNew: "Markierung",
        note: "Notiz",
        progress: "Lesefortschritt",
        status: "Status",
        finish: "Fertig, weg",
        vault: "In den Vault",
    ]
}

/// Sendet, was im Puffer der Leseansicht wartet, sobald das Cockpit wieder antwortet. Einer je
/// Anmeldung (wie `CaptureStore` für die Schnelleingabe); die Leseansichten legen hier ab.
@MainActor
@Observable
public final class ReadingBuffer {
    /// Puffer, ältester zuerst.
    public private(set) var entries: [ReadingOutbox.Entry] = []
    public private(set) var isFlushing = false
    /// Nachsenden ist an 401 gescheitert: erst neu anmelden.
    public private(set) var loginNeeded = false
    /// Netz laut Gerät (`setOnline`); ohne Netz gehen Aktionen gleich in den Puffer.
    public private(set) var isOnline = true

    private let context: CockpitContext
    private let outbox: ReadingOutbox
    private let retryInterval: UInt64
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var flushing: Task<Void, Never>?
    @ObservationIgnored private var listeners: [UUID: @MainActor (Set<String>) -> Void] = [:]

    /// `outbox` nil = neben dem Puffer der Schnelleingabe (`Puffer/lesen.json`).
    public init(context: CockpitContext, outbox: ReadingOutbox? = nil, retryInterval: TimeInterval = 30) {
        self.context = context
        self.outbox = outbox ?? ReadingOutbox(file: context.outbox.file.deletingLastPathComponent().appending(path: "lesen.json"))
        self.retryInterval = UInt64(max(0, retryInterval) * 1_000_000_000)
        entries = self.outbox.all()
    }

    // MARK: Ablegen

    /// Legt eine Aktion ab; neue Markierungen unter ihrer `cid`, alles andere unter Aktion und
    /// Ziel. `false`, wenn das Gerät nichts speichern kann. Mit Netz geht sie gleich raus.
    @discardableResult
    public func queue(_ action: String, fields: [String: String], docID: String, title: String, quiet: Bool = false) -> Bool {
        let key = action == ReadingAction.markNew ? (fields["cid"] ?? UUID().uuidString.lowercased()) : "\(action):\(fields["id"] ?? "")"
        let name = ReadingAction.buffered[action] ?? "Eintrag"
        let entry = ReadingOutbox.Entry(id: key, action: action, fields: fields, label: "\(name): \(title)", quiet: quiet, docID: docID, created: context.now())
        do {
            try outbox.put(entry)
        } catch {
            return false
        }
        entries = outbox.all()
        scheduleRetry()
        return true
    }

    /// Ändert die Felder eines wartenden Eintrags (Notiz an einer wartenden Markierung).
    @discardableResult
    func update(_ id: String, change: (inout [String: String]) -> Void) -> Bool {
        guard var entry = outbox.all().first(where: { $0.id == id }) else { return false }
        change(&entry.fields)
        entry.rev = UUID().uuidString
        entry.error = nil
        do {
            try outbox.put(entry)
        } catch {
            return false
        }
        entries = outbox.all()
        return true
    }

    /// Wartende neue Markierungen eines Dokuments (ohne Ablehnung).
    public func pendingHighlights(docID: String) -> [ReadingOutbox.Entry] {
        entries.filter { $0.isNewHighlight && $0.docID == docID && $0.error == nil }
    }

    public var waitingCount: Int { entries.filter { $0.error == nil }.count }
    public var failedCount: Int { entries.count - waitingCount }

    /// „2 Einträge warten auf Netz · 1 nicht gesendet“
    public var summary: String {
        var parts: [String] = []
        if waitingCount > 0 { parts.append("\(waitingCount) \(waitingCount == 1 ? "Eintrag wartet" : "Einträge warten") auf Netz") }
        if failedCount > 0 { parts.append("\(failedCount) nicht gesendet") }
        return parts.joined(separator: " · ")
    }

    // MARK: Nachsenden

    /// Netz laut Gerät (NWPathMonitor). Zurück online: alles senden.
    public func setOnline(_ online: Bool) {
        let back = online && !isOnline
        isOnline = online
        if back { Task { await flush() } }
    }

    /// Hört, welche Dokumente nachgesendete Einträge hatten (die Leseansicht lädt neu). Liefert
    /// einen Schlüssel für `removeListener`.
    @discardableResult
    public func addListener(_ listener: @escaping @MainActor (Set<String>) -> Void) -> UUID {
        let id = UUID()
        listeners[id] = listener
        return id
    }

    public func removeListener(_ id: UUID) {
        listeners.removeValue(forKey: id)
    }

    /// Sendet, was wartet; `retry` nimmt auch abgelehnte Einträge noch einmal. Läuft nie zweimal
    /// gleichzeitig: Ein zweiter Aufruf wartet auf den ersten.
    public func flush(retry: Bool = false) async {
        // Ohne Netz nicht einmal versuchen; `setOnline(true)` sendet später.
        guard isOnline else { return }
        if let running = flushing {
            await running.value
            return
        }
        let run = Task { [weak self] in
            guard let self else { return }
            await self.sendAll(retry: retry)
        }
        flushing = run
        await run.value
        flushing = nil
    }

    /// Nach dem Login: alles noch einmal versuchen.
    public func resume() async {
        loginNeeded = false
        await flush()
    }

    private func sendAll(retry: Bool) async {
        entries = outbox.all()
        let todo = entries.filter { retry || $0.error == nil }
        guard !todo.isEmpty else { return }
        isFlushing = true
        defer { isFlushing = false }
        var sent: [String] = []
        var docs: Set<String> = []
        var failed = 0
        var stopped = false
        for entry in todo {
            do {
                let response = try await context.api.action(entry.action, fields: entry.fields, as: ReadingActionResponse.self)
                outbox.settle(entry)
                docs.insert(entry.docID)
                if !entry.quiet { sent.append(response.message.isEmpty ? entry.label : response.message) }
            } catch let error as CockpitError {
                if error.isUnauthorized {
                    loginNeeded = true
                    context.onUnauthorized()
                    stopped = true
                    break
                }
                if error.isOffline {
                    stopped = true
                    break
                }
                var rejected = entry
                rejected.error = error.message
                rejected.failedAt = context.now()
                outbox.settle(entry, replacement: rejected)
                failed += 1
            } catch {
                stopped = true
                break
            }
        }
        entries = outbox.all()
        if !sent.isEmpty {
            loginNeeded = false
            context.toasts.show(sent.count == 1 ? "Nachgesendet: \(sent[0])" : "\(sent.count) Einträge nachgesendet")
        }
        if !docs.isEmpty {
            for listener in listeners.values { listener(docs) }
        }
        if failed > 0 {
            context.toasts.signal(.error)
            context.toasts.error(failed == 1 ? "Ein Eintrag ließ sich nicht nachsenden. Er bleibt im Puffer, siehe Liste." : "\(failed) Einträge ließen sich nicht nachsenden. Sie bleiben im Puffer, siehe Liste.")
        }
        if stopped && !loginNeeded { scheduleRetry() }
    }

    /// Solange etwas wartet, alle 30 s ein neuer Versuch.
    private func scheduleRetry() {
        guard retryTask == nil else { return }
        let interval = retryInterval
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: interval)
            guard !Task.isCancelled, let self else { return }
            self.retryTask = nil
            if self.waitingCount > 0 { await self.flush() }
        }
    }

    /// Verwirft einen Eintrag; er wird nicht gesendet.
    public func discard(_ entry: ReadingOutbox.Entry) {
        outbox.remove(entry.id)
        entries = outbox.all()
    }

    /// Hält die Wiederholung an (Abmelden).
    public func stop() {
        retryTask?.cancel()
        retryTask = nil
    }
}

/// Senden mit Meldung und Rückgängig für die Stores des Lesens (wie `ActionRunner`).
@MainActor
struct ReadingActions {
    let context: CockpitContext

    /// Sendet ohne Meldung; Fehler als `CockpitError`.
    func send(_ path: String, _ fields: [String: String]) async throws -> ReadingActionResponse {
        try await context.api.action(path, fields: fields, as: ReadingActionResponse.self)
    }

    /// Sendet `path` mit `fields`. Bei Erfolg Meldung (mit „Rückgängig“, wenn `undo` gesetzt ist
    /// und der Server eines liefert); bei Fehler Meldung, die stehen bleibt. nil bei Fehler.
    func run(_ path: String, _ fields: [String: String], undo: (@MainActor (UndoAction) -> Void)? = nil) async -> ReadingActionResponse? {
        do {
            let response = try await send(path, fields)
            show(response, undo: undo)
            return response
        } catch {
            context.report(error)
            return nil
        }
    }

    /// Meldung einer Antwort; leere Meldungen (Fortschritt) zeigen nichts.
    func show(_ response: ReadingActionResponse, undo: (@MainActor (UndoAction) -> Void)?) {
        guard !response.message.isEmpty else { return }
        if let undo, let action = response.undo {
            context.toasts.show(response.message, action: Toast.Action(label: "Rückgängig") { undo(action) })
        } else {
            context.toasts.show(response.message)
        }
    }
}
