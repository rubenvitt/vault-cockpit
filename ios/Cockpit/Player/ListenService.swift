import CockpitShared
import Foundation

/// Was der Player vom Server braucht. `APIClient` ist die echte Umsetzung, Tests und die
/// Debug-Vorführung (`-PlayerDemo`) nehmen eigene.
protocol ListenService: Sendable {
    func queue(minutes: Int) async throws -> Queue
    func text(id: String) async throws -> ListenText
    func saveProgress(id: String, progress: Double, anchor: Int?) async throws -> Double
    func addHighlight(_ highlight: NewHighlight) async throws -> HighlightResult
}

extension APIClient: ListenService {}

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
}
#endif
