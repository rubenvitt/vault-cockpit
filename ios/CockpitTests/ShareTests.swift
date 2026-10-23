import CockpitShared
import XCTest

/// Share Extension: Inhaltserkennung, PDF-Upload und Offline-Puffer (`MockURLProtocol` aus APIClientTests).
final class ShareTests: XCTestCase {
    private let base = URL(string: "https://vault.test")!
    private var session: URLSession!
    private var directory: URL!
    private var seen: [(request: URLRequest, body: Data)] = []

    override func setUpWithError() throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        session = URLSession(configuration: config)
        directory = FileManager.default.temporaryDirectory.appending(path: "ShareTests-\(UUID().uuidString)")
        seen = []
    }

    override func tearDownWithError() throws {
        MockURLProtocol.handler = nil
        MockURLProtocol.failure = nil
        try? FileManager.default.removeItem(at: directory)
    }

    private var client: APIClient { APIClient(baseURL: base, token: "vct_geheim", session: session) }

    private func respond(status: Int = 201, duplicate: Bool = false) {
        MockURLProtocol.failure = nil
        MockURLProtocol.handler = { [unowned self] request, body in
            seen.append((request, body))
            if status >= 400 { return (status, #"{"error":"Ungültige Adresse","status":\#(status),"message":"Nicht gespeichert: Ungültige Adresse"}"#) }
            return (status, #"{"ok":true,"id":"d1","title":"Vom Lesen","url":"https://blatt.test/a","kind":"artikel","duplicate":\#(duplicate),"message":"Im Lesestapel: Vom Lesen"}"#)
        }
    }

    private func pdf(_ bytes: String = "%PDF-1.7 Inhalt") throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "quelle.pdf")
        try Data(bytes.utf8).write(to: file)
        return file
    }

    // MARK: Inhaltserkennung

    func testDetectsWebURL() {
        let url = URL(string: "https://blatt.test/a")!
        XCTAssertEqual(SharedContent.detect(urls: [url], texts: [], hasPDF: false), .link(url, title: nil))
    }

    func testTextWithLinkGivesTitle() {
        XCTAssertEqual(
            SharedContent.detect(urls: [], texts: ["Vom Lesen — https://blatt.test/a?x=1"], hasPDF: false),
            .link(URL(string: "https://blatt.test/a?x=1")!, title: "Vom Lesen"))
        XCTAssertEqual(
            SharedContent.detect(urls: [], texts: ["Lies das: „https://blatt.test/b“."], hasPDF: false),
            .link(URL(string: "https://blatt.test/b")!, title: "Lies das"))
        XCTAssertEqual(
            SharedContent.detect(urls: [], texts: ["HTTP://Blatt.test/c"], hasPDF: false),
            .link(URL(string: "HTTP://Blatt.test/c")!, title: nil))
    }

    func testTextTitleOnlyForTheSameURL() {
        let url = URL(string: "https://blatt.test/a")!
        XCTAssertEqual(SharedContent.detect(urls: [url], texts: ["Vom Lesen https://blatt.test/a"], hasPDF: false), .link(url, title: "Vom Lesen"))
        XCTAssertEqual(SharedContent.detect(urls: [url], texts: ["Anderes https://blatt.test/z"], hasPDF: false), .link(url, title: nil))
    }

    func testPDFWinsAndFileURLsAreNoLinks() {
        let file = URL(filePath: "/tmp/a.pdf")
        XCTAssertEqual(SharedContent.detect(urls: [file, URL(string: "https://blatt.test/a")!], texts: [], hasPDF: true), .pdf(title: nil))
        XCTAssertNil(SharedContent.detect(urls: [file], texts: [], hasPDF: false))
    }

    func testNothingToSave() {
        XCTAssertNil(SharedContent.detect(urls: [URL(string: "mailto:a@b.test")!], texts: ["ohne Link", "ftp://x.test"], hasPDF: false))
    }

    // MARK: Senden

    func testSaveLinkSendsID() async throws {
        respond()
        _ = try await client.saveToReadingList(url: URL(string: "https://blatt.test/a")!, title: "Vom Lesen", id: "share-1")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: seen[0].body) as? [String: String])
        XCTAssertEqual(body, ["url": "https://blatt.test/a", "title": "Vom Lesen", "id": "share-1"])
    }

    func testUploadsPDFFromFile() async throws {
        respond()
        let saved = try await client.saveToReadingList(pdfFile: try pdf(), title: "C++ & Co", id: "share-2")
        XCTAssertEqual(saved.title, "Vom Lesen")
        let request = seen[0].request
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path(), "/lesestapel/speichern")
        XCTAssertEqual(request.url?.query(percentEncoded: true), "title=C%2B%2B%20%26%20Co&id=share-2")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/pdf")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer vct_geheim")
        XCTAssertEqual(String(decoding: seen[0].body, as: UTF8.self), "%PDF-1.7 Inhalt")
    }

    // MARK: Offline-Puffer

    func testBufferKeepsLinkAndPDF() throws {
        let pending = PendingShares(directory: directory.appending(path: "puffer"))
        let link = PendingShare(id: "a", url: URL(string: "https://blatt.test/a")!, title: "Vom Lesen")
        let file = PendingShare(id: "b", url: nil, title: nil)
        try pending.add(link)
        try pending.add(file, pdf: try pdf("%PDF-1.7 B"))
        XCTAssertEqual(Set(pending.all().map(\.id)), ["a", "b"])
        XCTAssertEqual(pending.all().first { $0.id == "a" }, link)
        XCTAssertEqual(try String(contentsOf: pending.pdfFile(for: file), encoding: .utf8), "%PDF-1.7 B")
    }

    func testFlushSendsAndRemoves() async throws {
        let pending = PendingShares(directory: directory.appending(path: "puffer"))
        try pending.add(PendingShare(id: "a", url: URL(string: "https://blatt.test/a")!, title: nil))
        let file = PendingShare(id: "b", url: nil, title: nil)
        try pending.add(file, pdf: try pdf())
        respond(status: 200, duplicate: true)
        let rejected = await pending.flush(using: client)
        XCTAssertTrue(rejected.isEmpty)
        XCTAssertEqual(seen.count, 2)
        XCTAssertEqual(Set(seen.map { $0.request.value(forHTTPHeaderField: "Content-Type") ?? "" }), ["application/json", "application/pdf"])
        XCTAssertTrue(pending.all().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: pending.pdfFile(for: file).path()))
    }

    func testFlushKeepsEverythingOfflineAndAfterExpiredLogin() async throws {
        let pending = PendingShares(directory: directory.appending(path: "puffer"))
        try pending.add(PendingShare(id: "a", url: URL(string: "https://blatt.test/a")!, title: nil))
        try pending.add(PendingShare(id: "b", url: URL(string: "https://blatt.test/b")!, title: nil))
        MockURLProtocol.failure = URLError(.notConnectedToInternet)
        await pending.flush(using: client)
        XCTAssertEqual(pending.all().count, 2)

        respond(status: 401)
        await pending.flush(using: client)
        XCTAssertEqual(seen.count, 1, "nach 401 bricht das Nachsenden ab")
        XCTAssertEqual(pending.all().count, 2)
    }

    func testFlushDropsRejected() async throws {
        let pending = PendingShares(directory: directory.appending(path: "puffer"))
        try pending.add(PendingShare(id: "a", url: URL(string: "https://blatt.test/a")!, title: nil))
        respond(status: 400)
        let rejected = await pending.flush(using: client)
        XCTAssertEqual(rejected.map(\.share.id), ["a"])
        XCTAssertEqual((rejected.first?.error as? APIError)?.message, "Nicht gespeichert: Ungültige Adresse")
        XCTAssertTrue(pending.all().isEmpty)
    }
}
