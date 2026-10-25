import CockpitShared
import SwiftUI
import UIKit

/// Feeds nativ (`/lesen/feeds` im Web): oben „Abonnieren“ (Adresse eines Feeds oder einer
/// Website, optional mit Gruppe), darunter die Gruppen als Abschnitte in ihrer Reihenfolge mit
/// „n neu“ (Tipp öffnet den Eingang dieser Gruppe) und „Ohne Gruppe“, unten „Gruppe anlegen“
/// und OPML (importieren, exportieren).
///
/// Ein Tipp auf einen Feed öffnet seine Einstellungen (Pausiert, Direkt auf den Stapel,
/// Stichwort-Filter, Abstand, Gruppe, „Feed entfernen“), Wischen pausiert oder entfernt ihn.
/// „Gruppe bearbeiten“ liegt im Menü am Kopf jeder Gruppe. Pausieren und Entfernen wirken in der
/// Liste sofort und werden zurückgenommen, wenn der Server ablehnt; der gespeicherte Stand
/// steht da, bevor die Antwort kommt.
///
/// Sammeln (VCP-110): Über der Liste suchen (Titel, Host, Gruppe) und „Nur mit Fehlern“; „Auswählen“
/// oben rechts setzt Häkchen an die Feeds, die Leiste unten zählt sie („n Feeds abgehakt“), hakt
/// alle sichtbaren ab und bietet die Aktionen für alle abgehakten auf einmal: in eine Gruppe
/// verschieben (auch eine neue), pausieren, fortsetzen, direkt auf den Stapel oder in den Eingang,
/// Abstand ändern und entfernen (mit Rückfrage).
@MainActor
struct FeedsScreen: View {
    @Environment(CockpitSession.self) private var session
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var store: FeedsStore?
    /// Zugeklappte Gruppen (im Web `<details open>`, also anfangs alle offen).
    @State private var collapsed: Set<String> = []
    /// Feeds und Gruppen, die gerade entfernt werden: sofort aus der Liste.
    @State private var removing: Set<String> = []
    /// Pause per Wischen, bis die Liste neu geladen ist.
    @State private var pauseOverride: [String: Bool] = [:]
    @State private var sheet: FeedsScreenSheet?
    @State private var deletingFeed: ReadingFeed?
    @State private var deletingGroup: FeedGroup?
    /// Auswahlmodus: Häkchen an den Feeds und die Leiste unten.
    @State private var selecting = false
    /// Rückfrage vor „Entfernen“ für alle abgehakten Feeds.
    @State private var confirmsBulkRemove = false

    var body: some View {
        Group {
            if let store {
                content(store)
            } else {
                LesenSkeleton(label: "Feeds werden geladen")
                    .padding(16)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .background(Theme.bg)
        .toasts(session.toasts)
        .task { await load() }
    }

    private func load() async {
        let store = store ?? FeedsStore(context: session.context)
        if self.store == nil { self.store = store }
        await store.load()
    }

    // MARK: Liste

    private func content(_ store: FeedsStore) -> some View {
        bulkChrome(listView(store), store: store)
    }

    private func listView(_ store: FeedsStore) -> some View {
        List {
            FeedsScreenSubscribe(store: store, toasts: session.toasts)
                .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            if let feeds = store.model {
                VStack(alignment: .leading, spacing: 8) {
                    LoadStatusView(state: store.state, hasModel: true)
                }
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                if !feeds.allFeeds.isEmpty {
                    FeedsScreenFilterBar(store: store, toasts: session.toasts)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                list(feeds, store: store)
                FeedsScreenTools(store: store, toasts: session.toasts) { url in
                    sheet = .export(url)
                }
                .listRowInsets(EdgeInsets(top: 20, leading: 16, bottom: 24, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else if let error = store.state.error, !store.state.isRefreshing {
                LoadFailedView(title: "Feeds nicht geladen", error: error) {
                    Task { await store.refresh() }
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else {
                LesenSkeleton(label: "Feeds werden geladen")
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg)
        .refreshable { await store.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.state.isRefreshing && store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                if selecting || !(store.model?.allFeeds.isEmpty ?? true) {
                    Button(selecting ? "Fertig" : "Auswählen") {
                        toggleSelecting(store)
                    }
                    .fontWeight(selecting ? .semibold : .regular)
                    .accessibilityHint(selecting ? "Beendet das Auswählen" : "Feeds abhaken und gemeinsam bearbeiten")
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.4, dampingFraction: 0.85), value: layoutKey(store))
        .sensoryFeedback(.impact(weight: .light), trigger: collapsed)
        .onChange(of: store.model) { _, _ in settle(store) }
        .sheet(item: $sheet) { sheet in
            switch sheet {
            case .feed(let feed):
                FeedsScreenFeedSheet(store: store, feed: feed, toasts: session.toasts) { feed in
                    remove(feed, store: store)
                }
            case .group(let group):
                FeedsScreenGroupSheet(store: store, group: group, toasts: session.toasts) { group in
                    remove(group, store: store)
                }
            case .export(let url):
                FolgenShareSheet(url: url)
                    .presentationDetents([.medium, .large])
            case .bulkMove:
                FeedsScreenBulkMoveSheet(store: store, toasts: session.toasts) { finishBulk() }
            case .bulkInterval:
                FeedsScreenBulkIntervalSheet(store: store, toasts: session.toasts) { finishBulk() }
            }
        }
        .confirmationDialog("Feed entfernen?", isPresented: presence($deletingFeed), titleVisibility: .visible, presenting: deletingFeed) { feed in
            Button("Entfernen", role: .destructive) { remove(feed, store: store) }
            Button("Abbrechen", role: .cancel) {}
        } message: { feed in
            Text("„\(feed.title)“ wird nicht mehr abgerufen. Gespeicherte Artikel bleiben.")
        }
        .confirmationDialog("Gruppe löschen?", isPresented: presence($deletingGroup), titleVisibility: .visible, presenting: deletingGroup) { group in
            Button("Gruppe löschen", role: .destructive) { remove(group, store: store) }
            Button("Abbrechen", role: .cancel) {}
        } message: { group in
            Text("„\(group.name)“ ist danach weg. Die Feeds bleiben, dann ohne Gruppe.")
        }
    }

    /// Leiste unten im Auswahlmodus und die Rückfrage vor dem Entfernen.
    private func bulkChrome<V: View>(_ content: V, store: FeedsStore) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if selecting {
                    FeedsScreenBulkBar(
                        store: store,
                        toasts: session.toasts,
                        apply: { action in bulk(action, store: store) },
                        move: { open(.bulkMove) },
                        interval: { open(.bulkInterval) },
                        remove: {
                            session.toasts.signal(.selection)
                            confirmsBulkRemove = true
                        }
                    )
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .confirmationDialog("\(FeedFilter.feedsWord(store.selectedCount)) entfernen?", isPresented: $confirmsBulkRemove, titleVisibility: .visible) {
                Button("Entfernen", role: .destructive) { bulkRemove(store) }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("Gespeicherte Artikel bleiben, es kommen nur keine neuen mehr.")
            }
            .onChange(of: store.model?.allFeeds.isEmpty ?? true) { _, empty in
                // Nichts mehr da (alles entfernt): Auswahlmodus beenden.
                if empty && selecting { finishBulk() }
            }
    }

    /// Gruppen und Feeds wie auf der Seite: ohne Gruppen eine einfache Liste, sonst je Gruppe ein
    /// Abschnitt und darunter „Ohne Gruppe“.
    /// Beim Suchen und Filtern fallen Gruppen ohne Treffer weg (wie im Web).
    @ViewBuilder
    private func list(_ feeds: FeedsModel, store: FeedsStore) -> some View {
        let kept = feeds.groups.filter { !removing.contains($0.id) }
        let loose = store.visible(visible(feeds.ungrouped) + orphans(feeds, shownGroups: kept))
        let groups = store.filter.isActive ? kept.filter { !store.visible(visible($0.feeds)).isEmpty } : kept
        let noMatch = store.filter.isActive && !feeds.allFeeds.isEmpty
        if groups.isEmpty && loose.isEmpty {
            FeedsScreenEmpty(
                text: noMatch ? "Kein Feed passt." : "Noch keine Feeds abonniert.",
                systemImage: noMatch ? "magnifyingglass" : "dot.radiowaves.up.forward"
            )
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        } else if kept.isEmpty {
            Section {
                rows(loose, store: store)
            } header: {
                FeedsScreenCount(total: loose.count)
            }
        } else {
            ForEach(groups) { group in
                Section {
                    if !collapsed.contains(group.id) {
                        groupRows(group, store: store)
                    }
                } header: {
                    FeedsScreenGroupHeader(
                        group: group,
                        collapsed: collapsed.contains(group.id),
                        busy: store.isBusy(.group(group.id)),
                        toggle: { toggle(group) },
                        openInbox: { openInbox(group) },
                        edit: { open(.group(group)) },
                        move: { up in move(group, up: up, store: store) },
                        delete: {
                            session.toasts.signal(.selection)
                            deletingGroup = group
                        }
                    )
                }
            }
            if !loose.isEmpty {
                Section {
                    if !collapsed.contains(Self.looseID) {
                        rows(loose, store: store)
                    }
                } header: {
                    FeedsScreenLooseHeader(count: loose.count, collapsed: collapsed.contains(Self.looseID)) {
                        toggleLoose()
                    }
                }
            }
        }
    }

    /// Zeile „n neue Einträge im Eingang · Flags“, dann die Feeds der Gruppe.
    @ViewBuilder
    private func groupRows(_ group: FeedGroup, store: FeedsStore) -> some View {
        FeedsScreenInboxRow(group: group) { openInbox(group) }
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
            .listRowBackground(Theme.bg)
            .listRowSeparatorTint(Theme.line)
        let feeds = store.visible(visible(group.feeds))
        if feeds.isEmpty {
            Text("Noch keine Feeds in dieser Gruppe.")
                .font(.subheadline)
                .foregroundStyle(Theme.text3)
                .listRowBackground(Theme.bg)
                .listRowSeparator(.hidden)
        } else {
            rows(feeds, store: store)
        }
    }

    private func rows(_ feeds: [ReadingFeed], store: FeedsStore) -> some View {
        ForEach(feeds) { feed in
            row(feed, store: store)
        }
    }

    /// Ein Feed: Tipp öffnet die Einstellungen, im Auswahlmodus setzt oder nimmt er das Häkchen
    /// (dann ohne Wischen).
    private func row(_ feed: ReadingFeed, store: FeedsStore) -> some View {
        let paused = pauseOverride[feed.id] ?? feed.paused
        let selected: Bool? = selecting ? store.isSelected(feed) : nil
        let hint: String = selected.map { $0 ? "Nimmt das Häkchen weg" : "Hakt den Feed ab" } ?? "Öffnet die Einstellungen"
        return Button {
            if selecting { toggleSelection(feed, store: store) } else { open(.feed(feed)) }
        } label: {
            FeedsScreenFeedRow(feed: feed, paused: paused, pending: pauseOverride[feed.id] != nil, busy: store.isBusy(.feed(feed.id)), selected: selected)
        }
        .buttonStyle(.plain)
        .listRowBackground(selected == true ? Theme.accentSoft : Theme.bg)
        .listRowSeparatorTint(Theme.line)
        .accessibilityHint(hint)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !selecting {
                Button(role: .destructive) {
                    session.toasts.signal(.selection)
                    deletingFeed = feed
                } label: {
                    Label("Entfernen", systemImage: "trash")
                }
                .tint(Theme.danger)
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if !selecting {
                Button {
                    setPaused(feed, !paused, store: store)
                } label: {
                    Label(paused ? "Fortsetzen" : "Pausieren", systemImage: paused ? "play.fill" : "pause.fill")
                }
                .tint(paused ? Theme.ok : Theme.warn)
            }
        }
        .contextMenu {
            if !selecting {
                Button {
                    startSelecting(with: feed, store: store)
                } label: {
                    Label("Auswählen", systemImage: "checkmark.circle")
                }
            }
            Button {
                open(.feed(feed))
            } label: {
                Label("Einstellungen", systemImage: "slider.horizontal.3")
            }
            Button {
                setPaused(feed, !paused, store: store)
            } label: {
                Label(paused ? "Fortsetzen" : "Pausieren", systemImage: paused ? "play" : "pause")
            }
            if let link = feed.siteLink {
                Button {
                    ExternalLink.open(link)
                } label: {
                    Label("Website öffnen", systemImage: "safari")
                }
            }
            Button {
                UIPasteboard.general.string = feed.url
                session.toasts.signal(.success)
                session.toasts.show("Feed-Adresse kopiert.")
            } label: {
                Label("Feed-Adresse kopieren", systemImage: "doc.on.doc")
            }
            Divider()
            Button(role: .destructive) {
                deletingFeed = feed
            } label: {
                Label("Feed entfernen", systemImage: "trash")
            }
        }
    }

    // MARK: Sammeln

    /// „Auswählen“ / „Fertig“; beim Beenden fallen die Häkchen weg.
    private func toggleSelecting(_ store: FeedsStore) {
        session.toasts.signal(.selection)
        withAnimation(reduceMotion ? nil : .snappy) {
            selecting.toggle()
            if !selecting { store.selectNone() }
        }
    }

    /// „Auswählen“ im Kontextmenü: Auswahlmodus mit diesem Feed abgehakt.
    private func startSelecting(with feed: ReadingFeed, store: FeedsStore) {
        session.toasts.signal(.selection)
        withAnimation(reduceMotion ? nil : .snappy) {
            selecting = true
            store.setSelected(feed, true)
        }
    }

    private func toggleSelection(_ feed: ReadingFeed, store: FeedsStore) {
        session.toasts.signal(.selection)
        withAnimation(reduceMotion ? nil : .snappy) { store.toggleSelection(feed) }
    }

    /// Pausieren, Fortsetzen, Stapel an/aus: sofort für alle abgehakten.
    private func bulk(_ action: FeedBulkAction, store: FeedsStore) {
        Task {
            if await store.applyBulk(action) { finishBulk() }
        }
    }

    /// Entfernen nach der Rückfrage: sofort aus der Liste, zurück, wenn der Server ablehnt.
    private func bulkRemove(_ store: FeedsStore) {
        let ids = Set(store.selectedFeeds.map(\.id))
        withAnimation(reduceMotion ? nil : .snappy) { removing.formUnion(ids) }
        Task {
            if await store.applyBulk(.remove) {
                finishBulk()
            } else {
                withAnimation(.snappy) { removing.subtract(ids) }
            }
        }
    }

    /// Nach einer Aktion: Auswahlmodus beenden (die Häkchen hat der Store schon geleert).
    private func finishBulk() {
        withAnimation(reduceMotion ? nil : .snappy) { selecting = false }
    }

    // MARK: Aktionen

    private func open(_ next: FeedsScreenSheet) {
        session.toasts.signal(.selection)
        sheet = next
    }

    private func openInbox(_ group: FeedGroup) {
        session.toasts.signal(.selection)
        model.open(reading: group.inboxRoute)
    }

    private func toggle(_ group: FeedGroup) {
        withAnimation(reduceMotion ? nil : .snappy) {
            if collapsed.contains(group.id) { collapsed.remove(group.id) } else { collapsed.insert(group.id) }
        }
    }

    private func toggleLoose() {
        withAnimation(reduceMotion ? nil : .snappy) {
            if collapsed.contains(Self.looseID) { collapsed.remove(Self.looseID) } else { collapsed.insert(Self.looseID) }
        }
    }

    private func move(_ group: FeedGroup, up: Bool, store: FeedsStore) {
        Task { await store.moveGroup(group, up: up) }
    }

    /// Wischen: sofort als pausiert bzw. fortgesetzt zeigen; die Antwort lädt die Liste neu.
    private func setPaused(_ feed: ReadingFeed, _ paused: Bool, store: FeedsStore) {
        guard !store.isBusy(.feed(feed.id)) else { return }
        session.toasts.signal(.selection)
        withAnimation(.snappy) { pauseOverride[feed.id] = paused }
        var settings = feed.settings
        settings.paused = paused
        Task {
            let ok = await store.update(feed, settings)
            withAnimation(.snappy) { _ = pauseOverride.removeValue(forKey: feed.id) }
            if ok { session.toasts.signal(.success) }
        }
    }

    /// Feed entfernen: sofort aus der Liste, zurück, wenn der Server ablehnt.
    private func remove(_ feed: ReadingFeed, store: FeedsStore) {
        withAnimation(reduceMotion ? nil : .snappy) { _ = removing.insert(feed.id) }
        Task {
            let ok = await store.remove(feed)
            if !ok { withAnimation(.snappy) { _ = removing.remove(feed.id) } }
        }
    }

    /// Gruppe löschen: sofort weg, ihre Feeds erscheinen unter „Ohne Gruppe“, sobald die Liste neu da ist.
    private func remove(_ group: FeedGroup, store: FeedsStore) {
        withAnimation(reduceMotion ? nil : .snappy) { _ = removing.insert(group.id) }
        Task {
            let ok = await store.removeGroup(group)
            if !ok { withAnimation(.snappy) { _ = removing.remove(group.id) } }
        }
    }

    /// Neuer Stand: Ausgeblendetes, das es nicht mehr gibt, vergessen.
    private func settle(_ store: FeedsStore) {
        guard let feeds = store.model else { return }
        let ids = Set(feeds.allFeeds.map(\.id) + feeds.groups.map(\.id))
        let gone = removing.subtracting(ids)
        if !gone.isEmpty { removing.subtract(gone) }
    }

    // MARK: Hilfen

    /// Abschnitt „Ohne Gruppe“ hat keine ID; diese steht für sein Auf- und Zuklappen.
    private static let looseID = "ohne-gruppe"

    private func visible(_ feeds: [ReadingFeed]) -> [ReadingFeed] {
        feeds.filter { !removing.contains($0.id) }
    }

    /// Feeds einer Gruppe, die gerade gelöscht wird, stehen bis zur Antwort schon unter „Ohne Gruppe“.
    private func orphans(_ feeds: FeedsModel, shownGroups: [FeedGroup]) -> [ReadingFeed] {
        let shown = Set(shownGroups.map(\.id))
        return visible(feeds.groups.filter { !shown.contains($0.id) }.flatMap(\.feeds))
    }

    /// Was sich in der Liste bewegt (Reihenfolge, Ausblenden), für die Animation.
    private func layoutKey(_ store: FeedsStore) -> [String] {
        guard let feeds = store.model else { return [] }
        var key = feeds.groups.map { "g\($0.id)" }
        key += feeds.matching(feeds.allFeeds, store.filter).map(\.id)
        key += removing.sorted()
        key += collapsed.sorted()
        if selecting { key.append("auswahl") }
        return key
    }

    private func presence<T>(_ value: Binding<T?>) -> Binding<Bool> {
        Binding(get: { value.wrappedValue != nil }, set: { if !$0 { value.wrappedValue = nil } })
    }
}

/// Blätter der Feeds-Seite.
enum FeedsScreenSheet: Identifiable {
    case feed(ReadingFeed)
    case group(FeedGroup)
    /// Exportierte OPML-Datei im Teilen-Blatt.
    case export(URL)
    /// „In Gruppe verschieben …“ für alle abgehakten Feeds.
    case bulkMove
    /// „Abstand ändern …“ für alle abgehakten Feeds.
    case bulkInterval

    var id: String {
        switch self {
        case .feed(let feed): "feed-\(feed.id)"
        case .group(let group): "gruppe-\(group.id)"
        case .export(let url): "export-\(url.path)"
        case .bulkMove: "auswahl-gruppe"
        case .bulkInterval: "auswahl-abstand"
        }
    }
}
