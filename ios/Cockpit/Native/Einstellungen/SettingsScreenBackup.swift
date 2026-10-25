import CockpitShared
import SwiftUI
import UniformTypeIdentifiers

/// Sicherung (`#sicherung` im Web): welche Dateien dazugehören (vorhanden oder nicht), „Sicherung
/// erstellen“ mit Passphrase und Wiederholung (die verschlüsselte Datei geht ins Teilen-Blatt,
/// z. B. „In Dateien sichern“) und „Wiederherstellen“ aus einer Datei mit Passphrase und
/// „Vorhandenes ersetzen“. Danach startet das Cockpit neu.
@MainActor
struct SettingsBackupView: View {
    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var passphrase = ""
    @State private var repeated = ""
    @State private var restorePassphrase = ""
    @State private var replace = false
    @State private var picked: SettingsPickedBackup?
    @State private var importing = false
    @State private var confirmsRestore = false
    @State private var share: ShareFileItem?
    /// Zuletzt lief „Wiederherstellen“ (nicht „Erstellen“): dorthin gehört ein Fehler bei `passphrase`.
    @State private var lastWasRestore = false

    private var store: BackupStore { session.backup }
    private var status: BackupStatus? { store.model ?? session.settings.model?.backup }

    var body: some View {
        Form {
            if let status {
                Section {
                    SettingsIntro(text: status.intro, state: nil)
                }
                filesSection(status)
                createSection(status)
                restoreSection(status)
            } else if let error = store.state.error, !store.state.isRefreshing {
                Section {
                    Text(error.message)
                        .foregroundStyle(Theme.danger)
                    Button("Erneut versuchen") { Task { await store.refresh() } }
                }
            } else {
                Section {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                }
            }
            if let restored = store.restored {
                restoredSection(restored)
                    .transition(.opacity)
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.refresh() }
        .animation(reduceMotion ? nil : .snappy, value: store.restored)
        .task {
            if store.model == nil { await store.load() } else { await store.refresh() }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            pick(result)
        }
        .sheet(item: $share) { item in
            ShareFileSheet(items: [item.url])
                .presentationDetents([.medium, .large])
        }
        .confirmationDialog("Sicherung wiederherstellen?", isPresented: $confirmsRestore, titleVisibility: .visible) {
            Button("Wiederherstellen", role: .destructive) { restore() }
        } message: {
            Text(status?.restore ?? "")
        }
    }

    // MARK: Dateien

    private func filesSection(_ status: BackupStatus) -> some View {
        Section {
            ForEach(status.files) { file in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Image(systemName: file.present ? "checkmark.circle.fill" : "circle.dashed")
                        .foregroundStyle(file.present ? Theme.ok : Theme.text3)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(file.label)
                            .font(.subheadline)
                            .foregroundStyle(Theme.text)
                        Text(file.name)
                            .font(.caption.monospaced())
                            .foregroundStyle(Theme.text3)
                    }
                    Spacer(minLength: 8)
                    Text(file.present ? "vorhanden" : "fehlt")
                        .font(.caption)
                        .foregroundStyle(file.present ? Theme.ok : Theme.text3)
                }
                .accessibilityElement(children: .combine)
            }
        } header: {
            Text("Inhalt")
        }
    }

    // MARK: Erstellen

    private func createSection(_ status: BackupStatus) -> some View {
        Section {
            passphraseField("Passphrase", text: $passphrase, error: lastWasRestore ? nil : store.fieldErrors["passphrase"])
            passphraseField("Passphrase wiederholen", text: $repeated, error: store.fieldErrors["passphrase2"])
            Button(action: create) {
                HStack {
                    Spacer()
                    if store.isCreating {
                        ProgressView()
                    } else {
                        Label("Sicherung erstellen", systemImage: "lock.doc")
                            .font(.body.weight(.semibold))
                    }
                    Spacer()
                }
            }
            .disabled(store.isCreating || passphrase.isEmpty || repeated.isEmpty)
            if let file = store.file {
                ShareLink(item: file) {
                    Label("Letzte Sicherung teilen: \(file.lastPathComponent)", systemImage: "square.and.arrow.up")
                        .font(.footnote)
                }
                .tint(Theme.accent)
            }
        } header: {
            Text("Sicherung erstellen")
        } footer: {
            Text("Mindestens \(status.minPassphrase) Zeichen. Ohne die Passphrase lässt sich die Sicherung nicht öffnen, auch nicht vom Cockpit.")
        }
    }

    private func create() {
        session.toasts.signal(.selection)
        lastWasRestore = false
        Task {
            if let url = await store.create(passphrase: passphrase, repeat: repeated) {
                passphrase = ""
                repeated = ""
                share = ShareFileItem(url: url)
            }
        }
    }

    // MARK: Wiederherstellen

    private func restoreSection(_ status: BackupStatus) -> some View {
        Section {
            Button {
                importing = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: picked == nil ? "doc.badge.plus" : "doc.fill")
                        .foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(picked?.filename ?? "Sicherung auswählen (.json)")
                            .foregroundStyle(picked == nil ? Theme.accent : Theme.text)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let picked {
                            Text(ByteCountFormatter.string(fromByteCount: Int64(picked.data.count), countStyle: .file))
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                    }
                }
            }
            .accessibilityLabel(picked.map { "Datei: \($0.filename)" } ?? "Sicherung auswählen")
            if let error = store.fieldErrors["datei"] {
                fieldError(error)
            }
            passphraseField("Passphrase der Sicherung", text: $restorePassphrase, error: lastWasRestore ? store.fieldErrors["passphrase"] : nil)
            if status.needsReplace {
                Toggle(isOn: $replace) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Vorhandenes ersetzen")
                        Text("Nötig, weil das Cockpit schon eingerichtet ist.")
                            .font(.caption)
                            .foregroundStyle(Theme.text3)
                    }
                }
                .tint(Theme.danger)
            }
            Button(role: .destructive) {
                confirmsRestore = true
            } label: {
                HStack {
                    Spacer()
                    if store.isRestoring {
                        ProgressView()
                    } else {
                        Label("Wiederherstellen", systemImage: "arrow.counterclockwise")
                            .font(.body.weight(.semibold))
                    }
                    Spacer()
                }
            }
            .disabled(store.isRestoring || picked == nil || restorePassphrase.isEmpty || (status.needsReplace && !replace))
        } header: {
            Text("Wiederherstellen")
        } footer: {
            Text(status.restore)
        }
    }

    private func pick(_ result: Result<URL, Error>) {
        switch result {
        case .success(let url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                picked = SettingsPickedBackup(filename: url.lastPathComponent, data: data)
                session.toasts.signal(.selection)
            } catch {
                session.toasts.signal(.error)
                session.toasts.error("Die Datei lässt sich nicht lesen.")
            }
        case .failure(let error):
            session.toasts.error(error.localizedDescription)
        }
    }

    private func restore() {
        guard let picked, let status else { return }
        lastWasRestore = true
        Task {
            if await store.restore(data: picked.data, filename: picked.filename, passphrase: restorePassphrase, replace: status.needsReplace ? replace : false) != nil {
                restorePassphrase = ""
                replace = false
                self.picked = nil
            }
        }
    }

    private func restoredSection(_ result: BackupRestoreResult) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label(result.title, systemImage: "checkmark.seal.fill")
                    .font(.headline)
                    .foregroundStyle(Theme.ok)
                if !result.message.isEmpty {
                    Text(result.message)
                        .font(.subheadline)
                }
                if !result.files.isEmpty {
                    Text("Zurückgeschrieben: \(result.files.joined(separator: ", "))")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
                if !result.skipped.isEmpty {
                    Text("Übersprungen: \(result.skipped.joined(separator: ", "))")
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
                if result.restart {
                    Text("Das Cockpit startet jetzt neu; in ein paar Sekunden ist es wieder da.")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
                if result.relogin {
                    Text("Das Sitzungs-Secret kam mit zurück: Im Browser meldest du dich neu an.")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
                if result.tokensReplaced {
                    Text("Die API-Tokens kamen mit zurück: Stand der Token dieser App nicht in der Sicherung, meldet sie sich nach dem Neustart neu an.")
                        .font(.footnote)
                        .foregroundStyle(Theme.warn)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: Felder

    private func passphraseField(_ label: String, text: Binding<String>, error: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SecureField(label, text: text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if let error {
                fieldError(error)
            }
        }
    }

    private func fieldError(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(.caption)
            .foregroundStyle(Theme.danger)
    }
}

/// Gewählte Sicherung (Inhalt schon gelesen, solange der Zugriff freigegeben war).
struct SettingsPickedBackup: Equatable {
    let filename: String
    let data: Data
}
