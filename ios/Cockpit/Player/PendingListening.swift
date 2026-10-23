import CockpitShared
import Foundation

/// Puffer für Fortschritt und Markierungen, die noch zum Server müssen. Liegt in den
/// `UserDefaults` der App Group, überlebt also Neustarts. Je Text nur der letzte Stand.
struct PendingListening: Codable, Equatable {
    enum Job: Equatable {
        case progress(ProgressUpdate)
        case highlight(NewHighlight)
    }

    // shortcut: feste Obergrenze, die ältesten Markierungen fallen raus; erst ändern, wenn jemand tagelang offline merkt.
    static let maxHighlights = 100
    static let key = "player.pending"

    private(set) var progress: [ProgressUpdate] = []
    private(set) var highlights: [NewHighlight] = []

    var next: Job? {
        progress.first.map(Job.progress) ?? highlights.first.map(Job.highlight)
    }

    func contains(cid: String) -> Bool {
        highlights.contains { $0.cid == cid }
    }

    /// Letzter Anker gewinnt, der Fortschritt sinkt nie (der Server nimmt jeden Wert).
    mutating func add(_ update: ProgressUpdate) {
        guard let i = progress.firstIndex(where: { $0.id == update.id }) else { return progress.append(update) }
        progress[i] = ProgressUpdate(id: update.id, progress: max(progress[i].progress, update.progress), anchor: update.anchor)
    }

    mutating func add(_ highlight: NewHighlight) {
        guard !highlights.contains(where: { $0.cid == highlight.cid }) else { return }
        highlights.append(highlight)
        highlights.removeFirst(max(0, highlights.count - Self.maxHighlights))
    }

    /// Nach dem Senden entfernen, aber nur, wenn inzwischen kein neuerer Stand dazukam.
    mutating func remove(_ job: Job) {
        switch job {
        case .progress(let sent): progress.removeAll { $0 == sent }
        case .highlight(let sent): highlights.removeAll { $0.cid == sent.cid }
        }
    }

    /// Später noch einmal versuchen? Netzfehler, Serverfehler, 401 (bis zur neuen Anmeldung) und
    /// 429 ja; andere 4xx (Artikel weg, `cid` gehört woanders hin) nie, sonst hängt der Puffer fest.
    static func shouldRetry(_ error: Error) -> Bool {
        shouldRetry(status: (error as? APIError)?.status)
    }

    /// `status` nil: kein HTTP-Fehler, also Netz.
    static func shouldRetry(status: Int?) -> Bool {
        guard let status else { return true }
        return status >= 500 || status == 401 || status == 429 || status == 0
    }

    init() {}

    init(defaults: UserDefaults) {
        self = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(Self.self, from: $0) } ?? Self()
    }

    func save(to defaults: UserDefaults) {
        defaults.set(try? JSONEncoder().encode(self), forKey: Self.key)
    }
}
