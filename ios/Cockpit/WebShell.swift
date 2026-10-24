import SafariServices
import SwiftUI
import WebKit

/// Was die Web-Hülle mit einer Navigation macht.
enum NavigationDecision: Equatable {
    case allow
    /// Sitzung abgelaufen: nativer Login, danach weiter auf `next`.
    case login(next: String)
    /// „Abmelden“ im Cockpit: geht zum Server durch, danach nativ abmelden (Token widerrufen,
    /// Cookies, Website-Daten, Keychain).
    case logout
    /// Anderer Host: `SFSafariViewController`.
    case external(URL)
    /// `mailto:`, `tel:` usw.: an das System.
    case system(URL)

    static func decide(_ url: URL, method: String, server: URL, isMainFrame: Bool) -> NavigationDecision {
        guard let scheme = url.scheme?.lowercased() else { return .allow }
        if ["about", "blob", "data"].contains(scheme) { return .allow }
        guard scheme == "http" || scheme == "https" else { return .system(url) }
        guard url.host() == server.host(), url.port == server.port else { return isMainFrame ? .external(url) : .allow }
        switch url.path() {
        case "/login":
            let next = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "next" }?.value
            // Nur eigene Pfade, wie safeNext im Server.
            return .login(next: next.flatMap { $0.hasPrefix("/") && !$0.hasPrefix("//") ? $0 : nil } ?? "/")
        case "/logout" where method == "POST":
            return .logout
        default:
            return .allow
        }
    }
}

/// Nachricht der Seite über `window.webkit.messageHandlers.cockpit.postMessage(…)`.
enum BridgeMessage: Equatable {
    /// `/lesen/hoeren`: `{type: 'hoeren', zeit}`
    case listen(minutes: Int)
    /// `/lesen/folgen`: `{type: 'folge', id, titel, art, dauer, groesse}`, fertige Folge im nativen Player.
    /// `seconds` und `bytes` laut Server, 0 = unbekannt.
    case episode(id: String, title: String, kind: String, seconds: Double, bytes: Int)
    /// Jede Seite (`/static/ui.js`): `{type: 'haptik', art}` beim Wechsel des Reiters, Abhaken usw.
    case haptic(Haptic)

    enum Haptic: String {
        case selection = "auswahl"
        case light = "leicht"
        case success = "erfolg"
        case error = "fehler"
    }

    init?(_ body: Any) {
        guard let body = body as? [String: Any] else { return nil }
        switch body["type"] as? String {
        case "hoeren":
            self = .listen(minutes: (body["zeit"] as? NSNumber)?.intValue ?? 15)
        case "folge":
            guard let id = body["id"] as? String, !id.isEmpty else { return nil }
            self = .episode(
                id: id,
                title: body["titel"] as? String ?? "Folge",
                kind: body["art"] as? String ?? "Folge",
                seconds: (body["dauer"] as? NSNumber)?.doubleValue ?? 0,
                bytes: (body["groesse"] as? NSNumber)?.intValue ?? 0
            )
        case "haptik":
            guard let haptic = (body["art"] as? String).flatMap(Haptic.init(rawValue:)) else { return nil }
            self = .haptic(haptic)
        default:
            return nil
        }
    }
}

struct WebShell: UIViewControllerRepresentable {
    let model: AppModel

    func makeUIViewController(context: Context) -> WebViewController {
        WebViewController(model: model)
    }

    func updateUIViewController(_ controller: WebViewController, context: Context) {}
}

/// Das Cockpit im WKWebView: randlos, Ziehen zum Neuladen, Zurück-Geste, Downloads ins Teilen-Blatt.
/// Datei-Upload (`<input type=file>`) zeigt WebKit selbst an.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private let model: AppModel
    private var webView: WKWebView!
    private var downloads: [ObjectIdentifier: URL] = [:]
    /// `POST /logout` läuft; die Weiterleitung auf `/login` danach meldet nativ ab statt neu an.
    private var loggingOut = false

    init(model: AppModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // App-Bound Domains (WKAppBoundDomains in der Info.plist): Nur so laufen Service Worker (sw.js,
        // Offline-Lesen) in einem WKWebView einer App.
        configuration.limitsNavigationsToAppBoundDomains = true
        configuration.allowsInlineMediaPlayback = true
        // WKUserContentController hält seine Handler stark; der Umweg vermeidet den Kreis.
        configuration.userContentController.add(WeakMessageHandler(self), name: "cockpit")

        webView = WKWebView(frame: .zero, configuration: configuration)
        // Bis die erste Seite malt: der Hintergrund des Cockpits (`--bg`) statt Weiß, auch im Dunkelmodus.
        webView.isOpaque = false
        webView.backgroundColor = .cockpitBackground
        webView.scrollView.backgroundColor = .cockpitBackground
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        // Die Seite nutzt viewport-fit=cover und env(safe-area-inset-*) selbst.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self] _ in self?.webView.reload() }, for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        // Natives Menü (Abmelden): mit zwei Fingern lange drücken.
        let press = UILongPressGestureRecognizer(target: self, action: #selector(showMenu(_:)))
        press.numberOfTouchesRequired = 2
        webView.addGestureRecognizer(press)

        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.load(URLRequest(url: model.startURL))
    }

    @objc private func showMenu(_ press: UILongPressGestureRecognizer) {
        if press.state == .began { model.showsMenu = true }
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if action.shouldPerformDownload { return .download }
        let isMainFrame = action.targetFrame?.isMainFrame ?? true
        switch NavigationDecision.decide(url, method: action.request.httpMethod ?? "GET", server: model.config.serverURL, isMainFrame: isMainFrame) {
        case .allow:
            // target=_blank auf eigene Seiten: im selben WKWebView öffnen.
            if action.targetFrame == nil {
                webView.load(action.request)
                return .cancel
            }
            return .allow
        case .login(let next):
            if loggingOut {
                loggingOut = false
                await model.logout()
            } else {
                model.sessionExpired(next: next)
            }
        case .logout:
            loggingOut = true
            return .allow
        case .external(let url):
            present(SFSafariViewController(url: url), animated: true)
        case .system(let url):
            await UIApplication.shared.open(url)
        }
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        // Am Header entscheiden: text/markdown (Wochenexport) könnte WebKit auch anzeigen.
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        return disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        // Ohne Netz erreicht `POST /logout` den Server nicht; lokal trotzdem abmelden.
        if loggingOut {
            loggingOut = false
            Task { await model.logout() }
        }
    }

    // MARK: JavaScript-Dialoge
    // Ohne diese Methoden gelten confirm() und prompt() als abgebrochen: keine Notiz in der
    // Leseansicht (lesen-doc.js), kein „Verwerfen“ im Offline-Puffer (offline.js).

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        _ = await panel(message, cancellable: false)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await panel(message) != nil
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        await panel(prompt, text: defaultText ?? "")
    }

    /// Dialog mit „OK“ und „Abbrechen“: bei OK der Text des Feldes ("" ohne Feld), bei Abbrechen nil.
    private func panel(_ message: String, text: String? = nil, cancellable: Bool = true) async -> String? {
        // WebKit wartet auf eine Antwort: Ohne Fenster lässt sich nichts zeigen, also gleich abbrechen.
        guard viewIfLoaded?.window != nil else { return nil }
        var presenter: UIViewController = self
        while let next = presenter.presentedViewController { presenter = next }
        guard !presenter.isBeingDismissed else { return nil }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            if let text { alert.addTextField { $0.text = text } }
            if cancellable { alert.addAction(UIAlertAction(title: "Abbrechen", style: .cancel) { _ in continuation.resume(returning: nil) }) }
            alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
                continuation.resume(returning: alert?.textFields?.first?.text ?? "")
            })
            presenter.present(alert, animated: true)
        }
    }

    // MARK: Downloads (OPML, Wochenexport)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: suggestedFilename)
        downloads[ObjectIdentifier(download)] = file
        return file
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        let alert = UIAlertController(title: "Download fehlgeschlagen", message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    // MARK: Brücke

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Nur das Cockpit selbst darf die App ansprechen.
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == model.config.serverURL.host() else { return }
        switch BridgeMessage(message.body) {
        case .listen(let minutes): model.listening = AppModel.ListenRequest(minutes: minutes)
        case .episode(let id, let title, let kind, let seconds, let bytes):
            model.episode = AppModel.EpisodeRequest(episodeID: id, title: title, kind: kind, seconds: seconds, bytes: bytes)
        case .haptic(let haptic): feedback(haptic)
        case nil: break
        }
    }

    private func feedback(_ haptic: BridgeMessage.Haptic) {
        switch haptic {
        case .selection: UISelectionFeedbackGenerator().selectionChanged()
        case .light: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

private extension UIColor {
    /// `--bg` aus cockpit.css (`THEME` in layout.js).
    static var cockpitBackground: UIColor {
        UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x14 / 255, green: 0x13 / 255, blue: 0x11 / 255, alpha: 1)
                : UIColor(red: 0xF7 / 255, green: 0xF5 / 255, blue: 0xF1 / 255, alpha: 1)
        }
    }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
