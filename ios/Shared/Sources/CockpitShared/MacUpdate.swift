import Foundation

/// Version `X.Y.Z` der App (`CFBundleShortVersionString`), vergleichbar. `1.0` gilt als `1.0.0`.
public struct AppVersion: Comparable, Hashable, Sendable, CustomStringConvertible {
    public let major: Int
    public let minor: Int
    public let patch: Int

    public init(major: Int, minor: Int, patch: Int) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    public init?(_ string: String) {
        let parts = string.trimmingCharacters(in: .whitespaces).split(separator: ".", omittingEmptySubsequences: false)
        guard (2...3).contains(parts.count) else { return nil }
        let numbers = parts.compactMap { part in part.allSatisfy(\.isASCII) ? Int(part) : nil }
        guard numbers.count == parts.count, numbers.allSatisfy({ $0 >= 0 }) else { return nil }
        self.init(major: numbers[0], minor: numbers[1], patch: numbers.count == 3 ? numbers[2] : 0)
    }

    public var description: String { "\(major).\(minor).\(patch)" }

    public static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }
}

/// Release auf GitHub (`GET /repos/…/releases`), nur was das Update braucht.
public struct GitHubRelease: Decodable, Sendable {
    public struct Asset: Decodable, Sendable {
        public let name: String
        public let browserDownloadURL: URL
        public let size: Int
        /// `sha256:…`, seit 2025 bei neuen Uploads gesetzt.
        public let digest: String?

        enum CodingKeys: String, CodingKey {
            case name, size, digest
            case browserDownloadURL = "browser_download_url"
        }
    }

    public let tagName: String
    public let name: String?
    public let body: String?
    public let htmlURL: URL
    public let draft: Bool
    public let prerelease: Bool
    public let assets: [Asset]

    enum CodingKeys: String, CodingKey {
        case name, body, draft, prerelease, assets
        case tagName = "tag_name"
        case htmlURL = "html_url"
    }
}

/// Neue Version der macOS-App im Direktvertrieb (Release `mac/vX.Y.Z`, siehe ios/scripts/mac-release.js).
public struct MacUpdate: Equatable, Sendable, Identifiable {
    public let version: AppVersion
    /// Release-Notizen (Markdown).
    public let notes: String
    /// Seite des Releases auf GitHub.
    public let pageURL: URL
    /// `Cockpit-mac.zip`: die geheftete App, die `MacUpdater` einspielt.
    public let archiveURL: URL
    public let archiveSize: Int
    /// SHA-256 des Archivs (hex, klein), falls GitHub ihn kennt.
    public let archiveSHA256: String?
    /// `Cockpit-X.Y.Z.dmg` zum Installieren von Hand.
    public let diskImageURL: URL?

    public var id: AppVersion { version }
}

/// Sucht unter den Releases auf GitHub die neueste macOS-Version.
public enum MacUpdateFeed {
    /// Öffentliches Repo: kein Token nötig (ohne Anmeldung 60 Abfragen pro Stunde und Adresse).
    public static let releasesURL = URL(string: "https://api.github.com/repos/rubenvitt/vault-cockpit/releases?per_page=30")!
    public static let tagPrefix = "mac/v"
    public static let archiveName = "Cockpit-mac.zip"

    /// Neuestes Release `mac/v…` über `current`, nicht Entwurf, nicht Vorabversion, mit Archiv; sonst nil.
    public static func newest(in releases: [GitHubRelease], newerThan current: AppVersion) -> MacUpdate? {
        let candidates = releases.compactMap { release -> MacUpdate? in
            guard !release.draft, !release.prerelease, release.tagName.hasPrefix(tagPrefix),
                  let version = AppVersion(String(release.tagName.dropFirst(tagPrefix.count))),
                  version > current,
                  let archive = release.assets.first(where: { $0.name == archiveName })
            else { return nil }
            let image = release.assets.first { $0.name.hasSuffix(".dmg") }
            return MacUpdate(
                version: version,
                notes: release.body ?? "",
                pageURL: release.htmlURL,
                archiveURL: archive.browserDownloadURL,
                archiveSize: archive.size,
                archiveSHA256: sha256(archive.digest),
                diskImageURL: image?.browserDownloadURL
            )
        }
        return candidates.max { $0.version < $1.version }
    }

    public static func newest(in data: Data, newerThan current: AppVersion) throws -> MacUpdate? {
        try newest(in: JSONDecoder().decode([GitHubRelease].self, from: data), newerThan: current)
    }

    /// `sha256:ABC…` → `abc…`; nil für andere Verfahren oder ohne Digest.
    static func sha256(_ digest: String?) -> String? {
        guard let digest, digest.hasPrefix("sha256:") else { return nil }
        let hex = digest.dropFirst("sha256:".count).lowercased()
        return hex.count == 64 && hex.allSatisfy(\.isHexDigit) ? hex : nil
    }

    /// Release-Notizen für die Anzeige in der App: ohne den Teil ab `---` (Installationshinweis
    /// fürs Release auf GitHub), Überschriften `###` als einfache Zeilen.
    public static func displayNotes(_ notes: String) -> String {
        var lines: [String] = []
        for line in notes.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            if line.trimmingCharacters(in: .whitespaces) == "---" { break }
            if line.hasPrefix("#") {
                lines.append(line.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces) + ":")
            } else {
                lines.append(String(line))
            }
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
