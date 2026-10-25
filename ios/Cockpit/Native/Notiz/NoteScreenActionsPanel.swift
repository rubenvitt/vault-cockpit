import CockpitShared
import SwiftUI

/// Verarbeiten einer Notiz (`aside.note-actions` im Web), nur mit Schreibrecht: Vorschläge für
/// Inbox-Notizen (Tags, Ordner, nicht verlinkte ähnliche), Ablegen mit Ordnervorschlägen und
/// „Ins Archiv“, Tags setzen, Text anhängen. Alles sendet der `NoteStore` (Meldung, Haptik,
/// Rückgängig beim Ablegen).
@MainActor
struct NoteScreenActionsPanel: View {
    @Bindable var store: NoteStore
    let model: NoteModel
    let toasts: ToastCenter
    /// Ablage der Entwürfe (beim Abmelden geleert).
    let drafts: SnapshotStore
    let open: (String) -> Void

    @State private var folder = ""
    @State private var tags = ""
    /// Erfolgreich verlinkt (bis die neu geladenen Vorschläge sie nicht mehr nennen).
    @State private var linked: Set<String> = []
    @State private var folderNudge: CGFloat = 0
    @FocusState private var folderFocused: Bool
    @FocusState private var tagsFocused: Bool
    @FocusState private var appendFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 16) {
            if let suggestions = model.suggestions {
                suggestionsSection(suggestions)
            }
            fileSection
            tagsSection
            appendSection
        }
        .onAppear {
            tags = store.tagsText
            // Entwurf von vorher (neue Anmeldung, App beendet), wie das Entwurfs-Cookie im Web.
            if store.appendDraft.isEmpty, let draft = NoteScreenDraft.load(store.path, from: drafts) { store.appendDraft = draft }
        }
        .onChange(of: model.tags) { _, _ in
            // Nicht in eine laufende Eingabe schreiben.
            if !tagsFocused { tags = store.tagsText }
        }
        // Gespeichert, wenn eine Weile nichts getippt wurde; geleert (angehängt) sofort weg.
        .task(id: store.appendDraft) {
            guard !store.appendDraft.isEmpty else { return }
            do { try await Task.sleep(nanoseconds: 600_000_000) } catch { return }
            NoteScreenDraft.save(store.appendDraft, for: store.path, in: drafts)
        }
        .onChange(of: store.appendDraft) { old, new in
            if !old.isEmpty, new.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                NoteScreenDraft.save("", for: store.path, in: drafts)
            }
        }
        .onDisappear {
            if !store.appendDraft.isEmpty { NoteScreenDraft.save(store.appendDraft, for: store.path, in: drafts) }
        }
    }

    // MARK: Vorschläge

    private func suggestionsSection(_ s: NoteSuggestions) -> some View {
        let openTags = s.tags.filter { !model.tags.contains($0.tag) }
        let hasRows = !openTags.isEmpty || !s.folders.isEmpty || !s.unlinked.isEmpty
        return CardSection("Vorschläge", hint: s.of > 0 ? "aus \(s.of) ähnlichen Notizen" : nil) {
            VStack(alignment: .leading, spacing: 14) {
                if !hasRows {
                    EmptyText(s.tags.isEmpty ? s.emptyText : "Alle vorgeschlagenen Tags sind gesetzt.")
                }
                if !openTags.isEmpty {
                    row("Tags") {
                        ChipRow {
                            ForEach(openTags) { tag in
                                NoteScreenChip(label: "+ #\(tag.tag)", busy: store.isBusy(.tags)) {
                                    Task { await store.addTags([tag.tag]) }
                                }
                                .accessibilityHint("bei \(tag.count) von \(s.of) ähnlichen")
                                .transition(.scale(scale: 0.8).combined(with: .opacity))
                            }
                            if openTags.count > 1 {
                                NoteScreenChip(label: "Alle übernehmen", systemImage: "plus.circle") {
                                    Task { await store.addTags(openTags.map(\.tag)) }
                                }
                                .disabled(store.isBusy(.tags))
                            }
                        }
                        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.8), value: openTags.map(\.tag))
                    }
                }
                if !s.folders.isEmpty {
                    row("Ablegen in") {
                        ChipRow {
                            ForEach(s.folders) { item in
                                NoteScreenChip(label: "\(item.folder)/", detail: "\(item.count) von \(s.of)", busy: store.isBusy(.file)) {
                                    file(item.folder)
                                }
                                .accessibilityLabel("Ablegen in \(item.folder), \(item.count) von \(s.of) ähnlichen")
                            }
                        }
                    }
                }
                if !s.unlinked.isEmpty {
                    row("Ähnlich, nicht verlinkt") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(s.unlinked) { note in
                                unlinkedRow(note)
                            }
                        }
                    }
                }
                if hasRows, s.source == "text", let problem = s.problem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func row<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.text2)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func unlinkedRow(_ note: NoteSuggestions.Unlinked) -> some View {
        let done = linked.contains(note.path)
        return HStack(alignment: .center, spacing: 10) {
            NoteScreenNoteRow(title: note.title, path: note.path, score: note.score, linked: false) { open(note.path) }
            if done {
                Label("Verlinkt", systemImage: "checkmark")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.ok)
                    .transition(.scale.combined(with: .opacity))
            } else {
                NoteScreenChip(label: "Verlinken", busy: store.isBusy(.link(note.path))) {
                    Task {
                        if await store.link(to: note.path) {
                            withAnimation(reduceMotion ? nil : .snappy) { _ = linked.insert(note.path) }
                        }
                    }
                }
                .accessibilityHint("[[\(note.title)]] an \(model.title) anhängen")
            }
        }
        .animation(reduceMotion ? nil : .snappy, value: done)
    }

    // MARK: Ablegen

    /// Passende Ordner zum Eingetippten (wie `datalist` im Web), höchstens zwölf.
    private var matchingTargets: [String] {
        let typed = folder.trimmingCharacters(in: .whitespaces).lowercased()
        let matches = typed.isEmpty ? model.targets : model.targets.filter { $0.lowercased().contains(typed) && $0.lowercased() != typed }
        return Array(matches.prefix(12))
    }

    private var fileSection: some View {
        CardSection("Ablegen") {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    TextField("Zielordner …", text: $folder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($folderFocused)
                        .onSubmit { file(folder) }
                        .noteScreenField()
                        .modifier(ShakeEffect(animatableData: folderNudge))
                        .accessibilityLabel("Zielordner")
                    Button {
                        file(folder)
                    } label: {
                        if store.isBusy(.file) {
                            ProgressView()
                        } else {
                            Text("Ablegen")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .disabled(store.isBusy(.file))
                }
                if !matchingTargets.isEmpty, folderFocused || !folder.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(matchingTargets, id: \.self) { target in
                                Button {
                                    folder = target
                                    toasts.signal(.selection)
                                } label: {
                                    Text("\(target)/")
                                        .font(.footnote.weight(.medium))
                                        .foregroundStyle(Theme.text2)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 5)
                                        .background(Theme.surface2, in: Capsule())
                                        .overlay { Capsule().strokeBorder(Theme.line) }
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Ordner \(target)")
                            }
                        }
                    }
                    .transition(.opacity)
                }
                if let archive = model.archive {
                    Button {
                        file(archive)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "archivebox")
                                .accessibilityHidden(true)
                            Text("Ins Archiv")
                            Text("\(archive)/")
                                .foregroundStyle(Theme.text3)
                        }
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                    .disabled(store.isBusy(.file))
                }
            }
            .animation(reduceMotion ? nil : .snappy, value: folderFocused)
        }
    }

    private func file(_ target: String) {
        let target = target.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else {
            withAnimation(reduceMotion ? nil : .linear(duration: 0.3)) { folderNudge += 1 }
            folderFocused = true
            return
        }
        folderFocused = false
        Task {
            if await store.file(to: target) { folder = "" }
        }
    }

    // MARK: Tags

    private var tagsSection: some View {
        CardSection("Tags") {
            HStack(spacing: 8) {
                TextField("z. B. idee, hund", text: $tags)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($tagsFocused)
                    .onSubmit(setTags)
                    .noteScreenField()
                    .accessibilityLabel("Tags")
                Button(action: setTags) {
                    if store.isBusy(.tags) {
                        ProgressView()
                    } else {
                        Text("Setzen")
                    }
                }
                .buttonStyle(.bordered)
                .tint(Theme.accent)
                .disabled(store.isBusy(.tags) || tags == store.tagsText)
            }
        }
    }

    private func setTags() {
        tagsFocused = false
        let text = tags
        Task {
            if await store.setTags(text) { tags = store.tagsText }
        }
    }

    // MARK: Anhängen

    private var appendSection: some View {
        CardSection("Anhängen") {
            VStack(alignment: .trailing, spacing: 8) {
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $store.appendDraft)
                        .focused($appendFocused)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 96)
                        .accessibilityLabel("Text ans Ende der Notiz")
                    if store.appendDraft.isEmpty {
                        Text("Text ans Ende der Notiz")
                            .foregroundStyle(Theme.text3)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(appendFocused ? Theme.accentLine : Theme.line)
                }
                HStack {
                    if store.appendDraft.count > NoteStore.appendLimit * 9 / 10 {
                        Text("\(store.appendDraft.count) / \(NoteStore.appendLimit)")
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(store.appendDraft.count > NoteStore.appendLimit ? Theme.danger : Theme.text3)
                            .contentTransition(.numericText(value: Double(store.appendDraft.count)))
                    }
                    Spacer(minLength: 8)
                    Button {
                        appendFocused = false
                        Task { await store.append() }
                    } label: {
                        if store.isBusy(.append) {
                            ProgressView()
                        } else {
                            Text("Anhängen")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .disabled(store.isBusy(.append) || store.appendDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

/// Entwurf für „Anhängen“ je Notiz auf diesem Gerät, bis er angehängt ist (wie das
/// Entwurfs-Cookie im Web über eine neue Anmeldung hinweg). Liegt bei den gespeicherten Ständen,
/// die das Abmelden löscht; ohne Speicher beginnt das Feld leer.
enum NoteScreenDraft {
    private static func key(_ path: String) -> String { "entwurf/notiz/\(path)" }

    static func load(_ path: String, from store: SnapshotStore) -> String? {
        guard let data = store.load(key(path))?.data, let draft = String(data: data, encoding: .utf8), !draft.isEmpty else { return nil }
        return draft
    }

    static func save(_ draft: String, for path: String, in store: SnapshotStore) {
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            store.remove(key(path))
        } else {
            try? store.save(Data(draft.utf8), for: key(path))
        }
    }
}
