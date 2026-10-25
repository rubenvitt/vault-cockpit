import CockpitShared
import SwiftUI
import UIKit

/// Markiert nativ (`/lesen/markiert?quelle=&thema=` im Web): alle Markierungen, neueste zuerst
/// (höchstens 200), mit Zitat, Notiz und Herkunft; Filter Quelle und Thema als Menüs, „Alle
/// zeigen“ hebt beide auf. Eine Zeile öffnet die Leseansicht an der Markierung.
///
/// Den Filter hält die App (`AppModel.highlightQuery`), damit Links wie
/// `/lesen/markiert?thema=…` ihn setzen und er beim Wechsel der Bereiche bleibt. Zeigt sofort den
/// gespeicherten Stand; ohne einen für den neuen Filter wird der alte Stand vorläufig auf dem
/// Gerät gefiltert, bis die Antwort da ist.
@MainActor
struct MarkiertScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var store: HighlightsStore?
    /// Letzter geladener Stand, für die vorläufige Liste beim Filterwechsel.
    @State private var lastModel: HighlightListModel?

    private var query: HighlightQuery { model.highlightQuery }
    private var isFiltered: Bool { query.site != nil || query.topic != nil }

    var body: some View {
        Group {
            if let store {
                list(store)
            } else {
                LesenSkeleton(label: "Markierungen werden geladen")
                    .padding(16)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .background(Theme.bg)
        .toasts(session.toasts)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let store, store.state.isRefreshing, store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        // Erster Auftritt und jeder neue Filter (aus dem Menü oder einem Link).
        .task(id: query) { await load() }
        .onChange(of: store?.model) { _, fresh in
            if let fresh { lastModel = fresh }
        }
    }

    private func load() async {
        let store = store ?? HighlightsStore(context: session.context)
        if self.store == nil { self.store = store }
        await store.load(query)
    }

    // MARK: Liste

    private func list(_ store: HighlightsStore) -> some View {
        let shown = store.model ?? preview(store)
        return List {
            controls(store, shown)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            content(store, shown)
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await store.refresh() }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: shown?.items.map(\.id))
    }

    /// Vorläufig: der letzte Stand, auf dem Gerät nach dem neuen Filter gesiebt, solange der
    /// Server lädt und für diesen Filter nichts gespeichert ist.
    private func preview(_ store: HighlightsStore) -> HighlightListModel? {
        guard store.state.isRefreshing, var model = lastModel else { return nil }
        let query = query
        model.items = model.items.filter { item in
            (query.site == nil || item.docSite == query.site) && (query.topic == nil || item.docTopics.contains(query.topic ?? ""))
        }
        return model
    }

    /// Filter Quelle und Thema (nur, wenn es etwas zu wählen gibt), Zahl, Stand.
    @ViewBuilder
    private func controls(_ store: HighlightsStore, _ shown: HighlightListModel?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let shown, !shown.facets.sites.isEmpty || !shown.facets.topics.isEmpty {
                MarkiertFilterBar(facets: shown.facets, query: query) { next in
                    guard next != query else { return }
                    session.toasts.signal(.selection)
                    model.highlightQuery = next
                }
            }
            if let shown, !shown.items.isEmpty {
                Text(Self.countLabel(shown.items.count))
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .contentTransition(.numericText(value: Double(shown.items.count)))
                    .animation(.snappy, value: shown.items.count)
            }
            LoadStatusView(state: store.state, hasModel: store.model != nil)
        }
    }

    /// „1 Markierung“, „37 Markierungen“, bei der Grenze „Die neuesten 200 Markierungen“.
    static func countLabel(_ count: Int) -> String {
        if count >= 200 { return "Die neuesten \(count) Markierungen" }
        return count == 1 ? "1 Markierung" : "\(count) Markierungen"
    }

    @ViewBuilder
    private func content(_ store: HighlightsStore, _ shown: HighlightListModel?) -> some View {
        if let shown {
            if shown.items.isEmpty {
                empty
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(shown.items) { item in
                    MarkiertRow(item: item, query: query, open: { open(item) }, filter: { next in
                        session.toasts.signal(.selection)
                        model.highlightQuery = next
                    }, copy: {
                        UIPasteboard.general.string = item.quote
                        session.toasts.signal(.success)
                        session.toasts.show("Zitat kopiert")
                    })
                    .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
                    .listRowBackground(Theme.bg)
                    .listRowSeparatorTint(Theme.line)
                }
            }
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Markierungen nicht geladen", error: error) {
                Task { await store.refresh() }
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        } else {
            LesenSkeleton(label: "Markierungen werden geladen")
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
        }
    }

    /// „Noch nichts markiert.“ bzw. „Für diese Auswahl ist nichts markiert.“ mit „Alle zeigen“.
    @ViewBuilder private var empty: some View {
        if isFiltered {
            ContentUnavailableView {
                Label("Für diese Auswahl ist nichts markiert.", systemImage: "line.3.horizontal.decrease.circle")
            } description: {
                Text("Eine andere Quelle oder ein anderes Thema wählen.")
            } actions: {
                Button("Alle zeigen") {
                    session.toasts.signal(.selection)
                    model.highlightQuery = HighlightQuery()
                }
                .buttonStyle(LesenQuietButtonStyle())
            }
        } else {
            ContentUnavailableView {
                Label("Noch nichts markiert.", systemImage: "highlighter")
            } description: {
                Text("Markierungen aus der Leseansicht landen hier, die neueste zuerst.")
            }
        }
    }

    /// Leseansicht an der Markierung (`doc#h-…`), obendrauf auf dem Stapel des Lesens.
    private func open(_ item: ReadingHighlight) {
        session.toasts.signal(.selection)
        model.open(reading: .reader(id: item.docId, highlight: item.id, resume: false))
    }
}

// MARK: Filter

/// „Quelle: alle ▾“ und „Thema: alle ▾“ als Menüs (die `select` im Web), dahinter „Alle zeigen“,
/// sobald ein Filter gesetzt ist. Eine Wahl filtert sofort (kein „Filtern“-Knopf).
@MainActor
struct MarkiertFilterBar: View {
    let facets: HighlightFacets
    let query: HighlightQuery
    let change: (HighlightQuery) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if !facets.sites.isEmpty {
                    MarkiertFilterMenu(title: "Quelle", values: facets.sites, current: query.site) { site in
                        change(HighlightQuery(site: site, topic: query.topic))
                    }
                }
                if !facets.topics.isEmpty {
                    MarkiertFilterMenu(title: "Thema", values: facets.topics, current: query.topic) { topic in
                        change(HighlightQuery(site: query.site, topic: topic))
                    }
                }
                if query.site != nil || query.topic != nil {
                    Button("Alle zeigen") { change(HighlightQuery()) }
                        .buttonStyle(LesenQuietButtonStyle())
                        .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .padding(.vertical, 2)
        }
        .animation(.snappy, value: query)
    }
}

/// Ein Filter als Menü mit Häkchen: „alle“ und die Werte; der gewählte Wert steht in der Kapsel.
@MainActor
struct MarkiertFilterMenu: View {
    let title: String
    let values: [String]
    let current: String?
    let select: (String?) -> Void

    private var selection: Binding<String> {
        Binding(get: { current ?? "" }, set: { value in select(value.isEmpty ? nil : value) })
    }

    var body: some View {
        Menu {
            Picker(title, selection: selection) {
                Text("alle").tag("")
                ForEach(values, id: \.self) { value in
                    Text(value).tag(value)
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text(title)
                    .foregroundStyle(Theme.text3)
                Text(current ?? "alle")
                    .foregroundStyle(current == nil ? Theme.text2 : Theme.accent)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: 34)
            .background(current == nil ? Theme.surface : Theme.accentSoft, in: Capsule())
            .overlay { Capsule().strokeBorder(current == nil ? Theme.line : Theme.accentLine) }
            .contentShape(Capsule())
        }
        .accessibilityLabel("\(title): \(current ?? "alle")")
        .accessibilityHint("Wählt, welche Markierungen zu sehen sind")
    }
}

// MARK: Zeile

/// Eine Markierung (`.lesen-item`): Zitat, Notiz, darunter Titel · Quelle · Themen. Tippen öffnet
/// den Text an der Stelle; das Kontextmenü kopiert das Zitat oder filtert nach Quelle und Thema.
@MainActor
struct MarkiertRow: View {
    let item: ReadingHighlight
    let query: HighlightQuery
    let open: () -> Void
    let filter: (HighlightQuery) -> Void
    let copy: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 8) {
                MarkiertQuote(text: item.quote)
                if let note = item.note, !note.isEmpty {
                    Label {
                        Text(note)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "note.text")
                            .foregroundStyle(Theme.text3)
                    }
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                }
                meta
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(action: open) {
                Label("Im Text zeigen", systemImage: "doc.text")
            }
            Button(action: copy) {
                Label("Zitat kopieren", systemImage: "doc.on.doc")
            }
            if let site = item.docSite, !site.isEmpty, query.site != site {
                Button {
                    filter(HighlightQuery(site: site, topic: query.topic))
                } label: {
                    Label("Nur aus \(site)", systemImage: "line.3.horizontal.decrease")
                }
            }
            ForEach(item.docTopics.filter { $0 != query.topic }, id: \.self) { topic in
                Button {
                    filter(HighlightQuery(site: query.site, topic: topic))
                } label: {
                    Label("Nur Thema \(topic)", systemImage: "tag")
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint("Öffnet den Text an dieser Stelle")
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Zitat kopieren", copy)
    }

    /// Titel des Texts (Akzent wie der Link im Web) · Quelle · Themen.
    private var meta: some View {
        (Text(item.docDisplayTitle).foregroundStyle(Theme.accent)
            + Text(Self.details(item)).foregroundStyle(Theme.text3))
            .font(.footnote)
            .lineLimit(3)
    }

    /// „ · quelle.de · Thema, Thema“ (ohne leere Teile).
    static func details(_ item: ReadingHighlight) -> String {
        var parts: [String] = []
        if let site = item.docSite, !site.isEmpty { parts.append(site) }
        if !item.docTopics.isEmpty { parts.append(item.docTopics.joined(separator: ", ")) }
        return parts.map { " · \($0)" }.joined()
    }

    private var accessibilityText: String {
        var parts = ["„\(item.quote)“"]
        if let note = item.note, !note.isEmpty { parts.append("Notiz: \(note)") }
        parts.append("Aus \(item.docDisplayTitle)\(Self.details(item).replacingOccurrences(of: " · ", with: ", "))")
        return parts.joined(separator: ". ")
    }
}

/// Zitat wie `.lesen-quote` im Web: Serifenschrift mit Strich in Akzentfarbe davor. Markiert und
/// Wiedersehen teilen es.
struct MarkiertQuote: View {
    let text: String
    var font: Font = .system(.body, design: .serif)
    var lineLimit: Int?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Capsule()
                .fill(Theme.accentLine)
                .frame(width: 3)
                .accessibilityHidden(true)
            Text(text)
                .font(font)
                .foregroundStyle(Theme.text)
                .lineSpacing(3)
                .lineLimit(lineLimit)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}
