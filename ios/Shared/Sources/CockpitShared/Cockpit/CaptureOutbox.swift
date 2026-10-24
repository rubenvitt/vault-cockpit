import Foundation

/// Puffer der Schnelleingabe ohne Netz (wie `cockpit-puffer` in offline.js): Jeder Eintrag
/// behält seine Erfassungs-ID (`cid`), damit der Server beim Nachsenden nichts doppelt anlegt.
/// Liegt als eine JSON-Datei auf der Platte und übersteht Neustarts und Abmelden.
public struct CaptureOutbox: Sendable {
    public struct Entry: Codable, Equatable, Identifiable, Sendable {
        /// Erfassungs-ID (`cid`), bleibt über alle Versuche gleich.
        public let id: String
        public let text: String
        public let created: Date
        /// Ablehnung des Servers; solche Einträge gehen nur mit „Erneut senden“ wieder raus.
        public var error: String?
        public var failedAt: Date?

        public init(id: String, text: String, created: Date, error: String? = nil, failedAt: Date? = nil) {
            self.id = id
            self.text = text
            self.created = created
            self.error = error
            self.failedAt = failedAt
        }

        /// „Aufgabe“, „Artikel“ oder „Notiz“ wie im Puffer des Webs.
        public var kind: String { CaptureText.kind(of: text) }
    }

    public let file: URL

    public init(file: URL) {
        self.file = file
    }

    /// `Application Support/Puffer/erfassen.json`.
    public static func applicationSupport() -> CaptureOutbox {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return CaptureOutbox(file: base.appending(path: "Puffer", directoryHint: .isDirectory).appending(path: "erfassen.json"))
    }

    /// Alle Einträge, ältester zuerst.
    public func all() -> [Entry] {
        guard let data = try? Data(contentsOf: file),
              let entries = try? JSONDecoder().decode([Entry].self, from: data)
        else { return [] }
        return entries.sorted { $0.created < $1.created }
    }

    /// Legt ab oder ersetzt den Eintrag mit derselben ID.
    public func put(_ entry: Entry) throws {
        var entries = all().filter { $0.id != entry.id }
        entries.append(entry)
        try write(entries)
    }

    public func remove(_ id: String) {
        try? write(all().filter { $0.id != id })
    }

    private func write(_ entries: [Entry]) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(entries).write(to: file, options: .atomic)
    }
}
