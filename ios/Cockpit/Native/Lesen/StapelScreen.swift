import CockpitShared
import SwiftUI

/// Stapel nativ (`/lesen/stapel` im Web): Zeitfenster füllen (5, 15, 30, 60 Min.) oder alles nach
/// „Passt jetzt“, „Neueste“, „Kürzeste“, Gruppen-Chips, „Unterwegs hören“ (nativer Player) und
/// „Folge erzeugen“. Zeilen öffnen die Leseansicht (angefangene an der Lesestelle); „Im Vault
/// ablegen“ per Wischen oder Kontextmenü, sofort aus der Liste mit Rückgängig.
@MainActor
struct StapelScreen: View {
    let model: AppModel
    let store: StackStore
    let toasts: ToastCenter

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        List {
            controls
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            content
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .refreshable { await store.refresh() }
        .toasts(toasts)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.state.isRefreshing && store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: store.model?.items.map(\.id))
        .task { await appear() }
    }

    // MARK: Auswahl

    /// Gruppen, Zeitfenster, Hören und Folge, Sortierung; mit Zeitfenster der Balken „x von y Min.“.
    @ViewBuilder private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let stack = store.model {
                if stack.showGroups {
                    LesenGroupChips(groups: stack.groups, current: store.query.group) { group in
                        guard group != store.query.group else { return }
                        toasts.signal(.selection)
                        Task { await store.setGroup(group) }
                    }
                }
                LesenChipScroller("Zeitfenster") {
                    LesenChip(label: "Alle", selected: store.query.zeit == nil) { setZeit(nil) }
                    ForEach(stack.windows, id: \.self) { minutes in
                        LesenChip(label: "\(minutes) Min.", selected: store.query.zeit == minutes) { setZeit(minutes) }
                    }
                }
                HStack(spacing: 8) {
                    Button {
                        toasts.signal(.selection)
                        model.listening = AppModel.ListenRequest(minutes: stack.listenZeit)
                    } label: {
                        Label("Unterwegs hören", systemImage: "headphones")
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                    .accessibilityHint("Öffnet den Player mit \(stack.listenZeit) Minuten")
                    if stack.episodes {
                        Button {
                            toasts.signal(.selection)
                            model.open(reading: .newEpisode(zeit: stack.episodeZeit))
                        } label: {
                            Label("Folge erzeugen", systemImage: "waveform")
                        }
                        .buttonStyle(LesenQuietButtonStyle())
                    }
                }
                .padding(.horizontal, 16)
                if store.query.zeit == nil {
                    LesenChipScroller("Sortierung") {
                        ForEach(stack.sorts, id: \.key) { sort in
                            LesenChip(label: sort.label, selected: (store.query.sort ?? stack.sort) == sort.key) {
                                guard (store.query.sort ?? stack.sort) != sort.key else { return }
                                toasts.signal(.selection)
                                Task { await store.setSort(sort.key) }
                            }
                        }
                    }
                    .transition(.opacity)
                }
                VStack(alignment: .leading, spacing: 10) {
                    LoadStatusView(state: store.state, hasModel: true)
                    if let window = stack.window, stack.count > 0 {
                        windowView(window)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .animation(.snappy, value: store.query)
    }

    /// „12 von 15 Min.“ mit Balken, oder „Nichts passt ganz – …“.
    @ViewBuilder
    private func windowView(_ window: StackWindow) -> some View {
        if window.fits {
            VStack(alignment: .leading, spacing: 6) {
                LesenBar(value: window.of > 0 ? Double(window.used) / Double(window.of) : 0, tint: Theme.accent)
                Text("\(window.used) von \(window.of) Min.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .contentTransition(.numericText(value: Double(window.used)))
                    .animation(.snappy, value: window.used)
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("Nichts passt ganz – lies den Anfang eines längeren Textes")
                .font(.subheadline)
                .foregroundStyle(Theme.text3)
        }
    }

    private func setZeit(_ zeit: Int?) {
        guard zeit != store.query.zeit else { return }
        toasts.signal(.selection)
        Task { await store.setZeit(zeit) }
    }

    // MARK: Liste

    @ViewBuilder private var content: some View {
        if let stack = store.model {
            if stack.count == 0 {
                Text("Auf dem Stapel liegt nichts.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(stack.items) { item in
                    row(item, vault: stack.vault)
                }
                if let window = stack.window, window.fits, window.more > 0 {
                    Text("\(window.more) weitere warten")
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .contentTransition(.numericText(value: Double(window.more)))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            }
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Stapel nicht geladen", error: error) {
                Task { await store.refresh() }
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        } else {
            LesenSkeleton(label: "Stapel wird geladen")
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
        }
    }

    private func row(_ item: StackItem, vault: Bool) -> some View {
        NavigationLink(value: ReadingRoute.reader(id: item.id, highlight: nil, resume: item.started)) {
            StapelRow(item: item, busy: store.busy.contains(item.id))
        }
        .listRowBackground(Theme.bg)
        .listRowSeparatorTint(Theme.line)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if vault {
                Button {
                    file(item)
                } label: {
                    Label("Im Vault ablegen", systemImage: "archivebox")
                }
                .tint(Theme.accent)
            }
        }
        .contextMenu {
            Button {
                toasts.signal(.selection)
                model.readingPath.append(.reader(id: item.id, highlight: nil, resume: item.started))
            } label: {
                Label(item.started ? "Weiterlesen" : "Lesen", systemImage: "book")
            }
            if vault {
                Button {
                    file(item)
                } label: {
                    Label("Im Vault ablegen", systemImage: "archivebox")
                }
            }
            if let url = URL(string: item.url), url.scheme?.hasPrefix("http") == true {
                Button {
                    ExternalLink.open(url)
                } label: {
                    Label("Original öffnen", systemImage: "safari")
                }
            }
        }
        .accessibilityAction(named: "Im Vault ablegen") {
            if vault { file(item) }
        }
    }

    private func file(_ item: StackItem) {
        Task { await store.file(item) }
    }

    // MARK: Laden

    /// Erster Auftritt: gespeicherter Stand und Laden; danach neu laden. Die nächsten Texte kommen
    /// in den Zwischenspeicher, damit sie ohne Netz aufgehen (wie die Offline-Liste im Web).
    private func appear() async {
        if store.model == nil {
            await store.load(store.query)
        } else if !store.state.isRefreshing {
            await store.refresh()
        }
        guard store.model != nil, !store.state.isOffline else { return }
        let store = store
        Task { await store.prefetchDocs() }
    }
}

/// Eintrag des Stapels: Titel, „Weiterlesen · noch 8 Min. · Quelle“, bei angefangenen ein Balken.
struct StapelRow: View {
    let item: StackItem
    let busy: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.displayTitle)
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.text)
                .lineLimit(3)
            HStack(spacing: 8) {
                Text(item.meta)
                    .font(.footnote)
                    .foregroundStyle(item.started ? Theme.accent : Theme.text3)
                    .lineLimit(1)
                if item.started {
                    LesenBar(value: item.progress, tint: Theme.accent)
                        .frame(maxWidth: 60)
                }
            }
        }
        .padding(.vertical, 6)
        .opacity(busy ? 0.5 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.displayTitle), \(item.meta)")
    }
}
