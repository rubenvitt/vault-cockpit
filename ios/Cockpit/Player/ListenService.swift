import CockpitShared
import Foundation

/// Was der Player vom Server braucht. `APIClient` ist die echte Umsetzung, Tests und die
/// Debug-Vorführung (`-PlayerDemo`) nehmen eigene.
protocol ListenService: Sendable {
    func queue(minutes: Int) async throws -> Queue
    func text(id: String) async throws -> ListenText
    func saveProgress(id: String, progress: Double, anchor: Int?) async throws -> Double
    func addHighlight(_ highlight: NewHighlight) async throws -> HighlightResult
    /// MP3 eines Satzes von der Stimme auf dem Server (nur, wenn `Queue.voice` gesetzt ist).
    func audio(id: String, start: Int, end: Int) async throws -> Data
}

extension APIClient: ListenService {}

/// `APIClient` mit dem Token, der gerade in der Keychain liegt, bei jedem Aufruf neu gelesen:
/// Meldet die App nach einem 401 neu an, arbeitet ein laufender Player gleich mit dem neuen Token
/// weiter, statt mit dem abgelehnten erneut den Login auszulösen.
struct KeychainListenService: ListenService {
    let baseURL: URL
    let keychain: KeychainStore

    private func client() throws -> APIClient {
        guard let token = try keychain.token() else {
            throw APIError(status: 401, code: "unauthorized", message: "Bitte in der Cockpit-App neu anmelden.")
        }
        return APIClient(baseURL: baseURL, token: token)
    }

    func queue(minutes: Int) async throws -> Queue { try await client().queue(minutes: minutes) }
    func text(id: String) async throws -> ListenText { try await client().text(id: id) }
    func saveProgress(id: String, progress: Double, anchor: Int?) async throws -> Double {
        try await client().saveProgress(id: id, progress: progress, anchor: anchor)
    }
    func addHighlight(_ highlight: NewHighlight) async throws -> HighlightResult { try await client().addHighlight(highlight) }
    func audio(id: String, start: Int, end: Int) async throws -> Data { try await client().audio(id: id, start: start, end: end) }
}

#if DEBUG
/// Fester deutscher Text ohne Server, für den Simulator (der unsignierte Build hat keinen
/// Geräte-Token): `xcrun simctl launch booted dev.rubeen.cockpit -PlayerDemo` und für Previews.
struct DemoListenService: ListenService {
    static var isRequested: Bool { ProcessInfo.processInfo.arguments.contains("-PlayerDemo") }

    private static let parts = ["Grüße aus Köln 👋🏽.", "Der Player liest diesen Text satzweise vor.", "Nach jedem Satz merkt er sich die Stelle.", "Das hier merken markiert den laufenden Satz."]

    private static func decode<T: Decodable>(_ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func queue(minutes: Int) async throws -> Queue {
        try Self.decode(#"{"zeit": \#(minutes), "items": [{"id": "demo", "title": "Vorführung", "url": "https://example.org", "site": "example.org", "kind": "article", "minutes": 1, "remaining": 1, "progress": 0}]}"#)
    }

    func text(id: String) async throws -> ListenText {
        // Satzgrenzen wie der Server: UTF-16-Offsets.
        var sentences: [[Int]] = []
        var start = 0
        for part in Self.parts {
            sentences.append([start, start + part.utf16.count])
            start += part.utf16.count + 1
        }
        let body: [String: Any] = ["id": id, "title": "Vorführung", "text": Self.parts.joined(separator: " "), "sentences": sentences, "progress": 0, "anchor": 0]
        return try JSONDecoder().decode(ListenText.self, from: JSONSerialization.data(withJSONObject: body))
    }

    func saveProgress(id: String, progress: Double, anchor: Int?) async throws -> Double { progress }

    func addHighlight(_ highlight: NewHighlight) async throws -> HighlightResult {
        try Self.decode(#"{"id": "h1", "duplicate": false, "message": "Markiert"}"#)
    }

    /// Die Vorführung hat keine Stimme vom Server (`voice` fehlt in der Liste).
    func audio(id: String, start: Int, end: Int) async throws -> Data {
        throw APIError(status: 404, code: "not_found", message: "Keine Stimme auf dem Server eingerichtet")
    }
}
#endif
