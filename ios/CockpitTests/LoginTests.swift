import AuthenticationServices
@testable import Cockpit
import XCTest

final class LoginTests: XCTestCase {
    func testPKCEMatchesRFC7636Vector() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testRandomVerifierFitsServerRules() {
        let pkce = PKCE()
        // Server: verifier /^[\w.~-]{43,128}$/, challenge /^[\w-]{43}$/
        XCTAssertNotNil(pkce.verifier.wholeMatch(of: /[A-Za-z0-9\-._~]{43,128}/))
        XCTAssertNotNil(pkce.challenge.wholeMatch(of: /[A-Za-z0-9\-_]{43}/))
        XCTAssertNotEqual(PKCE().verifier, pkce.verifier)
    }

    func testLoginURLCarriesStateAndChallenge() throws {
        let request = LoginRequest(serverURL: URL(string: "https://vault.test")!)
        let items = try XCTUnwrap(URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(request.url.path(), "/login")
        XCTAssertEqual(items.first { $0.name == "app" }?.value, "1")
        XCTAssertEqual(items.first { $0.name == "challenge" }?.value, request.pkce.challenge)
        XCTAssertEqual(items.first { $0.name == "state" }?.value, request.state)
        XCTAssertNotNil(request.state.wholeMatch(of: /[A-Za-z0-9\-_]{8,128}/))
    }

    func testCallbackChecksState() throws {
        let request = LoginRequest(serverURL: URL(string: "https://vault.test")!)
        let ok = URL(string: "https://vault.test/app/angemeldet?code=abc&state=\(request.state)")!
        XCTAssertEqual(try request.code(from: ok), "abc")
        let foreign = URL(string: "https://vault.test/app/angemeldet?code=abc&state=fremd")!
        XCTAssertThrowsError(try request.code(from: foreign)) { XCTAssertEqual($0 as? LoginError, .stateMismatch) }
        let denied = URL(string: "https://vault.test/app/angemeldet?error=access_denied&state=\(request.state)")!
        XCTAssertThrowsError(try request.code(from: denied)) { XCTAssertEqual($0 as? LoginError, .denied) }
        let empty = URL(string: "https://vault.test/app/angemeldet?state=\(request.state)")!
        XCTAssertThrowsError(try request.code(from: empty)) { XCTAssertEqual($0 as? LoginError, .invalidCallback) }
    }

    func testDeviceNameAddsModelAndDate() {
        let date = DateComponents(calendar: .current, year: 2026, month: 10, day: 23, hour: 12).date!
        XCTAssertEqual(LoginRequest.deviceName(name: "iPhone", model: "iPhone17,1", date: date), "iPhone · iPhone17,1 · 23.10.2026")
        XCTAssertEqual(LoginRequest.deviceName(name: String(repeating: "x", count: 100), model: "m", date: date).count, 80)
    }

    func testLoginSheetThatNeverOpenedShowsAMessage() {
        let canceled = ASWebAuthenticationSessionError(.canceledLogin)
        XCTAssertNil(LoginError.shown(canceled, elapsed: 4, host: "vault.test"), "Abbrechen durch den Nutzer: nichts zeigen")
        func notStarted(_ error: Error?) -> (host: String, detail: String)? {
            if case .notStarted(let host, let detail)? = error as? LoginError { return (host, detail) }
            return nil
        }
        let quick = notStarted(LoginError.shown(canceled, elapsed: 0.1, host: "vault.test"))
        XCTAssertEqual(quick?.host, "vault.test", "sofort abgebrochen: Associated Domain fehlt")
        XCTAssertTrue(quick?.detail.contains("WebAuthenticationSession 1 nach") == true, quick?.detail ?? "")
        XCTAssertEqual(notStarted(LoginError.shown(ASWebAuthenticationSessionError(.presentationContextInvalid), elapsed: 4, host: "vault.test"))?.host, "vault.test")
        XCTAssertEqual(notStarted(LoginError.shown(LoginError.notStarted(host: "vault.test", detail: "start() = false"), elapsed: 0, host: "x"))?.detail, "start() = false", "start() false")
        XCTAssertEqual(LoginError.shown(URLError(.notConnectedToInternet), elapsed: 4, host: "vault.test") as? URLError, URLError(.notConnectedToInternet))
        XCTAssertTrue(LoginError.notStarted(host: "vault.test", detail: "x").localizedDescription.contains("Associated Domains für vault.test"))
    }
}
