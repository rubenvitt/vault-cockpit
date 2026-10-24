import Foundation
import XCTest
@testable import CockpitShared

/// Die Fixtures sind echte Antworten des Servers (Attrappen für Zunder, Kalender und Vault wie in
/// test/plan.test.js), damit die Modelle genau das lesen, was `/api/…` und `/aktion/…` liefern.
final class ModelDecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(T.self, from: try fixture(name))
    }

    func testWeek() throws {
        let model = try decode(WeekModel.self, "woche")
        XCTAssertEqual(model.tz, "Europe/Berlin")
        XCTAssertEqual(model.vaultName, "RNotes")
        XCTAssertEqual(model.week.id, "2026-W42")
        XCTAssertEqual(model.week.prev, "2026-W41")
        XCTAssertTrue(model.week.current)
        XCTAssertFalse(model.week.past)
        XCTAssertEqual(model.today, "2026-10-14")
        XCTAssertEqual(model.capabilities, WeekCapabilities(actions: true, notes: true, plan: true))

        let feuer = try XCTUnwrap(model.feuer.value ?? nil)
        XCTAssertEqual(feuer.path, "phoenix/Feuer W3.md")
        XCTAssertEqual(feuer.goal, "**Am Mi 14.10. um 14:00 hältst du den Workshop** mit fertigen Folien.")
        XCTAssertEqual(feuer.firstMove, "💻 Laptop auf.")
        XCTAssertEqual(feuer.alignment, "Ziel 1 · Sichtbar werden")

        let burning = try XCTUnwrap(model.burning)
        XCTAssertEqual(burning.id, "t9")
        XCTAssertTrue(burning.running)
        XCTAssertEqual(burning.startedDate, CockpitFormat.date(from: "2026-10-14T09:40:00Z"))

        let flames = try XCTUnwrap(model.flames.value)
        XCTAssertEqual(flames.map(\.id), ["t7", "t9"])
        XCTAssertEqual(flames[0].minutes, 90)
        XCTAssertNil(flames[1].minutes)
        XCTAssertTrue(flames[0].isFlame)

        let rocks = try XCTUnwrap(model.rocks.value)
        XCTAssertFalse(rocks.partial)
        XCTAssertEqual(rocks.groups.map(\.area), ["Finanzen", "Gesundheit"])
        XCTAssertEqual(rocks.groups[0].done, 1)
        XCTAssertEqual(rocks.groups[0].tasks.map(\.status), [.done, .open])
        XCTAssertEqual(rocks.groups[1].tasks[0].status, .blocked)
        XCTAssertEqual(rocks.groups[1].tasks[0].stepWeek, "2026-W42")

        let calendar = try XCTUnwrap(model.calendar.value)
        XCTAssertEqual(calendar.days.count, 7)
        XCTAssertTrue(calendar.days[2].today)
        XCTAssertEqual(calendar.days[2].events.first?.title, "SAS-Workshop, Berlin")
        XCTAssertEqual(calendar.days[2].events.first?.location, "Maritim; Raum 2")
        XCTAssertEqual(calendar.days[2].events.first?.startDate, CockpitFormat.date(from: "2026-10-14T12:00:00Z"))
        XCTAssertTrue(calendar.days[5].events[0].allDay)
        XCTAssertNil(calendar.days[5].events[0].location)
        XCTAssertEqual(calendar.errors, [CalendarFailure(calendar: "Arbeit", error: "CalDAV antwortet mit HTTP 401")])

        let tasks = try XCTUnwrap(model.tasks.value)
        XCTAssertEqual(tasks.map(\.ref), ["GES-3"])
        XCTAssertTrue(tasks[0].overdue)

        XCTAssertEqual(model.inbox.vault.value?.map(\.title), ["2026-10-13 0912 - Web-Cockpit", "Idee"])
        XCTAssertEqual(model.inbox.zunder.value?.map(\.id), ["i1"])
        XCTAssertEqual(model.inbox.targets?.map(\.name), ["Finanzen", "Gesundheit", "Programmieren"])
        XCTAssertEqual(model.inbox.targets?.first?.projects.map(\.name), ["Steuer 2026"])
        XCTAssertEqual(model.inbox.folder, "inbox")
        XCTAssertEqual(model.inbox.count, 3)
    }

    func testWeekWithoutZunderAndCalendar() throws {
        let model = try decode(WeekModel.self, "woche-ohne-zunder")
        XCTAssertEqual(model.feuer, .ok(nil))
        XCTAssertNil(model.burning)
        XCTAssertEqual(model.flames.error, SectionError(error: "Zunder ist nicht eingerichtet", unconfigured: true))
        XCTAssertEqual(model.rocks.error?.unconfigured, true)
        XCTAssertEqual(model.calendar.error, SectionError(error: "Kalender ist nicht eingerichtet", unconfigured: true))
        XCTAssertNotNil(model.tasks.error)
        XCTAssertEqual(model.inbox.vault.value?.count, 2)
        XCTAssertNotNil(model.inbox.zunder.error)
    }

    func testWeekWithPartialZunder() throws {
        let model = try decode(WeekModel.self, "woche-teilweise")
        XCTAssertEqual(model.flames.error, SectionError(error: "Zunder antwortet mit HTTP 502", unconfigured: false))
        // Nur die Fälligkeiten haben geantwortet: Big Rocks mit Hinweis „unvollständig“.
        XCTAssertEqual(model.rocks.value?.partial, true)
        XCTAssertNotNil(model.inbox.zunder.error)
    }

    func testReview() throws {
        let model = try decode(ReviewModel.self, "rueckblick")
        XCTAssertEqual(model.week.id, "2026-W42")
        XCTAssertFalse(model.week.past)
        let content = try XCTUnwrap(model.content.value)
        XCTAssertEqual(content.totals.planned, 5)
        XCTAssertEqual(content.totals.done, 2)
        XCTAssertEqual(content.totals.extra, 1)
        XCTAssertEqual(content.totals.minutes, 90)
        XCTAssertEqual(content.totals.percent, 40)
        XCTAssertEqual(content.areas.map(\.area), ["Finanzen", "Gesundheit"])
        XCTAssertEqual(content.areas[1].open.map(\.id), ["t9", "t6"])
        XCTAssertEqual(content.flames.first?.minutes, 90)
        XCTAssertEqual(content.maxMinutes, 90)

        let off = try decode(ReviewModel.self, "rueckblick-ohne-zunder")
        XCTAssertEqual(off.content.error, SectionError(error: "Zunder ist nicht eingerichtet", unconfigured: true))
    }

    func testPlan() throws {
        let model = try decode(PlanModel.self, "planen")
        XCTAssertEqual(model.query.q, "steuer")
        XCTAssertEqual(model.week.days.count, 7)
        XCTAssertEqual(model.defaultFlameDay, "2026-10-14")
        let content = try XCTUnwrap(model.content.value)
        XCTAssertEqual(content.areas?.map(\.id), ["a1", "a2", "a4"])
        XCTAssertEqual(content.results?.value?.map(\.planned), ["faellig"])
        XCTAssertEqual(content.suggestions.map(\.areaId), ["a1", "a2"])
        XCTAssertEqual(content.suggestions[0].tasks.first?.project, "Steuer 2026")
        XCTAssertEqual(content.suggestions[0].more, 0)
        XCTAssertTrue(content.planned.ok)
        XCTAssertNil(content.planned.error)
        XCTAssertEqual(content.planned.flames.map(\.id), ["t7", "t9"])
        XCTAssertEqual(content.planned.rocks.map(\.areaId), ["a1", "a2"])
        XCTAssertEqual(content.from?.id, "t1")

        // Zeilen wie plan-page.js: Meta, Pille, Zeichen.
        let berlin = TimeZone(identifier: "Europe/Berlin")!
        let belege = try XCTUnwrap(content.suggestions[0].tasks.first)
        XCTAssertEqual(belege.planMeta(timeZone: berlin), "Finanzen / Steuer 2026")
        XCTAssertEqual(belege.planMeta(timeZone: berlin, showArea: false), "Steuer 2026")
        let steuer = try XCTUnwrap(content.results?.value?.first)
        XCTAssertEqual(steuer.planMeta(timeZone: berlin), "FIN-2 · Finanzen · Fr 16.10.")
        XCTAssertEqual(PlanReason.label(try XCTUnwrap(steuer.planned), week: model.week), "fällig KW 42")
        XCTAssertEqual(PlanReason.label(PlanReason.step, week: model.week), "Phönix-Schritt KW 42")
        let schuhe = try XCTUnwrap(content.planned.rocks.last?.tasks.first)
        XCTAssertEqual(schuhe.planMeta(timeZone: berlin, showArea: false), "blockiert")
        XCTAssertEqual(schuhe.planMark, "○")
        XCTAssertEqual(content.planned.flames.map(\.planMark), ["✓", "🕯️"])
        XCTAssertTrue(content.planned.flames[0].isClosed)

        let byArea = try decode(PlanModel.self, "planen-bereich")
        XCTAssertEqual(byArea.content.value?.results?.value?.map(\.id), ["t8", "t9", "t6", "t5"])
        XCTAssertNil(byArea.content.value?.from)

        let off = try decode(PlanModel.self, "planen-ohne-zunder")
        XCTAssertEqual(off.content.error?.unconfigured, true)
        XCTAssertEqual(off.week.days.first?.label, "Mo 12.10.")
    }

    func testCapturePreview() throws {
        let task = try decode(CapturePreview.self, "vorschau-aufgabe")
        XCTAssertEqual(task.kind, "task")
        XCTAssertEqual(task.summary, "Aufgabe · morgen · Gesundheit · Phönix-Schritt KW 42")
        XCTAssertEqual(task.location?.name, "Gesundheit")
        XCTAssertEqual(task.phoenix, PhoenixMark(role: "feuer_schritt", fire: "2026-W42"))
        XCTAssertEqual(task.notes, ["#nirgends passt zu keinem Bereich und keinem Projekt."])
        XCTAssertEqual(task.line, "Aufgabe · morgen · Gesundheit · Phönix-Schritt KW 42 · #nirgends passt zu keinem Bereich und keinem Projekt.")
        XCTAssertTrue(task.isShown)

        let note = try decode(CapturePreview.self, "vorschau-notiz")
        XCTAssertEqual(note.summary, "Notiz")
        XCTAssertFalse(note.isShown)
        XCTAssertEqual(try decode(CapturePreview.self, "vorschau-artikel").summary, "Artikel · Lesestapel")
    }

    func testActionResponses() throws {
        let status = try decode(ActionResponse.self, "aktion-status")
        XCTAssertEqual(status.message, "Erledigt: FIN-2 Steuererklärung abgeben")
        XCTAssertEqual(status.task?.status, .done)
        XCTAssertEqual(status.task?.location?.label, "Finanzen")
        XCTAssertEqual(status.undo, UndoAction(action: "/aktion/status", fields: ["id": "t2", "status": "open"]))

        XCTAssertEqual(try decode(ActionResponse.self, "aktion-faellig").undo?.fields["due"], "keine")
        XCTAssertEqual(try decode(ActionResponse.self, "aktion-zuordnen").undo?.fields["ziel"], "inbox")
        XCTAssertEqual(try decode(ActionResponse.self, "aktion-phoenix").task?.phoenix?.label, "Phönix-Schritt KW 42")

        let on = try decode(ActionResponse.self, "aktion-flamme-an")
        XCTAssertEqual(on.task?.running, true)
        XCTAssertEqual(on.task?.timing, .measured)
        XCTAssertNil(on.undo)
        XCTAssertEqual(try decode(ActionResponse.self, "aktion-flamme-aus").task?.endedAt, "2026-10-14T10:25:00Z")

        let holen = try decode(ActionResponse.self, "aktion-woche-holen")
        XCTAssertEqual(holen.undo, UndoAction(action: "/aktion/woche/zuruecksetzen", fields: ["id": "t1", "phoenix": ""]))
        XCTAssertEqual(holen.task?.location?.label, "Finanzen / Steuer 2026")
        XCTAssertEqual(try decode(ActionResponse.self, "aktion-woche-raus").undo?.fields["phoenix"], "feuer_schritt:2026-W42")

        let flame = try decode(ActionResponse.self, "aktion-woche-flamme")
        XCTAssertEqual(flame.redirect, "/planen?woche=2026-W42#flamme")
        XCTAssertEqual(flame.undo?.fields["status"], "dropped")

        let task = try decode(ActionResponse.self, "aktion-erfassen-aufgabe")
        XCTAssertEqual(task.result?.kind, "task")
        XCTAssertEqual(task.result?.ref, "INB-7")
        XCTAssertEqual(task.result?.link?.absoluteString, "https://zunder.test/#/aufgabe/c2")
        XCTAssertFalse(task.result?.landsInInbox ?? true)
        XCTAssertFalse(task.result?.duplicate ?? true)

        let note = try decode(ActionResponse.self, "aktion-erfassen-notiz")
        XCTAssertEqual(note.result?.kind, "note")
        XCTAssertTrue(note.result?.path?.hasPrefix("inbox/") ?? false)
        XCTAssertEqual(try decode(ActionResponse.self, "aktion-erfassen-artikel").result?.title, "Ein Artikel")
    }

    func testUndoFieldsTurnNumbersIntoText() throws {
        let undo = try JSONDecoder().decode(UndoAction.self, from: json(#"{"action":"/aktion/notiz/checkbox","fields":{"pfad":"a.md","n":"2","line":14,"erledigt":"0"}}"#))
        XCTAssertEqual(undo.fields, ["pfad": "a.md", "n": "2", "line": "14", "erledigt": "0"])
    }

    func testCapabilitiesWithoutCanOfferEverything() throws {
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: try fixture("woche")) as? [String: Any])
        raw["can"] = nil
        let model = try JSONDecoder().decode(WeekModel.self, from: try JSONSerialization.data(withJSONObject: raw))
        XCTAssertNil(model.can)
        XCTAssertEqual(model.capabilities, .all, "älterer Server: alles anbieten")
        raw["can"] = ["actions": true, "notes": false, "plan": false]
        let limited = try JSONDecoder().decode(WeekModel.self, from: try JSONSerialization.data(withJSONObject: raw))
        XCTAssertFalse(limited.capabilities.notes)
        XCTAssertFalse(limited.capabilities.plan)
        // Wie `writeContext`: ohne Aktionen weder Notizen noch Planen.
        raw["can"] = ["actions": false, "notes": true, "plan": true]
        let readOnly = try JSONDecoder().decode(WeekModel.self, from: try JSONSerialization.data(withJSONObject: raw))
        XCTAssertEqual(readOnly.capabilities, WeekCapabilities(actions: false, notes: false, plan: false))
    }

    func testInboxNoteWithoutTitleUsesFileName() throws {
        let note = try JSONDecoder().decode(InboxNote.self, from: json(#"{"path":"inbox/2026-10-24 1427 - Web-Cockpit.md","title":null,"type":null,"updated":null}"#))
        XCTAssertEqual(note.title, "2026-10-24 1427 - Web-Cockpit")
    }

    func testUnknownStatusSurvives() throws {
        let task = try JSONDecoder().decode(ZunderTask.self, from: json(#"{"id":"x","title":"Neu","status":"waiting","area":"Inbox"}"#))
        XCTAssertEqual(task.status.rawValue, "waiting")
        XCTAssertEqual(task.status.mark, "○")
        XCTAssertFalse(task.running)
    }
}
