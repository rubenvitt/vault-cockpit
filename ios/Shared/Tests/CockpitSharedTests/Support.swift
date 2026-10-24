import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import CockpitShared

/// Antwort-Attrappe: zeichnet Anfragen auf, antwortet über `handler`. Mit `hold` warten
/// Anfragen, bis der Test sie mit `release()` freigibt (um den Zwischenstand zu prüfen).
final class FakeTransport: HTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (status: Int, body: Data)

    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var handler: Handler
    var hold = false

    init(_ handler: @escaping Handler = { _ in (200, Data("{}".utf8)) }) {
        self.handler = handler
    }

    var requests: [URLRequest] { lock.withLock { recorded } }
    var heldCount: Int { lock.withLock { waiting.count } }

    func respond(_ handler: @escaping Handler) {
        lock.withLock { self.handler = handler }
    }

    func release() {
        let continuations = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            let all = waiting
            waiting = []
            return all
        }
        for c in continuations { c.resume() }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let held = lock.withLock { () -> Bool in
            recorded.append(request)
            return hold
        }
        if held {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                lock.withLock { waiting.append(c) }
            }
        }
        let handler = lock.withLock { self.handler }
        let reply = try handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        return (reply.body, response)
    }
}

/// Echte Antwort des Servers aus `Fixtures/<name>.json` (erzeugt mit src/cockpit und src/web/http.js).
func fixture(_ name: String) throws -> Data {
    let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"), "Fixture \(name) fehlt")
    return try Data(contentsOf: url)
}

func json(_ text: String) -> Data { Data(text.utf8) }

/// Pfad einer Anfrage ohne Basis, z. B. `/aktion/status`.
func path(of request: URLRequest) -> String {
    request.url?.path ?? ""
}

/// Formularfelder aus dem Body einer Aktion.
func formFields(_ request: URLRequest) -> [String: String] {
    guard let body = request.httpBody, let text = String(data: body, encoding: .utf8), !text.isEmpty else { return [:] }
    var fields: [String: String] = [:]
    for pair in text.split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map { String($0).removingPercentEncoding ?? String($0) }
        fields[parts[0]] = parts.count > 1 ? parts[1] : ""
    }
    return fields
}

func queryValue(_ request: URLRequest, _ name: String) -> String? {
    request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?.first { $0.name == name }?.value
}

/// Leeres Verzeichnis je Test.
func temporaryDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appending(path: "cockpit-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

let testBase = URL(string: "https://cockpit.test")!

@MainActor
func makeContext(_ transport: FakeTransport, directory: URL, toasts: ToastCenter? = nil) -> CockpitContext {
    CockpitContext(
        api: CockpitAPI(baseURL: testBase, token: "vct_geheim", transport: transport),
        snapshots: SnapshotStore(directory: directory.appending(path: "Snapshots")),
        outbox: CaptureOutbox(file: directory.appending(path: "Puffer/erfassen.json")),
        toasts: toasts,
        now: { Date(timeIntervalSince1970: 1_792_000_000) }
    )
}

/// Wartet, bis `condition` gilt (höchstens `timeout` Sekunden).
@MainActor
func waitUntil(_ timeout: TimeInterval = 2, _ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
    let end = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > end {
            XCTFail("Bedingung nicht erfüllt", file: file, line: line)
            return
        }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}
