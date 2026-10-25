import CockpitShared
import SwiftUI

/// Suche im Vault nativ (`/graph?q=…` im Web): Suchfeld, ab zwei Zeichen live die besten acht
/// Treffer als Liste unter dem Feld (wie das Dropdown im Web) mit „Alle N Treffer zeigen“;
/// Eingabe oder dieser Knopf zeigt alle Treffer mit Titel, Pfad, Quellen (Volltext, Bedeutung,
/// Graph), Ausschnitt und Link zum Graphen. Ein Treffer öffnet die Notiz, ohne Notizseiten den
/// Graphen. Hinweis, wenn die Bedeutungssuche fehlt.
///
/// `query`: Begriff aus einem Link (`/graph?q=…`, „Ganzen Vault durchsuchen“ in Wissen); dann
/// gleich alle Treffer. Ohne Begriff bekommt das Feld den Fokus.
@MainActor
struct SearchScreen: View {
    let query: String

    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var store: SearchStore?
    @FocusState private var focused: Bool
    /// Begriff aus dem Link, der schon gesucht wurde.
    @State private var applied: String?
    /// Notiz oder Graph eines Treffers auf demselben Stapel (zurück führt zur Suche).
    @State private var next: SearchScreenDestination?

    init(query: String = "") {
        self.query = query
    }

    var body: some View {
        Group {
            if let store {
                content(store)
            } else {
                Theme.bg
            }
        }
        .background(Theme.bg)
        .toasts(session.toasts)
        .navigationTitle("Suche")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $next) { destination in
            switch destination {
            case .note(let path):
                NoteScreen(path: path)
            case .graph(let path):
                GraphScreen(path: path)
            }
        }
        .task(id: query) { await load() }
    }

    /// Store beim ersten Auftritt; ein Begriff aus dem Link sucht gleich alles. Zurück auf den
    /// Bildschirm bleibt, was zuletzt eingegeben war.
    private func load() async {
        let store = self.store ?? SearchStore(context: session.context)
        if self.store == nil { self.store = store }
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if applied != wanted {
            applied = wanted
            if !wanted.isEmpty {
                await store.open(query: wanted)
                return
            }
        }
        if store.query.isEmpty { focused = true }
    }

    // MARK: Inhalt

    private func content(_ store: SearchStore) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                SearchScreenField(store: store, focused: $focused)
                if let degraded = store.degraded, store.isActive {
                    Label(degraded, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(Theme.warn)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.warnSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                        .transition(.opacity)
                }
                results(store)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: store.results.map(\.id))
            .animation(.snappy, value: store.full == nil)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await Self.reload(store) }
    }

    /// Ziehen zum Aktualisieren: alle Treffer zum Begriff neu.
    private static func reload(_ store: SearchStore) async {
        if store.isActive { await store.showAll() }
    }

    @ViewBuilder
    private func results(_ store: SearchStore) -> some View {
        if !store.isActive {
            if store.trimmedQuery.isEmpty {
                ContentUnavailableView {
                    Label("Vault durchsuchen", systemImage: "magnifyingglass")
                } description: {
                    Text("Suchbegriff oder Frage eingeben. Ein Treffer öffnet \(store.opensNotes ? "die Notiz" : "seinen Graphen").")
                }
                .padding(.top, 24)
            } else {
                EmptyText("Ab \(SearchStore.minLength) Zeichen wird gesucht.")
                    .padding(.horizontal, 4)
            }
        } else if let error = store.error, store.results.isEmpty, !store.isSearching, !store.isLoadingAll {
            LoadFailedView(title: "Suche fehlgeschlagen", error: error) {
                Task { await store.showAll() }
            }
            .padding(.top, 24)
        } else if store.full != nil {
            fullList(store)
        } else {
            liveList(store)
        }
    }

    /// Alle Treffer: „N Treffer“, darunter Titel, Pfad, Quellen, Ausschnitt.
    @ViewBuilder
    private func fullList(_ store: SearchStore) -> some View {
        if store.results.isEmpty {
            nothing(store)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Text(store.total == 1 ? "1 Treffer" : "\(store.total) Treffer")
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                    .contentTransition(.numericText(value: Double(store.total)))
                    .accessibilityAddTraits(.isHeader)
                    .padding(.bottom, 4)
                if let error = store.error {
                    ProblemText(error.message)
                        .padding(.vertical, 6)
                }
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(store.results) { hit in
                        SearchScreenRow(hit: hit, full: true, opensNotes: store.opensNotes, open: { open(hit, store) }, openGraph: { openGraph(hit) })
                            .padding(.vertical, 10)
                            .overlay(alignment: .top) {
                                if hit.id != store.results.first?.id { Theme.line.frame(height: 0.5) }
                            }
                    }
                }
            }
        }
    }

    /// Die besten acht beim Tippen, als Karte unter dem Feld; darunter „Alle N Treffer zeigen“.
    @ViewBuilder
    private func liveList(_ store: SearchStore) -> some View {
        if store.results.isEmpty {
            if store.isSearching || store.live == nil {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Sucht …")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text3)
                }
                .padding(.horizontal, 4)
                .accessibilityElement(children: .combine)
            } else {
                nothing(store)
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(store.results) { hit in
                    SearchScreenRow(hit: hit, full: false, opensNotes: store.opensNotes, open: { open(hit, store) }, openGraph: { openGraph(hit) })
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .overlay(alignment: .top) {
                            if hit.id != store.results.first?.id { Theme.line.frame(height: 0.5) }
                        }
                }
                if store.hasMore {
                    Button {
                        session.toasts.signal(.selection)
                        focused = false
                        Task { await store.showAll() }
                    } label: {
                        HStack(spacing: 8) {
                            Text("Alle \(store.total) Treffer zeigen")
                                .contentTransition(.numericText(value: Double(store.total)))
                            Spacer(minLength: 8)
                            if store.isLoadingAll {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .accessibilityHidden(true)
                            }
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(store.isLoadingAll)
                    .overlay(alignment: .top) { Theme.line.frame(height: 0.5) }
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                    .strokeBorder(Theme.line)
            }
            .opacity(store.isSearching ? 0.7 : 1)
            .animation(.easeOut(duration: 0.15), value: store.isSearching)
            if let error = store.error {
                ProblemText(error.message)
            }
        }
    }

    /// „Nichts gefunden für „…“.“
    private func nothing(_ store: SearchStore) -> some View {
        ContentUnavailableView {
            Label("Nichts gefunden", systemImage: "magnifyingglass")
        } description: {
            Text("Nichts gefunden für „\(store.trimmedQuery)“.")
        }
        .padding(.top, 24)
    }

    // MARK: Öffnen

    /// Treffer: Notizseite, ohne Notizseiten der Graph.
    private func open(_ hit: SearchHit, _ store: SearchStore) {
        session.toasts.signal(.selection)
        focused = false
        next = store.opensNotes ? .note(hit.path) : .graph(hit.path)
    }

    private func openGraph(_ hit: SearchHit) {
        session.toasts.signal(.selection)
        focused = false
        next = .graph(hit.path)
    }
}

/// Ziel auf dem Stapel aus der Suche: Notiz oder Graph eines Treffers.
enum SearchScreenDestination: Hashable {
    case note(String)
    case graph(String)
}

/// Suchfeld „Vault durchsuchen“: sucht live beim Tippen, Eingabe zeigt alle Treffer, ✕ leert.
@MainActor
struct SearchScreenField: View {
    @Bindable var store: SearchStore
    var focused: FocusState<Bool>.Binding

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.text3)
                .accessibilityHidden(true)
            TextField("Vault durchsuchen", text: $store.query)
                .focused(focused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .foregroundStyle(Theme.text)
                .onSubmit {
                    Task { await store.showAll() }
                }
                .accessibilityLabel("Vault durchsuchen")
            if store.isSearching || store.isLoadingAll {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Sucht")
            }
            if !store.query.isEmpty {
                Button {
                    store.clear()
                    focused.wrappedValue = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.text3)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Suche leeren")
            }
        }
        .font(.body)
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(minHeight: 46)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .strokeBorder(focused.wrappedValue ? Theme.accentLine : Theme.line)
        }
        .animation(.easeOut(duration: 0.15), value: store.isSearching)
    }
}

/// Treffer der Suche. `full`: mit den Quellen (Volltext, Bedeutung, Graph) und längerem
/// Ausschnitt; sonst knapp wie das Dropdown. „Graph“ daneben, wenn der Titel zur Notiz führt.
@MainActor
struct SearchScreenRow: View {
    let hit: SearchHit
    let full: Bool
    let opensNotes: Bool
    let open: () -> Void
    let openGraph: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(hit.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .multilineTextAlignment(.leading)
                    Text(hit.path)
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if full, !hit.streamLabels.isEmpty {
                        HStack(spacing: 4) {
                            ForEach(hit.streamLabels, id: \.self) { label in
                                Text(label)
                                    .font(.caption2.weight(.medium))
                                    .foregroundStyle(Theme.text2)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(Theme.surface2, in: Capsule())
                                    .overlay { Capsule().strokeBorder(Theme.line) }
                            }
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("Gefunden über \(hit.streamLabels.joined(separator: ", "))")
                    }
                    if let snippet = hit.snippet, !snippet.isEmpty {
                        Text(snippet)
                            .font(.subheadline)
                            .foregroundStyle(Theme.text2)
                            .lineLimit(full ? 4 : 2)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(opensNotes ? "Öffnet die Notiz" : "Öffnet den Graphen")
            if opensNotes {
                Button("Graph", action: openGraph)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.accent)
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Graph von \(hit.title)")
            }
        }
    }
}
