import CockpitShared
import SwiftUI

/// Ganzer Vault als Graph nativ (`/graph/alles` im Web, VCP-113): Knoten und Lagen kommen fertig
/// vom Server (`/api/graph/alles`), hier wird nur gezeichnet. Suche springt zum Knoten, Ziehen
/// verschiebt, zwei Finger zoomen, Beschriftungen erst beim Hineinzoomen, Tippen zeigt eine Karte
/// mit „Nachbarschaft“ (nativer Graph um die Notiz), Doppeltippen geht gleich dorthin. Legende
/// färbt nach Ordner oder Typ und hebt eine Gruppe hervor.
///
/// `focus`: Notiz, die gewählt und in die Mitte gerückt wird („Im ganzen Vault zeigen“).
/// `canOpenNotes`: „Notiz ansehen“ in der Karte (der Server hat Notizseiten).
@MainActor
struct WholeGraphScreen: View {
    let focus: String?
    let canOpenNotes: Bool

    @Environment(CockpitSession.self) private var session

    @State private var store: WholeGraphStore?
    @State private var camera = WholeGraphCamera()
    @FocusState private var searching: Bool
    /// Nachbarschaft, Notiz oder Suche auf demselben Stapel (zurück führt wieder hierher).
    @State private var next: WholeGraphDestination?
    /// Zählt Tipps auf Zoom-Knöpfe und Legende (Haptik).
    @State private var taps = 0

    init(focus: String? = nil, canOpenNotes: Bool = false) {
        self.focus = focus
        self.canOpenNotes = canOpenNotes
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
        .navigationTitle("Ganzer Vault")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let store, store.state.isRefreshing, store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        .sensoryFeedback(.selection, trigger: taps)
        .navigationDestination(item: $next) { destination in
            switch destination {
            case .graph(let path):
                GraphScreen(path: path)
            case .note(let path):
                NoteScreen(path: path)
            case .search(let query):
                SearchScreen(query: query)
            }
        }
        .task { await load() }
    }

    /// Erster Auftritt: Store anlegen (gespeicherter Stand zuerst) und auf den Fokus rücken;
    /// zurück auf den Bildschirm lädt nur neu.
    private func load() async {
        if let store {
            if !store.state.isRefreshing { await store.refresh() }
            return
        }
        let store = WholeGraphStore(context: session.context, focus: focus)
        self.store = store
        await store.load()
    }

    // MARK: Inhalt

    private func content(_ store: WholeGraphStore) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                WholeGraphSearchField(store: store, focused: $searching, submit: { submit(store) })
                if store.found != nil {
                    WholeGraphHits(store: store, pick: { jump(store, to: $0) })
                }
                LoadStatusView(state: store.state, hasModel: store.model != nil)
                if store.model == nil, let error = store.state.error, !store.state.isRefreshing {
                    LoadFailedView(title: "Graph nicht geladen", error: error) {
                        Task { await store.refresh() }
                    }
                } else {
                    Text(store.model == nil ? "Alle eigenen Notizen und ihre Links, ohne vertrauliche Ordner." : store.stats())
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                    stage(store)
                    WholeGraphLegend(store: store) { taps += 1 }
                    Text("Tippen: Karte mit Nachbarschaft · Doppeltippen: zur Nachbarschaft · Zwei Finger: zoomen")
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
            .animation(.snappy, value: store.found == nil)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.refresh() }
    }

    // MARK: Graph

    private func stage(_ store: WholeGraphStore) -> some View {
        WholeGraphStage(store: store, camera: $camera, open: { openNeighbourhood(store, $0) })
            .frame(height: WholeGraphStage.height)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                    .strokeBorder(Theme.line)
            }
            .overlay {
                if store.nodes.isEmpty {
                    if store.state.isRefreshing {
                        ProgressView()
                            .accessibilityLabel("Graph wird geladen")
                    } else if store.model != nil {
                        Text("Noch keine Notizen im Index.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.text3)
                    }
                }
            }
            .overlay(alignment: .topTrailing) { controls(store) }
            .overlay(alignment: .bottom) {
                if let index = store.selected, store.nodes.indices.contains(index) {
                    WholeGraphCard(
                        store: store,
                        index: index,
                        canOpenNote: canOpenNotes,
                        neighbourhood: { openNeighbourhood(store, index) },
                        openNote: {
                            session.toasts.signal(.selection)
                            next = .note(store.nodes[index].path)
                        },
                        close: { store.select(nil) }
                    )
                    .id(index)
                    .padding(10)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.32, dampingFraction: 0.86), value: store.selected)
    }

    /// Vergrößern, Verkleinern, Alles zeigen (wie `.graph-zoom` im Web).
    private func controls(_ store: WholeGraphStore) -> some View {
        VStack(spacing: 0) {
            control("plus", label: "Vergrößern") { camera = camera.zoomed(by: 1.5, around: nil) }
            Divider()
            control("minus", label: "Verkleinern") { camera = camera.zoomed(by: 1 / 1.5, around: nil) }
            Divider()
            control("arrow.up.left.and.arrow.down.right", label: "Alles zeigen") { camera = camera.fitted() }
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

    /// Treffer der Suche: Knoten wählen und heranzoomen.
    private func jump(_ store: WholeGraphStore, to index: Int) {
        searching = false
        store.jump(to: index)
        let node = store.nodes[index]
        camera = camera.centered(on: CGPoint(x: node.x, y: node.y))
    }

    /// Eingabe: eindeutiger Treffer (einer, oder der erste heißt genau so) springt; sonst die
    /// Suche im Vault mit Volltext und Bedeutung, wie das Formular im Web.
    private func submit(_ store: WholeGraphStore) {
        let q = store.query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let found = store.found, !q.isEmpty else { return }
        if let first = found.first, found.count == 1 || WholeGraphStore.fold(store.nodes[first].label) == WholeGraphStore.fold(q) {
            jump(store, to: first)
        } else {
            searching = false
            session.toasts.signal(.selection)
            next = .search(q)
        }
    }

    /// „Nachbarschaft“: nativer Graph um die Notiz auf demselben Stapel.
    private func openNeighbourhood(_ store: WholeGraphStore, _ index: Int) {
        guard store.nodes.indices.contains(index) else { return }
        session.toasts.signal(.selection)
        next = .graph(store.nodes[index].path)
    }
}

/// Ziel auf dem Stapel aus dem ganzen Graphen.
enum WholeGraphDestination: Hashable {
    case graph(String)
    case note(String)
    case search(String)
}

// MARK: Kamera

/// Ausschnitt: Maßstab und Verschiebung über den Lagen des Servers. Kennt die eingepasste
/// Ansicht (`fit`), damit Zoomgrenzen und Größe der Punkte relativ dazu gelten, egal in welcher
/// Einheit das Layout rechnet.
struct WholeGraphCamera: Equatable {
    var scale: CGFloat = 1
    var offset: CGSize = .zero
    /// Fläche in Punkten.
    var size: CGSize = .zero
    /// Ausdehnung der Lagen.
    var bounds = WholeGraphBounds()
    /// Maßstab der eingepassten Ansicht.
    var fit: CGFloat = 1

    /// Herauszoomen bis zur halben, hinein bis zur 60-fachen eingepassten Größe.
    static let minZoom: CGFloat = 0.5
    static let maxZoom: CGFloat = 60
    /// Zoom beim Sprung zu einem Knoten (Beschriftungen ringsum lesbar).
    static let jumpZoom: CGFloat = 4
    static let padding: CGFloat = 24

    /// Vergrößerung gegenüber der eingepassten Ansicht.
    var zoom: CGFloat { scale / max(fit, .leastNonzeroMagnitude) }
    var isReady: Bool { size.width > 0 && size.height > 0 && fit > 0 }

    func screen(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: size.width / 2 + CGFloat(x) * scale + offset.width, y: size.height / 2 + CGFloat(y) * scale + offset.height)
    }

    func graph(_ point: CGPoint) -> CGPoint {
        CGPoint(x: (point.x - size.width / 2 - offset.width) / scale, y: (point.y - size.height / 2 - offset.height) / scale)
    }

    /// Neue Fläche oder neue Lagen: Einpassmaß neu; beim ersten Mal ganz eingepasst.
    func resized(to size: CGSize, bounds: WholeGraphBounds) -> WholeGraphCamera {
        var next = self
        next.size = size
        next.bounds = bounds
        let width = max(size.width - 2 * Self.padding, 40)
        let height = max(size.height - 2 * Self.padding, 40)
        next.fit = min(width / max(CGFloat(bounds.width), 1), height / max(CGFloat(bounds.height), 1))
        return isReady && bounds == self.bounds ? next.clamped() : next.fitted()
    }

    /// Alles zeigen.
    func fitted() -> WholeGraphCamera {
        var next = self
        next.scale = fit
        next.offset = CGSize(width: -CGFloat(bounds.midX) * fit, height: -CGFloat(bounds.midY) * fit)
        return next
    }

    /// Zoomt um `factor`; `anchor` (Bildschirm) bleibt, wo er ist, nil = Mitte der Fläche.
    func zoomed(by factor: CGFloat, around anchor: CGPoint?) -> WholeGraphCamera {
        let anchor = anchor ?? CGPoint(x: size.width / 2, y: size.height / 2)
        let fixed = graph(anchor)
        var next = self
        next.scale = min(fit * Self.maxZoom, max(fit * Self.minZoom, scale * factor))
        next.offset = CGSize(width: anchor.x - size.width / 2 - fixed.x * next.scale, height: anchor.y - size.height / 2 - fixed.y * next.scale)
        return next
    }

    /// Punkt (Lage) in die Mitte, mindestens auf `jumpZoom`.
    func centered(on point: CGPoint) -> WholeGraphCamera {
        var next = self
        next.scale = max(scale, fit * Self.jumpZoom)
        next.offset = CGSize(width: -point.x * next.scale, height: -point.y * next.scale)
        return next
    }

    private func clamped() -> WholeGraphCamera {
        var next = self
        next.scale = min(fit * Self.maxZoom, max(fit * Self.minZoom, scale))
        return next
    }
}

// MARK: Fläche

/// Zeichnet den ganzen Graphen mit `Canvas`: Kanten als ein Pfad, Punkte je Farbe als ein Pfad,
/// nur was im Ausschnitt liegt. Beschriftungen ab Zoom, je Rasterzelle die Notiz mit den meisten
/// Links (wie `labelDensity` in sigma), Auswahl und Treffer immer. Tippen wählt, Doppeltippen
/// öffnet die Nachbarschaft, ein Finger verschiebt, zwei zoomen.
@MainActor
struct WholeGraphStage: View {
    let store: WholeGraphStore
    @Binding var camera: WholeGraphCamera
    /// Doppeltippen auf einen Knoten.
    let open: (Int) -> Void

    @Environment(\.colorScheme) private var colorScheme
    @State private var panStart: WholeGraphCamera?
    @State private var pinchStart: WholeGraphCamera?
    @State private var lastTap: (index: Int, at: Date)?
    /// Rückt nach dem Laden einmal auf den Fokus.
    @State private var focused = false

    static let height: CGFloat = 520
    static let doubleTapInterval: TimeInterval = 0.3
    /// Raster der Beschriftungen in Punkten.
    static let labelCell = CGSize(width: 120, height: 26)
    static let maxLabels = 70

    /// Gut unterscheidbar auf hellem und dunklem Grund (wie im Web); weitere Gruppen sind grau.
    static let palette: [Color] = ([0x4E79A7, 0xF28E2B, 0xE15759, 0x59A14F, 0xB07AA1, 0x76B7B2, 0xEDC948, 0xFF9DA7, 0x9C755F, 0x8CD17D] as [UInt32])
        .map { Color(uiColor: UIColor(hex: $0)) }

    static func color(_ group: WholeGraphGroup?) -> Color {
        guard let slot = group?.color, palette.indices.contains(slot) else { return Theme.text3 }
        return palette[slot]
    }

    var body: some View {
        // Hier lesen, damit Auswahl, Treffer, Legende und Ausschnitt neu zeichnen lassen.
        _ = (store.selected, store.found, store.picked, store.groupOf, store.edges.count, camera)
        return GeometryReader { proxy in
            Canvas { context, _ in
                draw(in: &context)
            }
            .contentShape(Rectangle())
            .onTapGesture(count: 1) { point in tap(hit(point)) }
            .gesture(pan)
            .simultaneousGesture(pinch)
            .onAppear { place(in: proxy.size) }
            .onChange(of: proxy.size) { _, size in place(in: size) }
            .onChange(of: store.bounds) { _, _ in place(in: proxy.size) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Graph über den ganzen Vault, \(store.nodes.count) Notizen")
            .accessibilityHint("Notizen über das Suchfeld darüber finden")
        }
    }

    /// Kamera an Fläche und Lagen anpassen; einmal nach dem Laden auf den Fokus rücken.
    private func place(in size: CGSize) {
        guard size.width > 0, !store.nodes.isEmpty else { return }
        camera = camera.resized(to: size, bounds: store.bounds)
        if !focused, store.focus != nil, let index = store.selected {
            focused = true
            let node = store.nodes[index]
            camera = camera.centered(on: CGPoint(x: node.x, y: node.y))
        }
    }

    // MARK: Zeichnen

    /// Halbmesser in Punkten: mit dem Grad wie im Web, beim Zoomen gedämpft größer.
    private func radius(_ index: Int, zoom: CGFloat) -> CGFloat {
        let degree = store.degree.indices.contains(index) ? store.degree[index] : 0
        let base = min(1.5 + CGFloat(Double(degree).squareRoot()) * 0.9, 12)
        return base * min(3, max(0.8, zoom.squareRoot()))
    }

    private func draw(in context: inout GraphicsContext) {
        guard camera.isReady else { return }
        let nodes = store.nodes
        let zoom = camera.zoom
        let visible = CGRect(origin: .zero, size: camera.size).insetBy(dx: -20, dy: -20)
        let emphasis = store.hasEmphasis
        let focus = store.selected
        let screen = nodes.map { camera.screen($0.x, $0.y) }

        // Kanten: zurückgetretene blass, die der Auswahl kräftig obenauf.
        var plain = Path()
        var strong = Path()
        for (a, b) in store.edges {
            let p = screen[a], q = screen[b]
            guard visible.contains(p) || visible.contains(q) || CGRect(x: min(p.x, q.x), y: min(p.y, q.y), width: abs(p.x - q.x), height: abs(p.y - q.y)).intersects(visible) else { continue }
            if let focus, a == focus || b == focus {
                strong.move(to: p)
                strong.addLine(to: q)
            } else if !emphasis || (store.emphasis(a) == true && store.emphasis(b) == true && focus == nil) {
                plain.move(to: p)
                plain.addLine(to: q)
            }
        }
        let edgeWidth: CGFloat = zoom > 6 ? 0.9 : 0.6
        context.stroke(plain, with: .color(Theme.text3.opacity(colorScheme == .dark ? 0.35 : 0.28)), lineWidth: edgeWidth)
        context.stroke(strong, with: .color(Theme.text.opacity(0.55)), lineWidth: 1.2)

        // Punkte: je Gruppe ein Pfad; zurückgetretene zuerst und grau.
        var dim = Path()
        var byGroup = [Path](repeating: Path(), count: max(store.groups.count, 1))
        var front: [Int] = []
        for (i, p) in screen.enumerated() where visible.contains(p) {
            let r = radius(i, zoom: zoom)
            let rect = CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)
            switch store.emphasis(i) {
            case false?:
                dim.addEllipse(in: rect)
            case true?:
                front.append(i)
            case nil:
                let g = store.groupOf.indices.contains(i) ? store.groupOf[i] : 0
                byGroup[min(g, byGroup.count - 1)].addEllipse(in: rect)
            }
        }
        context.fill(dim, with: .color(Theme.text3.opacity(0.2)))
        for (g, path) in byGroup.enumerated() {
            context.fill(path, with: .color(Self.color(store.groups.indices.contains(g) ? store.groups[g] : nil)))
        }
        for i in front {
            let p = screen[i]
            let r = radius(i, zoom: zoom)
            let rect = CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)
            let color = Self.color(store.group(of: i))
            context.fill(Path(ellipseIn: rect), with: .color(color))
            if i == focus {
                context.stroke(Path(ellipseIn: rect.insetBy(dx: -3.5, dy: -3.5)), with: .color(color), lineWidth: 2)
            }
        }

        drawLabels(in: &context, screen: screen, visible: visible, zoom: zoom, front: front)
    }

    /// Beschriftungen: Auswahl und wenige Treffer immer; sonst ab Zoom 2 je Rasterzelle die
    /// Notiz mit den meisten Links (bei Hervorhebung nur hervorgehobene).
    private func drawLabels(in context: inout GraphicsContext, screen: [CGPoint], visible: CGRect, zoom: CGFloat, front: [Int]) {
        var forced: [Int] = []
        if let selected = store.selected { forced.append(selected) }
        if store.selected == nil, let found = store.found, found.count <= 12 { forced.append(contentsOf: found) }

        var candidates: [Int] = []
        if zoom >= 2 {
            let pool = store.hasEmphasis ? front : Array(screen.indices)
            candidates = pool.filter { visible.contains(screen[$0]) && (zoom >= 6 || store.degree[$0] >= Int(12 / zoom)) }
            candidates.sort { store.degree[$0] > store.degree[$1] }
        }
        var taken: Set<Int> = []
        var cells: Set<Int> = []
        let columns = Int(camera.size.width / Self.labelCell.width) + 3
        func cell(_ p: CGPoint) -> Int {
            Int((p.y / Self.labelCell.height).rounded(.down) + 1) * columns + Int((p.x / Self.labelCell.width).rounded(.down) + 1)
        }
        var labels: [(index: Int, strong: Bool)] = []
        for i in forced where !taken.contains(i) && visible.contains(screen[i]) {
            taken.insert(i)
            cells.insert(cell(screen[i]))
            labels.append((i, true))
        }
        for i in candidates where labels.count < Self.maxLabels && !taken.contains(i) {
            let c = cell(screen[i])
            guard !cells.contains(c) else { continue }
            cells.insert(c)
            taken.insert(i)
            labels.append((i, false))
        }
        for (i, strong) in labels {
            let p = screen[i]
            let at = CGPoint(x: p.x + radius(i, zoom: zoom) + 4, y: p.y)
            let text = Self.short(store.nodes[i].label)
            let font: Font = strong ? .footnote.weight(.semibold) : .caption2
            // Rand in Flächenfarbe, damit die Schrift über Kanten lesbar bleibt (wie im Web).
            let halo = context.resolve(Text(text).font(font).foregroundStyle(Theme.surface))
            for (dx, dy) in [(-1.0, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0)] {
                context.draw(halo, at: CGPoint(x: at.x + dx, y: at.y + dy), anchor: .leading)
            }
            context.draw(Text(text).font(font).foregroundStyle(Theme.text), at: at, anchor: .leading)
        }
    }

    static func short(_ label: String) -> String {
        label.count > 42 ? String(label.prefix(41)) + "…" : label
    }

    // MARK: Gesten

    /// Knoten unter dem Finger (großzügig, damit kleine Punkte treffbar sind); hervorgehobene
    /// gewinnen gegen zurückgetretene.
    private func hit(_ point: CGPoint) -> Int? {
        guard camera.isReady else { return nil }
        var best: (index: Int, distance: CGFloat, front: Bool)?
        for (i, node) in store.nodes.enumerated() {
            let p = camera.screen(node.x, node.y)
            let distance = CGFloat(hypot(Double(p.x - point.x), Double(p.y - point.y)))
            guard distance <= max(radius(i, zoom: camera.zoom) + 8, 18) else { continue }
            let front = store.emphasis(i) != false
            if let current = best, (current.front && !front) || (current.front == front && current.distance <= distance) { continue }
            best = (i, distance, front)
        }
        return best?.index
    }

    /// Erstes Tippen wählt (ins Leere: Auswahl weg), ein zweites auf denselben Knoten innerhalb
    /// von `doubleTapInterval` öffnet die Nachbarschaft.
    private func tap(_ index: Int?) {
        let now = Date()
        if let index, let last = lastTap, last.index == index, now.timeIntervalSince(last.at) <= Self.doubleTapInterval {
            lastTap = nil
            open(index)
            return
        }
        lastTap = index.map { (index: $0, at: now) }
        store.select(index)
    }

    private var pan: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                // Zwei Finger: der Zoom führt; danach geht es ab der neuen Lage weiter.
                guard pinchStart == nil else {
                    panStart = nil
                    return
                }
                let start = panStart ?? camera
                if panStart == nil { panStart = start }
                var next = start
                next.offset.width += value.translation.width
                next.offset.height += value.translation.height
                camera = next
            }
            .onEnded { _ in panStart = nil }
    }

    private var pinch: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let start = pinchStart ?? camera
                if pinchStart == nil { pinchStart = start }
                camera = start.zoomed(by: value.magnification, around: value.startLocation)
            }
            .onEnded { _ in
                pinchStart = nil
                panStart = nil
            }
    }
}

// MARK: Suche, Karte, Legende

/// „Notiz im Graphen finden“: sucht beim Tippen in Titeln und Pfaden, Eingabe springt oder geht
/// zur Suche im Vault.
@MainActor
struct WholeGraphSearchField: View {
    @Bindable var store: WholeGraphStore
    var focused: FocusState<Bool>.Binding
    let submit: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.text3)
                .accessibilityHidden(true)
            TextField("Notiz im Graphen finden", text: $store.query)
                .focused(focused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .foregroundStyle(Theme.text)
                .onSubmit(submit)
                .accessibilityLabel("Notiz im Graphen finden")
            if !store.query.isEmpty {
                Button {
                    store.query = ""
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
    }
}

/// Die besten acht Treffer der Suche im Graphen als Karte; darunter, wie viele es sind.
@MainActor
struct WholeGraphHits: View {
    let store: WholeGraphStore
    let pick: (Int) -> Void

    static let shown = 8

    var body: some View {
        let found = store.found ?? []
        VStack(alignment: .leading, spacing: 0) {
            if found.isEmpty {
                Text("Keine Notiz heißt so. Volltext und Bedeutung: Eingabe.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .padding(14)
            }
            ForEach(Array(found.prefix(Self.shown)), id: \.self) { index in
                let node = store.nodes[index]
                Button {
                    pick(index)
                } label: {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(WholeGraphStage.color(store.group(of: index)))
                            .frame(width: 9, height: 9)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(node.label)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Theme.text)
                                .multilineTextAlignment(.leading)
                            Text(node.path)
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Zeigt die Notiz im Graphen")
                .overlay(alignment: .top) {
                    if index != found.first { Theme.line.frame(height: 0.5) }
                }
            }
            if found.count > Self.shown {
                Text("\(found.count) Notizen passen, im Graphen hervorgehoben.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .overlay(alignment: .top) { Theme.line.frame(height: 0.5) }
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .transition(.opacity)
    }
}

/// Karte zum gewählten Knoten (`.graph-card` im Web): Titel, Pfad und Links, Gruppe, dazu
/// „Nachbarschaft“ (nativer Graph) und „Notiz ansehen“.
@MainActor
struct WholeGraphCard: View {
    let store: WholeGraphStore
    let index: Int
    let canOpenNote: Bool
    let neighbourhood: () -> Void
    let openNote: () -> Void
    let close: () -> Void

    var body: some View {
        let group = store.group(of: index)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle()
                    .fill(WholeGraphStage.color(group))
                    .frame(width: 10, height: 10)
                    .accessibilityHidden(true)
                Text(store.nodes[index].label)
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Schließen")
            }
            Text(CockpitFormat.meta([store.cardMeta(index), group?.label]))
                .font(.footnote)
                .foregroundStyle(Theme.text2)
                .lineLimit(3)
            ChipRow {
                GraphScreenChip(label: "Nachbarschaft", systemImage: "point.3.connected.trianglepath.dotted", prominent: true, action: neighbourhood)
                if canOpenNote {
                    GraphScreenChip(label: "Notiz ansehen", systemImage: "doc.text", action: openNote)
                }
            }
            .padding(.trailing, 8)
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .accessibilityElement(children: .contain)
    }
}

/// Legende: „Farbe nach Ordner · Typ“, darunter die Gruppen mit Farbe und Zahl; Tippen hebt
/// eine Gruppe hervor (nochmals: aus).
@MainActor
struct WholeGraphLegend: View {
    @Bindable var store: WholeGraphStore
    let tapped: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text("Farbe nach")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                Picker("Farbe nach", selection: $store.coloring) {
                    ForEach(WholeGraphColoring.allCases, id: \.self) { coloring in
                        Text(coloring.label).tag(coloring)
                    }
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .onChange(of: store.coloring) { _, _ in tapped() }
            }
            ChipRow {
                ForEach(store.groups) { group in
                    let on = store.picked == group.id
                    Button {
                        tapped()
                        withAnimation(.snappy) { store.pick(group.id) }
                    } label: {
                        HStack(spacing: 6) {
                            Circle()
                                .fill(WholeGraphStage.color(group))
                                .frame(width: 9, height: 9)
                                .accessibilityHidden(true)
                            Text(group.label)
                                .foregroundStyle(on ? Theme.text : Theme.text2)
                            Text(String(group.count))
                                .font(.caption)
                                .foregroundStyle(Theme.text3)
                        }
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .frame(minHeight: 32)
                        .background(on ? Theme.accentSoft : Theme.surface, in: Capsule())
                        .overlay { Capsule().strokeBorder(on ? Theme.accentLine : Theme.line) }
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(group.label), \(group.count) Notizen")
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityHint("Hebt diese Gruppe im Graphen hervor")
                }
            }
        }
    }
}
