import AuthenticationServices
import CryptoKit
import UIKit

/// PKCE wie beim Server (src/web/app-access.js): `challenge = base64url(sha256(verifier))`.
struct PKCE {
    let verifier: String
    let challenge: String

    /// 32 Zufallsbytes base64url ergeben 43 Zeichen aus `[A-Za-z0-9-_]`.
    init(verifier: String = randomURLSafe(bytes: 32)) {
        self.verifier = verifier
        challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncoded()
    }
}

func randomURLSafe(bytes: Int) -> String {
    var generator = SystemRandomNumberGenerator()
    return Data((0..<bytes).map { _ in UInt8.random(in: .min ... .max, using: &generator) }).base64URLEncoded()
}

extension Data {
    func base64URLEncoded() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum LoginError: LocalizedError, Equatable {
    case stateMismatch, denied, invalidCallback, invalidCookie
    /// Das Login-Blatt ging gar nicht erst auf, meist weil Apple die Associated Domain nicht bestätigt hat.
    /// `detail`: Fehler-Domain, Code und Dauer, damit sich die Ursache auf dem Gerät ablesen lässt.
    case notStarted(host: String, detail: String)

    var errorDescription: String? {
        switch self {
        case .stateMismatch, .invalidCallback: "Die Antwort der Anmeldung passt nicht. Bitte noch einmal anmelden."
        case .denied: "Die Anmeldung wurde abgebrochen oder nicht angenommen."
        case .invalidCookie: "Der Server hat kein brauchbares Sitzungs-Cookie geschickt."
        case .notStarted(let host, let detail): "Anmeldung konnte nicht starten. Ist der Server mit dem App-Login schon deployt? (Associated Domains für \(host) nicht bestätigt)\n\(detail)"
        }
    }

    /// Was der Login-Bildschirm zu einem Fehler zeigt; nil: vom Nutzer abgebrochen, nichts zeigen.
    /// Ohne bestätigte Associated Domain (AASA fehlt) bricht das Login-Blatt mit https-Callback sofort
    /// mit `canceledLogin` ab, als hätte man „Abbrechen“ getippt.
    // shortcut: unter einer Sekunde gilt `canceledLogin` als „nicht gestartet“; ersetzen, falls iOS dafür einen eigenen Fehler liefert.
    static func shown(_ error: Error, elapsed: TimeInterval, host: String) -> Error? {
        if error is LoginError { return error }
        guard let sessionError = error as? ASWebAuthenticationSessionError else { return error }
        if sessionError.code == .canceledLogin && elapsed >= 1 { return nil }
        let ns = error as NSError
        return LoginError.notStarted(host: host, detail: "\(ns.domain) \(ns.code) nach \(elapsed.formatted(.number.precision(.fractionLength(1)))) s")
    }
}

/// Ein App-Login (README „iOS-App: Login und App-API“): Login-Blatt öffnen, Callback prüfen.
struct LoginRequest {
    static let callbackPath = "/app/angemeldet"

    let serverURL: URL
    let pkce = PKCE()
    let state = randomURLSafe(bytes: 16)

    var url: URL {
        serverURL.appending(path: "login").appending(queryItems: [
            URLQueryItem(name: "app", value: "1"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "challenge", value: pkce.challenge),
        ])
    }

    /// Universal Link des Servers. Nur in Debug und nur für einen Server ohne https (dort gibt es keine
    /// Universal Links) das eigene Schema, das der Server dann auch nur dort schickt. Ein Release-Build
    /// kennt `cockpit://` nicht.
    var callback: ASWebAuthenticationSession.Callback {
        #if DEBUG
        if serverURL.scheme == "http" { return .customScheme("cockpit") }
        #endif
        return .https(host: serverURL.host() ?? "", path: Self.callbackPath)
    }

    /// Der Code aus dem Callback, nachdem `state` geprüft ist.
    func code(from callback: URL) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard value("state") == state else { throw LoginError.stateMismatch }
        if value("error") != nil { throw LoginError.denied }
        guard let code = value("code"), !code.isEmpty else { throw LoginError.invalidCallback }
        return code
    }

    /// `UIDevice.name` ist seit iOS 16 nur „iPhone“; Modell und Datum machen den Token unter
    /// Einstellungen → API-Tokens unterscheidbar, z. B. „iPhone · iPhone17,1 · 23.10.2026“.
    static func deviceName(name: String, model: String, date: Date) -> String {
        let day = date.formatted(.dateTime.day(.twoDigits).month(.twoDigits).year().locale(Locale(identifier: "de_DE")))
        // Der Server zählt UTF-16-Einheiten wie JS (höchstens 80); ein Emoji sind meist zwei.
        var result = ""
        for character in "\(name) · \(model) · \(day)" {
            guard result.utf16.count + String(character).utf16.count <= 80 else { break }
            result.append(character)
        }
        return result
    }

    @MainActor
    static var currentDeviceName: String {
        deviceName(name: UIDevice.current.name, model: modelIdentifier, date: .now)
    }

    private static var modelIdentifier: String {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return simulated }
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}

/// Öffnet das Login-Blatt des Systems und liefert die Callback-URL.
@MainActor
final class WebAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(url: URL, callback: ASWebAuthenticationSession.Callback) async throws -> URL {
        defer { session = nil }
        return try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            let session = ASWebAuthenticationSession(url: url, callback: callback) { url, error in
                guard !resumed else { return }
                resumed = true
                if let url { continuation.resume(returning: url) } else { continuation.resume(throwing: error ?? LoginError.invalidCallback) }
            }
            session.presentationContextProvider = self
            // Gemeinsame Sitzung mit Safari, damit Pocket ID angemeldet bleibt und Passkeys greifen.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            // `start()` false kommt ohne Completion: sonst dreht der Spinner für immer.
            if !session.start(), !resumed {
                resumed = true
                continuation.resume(throwing: LoginError.notStarted(host: url.host() ?? "", detail: "start() = false"))
            }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}
