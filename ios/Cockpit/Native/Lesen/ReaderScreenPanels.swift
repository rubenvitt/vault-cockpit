import CockpitShared
import SwiftUI

/// Was gerade ausgewählt ist: eine Textstelle (UTF-16 im Lesetext) oder eine angetippte Markierung.
enum ReaderSelection: Equatable {
    case range(Range<Int>)
    case mark(String)

    var markID: String? {
        if case .mark(let id) = self { return id }
        return nil
    }
}

/// Wofür die Notiz ist: eine Auswahl (wird mit Notiz markiert) oder eine Markierung.
enum ReaderNoteTarget: Equatable {
    case range(Range<Int>)
    case highlight(String)

    var id: String {
        switch self {
        case .range(let range): "\(range.lowerBound)-\(range.upperBound)"
        case .highlight(let id): id
        }
    }
}

/// Seitenleiste als Blatt: Markierungen oder Stapel.
enum ReaderSideTab: String, Hashable {
    case marks, stack
}

/// Blätter der Leseansicht (im Web die Seitenleiste und `prompt()`).
enum ReaderSheet: Identifiable, Equatable {
    case side(ReaderSideTab)
    case note(ReaderNoteTarget)
    case connections

    var id: String {
        switch self {
        case .side(let tab): "seite-\(tab.rawValue)"
        case .note(let target): "notiz-\(target.id)"
        case .connections: "verbinden"
        }
    }
}

/// Text kürzen wie `short()` in src/lesen/doc.js.
enum ReaderFormat {
    static func short(_ text: String, _ limit: Int = 160) -> String {
        guard text.count > limit else { return text }
        let cut = text.prefix(limit - 1)
        return String(cut).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }

    /// Lesetext in der Schrift des Artikels (Zitate in Listen und Blättern).
    static func quoteFont(sans: Bool) -> Font {
        sans ? .body : .system(.body, design: .serif)
    }
}

// MARK: Fortschritt

/// Leiste über dem Text (`.lesen-progress`): Balken, „noch 8 min“ bzw. „gelesen“, „Weiterlesen“
/// und, was im Puffer auf Netz wartet. Liest den Fortschritt selbst, damit beim Scrollen nur sie
/// neu gezeichnet wird.
@MainActor
struct ReaderProgressBar: View {
    let store: ReaderStore
    let buffer: ReadingBuffer
    let toasts: ToastCenter
    let showsResume: Bool
    let onResume: () -> Void

    private var waiting: [ReadingOutbox.Entry] {
        buffer.entries.filter { $0.docID == store.docID }
    }

    var body: some View {
        let progress = store.progress
        HStack(spacing: 10) {
            Capsule()
                .fill(Theme.line)
                .frame(height: 4)
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(Theme.accent)
                            .frame(width: proxy.size.width * min(1, max(0, progress)))
                    }
                }
                .animation(.snappy, value: progress)
                .accessibilityElement()
                .accessibilityLabel("Gelesen")
                .accessibilityValue("\(Int((progress * 100).rounded())) Prozent")
            if !store.restLabel.isEmpty {
                Text(store.restLabel)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.numericText())
                    .animation(.snappy, value: store.restLabel)
                    .lineLimit(1)
                    .fixedSize()
            }
            if showsResume {
                Button("Weiterlesen", action: onResume)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.accent)
                    .buttonStyle(.borderless)
                    .fixedSize()
                    .accessibilityHint("Springt zur gespeicherten Lesestelle")
            }
            pending
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Theme.bg)
    }

    /// Wartende Einträge dieses Artikels: „Wartet auf Netz“, abgelehnte „Nicht gesendet“ (antippen sendet neu).
    @ViewBuilder private var pending: some View {
        let entries = waiting
        if !entries.isEmpty {
            let failed = entries.contains { $0.error != nil }
            Button {
                toasts.signal(.selection)
                if failed {
                    Task { await buffer.flush(retry: true) }
                } else {
                    toasts.show(buffer.summary)
                }
            } label: {
                Label(failed ? "Nicht gesendet" : "Wartet auf Netz", systemImage: failed ? "exclamationmark.icloud" : "icloud.slash")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(failed ? Theme.danger : Theme.warn)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(failed ? Theme.dangerSoft : Theme.warnSoft, in: Capsule())
                    .fixedSize()
            }
            .buttonStyle(.borderless)
            .accessibilityHint(failed ? "Erneut senden" : buffer.summary)
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }
}

// MARK: Leiste zur Auswahl

/// Leiste unten (`.lesen-selbar`): Markieren, Notiz, Verbinden, In Inbox; bei einer angetippten
/// Markierung Entfernen statt Markieren. Unten, damit sie dem Menü an der Auswahl nicht im Weg ist.
@MainActor
struct ReaderSelectionBar: View {
    let selection: ReaderSelection
    /// Die angetippte Markierung wartet noch im Puffer (Verbinden und In Inbox brauchen den Server).
    let isPending: Bool
    let busy: Set<String>
    let run: (ReaderCommand) -> Void

    var body: some View {
        HStack(spacing: 2) {
            if selection.markID == nil {
                item("Markieren", "highlighter", .mark)
            }
            item("Notiz", "note.text", .note)
            item("Verbinden", "point.3.connected.trianglepath.dotted", .connect, enabled: !isPending)
            item("In Inbox", "tray.and.arrow.down", .inbox, enabled: !isPending && !busy.contains("inbox"))
            if let id = selection.markID {
                item("Entfernen", "trash", .delete, role: .destructive, enabled: !busy.contains(id))
            }
        }
        .padding(6)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .shadow(color: .black.opacity(0.14), radius: 16, y: 6)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Auswahl")
    }

    private func item(_ title: String, _ icon: String, _ command: ReaderCommand, role: ButtonRole? = nil, enabled: Bool = true) -> some View {
        Button(role: role) {
            run(command)
        } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.body.weight(.medium))
                Text(title)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .foregroundStyle(role == .destructive ? Theme.danger : Theme.text)
            .frame(maxWidth: .infinity, minHeight: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
    }
}

// MARK: Nach dem Lesen

/// Am Ende des Texts: „Fertig, weg“ und „In den Vault“ (lange drücken: mit Volltext), bis
/// entschieden oder weggeklickt.
@MainActor
struct ReaderDecisionBar: View {
    let fertig: Bool
    let vault: Bool
    let busy: Set<String>
    let onFinish: () -> Void
    let onVault: (Bool) -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Text("Gelesen")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.text)
            Spacer(minLength: 4)
            if fertig {
                Button("Fertig, weg", action: onFinish)
                    .buttonStyle(.bordered)
                    .disabled(busy.contains("fertig"))
            }
            if vault {
                Menu {
                    Button("In den Vault mit Volltext") { onVault(true) }
                } label: {
                    Text("In den Vault")
                } primaryAction: {
                    onVault(false)
                }
                .menuStyle(.button)
                .buttonStyle(.borderedProminent)
                .disabled(busy.contains("vault"))
                .accessibilityHint("Lange drücken für „mit Volltext“")
            }
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Ausblenden")
        }
        .tint(Theme.accent)
        .controlSize(.small)
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 8)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .shadow(color: .black.opacity(0.14), radius: 16, y: 6)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
}

// MARK: Darstellung

/// „A−“ / „A+“ (Stufe 1…5) und „Ohne Serifen“, gemerkt wie `lesen-darstellung` im Web.
@MainActor
struct ReaderAppearancePanel: View {
    @Binding var level: Int
    @Binding var sans: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Button {
                    level = ReaderAppearance.clamp(level - 1)
                } label: {
                    Text("A−")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 48, height: 36)
                }
                .disabled(level <= ReaderAppearance.levels.lowerBound)
                .accessibilityLabel("Schrift kleiner")
                HStack(spacing: 6) {
                    ForEach(Array(ReaderAppearance.levels), id: \.self) { step in
                        Circle()
                            .fill(step <= level ? Theme.accent : Theme.lineStrong)
                            .frame(width: 7, height: 7)
                    }
                }
                .animation(.snappy, value: level)
                .accessibilityElement()
                .accessibilityLabel("Schriftgröße")
                .accessibilityValue("Stufe \(level) von \(ReaderAppearance.levels.upperBound)")
                Button {
                    level = ReaderAppearance.clamp(level + 1)
                } label: {
                    Text("A+")
                        .font(.system(size: 19, weight: .semibold))
                        .frame(width: 48, height: 36)
                }
                .disabled(level >= ReaderAppearance.levels.upperBound)
                .accessibilityLabel("Schrift größer")
            }
            .buttonStyle(.bordered)
            Toggle("Ohne Serifen", isOn: $sans)
                .tint(Theme.accent)
        }
        .padding(16)
        .frame(minWidth: 250)
        .sensoryFeedback(trigger: level) { old, new in new > old ? .increase : .decrease }
        .sensoryFeedback(.selection, trigger: sans)
    }
}

// MARK: Seitenleiste

/// Markierungen des Artikels (Sprung, Notiz, Verbinden, Entfernen; verlorene mit „Stelle nicht
/// mehr im Text“) und der Stapel mit den Bereichen, wie die Seitenleisten im Web.
@MainActor
struct ReaderSideSheet: View {
    let store: ReaderStore
    let sans: Bool
    let onJump: (String) -> Void
    let onNote: (String) -> Void
    let onConnect: (String) -> Void
    let onOpenDoc: (ReaderStackEntry) -> Void
    let onOpenPath: (String) -> Void

    @State private var tab: ReaderSideTab
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(store: ReaderStore, tab: ReaderSideTab, sans: Bool, onJump: @escaping (String) -> Void, onNote: @escaping (String) -> Void, onConnect: @escaping (String) -> Void, onOpenDoc: @escaping (ReaderStackEntry) -> Void, onOpenPath: @escaping (String) -> Void) {
        self.store = store
        self.sans = sans
        self.onJump = onJump
        self.onNote = onNote
        self.onConnect = onConnect
        self.onOpenDoc = onOpenDoc
        self.onOpenPath = onOpenPath
        _tab = State(initialValue: tab)
    }

    /// In Lesereihenfolge, verlorene Stellen zuletzt.
    private var highlights: [ReadingHighlight] {
        (store.model?.highlights ?? []).enumerated().sorted { a, b in
            let left = a.element.lost ? Int.max : (a.element.start ?? Int.max)
            let right = b.element.lost ? Int.max : (b.element.start ?? Int.max)
            return left != right ? left < right : a.offset < b.offset
        }.map(\.element)
    }

    var body: some View {
        NavigationStack {
            List {
                switch tab {
                case .marks: marks
                case .stack: stack
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .animation(reduceMotion ? nil : .snappy, value: store.model?.highlights.map(\.id))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("Ansicht", selection: $tab) {
                        Text("Markierungen").tag(ReaderSideTab.marks)
                        Text("Stapel").tag(ReaderSideTab.stack)
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 300)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .sensoryFeedback(.selection, trigger: tab)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: Markierungen

    @ViewBuilder private var marks: some View {
        let items = highlights
        if items.isEmpty {
            EmptyText("Text auswählen, um zu markieren.")
                .listRowBackground(Theme.surface)
        }
        ForEach(items) { highlight in
            row(highlight)
                .listRowBackground(Theme.surface)
                .opacity(store.busy.contains(highlight.id) ? 0.5 : 1)
                .swipeActions(edge: .trailing) {
                    Button("Entfernen", role: .destructive) { remove(highlight) }
                }
        }
    }

    private func row(_ highlight: ReadingHighlight) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if highlight.lost {
                Text(ReaderFormat.short(highlight.quote))
                    .font(ReaderFormat.quoteFont(sans: sans))
                    .foregroundStyle(Theme.text2)
                Label("Stelle nicht mehr im Text", systemImage: "questionmark.circle")
                    .font(.caption)
                    .foregroundStyle(Theme.warn)
            } else {
                Button {
                    onJump(highlight.id)
                } label: {
                    Text(ReaderFormat.short(highlight.quote))
                        .font(ReaderFormat.quoteFont(sans: sans))
                        .foregroundStyle(Theme.text)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 10)
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(Color(red: 0.98, green: 0.8, blue: 0.08).opacity(0.7))
                                .frame(width: 3)
                        }
                }
                .buttonStyle(.borderless)
                .accessibilityHint("Springt zur Stelle im Text")
            }
            if let note = highlight.note, !note.isEmpty {
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if highlight.isPending {
                Label("Wartet auf Netz", systemImage: "icloud.slash")
                    .font(.caption)
                    .foregroundStyle(Theme.warn)
            }
            HStack(spacing: 18) {
                Button(highlight.note?.isEmpty == false ? "Notiz ändern" : "Notiz") { onNote(highlight.id) }
                if !highlight.isPending {
                    Button("Verbinden") { onConnect(highlight.id) }
                }
                Spacer(minLength: 0)
                Button("Entfernen", role: .destructive) { remove(highlight) }
                    .foregroundStyle(Theme.danger)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(Theme.accent)
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    private func remove(_ highlight: ReadingHighlight) {
        Task { await store.deleteHighlight(highlight.id) }
    }

    // MARK: Stapel

    @ViewBuilder private var stack: some View {
        if let model = store.model {
            Section {
                area("Eingang", count: model.counts.eingang, path: "/lesen/eingang", icon: "tray")
                area("Stapel", count: model.counts.stapel, path: "/lesen/stapel", icon: "books.vertical")
                area("Markiert", count: nil, path: "/lesen/markiert", icon: "highlighter")
                area("Wissen", count: nil, path: "/wissen", icon: "brain")
            } header: {
                Text("Bereiche")
            }
            Section {
                if model.stack.isEmpty {
                    EmptyText("Leer.")
                        .listRowBackground(Theme.surface)
                }
                ForEach(model.stack) { entry in
                    Button {
                        if !entry.current { onOpenDoc(entry) }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(entry.displayTitle)
                                    .font(ReaderFormat.quoteFont(sans: sans))
                                    .foregroundStyle(Theme.text)
                                    .multilineTextAlignment(.leading)
                                let meta = CockpitFormat.meta([entry.site, entry.rest])
                                if !meta.isEmpty {
                                    Text(meta)
                                        .font(.caption)
                                        .foregroundStyle(Theme.text2)
                                }
                            }
                            Spacer(minLength: 0)
                            if entry.current {
                                Text("Offen")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Theme.accent)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .listRowBackground(entry.current ? Theme.accentSoft : Theme.surface)
                    .accessibilityAddTraits(entry.current ? .isSelected : [])
                }
            } header: {
                Text("Stapel")
            }
        }
    }

    private func area(_ title: String, count: Int?, path: String, icon: String) -> some View {
        Button {
            onOpenPath(path)
        } label: {
            HStack {
                Label(title, systemImage: icon)
                    .foregroundStyle(Theme.text)
                Spacer()
                if let count, count > 0 {
                    Text("\(count)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(Theme.text2)
                        .contentTransition(.numericText(value: Double(count)))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .listRowBackground(Theme.surface)
    }
}

// MARK: Notiz

/// Notiz zur Markierung (im Web `prompt()`): leer entfernt eine bestehende Notiz.
@MainActor
struct ReaderNoteSheet: View {
    let quote: String
    let sans: Bool
    let canDelete: Bool
    let onSave: (String) -> Void
    let onDelete: () -> Void

    @State private var text: String
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    init(quote: String, initial: String, sans: Bool, canDelete: Bool, onSave: @escaping (String) -> Void, onDelete: @escaping () -> Void) {
        self.quote = quote
        self.sans = sans
        self.canDelete = canDelete
        self.onSave = onSave
        self.onDelete = onDelete
        _text = State(initialValue: initial)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !quote.isEmpty {
                        Text(ReaderFormat.short(quote, 280))
                            .font(ReaderFormat.quoteFont(sans: sans))
                            .foregroundStyle(Theme.text2)
                            .padding(.leading, 12)
                            .overlay(alignment: .leading) {
                                Capsule()
                                    .fill(Theme.lineStrong)
                                    .frame(width: 3)
                            }
                            .accessibilityLabel("Zitat: \(quote)")
                    }
                    TextEditor(text: $text)
                        .focused($focused)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 140)
                        .padding(8)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                                .strokeBorder(focused ? Theme.accent : Theme.line)
                        }
                        .accessibilityLabel("Notiz")
                    if canDelete {
                        Button("Notiz entfernen", role: .destructive) {
                            onDelete()
                            dismiss()
                        }
                        .font(.subheadline.weight(.medium))
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.danger)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg)
            .navigationTitle("Notiz zur Markierung")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Speichern") {
                        onSave(text)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
            .onAppear { focused = true }
        }
        .tint(Theme.accent)
        .presentationDetents([.medium, .large])
    }
}

// MARK: Verbinden

/// Querverbindungen (`lesen-verbinden.js`): Hinweis bei Volltext, „Schon verknüpft“, „Aus anderen
/// Texten“, „Synthesen und Konzepte“ bzw. „Aus dem Vault“, je Treffer „Verknüpfen“.
@MainActor
struct ReaderConnectionsSheet: View {
    let store: ReaderStore
    let sans: Bool
    /// Web-Pfad eines Treffers (anderer Artikel, Notiz); das Blatt geht vorher zu.
    let onOpen: (String) -> Void

    @State private var linking: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    content
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .animation(reduceMotion ? nil : .snappy, value: store.connections)
            }
            .background(Theme.bg)
            .navigationTitle("Querverbindungen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Schließen") { dismiss() }
                }
            }
        }
        .tint(Theme.accent)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private var content: some View {
        switch store.connections {
        case .idle, .loading:
            HStack(spacing: 10) {
                ProgressView()
                Text("Suche passende Stellen …")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
            }
            .accessibilityElement(children: .combine)
        case .failed(let message):
            EmptyText(message)
            if let target = store.connectionTarget {
                Button("Erneut versuchen") {
                    Task { await store.loadConnections(for: target) }
                }
                .buttonStyle(.bordered)
            }
        case .loaded(let data):
            if let problem = data.problem, !problem.isEmpty {
                Label(problem, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.warn)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.warnSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            }
            if !data.linked.isEmpty {
                section("Schon verknüpft") {
                    ForEach(data.linked, id: \.self) { link in
                        if let href = link.href {
                            Button {
                                open(href)
                            } label: {
                                Label(link.target, systemImage: "link")
                                    .font(.subheadline)
                                    .multilineTextAlignment(.leading)
                            }
                            .buttonStyle(.borderless)
                        } else {
                            Label(link.target, systemImage: "link")
                                .font(.subheadline)
                                .foregroundStyle(Theme.text)
                        }
                    }
                }
            }
            if !data.highlights.isEmpty {
                section("Aus anderen Texten") {
                    ForEach(data.highlights) { hit in
                        ReaderConnectionHit(title: hit.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Ohne Titel", heading: nil, text: hit.text, note: hit.note, href: hit.href, linked: hit.linked, linking: linking == hit.id, busy: store.busy.contains("link"), sans: sans, onOpen: open) {
                            connect(hit.id) { await store.link(highlight: hit) }
                        }
                    }
                }
            }
            if !data.notes.isEmpty {
                section(data.notesTitle) {
                    ForEach(data.notes) { note in
                        ReaderConnectionHit(title: note.title.flatMap { $0.isEmpty ? nil : $0 } ?? CockpitFormat.notePath(note.path), heading: note.heading, text: note.text, note: nil, href: note.href, linked: note.linked, linking: linking == note.id, busy: store.busy.contains("link"), sans: sans, onOpen: open) {
                            connect(note.id) { await store.link(note: note) }
                        }
                    }
                }
            }
            if data.isEmpty {
                EmptyText("Nichts Passendes gefunden.")
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.text)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func open(_ href: String) {
        onOpen(href)
        dismiss()
    }

    private func connect(_ id: String, _ action: @escaping @MainActor () async -> Bool) {
        linking = id
        Task {
            _ = await action()
            linking = nil
        }
    }
}

/// Ein Treffer: Titel (Link) · Abschnitt, Zitat, dann „Verknüpfen“ oder „Schon verknüpft“.
@MainActor
struct ReaderConnectionHit: View {
    let title: String
    let heading: String?
    let text: String?
    let note: String?
    let href: String?
    let linked: Bool
    let linking: Bool
    let busy: Bool
    let sans: Bool
    let onOpen: (String) -> Void
    let onLink: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if let href {
                    Button(title) { onOpen(href) }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.borderless)
                        .multilineTextAlignment(.leading)
                } else {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.text)
                }
                if let heading, !heading.isEmpty {
                    Text("· \(heading)")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                }
            }
            if let text, !text.isEmpty {
                Text(ReaderFormat.short(text, 220))
                    .font(ReaderFormat.quoteFont(sans: sans))
                    .foregroundStyle(Theme.text2)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(Theme.lineStrong)
                            .frame(width: 3)
                    }
            }
            if let note, !note.isEmpty {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
            }
            if linked {
                Label("Schon verknüpft", systemImage: "checkmark")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.ok)
                    .transition(.opacity)
            } else {
                Button(action: onLink) {
                    HStack(spacing: 6) {
                        if linking {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text("Verknüpfen")
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(busy)
            }
        }
        .cardStyle(padding: 12)
    }
}

// MARK: Platzhalter

/// Platzhalter in Form eines Artikels, nur solange es keinen gespeicherten Stand gibt.
struct ReaderSkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Ein Titel für diesen Artikel, ungefähr so lang")
                    .font(.title.bold())
                Text("Quelle · Autor · 8 min")
                    .font(.footnote)
                ForEach(0..<6, id: \.self) { _ in
                    Text("Ein Absatz des Artikels, der gerade geladen wird, mit ein paar Zeilen Text darin, damit die Form stimmt.")
                        .font(.system(.body, design: .serif))
                }
            }
            .padding(20)
        }
        .redacted(reason: .placeholder)
        .opacity(dim ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Artikel wird geladen")
    }
}
