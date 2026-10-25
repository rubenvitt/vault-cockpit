import CockpitShared
import SwiftUI

/// Stapel nativ (`/lesen/stapel` im Web): Zeitfenster füllen (5, 15, 30, 60 Min.) oder alles nach
/// „Passt jetzt“, „Neueste“, „Kürzeste“, Gruppen-Chips, „Unterwegs hören“ (nativer Player) und
/// „Folge erzeugen“. Zeilen öffnen die Leseansicht (angefangene an der Lesestelle); „Im Vault
/// ablegen“ per Wischen oder Kontextmenü, sofort aus der Liste mit Rückgängig.
///
/// Mit Ingest trägt jede Zeile ihr Abzeichen (`ingestBadge` im Web): „Ingest bereit“ und
/// „Ingest-Fehler“ öffnen die Prüfansicht, „wird entworfen…“ aktualisiert sich (der `IngestStore`
/// fragt nach, solange der Stapel sichtbar ist), sonst „Ingest entwerfen“, wenn Claude da ist.
@MainActor
struct StapelScreen: View {
    let model: AppModel
    let store: StackStore
    let ingest: IngestStore
    let toasts: ToastCenter

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private static let pollKey = "stapel"

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
        .onAppear {
            ingest.setActive(scenePhase == .active)
            ingest.startPolling(Self.pollKey)
        }
        .onDisappear { ingest.stopPolling(Self.pollKey) }
        .onChange(of: scenePhase) { _, phase in ingest.setActive(phase == .active) }
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
                    row(item, stack: stack)
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

    /// Zeile: Tipp öffnet die Leseansicht; das Ingest-Abzeichen darunter ist ein eigener Knopf
    /// (deshalb Knöpfe statt eines `NavigationLink`, der die ganze Zeile übernähme).
    private func row(_ item: StackItem, stack: ReadingStackModel) -> some View {
        let vault = stack.vault
        let status = ingestStatus(item, stack)
        return VStack(alignment: .leading, spacing: 2) {
            Button {
                openReader(item)
            } label: {
                HStack(spacing: 8) {
                    StapelRow(item: item, busy: store.busy.contains(item.id))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if stack.ingest == true {
                ingestLine(item, status: status, available: stack.ingestAvailable == true)
                    .padding(.bottom, 4)
            }
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
            if stack.ingest == true {
                if IngestBadge.opensReview(status) {
                    Button {
                        openReview(item)
                    } label: {
                        Label("Ingest prüfen", systemImage: "checklist")
                    }
                } else if canDraft(status, stack) {
                    Button {
                        draft(item)
                    } label: {
                        Label("Ingest entwerfen", systemImage: "sparkles")
                    }
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
        .accessibilityAction(named: "Ingest") {
            if IngestBadge.opensReview(status) { openReview(item) } else if canDraft(status, stack) { draft(item) }
        }
    }

    private func file(_ item: StackItem) {
        Task { await store.file(item) }
    }

    private func openReader(_ item: StackItem) {
        model.readingPath.append(.reader(id: item.id, highlight: nil, resume: item.started))
    }

    // MARK: Ingest

    /// Stand des Entwurfs: was der `IngestStore` neuer weiß, sonst die Liste.
    private func ingestStatus(_ item: StackItem, _ stack: ReadingStackModel) -> String? {
        guard stack.ingest == true else { return nil }
        return ingest.status(of: item.id, fallback: item.ingest, loadedAt: store.state.lastUpdated)
    }

    /// „Ingest entwerfen“ geht: Claude da, kein offener Entwurf, nicht schon im Wiki.
    private func canDraft(_ status: String?, _ stack: ReadingStackModel) -> Bool {
        stack.ingestAvailable == true && (status == nil || status == IngestStatus.discarded)
    }

    /// Abzeichen bzw. „Ingest entwerfen“ unter dem Titel.
    @ViewBuilder
    private func ingestLine(_ item: StackItem, status: String?, available: Bool) -> some View {
        if IngestBadge.opensReview(status) {
            Button {
                openReview(item)
            } label: {
                IngestBadge(status: status)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(status == IngestStatus.ready ? "Ingest bereit: \(item.displayTitle)" : "Ingest-Fehler: \(item.displayTitle)")
            .accessibilityHint("Öffnet die Prüfansicht")
        } else if status != nil, status != IngestStatus.discarded {
            IngestBadge(status: status)
        } else if available {
            let busy = ingest.busy.contains(item.id)
            Button {
                draft(item)
            } label: {
                HStack(spacing: 4) {
                    if busy {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "sparkles")
                            .accessibilityHidden(true)
                    }
                    Text("Ingest entwerfen")
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.text2)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Theme.surface, in: Capsule())
                .overlay { Capsule().strokeBorder(Theme.line) }
                .fixedSize()
            }
            .buttonStyle(.borderless)
            .disabled(busy)
            .accessibilityLabel("Ingest entwerfen: \(item.displayTitle)")
        }
    }

    private func openReview(_ item: StackItem) {
        toasts.signal(.selection)
        model.readingPath.append(.ingestReview(id: item.id))
    }

    private func draft(_ item: StackItem) {
        let ingest = ingest
        Task { await ingest.draft(item.id) }
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
