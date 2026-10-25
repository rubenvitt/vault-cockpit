import CockpitShared
import SwiftUI

/// Folgen nativ (`/lesen/folgen` im Web): „Neue Folge“, darunter die Folgen als Karten. Fertige
/// spielen im nativen Player (`EpisodePlayerView`), entstehende zeigen Schritte und Fortschritt
/// und fragen alle 3 s nach, solange die Liste sichtbar und die App vorne ist; wird eine fertig,
/// meldet der Store „Fertig: …“ mit „Abspielen“.
@MainActor
struct FolgenScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(CockpitSession.self) private var session

    var body: some View {
        // Eigener Store je Anmeldung; die Liste kommt aus dem Zwischenspeicher sofort zurück.
        FolgenList(model: model, session: session)
            .id(ObjectIdentifier(session))
    }
}

/// Liste der Folgen mit eigenem `EpisodesStore`.
@MainActor
struct FolgenList: View {
    let model: AppModel
    let session: CockpitSession

    @State private var store: EpisodesStore
    @State private var downloads = FolgenDownloads()
    /// Folge, deren Löschen gerade bestätigt werden soll.
    @State private var deleting: Episode?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(model: AppModel, session: CockpitSession) {
        self.model = model
        self.session = session
        _store = State(initialValue: EpisodesStore(context: session.context))
    }

    private var toasts: ToastCenter { session.toasts }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                header
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(Theme.bg)
        .refreshable { await store.refresh() }
        .toasts(toasts)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.state.isRefreshing && store.model != nil && !store.isPolling {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.4, dampingFraction: 0.85), value: store.model?.items.map(\.id))
        .animation(reduceMotion ? nil : .snappy, value: store.model?.items.map(\.status))
        .confirmationDialog("Folge löschen?", isPresented: deletingBinding, titleVisibility: .visible, presenting: deleting) { episode in
            Button("Löschen", role: .destructive) { delete(episode) }
            Button("Abbrechen", role: .cancel) {}
        } message: { episode in
            Text("„\(episode.title)“ und die MP3 sind danach weg.")
        }
        .sheet(item: $downloads.shared) { file in
            FolgenShareSheet(url: file.url)
                .presentationDetents([.medium, .large])
        }
        .onAppear {
            store.onPlay = { [model] episode in model.episode = FolgenList.request(for: episode) }
            store.setActive(scenePhase == .active)
            store.startPolling()
        }
        .onDisappear { store.stopPolling() }
        .onChange(of: scenePhase) { _, phase in store.setActive(phase == .active) }
        .task { await appear() }
    }

    private var deletingBinding: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
    }

    // MARK: Kopf

    /// „Neue Folge“ (nur, wenn Folgen eingerichtet sind) und „Stand von …“.
    @ViewBuilder private var header: some View {
        if let list = store.model, list.enabled {
            Button {
                toasts.signal(.selection)
                model.open(reading: .newEpisode(zeit: nil))
            } label: {
                Label("Neue Folge", systemImage: "plus")
                    .font(.body.weight(.semibold))
                    .frame(minHeight: 32)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .accessibilityHint("Texte vom Stapel vorlesen, als Podcast besprechen oder zu einem Report machen")
        }
        if store.model != nil {
            LoadStatusView(state: store.state, hasModel: true)
        }
    }

    // MARK: Liste

    @ViewBuilder private var content: some View {
        if let list = store.model {
            if !list.enabled {
                FolgenDisabledView(kinds: list.kinds) {
                    toasts.signal(.selection)
                    model.tab = .settings
                }
            } else if list.items.isEmpty {
                Text("Noch keine Folgen. Aus dem Stapel lassen sich Texte vorlesen, als Podcast besprechen oder zu einem Report zusammenfassen.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .cardStyle()
            } else {
                ForEach(list.items) { episode in
                    card(episode)
                        .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .scale(scale: 0.95).combined(with: .opacity)))
                }
            }
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Folgen nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else {
            LesenSkeleton(label: "Folgen werden geladen", rows: 3)
                .padding(.top, 8)
        }
    }

    @ViewBuilder
    private func card(_ episode: Episode) -> some View {
        let busy = store.busy.contains(episode.id)
        if episode.isDone {
            FolgenDoneCard(
                episode: episode,
                isBusy: busy,
                isDownloading: downloads.loading.contains(episode.id),
                play: { play(episode) },
                openNote: { path in
                    toasts.signal(.selection)
                    model.open(path: CockpitFormat.notePath(path))
                },
                download: { download(episode) },
                delete: { confirmDelete(episode) }
            )
        } else if episode.isFailed {
            FolgenFailedCard(
                episode: episode,
                isBusy: busy,
                retry: { resume(episode) },
                delete: { confirmDelete(episode) }
            )
        } else {
            FolgenBusyCard(episode: episode)
        }
    }

    // MARK: Aktionen

    private func play(_ episode: Episode) {
        toasts.signal(.selection)
        model.episode = Self.request(for: episode)
    }

    /// Wunsch an den nativen Player, wie `{type: 'folge', id, titel, art, dauer, groesse}` im Web.
    static func request(for episode: Episode) -> AppModel.EpisodeRequest {
        AppModel.EpisodeRequest(episodeID: episode.id, title: episode.title, kind: episode.kindLabel, seconds: Double(episode.seconds ?? 0), bytes: episode.bytes ?? 0)
    }

    private func confirmDelete(_ episode: Episode) {
        toasts.signal(.selection)
        deleting = episode
    }

    private func delete(_ episode: Episode) {
        deleting = nil
        Task { await store.delete(episode) }
    }

    private func resume(_ episode: Episode) {
        toasts.signal(.selection)
        Task { await store.resume(episode) }
    }

    private func download(_ episode: Episode) {
        toasts.signal(.selection)
        let context = session.context
        Task { await downloads.download(episode, context: context) }
    }

    // MARK: Laden

    /// Erster Auftritt: gespeicherter Stand und Laden; danach neu laden.
    private func appear() async {
        if store.model == nil {
            await store.load()
        } else if !store.state.isRefreshing {
            await store.refresh()
        }
    }
}

/// Folgen sind nicht eingerichtet (`enabled: false`): was fehlt und der Weg in die Einstellungen.
struct FolgenDisabledView: View {
    let kinds: [EpisodeKindInfo]
    let openSettings: () -> Void

    /// Gründe der Arten, ohne Wiederholungen („ElevenLabs fehlt“ gilt für alle drei).
    private var reasons: [String] {
        var seen = Set<String>()
        return kinds.compactMap(\.missing).filter { seen.insert($0).inserted }
    }

    var body: some View {
        ContentUnavailableView {
            Label("Folgen brauchen ElevenLabs", systemImage: "speaker.slash")
        } description: {
            Text(reasons.isEmpty ? "Einstellungen → Vorlesen" : reasons.joined(separator: "\n"))
        } actions: {
            Button("Einstellungen", action: openSettings)
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
        }
    }
}
