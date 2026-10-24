import Foundation

/// Ein geteilter Link oder eine PDF-Datei, die noch zum Server muss. `id` bleibt über alle
/// Versuche gleich, der Server speichert damit nicht doppelt.
public struct PendingShare: Codable, Equatable, Sendable {
    public let id: String
    /// `nil` heißt PDF: die Datei liegt als `<id>.pdf` im Puffer.
    public let url: URL?
    public let title: String?

    public init(id: String = UUID().uuidString, url: URL?, title: String?) {
        self.id = id
        self.url = url
        self.title = title
    }
}

/// Puffer im App-Group-Container: Die Share Extension legt jede Anfrage zuerst hier ab und
/// löscht sie nach dem Senden. Was liegen bleibt (kein Netz, Extension beendet, abgemeldet),
/// sendet die App beim Start bzw. im Vordergrund mit `flush(using:)` nach.
///
/// Je Anfrage `<id>.json`, bei PDF dazu `<id>.pdf`. Die JSON-Datei kommt zuletzt, damit nur
/// vollständige Einträge gelesen werden.
public struct PendingShares: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    #if !os(Linux)
    /// `nil` ohne App-Group-Berechtigung (Simulator-Build ohne Signieren).
    public init?(appGroup: String) {
        guard !appGroup.isEmpty,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        else { return nil }
        directory = container.appending(path: "PendingShares", directoryHint: .isDirectory)
    }
    #endif

    /// Legt die Anfrage ab. `pdf` wird in den Puffer kopiert (als Datei, nicht über den Speicher).
    public func add(_ share: PendingShare, pdf: URL? = nil) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let pdf {
            let target = pdfFile(for: share)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.copyItem(at: pdf, to: target)
        }
        try JSONEncoder().encode(share).write(to: jsonFile(for: share.id), options: .atomic)
    }

    public func all() -> [PendingShare] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { file in
            (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(PendingShare.self, from: $0) }
        }
    }

    public func remove(_ share: PendingShare) {
        try? FileManager.default.removeItem(at: jsonFile(for: share.id))
        try? FileManager.default.removeItem(at: pdfFile(for: share))
    }

    public func pdfFile(for share: PendingShare) -> URL {
        directory.appending(path: "\(share.id).pdf")
    }

    /// Sendet eine Anfrage, ohne sie zu löschen.
    public func send(_ share: PendingShare, using api: APIClient) async throws -> SavedDocument {
        if let url = share.url {
            return try await api.saveToReadingList(url: url, title: share.title, id: share.id)
        }
        return try await api.saveToReadingList(pdfFile: pdfFile(for: share), title: share.title, id: share.id)
    }

    /// Sendet alles nach. Gesendetes und vom Server Abgelehntes verschwindet; bei einem
    /// vorübergehenden Fehler bleibt der Eintrag für den nächsten Versuch liegen, ohne Netz oder
    /// bei 401 auch der ganze Rest.
    /// Liefert die abgelehnten Anfragen mit Fehler (zum Protokollieren).
    @discardableResult
    public func flush(using api: APIClient) async -> [(share: PendingShare, error: Error)] {
        var rejected: [(PendingShare, Error)] = []
        for share in all() {
            do {
                _ = try await send(share, using: api)
                remove(share)
            } catch let error as APIError where error.isUnauthorized {
                break  // gilt für alle Einträge: liegen lassen bis zur neuen Anmeldung
            } catch is URLError {
                break  // kein Netz
            } catch where Self.isTemporary(error) {
                continue  // Server-Fehler bei diesem Eintrag: liegen lassen, die anderen trotzdem senden
            } catch {
                // Nochmal senden hilft nicht (z. B. ungültige Adresse, Datei zu groß).
                rejected.append((share, error))
                remove(share)
            }
        }
        return rejected
    }

    /// Später nochmal versuchen statt verwerfen: kein Netz, Server nicht erreichbar oder
    /// überlastet, Anmeldung abgelaufen.
    public static func isTemporary(_ error: Error) -> Bool {
        if let error = error as? APIError {
            return error.isUnauthorized || error.status == 408 || error.status == 429 || error.status >= 500
        }
        return error is URLError
    }

    private func jsonFile(for id: String) -> URL {
        directory.appending(path: "\(id).json")
    }
}
