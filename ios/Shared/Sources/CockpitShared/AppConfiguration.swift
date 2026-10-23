import Foundation

/// Werte, die beim Bauen in die Info.plist geschrieben werden (siehe ios/project.yml).
/// Jedes Target (App, Extension) braucht dieselben Schlüssel in seiner eigenen Info.plist.
public struct AppConfiguration: Sendable {
    public let serverURL: URL
    /// Mit Team-Präfix; ohne Signieren (Simulator-CI) fehlt das Präfix.
    public let keychainGroup: String
    public let appGroup: String

    public init(info: [String: Any]? = Bundle.main.infoDictionary) {
        guard let raw = info?["CockpitServerURL"] as? String,
              let url = URL(string: raw), url.scheme != nil, url.host != nil
        else {
            preconditionFailure("CockpitServerURL fehlt oder ist keine gültige URL")
        }
        serverURL = url
        keychainGroup = info?["CockpitKeychainGroup"] as? String ?? ""
        appGroup = info?["CockpitAppGroup"] as? String ?? ""
    }
}
