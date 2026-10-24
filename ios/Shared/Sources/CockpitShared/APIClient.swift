import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Fehlerantwort des Servers (`{error, status, message}`) oder ein HTTP-Status ohne solchen Body.
public struct APIError: Error, Equatable, LocalizedError {
    public let status: Int
    /// Maschinenlesbar, z. B. `unauthorized`, `invalid_code`.
    public let code: String?
    /// Deutscher Satz zum Anzeigen.
    public let message: String

    public init(status: Int, code: String?, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    /// Token unbekannt oder widerrufen: neu anmelden.
    public var isUnauthorized: Bool { status == 401 }
    public var errorDescription: String? { message }
}

private struct FailureBody: Decodable {
    let error: String?
    let message: String?
}

/// Client für die App-API (`/api/app/…`) und `POST /lesestapel/speichern` mit dem Geräte-Token.
///
/// ```swift
/// let api = APIClient(baseURL: config.serverURL, token: token)
/// let saved = try await api.saveToReadingList(url: link)
/// ```
public struct APIClient: Sendable {
    public let baseURL: URL
    private let token: String
    private let session: URLSession

    public init(baseURL: URL, token: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    /// Prüft den Token.
    public func me() async throws -> Me {
        try await send("api/app/ich")
    }

    /// Wiedergabeliste für `minutes` (5, 15, 30 oder 60; sonst nimmt der Server 15).
    public func queue(minutes: Int = 15) async throws -> Queue {
        try await send("api/app/stapel", query: [URLQueryItem(name: "zeit", value: String(minutes))])
    }

    public func text(id: String) async throws -> ListenText {
        try await send("api/app/text", query: [URLQueryItem(name: "id", value: id)])
    }

    /// Ein Stück des Textes als MP3 von der Stimme auf dem Server (`start`/`end` in UTF-16-Einheiten
    /// wie die Sätze). 404, wenn keine eingerichtet ist; 502, wenn der Anbieter ablehnt.
    public func audio(id: String, start: Int, end: Int) async throws -> Data {
        let query = [URLQueryItem(name: "id", value: id), URLQueryItem(name: "von", value: String(start)), URLQueryItem(name: "bis", value: String(end))]
        var request = URLRequest(url: baseURL.appending(path: "api/app/audio").appending(queryItems: query))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        try Self.check(data, response)
        return data
    }

    /// Lädt die MP3 einer fertigen Folge (`/api/app/folge`) nach `destination`; eine Datei dort
    /// wird ersetzt. 404, wenn es die Folge nicht gibt oder sie noch entsteht.
    public func downloadEpisode(id: String, to destination: URL) async throws {
        var request = URLRequest(url: baseURL.appending(path: "api/app/folge").appending(queryItems: [URLQueryItem(name: "id", value: id)]))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        let (file, response) = try await session.download(for: request)
        let files = FileManager.default
        defer { try? files.removeItem(at: file) }
        // Bei einem Fehler steht die Meldung des Servers (JSON) in der Datei.
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) { try Self.check((try? Data(contentsOf: file)) ?? Data(), response) }
        try files.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if files.fileExists(atPath: destination.path) { try files.removeItem(at: destination) }
        try files.moveItem(at: file, to: destination)
    }

    /// Speichert die Lesestelle; `anchor` in Zeichen des Textes. Liefert den Fortschritt laut Server.
    @discardableResult
    public func saveProgress(id: String, progress: Double, anchor: Int? = nil) async throws -> Double {
        struct Body: Encodable { let id: String; let fortschritt: Double; let anker: Int? }
        struct Result: Decodable { let progress: Double }
        let result: Result = try await send("api/app/fortschritt", body: Body(id: id, fortschritt: progress, anker: anchor))
        return result.progress
    }

    public func addHighlight(_ highlight: NewHighlight) async throws -> HighlightResult {
        try await send("api/app/markierung", body: highlight)
    }

    /// Widerruft diesen Geräte-Token auf dem Server (Abmelden); danach gibt jeder Aufruf 401.
    public func signOut() async throws {
        struct Empty: Codable {}
        let _: Empty = try await send("api/app/abmelden", body: Empty())
    }

    /// Legt eine Adresse in den Lesestapel (Recht „Lesestapel“ gehört zum App-Token). `id` macht
    /// das Speichern idempotent: ein zweiter Versuch mit derselben `id` speichert nicht doppelt.
    public func saveToReadingList(url: URL, title: String? = nil, id: String? = nil) async throws -> SavedDocument {
        struct Body: Encodable { let url: String; let title: String?; let id: String? }
        return try await send("lesestapel/speichern", body: Body(url: url.absoluteString, title: title, id: id))
    }

    /// Lädt eine PDF-Datei (höchstens 20 MB) in den Lesestapel. Der Body kommt als Stream aus der
    /// Datei, damit sie nicht ganz im Speicher liegt (Share Extension).
    public func saveToReadingList(pdfFile: URL, title: String? = nil, id: String? = nil) async throws -> SavedDocument {
        var components = URLComponents(url: baseURL.appending(path: "lesestapel/speichern"), resolvingAgainstBaseURL: false)!
        // URLSearchParams auf dem Server liest „+“ als Leerzeichen, deshalb auch „+“ kodieren.
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&="))
        let query = [("title", title), ("id", id)].compactMap { name, value in
            value.map { URLQueryItem(name: name, value: $0.addingPercentEncoding(withAllowedCharacters: allowed)) }
        }
        if !query.isEmpty { components.percentEncodedQueryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
        let size = try pdfFile.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        request.setValue(String(size), forHTTPHeaderField: "Content-Length")
        request.httpBodyStream = InputStream(url: pdfFile)
        return try await Self.perform(request, session: session)
    }

    /// Tauscht den Code aus dem Login-Blatt gegen Sitzungs-Cookie und Geräte-Token. Der Code
    /// gilt für genau einen Versuch, auch ein Fehlschlag verbraucht ihn.
    public static func redeem(baseURL: URL, code: String, verifier: String, device: String, session: URLSession = .shared) async throws -> Redemption {
        struct Body: Encodable { let code: String; let verifier: String; let device: String }
        var request = URLRequest(url: baseURL.appending(path: "api/app/einloesen"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Body(code: code, verifier: verifier, device: device))
        return try await perform(request, session: session)
    }

    private func send<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let url = baseURL.appending(path: path)
        var request = URLRequest(url: query.isEmpty ? url : url.appending(queryItems: query))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try await Self.perform(request, session: session)
    }

    private func send<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await Self.perform(request, session: session)
    }

    private static func perform<T: Decodable>(_ request: URLRequest, session: URLSession) async throws -> T {
        var request = request
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        try check(data, response)
        return try decoder.decode(T.self, from: data)
    }

    /// Wirft `APIError` mit der Meldung des Servers, wenn der Status kein Erfolg ist.
    private static func check(_ data: Data, _ response: URLResponse) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard !(200..<300).contains(status) else { return }
        let failure = try? JSONDecoder().decode(FailureBody.self, from: data)
        throw APIError(status: status, code: failure?.error, message: failure?.message ?? HTTPURLResponse.localizedString(forStatusCode: status))
    }

    /// Datumsangaben kommen als ISO 8601 mit Millisekunden (`2026-11-22T10:00:00.000Z`).
    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(raw) { return date }
            return try Date.ISO8601FormatStyle().parse(raw)
        }
        return decoder
    }()
}
