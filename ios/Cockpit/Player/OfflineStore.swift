import CockpitShared
import Foundation

/// Texte für „Unterwegs hören“ ohne Netz. Je Text ein Ordner unter Application Support/Offline
/// (nicht Caches: iOS räumt die nicht leer, und offline heißt verlässlich da) mit `entry.json`
/// (Eintrag der Liste, Text, Lesestelle) und, wenn die Stimme vom Server liest, je Satz
/// `<start>-<end>.mp3`. Ein Text gilt erst als offline, wenn `entry.json` liegt; angefangene
/// Sätze aus einem abgebrochenen Laden nimmt der nächste Versuch mit. Nicht im iCloud-Backup.
actor OfflineStore {
    struct Entry: Codable, Equatable, Sendable {
        let item: QueueItem
        var text: ListenText
        /// Anbieter der Stimme vom Server beim Laden, nil = nur Text (Gerätestimme).
        let voice: String?
        let savedAt: Date
    }

    let root: URL
    private let files = FileManager.default

    init(root: URL) {
        self.root = root
    }

    static var defaultRoot: URL {
        URL.applicationSupportDirectory.appending(path: "Offline", directoryHint: .isDirectory)
    }

    /// Ordnername aus der ID; IDs sind UUIDs, alles andere wird kodiert.
    private func folder(_ id: String) -> URL {
        let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? id
        return root.appending(path: safe, directoryHint: .isDirectory)
    }

    private func clip(_ id: String, _ start: Int, _ end: Int) -> URL {
        folder(id).appending(path: "\(start)-\(end).mp3")
    }

    func entries() -> [Entry] {
        let dirs = (try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return dirs.compactMap { dir in
            (try? Data(contentsOf: dir.appending(path: "entry.json"))).flatMap { try? JSONDecoder().decode(Entry.self, from: $0) }
        }
        .sorted { $0.savedAt < $1.savedAt }
    }

    func entry(id: String) -> Entry? {
        (try? Data(contentsOf: folder(id).appending(path: "entry.json"))).flatMap { try? JSONDecoder().decode(Entry.self, from: $0) }
    }

    func save(_ entry: Entry) throws {
        try prepare(folder(entry.item.id))
        try JSONEncoder().encode(entry).write(to: folder(entry.item.id).appending(path: "entry.json"), options: .atomic)
    }

    func audio(id: String, start: Int, end: Int) -> Data? {
        try? Data(contentsOf: clip(id, start, end))
    }

    func saveAudio(_ data: Data, id: String, start: Int, end: Int) throws {
        try prepare(folder(id))
        try data.write(to: clip(id, start, end), options: .atomic)
    }

    /// Lesestelle der Offline-Kopie mitführen, damit sie ohne Netz an der richtigen Stelle anfängt.
    func updateProgress(id: String, progress: Double, anchor: Int?) {
        guard var entry = entry(id: id) else { return }
        entry.text = entry.text.at(progress: max(entry.text.progress, progress), anchor: anchor ?? entry.text.anchor)
        try? save(entry)
    }

    func remove(id: String) {
        try? files.removeItem(at: folder(id))
    }

    /// Belegter Platz in Bytes, für die Anzeige.
    func size(id: String) -> Int {
        let urls = (try? files.contentsOfDirectory(at: folder(id), includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return urls.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    private func prepare(_ dir: URL) throws {
        guard !files.fileExists(atPath: dir.path()) else { return }
        try files.createDirectory(at: dir, withIntermediateDirectories: true)
        var root = self.root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? root.setResourceValues(values)
    }
}

/// Server zuerst, ohne Netz die Offline-Kopien: Liste und Text fallen auf sie zurück, gespeicherte
/// Sätze kommen immer von der Platte (kostet nichts und geht schneller). Fortschritt geht in die
/// Kopie und an den Server; ohne Netz puffert ihn der Player wie bisher.
struct OfflineListenService: ListenService {
    let online: any ListenService
    let offline: OfflineStore

    /// Kein Netz oder Server nicht erreichbar; ein abgelehnter Token (401) bleibt ein Fehler.
    static func isUnreachable(_ error: Error) -> Bool {
        if error is URLError { return true }
        guard let status = (error as? APIError)?.status else { return false }
        return status >= 500 || status == 0
    }

    func queue(minutes: Int) async throws -> Queue {
        do {
            return try await online.queue(minutes: minutes)
        } catch where Self.isUnreachable(error) {
            let entries = await offline.entries().filter { $0.text.progress < 1 }
            guard !entries.isEmpty else { throw error }
            return Queue(minutes: minutes, voice: entries.compactMap(\.voice).first, items: entries.map(\.item))
        }
    }

    func text(id: String) async throws -> ListenText {
        do {
            return try await online.text(id: id)
        } catch where Self.isUnreachable(error) {
            guard let entry = await offline.entry(id: id) else { throw error }
            return entry.text
        }
    }

    func audio(id: String, start: Int, end: Int) async throws -> Data {
        if let data = await offline.audio(id: id, start: start, end: end) { return data }
        return try await online.audio(id: id, start: start, end: end)
    }

    func saveProgress(id: String, progress: Double, anchor: Int?) async throws -> Double {
        await offline.updateProgress(id: id, progress: progress, anchor: anchor)
        return try await online.saveProgress(id: id, progress: progress, anchor: anchor)
    }

    func addHighlight(_ highlight: NewHighlight) async throws -> HighlightResult {
        try await online.addHighlight(highlight)
    }
}
