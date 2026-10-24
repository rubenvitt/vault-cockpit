import Foundation

/// Was alle Bildschirm-Stores teilen: API mit Token, Zwischenspeicher, Meldungen und die
/// Haken in die Oberfläche (neu anmelden, Links öffnen). Die App legt einen je Anmeldung an.
@MainActor
public final class CockpitContext {
    public let api: CockpitAPI
    public let snapshots: SnapshotStore
    public let toasts: ToastCenter
    /// Ablage der Schnelleingabe ohne Netz.
    public let outbox: CaptureOutbox
    public var now: () -> Date
    /// 401: Token abgelehnt, die App meldet ab und zeigt den Login.
    public var onUnauthorized: @MainActor () -> Void = {}
    /// Externer Link (Zunder-Aufgabe nach „Öffnen“ im Toast).
    public var openURL: @MainActor (URL) -> Void = { _ in }
    /// Web-Pfad aus `redirect`, den kein Store selbst abbildet; die App wählt Reiter oder Web-Ansicht.
    public var openPath: @MainActor (String) -> Void = { _ in }

    public init(api: CockpitAPI, snapshots: SnapshotStore, outbox: CaptureOutbox, toasts: ToastCenter? = nil, now: @escaping () -> Date = { Date() }) {
        self.api = api
        self.snapshots = snapshots
        self.outbox = outbox
        self.toasts = toasts ?? ToastCenter()
        self.now = now
    }

    /// Meldet einen Fehler: 401 führt zum Login, sonst Toast (Fehler bleiben stehen) und Haptik.
    func report(_ error: Error, action: Bool = true) {
        guard !CockpitError.isCancellation(error) else { return }
        let error = CockpitError.from(error, action: action)
        if error.isUnauthorized { onUnauthorized() }
        toasts.signal(.error)
        toasts.error(error.message)
    }

    /// Gespeicherter Stand für `key`, dekodiert; nil, wenn keiner da ist oder er nicht mehr passt.
    func cached<T: Decodable>(_ type: T.Type, key: String) -> (value: T, savedAt: Date)? {
        guard let snapshot = snapshots.load(key),
              let value = try? CockpitAPI.decode(T.self, from: snapshot.data)
        else { return nil }
        return (value, snapshot.savedAt)
    }

    /// Holt `path`, dekodiert und legt die rohe Antwort unter `key` ab.
    func fetch<T: Decodable>(_ type: T.Type, path: String, query: [URLQueryItem], key: String) async throws -> (value: T, savedAt: Date) {
        let data = try await api.data(path, query: query)
        let value = try CockpitAPI.decode(T.self, from: data)
        let savedAt = now()
        try? snapshots.save(data, for: key, at: savedAt)
        return (value, savedAt)
    }
}

/// Ladezustand eines Bildschirms, gemeinsam für Woche, Rückblick und Planung.
public struct LoadState: Equatable, Sendable {
    /// Lädt gerade neu (der gezeigte Stand bleibt sichtbar).
    public var isRefreshing = false
    /// Zeitpunkt des gezeigten Stands (aus dem Zwischenspeicher oder vom letzten Laden).
    public var lastUpdated: Date?
    /// Der gezeigte Stand kommt aus dem Zwischenspeicher und ist nicht frisch bestätigt
    /// („Stand von …“).
    public var isStale = false
    /// Fehler des letzten Ladens, z. B. „Keine Verbindung zum Cockpit.“
    public var error: CockpitError?

    public init() {}

    public var isOffline: Bool { error?.isOffline ?? false }
}
