import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

final class CockpitAPITests: XCTestCase {
    private func api(_ transport: FakeTransport) -> CockpitAPI {
        CockpitAPI(baseURL: testBase, token: "vct_geheim", transport: transport)
    }

    func testGetSendsBearerAndAcceptsJSON() async throws {
        let transport = FakeTransport { _ in (200, try fixture("woche")) }
        let week = try await api(transport).week("2026-W42")
        XCTAssertEqual(week.week.id, "2026-W42")
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod ?? "GET", "GET")
        XCTAssertEqual(path(of: request), "/api/woche")
        XCTAssertEqual(queryValue(request, "woche"), "2026-W42")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    func testCurrentWeekHasNoQuery() async throws {
        let transport = FakeTransport { _ in (200, try fixture("rueckblick")) }
        _ = try await api(transport).review()
        XCTAssertNil(transport.requests.first?.url?.query)
        XCTAssertEqual(transport.requests.first.map(path(of:)), "/api/rueckblick")
    }

    func testPlanQueryUsesServerNames() async throws {
        let transport = FakeTransport { _ in (200, try fixture("planen")) }
        _ = try await api(transport).plan("2026-W42", query: PlanQuery(q: "steuer & co", area: "a1", from: "t1"))
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(path(of: request), "/api/planen")
        XCTAssertEqual(queryValue(request, "q"), "steuer & co")
        XCTAssertEqual(queryValue(request, "bereich"), "a1")
        XCTAssertEqual(queryValue(request, "aus"), "t1")
    }

    func testPreviewSendsAtMost500Characters() async throws {
        let transport = FakeTransport { _ in (200, try fixture("vorschau-aufgabe")) }
        _ = try await api(transport).capturePreview("!" + String(repeating: "a", count: 900))
        XCTAssertEqual(queryValue(transport.requests[0], "text")?.count, 500)
    }

    func testQueryEncodesPlusLikeAForm() async throws {
        // URLSearchParams liest ein rohes `+` als Leerzeichen; `+woche` muss als %2B ankommen.
        let transport = FakeTransport { _ in (200, try fixture("vorschau-aufgabe")) }
        _ = try await api(transport).capturePreview("!Laufen morgen +woche & mehr")
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.query(percentEncoded: true), "text=%21Laufen%20morgen%20%2Bwoche%20%26%20mehr")
        XCTAssertEqual(queryValue(request, "text"), "!Laufen morgen +woche & mehr")
    }

    func testActionPostsFormWithoutCSRF() async throws {
        let transport = FakeTransport { _ in (200, try fixture("aktion-status")) }
        let response = try await api(transport).action("/aktion/status", fields: ["id": "t2", "status": "done", "prev": "open"])
        XCTAssertEqual(response.message, "Erledigt: FIN-2 Steuererklärung abgeben")
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(path(of: request), "/aktion/status")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
        XCTAssertEqual(String(data: try XCTUnwrap(request.httpBody), encoding: .utf8), "id=t2&prev=open&status=done")
        XCTAssertNil(formFields(request)["csrf"])
    }

    func testFormBodyEncodesEverythingButUnreserved() {
        let body = CockpitAPI.formBody(["text": "! Zahnarzt + Ärztin & mehr=1\nZeile 2", "cid": "A-1"])
        XCTAssertEqual(body, "cid=A-1&text=%21%20Zahnarzt%20%2B%20%C3%84rztin%20%26%20mehr%3D1%0AZeile%202")
    }

    func testUndoReplayPostsItsForm() async throws {
        let transport = FakeTransport { _ in (200, json(#"{"ok":true,"message":"Zurückgesetzt: Belege sortieren"}"#)) }
        let undo = UndoAction(action: "/aktion/woche/zuruecksetzen", fields: ["id": "t1", "phoenix": "feuer_schritt:2026-W42"])
        let response = try await api(transport).replay(undo)
        XCTAssertEqual(response.message, "Zurückgesetzt: Belege sortieren")
        XCTAssertEqual(path(of: transport.requests[0]), "/aktion/woche/zuruecksetzen")
        XCTAssertEqual(formFields(transport.requests[0]), ["id": "t1", "phoenix": "feuer_schritt:2026-W42"])
    }

    // MARK: Fehler

    func testUnauthorized() async {
        let transport = FakeTransport { _ in (401, json(#"{"error":"unauthorized","error_description":"Anmeldung unter /login nötig"}"#)) }
        do {
            _ = try await api(transport).week()
            XCTFail("401 erwartet")
        } catch let error as CockpitError {
            XCTAssertTrue(error.isUnauthorized)
            XCTAssertEqual(error.message, "Die Anmeldung ist abgelaufen. Bitte neu anmelden.")
        } catch {
            XCTFail("\(error)")
        }
    }

    func testActionFailedCarriesServerMessage() async throws {
        let transport = FakeTransport { _ in (400, try fixture("aktion-fehler")) }
        do {
            _ = try await api(transport).action("/aktion/woche/holen", fields: ["id": "t1", "woche": "2026-W42", "wann": "2027-01-01"])
            XCTFail("Fehler erwartet")
        } catch let error as CockpitError {
            XCTAssertEqual(error, .failed(status: 400, code: "action_failed", message: "Bitte „Phönix-Schritt“ oder einen Tag dieser Woche wählen"))
        }
    }

    func testInvalidWeekUsesErrorDescription() async throws {
        let transport = FakeTransport { _ in (400, try fixture("woche-ungueltig")) }
        do {
            _ = try await api(transport).week("kaputt")
            XCTFail("Fehler erwartet")
        } catch let error as CockpitError {
            XCTAssertEqual(error, .failed(status: 400, code: "invalid_week", message: "Kalenderwoche wie 2026-W42 erwartet"))
        }
    }

    func testNetworkErrorAndGatewayAreOffline() async {
        let offline = FakeTransport { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await api(offline).action("/aktion/erfassen", fields: ["text": "x"])
            XCTFail("Fehler erwartet")
        } catch {
            XCTAssertEqual(error as? CockpitError, .offline(message: "Keine Verbindung zum Cockpit. Nichts gespeichert."))
        }
        // Proxy während eines Deploys: 502 ohne Meldung vom Cockpit.
        let gateway = FakeTransport { _ in (502, json("<html>Bad Gateway</html>")) }
        do {
            _ = try await api(gateway).week()
            XCTFail("Fehler erwartet")
        } catch {
            XCTAssertTrue((error as? CockpitError)?.isOffline ?? false)
        }
    }

    func testDecodingError() async {
        let transport = FakeTransport { _ in (200, json(#"{"tz":"Europe/Berlin"}"#)) }
        do {
            _ = try await api(transport).week()
            XCTFail("Fehler erwartet")
        } catch {
            guard case .decoding = error as? CockpitError else { return XCTFail("\(error)") }
        }
    }
}
