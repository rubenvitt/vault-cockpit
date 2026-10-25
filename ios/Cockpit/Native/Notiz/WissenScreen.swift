import CockpitShared
import SwiftUI

/// Wissen nativ (`/wissen?q&art&status&lesen=1` im Web): Frage an die Synthesen, Filter
/// Querverbindung und Status, „Passt zu meinem Lesen“; darunter „Treffer“ (mit Frage) und
/// „Zuletzt bewegt“. Eine Zeile öffnet die Synthese als Notiz, „Ganzen Vault durchsuchen“ die Suche.
///
/// Filter wirken sofort, die Frage beim Abschicken. Jeder Filter hat seinen gespeicherten Stand;
/// ohne einen bleibt die vorige Liste stehen, bis die Antwort da ist.
@MainActor
struct WissenScreen: View {
    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var store: WissenStore?
    @State private var query: WissenQuery
    /// Frage im Feld, gilt erst beim Abschicken.
    @State private var question: String
    @State private var next: WissenScreenDestination?
    @FocusState private var questionFocused: Bool

    /// `query`: Auswahl beim Öffnen, z. B. aus einem Link `/wissen?q=…`.
    init(query: WissenQuery = WissenQuery()) {
        _query = State(initialValue: query)
        _question = State(initialValue: query.q)
    }

    var body: some View {
        Group {
            if let store {
                content(store)
            } else {
                LesenSkeleton(label: "Synthesen werden geladen")
                    .padding(16)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .background(Theme.bg)
        .toasts(session.toasts)
        .task(id: query) { await load() }
        .navigationDestination(item: $next) { destination in
            switch destination {
            case .note(let path):
                NoteScreen(path: path)
            case .search(let q):
                SearchScreen(query: q)
            }
        }
    }

    private func load() async {
        let store = store ?? WissenStore(context: session.context)
        if self.store == nil { self.store = store }
        await store.load(query)
    }

    /// Neue Auswahl: lädt über `.task(id:)`.
    private func apply(_ change: (inout WissenQuery) -> Void) {
        var next = query
        change(&next)
        next.q = next.q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard next != query else { return }
        session.toasts.signal(.selection)
        query = next
    }

    // MARK: Liste

    private func content(_ store: WissenStore) -> some View {
        List {
            form(store)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            if let model = store.model {
                results(model)
            } else if let error = store.state.error, !store.state.isRefreshing {
                LoadFailedView(title: "Wissen nicht geladen", error: error) {
                    Task { await store.refresh() }
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else {
                LesenSkeleton(label: "Synthesen werden geladen")
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.refresh() }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: store.model?.recent.map(\.id))
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: store.model?.hits?.map(\.id))
    }

    // MARK: Formular

    @ViewBuilder
    private func form(_ store: WissenStore) -> some View {
        let model = store.model
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(Theme.text3)
                        .accessibilityHidden(true)
                    TextField("Frage an die Synthesen", text: $question)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                        .focused($questionFocused)
                        .onSubmit(search)
                        .accessibilityLabel("Frage an die Synthesen")
                    if !question.isEmpty {
                        Button {
                            question = ""
                            apply { $0.q = "" }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(Theme.text3)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Frage löschen")
                    }
                }
                .noteScreenField()
                Button("Suchen", action: search)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
            }
            if let model, !model.arts.isEmpty || !model.statuses.isEmpty || model.reading {
                filters(model)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let model {
                    Text(model.total == 1 ? "1 Synthese" : "\(model.total) Synthesen")
                        .monospacedDigit()
                        .contentTransition(.numericText(value: Double(model.total)))
                        .animation(.snappy, value: model.total)
                    Text("·")
                        .accessibilityHidden(true)
                }
                Button("Ganzen Vault durchsuchen") {
                    session.toasts.signal(.selection)
                    next = .search(query.q)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.accent)
            }
            .font(.footnote)
            .foregroundStyle(Theme.text3)
            LoadStatusView(state: store.state, hasModel: model != nil)
            if let degraded = model?.degraded {
                ProblemText(degraded)
            }
        }
    }

    private func filters(_ model: WissenModel) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if !model.arts.isEmpty {
                    WissenScreenFilterMenu(title: "Querverbindung", value: query.art, options: model.arts) { value in
                        apply { $0.art = value }
                    }
                }
                if !model.statuses.isEmpty {
                    WissenScreenFilterMenu(title: "Status", value: query.status, options: model.statuses) { value in
                        apply { $0.status = value }
                    }
                }
                if model.reading {
                    LesenChip(label: "Passt zu meinem Lesen", selected: query.lesen) {
                        apply { $0.lesen.toggle() }
                    }
                    .accessibilityHint("Nur Synthesen, zu denen neue Markierungen passen")
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func search() {
        questionFocused = false
        let q = question
        apply { $0.q = q }
    }

    // MARK: Treffer

    @ViewBuilder
    private func results(_ model: WissenModel) -> some View {
        if let hits = model.hits {
            Section {
                if hits.isEmpty {
                    EmptyText("Keine Synthese passt zu „\(model.q)“.")
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                } else {
                    rows(hits)
                }
            } header: {
                header("Treffer", count: hits.count)
            }
        }
        Section {
            if model.recent.isEmpty {
                EmptyText(model.total > 0 ? "Keine Synthese passt zu den Filtern." : "Noch keine Synthesen (Frontmatter type: synthesis).")
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            } else {
                rows(model.recent)
            }
        } header: {
            header("Zuletzt bewegt", count: nil)
        }
    }

    private func rows(_ items: [WissenItem]) -> some View {
        ForEach(items) { item in
            WissenScreenRow(item: item) {
                session.toasts.signal(.selection)
                next = .note(item.path)
            }
            .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
            .listRowBackground(Theme.bg)
            .listRowSeparatorTint(Theme.line)
        }
    }

    private func header(_ title: String, count: Int?) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.text)
            if let count, count > 0 {
                CountBadge(count: count)
            }
        }
        .textCase(nil)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Ziel auf dem Stapel aus Wissen: eine Synthese oder die Suche im ganzen Vault.
enum WissenScreenDestination: Hashable {
    case note(String)
    case search(String)
}

/// Auswahl „Querverbindung“ oder „Status“ als Menü-Chip; „alle“ hebt den Filter auf.
struct WissenScreenFilterMenu: View {
    let title: String
    let value: String
    let options: [String]
    let select: (String) -> Void

    var body: some View {
        Menu {
            Button {
                select("")
            } label: {
                if value.isEmpty { Label("alle", systemImage: "checkmark") } else { Text("alle") }
            }
            ForEach(options, id: \.self) { option in
                Button {
                    select(option)
                } label: {
                    if option == value { Label(option, systemImage: "checkmark") } else { Text(option) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(value.isEmpty ? title : "\(title): \(value)")
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .accessibilityHidden(true)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(value.isEmpty ? Theme.text2 : Theme.accent)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: 34)
            .background(value.isEmpty ? Theme.surface : Theme.accentSoft, in: Capsule())
            .overlay { Capsule().strokeBorder(value.isEmpty ? Theme.line : Theme.accentLine) }
            .contentShape(Capsule())
        }
        .accessibilityLabel("\(title): \(value.isEmpty ? "alle" : value)")
    }
}

/// Synthese in der Liste: Titel, Datum, Chips, Zusammenfassung (Wikilinks als Text).
struct WissenScreenRow: View {
    let item: WissenItem
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let updated = item.updated, !updated.isEmpty {
                        Text(CockpitFormat.fullDay(updated))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(Theme.text3)
                    }
                }
                NoteScreenSynthChips(art: item.art, status: item.status, confidence: item.confidence)
                if let summary = item.summary, !summary.isEmpty {
                    Text(CockpitFormat.inlineMarkdown(summary))
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Öffnet die Synthese")
    }
}
