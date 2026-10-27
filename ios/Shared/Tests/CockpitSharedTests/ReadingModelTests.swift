import Foundation
import XCTest
@testable import CockpitShared

/// Die Fixtures `lesen-*.json` sind echte Antworten von `/api/lesen/…` und `/aktion/lesen/…`
/// (test/lesen-app-json.test.js rechnet mit demselben Server).
final class ReadingModelTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: try fixture(name))
    }

    // MARK: Eingang und Stapel

    func testInbox() throws {
        let model = try decode(ReadingInboxModel.self, "lesen-eingang")
        let card = try XCTUnwrap(model.doc)
        XCTAssertEqual(card.id, "64e6253f-0e9a-4a0b-8b7b-ea1e7ec0575d")
        XCTAssertEqual(card.title, "Neu im Blog: Feeds ordnen")
        XCTAssertEqual(card.kindLabel, "Feed-Eintrag")
        XCTAssertEqual(card.status, .inbox)
        XCTAssertEqual(card.readingMinutes, 5)
        XCTAssertEqual(card.topics, ["Technik"])
        XCTAssertEqual(card.siteLabel, "Beispiel-Blog")
        XCTAssertEqual(card.why, "Feed Beispiel-Blog, abonniert im Oktober 2026")
        XCTAssertEqual(card.savedLabel, "23. Okt.")
        XCTAssertEqual(card.feed?.groupId, "f60a3c79-3a3c-4e05-bda2-4c565b140c5f")
        XCTAssertEqual(model.left, 1)
        XCTAssertFalse(model.more)
        XCTAssertEqual(model.today.seen, 1)
        XCTAssertEqual(model.today.total, 2)
        XCTAssertEqual(model.today.last?.title, "Newsletter Oktober")
        XCTAssertEqual(model.progressLabel, "Heute 1 von 2 gesichtet")
        XCTAssertEqual(model.undo, UndoAction(action: "/aktion/lesen/sortieren", fields: ["id": "2f94c7c3-f257-413a-be3a-365c29ddcb50", "ziel": "eingang"]))
        XCTAssertNil(model.filter.gruppe)
        XCTAssertEqual(model.groups.map(\.name), ["Technik", "Gesellschaft"])
        XCTAssertEqual(model.groups.map(\.count), [1, 0])
        XCTAssertTrue(model.showGroups)
        XCTAssertTrue(model.vault)

        let group = try decode(ReadingInboxModel.self, "lesen-eingang-gruppe")
        XCTAssertEqual(group.filter.gruppe, "f60a3c79-3a3c-4e05-bda2-4c565b140c5f")
        XCTAssertNil(group.undo)
        XCTAssertNil(group.today.last)

        let empty = try decode(ReadingInboxModel.self, "lesen-eingang-leer")
        XCTAssertNil(empty.doc)
        XCTAssertEqual(empty.left, 0)
        XCTAssertEqual(empty.filter.gruppe, ReadingGroupFilter.noFeed)
    }

    func testStack() throws {
        let all = try decode(ReadingStackModel.self, "lesen-stapel")
        XCTAssertNil(all.zeit)
        XCTAssertEqual(all.sort, "passt")
        XCTAssertEqual(all.windows, [5, 15, 30, 60])
        XCTAssertEqual(all.sorts.map(\.label), ["Passt jetzt", "Neueste", "Kürzeste"])
        XCTAssertEqual(all.count, 4)
        XCTAssertNil(all.window)
        XCTAssertTrue(all.episodes)
        XCTAssertEqual(all.listenZeit, 15)
        XCTAssertEqual(all.episodeZeit, 30)
        XCTAssertEqual(all.items.map(\.remaining), [2, 8, 7, 45])
        XCTAssertEqual(all.items.map(\.started), [true, true, false, false])
        XCTAssertEqual(all.items[1].scrollAnchor, 186)
        XCTAssertEqual(all.items[1].meta, "Weiterlesen · noch 8 Min. · Blatt")
        XCTAssertEqual(all.items[2].meta, "7 Min. · Zeit")
        // Restzeit wie der Server.
        XCTAssertEqual(all.items.map(\.doc.remainingMinutes), [2, 8, 7, 45])

        let window = try decode(ReadingStackModel.self, "lesen-stapel-zeit")
        XCTAssertEqual(window.zeit, 15)
        XCTAssertEqual(window.window, StackWindow(used: 10, of: 15, more: 2, fits: true))
        XCTAssertEqual(window.items.count, 2)

        let none = try decode(ReadingStackModel.self, "lesen-stapel-nichts-passt")
        XCTAssertEqual(none.window?.fits, false)
        XCTAssertEqual(none.items.map(\.title), ["Vom langsamen Lesen"])
        XCTAssertEqual(none.filter.gruppe, "ohne")

        let short = try decode(ReadingStackModel.self, "lesen-stapel-kurz")
        XCTAssertEqual(short.sort, "kurz")
    }

    // MARK: Leseansicht

    func testDoc() throws {
        let model = try decode(ReadingDocModel.self, "lesen-doc")
        XCTAssertEqual(model.doc.id, "1031d266-e30f-4163-af2c-483c2fe68816")
        XCTAssertEqual(model.doc.rest, "noch 8 min")
        XCTAssertEqual(model.doc.remaining, 8)
        XCTAssertEqual(model.doc.author, "Ada Beispiel")
        XCTAssertTrue(model.hasText)
        XCTAssertEqual(model.length, 501)
        XCTAssertEqual(model.anchor, 186)
        XCTAssertEqual(model.weiter, 187)
        XCTAssertEqual(model.blocks.map(\.kind), [.heading, .paragraph, .image, .caption, .heading, .listItem, .listItem, .listItem, .listItem, .listItem, .quote, .code, .rule, .row, .row, .paragraph])
        XCTAssertEqual(model.blocks[0].level, 2)
        XCTAssertEqual(model.blocks[1].runs.map(\.italic), [false, true, false, false, false, false, false])
        XCTAssertEqual(model.blocks[1].runs[3].bold, true)
        XCTAssertEqual(model.blocks[1].runs[5].link, "https://example.org/studie")
        XCTAssertEqual(model.blocks[2].src, "https://blatt.example.org/bilder/stapel.jpg")
        XCTAssertEqual(model.blocks[2].alt, "Ein Stapel Bücher")
        XCTAssertTrue(model.blocks[2].runs.isEmpty)
        XCTAssertEqual(model.blocks[5].ordered, true)
        XCTAssertEqual(model.blocks[5].number, 1)
        XCTAssertEqual(model.blocks[7].depth, 2)
        XCTAssertNil(model.blocks[7].number)
        XCTAssertEqual(model.blocks[11].runs.first?.code, true)
        XCTAssertTrue(model.blocks[13].header)
        XCTAssertFalse(model.blocks[14].header)
        XCTAssertEqual(model.blocks[13].runs.filter(\.extra).map(\.text), ["\t", "\t"])
        XCTAssertEqual(model.blocks[15].runs[1].extra, true)
        XCTAssertEqual(model.blocks[15].runs[3].strike, true)

        XCTAssertEqual(model.highlights.count, 3)
        let lost = model.highlights[0]
        XCTAssertTrue(lost.lost)
        XCTAssertNil(lost.start)
        XCTAssertNil(lost.range)
        XCTAssertEqual(lost.note, "Alte Stelle")
        XCTAssertEqual(model.highlights[1].range, 48..<80)
        XCTAssertEqual(model.highlights[1].startHint, 48)
        XCTAssertEqual(model.ranges.map(\.id), ["de8f6b53-f1c2-4992-9657-69f54f1173a5", "2a2cb0a5-a618-46f6-9d58-2561f594f970"])
        // Dieselbe Rechnung wie placeHighlights auf dem Server.
        XCTAssertEqual(HighlightRange.placed(model.highlights), model.ranges)

        XCTAssertEqual(model.counts.stapel, 4)
        XCTAssertEqual(model.stack.count, 4)
        XCTAssertEqual(model.stack.filter(\.current).map(\.id), [model.doc.id])
        XCTAssertEqual(model.nav, "stapel")
        XCTAssertEqual(model.decisions, ReaderDecisions(fertig: true, vault: true, zurueck: false))
        XCTAssertEqual(ReaderDecisions.of(status: model.doc.status, vault: true), model.decisions)

        let bare = try decode(ReadingDocModel.self, "lesen-doc-ohne-text")
        XCTAssertFalse(bare.hasText)
        XCTAssertEqual(bare.doc.rest, "")
        XCTAssertNil(bare.doc.remaining)
        XCTAssertEqual(bare.blocks.first?.displayText, "Nur der Anriss ist da.")
        XCTAssertNil(bare.nav)
        XCTAssertEqual(bare.decisions, ReaderDecisions.of(status: .archive, vault: true))
    }

    func testPlacedTrimsOverlaps() {
        func h(_ id: String, _ start: Int, _ end: Int) -> ReadingHighlight {
            ReadingHighlight(id: id, docId: "d", quote: "x", createdAt: "", start: start, end: end)
        }
        let ranges = HighlightRange.placed([h("b", 10, 20), h("a", 0, 12), h("inner", 2, 5), h("c", 30, 40)])
        XCTAssertEqual(ranges.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(ranges.map(\.start), [0, 12, 30])
        XCTAssertEqual(ranges.map(\.end), [12, 20, 40])
    }

    // MARK: Markiert, Wiedersehen

    func testHighlights() throws {
        let model = try decode(HighlightListModel.self, "lesen-markiert")
        XCTAssertNil(model.filter.quelle)
        XCTAssertEqual(model.facets.sites, ["Blatt", "Zeit"])
        XCTAssertEqual(model.facets.topics, ["Gewohnheit", "Lesen"])
        XCTAssertEqual(model.items.count, 5)
        let first = model.items[0]
        XCTAssertEqual(first.quote, "Wir überschätzen später.")
        XCTAssertEqual(first.docTitle, "Warum der Stapel wächst")
        XCTAssertEqual(first.docSite, "Blatt")
        XCTAssertEqual(first.docTopics, ["Lesen", "Gewohnheit"])
        XCTAssertNil(first.start)
        XCTAssertFalse(first.lost)

        let filtered = try decode(HighlightListModel.self, "lesen-markiert-filter")
        XCTAssertEqual(filtered.filter.thema, "Gewohnheit")
        XCTAssertTrue(filtered.items.allSatisfy { $0.docTopics.contains("Gewohnheit") })
    }

    func testReviewCards() throws {
        let model = try decode(ReviewCardsModel.self, "lesen-wiedersehen")
        XCTAssertEqual(model.seen, 0)
        XCTAssertEqual(model.left, 4)
        XCTAssertEqual(model.total, 4)
        XCTAssertEqual(model.limit, 20)
        XCTAssertEqual(model.maxBox, 5)
        XCTAssertTrue(model.canCapture)
        XCTAssertEqual(model.cards.count, 4)
        XCTAssertEqual(model.cards[0].box, 1)
        XCTAssertEqual(model.cards[0].quote, "Der Stapel darf warten.")
        XCTAssertEqual(model.cards[0].docTitle, "Vom langsamen Lesen")
        XCTAssertEqual(model.progressLabel, "Heute 0 von 4 gesehen")
        XCTAssertEqual(model.week.id, "2026-W43")
        XCTAssertEqual(model.week.label, "19.10. – 25.10.")
        XCTAssertEqual(model.week.prev, ReadingWeekRef(id: "2026-W42", week: 42))
        XCTAssertEqual(model.week.stats.highlights, 5)
        XCTAssertEqual(model.week.topics.first, TopicCount(label: "Lesen", count: 5))
        XCTAssertEqual(model.week.clusters.count, 1)
        XCTAssertEqual(model.week.clusters[0].items.count, 2)
        XCTAssertEqual(model.week.clusters[0].id, model.week.clusters[0].ids.sorted().joined(separator: ","))
        XCTAssertEqual(model.week.export, "/api/lesen/wiedersehen.md?woche=2026-W43")

        let empty = try decode(ReviewCardsModel.self, "lesen-wiedersehen-leer")
        XCTAssertEqual(empty.week.id, "2020-W01")
        XCTAssertNil(empty.week.export)
        XCTAssertTrue(empty.week.clusters.isEmpty)
    }

    func testReviewEmptyTexts() throws {
        var model = try decode(ReviewCardsModel.self, "lesen-wiedersehen")
        model.cards = []
        XCTAssertEqual(model.emptyTitle, "Nichts fällig")
        XCTAssertEqual(model.emptyDetail, "Neue Markierungen kommen einen Tag später wieder.")
    }

    // MARK: Folgen

    func testEpisodes() throws {
        let model = try decode(EpisodeListModel.self, "lesen-folgen")
        XCTAssertTrue(model.enabled)
        XCTAssertTrue(model.hasBusy)
        XCTAssertEqual(model.items.map(\.status), ["wartet", "schreibt", "spricht", "fehler", "fehler", "fertig", "fertig"])
        let speaking = model.items[2]
        XCTAssertEqual(speaking.progress?.steps, ["Eingereiht", "Stimme spricht", "Fertig"])
        XCTAssertEqual(speaking.progress?.percent, 37)
        XCTAssertEqual(speaking.progress?.fraction, 0.375)
        XCTAssertEqual(speaking.progress?.restMinutes, 5)
        XCTAssertNil(speaking.minutes)
        XCTAssertNil(model.items[1].progress?.percent)
        XCTAssertEqual(model.items[1].worklog.map(\.text), ["Claude schreibt das Gespräch aus 2 Texten", "Schreibt das Ergebnis zusammen"])
        XCTAssertEqual(model.items[1].worklog.first?.time(timeZone: TimeZone(identifier: "Europe/Berlin")!), "18:10")
        XCTAssertEqual(speaking.worklog, [])
        let failed = model.items[3]
        XCTAssertTrue(failed.isFailed)
        XCTAssertTrue(failed.resumable)
        XCTAssertEqual(failed.retry?.label, "Fortsetzen")
        let done = model.items[5]
        XCTAssertTrue(done.isDone)
        XCTAssertEqual(done.seconds, 312)
        XCTAssertEqual(done.bytes, 4_992_000)
        XCTAssertEqual(done.durationLabel, "5:12")
        XCTAssertEqual(done.note, "Inbox/2026-10-24 1810 - Report Stapel.md")
        XCTAssertNil(model.availability?.vorlesen)
        XCTAssertNotNil(model.availability?["report"])
        XCTAssertEqual(model.kinds.map(\.isAvailable), [true, true, false])
        XCTAssertEqual(Episode.clock(3725), "1:02:05")
        XCTAssertEqual(Episode.clock(75), "1:15")

        let off = try decode(EpisodeListModel.self, "lesen-folgen-aus")
        XCTAssertFalse(off.enabled)
        XCTAssertTrue(off.items.isEmpty)
        XCTAssertNil(off.availability)
        XCTAssertEqual(off.kinds.count, 3)
    }

    func testNewEpisode() throws {
        let model = try decode(NewEpisodeModel.self, "lesen-folgen-neu")
        XCTAssertTrue(model.enabled)
        XCTAssertEqual(model.zeit, 30)
        XCTAssertEqual(model.docs.map(\.chars), [4321, 0, 4321])
        XCTAssertEqual(model.chars, 8642)
        XCTAssertEqual(model.defaultKind, "vorlesen")
        XCTAssertEqual(model.lengths, [5, 10, 20])
        XCTAssertEqual(model.defaultLength, 10)
        XCTAssertEqual(model.maxDocs, 20)
        XCTAssertEqual(model.spokenCharsPerMinute, 900)
        XCTAssertEqual(model.summary, EpisodeSummary(main: "Vorlesen · 3 Texte · etwa 10 Min.", cost: "rund 8.642 Zeichen bei ElevenLabs"))
        XCTAssertEqual(Set(model.summaries.keys), ["vorlesen", "podcast"])
        XCTAssertEqual(model.styles.map(\.style), ["ausgewogen", "locker", "kritisch", "tiefgang"])
        XCTAssertEqual(model.defaultStyle, "ausgewogen")
        XCTAssertEqual(model.topics, [EpisodeTopic(label: "Lesen", count: 2), EpisodeTopic(label: "Medien", count: 1)])
        XCTAssertEqual([model.maxTopics, model.maxFocus], [5, 200])
        XCTAssertTrue(model.transcriptOnly)
        XCTAssertEqual(model.languageLabel, "Deutsch")

        let off = try decode(NewEpisodeModel.self, "lesen-folgen-neu-aus")
        XCTAssertFalse(off.enabled)
        XCTAssertTrue(off.docs.isEmpty)
        XCTAssertNil(off.zeit)
        XCTAssertNil(off.summary)
        XCTAssertEqual(off.lengths, [5, 10, 20])
        XCTAssertTrue(off.styles.isEmpty)
        XCTAssertFalse(off.transcriptOnly)
        XCTAssertNil(off.languageLabel)
    }

    /// Der Satz am Knopf, in Swift gerechnet, gleicht dem des Servers für jede Art.
    func testSummaryMatchesServer() throws {
        for name in ["lesen-folgen-neu", "lesen-folgen-neu-leer"] {
            let model = try decode(NewEpisodeModel.self, name)
            for (kind, expected) in model.summaries {
                let label = model.kinds.first { $0.kind == kind }?.label
                XCTAssertEqual(NewEpisodeStore.summary(kind: kind, label: label, texts: model.docs.count, chars: model.chars, minutes: 10), expected, "\(name) \(kind)")
            }
        }
        XCTAssertEqual(NewEpisodeStore.summary(kind: "vorlesen", texts: 1, chars: 0, minutes: 10), EpisodeSummary(main: "Vorlesen · 1 Text · etwa 1 Min.", cost: "Schon alles gehört, kostet nichts"))
        XCTAssertEqual(NewEpisodeStore.summary(kind: "report", texts: 2, chars: 0, minutes: 20), EpisodeSummary(main: "Report · 2 Texte · 20 Min.", cost: "rund 18.000 Zeichen bei ElevenLabs, dazu dein Claude-Abo"))
        XCTAssertEqual(NewEpisodeStore.summary(kind: "podcast", texts: 0, chars: 0, minutes: 10), EpisodeSummary(main: "Bitte mindestens einen Text wählen", cost: ""))
        // Math.round: 1350 / 900 = 1,5 → 2
        XCTAssertEqual(NewEpisodeStore.summary(kind: "vorlesen", texts: 1, chars: 1350, minutes: 10).main, "Vorlesen · 1 Text · etwa 2 Min.")
        XCTAssertEqual(NewEpisodeStore.summary(kind: "report", texts: 2, chars: 0, minutes: 5, audio: false), EpisodeSummary(main: "Report · 2 Texte · 5 Min. · erst Transkript", cost: "Nur dein Claude-Abo; Audio später auf Knopfdruck"))
        XCTAssertEqual(NewEpisodeStore.grouped(1_234_567), "1.234.567")
        XCTAssertEqual(NewEpisodeStore.grouped(999), "999")
        XCTAssertEqual(NewEpisodeStore.grouped(0), "0")
    }

    // MARK: Antworten der Aktionen

    func testActionResponses() throws {
        let sort = try decode(ReadingActionResponse.self, "lesen-aktion-sortieren")
        XCTAssertEqual(sort.message, "Weg: Newsletter Oktober")
        XCTAssertEqual(sort.doc?.status, .gone)
        XCTAssertEqual(sort.undo?.fields["ziel"], "eingang")
        XCTAssertNil(sort.redirect)

        let mark = try decode(ReadingActionResponse.self, "lesen-aktion-markierung-neu")
        XCTAssertEqual(mark.highlight?.id, "6f1c0b0e-1111-4c4c-9d9d-000000000001")
        XCTAssertEqual(mark.undo?.action, "/aktion/lesen/markierung/loeschen")
        XCTAssertFalse(mark.duplicate)

        let progress = try decode(ReadingActionResponse.self, "lesen-aktion-fortschritt")
        XCTAssertEqual(progress.message, "")
        XCTAssertEqual(progress.progress, 0.42)

        let saved = try decode(ReadingActionResponse.self, "lesen-aktion-speichern")
        XCTAssertEqual(saved.doc?.title, "Vom Speichern")
        XCTAssertEqual(saved.doc?.status, .inbox)

        let review = try decode(ReadingActionResponse.self, "lesen-aktion-wiedersehen")
        XCTAssertEqual(review.undo?.action, "/aktion/lesen/wiedersehen/zurueck")
        // Zahlen im Rückgängig werden Text fürs Formular.
        XCTAssertEqual(review.undo?.fields["box"], "0")
        XCTAssertEqual(review.undo?.fields["zustand"], "aktiv")
    }

    // MARK: Wege

    func testReadingRoutes() {
        XCTAssertEqual(ReadingRoute(webPath: "/lesen"), .weiter, "wie im Web: /lesen führt zu „Weiter“")
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/eingang?gruppe=ohne"), .inbox(group: "ohne"))
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/stapel?zeit=15&gruppe=g1"), .stack(StackQuery(zeit: 15, group: "g1")))
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/doc?id=abc#weiter"), .reader(id: "abc", highlight: nil, resume: true))
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/doc?id=abc#h-x1"), .reader(id: "abc", highlight: "x1", resume: false))
        XCTAssertNil(ReadingRoute(webPath: "/lesen/doc"))
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/markiert?thema=Lesen"), .highlights(HighlightQuery(topic: "Lesen")))
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/wiedersehen?woche=2026-W43"), .review(week: "2026-W43"))
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/folgen"), .episodes)
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/folgen/neu?zeit=15"), .newEpisode(zeit: 15))
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/hinzufuegen"), .add)
        XCTAssertEqual(ReadingRoute(webPath: "/lesen/hoeren?zeit=30"), .listen(zeit: 30))
        // Feeds und Wissen bleiben Web.
        XCTAssertNil(ReadingRoute(webPath: "/lesen/feeds"))
        XCTAssertNil(ReadingRoute(webPath: "/wissen"))
        XCTAssertNil(ReadingRoute(webPath: "//fremd.example/lesen"))

        XCTAssertEqual(ReadingRoute.reader(id: "abc", highlight: "x1", resume: false).webPath, "/lesen/doc?id=abc#h-x1")
        XCTAssertEqual(ReadingRoute.stack(StackQuery(zeit: 5, sort: "kurz")).webPath, "/lesen/stapel?zeit=5&sort=kurz")
        XCTAssertEqual(ReadingRoute.inbox(group: nil).webPath, "/lesen/eingang")
        for route: ReadingRoute in [.inbox(group: "g"), .review(week: "2026-W01"), .newEpisode(zeit: 60), .highlights(HighlightQuery(site: "Blatt")), .reader(id: "d", highlight: nil, resume: true)] {
            XCTAssertEqual(ReadingRoute(webPath: route.webPath), route)
        }
    }
}
