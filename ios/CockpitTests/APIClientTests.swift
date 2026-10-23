import CockpitShared
import XCTest

/// Antwortet statt des Netzes; `handler` sieht die Anfrage samt Body.
final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest, Data) -> (Int, String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        // Im URLProtocol kommt der Body als Stream, nicht als httpBody.
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read) ?? Data()
        let (status, json) = Self.handler!(request, body)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            guard n > 0 else { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

final class APIClientTests: XCTestCase {
    private let base = URL(string: "https://vault.test")!
    private var session: URLSession!
    private var seen: [(request: URLRequest, body: [String: Any])] = []

    override func setUp() {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        session = URLSession(configuration: config)
        seen = []
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
    }

    private func respond(_ json: String, status: Int = 200) {
        seen = []
        MockURLProtocol.handler = { [unowned self] request, body in
            seen.append((request, (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]))
            return (status, json)
        }
    }

    private var client: APIClient { APIClient(baseURL: base, token: "vct_geheim", session: session) }

    func testMeSendsBearerToken() async throws {
        respond(#"{"ok":true,"name":"Rubens iPhone","scopes":["app","lesestapel"],"version":"0.1.0"}"#)
        let me = try await client.me()
        XCTAssertEqual(me.name, "Rubens iPhone")
        XCTAssertEqual(me.scopes, ["app", "lesestapel"])
        XCTAssertEqual(seen[0].request.url?.absoluteString, "https://vault.test/api/app/ich")
        XCTAssertEqual(seen[0].request.httpMethod, "GET")
        XCTAssertEqual(seen[0].request.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
    }

    func testQueueAndText() async throws {
        respond(#"{"ok":true,"zeit":30,"items":[{"id":"d1","title":"Vom Lesen","url":"https://blatt.test/a","site":null,"kind":"artikel","minutes":5,"remaining":3,"progress":0.4}]}"#)
        let queue = try await client.queue(minutes: 30)
        XCTAssertEqual(seen[0].request.url?.absoluteString, "https://vault.test/api/app/stapel?zeit=30")
        XCTAssertEqual(queue.minutes, 30)
        XCTAssertEqual(queue.items.first?.remaining, 3)
        XCTAssertNil(queue.items.first?.site)

        respond(#"{"ok":true,"id":"d1","title":"Vom Lesen","text":"Eins. Zwei.","sentences":[[0,5],[6,11]],"progress":0.5,"anchor":6}"#)
        let text = try await client.text(id: "d 1")
        XCTAssertEqual(seen[0].request.url?.absoluteString, "https://vault.test/api/app/text?id=d%201")
        XCTAssertEqual(text.sentences, [[0, 5], [6, 11]])
        XCTAssertEqual(text.anchor, 6)
    }

    func testWritesSendJSON() async throws {
        respond(#"{"ok":true,"progress":0.42}"#)
        let progress = try await client.saveProgress(id: "d1", progress: 0.42, anchor: 1234)
        XCTAssertEqual(progress, 0.42)
        XCTAssertEqual(seen[0].request.httpMethod, "POST")
        XCTAssertEqual(seen[0].request.url?.path(), "/api/app/fortschritt")
        XCTAssertEqual(seen[0].request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(seen[0].body["id"] as? String, "d1")
        XCTAssertEqual(seen[0].body["fortschritt"] as? Double, 0.42)
        XCTAssertEqual(seen[0].body["anker"] as? Int, 1234)

        respond(#"{"ok":true,"id":"app-1","duplicate":false,"message":"Markiert."}"#, status: 201)
        let mark = try await client.addHighlight(NewHighlight(id: "d1", quote: "Zwei.", start: 6, cid: "app-1"))
        XCTAssertEqual(mark.id, "app-1")
        XCTAssertFalse(mark.duplicate)
        XCTAssertEqual(seen[0].request.url?.path(), "/api/app/markierung")
        XCTAssertEqual(seen[0].body["quote"] as? String, "Zwei.")
        XCTAssertNil(seen[0].body["prefix"], "leere Felder fehlen statt null")

        respond(#"{"ok":true,"id":"d2","title":null,"url":"https://blatt.test/b","kind":"artikel","duplicate":false,"message":"Im Lesestapel: blatt.test"}"#, status: 201)
        let saved = try await client.saveToReadingList(url: URL(string: "https://blatt.test/b")!)
        XCTAssertEqual(saved.message, "Im Lesestapel: blatt.test")
        XCTAssertEqual(seen[0].request.url?.path(), "/lesestapel/speichern")
        XCTAssertEqual(seen[0].request.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
        XCTAssertEqual(seen[0].body["url"] as? String, "https://blatt.test/b")
    }

    func testSignOutRevokesToken() async throws {
        respond(#"{"ok":true}"#)
        try await client.signOut()
        XCTAssertEqual(seen[0].request.httpMethod, "POST")
        XCTAssertEqual(seen[0].request.url?.path(), "/api/app/abmelden")
        XCTAssertEqual(seen[0].request.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
    }

    func testErrorsCarryStatusAndMessage() async {
        respond(#"{"error":"unauthorized","status":401,"message":"Token abgelehnt. Bitte in der App neu anmelden."}"#, status: 401)
        do {
            _ = try await client.me()
            XCTFail("401 erwartet")
        } catch let error as APIError {
            XCTAssertTrue(error.isUnauthorized)
            XCTAssertEqual(error.code, "unauthorized")
            XCTAssertEqual(error.localizedDescription, "Token abgelehnt. Bitte in der App neu anmelden.")
        } catch {
            XCTFail("\(error)")
        }

        respond("<html>Bad Gateway</html>", status: 502)
        do {
            _ = try await client.me()
            XCTFail("502 erwartet")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 502)
            XCTAssertNil(error.code)
        } catch {
            XCTFail("\(error)")
        }
    }

    func testRedeemDecodesCookieAndToken() async throws {
        respond(#"""
        {"ok":true,"cookie":{"name":"vc_session","value":"abc.def","domain":"vault.test","path":"/","expires":"2026-11-22T10:00:00.000Z","secure":true,"httpOnly":true,"sameSite":"Lax"},
         "token":{"token":"vct_neu","id":"t1","name":"iPhone","scopes":["app","lesestapel"]}}
        """#)
        let result = try await APIClient.redeem(baseURL: base, code: "c0de", verifier: "v", device: "iPhone · 23.10.2026", session: session)
        XCTAssertEqual(seen[0].request.url?.absoluteString, "https://vault.test/api/app/einloesen")
        XCTAssertEqual(seen[0].request.httpMethod, "POST")
        XCTAssertNil(seen[0].request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(seen[0].body as? [String: String], ["code": "c0de", "verifier": "v", "device": "iPhone · 23.10.2026"])
        XCTAssertEqual(result.token.token, "vct_neu")
        XCTAssertEqual(result.cookie.expires, Date(timeIntervalSince1970: 1_795_341_600))
    }

    func testRedeemFailureIsInvalidCode() async {
        respond(#"{"error":"invalid_code","status":400,"message":"Code ungültig, abgelaufen oder schon eingelöst. Bitte neu anmelden."}"#, status: 400)
        do {
            _ = try await APIClient.redeem(baseURL: base, code: "alt", verifier: "v", device: "iPhone", session: session)
            XCTFail("400 erwartet")
        } catch {
            XCTAssertEqual((error as? APIError)?.code, "invalid_code")
        }
    }

    func testSessionCookieBecomesHTTPCookie() throws {
        let expires = Date(timeIntervalSince1970: 1_795_341_600)
        let json = #"{"name":"vc_session","value":"abc","domain":"vault.test","path":"/","expires":"2026-11-22T10:00:00Z","secure":true,"httpOnly":true,"sameSite":"Lax"}"#
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let session = try decoder.decode(SessionCookie.self, from: Data(json.utf8))
        let cookie = try XCTUnwrap(session.httpCookie)
        XCTAssertEqual(cookie.name, "vc_session")
        XCTAssertEqual(cookie.value, "abc")
        XCTAssertEqual(cookie.domain, "vault.test")
        XCTAssertEqual(cookie.path, "/")
        XCTAssertEqual(cookie.expiresDate, expires)
        XCTAssertTrue(cookie.isSecure)
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertFalse(cookie.isSessionOnly)
        XCTAssertEqual(cookie.sameSitePolicy, .sameSiteLax)

        let local = try decoder.decode(SessionCookie.self, from: Data(json.replacingOccurrences(of: #""secure":true,"httpOnly":true"#, with: #""secure":false,"httpOnly":false"#).utf8))
        XCTAssertFalse(try XCTUnwrap(local.httpCookie).isSecure)
        XCTAssertFalse(try XCTUnwrap(local.httpCookie).isHTTPOnly)
    }
}
