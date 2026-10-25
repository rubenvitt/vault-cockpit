import CockpitShared
import SwiftUI
import UIKit

/// Ziel auf dem Stapel aus einer Notiz: andere Notiz (Wikilink, Backlink, Ähnlich), ihr Graph
/// oder die Leseansicht an einer Markierung (Belege).
enum NoteScreenDestination: Hashable {
    case note(path: String, anchor: String?)
    case graph(path: String)
    case reader(id: String, anchor: ReaderAnchor?)
}

/// Sprungwunsch zu einer Überschrift; jede Anfrage einmal (`serial`).
struct NoteScreenScroll: Equatable {
    let anchor: String
    let serial: Int
}

/// Notiz nativ (`/notiz?pfad=…` im Web): Kopf mit Graph und Obsidian, Tags, Kopf einer Synthese,
/// Frontmatter, der Text als Blöcke (Checkboxen zum Abhaken, Callouts, Tabellen, Bilder mit dem
/// Geräte-Token), Belege aus dem Lesestapel, Verwandte und mit Schreibrecht das Verarbeiten
/// (Vorschläge, Ablegen, Tags, Anhängen).
///
/// Zeigt sofort den gespeicherten Stand und lädt dann neu. Wikilinks öffnen die nächste Notiz auf
/// demselben Stapel, `[[#Überschrift]]` und die Thesen springen in der Notiz, Links nach außen gehen
/// in den `SFSafariViewController`. Braucht einen `NavigationStack` und die Sitzung im Environment.
@MainActor
struct NoteScreen: View {
    let path: String
    /// Überschrift (`h-…`), zu der nach dem Laden gesprungen wird.
    let anchor: String?

    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var store: NoteStore?
    @State private var next: NoteScreenDestination?
    @State private var viewer: NoteScreenImageItem?
    @State private var scrollRequest: NoteScreenScroll?
    /// Noch nicht ausgeführter Sprung aus dem Link, der die Notiz geöffnet hat.
    @State private var pendingAnchor: String?

    init(path: String, anchor: String? = nil) {
        self.path = path
        self.anchor = anchor
        _pendingAnchor = State(initialValue: anchor)
    }

    var body: some View {
        Group {
            if let store {
                screen(store)
            } else {
                skeleton
            }
        }
        .background(Theme.bg)
        .navigationTitle(store?.model?.title ?? Self.fallbackTitle(path))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let store, store.state.isRefreshing, store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                menu
            }
        }
        .toasts(session.toasts)
        .task(id: path) { await load() }
        .navigationDestination(item: $next) { destination in
            destinationView(destination)
        }
        .fullScreenCover(item: $viewer) { item in
            NoteScreenImageViewer(item: item) { src in
                await store?.imageData(src)
            }
        }
    }

    private func load() async {
        let store = store ?? NoteStore(context: session.context, path: path)
        if self.store == nil { self.store = store }
        await store.load()
    }

    /// Titel, solange nichts geladen ist: Dateiname ohne `.md`.
    static func fallbackTitle(_ path: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return name.lowercased().hasSuffix(".md") ? String(name.dropLast(3)) : name
    }

    // MARK: Zustände

    @ViewBuilder
    private func screen(_ store: NoteStore) -> some View {
        if let model = store.model {
            note(store, model)
        } else if let error = store.state.error, !store.state.isRefreshing {
            if case .failed(404, _, let message) = error {
                ContentUnavailableView {
                    Label("Notiz nicht gefunden", systemImage: "doc.questionmark")
                } description: {
                    Text(message)
                } actions: {
                    Button("Erneut versuchen") { Task { await store.refresh() } }
                        .buttonStyle(.bordered)
                        .tint(Theme.accent)
                }
            } else {
                LoadFailedView(title: "Notiz nicht geladen", error: error) {
                    Task { await store.refresh() }
                }
            }
        } else {
            skeleton
        }
    }

    private var skeleton: some View {
        ScrollView {
            LesenSkeleton(label: "Notiz wird geladen", rows: 6)
                .padding(16)
        }
    }

    // MARK: Notiz

    private func note(_ store: NoteStore, _ model: NoteModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    LoadStatusView(state: store.state, hasModel: true)
                    NoteScreenHeader(model: model, movedFrom: store.movedFrom) {
                        session.toasts.signal(.selection)
                        next = .graph(path: model.path)
                    }
                    article(store, model)
                    // Inbox-Notizen wollen verarbeitet werden: das Panel gleich unter den Text.
                    if model.inInbox, model.can.write {
                        panel(store, model)
                    }
                    if let evidence = model.evidence, !evidence.isEmpty {
                        NoteScreenEvidence(
                            items: evidence,
                            canWrite: model.can.write,
                            isBusy: { store.isBusy(.evidence($0)) },
                            open: { openEvidence($0) },
                            attach: { item in Task { await store.attachEvidence(item) } }
                        )
                    }
                    NoteScreenRelated(related: model.related) { path in
                        open(.note(path: path, anchor: nil))
                    }
                    if !model.inInbox, model.can.write {
                        panel(store, model)
                    }
                }
                .padding(16)
                .animation(reduceMotion ? nil : .snappy, value: model.evidence?.map(\.id))
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await store.refresh() }
            // Wikilinks, Bilder und Sprungmarken im Text bleiben in der App.
            .environment(\.openURL, OpenURLAction { url in handle(url) })
            .onChange(of: scrollRequest) { _, request in
                guard let request else { return }
                withAnimation(reduceMotion ? nil : .snappy) {
                    proxy.scrollTo(request.anchor, anchor: .top)
                }
            }
            .onChange(of: model.path, initial: true) { _, _ in
                jumpToPendingAnchor()
            }
        }
    }

    private func article(_ store: NoteStore, _ model: NoteModel) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if !model.tags.isEmpty {
                NoteScreenTags(tags: model.tags)
            }
            if let synthesis = model.synthesis {
                NoteScreenSynthesis(
                    head: synthesis,
                    creatingTasks: store.isBusy(.tasks),
                    jump: { scroll(to: $0) },
                    createTasks: { Task { await store.createTasks() } }
                )
            }
            if !model.frontmatter.isEmpty {
                NoteScreenFrontmatter(model: model)
            }
            if model.blocks.isEmpty {
                EmptyText("Die Notiz ist leer.")
            } else {
                NoteScreenBlocks(blocks: model.blocks, actions: actions(store))
            }
        }
        .cardStyle(padding: 18)
    }

    private func panel(_ store: NoteStore, _ model: NoteModel) -> some View {
        NoteScreenActionsPanel(store: store, model: model, toasts: session.toasts, drafts: session.context.snapshots) { path in
            open(.note(path: path, anchor: nil))
        }
    }

    private func actions(_ store: NoteStore) -> NoteScreenActions {
        NoteScreenActions(
            canToggle: store.canWrite,
            isBusy: { store.isBusy(.checkbox($0)) },
            toggle: { box in Task { await store.toggle(box) } },
            loadImage: { src in await store.imageData(src) },
            openImage: { viewer = $0 },
            openLink: { open($0) },
            copy: { copy($0) }
        )
    }

    // MARK: Links und Sprünge

    /// Links aus dem Text: eigene (`x-cockpit-notiz`) in der App, Adressen des Cockpits als
    /// Seite der App, http(s) im `SFSafariViewController`, der Rest (obsidian://, mailto:) ans System.
    private func handle(_ url: URL) -> OpenURLAction.Result {
        if let destination = NoteScreenLink.destination(of: url) {
            open(destination)
            return .handled
        }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return .systemAction
        }
        let server = session.context.api.baseURL
        if url.host() == server.host(), url.port == server.port, let route = PageRoute(url: url) {
            if case .note(let path, let anchor) = route {
                open(.note(path: path, anchor: anchor))
            } else if case .graph(let path) = route {
                next = .graph(path: path)
            } else {
                session.context.openPath(route.webPath)
            }
            return .handled
        }
        ExternalLink.open(url)
        return .handled
    }

    private func open(_ destination: NoteLinkDestination) {
        switch destination {
        case .note(let path, let anchor):
            if path == store?.path {
                if let anchor { scroll(to: anchor) }
            } else {
                session.toasts.signal(.selection)
                next = .note(path: path, anchor: anchor)
            }
        case .heading(let anchor):
            scroll(to: anchor)
        case .image(let src):
            viewer = NoteScreenImageItem(src: src, alt: "")
        case .none:
            break
        }
    }

    private func openEvidence(_ item: EvidenceSuggestion) {
        guard let route = item.route else {
            if let href = item.href { session.context.openPath(href) }
            return
        }
        session.toasts.signal(.selection)
        if case .reader(let id, let highlight, let resume) = route {
            next = .reader(id: id, anchor: ReaderAnchor(highlight: highlight, resume: resume))
        } else {
            session.context.openPath(item.href ?? "")
        }
    }

    private func scroll(to anchor: String) {
        scrollRequest = NoteScreenScroll(anchor: anchor, serial: (scrollRequest?.serial ?? 0) + 1)
    }

    /// Sprung aus dem öffnenden Link, sobald der Text steht (kurz warten, bis er gesetzt ist).
    private func jumpToPendingAnchor() {
        guard let anchor = pendingAnchor else { return }
        pendingAnchor = nil
        Task {
            try? await Task.sleep(nanoseconds: 150_000_000)
            scroll(to: anchor)
        }
    }

    private func copy(_ text: String) {
        UIPasteboard.general.string = text
        session.toasts.signal(.success)
        session.toasts.show("Kopiert")
    }

    // MARK: Menü und Ziele

    private var menu: some View {
        Menu {
            if let model = store?.model {
                if model.can.graph {
                    Button {
                        next = .graph(path: model.path)
                    } label: {
                        Label("Graph", systemImage: "point.3.connected.trianglepath.dotted")
                    }
                }
                if let obsidian = model.obsidianURL {
                    Button {
                        ExternalLink.open(obsidian)
                    } label: {
                        Label("In Obsidian öffnen", systemImage: "arrow.up.forward.app")
                    }
                }
                Button {
                    copy(model.path)
                } label: {
                    Label("Pfad kopieren", systemImage: "doc.on.doc")
                }
            }
            Button {
                if let store { Task { await store.refresh() } }
            } label: {
                Label("Neu laden", systemImage: "arrow.clockwise")
            }
            Button {
                session.context.openPath("/")
            } label: {
                Label("Zur Woche", systemImage: "calendar")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .accessibilityLabel("Mehr")
        }
    }

    @ViewBuilder
    private func destinationView(_ destination: NoteScreenDestination) -> some View {
        switch destination {
        case .note(let path, let anchor):
            NoteScreen(path: path, anchor: anchor)
        case .graph(let path):
            GraphScreen(path: path)
        case .reader(let id, let anchor):
            ReaderScreen(docID: id, anchor: anchor)
        }
    }
}
