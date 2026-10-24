import SafariServices
import SwiftUI
import UIKit

/// Links aus den nativen Bildschirmen: Zunder & Co. im `SFSafariViewController` wie in der
/// Web-Hülle, `obsidian://` und Ähnliches an das System.
enum ExternalLink {
    @MainActor
    static func open(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            UIApplication.shared.open(url)
            return
        }
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
}

/// Web-Seite als Blatt (Notiz, Suche), bis sie nativ ist. Links auf native Seiten schließen das
/// Blatt und wechseln den Reiter (`AppModel.open(_:)`).
@MainActor
struct WebSheet: View {
    let model: AppModel
    let page: AppModel.WebPage
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WebShell(model: model, startPath: page.path)
                .ignoresSafeArea(.container, edges: .bottom)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Fertig") { dismiss() }
                    }
                }
        }
    }
}
