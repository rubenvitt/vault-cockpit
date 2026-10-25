import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// Dekodiert die echten Antworten von `/api/notiz`, `/api/suche`, `/api/graph`, `/api/wissen`,
/// `/api/zustand`, `/api/einstellungen…` und `/api/lesen/feeds` (Fixtures `rest-*`).
final class VaultModelTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: try fixture(name))
    }

    // MARK: Notiz

    func testNote() throws {
        let note = try decode(NoteModel.self, "rest-notiz")
        XCTAssertEqual(note.path, "00-inbox/Idee.md")
        XCTAssertEqual(note.title, "Idee")
        XCTAssertEqual(note.tags, ["idee"])
        XCTAssertTrue(note.inInbox)
        XCTAssertNil(note.type)
        XCTAssertFalse(note.isSynthesis)
        XCTAssertEqual(note.obsidianURL?.scheme, "obsidian")
        XCTAssertEqual(note.frontmatter.first?.key, "projekt")
        XCTAssertEqual(note.frontmatter.first?.text, "Hund")
        XCTAssertNil(note.synthesis)
        XCTAssertNil(note.evidence)
        XCTAssertEqual(note.blocks.count, 5)
        XCTAssertEqual(note.blocks[0], .heading(level: 1, id: "h-idee", content: [.text("Idee")]))
        XCTAssertEqual(note.blocks[0].anchor, "h-idee")
        guard case .paragraph(let content) = note.blocks[1] else { return XCTFail("Absatz erwartet") }
        XCTAssertEqual(NoteInline.plainText(content), "Mit Hund, Gibts nicht und markiert.")
        guard case .wikilink(let missing) = content[3] else { return XCTFail("Wikilink erwartet") }
        XCTAssertTrue(missing.isMissing)
        XCTAssertEqual(missing.destination, NoteLinkDestination.none)
        guard case .wikilink(let hund) = content[1] else { return XCTFail("Wikilink erwartet") }
        XCTAssertEqual(hund.destination, .note(path: "wiki/Hund.md", anchor: nil))
        XCTAssertEqual(content[5], .styled(.mark, [.text("markiert")]))

        // Zwei abhakbare Checkboxen; die im Callout ist nur Anzeige.
        XCTAssertEqual(note.checkboxes.map(\.n), [0, 1])
        XCTAssertEqual(note.checkboxes[0].line, "- [ ] Preise vergleichen")
        guard case .callout(let callout) = note.blocks[4] else { return XCTFail("Callout erwartet") }
        XCTAssertEqual(callout.family, .ok)
        XCTAssertEqual(callout.label, "Tipp")
        guard case .list(let inner) = callout.children[0] else { return XCTFail("Liste erwartet") }
        XCTAssertEqual(inner.items[0].task?.isToggleable, false)
        guard case .image(let image) = note.blocks[3] else { return XCTFail("Bild erwartet") }
        XCTAssertEqual(image.src, "/notiz/bild?pfad=00-inbox%2Ffoto.png")
        XCTAssertEqual(image.width, 120)
        XCTAssertNil(image.height)

        XCTAssertEqual(note.related.backlinks, [])
        XCTAssertEqual(note.related.similar.count, 3)
        XCTAssertEqual(note.related.similar[2].linked, true)
        XCTAssertNil(note.related.similar[0].score)
        XCTAssertEqual(note.related.source, "text")
        let suggestions = try XCTUnwrap(note.suggestions)
        XCTAssertEqual(suggestions.of, 3)
        XCTAssertEqual(suggestions.tags.map(\.tag), ["hund", "tag"])
        XCTAssertEqual(suggestions.folders.first?.count, 3)
        XCTAssertEqual(suggestions.unlinked.map(\.path), ["wiki/Training.md", "wiki/Alles.md"])
        XCTAssertFalse(suggestions.isEmpty)
        XCTAssertEqual(note.targets, ["40-archiv", "wiki", "wiki/synthesis"])
        XCTAssertEqual(note.archive, "40-archiv")
        XCTAssertEqual(note.can, NoteCapabilities(write: true, graph: true))
    }

    func testNoteMarkdownHasEveryBlockAndInline() throws {
        let note = try decode(NoteModel.self, "rest-notiz-markdown")
        XCTAssertEqual(note.frontmatter.map(\.key), ["source", "bewertung", "liste"])
        XCTAssertEqual(note.frontmatter[0].text, "Bello")
        let preview = note.frontmatterPreview
        XCTAssertEqual(preview.shown.count, 3)
        XCTAssertEqual(preview.more, 0)

        guard case .paragraph(let inline) = note.blocks[1] else { return XCTFail("Absatz erwartet") }
        XCTAssertTrue(inline.contains(.styled(.bold, [.text("fett")])))
        XCTAssertTrue(inline.contains(.styled(.italic, [.text("kursiv")])))
        XCTAssertTrue(inline.contains(.styled(.strike, [.text("weg")])))
        XCTAssertTrue(inline.contains(.code("code")))
        XCTAssertTrue(inline.contains(.tag("tag")))
        XCTAssertTrue(inline.contains(.url("https://example.org/x.")))
        XCTAssertTrue(inline.contains(.lineBreak))
        XCTAssertTrue(inline.contains(.link(url: "https://example.org/a", text: "Link")))
        let links = inline.compactMap { if case .wikilink(let l) = $0 { l } else { nil } }
        XCTAssertEqual(links.count, 4)
        XCTAssertEqual(links[0].destination, .note(path: "00-inbox/Idee.md", anchor: "h-idee"))
        XCTAssertEqual(links[0].text, "Plan")
        XCTAssertEqual(links[1].destination, .note(path: "wiki/Hund.md", anchor: "h-über-den-hund"))
        XCTAssertTrue(links[2].isSelf)
        XCTAssertEqual(links[2].destination, .heading("h-tabelle"))
        XCTAssertEqual(links[3].status, .image)
        XCTAssertEqual(links[3].destination, .image(src: "/notiz/bild?pfad=00-inbox%2Ffoto.png"))

        var kinds: [String] = []
        for block in note.blocks {
            switch block {
            case .heading: kinds.append("heading")
            case .paragraph: kinds.append("paragraph")
            case .list: kinds.append("list")
            case .quote: kinds.append("quote")
            case .callout: kinds.append("callout")
            case .table: kinds.append("table")
            case .code: kinds.append("code")
            case .rule: kinds.append("rule")
            case .image: kinds.append("image")
            case .embed: kinds.append("embed")
            case .unknown: kinds.append("unknown")
            }
        }
        for kind in ["heading", "paragraph", "list", "quote", "callout", "table", "code", "rule", "image", "embed"] {
            XCTAssertTrue(kinds.contains(kind), "Block \(kind) fehlt")
        }
        XCTAssertFalse(kinds.contains("unknown"))

        guard case .list(let ordered) = note.blocks[3] else { return XCTFail("Liste erwartet") }
        XCTAssertTrue(ordered.ordered)
        XCTAssertNil(ordered.items[0].task)
        guard case .list(let tasks) = note.blocks[4] else { return XCTFail("Liste erwartet") }
        XCTAssertEqual(tasks.items.map(\.depth), [0, 1, 0])
        XCTAssertEqual(tasks.items[1].task, NoteCheckbox(done: true, n: 1, line: "- [x] erledigt, eingerückt"))
        guard case .quote(let quote) = note.blocks[5] else { return XCTFail("Zitat erwartet") }
        XCTAssertEqual(NoteInline.plainText(quote), "Ein Zitat\nüber zwei Zeilen")
        guard case .callout(let folded) = note.blocks[7] else { return XCTFail("Callout erwartet") }
        XCTAssertTrue(folded.foldable)
        XCTAssertFalse(folded.open)
        XCTAssertEqual(folded.family, .warn)
        guard case .table(let table) = note.blocks[9] else { return XCTFail("Tabelle erwartet") }
        XCTAssertEqual(table.align, [nil, .center, .trailing])
        XCTAssertEqual(table.alignment(of: 0), .leading)
        XCTAssertEqual(table.alignment(of: 2), .trailing)
        XCTAssertEqual(table.head.count, 3)
        XCTAssertTrue(table.rows.allSatisfy { $0.count == 3 })
        XCTAssertEqual(table.rows[0][1], [.code("a|b")])
        XCTAssertEqual(note.blocks[10], .code(lang: "swift", text: "let x = 1"))
        XCTAssertEqual(note.blocks[11], .rule)
        guard case .embed(let embed) = note.blocks[12], case .embed(let file) = note.blocks[13], case .embed(let gone) = note.blocks[14] else { return XCTFail("Einbettungen erwartet") }
        XCTAssertTrue(embed.embed)
        XCTAssertEqual(embed.destination, .note(path: "wiki/Hund.md", anchor: nil))
        XCTAssertEqual(file.status, .file)
        XCTAssertEqual(gone.status, .missing)
        guard case .image(let image) = note.blocks[15] else { return XCTFail("Bild erwartet") }
        XCTAssertEqual(image.alt, "Skizze")
    }

    func testSynthesisNote() throws {
        let note = try decode(NoteModel.self, "rest-notiz-synthese")
        XCTAssertTrue(note.isSynthesis)
        let head = try XCTUnwrap(note.synthesis)
        XCTAssertEqual(head.art, "Brücke")
        XCTAssertEqual(head.status, "entwurf")
        XCTAssertEqual(head.confidence, "mittel")
        XCTAssertEqual(head.theses.map(\.id), ["h-erschöpfung-ist-umstritten", "h-gewohnheiten-schlagen-willenskraft", "h-offene-punkte"])
        XCTAssertEqual(head.openPoints, ["Quelle zu Ego-Depletion prüfen", "Gegenposition suchen"])
        XCTAssertTrue(head.toZunder)
        XCTAssertEqual(NoteInline.plainText(head.summary ?? []), "Willenskraft ist kein Muskel, sagt Hund")
        let evidence = try XCTUnwrap(note.evidence?.first)
        XCTAssertEqual(evidence.id, "hl-1")
        XCTAssertEqual(evidence.score, 0.812)
        XCTAssertEqual(evidence.route, .reader(id: "doc-7", highlight: "hl-1", resume: false))
        XCTAssertNil(note.suggestions)
        // Jede These hat ihre Überschrift im Text.
        let anchors = Set(note.blocks.compactMap(\.anchor))
        XCTAssertTrue(head.theses.allSatisfy { anchors.contains($0.id) })
    }

    func testNoteActionResponses() throws {
        let box = try decode(NoteActionResponse.self, "rest-aktion-notiz-checkbox")
        XCTAssertEqual(box.n, 0)
        XCTAssertEqual(box.line, "- [x] Preise vergleichen")
        XCTAssertEqual(box.done, true)
        XCTAssertEqual(box.undo?.fields["erledigt"], "0")
        let file = try decode(NoteActionResponse.self, "rest-aktion-notiz-ablegen")
        XCTAssertEqual(file.path, "wiki/Idee.md")
        XCTAssertEqual(file.from, "00-inbox/Idee.md")
        XCTAssertEqual(file.folder, "wiki")
        XCTAssertEqual(file.redirect.flatMap(PageRoute.init(webPath:)), .note(path: "wiki/Idee.md", anchor: nil))
        XCTAssertEqual(file.undo?.fields["ordner"], "00-inbox")
        XCTAssertEqual(try decode(NoteActionResponse.self, "rest-aktion-notiz-tags").tags, ["idee", "hund"])
        XCTAssertEqual(try decode(NoteActionResponse.self, "rest-aktion-notiz-anhaengen").message, "Angehängt")
        let link = try decode(NoteActionResponse.self, "rest-aktion-verlinken")
        XCTAssertEqual(link.target, "wiki/Training.md")
        XCTAssertEqual(link.title, "Training")
        XCTAssertEqual(link.changed, true)
        let tasks = try decode(NoteActionResponse.self, "rest-aktion-synthese-aufgaben")
        XCTAssertEqual(tasks.created, 1)
        XCTAssertEqual(tasks.existing, 1)
        let evidence = try decode(NoteActionResponse.self, "rest-aktion-synthese-beleg")
        XCTAssertEqual(evidence.undo?.action, NoteAction.evidenceRemove)
        XCTAssertEqual(try decode(NoteActionResponse.self, "rest-aktion-synthese-beleg-entfernen").message, "Beleg entfernt")
    }

    // MARK: Suche, Graph, Wissen, Zustand

    func testSearch() throws {
        let top = try decode(SearchModel.self, "rest-suche")
        XCTAssertEqual(top.results.count, 8)
        XCTAssertEqual(top.total, 12)
        XCTAssertTrue(top.hasMore)
        XCTAssertEqual(top.degraded, "Bedeutungssuche gerade nicht verfügbar, nur Volltext")
        XCTAssertTrue(top.notes)
        XCTAssertEqual(top.results[0].streamLabels, ["Volltext", "Bedeutung"])
        XCTAssertNil(top.results[1].snippet)
        let all = try decode(SearchModel.self, "rest-suche-alle")
        XCTAssertEqual(all.results.count, 12)
        XCTAssertFalse(all.hasMore)
        let empty = try decode(SearchModel.self, "rest-suche-leer")
        XCTAssertEqual(empty.results, [])
        XCTAssertNil(empty.degraded)
    }

    func testGraph() throws {
        let graph = try decode(GraphModel.self, "rest-graph")
        XCTAssertEqual(graph.center, "note:2026-10-25.md")
        XCTAssertEqual(graph.path, "2026-10-25.md")
        XCTAssertEqual(graph.label, "2026-10-25")
        XCTAssertEqual(graph.nodes.count, 8)
        XCTAssertEqual(graph.edges.count, 7)
        let task = try XCTUnwrap(graph.nodes.first { $0.id == "task:t1" })
        XCTAssertEqual(task.kind, .task)
        XCTAssertEqual(task.status, .inProgress)
        XCTAssertEqual(task.statusText, "in Arbeit")
        XCTAssertEqual(task.link?.host, "zunder.test")
        let event = try XCTUnwrap(graph.nodes.first { $0.id == "event:2" })
        XCTAssertTrue(event.allDay)
        XCTAssertNotNil(event.startDate)
        let semantic = try XCTUnwrap(graph.edges.first { $0.kind == .semantic })
        XCTAssertEqual(semantic.score, 0.734)
        XCTAssertEqual(semantic.id, "note:2026-10-25.md|note:wiki/synthesis/Gewohnheit.md")
        XCTAssertEqual(graph.problems.count, 1)
        XCTAssertEqual(graph.lists.outgoing.map(\.path), ["wiki/Training.md"])
        XCTAssertEqual(graph.lists.incoming.map(\.path), ["00-inbox/Idee.md"])
        XCTAssertEqual(graph.lists.similar.first?.score, 0.734)
        XCTAssertEqual(graph.lists.tasks.map(\.from), [nil, "Training"])
        XCTAssertEqual(graph.lists.tasks[0].mark, "◐")
        XCTAssertEqual(graph.lists.events.map(\.label), ["Urlaub", "Hundeschule"])
        XCTAssertEqual(graph.can.link, true)
        XCTAssertNotNil(graph.obsidianURL)
    }

    func testWissen() throws {
        let start = try decode(WissenModel.self, "rest-wissen")
        XCTAssertNil(start.hits)
        XCTAssertEqual(start.recent.count, 2)
        XCTAssertEqual(start.arts, ["Brücke", "Vertiefung"])
        XCTAssertEqual(start.statuses, ["entwurf", "stabil"])
        XCTAssertTrue(start.reading)
        XCTAssertEqual(start.total, 2)
        XCTAssertNil(start.recent[1].confidence)
        XCTAssertTrue(start.query.isEmpty)
        let question = try decode(WissenModel.self, "rest-wissen-frage")
        XCTAssertEqual(question.hits?.map(\.title), ["Selbstkontrolle"])
        XCTAssertEqual(question.query, WissenQuery(q: "Willen", status: "entwurf"))
        XCTAssertTrue(try decode(WissenModel.self, "rest-wissen-lesen").lesen)
    }

    func testHealth() throws {
        let health = try decode(HealthModel.self, "rest-zustand")
        XCTAssertEqual(health.failing, [ServiceAlert(id: "calendars", name: "Kalender")])
        XCTAssertEqual(health.services.map(\.state), [.ok, .error, .off])
        XCTAssertEqual(health.services[0].facts.map(\.label), ["Letzter Lauf", "Dateien"])
        XCTAssertNotNil(health.services[0].facts[0].date)
        XCTAssertEqual(health.services[0].facts[1].value, "1234")
        let calendars = health.services[1]
        XCTAssertEqual(calendars.items.map(\.name), ["Privat", "Arbeit"])
        XCTAssertEqual(calendars.items[1].facts, [])
        XCTAssertNil(calendars.items[1].summary)
        XCTAssertTrue(calendars.errorIsCurrent)
        XCTAssertEqual(health.overview, "Ein Dienst meldet einen Fehler: Kalender")
        XCTAssertEqual(HealthState.off.label, "aus")
        let now = try XCTUnwrap(CockpitFormat.date(from: "2026-10-25T08:35:00.000Z"))
        let berlin = try XCTUnwrap(TimeZone(identifier: "Europe/Berlin"))
        XCTAssertEqual(HealthModel.when("2026-10-25T08:30:00.000Z", now: now, timeZone: berlin), "25.10. 09:30 · vor 5 min")
        XCTAssertEqual(HealthModel.when(nil, now: now, timeZone: berlin), "–")
        XCTAssertEqual(HealthModel.when("2026-10-24T08:35:00.000Z", now: now, timeZone: berlin), "24.10. 10:35 · vor 24 h")
    }

    func testWeekAlert() throws {
        let week = try decode(WeekModel.self, "rest-woche-stoerung")
        XCTAssertEqual(week.failingServices, [ServiceAlert(id: "calendars", name: "Kalender")])
        // Ältere Antworten ohne `alert`: kein Hinweis.
        XCTAssertEqual(try decode(WeekModel.self, "woche").failingServices, [])
    }

    // MARK: Einstellungen

    func testSettings() throws {
        let settings = try decode(SettingsModel.self, "rest-einstellungen")
        XCTAssertEqual(settings.sections.map(\.id), ["kalender", "zunder", "bruecke", "feuer-notiz", "mail", "lesestapel", "embeddings", "vorlesen", "anzeige", "anmeldung", "tokens", "kurzbefehle", "sicherung"])
        let zunder = try XCTUnwrap(settings.section("zunder"))
        XCTAssertEqual(zunder.state, SettingsSectionState(text: "eigener Zugang", tone: .ok))
        let token = try XCTUnwrap(zunder.fields.last)
        XCTAssertEqual(token.kind, .secret)
        XCTAssertEqual(token.value, "")
        XCTAssertTrue(token.isSet)
        XCTAssertEqual(token.clear, "zunder.clear")
        XCTAssertEqual(settings.field("bridge.enabled")?.options.map(\.value), ["", "an", "aus"])
        let mail = try XCTUnwrap(settings.section("mail"))
        XCTAssertEqual(mail.fieldGroups.map(\.title), [nil, "Ordner und Abstand"])
        XCTAssertEqual(mail.fieldGroups[1].fields.map(\.name), ["mail.mailbox", "mail.doneMailbox", "mail.pollMinutes"])
        XCTAssertTrue(mail.fieldGroups[1].fields[0].collapsed)
        XCTAssertEqual(settings.section("vorlesen")?.groups["Folgen"]?.hasPrefix("Podcast"), true)
        XCTAssertEqual(settings.section(ofField: "mail.clear")?.id, "mail")
        XCTAssertEqual(settings.section(ofField: "cal.1.url")?.id, "kalender")
        XCTAssertEqual(settings.section("lesestapel")?.state, nil)

        XCTAssertEqual(settings.calendars.items.map(\.name), ["Privat", "Arbeit"])
        XCTAssertEqual(settings.calendars.next, 2)
        XCTAssertTrue(settings.calendars.canAdd)
        let privat = settings.calendars.items[0]
        XCTAssertTrue(privat.isCalDAV)
        XCTAssertTrue(privat.passwordSet)
        XCTAssertEqual(privat.filter, ["Familie", "Sport"])
        XCTAssertEqual(privat.check?.text, "✓ 3 Termine diese Woche")
        XCTAssertEqual(settings.calendars.items[1].check?.ok, false)
        XCTAssertEqual(settings.signOutEverywhere?.action, "/api/einstellungen/abmelden")
        XCTAssertEqual(settings.tokens?.first?.current, true)
        XCTAssertEqual(settings.scopes?.map(\.value), ["search", "capture", "lesestapel", "app"])
        XCTAssertEqual(settings.shortcuts.map(\.slug), ["notiz", "sprachmemo", "lesestapel"])
        XCTAssertFalse(settings.captureEnabled)
        XCTAssertEqual(settings.backup?.minPassphrase, 12)
        XCTAssertEqual(settings.backup?.files.count, 5)
        XCTAssertEqual(settings.secretHint, "Leere Geheimnisfelder behalten den gespeicherten Wert.")

        let standard = try decode(SettingsModel.self, "rest-einstellungen-standard")
        XCTAssertEqual(standard.calendars.items, [])
        XCTAssertEqual(standard.calendars.next, 0)
        XCTAssertEqual(standard.section("kalender")?.state?.tone, .off)
    }

    func testSettingsReplies() throws {
        XCTAssertEqual(try decode(MessageReply.self, "rest-einstellungen-gespeichert"), MessageReply(message: "Gespeichert."))
        XCTAssertTrue(try decode(MessageReply.self, "rest-einstellungen-abmelden").message.hasPrefix("Überall abgemeldet"))
        let tokens = try decode(TokensModel.self, "rest-tokens")
        XCTAssertEqual(tokens.tokens.map(\.scopeLabel), ["App"])
        XCTAssertNotNil(tokens.tokens[0].createdDate)
        let created = try decode(TokenReply.self, "rest-token-neu")
        XCTAssertEqual(created.token?.token, "vct_beispiel_nur_einmal_sichtbar")
        XCTAssertEqual(created.tokens.count, 2)
        XCTAssertFalse(created.isSelf)
        let revoked = try decode(TokenReply.self, "rest-token-widerrufen")
        XCTAssertEqual(revoked.id, "e03fed7c-2e41-441c-961b-6cae7542ccc9")
        XCTAssertNil(revoked.token)
        let backup = try decode(BackupStatus.self, "rest-sicherung")
        XCTAssertTrue(backup.needsReplace)
        XCTAssertEqual(backup.files.filter(\.present).map(\.name), ["api-tokens.json"])
        let restored = try decode(BackupRestoreResult.self, "rest-sicherung-wiederhergestellt")
        XCTAssertEqual(restored.files, ["cockpit-settings.json", "api-tokens.json"])
        XCTAssertTrue(restored.restart)
        XCTAssertFalse(restored.relogin)
        XCTAssertTrue(restored.tokensReplaced)
        let shortcuts = try decode(ShortcutsModel.self, "rest-kurzbefehle")
        XCTAssertEqual(shortcuts.shortcuts[0].file, "/kurzbefehle/notiz.shortcut")
        XCTAssertEqual(shortcuts.shortcuts[2].filename, "Zum Lesestapel.shortcut")
        XCTAssertTrue(shortcuts.intro.hasPrefix("Auf dem iPhone"))
    }

    // MARK: Feeds

    func testFeeds() throws {
        let feeds = try decode(FeedsModel.self, "rest-lesen-feeds")
        XCTAssertEqual(feeds.total, 3)
        XCTAssertEqual(feeds.groups.map(\.name), ["Kultur", "Technik"])
        XCTAssertEqual(feeds.groups[0].inboxText, "1 neuer Eintrag im Eingang")
        XCTAssertEqual(feeds.groups[0].inboxRoute, .inbox(group: "6cf023d8-de27-4a92-812d-38a019c5e395"))
        XCTAssertEqual(feeds.groups[1].flags, "direkt auf den Stapel")
        XCTAssertEqual([feeds.groups[0].canMoveUp, feeds.groups[0].canMoveDown], [false, true])
        let kultur = feeds.groups[0].feeds[0]
        XCTAssertEqual(kultur.state, .ok)
        XCTAssertEqual(kultur.siteLink?.host, "kultur.test")
        XCTAssertNotNil(kultur.iconData)
        let blog = feeds.groups[1].feeds[0]
        XCTAssertEqual(blog.state, .error)
        XCTAssertTrue(blog.isFailing)
        XCTAssertNil(blog.siteLink)
        XCTAssertTrue(blog.groupToStack)
        let atom = try XCTUnwrap(feeds.ungrouped.first)
        XCTAssertEqual(atom.state, .paused)
        XCTAssertEqual(atom.settings, FeedSettings(paused: true, toStack: true, filter: "swift, ios", intervalMinutes: 5, groupId: nil))
        XCTAssertEqual(feeds.limits.maxOpmlBytes, 2_097_152)
        XCTAssertEqual(feeds.opml, "/api/lesen/feeds.opml")
        XCTAssertEqual(feeds.allFeeds.count, 3)
        XCTAssertEqual(feeds.feed(atom.id)?.title, "Atom-Seite")
        XCTAssertFalse(feeds.isEmpty)
        XCTAssertTrue(try decode(FeedsModel.self, "rest-lesen-feeds-leer").isEmpty)
        for name in ["rest-aktion-lesen-feed-abonnieren", "rest-aktion-lesen-feed-aendern", "rest-aktion-lesen-feeds-import", "rest-aktion-lesen-gruppe-anlegen", "rest-aktion-lesen-feeds-auswahl"] {
            XCTAssertFalse(try decode(MessageReply.self, name).message.isEmpty, name)
        }
        XCTAssertEqual(feeds.bulk, FeedBulkInfo(action: "/aktion/lesen/feeds/auswahl", actions: ["gruppe", "pausieren", "fortsetzen", "stapel-an", "stapel-aus", "abstand", "entfernen"], newGroup: "neu"))
        XCTAssertEqual(feeds.bulk, .fallback)
        XCTAssertEqual(feeds.summary, "3 Feeds · 1 pausiert · 1 mit Fehlern")
        XCTAssertEqual(feeds.failingCount, 1)
        XCTAssertEqual(feeds.groupName(of: kultur), "Kultur")
        XCTAssertNil(feeds.groupName(of: atom))
    }

    /// Suche über Titel, Host und Gruppe, „Nur mit Fehlern“ (src/web/static/lesen-feeds.js).
    func testFeedFilter() throws {
        let feeds = try decode(FeedsModel.self, "rest-lesen-feeds")
        let all = feeds.allFeeds
        func titles(_ filter: FeedFilter) -> [String] { feeds.matching(all, filter).map(\.title) }

        XCTAssertFalse(FeedFilter().isActive)
        XCTAssertFalse(FeedFilter(query: "   ").isActive)
        XCTAssertEqual(titles(FeedFilter()), ["Feuilleton", "Blog", "Atom-Seite"])
        // Titel, Host und Gruppe, ohne Groß/klein und Ränder.
        XCTAssertEqual(titles(FeedFilter(query: "  FEUILLE ")), ["Feuilleton"])
        XCTAssertEqual(titles(FeedFilter(query: "atom.test")), ["Atom-Seite"])
        XCTAssertEqual(titles(FeedFilter(query: "technik")), ["Blog"])
        XCTAssertEqual(titles(FeedFilter(query: "kultur")), ["Feuilleton"])
        XCTAssertEqual(titles(FeedFilter(query: ".test")), ["Feuilleton", "Blog", "Atom-Seite"])
        XCTAssertEqual(titles(FeedFilter(query: "gibt es nicht")), [])
        // Nur mit Fehlern, auch zusammen mit der Suche.
        XCTAssertEqual(titles(FeedFilter(onlyFailing: true)), ["Blog"])
        XCTAssertEqual(titles(FeedFilter(query: "blog", onlyFailing: true)), ["Blog"])
        XCTAssertEqual(titles(FeedFilter(query: "atom", onlyFailing: true)), [])
        XCTAssertEqual(FeedFilter.hits(0), "Kein Feed passt.")
        XCTAssertEqual(FeedFilter.hits(1), "1 Feed gefunden")
        XCTAssertEqual(FeedFilter.hits(3), "3 Feeds gefunden")
        let umlaut = FeedFilter(query: "ÜBER")
        XCTAssertEqual(umlaut.needle, "über")
    }

    /// Formular der Sammelleiste: `tun`, die passenden Felder, dann je Feed ein `feed`.
    func testFeedBulkPairs() {
        func body(_ action: FeedBulkAction, _ ids: [String] = ["a", "b", "a", ""]) -> String {
            CockpitAPI.formBody(pairs: action.pairs(feeds: ids))
        }
        XCTAssertEqual(body(.pause), "tun=pausieren&feed=a&feed=b")
        XCTAssertEqual(body(.resume), "tun=fortsetzen&feed=a&feed=b")
        XCTAssertEqual(body(.stackOn), "tun=stapel-an&feed=a&feed=b")
        XCTAssertEqual(body(.stackOff), "tun=stapel-aus&feed=a&feed=b")
        XCTAssertEqual(body(.interval(90)), "tun=abstand&intervall=90&feed=a&feed=b")
        XCTAssertEqual(body(.remove), "tun=entfernen&bestaetigt=1&feed=a&feed=b")
        XCTAssertEqual(body(.move(.ungrouped)), "tun=gruppe&ziel=&feed=a&feed=b")
        XCTAssertEqual(body(.move(.group("g-1"))), "tun=gruppe&ziel=g-1&feed=a&feed=b")
        XCTAssertEqual(body(.move(.newGroup(" Kunst & Kultur "))), "tun=gruppe&ziel=neu&neu=Kunst%20%26%20Kultur&feed=a&feed=b")
        XCTAssertEqual(CockpitAPI.formBody(pairs: FeedBulkAction.move(.newGroup("X")).pairs(feeds: ["a"], newGroup: "+")), "tun=gruppe&ziel=%2B&neu=X&feed=a")
        XCTAssertEqual(FeedBulkInfo.fallback.actions, ["gruppe", "pausieren", "fortsetzen", "stapel-an", "stapel-aus", "abstand", "entfernen"])
        let verbs: [FeedBulkAction] = [.move(.ungrouped), .pause, .resume, .stackOn, .stackOff, .interval(5), .remove]
        XCTAssertEqual(verbs.map(\.verb), FeedBulkInfo.fallback.actions)
    }

    // MARK: Fehler und Wege

    func testErrorFixturesBecomeErrors() async throws {
        let transport = FakeTransport { request in
            switch path(of: request) {
            case "/api/notiz": (404, try fixture("rest-notiz-fehlt"))
            case "/api/graph": (404, try fixture("rest-graph-fehlt"))
            case "/api/einstellungen": (400, try fixture("rest-einstellungen-fehler"))
            case "/api/einstellungen/tokens": (400, try fixture("rest-token-fehler"))
            case "/aktion/notiz/ablegen": (403, try fixture("rest-aktion-notiz-ablegen-verboten"))
            default: (400, try fixture("rest-aktion-notiz-checkbox-veraltet"))
            }
        }
        let api = CockpitAPI(baseURL: testBase, token: "vct_geheim", transport: transport)
        do {
            _ = try await api.note(path: "privat/Geheim.md")
            XCTFail("404 erwartet")
        } catch let error as CockpitError {
            XCTAssertEqual(error, .failed(status: 404, code: "not_found", message: "„privat/Geheim.md“ gibt es nicht, oder sie liegt in einem vertraulichen oder ausgeschlossenen Ordner."))
        }
        do {
            _ = try await api.graph(path: "weg.md")
            XCTFail("404 erwartet")
        } catch let error as CockpitError {
            XCTAssertEqual(error, .failed(status: 404, code: "not_found", message: "Notiz nicht im Index"))
        }
        do {
            _ = try await api.action(SettingsPath.settings, fields: ["tz": "Mars/Olympus"], as: MessageReply.self)
            XCTFail("400 erwartet")
        } catch let rejection as FieldRejection {
            XCTAssertEqual(rejection.field, "tz")
            XCTAssertEqual(rejection.error, .failed(status: 400, code: "invalid", message: "Unbekannte Zeitzone „Mars/Olympus“ (z. B. Europe/Berlin)"))
            XCTAssertEqual(CockpitError.from(rejection, action: true), rejection.error)
        }
        do {
            _ = try await api.action(SettingsPath.tokens, fields: ["name": ""], as: TokenReply.self)
            XCTFail("400 erwartet")
        } catch let rejection as FieldRejection {
            XCTAssertEqual(rejection.field, "name")
        }
        do {
            _ = try await api.action(NoteAction.file, fields: ["pfad": "a.md", "ordner": "privat"], as: NoteActionResponse.self)
            XCTFail("403 erwartet")
        } catch let error as CockpitError {
            XCTAssertEqual(error, .failed(status: 403, code: "action_failed", message: "„privat“ ist vertraulich oder ausgeschlossen; dorthin legt das Cockpit nichts ab"))
        }
        do {
            _ = try await api.action(NoteAction.checkbox, fields: [:], as: NoteActionResponse.self)
            XCTFail("400 erwartet")
        } catch let error as CockpitError {
            XCTAssertEqual(error.message, "Die Checkbox steht nicht mehr an dieser Stelle. Bitte neu laden.")
        }
    }

    func testRequestsUseTokenAndQuery() async throws {
        let transport = FakeTransport { request in
            switch path(of: request) {
            case "/api/suche": (200, try fixture("rest-suche"))
            case "/api/wissen": (200, try fixture("rest-wissen-frage"))
            default: (200, try fixture("rest-notiz"))
            }
        }
        let api = CockpitAPI(baseURL: testBase, token: "vct_geheim", transport: transport)
        _ = try await api.note(path: "00-inbox/Idee.md")
        _ = try await api.search("C++ & Co", all: true, type: "synthesis")
        _ = try await api.wissen(WissenQuery(q: " Willen ", status: "entwurf", lesen: true))
        let requests = transport.requests
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
        XCTAssertEqual(requests[0].url?.query, "pfad=00-inbox%2FIdee.md")
        XCTAssertEqual(requests[1].url?.query, "q=C%2B%2B%20%26%20Co&type=synthesis&alle=1")
        XCTAssertEqual(requests[2].url?.query, "q=Willen&status=entwurf&lesen=1")
    }

    func testResourceRequestAndDownloadName() throws {
        let api = CockpitAPI(baseURL: URL(string: "https://cockpit.test/basis")!, token: "vct_geheim")
        let request = try XCTUnwrap(api.resourceRequest("/notiz/bild?pfad=00-inbox%2Ffoto.png"))
        XCTAssertEqual(request.url?.absoluteString, "https://cockpit.test/basis/notiz/bild?pfad=00-inbox%2Ffoto.png")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
        XCTAssertNil(api.resourceRequest("https://fremd.test/x"))
        XCTAssertNil(api.resourceRequest("//fremd.test/x"))
        XCTAssertEqual(DownloadedFile.filename(fromDisposition: #"attachment; filename="feeds.opml""#), "feeds.opml")
        XCTAssertEqual(DownloadedFile.filename(fromDisposition: #"attachment; filename="x.shortcut"; filename*=UTF-8''Zum%20Lesestapel.shortcut"#), "Zum Lesestapel.shortcut")
        XCTAssertNil(DownloadedFile.filename(fromDisposition: "inline"))
    }

    func testPageRoutes() {
        XCTAssertEqual(PageRoute(webPath: "/notiz?pfad=wiki%2FIdee.md#h-idee"), .note(path: "wiki/Idee.md", anchor: "h-idee"))
        XCTAssertEqual(PageRoute(webPath: "/graph?pfad=a.md"), .graph(path: "a.md"))
        XCTAssertEqual(PageRoute(webPath: "/graph?q=Hund"), .search("Hund"))
        XCTAssertEqual(PageRoute(webPath: "/graph"), .search(""))
        XCTAssertEqual(PageRoute(webPath: "/wissen?q=x&art=Br%C3%BCcke&lesen=1"), .wissen(WissenQuery(q: "x", art: "Brücke", lesen: true)))
        XCTAssertEqual(PageRoute(webPath: "/zustand"), .health)
        XCTAssertEqual(PageRoute(webPath: "/einstellungen#tokens"), .settings(section: "tokens"))
        XCTAssertEqual(PageRoute(webPath: "/einstellungen"), .settings(section: nil))
        XCTAssertEqual(PageRoute(webPath: "/lesen/feeds"), .feeds)
        XCTAssertNil(PageRoute(webPath: "/notiz"))
        XCTAssertNil(PageRoute(webPath: "/planen"))
        XCTAssertEqual(PageRoute.note(path: "00-inbox/Idee.md", anchor: nil).webPath, "/notiz?pfad=00-inbox%2FIdee.md")
        XCTAssertEqual(PageRoute.wissen(WissenQuery(q: "a b", lesen: true)).webPath, "/wissen?q=a%20b&lesen=1")
        XCTAssertEqual(PageRoute.settings(section: "sicherung").webPath, "/einstellungen#sicherung")
        for route in [PageRoute.note(path: "a/b c.md", anchor: "h-x"), .graph(path: "a.md"), .search("Hund"), .health, .feeds, .wissen(WissenQuery(q: "C++"))] {
            XCTAssertEqual(PageRoute(webPath: route.webPath), route, route.webPath)
        }
    }
}
