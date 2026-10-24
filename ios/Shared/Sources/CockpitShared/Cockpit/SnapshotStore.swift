import Foundation

/// Letzte erfolgreiche Antwort eines Lesewegs mit ihrem Zeitpunkt.
public struct Snapshot: Equatable, Sendable {
    public let data: Data
    public let savedAt: Date

    public init(data: Data, savedAt: Date) {
        self.data = data
        self.savedAt = savedAt
    }
}

/// Zwischenspeicher auf der Platte: je Schlüssel (z. B. `woche/2026-W42`) die letzte
/// erfolgreiche JSON-Antwort. Die Bildschirme zeigen damit sofort den letzten Stand und laden
/// im Hintergrund neu. Kaputte oder fremde Dateien gelten als nicht vorhanden.
///
/// Eine Datei je Schlüssel, `{key, savedAt, data}`; geschrieben wird atomar.
public struct SnapshotStore: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// `Application Support/Snapshots`, nicht im Backup (der Server hat alles).
    public static func applicationSupport() -> SnapshotStore {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        return SnapshotStore(directory: base.appending(path: "Snapshots", directoryHint: .isDirectory))
    }

    public func load(_ key: String) -> Snapshot? {
        guard let raw = try? Data(contentsOf: file(for: key)),
              let entry = try? JSONDecoder().decode(Entry.self, from: raw),
              entry.key == key
        else { return nil }
        return Snapshot(data: entry.data, savedAt: entry.savedAt)
    }

    public func save(_ data: Data, for key: String, at date: Date = Date()) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if canImport(Darwin)
        var dir = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        #endif
        let entry = Entry(key: key, savedAt: date, data: data)
        try JSONEncoder().encode(entry).write(to: file(for: key), options: .atomic)
    }

    public func remove(_ key: String) {
        try? FileManager.default.removeItem(at: file(for: key))
    }

    /// Beim Abmelden: nichts vom alten Konto soll stehen bleiben.
    public func removeAll() {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Dateiname aus dem Schlüssel: Buchstaben, Ziffern und `-` bleiben, alles andere wird
    /// `_XX` (Byte in Hex). Lange Schlüssel (Suchbegriffe) werden gekürzt und bekommen eine Prüfsumme.
    func file(for key: String) -> URL {
        var name = ""
        for byte in key.utf8 {
            switch byte {
            case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"):
                name.append(Character(UnicodeScalar(byte)))
            default:
                name += String(format: "_%02X", byte)
            }
        }
        if name.count > 120 {
            name = "\(name.prefix(100))_\(Self.checksum(key))"
        }
        return directory.appending(path: "\(name).json")
    }

    /// FNV-1a über die UTF-8-Bytes, als Hex (stabil über Starts hinweg, anders als `hashValue`).
    static func checksum(_ text: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
    }

    private struct Entry: Codable {
        let key: String
        let savedAt: Date
        let data: Data
    }
}
