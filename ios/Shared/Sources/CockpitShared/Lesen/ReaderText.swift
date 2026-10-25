import Foundation

/// Anker einer neuen Markierung, wie ihn die Leseansicht im Web bildet (static/lesen-doc.js,
/// `anchorOf`): das Zitat, je 32 Zeichen davor und danach und sein Anfang im Lesetext (UTF-16).
public struct HighlightAnchor: Codable, Equatable, Hashable, Sendable {
    public let quote: String
    public let prefix: String
    public let suffix: String
    public let start: Int

    public init(quote: String, prefix: String, suffix: String, start: Int) {
        self.quote = quote
        self.prefix = prefix
        self.suffix = suffix
        self.start = start
    }

    /// Formularfelder für `/aktion/lesen/markierung/neu` und `/markierung/inbox`.
    public var fields: [String: String] {
        ["quote": quote, "prefix": prefix, "suffix": suffix, "start": String(start)]
    }

    /// Ende im Lesetext (UTF-16).
    public var end: Int { start + quote.utf16.count }
}

/// Lesetext einer Leseansicht, aus den Blöcken zurückgebaut: an jeder Stelle steht das Zeichen
/// aus dem Lauf, der sie abdeckt; Lücken (Leerraum zwischen und in Blöcken) sind Leerzeichen,
/// ein Bild steht als „Bild: …“ darin wie im Web. Bis auf die Art des Leerraums ist das genau
/// `textContent` der Leseansicht im Web; der Server vergleicht Anker ohne Leerraum
/// (src/lesen/anchor.js, `findAnchor`), deshalb finden Anker von hier dieselbe Stelle.
public struct ReaderText: Equatable, Sendable {
    /// So viele Zeichen Umgebung nimmt ein neuer Anker mit (`CONTEXT`).
    public static let context = 32

    /// UTF-16-Einheiten des Lesetexts.
    public let units: [UInt16]

    public init(blocks: [ReaderBlock], length: Int) {
        var size = max(0, length)
        for block in blocks {
            size = max(size, block.end)
            for run in block.runs where !run.extra { size = max(size, run.start + run.text.utf16.count) }
        }
        var units = [UInt16](repeating: 0x20, count: size)
        func write(_ text: String, at start: Int) {
            guard start >= 0 else { return }
            for (offset, unit) in text.utf16.enumerated() where start + offset < size {
                units[start + offset] = unit
            }
        }
        for block in blocks {
            if block.kind == .image {
                // Das Web hat hier den Linktext „Bild: alt“ (sanitizeHtml); nur bei passender Länge.
                let alt = block.alt ?? ""
                let label = alt.isEmpty ? "Bild" : "Bild: \(alt)"
                if label.utf16.count == block.end - block.start { write(label, at: block.start) }
                continue
            }
            for run in block.runs where !run.extra { write(run.text, at: run.start) }
        }
        self.units = units
    }

    public init(model: ReadingDocModel) {
        self.init(blocks: model.blocks, length: model.length)
    }

    public var length: Int { units.count }
    public var string: String { String(decoding: units, as: UTF16.self) }

    /// Text von `range` (UTF-16, auf den Text gekürzt).
    public func slice(_ range: Range<Int>) -> String {
        let lower = min(max(0, range.lowerBound), units.count)
        let upper = min(max(lower, range.upperBound), units.count)
        return String(decoding: units[lower..<upper], as: UTF16.self)
    }

    /// Anker für `range` wie `anchorOf` im Web; nil, wenn darin nur Leerraum steht.
    public func anchor(for range: Range<Int>) -> HighlightAnchor? {
        let start = min(max(0, range.lowerBound), units.count)
        let end = min(max(start, range.upperBound), units.count)
        guard units[start..<end].contains(where: { !Self.isSpace($0) }) else { return nil }
        return HighlightAnchor(
            quote: slice(start..<end),
            prefix: slice(max(0, start - Self.context)..<start),
            suffix: slice(end..<(end + Self.context)),
            start: start
        )
    }

    /// Anker für einen ganzen Block (H ohne Auswahl), ohne Leerraum am Rand; nil ohne Text
    /// (Bild, Trennlinie).
    public func anchor(for block: ReaderBlock) -> HighlightAnchor? {
        guard block.kind != .image, block.kind != .rule else { return nil }
        var start = max(0, block.start)
        var end = min(block.end, units.count)
        while start < end, Self.isSpace(units[start]) { start += 1 }
        while end > start, Self.isSpace(units[end - 1]) { end -= 1 }
        return start < end ? anchor(for: start..<end) : nil
    }

    /// Bereich eines Blocks ohne Leerraum am Rand.
    public func trimmedRange(of block: ReaderBlock) -> Range<Int>? {
        anchor(for: block).map { $0.start..<$0.end }
    }

    /// Index des Blocks, in dem `offset` liegt (zwischen Blöcken: der nächste danach).
    public static func blockIndex(containing offset: Int, in blocks: [ReaderBlock]) -> Int? {
        if let index = blocks.firstIndex(where: { offset >= $0.start && offset < $0.end }) { return index }
        return blocks.firstIndex { $0.start >= offset }
    }

    /// Sucht einen Anker im Text wie `findAnchor` auf dem Server: Zitat ohne Leerraum, Präfix und
    /// Suffix entscheiden zwischen gleichen Zitaten, `startHint` nur bei Gleichstand. nil, wenn
    /// das Zitat fehlt. Für wartende Markierungen aus dem Puffer.
    public func locate(quote: String, prefix: String = "", suffix: String = "", startHint: Int? = nil) -> Range<Int>? {
        let q = Self.compact(Array(quote.utf16)).units
        guard !q.isEmpty else { return nil }
        let pre = Self.compact(Array(prefix.utf16)).units
        let suf = Self.compact(Array(suffix.utf16)).units
        let (s, map) = Self.compact(units)
        guard s.count >= q.count else { return nil }
        var best: (score: Int, distance: Int, start: Int, end: Int)?
        var i = 0
        while i + q.count <= s.count {
            if s[i] == q[0], Array(s[i..<(i + q.count)]) == q {
                let before = s[max(0, i - pre.count)..<i]
                let after = s[(i + q.count)..<min(s.count, i + q.count + suf.count)]
                let score = Self.sameTail(Array(before), pre) + Self.sameHead(Array(after), suf)
                let distance = startHint.map { abs(map[i] - $0) } ?? 0
                if best == nil || score > best!.score || (score == best!.score && distance < best!.distance) {
                    best = (score, distance, map[i], map[i + q.count - 1] + 1)
                }
            }
            i += 1
        }
        return best.map { $0.start..<$0.end }
    }

    public func locate(_ anchor: HighlightAnchor) -> Range<Int>? {
        locate(quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, startHint: anchor.start)
    }

    // MARK: Leerraum wie `\s` in JavaScript

    /// `\s` in JavaScript, je UTF-16-Einheit.
    public static func isSpace(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
        default: false
        }
    }

    /// Text ohne Leerraum und je Einheit ihre Stelle im Original (`compact` in anchor.js).
    static func compact(_ units: [UInt16]) -> (units: [UInt16], map: [Int]) {
        var out: [UInt16] = []
        var map: [Int] = []
        out.reserveCapacity(units.count)
        map.reserveCapacity(units.count)
        for (index, unit) in units.enumerated() where !isSpace(unit) {
            out.append(unit)
            map.append(index)
        }
        return (out, map)
    }

    /// Text ohne Leerraum, zum Vergleichen von Zitaten.
    public static func compacted(_ text: String) -> String {
        String(decoding: compact(Array(text.utf16)).units, as: UTF16.self)
    }

    private static func sameTail(_ a: [UInt16], _ b: [UInt16]) -> Int {
        var n = 0
        while n < a.count, n < b.count, a[a.count - 1 - n] == b[b.count - 1 - n] { n += 1 }
        return n
    }

    private static func sameHead(_ a: [UInt16], _ b: [UInt16]) -> Int {
        var n = 0
        while n < a.count, n < b.count, a[n] == b[n] { n += 1 }
        return n
    }
}
