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
    private var headers: [String: [String: String]] = [:]
    var hold = false

    init(_ handler: @escaping Handler = { _ in (200, Data("{}".utf8)) }) {
        self.handler = handler
    }

    var requests: [URLRequest] { lock.withLock { recorded } }
    var heldCount: Int { lock.withLock { waiting.count } }

    func respond(_ handler: @escaping Handler) {
        lock.withLock { self.handler = handler }
    }

    /// Zusätzliche Kopfzeilen für Antworten auf `path` (z. B. `Content-Disposition`).
    func setHeaders(_ fields: [String: String], for path: String) {
        lock.withLock { headers[path] = fields }
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
        let (handler, extra) = lock.withLock { (self.handler, headers[request.url?.path ?? ""] ?? [:]) }
        let reply = try handler(request)
        let fields = ["Content-Type": "application/json"].merging(extra) { _, new in new }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: fields)!
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

/// Textfelder und Dateien eines `multipart/form-data`-Bodys (Name → Inhalt, Dateiname).
func multipartParts(_ request: URLRequest) -> [String: (value: String, filename: String?)] {
    guard let type = request.value(forHTTPHeaderField: "Content-Type"), let range = type.range(of: "boundary="),
          let body = request.httpBody, let text = String(data: body, encoding: .utf8) else { return [:] }
    let boundary = "--" + type[range.upperBound...]
    var parts: [String: (String, String?)] = [:]
    for chunk in text.components(separatedBy: boundary) {
        guard let split = chunk.range(of: "\r\n\r\n") else { continue }
        let head = chunk[..<split.lowerBound]
        var value = String(chunk[split.upperBound...])
        // "\r\n" ist ein einziges Zeichen (Graphem).
        if value.hasSuffix("\r\n") { value.removeLast() }
        func attribute(_ key: String) -> String? {
            guard let start = head.range(of: "\(key)=\"") else { return nil }
            let rest = head[start.upperBound...]
            return rest.firstIndex(of: "\"").map { String(rest[..<$0]) }
        }
        if let name = attribute("name") { parts[name] = (value, attribute("filename")) }
    }
    return parts
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
