import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// Einstellungen, Tokens, Sicherung, Kurzbefehle und Feeds gegen eine Attrappe.
final class SettingsStoreTests: XCTestCase {
    @MainActor
    private func setup(_ transport: FakeTransport) throws -> CockpitContext {
        makeContext(transport, directory: try temporaryDirectory())
    }

    /// GET liefert `get`, POST `post` (Status 200), sonst `{ok, message}`.
    private func server(get: [String: String] = [:], post: [String: (Int, String)] = [:]) -> FakeTransport {
        FakeTransport { request in
            let p = path(of: request)
            if request.httpMethod == "POST" {
                if let (status, name) = post[p] { return (status, try fixture(name)) }
                return (200, json(#"{"ok":true,"message":"Gespeichert."}"#))
            }
            if let name = get[p] { return (200, try fixture(name)) }
            return (200, try fixture("rest-einstellungen"))
        }
    }

    // MARK: Einstellungen

    @MainActor
    func testDraftAndSaveSection() async throws {
        let transport = server(post: ["/api/einstellungen": (200, "rest-einstellungen-gespeichert")])
        let context = try setup(transport)
        let store = SettingsStore(context: context)
        await store.load()
        let zunder = try XCTUnwrap(store.model?.section("zunder"))
        let url = zunder.fields[0]
        let token = zunder.fields[1]
        XCTAssertEqual(store.value(of: url), "https://zunder.test/")
        XCTAssertEqual(store.value(of: token), "")
        XCTAssertFalse(store.isDirty(zunder))

        store.setValue("https://zunder.neu/", for: url)
        XCTAssertTrue(store.isDirty(zunder))
        store.setValue("https://zunder.test/", for: url)
        XCTAssertFalse(store.isDirty(zunder))
        store.setValue("https://zunder.neu/", for: url)
        store.setValue("", for: token)
        XCTAssertEqual(store.drafts[token.name], nil)

        let ok = await store.save(zunder)
        XCTAssertTrue(ok)
        let request = transport.requests[1]
        XCTAssertEqual(path(of: request), "/api/einstellungen")
        XCTAssertEqual(request.httpMethod, "POST")
        // Leeres Geheimnis bleibt weg (unverändert), kein Häkchen zum Löschen.
        XCTAssertEqual(formFields(request), ["zunder.url": "https://zunder.neu/"])
        XCTAssertNil(request.value(forHTTPHeaderField: "X-CSRF"))
        XCTAssertEqual(context.toasts.toasts.last?.message, "Gespeichert.")
        XCTAssertFalse(store.isDirty(zunder))
        // Danach neu geladen (Stände der Abschnitte).
        XCTAssertEqual(path(of: transport.requests[2]), "/api/einstellungen")
        XCTAssertEqual(transport.requests[2].httpMethod ?? "GET", "GET")
    }

    @MainActor
    func testSecretAndClearAreSent() async throws {
        let transport = server()
        let store = SettingsStore(context: try setup(transport))
        await store.load()
        let mail = try XCTUnwrap(store.model?.section("mail"))
        let token = try XCTUnwrap(mail.fields.first { $0.name == "mail.token" })
        store.setValue("fm_neu", for: token)
        store.setCleared(true, for: token)
        XCTAssertTrue(store.isCleared(token))
        await store.save(mail)
        let fields = formFields(transport.requests[1])
        XCTAssertEqual(fields["mail.token"], "fm_neu")
        XCTAssertEqual(fields["mail.clear"], "1")
        XCTAssertEqual(fields["mail.senders"], "r@example.dev, @rubeen.dev")
        XCTAssertEqual(fields["mail.pollMinutes"], "10")
        XCTAssertEqual(Set(fields.keys), ["mail.token", "mail.clear", "mail.senders", "mail.mailbox", "mail.doneMailbox", "mail.pollMinutes"])
    }

    @MainActor
    func testRejectedFieldShowsErrorAndKeepsDraft() async throws {
        let transport = server(post: ["/api/einstellungen": (400, "rest-einstellungen-fehler")])
        let context = try setup(transport)
        let store = SettingsStore(context: context)
        await store.load()
        let display = try XCTUnwrap(store.model?.section("anzeige"))
        let tz = display.fields[0]
        store.setValue("Mars/Olympus", for: tz)
        let ok = await store.save(display)
        XCTAssertFalse(ok)
        XCTAssertEqual(store.error(for: "tz"), "Unbekannte Zeitzone „Mars/Olympus“ (z. B. Europe/Berlin)")
        XCTAssertEqual(store.value(of: tz), "Mars/Olympus")
        XCTAssertEqual(context.toasts.toasts.last?.kind, .error)
        XCTAssertEqual(transport.requests.count, 2)
        // Tippen im Feld nimmt den Fehler weg.
        store.setValue("Europe/Berlin", for: tz)
        XCTAssertNil(store.error(for: "tz"))
    }

    @MainActor
    func testCalendars() async throws {
        let transport = server()
        let store = SettingsStore(context: try setup(transport))
        await store.load()
        let calendars = try XCTUnwrap(store.model?.calendars)

        var privat = store.calendarDraft(for: calendars.items[0])
        XCTAssertEqual(privat.filter, "Familie, Sport")
        XCTAssertTrue(privat.usesLogin)
        privat.name = "Familie"
        await store.saveCalendar(privat)
        XCTAssertEqual(formFields(transport.requests[1]), [
            "cal.0.id": calendars.items[0].id, "cal.0.name": "Familie", "cal.0.kind": "caldav", "cal.0.auth": "1",
            "cal.0.username": "ruben", "cal.0.filter": "Familie, Sport",
        ])

        var fresh = try XCTUnwrap(store.newCalendarDraft())
        XCTAssertEqual(fresh.index, 2)
        XCTAssertTrue(fresh.isNew)
        fresh.name = "Feiertage"
        let missingURL = await store.saveCalendar(fresh)
        XCTAssertFalse(missingURL)
        XCTAssertEqual(store.error(for: "cal.2.url"), "Bitte die Adresse des Kalenders angeben.")
        fresh.url = "https://feiertage.test/ics"
        fresh.auth = true
        fresh.username = "ich"
        fresh.password = "geheim"
        await store.saveCalendar(fresh)
        let sent = formFields(transport.requests.last { $0.httpMethod == "POST" }!)
        XCTAssertEqual(sent["cal.2.url"], "https://feiertage.test/ics")
        XCTAssertEqual(sent["cal.2.password"], "geheim")
        XCTAssertNil(sent["cal.2.id"])
        XCTAssertNil(store.error(for: "cal.2.url"))

        await store.removeCalendar(calendars.items[1])
        let removed = formFields(transport.requests.last { $0.httpMethod == "POST" }!)
        XCTAssertEqual(removed, ["cal.1.id": calendars.items[1].id, "cal.1.remove": "1"])

        let before = transport.requests.count
        await store.checkCalendars()
        XCTAssertEqual(transport.requests.count, before + 1)
    }

    @MainActor
    func testCalendarFieldErrorFromServer() async throws {
        let transport = FakeTransport { request in
            if request.httpMethod == "POST" { return (400, json(#"{"error":"invalid","message":"Die Adresse muss mit https:// beginnen","field":"cal.2.url"}"#)) }
            return (200, try fixture("rest-einstellungen"))
        }
        let store = SettingsStore(context: try setup(transport))
        await store.load()
        var fresh = try XCTUnwrap(store.newCalendarDraft())
        fresh.name = "X"
        fresh.url = "http://x.test"
        let ok = await store.saveCalendar(fresh)
        XCTAssertFalse(ok)
        XCTAssertEqual(store.error(for: fresh.fieldName("url")), "Die Adresse muss mit https:// beginnen")
    }

    @MainActor
    func testSignOutEverywhere() async throws {
        let transport = server(post: ["/api/einstellungen/abmelden": (200, "rest-einstellungen-abmelden")])
        let context = try setup(transport)
        let store = SettingsStore(context: context)
        let ok = await store.signOutEverywhere()
        XCTAssertTrue(ok)
        XCTAssertEqual(path(of: transport.requests[0]), "/api/einstellungen/abmelden")
        XCTAssertTrue(context.toasts.toasts.last?.message.hasPrefix("Überall abgemeldet") ?? false)
    }

    // MARK: Tokens

    @MainActor
    func testTokensCreateAndRevoke() async throws {
        let transport = server(
            get: ["/api/einstellungen/tokens": "rest-tokens"],
            post: ["/api/einstellungen/tokens": (200, "rest-token-neu"), "/api/einstellungen/tokens/widerrufen": (200, "rest-token-widerrufen")]
        )
        let context = try setup(transport)
        var loggedOut = false
        context.onUnauthorized = { loggedOut = true }
        let store = TokensStore(context: context)
        await store.load()
        XCTAssertEqual(store.model?.tokens.count, 1)

        let empty = await store.create(name: "  ")
        XCTAssertNil(empty)
        XCTAssertEqual(store.fieldErrors["name"], "Der Token braucht einen Namen")

        let created = await store.create(name: "Raycast")
        XCTAssertEqual(created?.token, "vct_beispiel_nur_einmal_sichtbar")
        XCTAssertEqual(formFields(transport.requests[1]), ["name": "Raycast", "scope": "search"])
        XCTAssertEqual(store.model?.tokens.count, 2)
        XCTAssertEqual(store.created?.name, "Raycast")
        XCTAssertTrue(store.fieldErrors.isEmpty)
        // Der Klartext landet nie im Zwischenspeicher.
        let cached = try XCTUnwrap(context.snapshots.load("einstellungen/tokens"))
        XCTAssertFalse(String(decoding: cached.data, as: UTF8.self).contains("vct_beispiel"))

        let raycast = try XCTUnwrap(store.model?.tokens.last)
        let revoked = await store.revoke(raycast)
        XCTAssertTrue(revoked)
        XCTAssertEqual(formFields(transport.requests[2]), ["id": raycast.id])
        XCTAssertNil(store.created)
        XCTAssertFalse(loggedOut)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Token widerrufen.")
    }

    @MainActor
    func testRevokingOwnTokenSignsOut() async throws {
        let transport = FakeTransport { request in
            if request.httpMethod == "POST" {
                return (200, json(#"{"ok":true,"message":"Token widerrufen.","id":"a","self":true,"tokens":[],"scopes":[]}"#))
            }
            return (200, try fixture("rest-tokens"))
        }
        let context = try setup(transport)
        var loggedOut = false
        context.onUnauthorized = { loggedOut = true }
        let store = TokensStore(context: context)
        await store.load()
        await store.revoke(try XCTUnwrap(store.model?.tokens.first))
        XCTAssertTrue(loggedOut)
    }

    @MainActor
    func testTokenFieldErrorFromServer() async throws {
        let transport = server(post: ["/api/einstellungen/tokens": (400, "rest-token-fehler")])
        let store = TokensStore(context: try setup(transport))
        let created = await store.create(name: "x", scope: "app")
        XCTAssertNil(created)
        XCTAssertEqual(store.fieldErrors["name"], "Der Token braucht einen Namen")
    }

    // MARK: Sicherung

    @MainActor
    func testBackupCreateWritesFile() async throws {
        let transport = FakeTransport { request in
            if request.httpMethod == "POST" { return (200, json(#"{"format":"cockpit-sicherung","v":1}"#)) }
            return (200, try fixture("rest-sicherung"))
        }
        transport.setHeaders(["Content-Disposition": #"attachment; filename="cockpit-sicherung-2026-10-25.json""#], for: "/api/einstellungen/sicherung")
        let store = BackupStore(context: try setup(transport))
        await store.load()
        XCTAssertEqual(store.model?.needsReplace, true)

        let short = await store.create(passphrase: "kurz", repeat: "kurz")
        XCTAssertNil(short)
        XCTAssertEqual(store.fieldErrors["passphrase"], "Die Passphrase braucht mindestens 12 Zeichen")
        let mismatch = await store.create(passphrase: "lang genug, wirklich", repeat: "anders, wirklich")
        XCTAssertNil(mismatch)
        XCTAssertEqual(store.fieldErrors["passphrase2"], "Die beiden Passphrasen stimmen nicht überein")
        XCTAssertEqual(transport.requests.count, 1)

        let created = await store.create(passphrase: "lang genug, wirklich", repeat: "lang genug, wirklich")
        let url = try XCTUnwrap(created)
        XCTAssertEqual(url.lastPathComponent, "cockpit-sicherung-2026-10-25.json")
        XCTAssertEqual(try Data(contentsOf: url), json(#"{"format":"cockpit-sicherung","v":1}"#))
        XCTAssertEqual(formFields(transport.requests[1]), ["passphrase": "lang genug, wirklich", "passphrase2": "lang genug, wirklich"])
        XCTAssertEqual(store.file, url)
        XCTAssertTrue(store.fieldErrors.isEmpty)
    }

    @MainActor
    func testBackupServerRejectsPassphrase() async throws {
        let transport = server(post: ["/api/einstellungen/sicherung": (400, "rest-sicherung-fehler")])
        let store = BackupStore(context: try setup(transport))
        let url = await store.create(passphrase: String(repeating: "x", count: 12), repeat: String(repeating: "x", count: 12))
        XCTAssertNil(url)
        XCTAssertEqual(store.fieldErrors["passphrase"], "Die Passphrase braucht mindestens 12 Zeichen")
    }

    @MainActor
    func testBackupRestoreSendsMultipart() async throws {
        let transport = server(post: ["/api/einstellungen/sicherung/wiederherstellen": (200, "rest-sicherung-wiederhergestellt")])
        let context = try setup(transport)
        let store = BackupStore(context: context)
        let missing = await store.restore(data: Data(), filename: "x.json", passphrase: "p", replace: true)
        XCTAssertNil(missing)
        XCTAssertNotNil(store.fieldErrors["datei"])

        let dir = try temporaryDirectory()
        let file = dir.appending(path: "sicherung.json")
        try json(#"{"v":1}"#).write(to: file)
        let result = await store.restore(file: file, passphrase: "lang genug, wirklich", replace: true)
        XCTAssertEqual(result?.tokensReplaced, true)
        XCTAssertEqual(store.restored?.restart, true)
        let request = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(path(of: request), "/api/einstellungen/sicherung/wiederherstellen")
        XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") ?? false)
        let parts = multipartParts(request)
        XCTAssertEqual(parts["passphrase"]?.value, "lang genug, wirklich")
        XCTAssertEqual(parts["ersetzen"]?.value, "1")
        XCTAssertEqual(parts["datei"]?.filename, "sicherung.json")
        XCTAssertEqual(parts["datei"]?.value, #"{"v":1}"#)
        XCTAssertTrue(context.toasts.toasts.last?.message.hasPrefix("2 Dateien") ?? false)
    }

    // MARK: Kurzbefehle

    @MainActor
    func testShortcutDownload() async throws {
        let transport = FakeTransport { request in
            if path(of: request) == "/kurzbefehle/lesestapel.shortcut" { return (200, Data("bplist".utf8)) }
            return (200, try fixture("rest-kurzbefehle"))
        }
        let store = ShortcutsStore(context: try setup(transport))
        await store.load()
        let shortcut = try XCTUnwrap(store.model?.shortcuts.last)
        let downloaded = await store.download(shortcut)
        let url = try XCTUnwrap(downloaded)
        XCTAssertEqual(url.lastPathComponent, "Zum Lesestapel.shortcut")
        XCTAssertEqual(try Data(contentsOf: url), Data("bplist".utf8))
        XCTAssertEqual(store.files["lesestapel"], url)
        XCTAssertEqual(transport.requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
    }

    // MARK: Feeds

    private func feedsServer() -> FakeTransport {
        FakeTransport { request in
            switch path(of: request) {
            case "/api/lesen/feeds": (200, try fixture("rest-lesen-feeds"))
            case "/api/lesen/feeds.opml": (200, Data("<opml/>".utf8))
            case "/aktion/lesen/feed/abonnieren": (200, try fixture("rest-aktion-lesen-feed-abonnieren"))
            case "/aktion/lesen/feed/aendern": (200, try fixture("rest-aktion-lesen-feed-aendern"))
            case "/aktion/lesen/feeds/import": (200, try fixture("rest-aktion-lesen-feeds-import"))
            case "/aktion/lesen/gruppe/anlegen": (200, try fixture("rest-aktion-lesen-gruppe-anlegen"))
            case "/aktion/lesen/feeds/auswahl": (200, try fixture("rest-aktion-lesen-feeds-auswahl"))
            default: (200, json(#"{"ok":true,"message":"Erledigt"}"#))
            }
        }
    }

    @MainActor
    func testFeedsSubscribeAndUpdate() async throws {
        let transport = feedsServer()
        let context = try setup(transport)
        let store = FeedsStore(context: context)
        await store.load()
        XCTAssertEqual(store.model?.groups.count, 2)

        let ok = await store.subscribe(url: " https://atom.test ", groupId: "g1")
        XCTAssertTrue(ok)
        XCTAssertEqual(formFields(transport.requests[1]), ["url": "https://atom.test", "gruppe": "g1"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "Abonniert: Atom-Seite")
        XCTAssertEqual(path(of: transport.requests[2]), "/api/lesen/feeds")
        let empty = await store.subscribe(url: "")
        XCTAssertFalse(empty)

        let atom = try XCTUnwrap(store.model?.ungrouped.first)
        var settings = atom.settings
        settings.paused = false
        settings.intervalMinutes = 1
        settings.groupId = "g2"
        await store.update(atom, settings)
        XCTAssertEqual(formFields(transport.requests[3]), ["id": atom.id, "stapel": "1", "filter": "swift, ios", "intervall": "5", "gruppe": "g2", "url": "https://atom.test/feed.xml"])

        settings.groupId = nil
        settings.toStack = false
        settings.filter = "  "
        settings.url = " https://blog.test/ "
        await store.update(atom, settings)
        XCTAssertEqual(formFields(transport.requests[5]), ["id": atom.id, "filter": "", "intervall": "5", "gruppe": "", "url": "https://blog.test/"])

        await store.remove(atom)
        XCTAssertEqual(path(of: transport.requests[7]), "/aktion/lesen/feed/entfernen")
        XCTAssertEqual(formFields(transport.requests[7]), ["id": atom.id])
    }

    @MainActor
    func testFeedGroups() async throws {
        let transport = feedsServer()
        let context = try setup(transport)
        let store = FeedsStore(context: context)
        await store.load()
        let groups = try XCTUnwrap(store.model?.groups)

        await store.createGroup(name: " Technik ")
        XCTAssertEqual(formFields(transport.requests[1]), ["name": "Technik"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "Gruppe angelegt: Technik")

        await store.updateGroup(groups[0], name: "Kunst", paused: true, toStack: false)
        XCTAssertEqual(formFields(transport.requests[3]), ["id": groups[0].id, "name": "Kunst", "pausiert": "1"])

        await store.removeGroup(groups[1])
        XCTAssertEqual(path(of: transport.requests[5]), "/aktion/lesen/gruppe/entfernen")
    }

    @MainActor
    func testMoveGroupIsOptimisticAndReverts() async throws {
        let transport = feedsServer()
        let context = try setup(transport)
        let store = FeedsStore(context: context)
        await store.load()
        let kultur = try XCTUnwrap(store.model?.groups.first)
        let up = await store.moveGroup(kultur, up: true)
        XCTAssertFalse(up)
        XCTAssertEqual(transport.requests.count, 1)

        transport.hold = true
        let moving = Task { await store.moveGroup(kultur, up: false) }
        await waitUntil { transport.heldCount == 1 }
        XCTAssertEqual(store.model?.groups.map(\.name), ["Technik", "Kultur"])
        XCTAssertEqual(store.model?.groups[0].canMoveUp, false)
        XCTAssertEqual(store.model?.groups[1].canMoveDown, false)
        XCTAssertEqual(formFields(transport.requests[1]), ["id": kultur.id, "richtung": "runter"])
        transport.hold = false
        transport.respond { _ in (404, json(#"{"error":"action_failed","message":"Diese Gruppe gibt es nicht mehr"}"#)) }
        transport.release()
        let ok = await moving.value
        XCTAssertFalse(ok)
        XCTAssertEqual(store.model?.groups.map(\.name), ["Kultur", "Technik"])
        XCTAssertEqual(context.toasts.toasts.last?.message, "Diese Gruppe gibt es nicht mehr")
    }

    @MainActor
    func testOPMLImportAndExport() async throws {
        let transport = feedsServer()
        transport.setHeaders(["Content-Disposition": #"attachment; filename="feeds.opml""#, "Content-Type": "text/x-opml; charset=utf-8"], for: "/api/lesen/feeds.opml")
        let context = try setup(transport)
        let store = FeedsStore(context: context)
        await store.load()

        let ok = await store.importOPML(Data("<opml/>".utf8), filename: "abos.opml")
        XCTAssertTrue(ok)
        let upload = transport.requests[1]
        XCTAssertEqual(path(of: upload), "/aktion/lesen/feeds/import")
        XCTAssertEqual(multipartParts(upload)["datei"]?.filename, "abos.opml")
        XCTAssertEqual(context.toasts.toasts.last?.message, "1 Feed importiert, 1 schon abonniert")
        let tooBig = await store.importOPML(Data(count: 2 * 1024 * 1024 + 1))
        XCTAssertFalse(tooBig)

        let exported = await store.exportOPML()
        let url = try XCTUnwrap(exported)
        XCTAssertEqual(url.lastPathComponent, "feeds.opml")
        XCTAssertEqual(try Data(contentsOf: url), Data("<opml/>".utf8))
        XCTAssertEqual(store.exportedFile, url)
        XCTAssertEqual(transport.requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
    }

    /// Rohes Formular einer Aktion (mit wiederholten Feldern).
    private func body(_ request: URLRequest) -> String {
        request.httpBody.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    @MainActor
    func testFeedSelectionAndFilter() async throws {
        let transport = feedsServer()
        let context = try setup(transport)
        let store = FeedsStore(context: context)
        await store.load()
        let model = try XCTUnwrap(store.model)
        let (kultur, blog, atom) = (model.groups[0].feeds[0], model.groups[1].feeds[0], model.ungrouped[0])
        XCTAssertEqual(store.visibleFeeds.map(\.id), [kultur.id, blog.id, atom.id])
        XCTAssertEqual(store.selectionText, "0 Feeds abgehakt")
        XCTAssertFalse(store.allVisibleSelected)

        store.toggleSelection(blog)
        XCTAssertTrue(store.isSelected(blog))
        XCTAssertEqual(store.selectionText, "1 Feed abgehakt")
        store.toggleSelection(blog)
        XCTAssertFalse(store.isSelected(blog))

        // „Alle auswählen“ nimmt nur die sichtbaren; ausgefilterte Häkchen bleiben.
        store.setSelected(atom, true)
        store.filter = FeedFilter(onlyFailing: true)
        XCTAssertEqual(store.visibleFeeds.map(\.id), [blog.id])
        XCTAssertEqual(store.visible(model.groups[0].feeds), [])
        store.selectAllVisible()
        XCTAssertTrue(store.allVisibleSelected)
        XCTAssertEqual(store.selectedFeeds.map(\.id), [blog.id, atom.id])
        XCTAssertEqual(store.selectionText, "2 Feeds abgehakt")
        store.filter.query = "nichts"
        XCTAssertFalse(store.allVisibleSelected, "ohne Sichtbare ist nichts „alle“")
        store.filter = FeedFilter()
        XCTAssertFalse(store.allVisibleSelected)
        store.selectAllVisible()
        XCTAssertEqual(store.selectedCount, 3)
        store.selectNone()
        XCTAssertEqual(store.selectedCount, 0)
    }

    @MainActor
    func testFeedBulkActions() async throws {
        let transport = feedsServer()
        let context = try setup(transport)
        let store = FeedsStore(context: context)
        await store.load()
        let model = try XCTUnwrap(store.model)
        let (kultur, blog, atom) = (model.groups[0].feeds[0], model.groups[1].feeds[0], model.ungrouped[0])

        // Ohne Häkchen geht nichts raus.
        let none = await store.applyBulk(.pause)
        XCTAssertFalse(none)
        XCTAssertEqual(transport.requests.count, 1)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Bitte zuerst Feeds abhaken")

        // Reihenfolge der Liste, je Feed ein `feed`; danach neu laden, Toast, Häkchen weg.
        store.setSelected(atom, true)
        store.setSelected(kultur, true)
        let paused = await store.applyBulk(.pause)
        XCTAssertTrue(paused)
        XCTAssertEqual(path(of: transport.requests[1]), "/aktion/lesen/feeds/auswahl")
        XCTAssertEqual(transport.requests[1].httpMethod, "POST")
        XCTAssertEqual(body(transport.requests[1]), "tun=pausieren&feed=\(kultur.id)&feed=\(atom.id)")
        XCTAssertEqual(path(of: transport.requests[2]), "/api/lesen/feeds")
        XCTAssertEqual(context.toasts.toasts.last?.message, "2 Feeds pausiert")
        XCTAssertEqual(store.selectedCount, 0)
        XCTAssertFalse(store.isBusy(.bulk))

        // Abstand in den Grenzen, neue Gruppe mit Namen, Entfernen bestätigt.
        store.setSelected(blog, true)
        await store.applyBulk(.interval(2))
        XCTAssertEqual(body(transport.requests[3]), "tun=abstand&intervall=5&feed=\(blog.id)")
        store.setSelected(blog, true)
        await store.applyBulk(.interval(5000))
        XCTAssertEqual(body(transport.requests[5]), "tun=abstand&intervall=1440&feed=\(blog.id)")
        store.setSelected(blog, true)
        let unnamed = await store.applyBulk(.move(.newGroup("  ")))
        XCTAssertFalse(unnamed)
        XCTAssertEqual(transport.requests.count, 7)
        XCTAssertTrue(store.isSelected(blog), "abgelehnt: Häkchen bleiben")
        await store.applyBulk(.move(.newGroup(" Später ")))
        XCTAssertEqual(body(transport.requests[7]), "tun=gruppe&ziel=neu&neu=Sp%C3%A4ter&feed=\(blog.id)")
        store.setSelected(blog, true)
        await store.applyBulk(.move(.ungrouped))
        XCTAssertEqual(formFields(transport.requests[9]), ["tun": "gruppe", "ziel": "", "feed": blog.id])
        store.setSelected(blog, true)
        await store.applyBulk(.remove)
        XCTAssertEqual(body(transport.requests[11]), "tun=entfernen&bestaetigt=1&feed=\(blog.id)")

        // Lehnt der Server ab, bleiben die Häkchen und seine Meldung kommt.
        store.setSelected(atom, true)
        transport.respond { _ in (404, json(#"{"error":"action_failed","message":"Diese Feeds gibt es nicht mehr"}"#)) }
        let gone = await store.applyBulk(.resume)
        XCTAssertFalse(gone)
        XCTAssertTrue(store.isSelected(atom))
        XCTAssertEqual(context.toasts.toasts.last?.message, "Diese Feeds gibt es nicht mehr")
    }

    @MainActor
    func testUnreachableFeedShowsServerMessage() async throws {
        let transport = feedsServer()
        let context = try setup(transport)
        let store = FeedsStore(context: context)
        transport.respond { _ in (502, json(#"{"error":"action_failed","message":"Die Adresse ist nicht erreichbar"}"#)) }
        let ok = await store.subscribe(url: "https://weg.test")
        XCTAssertFalse(ok)
        XCTAssertEqual(context.toasts.toasts.last?.message, "Die Adresse ist nicht erreichbar")
    }
}
