import CockpitShared
import SwiftUI

/// Graph einer Notiz nativ (`/graph?pfad=…` im Web): Kopf mit „Notiz ansehen“, „In Obsidian
/// öffnen“ und „Im ganzen Vault zeigen“, darunter der Graph (Physik, Verschieben, Zoomen, Tippen
/// wählt und klappt die Nachbarn auf, Doppeltippen macht den Knoten zur Mitte), Legende als
/// Filter, Probleme und die Listen „Verlinkt von hier“, „Verweist hierher“, „Ähnlich, nicht
/// verlinkt“ (mit Verlinken), „Aufgaben“ und „Termine“. Zeigt sofort den gespeicherten Stand
/// und lädt dann neu.
///
/// Eine neue Mitte (Doppeltippen, „Zur Mitte“, Tipp in einer Liste) bleibt auf diesem Bildschirm;
/// „Zurück zu …“ im Kopf führt den Weg zurück.
@MainActor
struct GraphScreen: View {
    let path: String

    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var store: GraphStore?
    @State private var sim = GraphScreenSimulation()
    /// Frühere Mitten, die neueste zuletzt.
    @State private var trail: [GraphScreenStop] = []
    /// Zählt Tipps auf die Zoom-Knöpfe und die Legende (Haptik).
    @State private var taps = 0
    /// Pfad, mit dem der Bildschirm zuletzt geladen hat (nicht die Mitte nach Doppeltippen).
    @State private var applied: String?
    /// Notiz oder Suche auf demselben Stapel (zurück führt wieder hierher).
    @State private var next: GraphScreenDestination?

    init(path: String) {
        self.path = path
    }

    var body: some View {
        Group {
            if let store {
                content(store)
            } else {
                LesenSkeleton(label: "Graph wird geladen")
                    .padding(16)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .background(Theme.bg)
        .toasts(session.toasts)
        .navigationTitle("Graph")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let store, store.state.isRefreshing, store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                // Wie das Suchfeld im Kopf der Graphseite im Web.
                Button {
                    session.toasts.signal(.selection)
                    next = .search
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .accessibilityLabel("Vault durchsuchen")
            }
        }
        .sensoryFeedback(.selection, trigger: taps)
        .navigationDestination(item: $next) { destination in
            switch destination {
            case .note(let path):
                NoteScreen(path: path)
            case .search:
                SearchScreen()
            case .whole(let path, let notes):
                WholeGraphScreen(focus: path, canOpenNotes: notes)
            }
        }
        .task(id: path) { await load() }
        .onAppear { sim.reduceMotion = reduceMotion }
        .onChange(of: reduceMotion) { _, reduce in sim.reduceMotion = reduce }
        .onDisappear { sim.stop() }
    }

    /// Erster Auftritt: Store anlegen (gespeicherter Stand zuerst). Ein anderer Pfad für denselben
    /// Bildschirm (Link) lädt neu; zurück auf den Bildschirm (etwa von der Notiz) lädt nur die
    /// gezeigte Mitte neu, auch wenn sie inzwischen eine andere ist.
    private func load() async {
        if let store {
            if applied != path {
                applied = path
                trail = []
                await store.load(path: path)
            } else if !store.state.isRefreshing {
                await store.refresh()
            }
            return
        }
        let store = GraphStore(context: session.context, path: path)
        self.store = store
        applied = path
        await store.load()
    }

    // MARK: Inhalt

    private func content(_ store: GraphStore) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(store)
                LoadStatusView(state: store.state, hasModel: store.model != nil)
                if store.model == nil, store.nodes.isEmpty, let error = store.state.error, !store.state.isRefreshing {
                    failed(store, error)
                } else {
                    stage(store)
                    GraphScreenLegend(filters: store.filters) { kind in
                        taps += 1
                        withAnimation(.snappy) { store.filters[kind].toggle() }
                    }
                    Text("Tippen: Nachbarn aufklappen · Doppeltippen: zur Mitte · Ziehen: Knoten bewegen")
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                        .accessibilityHidden(true)
                    if let problems = store.model?.problems, !problems.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(problems, id: \.self) { ProblemText($0) }
                        }
                    }
                    if let model = store.model {
                        GraphScreenLists(
                            model: model,
                            linking: store.linking,
                            recenter: { path, label in recenter(store, path: path, label: label) },
                            openNote: openNote,
                            openURL: { session.context.openURL($0) },
                            link: { path in Task { await store.link(path: path) } }
                        )
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: store.model?.path)
        }
        .refreshable { await store.refresh() }
        // Neue Knoten und Kanten (Mitte, aufgeklappte Nachbarn, Verlinken) gehen in die Physik.
        .onChange(of: store.nodes, initial: true) { _, _ in syncLayout(store) }
        .onChange(of: store.edges) { _, _ in syncLayout(store) }
    }

    private func syncLayout(_ store: GraphStore) {
        sim.sync(nodes: store.nodes, edges: store.edges, center: store.center, near: store.addedNear)
    }

    // MARK: Kopf

    /// Titel der Mitte, Pfad, „Notiz ansehen“ und „In Obsidian öffnen“; „Zurück zu …“ nach einem
    /// Wechsel der Mitte.
    private func header(_ store: GraphStore) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let back = trail.last {
                Button {
                    goBack(store)
                } label: {
                    Label("Zurück zu \(back.label)", systemImage: "chevron.backward")
                        .lineLimit(1)
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.accent)
                .buttonStyle(.borderless)
                .transition(.opacity)
            }
            Text(store.model?.label ?? GraphScreenStop.title(of: store.path))
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.text)
                .accessibilityAddTraits(.isHeader)
            Text(store.path)
                .font(.footnote)
                .foregroundStyle(Theme.text3)
                .lineLimit(2)
            if let model = store.model, model.can.notes || model.obsidianURL != nil {
                HStack(spacing: 16) {
                    if model.can.notes {
                        Button("Notiz ansehen") { openNote(model.path) }
                    }
                    if let obsidian = model.obsidianURL {
                        Button("In Obsidian öffnen") { session.context.openURL(obsidian) }
                    }
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.accent)
                .buttonStyle(.borderless)
            }
            if let model = store.model {
                // Wie „Im ganzen Vault zeigen“ im Kopf der Graphseite im Web.
                Button {
                    session.toasts.signal(.selection)
                    next = .whole(model.path, notes: model.can.notes)
                } label: {
                    Label("Im ganzen Vault zeigen", systemImage: "circle.hexagongrid")
                }
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.accent)
                .buttonStyle(.borderless)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(.snappy, value: trail)
    }

    /// Mitte nicht im Index (404) oder nichts gespeichert und kein Netz.
    @ViewBuilder
    private func failed(_ store: GraphStore, _ error: CockpitError) -> some View {
        if case .failed(404, _, _) = error {
            ContentUnavailableView {
                Label("Nicht im Index", systemImage: "point.3.connected.trianglepath.dotted")
            } description: {
                Text("Diese Notiz ist nicht im Index.")
            } actions: {
                if !trail.isEmpty {
                    Button("Zurück") { goBack(store) }
                        .buttonStyle(.bordered)
                }
            }
        } else {
            LoadFailedView(title: "Graph nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        }
    }

    // MARK: Graph

    private func stage(_ store: GraphStore) -> some View {
        GraphScreenStage(store: store, sim: sim, select: { id in
            Task { await store.select(id) }
        }, recenter: { id in
            guard let node = store.node(id), node.kind == .note, let path = node.path else { return }
            recenter(store, path: path, label: node.label)
        })
        .frame(height: GraphScreenStop.stageHeight)
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .overlay {
            if store.nodes.isEmpty, store.state.isRefreshing {
                ProgressView()
                    .accessibilityLabel("Graph wird geladen")
            }
        }
        .overlay(alignment: .topTrailing) { controls }
        .overlay(alignment: .bottom) {
            if let id = store.selected, let node = store.node(id) {
                GraphScreenCard(
                    node: node,
                    meta: store.cardMeta(id),
                    isCenter: id == store.center,
                    canOpenNote: store.model?.can.notes ?? false,
                    canLink: store.canLink(id),
                    isLinking: node.path.map { store.linking.contains($0) } ?? false,
                    canExpand: node.kind == .note && !store.loaded.contains(id),
                    isExpanding: store.expanding.contains(id),
                    recenter: {
                        if let path = node.path { recenter(store, path: path, label: node.label) }
                    },
                    openNote: { if let path = node.path { openNote(path) } },
                    link: { Task { await store.link(node: id) } },
                    expand: { Task { await store.expand(id) } },
                    openURL: { session.context.openURL($0) },
                    close: { Task { await store.select(nil) } }
                )
                .id(id)
                .padding(10)
                .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.86), value: store.selected)
    }

    /// Vergrößern, Verkleinern, Alles zeigen, Physik anstoßen (wie `.graph-zoom` im Web).
    private var controls: some View {
        VStack(spacing: 0) {
            control("plus", label: "Vergrößern") { sim.zoom(by: 1.4) }
            Divider()
            control("minus", label: "Verkleinern") { sim.zoom(by: 1 / 1.4) }
            Divider()
            control("arrow.up.left.and.arrow.down.right", label: "Alles zeigen") { sim.fit() }
            Divider()
            control("arrow.clockwise", label: "Physik anstoßen") { sim.kick() }
        }
        .frame(width: 40)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .padding(8)
    }

    private func control(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button {
            taps += 1
            action()
        } label: {
            Image(systemName: symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.text2)
                .frame(width: 40, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: Wege

    /// Neue Mitte auf diesem Bildschirm; die alte kommt auf den Weg zurück.
    private func recenter(_ store: GraphStore, path: String, label: String) {
        guard path != store.path else { return }
        session.toasts.signal(.selection)
        trail.append(GraphScreenStop(path: store.path, label: store.model?.label ?? GraphScreenStop.title(of: store.path)))
        Task { await store.load(path: path) }
    }

    private func goBack(_ store: GraphStore) {
        guard let back = trail.popLast() else { return }
        session.toasts.signal(.selection)
        Task { await store.load(path: back.path) }
    }

    /// Notizseite (`/notiz?pfad=…`) auf demselben Stapel, wie die Links der Notiz selbst.
    private func openNote(_ path: String) {
        session.toasts.signal(.selection)
        next = .note(path)
    }
}

/// Ziel auf dem Stapel aus dem Graphen: eine Notiz, die Suche oder der ganze Vault mit dieser
/// Notiz gewählt (`notes`: es gibt Notizseiten).
enum GraphScreenDestination: Hashable {
    case note(String)
    case search
    case whole(String, notes: Bool)
}

/// Frühere Mitte auf dem Weg zurück.
struct GraphScreenStop: Equatable {
    let path: String
    let label: String

    /// Höhe der Fläche des Graphen.
    static let stageHeight: CGFloat = 440

    /// Name einer Notiz aus dem Pfad, solange der Titel fehlt („wiki/Training.md“ → „Training“).
    static func title(of path: String) -> String {
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return name.hasSuffix(".md") ? String(name.dropLast(3)) : name
    }
}

// MARK: Legende

/// Legende als Filter (Link, ähnlich nicht verlinkt, Aufgabe, Termin) mit dem Strich der
/// jeweiligen Kante; ausgeschaltet blass und durchgestrichen wie im Web.
@MainActor
struct GraphScreenLegend: View {
    let filters: GraphFilters
    let toggle: (GraphEdgeKind) -> Void

    var body: some View {
        ChipRow {
            ForEach(GraphEdgeKind.allCases, id: \.self) { kind in
                let on = filters[kind]
                Button {
                    toggle(kind)
                } label: {
                    HStack(spacing: 6) {
                        GraphScreenStroke()
                            .stroke(GraphScreenScene.edgeColor(kind, strength: 1), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: kind == .semantic ? [4, 3] : []))
                            .frame(width: 22, height: 2)
                            .accessibilityHidden(true)
                        Text(kind.label)
                            .strikethrough(!on)
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(on ? Theme.text2 : Theme.text3)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(minHeight: 32)
                    .background(on ? Theme.surface : Color.clear, in: Capsule())
                    .overlay { Capsule().strokeBorder(Theme.line) }
                    .opacity(on ? 1 : 0.55)
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(kind.label)
                .accessibilityValue(on ? "sichtbar" : "ausgeblendet")
                .accessibilityHint("Blendet diese Art im Graphen ein oder aus")
            }
        }
        .animation(.snappy, value: filters)
    }
}

/// Waagrechter Strich in der Mitte des Rahmens (Muster der Legende).
struct GraphScreenStroke: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return path
    }
}
