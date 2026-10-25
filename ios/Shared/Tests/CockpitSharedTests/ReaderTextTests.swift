import Foundation
import XCTest
@testable import CockpitShared

/// Anker aus den Blöcken müssen beim Server dieselbe Stelle treffen wie die Anker des Webs aus
/// `textContent`. Die Markierungen in `lesen-doc.json` hat der Server aus dem echten Lesetext
/// gebildet (`anchorAt`); ihre Stellen sind die, die `placeHighlights` dort findet.
final class ReaderTextTests: XCTestCase {
    private func doc() throws -> ReadingDocModel {
        try JSONDecoder().decode(ReadingDocModel.self, from: try fixture("lesen-doc"))
    }

    func testRebuildsTextFromBlocks() throws {
        let model = try doc()
        let text = ReaderText(model: model)
        XCTAssertEqual(text.length, 501)
        XCTAssertEqual(text.slice(0..<23), "Warum der Stapel wächst")
        XCTAssertEqual(text.slice(144..<167), "Bild: Ein Stapel Bücher")
        XCTAssertEqual(text.slice(250..<262), "unterwegs 🚆")
        XCTAssertEqual(text.slice(334..<375), "stapel.push(text)\nstapel.length // wächst")
        // Jeder Lauf steht an seiner Stelle.
        for block in model.blocks {
            for run in block.runs where !run.extra {
                XCTAssertEqual(text.slice(run.start..<(run.start + run.text.utf16.count)), run.text)
            }
        }
        // Lücken (Leerraum zwischen den Blöcken) sind Leerzeichen.
        XCTAssertEqual(text.slice(23..<24), " ")
        XCTAssertEqual(text.slice(-5..<3), "War")
        XCTAssertEqual(text.slice(499..<600), "n.")
    }

    func testAnchorsMatchServerAnchors() throws {
        let model = try doc()
        let text = ReaderText(model: model)
        for h in model.highlights where !h.lost {
            let range = try XCTUnwrap(h.range)
            let anchor = try XCTUnwrap(text.anchor(for: range))
            XCTAssertEqual(anchor.quote, h.quote)
            XCTAssertEqual(anchor.start, h.startHint)
            // Bis auf die Art des Leerraums wie im Web; der Server vergleicht ohne Leerraum.
            XCTAssertEqual(ReaderText.compacted(anchor.prefix), ReaderText.compacted(h.prefix))
            XCTAssertEqual(ReaderText.compacted(anchor.suffix), ReaderText.compacted(h.suffix))
            XCTAssertEqual(anchor.prefix.utf16.count, min(32, range.lowerBound))
            XCTAssertEqual(anchor.suffix.utf16.count, min(32, text.length - range.upperBound))
        }
        // Ohne Leerraum zwischen den Listenpunkten sogar genau gleich.
        let marked = try JSONDecoder().decode(HighlightListModel.self, from: try fixture("lesen-markiert"))
        let later = try XCTUnwrap(marked.items.first { $0.id == "6f1c0b0e-1111-4c4c-9d9d-000000000001" })
        let anchor = try XCTUnwrap(text.anchor(for: 262..<286))
        XCTAssertEqual(anchor.quote, later.quote)
        XCTAssertEqual(anchor.prefix, later.prefix)
        XCTAssertEqual(ReaderText.compacted(anchor.suffix), ReaderText.compacted(later.suffix))
    }

    /// `locate` rechnet wie `findAnchor` auf dem Server: Server-Anker finden ihre Stelle, eigene
    /// Anker auch, verlorene keine.
    func testLocateLikeServer() throws {
        let model = try doc()
        let text = ReaderText(model: model)
        for h in model.highlights {
            let found = text.locate(quote: h.quote, prefix: h.prefix, suffix: h.suffix, startHint: h.startHint)
            XCTAssertEqual(found, h.range, h.quote)
        }
        for range in [0..<5, 35..<41, 58..<80, 131..<142, 250..<262, 287..<333, 334..<351, 409..<452, 452..<501] {
            let anchor = try XCTUnwrap(text.anchor(for: range))
            XCTAssertEqual(text.locate(anchor), range, anchor.quote)
        }
        // Gleiches Zitat zweimal: Präfix und Suffix entscheiden, nicht die alte Stelle.
        XCTAssertEqual(text.locate(quote: "Stapel", prefix: "Ein ", suffix: " ist", startHint: 0), 291..<297)
        XCTAssertNil(text.locate(quote: "   "))
        XCTAssertNil(text.locate(quote: "Gibt es nicht"))
    }

    func testAnchorEdges() throws {
        let model = try doc()
        let text = ReaderText(model: model)
        // Nur Leerraum ist keine Auswahl.
        XCTAssertNil(text.anchor(for: 23..<24))
        XCTAssertNil(text.anchor(for: 10..<10))
        // Anfang des Textes: kürzeres Präfix.
        XCTAssertEqual(text.anchor(for: 0..<5)?.prefix, "")
        XCTAssertEqual(text.anchor(for: 0..<5)?.fields, ["quote": "Warum", "prefix": "", "suffix": " der Stapel wächst Der Stapel wä", "start": "0"])
        // Ende des Textes: kürzeres Suffix.
        XCTAssertEqual(text.anchor(for: 490..<501)?.suffix, "")
        // Ganze Blöcke (H ohne Auswahl), Bild und Trennlinie ohne Text.
        XCTAssertEqual(text.anchor(for: model.blocks[1])?.quote, text.slice(24..<143))
        XCTAssertNil(text.anchor(for: model.blocks[2]))
        XCTAssertNil(text.anchor(for: model.blocks[12]))
        XCTAssertEqual(text.trimmedRange(of: model.blocks[10]), 287..<333)
        XCTAssertEqual(ReaderText.blockIndex(containing: 290, in: model.blocks), 10)
        XCTAssertEqual(ReaderText.blockIndex(containing: 286, in: model.blocks), 10)
        XCTAssertEqual(ReaderText.blockIndex(containing: 0, in: model.blocks), 0)
        XCTAssertNil(ReaderText.blockIndex(containing: 600, in: model.blocks))
    }

    /// Auswahl in der Anzeige eines Blocks → Stellen im Lesetext, und zurück zum Malen.
    func testDisplayOffsets() throws {
        let model = try doc()
        let text = ReaderText(model: model)
        let paragraph = model.blocks[1]
        XCTAssertEqual(paragraph.displayText, "Der Stapel wächst, weil Speichern leichter ist als Lesen. Wer viel speichert, liest am Ende weniger – sagt eine Studie.")
        let shown = paragraph.displayText.utf16
        let word = "leichter ist als Lesen"
        let at = try XCTUnwrap(paragraph.displayText.range(of: word))
        let lower = shown.distance(from: shown.startIndex, to: at.lowerBound)
        let selection = lower..<(lower + word.utf16.count)
        let range = paragraph.documentRange(forDisplay: selection)
        XCTAssertEqual(text.slice(range), word)
        XCTAssertEqual(paragraph.displayRange(for: range), selection)
        // Markierung über den Rand des Blocks: auf den Block gekürzt.
        XCTAssertEqual(paragraph.displayRange(for: 0..<30), 0..<6)
        XCTAssertNil(paragraph.displayRange(for: 200..<300))

        // Tabellenzeile: der Tab zwischen den Zellen hat keine Länge im Lesetext.
        let row = model.blocks[13]
        XCTAssertEqual(row.displayText, "Woche\tGespeichert\tGelesen")
        XCTAssertEqual(row.documentOffset(atDisplay: 6), 382)
        XCTAssertEqual(row.documentRange(forDisplay: 0..<25), 377..<400)
        XCTAssertEqual(row.displayRange(for: 382..<393), 6..<17)
        XCTAssertEqual(text.slice(row.documentRange(forDisplay: 6..<17)), "Gespeichert")

        // Umbruch (<br>): Auswahl über den Umbruch hinweg.
        let last = model.blocks[15]
        XCTAssertEqual(last.displayText, "Zum Schluss: Weniger speichern, mehr lesen.\nOder wenigstens: den Stapel ignorieren sortieren.")
        XCTAssertEqual(last.documentOffset(atDisplay: 43, preferNext: false), 452)
        XCTAssertEqual(last.documentOffset(atDisplay: 44), 452)
        XCTAssertEqual(text.slice(last.documentRange(forDisplay: 38..<48)), "esen.Oder")
        XCTAssertEqual(last.displayRange(for: 452..<456), 44..<48)

        // Emoji zählt zwei UTF-16-Einheiten wie im Browser.
        let train = model.blocks[8]
        XCTAssertEqual(train.documentRange(forDisplay: 10..<12), 260..<262)
        XCTAssertEqual(text.slice(260..<262), "🚆")
    }

    /// Zusammengefasster Leerraum: Läufe mit Lücke dazwischen zählen je ab ihrer eigenen `start`.
    func testCollapsedWhitespaceGaps() {
        let block = ReaderBlock(kind: .paragraph, start: 10, end: 27, runs: [
            ReaderRun(text: "Eins ", start: 10),
            ReaderRun(text: "zwei", start: 18, bold: true),
            ReaderRun(text: " drei", start: 22),
        ])
        let text = ReaderText(blocks: [block], length: 30)
        XCTAssertEqual(text.slice(10..<27), "Eins    zwei drei")
        XCTAssertEqual(block.documentOffset(atDisplay: 5), 18)
        XCTAssertEqual(block.documentOffset(atDisplay: 5, preferNext: false), 15)
        XCTAssertEqual(block.documentRange(forDisplay: 5..<9), 18..<22)
        XCTAssertEqual(block.displayOffset(atDocument: 16), 5)
        XCTAssertEqual(block.displayRange(for: 12..<20), 2..<7)
        let anchor = text.anchor(for: block.documentRange(forDisplay: 0..<14))
        XCTAssertEqual(anchor?.quote, "Eins    zwei drei")
        XCTAssertEqual(anchor.flatMap { text.locate($0) }, 10..<27)
    }
}
