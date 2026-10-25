import CockpitShared
import SafariServices
import SwiftUI
import UIKit

/// Wohin ein Link aus einem nativen Bildschirm führt (Notiz, Leseansicht, `redirect` einer
/// Aktion, Universal Link). Die App zeigt jede Seite des Cockpits nativ; es gibt keinen
/// WKWebView mehr.
enum NavigationDecision: Equatable {
    /// Woche, Rückblick, Planen: Reiter „Woche“ bzw. „Rückblick“.
    case native(NativeRoute)
    /// Eingang, Stapel, Leseansicht, Folgen, Markiert, Wiedersehen, Hinzufügen, Hören.
    case reading(ReadingRoute)
    /// Notiz, Graph, Suche, Wissen, Zustand, Einstellungen, Feeds.
    case page(PageRoute)
    /// Eigene Adresse ohne nativen Bildschirm (z. B. `/static/…`): `SFSafariViewController`.
    case browser(URL)
    /// Anderer Host: `SFSafariViewController`.
    case external(URL)
    /// `mailto:`, `tel:`, `obsidian://` usw.: an das System.
    case system(URL)

    static func decide(_ url: URL, server: URL) -> NavigationDecision {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return .system(url) }
        guard url.host()?.lowercased() == server.host()?.lowercased(), url.port == server.port else { return .external(url) }
        if let route = NativeRoute(url: url) { return .native(route) }
        if let route = ReadingRoute(url: url) { return .reading(route) }
        if let route = PageRoute(url: url) { return .page(route) }
        return .browser(url)
    }

    /// Eigener Pfad mit Query (`redirect`, `href` aus JSON, `next`); nil für fremde Pfade (`//host`).
    static func decide(path: String, server: URL) -> NavigationDecision? {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        if let route = NativeRoute(webPath: path) { return .native(route) }
        if let route = ReadingRoute(webPath: path) { return .reading(route) }
        if let route = PageRoute(webPath: path) { return .page(route) }
        return URL(string: path, relativeTo: server).map { .browser($0.absoluteURL) }
    }
}

/// Links nach außen aus den nativen Bildschirmen: Zunder & Co. im `SFSafariViewController`,
/// `obsidian://` und Ähnliches an das System.
enum ExternalLink {
    @MainActor
    static func open(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            system(url)
            return
        }
        present(url)
    }

    /// http(s) im `SFSafariViewController` über dem obersten Blatt.
    @MainActor
    static func present(_ url: URL) {
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
        guard var presenter = window?.rootViewController else {
            UIApplication.shared.open(url)
            return
        }
        while let next = presenter.presentedViewController, !next.isBeingDismissed { presenter = next }
        let safari = SFSafariViewController(url: url)
        safari.preferredControlTintColor = .cockpitAccent
        presenter.present(safari, animated: true)
    }

    @MainActor
    static func system(_ url: URL) {
        UIApplication.shared.open(url)
    }
}

/// Teilen-Blatt des Systems für eine Datei (Sicherung, Kurzbefehl, OPML), z. B. als
/// `.sheet(item:)` mit `ShareFileItem`.
struct ShareFileSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Datei für das Teilen-Blatt (`sheet(item:)`).
struct ShareFileItem: Identifiable, Equatable {
    let url: URL
    var id: URL { url }
}
