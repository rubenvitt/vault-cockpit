import CockpitShared
import Foundation

/// Gespeicherte Lesestelle nach einem Satz: `anchor` in UTF-16-Einheiten des Textes, `progress` 0…1.
struct ProgressUpdate: Codable, Equatable {
    let id: String
    let progress: Double
    let anchor: Int
}

/// Ein Text der Wiedergabeliste, zerlegt in Sätze. Alle Offsets zählen UTF-16-Einheiten wie
/// JS-Strings, denn so rechnet der Server (`src/lesen/listen.js`) und die Leseansicht
/// (`src/lesen/anchor.js`). Ein „ü“ ist eine Einheit, ein Emoji meist zwei.
struct SpeechText: Equatable {
    struct Sentence: Equatable {
        let start: Int
        let end: Int
    }

    /// So viele Einheiten Umgebung nimmt ein Anker mit (`CONTEXT` in `src/lesen/anchor.js`).
    static let context = 32
    /// Längstes Zitat in UTF-16-Einheiten (`MAX_QUOTE` in `src/lesen/highlights.js`).
    static let maxQuote = 4000

    let id: String
    let sentences: [Sentence]
    /// Erster Satz ab der gespeicherten Lesestelle bzw. dem Fortschritt, sonst 0 (wie `load` in `lesen-hoeren.js`).
    let startSentence: Int
    /// Fortschritt 0…1; `finish` lässt ihn nie sinken.
    private(set) var progress: Double
    private let units: [UInt16]

    init(_ listen: ListenText) {
        id = listen.id
        units = Array(listen.text.utf16)
        let length = units.count
        // Offsets kommen vom Server: auf den Text begrenzen, leere und kaputte verwerfen.
        sentences = listen.sentences.compactMap { pair in
            guard pair.count == 2 else { return nil }
            let start = min(max(pair[0], 0), length)
            let end = min(max(pair[1], 0), length)
            return start < end ? Sentence(start: start, end: end) : nil
        }
        // Ohne Anker (Fortschritt ohne `anker` gespeichert) die Stelle aus dem Fortschritt schätzen.
        let from = listen.anchor > 0 ? listen.anchor : Int(listen.progress * Double(length))
        startSentence = sentences.firstIndex { $0.start >= from } ?? 0
        progress = min(max(listen.progress, 0), 1)
    }

    /// Länge in UTF-16-Einheiten, wie `text.length` in JS.
    var length: Int { units.count }

    func text(of sentence: Int) -> String {
        slice(sentences[sentence].start, sentences[sentence].end)
    }

    /// Markierung für einen Satz, aufgebaut wie `anchorAt` in `src/lesen/anchor.js`. Längere Sätze
    /// werden auf `maxQuote` gekürzt, sonst lehnt der Server ab; das Suffix folgt dem gekürzten Zitat.
    func highlight(of sentence: Int, cid: String) -> NewHighlight {
        let s = sentences[sentence]
        var end = min(s.end, s.start + Self.maxQuote)
        if splitsPair(end) { end -= 1 }
        return NewHighlight(
            id: id,
            quote: slice(s.start, end),
            prefix: slice(s.start - Self.context, s.start),
            suffix: slice(end, end + Self.context),
            start: s.start,
            cid: cid
        )
    }

    /// Satz zu Ende gehört: Anker ist der Anfang des nächsten Satzes, am Ende Fortschritt 1.
    mutating func finish(_ sentence: Int) -> ProgressUpdate {
        let current = sentences[sentence]
        let next = sentence + 1 < sentences.count ? sentences[sentence + 1] : nil
        progress = next == nil ? 1 : max(progress, Double(current.end) / Double(max(length, 1)))
        return ProgressUpdate(id: id, progress: progress, anchor: next?.start ?? current.start)
    }

    /// Text zwischen zwei UTF-16-Offsets wie `String.prototype.slice`. Fällt eine Grenze mitten in
    /// ein Surrogatpaar (Emoji), rückt sie nach innen: Ein halbes Paar kann ein Swift-String nicht
    /// halten, und `findAnchor` vergleicht Präfix und Suffix vom Zitat aus, ein Zeichen weniger schadet nicht.
    func slice(_ from: Int, _ to: Int) -> String {
        var a = min(max(from, 0), units.count)
        var b = min(max(to, 0), units.count)
        if splitsPair(a) { a += 1 }
        if splitsPair(b) { b -= 1 }
        guard a < b else { return "" }
        return String(decoding: units[a..<b], as: UTF16.self)
    }

    private func splitsPair(_ i: Int) -> Bool {
        i > 0 && i < units.count && UTF16.isLeadSurrogate(units[i - 1]) && UTF16.isTrailSurrogate(units[i])
    }
}
