import CockpitShared
import SwiftUI
import UniformTypeIdentifiers

/// „Abonnieren“ (`.lesen-save` oben auf der Seite): Adresse eines Feeds oder einer Website, der
/// Server sucht den Feed (`<link rel=alternate>`), optional gleich in eine Gruppe. Nach dem
/// Abonnieren leert sich das Feld; der neue Feed steht nach dem Neuladen in der Liste.
@MainActor
struct FeedsScreenSubscribe: View {
    let store: FeedsStore
    let toasts: ToastCenter

    @State private var url = ""
    /// Gruppen-ID, leer = ohne Gruppe.
    @State private var groupID = ""
    @FocusState private var focused: Bool

    private var busy: Bool { store.isBusy(.subscribe) }
    private var groups: [FeedGroup] { store.model?.groups ?? [] }
    private var canSubmit: Bool { !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "dot.radiowaves.up.forward")
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
                TextField("https://… Feed oder Website", text: $url)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit(submit)
                    .disabled(busy)
                    .accessibilityLabel("Adresse eines Feeds oder einer Website")
                if !url.isEmpty && !busy {
                    Button {
                        url = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Theme.text3)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Adresse leeren")
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                    .strokeBorder(focused ? Theme.accentLine : Theme.line)
            }
            HStack(spacing: 8) {
                if !groups.isEmpty {
                    Picker("Gruppe", selection: $groupID) {
                        Text("ohne Gruppe").tag("")
                        ForEach(groups) { group in
                            Text(group.name).tag(group.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(Theme.text2)
                    .accessibilityLabel("Gruppe")
                    Spacer(minLength: 0)
                }
                Button(action: submit) {
                    HStack(spacing: 8) {
                        if busy {
                            ProgressView()
                                .tint(Theme.onAccent)
                        }
                        Text(busy ? "Sucht den Feed …" : "Abonnieren")
                    }
                    .frame(maxWidth: groups.isEmpty ? .infinity : nil, minHeight: 36)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.roundedRectangle(radius: Theme.radius))
                .tint(Theme.accent)
                .disabled(!canSubmit)
            }
            Text("Neue Einträge landen von selbst im Eingang, beim ersten Abruf die letzten fünf.")
                .font(.footnote)
                .foregroundStyle(Theme.text3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .animation(.snappy, value: busy)
        .onChange(of: groups.map(\.id)) { _, ids in
            // Gelöschte Gruppe nicht weiter anbieten.
            if !groupID.isEmpty, !ids.contains(groupID) { groupID = "" }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        focused = false
        let address = url
        let group = groupID.isEmpty ? nil : groupID
        Task {
            if await store.subscribe(url: address, groupId: group), url == address {
                withAnimation(.snappy) { url = "" }
            }
        }
    }
}

/// Unten auf der Seite: „Gruppe anlegen“ und OPML (importieren: Ordner werden Gruppen;
/// exportieren: Datei `feeds.opml` ins Teilen-Blatt).
@MainActor
struct FeedsScreenTools: View {
    let store: FeedsStore
    let toasts: ToastCenter
    /// Exportierte Datei zum Teilen.
    let share: (URL) -> Void

    @State private var groupName = ""
    @State private var picking = false
    /// Die gewählte Datei wird gerade gelesen (vor dem Hochladen).
    @State private var reading = false
    @FocusState private var nameFocused: Bool

    /// Was beim Lesen der gewählten Datei herauskommt.
    enum PickedFile: Sendable {
        case data(Data, String)
        case tooLarge
        case unreadable
    }

    private var creating: Bool { store.isBusy(.createGroup) }
    private var importing: Bool { reading || store.isBusy(.importOPML) }
    private var exporting: Bool { store.isBusy(.exportOPML) }
    private var maxBytes: Int { store.limits?.maxOpmlBytes ?? 2 * 1024 * 1024 }

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 10) {
                heading("Gruppe anlegen")
                HStack(spacing: 8) {
                    TextField("Name der Gruppe", text: $groupName)
                        .submitLabel(.done)
                        .focused($nameFocused)
                        .onSubmit(createGroup)
                        .disabled(creating)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                                .strokeBorder(nameFocused ? Theme.accentLine : Theme.line)
                        }
                        .accessibilityLabel("Name der neuen Gruppe")
                    Button(action: createGroup) {
                        if creating {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Text("Anlegen")
                        }
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                    .disabled(creating || groupName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Text("Pausieren und „direkt auf den Stapel“ einer Gruppe gelten für alle ihre Feeds.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 10) {
                heading("OPML")
                HStack(spacing: 8) {
                    Button {
                        toasts.signal(.selection)
                        picking = true
                    } label: {
                        HStack(spacing: 8) {
                            if importing {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "square.and.arrow.down")
                                    .accessibilityHidden(true)
                            }
                            Text(importing ? "Importiert …" : "Importieren")
                        }
                    }
                    .disabled(importing)
                    Button(action: export) {
                        HStack(spacing: 8) {
                            if exporting {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "square.and.arrow.up")
                                    .accessibilityHidden(true)
                            }
                            Text("Exportieren")
                        }
                    }
                    .disabled(exporting || (store.model?.total ?? 0) == 0)
                    .accessibilityLabel("Als OPML exportieren")
                    .accessibilityHint("Teilt feeds.opml")
                }
                .buttonStyle(LesenQuietButtonStyle())
                Text("Import aus einem anderen Feed-Reader, höchstens \(maxBytes / 1024 / 1024) MB; Ordner werden zu Gruppen.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .animation(.snappy, value: importing)
        .fileImporter(isPresented: $picking, allowedContentTypes: Self.contentTypes) { result in
            importFile(result)
        }
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(.headline)
            .foregroundStyle(Theme.text)
            .accessibilityAddTraits(.isHeader)
    }

    // MARK: Gruppe

    private func createGroup() {
        let name = groupName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !creating else { return }
        nameFocused = false
        Task {
            if await store.createGroup(name: name), groupName.trimmingCharacters(in: .whitespacesAndNewlines) == name {
                withAnimation(.snappy) { groupName = "" }
            }
        }
    }

    // MARK: OPML

    /// `.opml` (ohne eigenen Typ im System über die Endung) und XML.
    static var contentTypes: [UTType] {
        var types: [UTType] = [.xml]
        if let opml = UTType(filenameExtension: "opml") { types.insert(opml, at: 0) }
        return types
    }

    private func export() {
        toasts.signal(.selection)
        Task {
            if let url = await store.exportOPML() { share(url) }
        }
    }

    private func importFile(_ result: Result<URL, Error>) {
        let url: URL
        switch result {
        case .success(let picked):
            url = picked
        case .failure(let error):
            toasts.signal(.error)
            toasts.error(error.localizedDescription)
            return
        }
        reading = true
        let limit = maxBytes
        Task {
            let picked = await Self.read(url, limit: limit)
            reading = false
            switch picked {
            case .data(let data, let name):
                await store.importOPML(data, filename: name)
            case .tooLarge:
                toasts.signal(.error)
                toasts.error("Die Datei ist zu groß (höchstens \(limit / 1024 / 1024) MB).")
            case .unreadable:
                toasts.signal(.error)
                toasts.error("Die Datei lässt sich nicht lesen.")
            }
        }
    }

    /// Liest die Datei abseits des Main Actors (mit Freigabe des Dokumenten-Pickers); zu große gar nicht erst.
    nonisolated static func read(_ url: URL, limit: Int) async -> PickedFile {
        await Task.detached(priority: .userInitiated) { () -> PickedFile in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > limit {
                return .tooLarge
            }
            guard let data = try? Data(contentsOf: url) else { return .unreadable }
            return data.count > limit ? .tooLarge : .data(data, url.lastPathComponent)
        }.value
    }
}
