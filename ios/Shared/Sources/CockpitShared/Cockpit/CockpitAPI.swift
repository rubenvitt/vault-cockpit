import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Schickt eine Anfrage und liefert Body und Antwort. Die App nimmt `URLSessionTransport`,
/// Tests eine Attrappe ohne Netz.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// `HTTPTransport` über `URLSession`.
public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        // Nur der Geräte-Token zählt: Ein Sitzungs-Cookie aus dem gemeinsamen Keksglas würde der
        // Server sonst vorziehen und für Aktionen ein CSRF-Token verlangen.
        var request = request
        request.httpShouldHandleCookies = false
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

/// Fehler der Cockpit-API, auf Deutsch zum Anzeigen (`message`).
public enum CockpitError: Error, Equatable, LocalizedError, Sendable {
    /// 401: Token unbekannt oder widerrufen, die App muss neu anmelden.
    case unauthorized(message: String)
    /// Der Server hat geantwortet und abgelehnt (`{error, message}`, z. B. `action_failed`,
    /// `invalid_week`); `message` ist sein Satz.
    case failed(status: Int, code: String?, message: String)
    /// Keine Verbindung oder keine Antwort vom Cockpit selbst (etwa ein Proxy während eines
    /// Deploys, 5xx ohne Meldung). Nichts ist passiert, später noch einmal.
    case offline(message: String)
    /// Antwort passt nicht zum Modell (Server neuer oder älter als die App).
    case decoding(message: String)

    public var message: String {
        switch self {
        case .unauthorized(let message), .failed(_, _, let message), .offline(let message), .decoding(let message): message
        }
    }

    public var errorDescription: String? { message }
    public var isUnauthorized: Bool { if case .unauthorized = self { true } else { false } }
    public var isOffline: Bool { if case .offline = self { true } else { false } }

    static let loginExpired = "Die Anmeldung ist abgelaufen. Bitte neu anmelden."

    /// Abgebrochen statt gescheitert, z. B. das `.task` eines Bildschirms beim Reiterwechsel:
    /// kein Fehler zum Anzeigen.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let error = error as? URLError { return error.code == .cancelled }
        return false
    }

    /// Ordnet beliebige Fehler ein: `URLError` (außer Abbruch) heißt offline.
    static func from(_ error: Error, action: Bool) -> CockpitError {
        if let error = error as? CockpitError { return error }
        if let rejection = error as? FieldRejection { return rejection.error }
        if let error = error as? URLError, error.code != .cancelled {
            return .offline(message: action ? "Keine Verbindung zum Cockpit. Nichts gespeichert." : "Keine Verbindung zum Cockpit.")
        }
        if error is DecodingError { return .decoding(message: "Die Antwort des Cockpits passt nicht zur App (\(error)).") }
        return .offline(message: error.localizedDescription)
    }
}

/// Antwort einer Aktion mit `ok` und `message`: `ActionResponse` und die Antworten eigener
/// Bereiche (`ReadingActionResponse` im Lesen).
public protocol ActionReply: Decodable {
    var ok: Bool { get }
    var message: String { get }
}

/// Antwort einer Aktion (`POST /aktion/…` mit `Accept: application/json`):
/// `{ok: true, message, undo?, redirect?, task?, result?, path?}`.
public struct ActionResponse: ActionReply, Equatable, Sendable {
    public let ok: Bool
    /// Meldung für den Toast, z. B. „Erledigt: VCP-47 Planen im Cockpit“.
    public let message: String
    /// Formular, das den alten Stand wiederherstellt (Knopf „Rückgängig“).
    public let undo: UndoAction?
    /// Web-Pfad, auf den die Seite wechseln würde (z. B. `/planen?woche=…#flamme`).
    public let redirect: String?
    /// Die geänderte Aufgabe (Status, Fälligkeit, Zuordnen, Phönix, Flamme, Planung).
    public let task: TaskSummary?
    /// Ergebnis der Schnelleingabe (`/aktion/erfassen`).
    public let result: CaptureResult?
    /// Pfad der Notiz (`/aktion/feuer`, `/aktion/feuer/anlegen`, Notiz-Aktionen).
    public let path: String?

    public init(ok: Bool = true, message: String, undo: UndoAction? = nil, redirect: String? = nil, task: TaskSummary? = nil, result: CaptureResult? = nil, path: String? = nil) {
        self.ok = ok
        self.message = message
        self.undo = undo
        self.redirect = redirect
        self.task = task
        self.result = result
        self.path = path
    }
}

/// Client für die JSON-Wege des Cockpits (`/api/woche`, `/api/rueckblick`, `/api/planen`,
/// `/api/erfassen/vorschau`) und alle Aktionen unter `/aktion/…`, angemeldet mit dem
/// Geräte-Token. Aktionen brauchen damit kein CSRF-Feld (src/web/http.js, `appSessionOf`).
///
/// ```swift
/// let api = CockpitAPI(baseURL: config.serverURL, token: token)
/// let week = try await api.week()
/// let done = try await api.action("/aktion/status", fields: ["id": task.id, "status": "done", "prev": "open"])
/// ```
public struct CockpitAPI: Sendable {
    public let baseURL: URL
    private let token: String
    private let transport: HTTPTransport

    public init(baseURL: URL, token: String, transport: HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.token = token
        self.transport = transport
    }

    // MARK: Lesen

    /// Wochenmodell (`cockpit.week`); `nil` = laufende Woche.
    public func week(_ id: String? = nil) async throws -> WeekModel {
        try await get("api/woche", query: Self.weekQuery(id))
    }

    /// Wochenrückblick (`cockpit.review`); `nil` = laufende Woche.
    public func review(_ id: String? = nil) async throws -> ReviewModel {
        try await get("api/rueckblick", query: Self.weekQuery(id))
    }

    /// Planungsseite (`plan.view`): `q` sucht, `area` (Bereichs-ID) filtert, `from` füllt „Flamme einplanen“ vor.
    public func plan(_ id: String? = nil, query: PlanQuery = PlanQuery()) async throws -> PlanModel {
        try await get("api/planen", query: Self.planQuery(id, query))
    }

    /// Vorschau der Schnelleingabe; der Server sieht nur die ersten 500 Zeichen.
    public func capturePreview(_ text: String) async throws -> CapturePreview {
        try await get("api/erfassen/vorschau", query: [URLQueryItem(name: "text", value: String(text.prefix(500)))])
    }

    /// Lädt `path` und dekodiert die Antwort.
    public func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) async throws -> T {
        try Self.decode(T.self, from: try await data(path, query: query))
    }

    /// Lädt `path` und liefert den rohen Body (für `SnapshotStore`); Fehler als `CockpitError`.
    public func data(_ path: String, query: [URLQueryItem] = []) async throws -> Data {
        try await perform(getRequest(path, query: query), action: false)
    }

    // MARK: Dateien

    /// Lädt eine Datei (OPML, Kurzbefehl) mit Namen aus `Content-Disposition`.
    public func download(_ path: String, query: [URLQueryItem] = []) async throws -> DownloadedFile {
        var request = getRequest(path, query: query)
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        return try await file(request, action: false)
    }

    /// Schickt ein Formular, dessen Antwort eine Datei ist (Sicherung). Abgelehnte Felder kommen
    /// als `FieldRejection`.
    public func download(_ path: String, fields: [String: String]) async throws -> DownloadedFile {
        try await file(actionRequest(path, fields: fields), action: true)
    }

    /// Web-Pfad mit Query, wie der Server ihn in JSON schreibt (`/notiz/bild?pfad=…`,
    /// `/kurzbefehle/notiz.shortcut`), als Anfrage mit Geräte-Token. nil bei fremden Adressen.
    public func resourceRequest(_ webPath: String) -> URLRequest? {
        guard webPath.hasPrefix("/"), !webPath.hasPrefix("//"), let parts = URLComponents(string: webPath) else { return nil }
        var url = baseURL.appending(path: Self.relative(parts.path))
        if let query = parts.percentEncodedQuery, !query.isEmpty, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.percentEncodedQuery = query
            url = components.url ?? url
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        return request
    }

    /// Lädt einen Web-Pfad (`resourceRequest`), z. B. ein Bild aus einer Notiz.
    public func resource(_ webPath: String) async throws -> DownloadedFile {
        guard let request = resourceRequest(webPath) else { throw CockpitError.failed(status: 400, code: "bad_path", message: "Unbekannte Adresse: \(webPath)") }
        return try await file(request, action: false)
    }

    private func file(_ request: URLRequest, action: Bool) async throws -> DownloadedFile {
        let (data, response) = try await exchange(request, action: action)
        return DownloadedFile(
            data: data,
            filename: DownloadedFile.filename(fromDisposition: response.value(forHTTPHeaderField: "Content-Disposition")),
            contentType: response.value(forHTTPHeaderField: "Content-Type")
        )
    }

    // MARK: Aktionen

    /// Schickt eine Aktion (`/aktion/status` usw.) als Formular. Wirft `CockpitError.failed`
    /// mit der Meldung des Servers, wenn er ablehnt.
    public func action(_ path: String, fields: [String: String]) async throws -> ActionResponse {
        try await action(path, fields: fields, as: ActionResponse.self)
    }

    /// Wie `action(_:fields:)`, dekodiert aber in ein eigenes Antwortmodell (z. B. mit `doc`
    /// oder `highlight` im Lesen).
    public func action<R: ActionReply>(_ path: String, fields: [String: String], as type: R.Type) async throws -> R {
        try Self.reply(R.self, from: try await perform(actionRequest(path, fields: fields), action: true))
    }

    /// Formular mit wiederholten Feldern in fester Reihenfolge (`doc` je Text bei „Neue Folge“).
    public func action<R: ActionReply>(_ path: String, pairs: [(String, String)], as type: R.Type) async throws -> R {
        var request = actionRequest(path, fields: [:])
        request.httpBody = Data(Self.formBody(pairs: pairs).utf8)
        return try Self.reply(R.self, from: try await perform(request, action: true))
    }

    /// Lädt eine Datei als `multipart/form-data` hoch (PDF unter `/aktion/lesen/pdf`), dazu
    /// Textfelder wie `cid`. Die Datei liegt ganz im Speicher (höchstens 20 MB).
    public func upload<R: ActionReply>(_ path: String, fields: [String: String], file: UploadFile, as type: R.Type) async throws -> R {
        let boundary = "CockpitGrenze-\(UUID().uuidString)"
        var request = actionRequest(path, fields: [:])
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.multipartBody(fields: fields, file: file, boundary: boundary)
        return try Self.reply(R.self, from: try await perform(request, action: true))
    }

    /// Spielt ein `undo` ab (das Formular aus der Antwort einer Aktion).
    public func replay(_ undo: UndoAction) async throws -> ActionResponse {
        try await action(undo.action, fields: undo.fields)
    }

    // MARK: Anfragen

    /// Query wie das Formular kodiert: `URLQueryItem` ließe `+` stehen, der Server
    /// (URLSearchParams) läse daraus ein Leerzeichen (`+woche` in der Vorschau, „C++“ in der Suche).
    public func getRequest(_ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var url = baseURL.appending(path: Self.relative(path))
        if !query.isEmpty, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.percentEncodedQuery = query.map { "\(Self.formEncode($0.name))=\(Self.formEncode($0.value ?? ""))" }.joined(separator: "&")
            url = components.url ?? url
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    public func actionRequest(_ path: String, fields: [String: String]) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: Self.relative(path)))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(Self.formBody(fields).utf8)
        return request
    }

    /// `a=1&b=x%20y`, Schlüssel sortiert. Kodiert alles außer `A-Za-z0-9-._~`, also auch
    /// `+` und `&` (URLSearchParams auf dem Server liest `+` als Leerzeichen).
    public static func formBody(_ fields: [String: String]) -> String {
        fields.sorted { $0.key < $1.key }.map { "\(formEncode($0.key))=\(formEncode($0.value))" }.joined(separator: "&")
    }

    /// Wie `formBody`, aber in der gegebenen Reihenfolge und mit wiederholten Schlüsseln.
    public static func formBody(pairs: [(String, String)]) -> String {
        pairs.map { "\(formEncode($0.0))=\(formEncode($0.1))" }.joined(separator: "&")
    }

    /// Body für `multipart/form-data`: Textfelder (sortiert), dann die Datei. Anführungszeichen
    /// und Zeilenumbrüche im Dateinamen würden den Kopf des Teils brechen und fallen weg.
    static func multipartBody(fields: [String: String], file: UploadFile, boundary: String) -> Data {
        var body = Data()
        func line(_ text: String) { body.append(Data("\(text)\r\n".utf8)) }
        for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
            line("--\(boundary)")
            line("Content-Disposition: form-data; name=\"\(name)\"")
            line("")
            line(value)
        }
        let filename = String(file.filename.filter { $0 != "\"" && !$0.isNewline })
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"\(file.field)\"; filename=\"\(filename)\"")
        line("Content-Type: \(file.contentType)")
        line("")
        body.append(file.data)
        line("")
        line("--\(boundary)--")
        return body
    }

    /// Dekodiert die Antwort einer Aktion; `ok: false` wird `CockpitError.failed`.
    static func reply<R: ActionReply>(_ type: R.Type, from data: Data) throws -> R {
        let response = try decode(R.self, from: data)
        guard response.ok else { throw CockpitError.failed(status: 200, code: nil, message: response.message) }
        return response
    }

    static func formEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// Aktionen heißen wie im Web (`/aktion/status`); `appending(path:)` will sie ohne `/` vorne.
    private static func relative(_ path: String) -> String {
        path.hasPrefix("/") ? String(path.dropFirst()) : path
    }

    static func weekQuery(_ id: String?) -> [URLQueryItem] {
        guard let id, !id.isEmpty else { return [] }
        return [URLQueryItem(name: "woche", value: id)]
    }

    static func planQuery(_ id: String?, _ query: PlanQuery) -> [URLQueryItem] {
        var items = weekQuery(id)
        if !query.q.isEmpty { items.append(URLQueryItem(name: "q", value: query.q)) }
        if !query.area.isEmpty { items.append(URLQueryItem(name: "bereich", value: query.area)) }
        if !query.from.isEmpty { items.append(URLQueryItem(name: "aus", value: query.from)) }
        return items
    }

    private func perform(_ request: URLRequest, action: Bool) async throws -> Data {
        try await exchange(request, action: action).0
    }

    private func exchange(_ request: URLRequest, action: Bool) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch {
            // Abbruch bleibt Abbruch (`CockpitError.isCancellation`), alles andere wird `CockpitError`.
            throw CockpitError.isCancellation(error) ? error : CockpitError.from(error, action: action)
        }
        try Self.check(data, response, action: action)
        return (data, response)
    }

    /// Wirft `CockpitError`, wenn der Status kein Erfolg ist.
    static func check(_ data: Data, _ response: HTTPURLResponse, action: Bool) throws {
        let status = response.statusCode
        guard !(200..<300).contains(status) else { return }
        let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
        if status == 401 { throw CockpitError.unauthorized(message: CockpitError.loginExpired) }
        guard let message = body?.message ?? body?.description else {
            // Keine Meldung vom Cockpit: Proxy oder Neustart, also später noch einmal.
            if status >= 500 { throw CockpitError.offline(message: "Das Cockpit antwortet gerade nicht (\(status)).\(action ? " Nichts gespeichert." : "")") }
            throw CockpitError.failed(status: status, code: body?.error, message: "Fehler \(status).\(action ? " Nichts gespeichert." : "")")
        }
        let failure = CockpitError.failed(status: status, code: body?.error, message: message)
        // Einstellungen, Tokens, Sicherung: `{error: 'invalid', message, field}` nennt das Feld.
        if let field = body?.field, !field.isEmpty { throw FieldRejection(field: field, error: failure) }
        throw failure
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw CockpitError.from(error, action: false)
        }
    }

    /// `/aktion/…` antwortet mit `message`, `/api/…` mit `error_description`.
    private struct ErrorBody: Decodable {
        let error: String?
        let message: String?
        let description: String?
        let field: String?

        enum CodingKeys: String, CodingKey {
            case error, message, field
            case description = "error_description"
        }
    }
}

/// Abgelehntes Formularfeld (`{error: 'invalid', message, field}` von `/api/einstellungen…`):
/// `field` ist der Name wie im Formular (`tz`, `cal.1.url`, `name`, `passphrase2`), `error` der
/// Fehler wie sonst (`CockpitError.failed` mit Status 400). `CockpitContext.report` und alle
/// Stores behandeln ihn wie `error`.
public struct FieldRejection: Error, Equatable, LocalizedError, Sendable {
    public let field: String
    public let error: CockpitError

    public init(field: String, error: CockpitError) {
        self.field = field
        self.error = error
    }

    public var message: String { error.message }
    public var errorDescription: String? { error.message }
}

/// Antwort, die eine Datei ist: Inhalt, Name aus `Content-Disposition` (nil ohne) und Typ.
public struct DownloadedFile: Equatable, Sendable {
    public let data: Data
    public let filename: String?
    public let contentType: String?

    public init(data: Data, filename: String? = nil, contentType: String? = nil) {
        self.data = data
        self.filename = filename
        self.contentType = contentType
    }

    /// `attachment; filename="feeds.opml"` oder `filename*=UTF-8''…` (hat Vorrang).
    static func filename(fromDisposition header: String?) -> String? {
        guard let header else { return nil }
        var plain: String?
        for part in header.split(separator: ";") {
            let pair = part.trimmingCharacters(in: .whitespaces)
            if pair.lowercased().hasPrefix("filename*="), let quote = pair.range(of: "''") {
                if let decoded = String(pair[quote.upperBound...]).removingPercentEncoding, !decoded.isEmpty { return decoded }
            } else if pair.lowercased().hasPrefix("filename=") {
                var value = String(pair.dropFirst("filename=".count))
                if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 { value = String(value.dropFirst().dropLast()) }
                plain = value.isEmpty ? nil : value
            }
        }
        return plain
    }

    /// Schreibt die Datei nach `directory/<name>` (für das Teilen-Blatt); eine Datei dort wird
    /// ersetzt. Schrägstriche im Namen werden `-`.
    public func write(to directory: URL, name: String? = nil) throws -> URL {
        let raw = (name ?? filename ?? "datei").replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\\", with: "-")
        let safe = raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || raw.hasPrefix(".") ? "datei\(raw)" : raw
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appending(path: safe)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        try data.write(to: url, options: .atomic)
        return url
    }
}

/// Datei für `CockpitAPI.upload`: Feldname (`datei`), Dateiname, Typ und Inhalt.
public struct UploadFile: Sendable {
    public let field: String
    public let filename: String
    public let contentType: String
    public let data: Data

    public init(field: String = "datei", filename: String, contentType: String = "application/pdf", data: Data) {
        self.field = field
        self.filename = filename
        self.contentType = contentType
        self.data = data
    }
}
