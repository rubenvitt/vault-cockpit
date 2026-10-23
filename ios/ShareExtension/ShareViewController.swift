import CockpitShared
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Einstieg der Share Extension „Zum Lesestapel“ (NSExtensionPrincipalClass, ohne Storyboard).
final class ShareViewController: UIViewController {
    private lazy var model = ShareModel(context: extensionContext)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let host = UIHostingController(rootView: ShareView(model: model))
        host.view.backgroundColor = .clear
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.start() }
    }
}

@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case saving
        case done(String)
        /// `keep`: der Eintrag bleibt im Puffer, die App sendet ihn nach.
        case failed(String, keep: Bool)
    }

    /// Höchstgröße für PDF laut Server (`MAX_PDF`).
    nonisolated static let maxPDFSize = 20 * 1024 * 1024

    var phase = Phase.saving
    private let context: NSExtensionContext?
    private let config = AppConfiguration()
    private let pending: PendingShares
    private var share: PendingShare?
    /// Ohne erkannten Inhalt gibt es nichts zu wiederholen.
    var canRetry: Bool { share != nil }

    init(context: NSExtensionContext?) {
        self.context = context
        // Ohne App Group (Simulator ohne Signieren) puffert die Extension nur für „Erneut versuchen“.
        pending = PendingShares(appGroup: config.appGroup)
            ?? PendingShares(directory: FileManager.default.temporaryDirectory.appending(path: "PendingShares"))
    }

    func start() async {
        do {
            share = try await bufferSharedItem()
            await send()
        } catch {
            phase = .failed(error.localizedDescription, keep: false)
        }
    }

    func send() async {
        guard let share else { return }
        phase = .saving
        guard let token = (try? KeychainStore(accessGroup: config.keychainGroup).token()) ?? nil else {
            phase = .failed("Bitte zuerst in der Cockpit-App anmelden. Danach wird es nachgesendet.", keep: true)
            return
        }
        do {
            let saved = try await pending.send(share, using: APIClient(baseURL: config.serverURL, token: token))
            pending.remove(share)
            phase = .done(saved.duplicate ? "Schon im Lesestapel" : "Im Eingang: \(saved.title ?? saved.url)")
            try? await Task.sleep(for: .seconds(1.5))
            close()
        } catch let error as APIError where error.isUnauthorized {
            phase = .failed("Anmeldung abgelaufen. Bitte in der Cockpit-App neu anmelden, dann wird es nachgesendet.", keep: true)
        } catch is URLError {
            phase = .failed("Kein Netz. Die Cockpit-App sendet es nach, sobald sie wieder online ist.", keep: true)
        } catch {
            phase = .failed(error.localizedDescription, keep: PendingShares.isTemporary(error))
        }
    }

    func close() {
        if case .failed(_, keep: false) = phase, let share { pending.remove(share) }
        context?.completeRequest(returningItems: nil)
    }

    /// Liest die Anhänge, erkennt den Inhalt und legt die Anfrage in den Puffer.
    private func bufferSharedItem() async throws -> PendingShare {
        let providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var urls: [URL] = []
        var texts: [String] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                urls.append(url)
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
               let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                texts.append(text)
            }
        }
        let pdfProvider = providers.first { $0.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) }
        switch SharedContent.detect(urls: urls, texts: texts, hasPDF: pdfProvider != nil) {
        case let .link(url, title):
            let share = PendingShare(url: url, title: title)
            try pending.add(share)
            return share
        case let .pdf(title):
            let share = PendingShare(url: nil, title: title)
            try await copyPDF(from: pdfProvider!, into: share)
            return share
        case nil:
            throw ShareError("Hier ist kein Link und keine PDF-Datei zum Speichern.")
        }
    }

    /// Die Datei aus `loadFileRepresentation` gilt nur im Callback: dort in den Puffer kopieren.
    private func copyPDF(from provider: NSItemProvider, into share: PendingShare) async throws {
        let pending = pending
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.pdf.identifier) { file, error in
                continuation.resume(with: Result {
                    guard let file else { throw error ?? ShareError("Die PDF-Datei ließ sich nicht lesen.") }
                    let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= Self.maxPDFSize else { throw ShareError("Die PDF-Datei ist größer als 20 MB.") }
                    try pending.add(share, pdf: file)
                })
            }
        }
    }
}

struct ShareError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct ShareView: View {
    let model: ShareModel

    var body: some View {
        VStack(spacing: 16) {
            switch model.phase {
            case .saving:
                ProgressView()
                Text("Wird gespeichert …")
            case let .done(message):
                Image(systemName: "checkmark.circle.fill")
                    .font(.largeTitle)
                    .foregroundStyle(.green)
                    .accessibilityHidden(true)
                Text(message)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            case let .failed(message, _):
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.largeTitle)
                    .foregroundStyle(.orange)
                    .accessibilityHidden(true)
                Text(message)
                    .multilineTextAlignment(.center)
                HStack {
                    Button("Schließen") { model.close() }
                        .buttonStyle(.bordered)
                    if model.canRetry {
                        Button("Erneut versuchen") { Task { await model.send() } }
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
        .padding(24)
        .frame(maxWidth: 340)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.default, value: model.phase)
    }
}
