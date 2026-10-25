import CockpitShared
import SwiftUI

/// Ein Bild des Graphen: sichtbare Knoten und Kanten mit Lage (Graph-Koordinaten), Größe, Farbe
/// und Beschriftung wie graph.js (Mitte in Akzent, Aufgaben grün bzw. grau, blockiert und Termine
/// orange, „nur ähnlich“ blasser Akzent). Mit Auswahl treten Knoten außerhalb der Nachbarschaft
/// zurück.
struct GraphScreenScene {
    struct Dot: Identifiable {
        let id: String
        let kind: GraphNodeKind
        /// Lage in Graph-Koordinaten.
        let point: CGPoint
        /// Halbmesser in Punkten bei Maßstab 1.
        let radius: CGFloat
        let color: Color
        let label: String
        let showsLabel: Bool
        let isCenter: Bool
        let isSelected: Bool
        let dimmed: Bool
        let sensitive: Bool
    }

    struct Line {
        let from: CGPoint
        let to: CGPoint
        let kind: GraphEdgeKind
        let color: Color
        let width: CGFloat
        let focused: Bool
    }

    let camera: GraphScreenCamera
    private(set) var dots: [Dot] = []
    private(set) var lines: [Line] = []
    /// Ids der sichtbaren Knoten (Einpassen).
    private(set) var visible: Set<String> = []

    /// Knoten unter höchstens so vielen werden alle beschriftet.
    static let labelAll = 30

    @MainActor
    init(store: GraphStore, physics: GraphScreenPhysics, camera: GraphScreenCamera) {
        self.camera = camera
        let center = store.center
        let filters = store.filters

        var degree: [String: Int] = [:]
        var kinds: [String: Set<GraphEdgeKind>] = [:]
        var shownEnds: Set<String> = []
        for edge in store.edges {
            degree[edge.from, default: 0] += 1
            degree[edge.to, default: 0] += 1
            kinds[edge.from, default: []].insert(edge.kind)
            kinds[edge.to, default: []].insert(edge.kind)
            if filters[edge.kind] {
                shownEnds.insert(edge.from)
                shownEnds.insert(edge.to)
            }
        }
        // Wie `GraphStore.isVisible`, einmal für alle statt je Knoten über alle Kanten.
        let nodes = store.nodes.filter { node in
            if node.id == center { return true }
            if node.kind == .task, !filters.task { return false }
            if node.kind == .event, !filters.event { return false }
            return shownEnds.contains(node.id)
        }
        visible = Set(nodes.map(\.id))
        let selected = store.selected.flatMap { visible.contains($0) ? $0 : nil }
        var focus: Set<String>?
        if let selected {
            var set: Set<String> = [selected]
            for edge in store.edges where edge.connects(selected) { set.insert(edge.other(than: selected)) }
            focus = set
        }

        for edge in store.edges where filters[edge.kind] && visible.contains(edge.from) && visible.contains(edge.to) {
            guard let from = physics.position(of: edge.from), let to = physics.position(of: edge.to) else { continue }
            let focused = selected.map { edge.connects($0) } ?? false
            var color = Self.edgeColor(edge.kind, strength: focused ? 0.9 : 0.5)
            if focused, edge.kind == .link { color = Theme.text.opacity(0.6) }
            if selected != nil, !focused { color = color.opacity(0.45) }
            let width: CGFloat = (edge.kind == .semantic ? 1 : 1.4) + (focused ? 0.8 : 0)
            lines.append(Line(from: from, to: to, kind: edge.kind, color: color, width: width, focused: focused))
        }
        lines.sort { !$0.focused && $1.focused }

        let many = nodes.count > Self.labelAll
        for node in nodes {
            guard let point = physics.position(of: node.id) else { continue }
            let isCenter = node.id == center
            let deg = degree[node.id] ?? 0
            let base: CGFloat = isCenter ? 13 : node.kind == .note ? min(4 + CGFloat(Double(deg).squareRoot()) * 2.2, 11) : 4.5
            let onlySimilar = node.kind == .note && !isCenter && kinds[node.id] == [.semantic]
            let dimmed = focus.map { !$0.contains(node.id) } ?? false
            let inFocus = focus?.contains(node.id) ?? false
            let showsLabel: Bool
            if dimmed {
                showsLabel = false
            } else if isCenter || inFocus || !many {
                showsLabel = true
            } else {
                showsLabel = camera.scale >= 1.15 || (deg >= 4 && camera.scale >= 0.6)
            }
            dots.append(Dot(
                id: node.id,
                kind: node.kind,
                point: point,
                radius: base * 1.15,
                color: dimmed ? Theme.text3.opacity(0.18) : Self.nodeColor(node, isCenter: isCenter, onlySimilar: onlySimilar),
                label: Self.short(node.label),
                showsLabel: showsLabel,
                isCenter: isCenter,
                isSelected: node.id == selected,
                dimmed: dimmed,
                sensitive: node.sensitivity != nil
            ))
        }
        // Zurückgetretene zuerst, dann die übrigen, Mitte und Auswahl obenauf.
        dots.sort { Self.layer($0) < Self.layer($1) }
    }

    private static func layer(_ dot: Dot) -> Int {
        if dot.isSelected { return 3 }
        if dot.isCenter { return 2 }
        return dot.dimmed ? 0 : 1
    }

    static func nodeColor(_ node: GraphNode, isCenter: Bool, onlySimilar: Bool) -> Color {
        switch node.kind {
        case .task:
            if node.status == .done || node.status == .dropped { return Theme.text3 }
            return node.status == .blocked ? Theme.warn : Theme.ok
        case .event:
            return Theme.warn
        case .note:
            if isCenter { return Theme.accent }
            return onlySimilar ? Theme.accent.opacity(0.55) : Theme.text3
        }
    }

    static func edgeColor(_ kind: GraphEdgeKind, strength: Double) -> Color {
        switch kind {
        case .semantic: Theme.accent.opacity(strength)
        case .task: Theme.ok.opacity(strength)
        case .event: Theme.warn.opacity(strength)
        case .link: Theme.text3.opacity(strength * 0.9)
        }
    }

    /// Lange Titel gekürzt, damit Beschriftungen nicht über den halben Graphen laufen.
    static func short(_ label: String) -> String {
        label.count > 32 ? String(label.prefix(31)) + "…" : label
    }

    /// Halbmesser auf dem Bildschirm: wächst beim Zoomen mit, aber gedämpft.
    func screenRadius(_ dot: Dot) -> CGFloat {
        dot.radius * min(1.6, max(0.75, camera.scale.squareRoot()))
    }

    /// Knoten unter dem Finger (großzügig, damit kleine Punkte treffbar sind).
    func hit(_ point: CGPoint, in size: CGSize) -> String? {
        var best: (id: String, distance: CGFloat)?
        for dot in dots {
            let p = camera.screen(dot.point, in: size)
            let distance = CGFloat(hypot(Double(p.x - point.x), Double(p.y - point.y)))
            guard distance <= max(screenRadius(dot) + 10, 22) else { continue }
            if let current = best, current.distance <= distance { continue }
            best = (dot.id, distance)
        }
        return best?.id
    }

    // MARK: Zeichnen

    func draw(in context: inout GraphicsContext, size: CGSize) {
        for line in lines {
            var path = Path()
            path.move(to: camera.screen(line.from, in: size))
            path.addLine(to: camera.screen(line.to, in: size))
            let style = line.kind == .semantic
                ? StrokeStyle(lineWidth: line.width, lineCap: .round, dash: [5, 5])
                : StrokeStyle(lineWidth: line.width, lineCap: .round)
            context.stroke(path, with: .color(line.color), style: style)
        }
        for dot in dots {
            let p = camera.screen(dot.point, in: size)
            let r = screenRadius(dot)
            let rect = CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)
            if dot.isCenter, !dot.dimmed {
                let halo = rect.insetBy(dx: -5, dy: -5)
                context.fill(Path(ellipseIn: halo), with: .color(Theme.accent.opacity(0.16)))
            }
            switch dot.kind {
            case .note:
                context.fill(Path(ellipseIn: rect), with: .color(dot.color))
            case .task, .event:
                context.fill(Path(roundedRect: rect, cornerRadius: r * 0.4), with: .color(dot.color))
            }
            if dot.sensitive, !dot.dimmed {
                context.stroke(Path(ellipseIn: rect.insetBy(dx: -2.5, dy: -2.5)), with: .color(dot.color), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
            }
            if dot.isSelected {
                context.stroke(Path(ellipseIn: rect.insetBy(dx: -4, dy: -4)), with: .color(dot.color), lineWidth: 2)
            }
        }
        for dot in dots where dot.showsLabel {
            let p = camera.screen(dot.point, in: size)
            let at = CGPoint(x: p.x + screenRadius(dot) + 5, y: p.y)
            let font: Font = dot.isCenter || dot.isSelected ? .footnote.weight(.semibold) : .caption
            // Rand in Flächenfarbe, damit die Schrift über Kanten lesbar bleibt (wie im Web).
            let halo = context.resolve(Text(dot.label).font(font).foregroundStyle(Theme.surface))
            for (dx, dy) in [(-1.0, 0.0), (1.0, 0.0), (0.0, -1.0), (0.0, 1.0)] {
                context.draw(halo, at: CGPoint(x: at.x + dx, y: at.y + dy), anchor: .leading)
            }
            context.draw(Text(dot.label).font(font).foregroundStyle(Theme.text), at: at, anchor: .leading)
        }
    }

    /// Text für VoiceOver: „Training, Notiz“, „Leine kaufen, Aufgabe“, „…, Mitte“.
    static func spoken(_ dot: Dot) -> String {
        let kind: String
        switch dot.kind {
        case .note: kind = "Notiz"
        case .task: kind = "Aufgabe"
        case .event: kind = "Termin"
        }
        return [dot.label, kind, dot.isCenter ? "Mitte" : nil].compactMap { $0 }.joined(separator: ", ")
    }
}

/// Die Fläche des Graphen: zeichnet mit `Canvas`, Finger verschieben (auf einem Knoten: den Knoten
/// ziehen, die Physik läuft mit), zwei Finger zoomen, Tippen wählt, Doppeltippen zentriert.
///
/// Tippen wählt sofort: Es gibt nur eine Tipp-Geste, die ein zweites Tippen auf denselben Knoten
/// kurz danach als Doppeltippen nimmt. `onTapGesture(count: 2)` vor `count: 1` ließe jedes einfache
/// Tippen erst auf das Ende der Doppeltipp-Frist warten.
@MainActor
struct GraphScreenStage: View {
    let store: GraphStore
    let sim: GraphScreenSimulation
    /// Tippen: Knoten wählen, nil = Auswahl aufheben.
    let select: (String?) -> Void
    /// Doppeltippen auf eine Notiz: neuer Graph um sie.
    let recenter: (String) -> Void

    private enum DragMode {
        /// Verschieben ab Kamera und Fingerweg beim Start.
        case pan(GraphScreenCamera, CGSize)
        case node(String)
    }

    /// Letztes Tippen auf einen Knoten (für das Doppeltippen).
    private struct LastTap {
        let id: String
        let at: Date
    }

    @State private var mode: DragMode?
    @State private var pinchStart: GraphScreenCamera?
    @State private var lastTap: LastTap?

    /// Höchster Abstand zweier Tipps auf denselben Knoten, die als Doppeltippen zählen.
    static let doubleTapInterval: TimeInterval = 0.3

    var body: some View {
        // Lage und Ausschnitt hier lesen, damit jedes Bild der Physik neu zeichnet.
        let scene = GraphScreenScene(store: store, physics: sim.physics, camera: sim.camera)
        let label = store.model?.label ?? store.path
        return GeometryReader { proxy in
            Canvas { context, size in
                scene.draw(in: &context, size: size)
            }
            .contentShape(Rectangle())
            .onTapGesture(count: 1) { point in
                tap(scene.hit(point, in: proxy.size))
            }
            .gesture(drag(scene, size: proxy.size))
            .simultaneousGesture(pinch(size: proxy.size))
            .onAppear { sim.size = proxy.size }
            .onChange(of: proxy.size) { _, size in sim.size = size }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Graph um \(label), \(scene.dots.count) Knoten")
            .accessibilityChildren {
                ForEach(scene.dots) { dot in
                    Text(GraphScreenScene.spoken(dot))
                        .accessibilityAddTraits(dot.isSelected ? [.isButton, .isSelected] : .isButton)
                        .accessibilityAction { select(dot.id) }
                }
            }
        }
        .onChange(of: scene.visible) { _, ids in sim.visibleIDs = ids }
        .onAppear { sim.visibleIDs = scene.visible }
    }

    /// Erstes Tippen wählt (oder hebt die Auswahl auf), ein zweites auf denselben Knoten innerhalb
    /// von `doubleTapInterval` zentriert dort.
    private func tap(_ id: String?) {
        let now = Date()
        if let id, let last = lastTap, last.id == id, now.timeIntervalSince(last.at) <= Self.doubleTapInterval {
            lastTap = nil
            recenter(id)
            return
        }
        lastTap = id.map { LastTap(id: $0, at: now) }
        select(id)
    }

    private func drag(_ scene: GraphScreenScene, size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                // Zwei Finger: der Zoom führt; danach geht es ab der neuen Lage weiter.
                guard pinchStart == nil else {
                    if case .node = mode { sim.endDrag() }
                    mode = nil
                    return
                }
                switch mode {
                case nil:
                    if let id = scene.hit(value.startLocation, in: size) {
                        mode = .node(id)
                        sim.beginDrag(id)
                        sim.drag(to: value.location)
                    } else {
                        mode = .pan(sim.camera, value.translation)
                    }
                case .node?:
                    sim.drag(to: value.location)
                case .pan(let start, let base)?:
                    var camera = start
                    camera.offset.width += value.translation.width - base.width
                    camera.offset.height += value.translation.height - base.height
                    sim.setCamera(camera)
                }
            }
            .onEnded { _ in
                if case .node? = mode { sim.endDrag() }
                mode = nil
            }
    }

    private func pinch(size: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let start = pinchStart ?? sim.camera
                if pinchStart == nil { pinchStart = start }
                sim.setCamera(start.zoomed(by: value.magnification, anchor: value.startLocation, in: size))
            }
            .onEnded { _ in pinchStart = nil }
    }
}
