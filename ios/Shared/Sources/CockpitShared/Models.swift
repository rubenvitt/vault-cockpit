import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Antworten der App-API, Felder wie im README („iOS-App: Login und App-API“).

/// `GET /api/app/ich`
public struct Me: Codable, Equatable, Sendable {
    public let name: String
    public let scopes: [String]
    public let version: String
}

/// `GET /api/app/stapel?zeit=…`: Wiedergabeliste wie `/lesen/hoeren`.
public struct Queue: Codable, Equatable, Sendable {
    /// Zeitfenster in Minuten (5, 15, 30 oder 60).
    public let minutes: Int
    /// Anbieter der Stimme vom Server (z. B. „ElevenLabs“), nil = Sprachausgabe des Geräts.
    public let voice: String?
    public let items: [QueueItem]

    enum CodingKeys: String, CodingKey {
        case minutes = "zeit"
        case voice = "stimme"
        case items
    }

    /// Für die Wiedergabeliste aus Offline-Kopien.
    public init(minutes: Int, voice: String?, items: [QueueItem]) {
        self.minutes = minutes
        self.voice = voice
        self.items = items
    }
}

public struct QueueItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    /// Adresse des Artikels; auch `pdf:…` oder `mid:…`, daher kein `URL`.
    public let url: String
    public let site: String?
    public let kind: String
    /// Lesezeit des ganzen Textes in Minuten.
    public let minutes: Int
    /// Restzeit ab der Lesestelle in Minuten.
    public let remaining: Int
    /// 0…1
    public let progress: Double
}

/// `GET /api/app/text?id=…`: Lesetext mit Sätzen als `[start, end]` in Zeichen des Textes.
public struct ListenText: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let text: String
    public let sentences: [[Int]]
    public let progress: Double
    /// Lesestelle in Zeichen des Textes, 0 ohne.
    public let anchor: Int

    /// Derselbe Text mit neuer Lesestelle, für Offline-Kopien.
    public func at(progress: Double, anchor: Int) -> ListenText {
        ListenText(id: id, title: title, text: text, sentences: sentences, progress: progress, anchor: anchor)
    }

    public init(id: String, title: String, text: String, sentences: [[Int]], progress: Double, anchor: Int) {
        self.id = id
        self.title = title
        self.text = text
        self.sentences = sentences
        self.progress = progress
        self.anchor = anchor
    }
}

/// Body für `POST /api/app/markierung`. `cid` macht das Senden idempotent. Codable, damit der Player ihn puffern kann.
public struct NewHighlight: Codable, Equatable, Sendable {
    public let id: String
    public let quote: String
    public let prefix: String?
    public let suffix: String?
    public let start: Int?
    public let cid: String?

    public init(id: String, quote: String, prefix: String? = nil, suffix: String? = nil, start: Int? = nil, cid: String? = nil) {
        self.id = id
        self.quote = quote
        self.prefix = prefix
        self.suffix = suffix
        self.start = start
        self.cid = cid
    }
}

public struct HighlightResult: Codable, Equatable, Sendable {
    public let id: String
    public let duplicate: Bool
    public let message: String
}

/// `POST /lesestapel/speichern`
public struct SavedDocument: Codable, Equatable, Sendable {
    public let id: String
    public let title: String?
    public let url: String
    public let kind: String
    public let duplicate: Bool
    /// Fertiger Satz für eine Mitteilung, z. B. „Im Lesestapel: …“.
    public let message: String
}

/// `POST /api/app/einloesen`
public struct Redemption: Decodable, Sendable {
    public let cookie: SessionCookie
    public let token: DeviceToken
}

public struct DeviceToken: Decodable, Equatable, Sendable {
    public let token: String
    public let id: String
    public let name: String
    public let scopes: [String]
}

/// Sitzungs-Cookie aus dem Login (dieselbe Sitzung wie im Browser). Die native App braucht es
/// nicht mehr; sie arbeitet mit dem Geräte-Token.
public struct SessionCookie: Decodable, Equatable, Sendable {
    public let name: String
    public let value: String
    /// Ohne Punkt davor: gilt nur für genau diesen Host.
    public let domain: String
    public let path: String
    public let expires: Date
    public let secure: Bool
    public let httpOnly: Bool
    /// `Lax` oder `Strict`.
    public let sameSite: String

    /// Mit allen Attributen; `nil`, wenn Foundation das Cookie ablehnt.
    public var httpCookie: HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [
            .name: name, .value: value, .domain: domain, .path: path, .expires: expires,
        ]
        if secure { properties[.secure] = "TRUE" }
        // Für HttpOnly gibt es keinen öffentlichen Schlüssel, Foundation liest diesen.
        if httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        #if !os(Linux)
        switch sameSite.lowercased() {
        case "lax": properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteLax
        case "strict": properties[.sameSitePolicy] = HTTPCookieStringPolicy.sameSiteStrict
        default: break
        }
        #endif
        return HTTPCookie(properties: properties)
    }
}
