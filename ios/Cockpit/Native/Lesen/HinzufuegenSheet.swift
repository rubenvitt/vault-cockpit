import CockpitShared
import SwiftUI
import UniformTypeIdentifiers

/// „Hinzufügen“ (`/lesen/hinzufuegen` im Web) als Blatt: Adresse speichern oder ein PDF
/// hochladen (höchstens 20 MB, nur der Text wird gespeichert). Danach „Jetzt lesen“.
@MainActor
struct HinzufuegenSheet: View {
    let model: AppModel
    let store: InboxStore
    let toasts: ToastCenter

    @Environment(\.dismiss) private var dismiss
    @State private var picking = false
    /// Die gewählte Datei wird gerade gelesen (vor dem Hochladen).
    @State private var reading = false
    @State private var fileName: String?
    /// Zuletzt gespeichert (Adresse oder PDF).
    @State private var saved: ReadingActionDoc?

    /// Was beim Lesen der gewählten Datei herauskommt.
    enum PickedFile: Sendable {
        case data(Data)
        case tooLarge
        case unreadable
    }

    private var busy: Bool { reading || store.isUploading }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 10) {
                        heading("Adresse")
                        EingangSaveForm(store: store) { doc in
                            withAnimation(.snappy) { saved = doc }
                        }
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        heading("PDF")
                        Button {
                            toasts.signal(.selection)
                            picking = true
                        } label: {
                            HStack(spacing: 10) {
                                if busy {
                                    ProgressView()
                                        .tint(Theme.onAccent)
                                } else {
                                    Image(systemName: "doc.badge.plus")
                                        .accessibilityHidden(true)
                                }
                                Text(busy ? "Lädt hoch …" : "PDF auswählen")
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.roundedRectangle(radius: Theme.radius))
                        .tint(Theme.accent)
                        .disabled(busy)
                        if let fileName, busy {
                            Text(fileName)
                                .font(.footnote)
                                .foregroundStyle(Theme.text2)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Text("Höchstens 20 MB. Gespeichert wird der Text, nicht die Datei; gescannte PDFs ohne Text gehen nicht.")
                            .font(.footnote)
                            .foregroundStyle(Theme.text3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let saved {
                        savedCard(saved)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle("Hinzufügen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .fileImporter(isPresented: $picking, allowedContentTypes: [.pdf]) { result in
                upload(result)
            }
            .toasts(toasts)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(.headline)
            .foregroundStyle(Theme.text)
            .accessibilityAddTraits(.isHeader)
    }

    /// „Neu im Blog“ · Liegt im Eingang · „Jetzt lesen“
    private func savedCard(_ doc: ReadingActionDoc) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title3)
                .foregroundStyle(Theme.ok)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(doc.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Gespeichert")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                if let status = doc.status {
                    Text(Self.place(status))
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
            }
            Spacer(minLength: 8)
            Button("Jetzt lesen") {
                toasts.signal(.selection)
                model.showsAdd = false
                model.open(reading: .reader(id: doc.id, highlight: nil, resume: false))
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(Theme.accent)
        }
        .cardStyle(padding: 14)
        .accessibilityElement(children: .combine)
    }

    /// Wo das Gespeicherte jetzt liegt.
    static func place(_ status: ReadingStatus) -> String {
        switch status {
        case .inbox: "Liegt im Eingang"
        case .stack: "Liegt auf dem Stapel"
        default: "Liegt unter \(status.label)"
        }
    }

    // MARK: PDF

    private func upload(_ result: Result<URL, Error>) {
        let url: URL
        switch result {
        case .success(let picked):
            url = picked
        case .failure(let error):
            // Abbrechen im Dateiauswahl-Blatt kommt nicht hier an, nur echte Fehler.
            toasts.signal(.error)
            toasts.error(error.localizedDescription)
            return
        }
        let name = url.lastPathComponent
        fileName = name
        reading = true
        Task {
            let picked = await Self.read(url)
            reading = false
            switch picked {
            case .data(let data):
                if let doc = await store.uploadPDF(data, filename: name) {
                    withAnimation(.snappy) { saved = doc }
                }
            case .tooLarge:
                toasts.signal(.error)
                toasts.error("Die Datei ist zu groß (höchstens 20 MB).")
            case .unreadable:
                toasts.signal(.error)
                toasts.error("Die Datei lässt sich nicht öffnen.")
            }
        }
    }

    /// Liest die Datei abseits des Main Actors; zu große gar nicht erst.
    nonisolated static func read(_ url: URL) async -> PickedFile {
        await Task.detached(priority: .userInitiated) { () -> PickedFile in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > InboxStore.maxPDFBytes {
                return .tooLarge
            }
            guard let data = try? Data(contentsOf: url) else { return .unreadable }
            return data.count > InboxStore.maxPDFBytes ? .tooLarge : .data(data)
        }.value
    }
}
