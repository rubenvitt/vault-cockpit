import CockpitShared
import Foundation
import Observation

/// Ausschnitt des Graphen: Bildschirmpunkt = Mitte der Fläche + Lage · `scale` + `offset`.
struct GraphScreenCamera: Equatable, Sendable {
    var scale: CGFloat = 1
    var offset: CGSize = .zero

    static let minScale: CGFloat = 0.15
    static let maxScale: CGFloat = 4
    /// Einpassen vergrößert höchstens so weit (kleine Graphen nicht riesig).
    static let fitMaxScale: CGFloat = 1.5

    init(scale: CGFloat = 1, offset: CGSize = .zero) {
        self.scale = min(Self.maxScale, max(Self.minScale, scale))
        self.offset = offset
    }

    func screen(_ point: CGPoint, in size: CGSize) -> CGPoint {
        CGPoint(x: size.width / 2 + point.x * scale + offset.width, y: size.height / 2 + point.y * scale + offset.height)
    }

    func graph(_ point: CGPoint, in size: CGSize) -> CGPoint {
        CGPoint(x: (point.x - size.width / 2 - offset.width) / scale, y: (point.y - size.height / 2 - offset.height) / scale)
    }

    /// Zoomt um `factor`; der Bildschirmpunkt `anchor` bleibt, wo er ist (Finger, Fläche).
    func zoomed(by factor: CGFloat, anchor: CGPoint, in size: CGSize) -> GraphScreenCamera {
        let fixed = graph(anchor, in: size)
        let next = GraphScreenCamera(scale: scale * factor)
        let offset = CGSize(
            width: anchor.x - size.width / 2 - fixed.x * next.scale,
            height: anchor.y - size.height / 2 - fixed.y * next.scale
        )
        return GraphScreenCamera(scale: next.scale, offset: offset)
    }

    /// Ausschnitt, der `rect` (Lagen) mit Rand `padding` in `size` zeigt.
    static func fitting(_ rect: CGRect, in size: CGSize, padding: CGFloat) -> GraphScreenCamera {
        let width = max(size.width - 2 * padding, 40)
        let height = max(size.height - 2 * padding, 40)
        let scale = min(fitMaxScale, width / max(rect.width, 1), height / max(rect.height, 1))
        let clamped = GraphScreenCamera(scale: scale).scale
        return GraphScreenCamera(scale: clamped, offset: CGSize(width: -rect.midX * clamped, height: -rect.midY * clamped))
    }

    /// Ein Stück weiter Richtung `target` (0…1).
    func approaching(_ target: GraphScreenCamera, _ t: CGFloat) -> GraphScreenCamera {
        var next = self
        next.scale += (target.scale - scale) * t
        next.offset.width += (target.offset.width - offset.width) * t
        next.offset.height += (target.offset.height - offset.height) * t
        return next
    }

    func isClose(to other: GraphScreenCamera) -> Bool {
        abs(scale - other.scale) < 0.002 && abs(offset.width - other.offset.width) < 0.5 && abs(offset.height - other.offset.height) < 0.5
    }
}

/// Physik und Ausschnitt eines Graphen auf dem Bildschirm. Läuft in Schritten von 1/60 s, solange
/// sich etwas bewegt (angestoßen, gezogen, Kamera unterwegs), und hält dann an. Der erste Aufbau
/// rechnet abseits des Main Actors vor; mit „Bewegung reduzieren“ springt alles gleich in die
/// Ruhelage. Merkt sich die Lage von Knoten, die beim Wechsel der Mitte verschwinden.
@MainActor
@Observable
final class GraphScreenSimulation {
    private(set) var physics = GraphScreenPhysics()
    private(set) var camera = GraphScreenCamera()

    /// Größe der Fläche; setzt die Ansicht.
    @ObservationIgnored var size: CGSize = .zero
    /// Ohne Animation: Physik vorrechnen, Kamera springt.
    @ObservationIgnored var reduceMotion = false
    /// Zum Einpassen: nur sichtbare Knoten (Legende); nil = alle.
    @ObservationIgnored var visibleIDs: Set<String>?
    /// Die Kamera folgt dem Graphen, bis man selbst verschiebt oder zoomt („Alles zeigen“
    /// schaltet es wieder ein).
    @ObservationIgnored private(set) var follows = true
    /// Knoten unter dem Finger.
    @ObservationIgnored private(set) var dragged: String?

    @ObservationIgnored private var target: GraphScreenCamera?
    @ObservationIgnored private var frames = 0
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var loopID = 0
    @ObservationIgnored private var remembered: [String: CGPoint] = [:]
    @ObservationIgnored private var topology: [String] = []
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var center: String?

    static let padding: CGFloat = 44
    static let frame: UInt64 = 16_666_667

    init() {}

    // MARK: Aufbau

    /// Übernimmt Knoten und Kanten aus dem Store. Neue Knoten starten neben dem Knoten, aus dessen
    /// Nachbarschaft sie kamen (`near`), sonst neben einem Nachbarn oder im Kreis um die Mitte.
    func sync(nodes: [GraphNode], edges: [GraphEdge], center: String, near: [String: String]) {
        let key = nodes.map(\.id) + ["|"] + edges.map { "\($0.id)#\($0.kind.rawValue)" } + ["@" + center]
        guard key != topology else { return }
        topology = key
        generation += 1
        for (id, point) in physics.positions { remembered[id] = point }
        let first = physics.isEmpty
        let centerChanged = self.center != nil && self.center != center
        self.center = center
        if centerChanged { follows = true }

        // Nachbarn je Knoten, für die Startlage ohne `near`.
        var neighbours: [String: [String]] = [:]
        for edge in edges {
            neighbours[edge.from, default: []].append(edge.to)
            neighbours[edge.to, default: []].append(edge.from)
        }
        var placed: [String: CGPoint] = [:]
        // Bekannte zuerst, damit neue sich an ihnen ausrichten.
        for node in nodes {
            if let known = remembered[node.id] { placed[node.id] = known }
        }
        if placed[center] == nil { placed[center] = .zero }
        for node in nodes where placed[node.id] == nil {
            if let origin = near[node.id].flatMap({ placed[$0] }) {
                placed[node.id] = GraphScreenPhysics.seed(node.id, around: origin, radius: 55)
            } else if let origin = neighbours[node.id]?.lazy.compactMap({ placed[$0] }).first {
                placed[node.id] = GraphScreenPhysics.seed(node.id, around: origin, radius: node.kind == .note ? 90 : 60)
            } else {
                placed[node.id] = GraphScreenPhysics.seed(node.id, around: .zero, radius: 100 + 50 * Double(max(0, node.level - 1)))
            }
        }
        // Die Mitte liegt im Ursprung; alles andere rückt mit.
        let shift = placed[center] ?? .zero
        let ids = nodes.map(\.id)
        let positions = ids.map { id -> CGPoint in
            let p = placed[id] ?? .zero
            return CGPoint(x: p.x - shift.x, y: p.y - shift.y)
        }
        if shift != .zero, !centerChanged {
            // Gleiche Mitte, nur verrutscht: der Ausschnitt rückt mit, nichts springt.
            camera.offset.width += shift.x * camera.scale
            camera.offset.height += shift.y * camera.scale
        }
        var index: [String: Int] = [:]
        for (i, id) in ids.enumerated() where index[id] == nil { index[id] = i }
        let springs: [(Int, Int, GraphScreenPhysics.Kind)] = edges.compactMap { edge in
            guard let a = index[edge.from], let b = index[edge.to], a != b else { return nil }
            switch edge.kind {
            case .link: return (a, b, .link)
            case .semantic: return (a, b, .semantic)
            case .task, .event: return (a, b, .satellite)
            }
        }
        var pinned: Set<Int> = []
        if let c = index[center] { pinned.insert(c) }
        if let dragged, let d = index[dragged] { pinned.insert(d) } else { dragged = nil }
        physics = GraphScreenPhysics(ids: ids, positions: positions, edges: springs, pinned: pinned)

        if first || reduceMotion {
            prepare(steps: reduceMotion ? 320 : 110, then: reduceMotion ? 0 : 70)
        } else {
            physics.heat(0.8)
            settle(140)
        }
    }

    /// Rechnet `steps` Schritte im Hintergrund vor, dann sichtbar `frames` weiter (0 = fertig).
    private func prepare(steps: Int, then frames: Int) {
        var start = physics
        start.heat(1)
        let ready = start
        let mine = generation
        Task { [weak self] in
            let done = await Task.detached(priority: .userInitiated) { () -> GraphScreenPhysics in
                var physics = ready
                physics.run(steps)
                return physics
            }.value
            guard let self, mine == self.generation else { return }
            self.physics = done
            if self.follows { self.jump(to: self.fittingCamera()) }
            if frames > 0 {
                self.physics.heat(0.25)
                self.settle(frames)
            }
        }
    }

    // MARK: Bewegung

    /// Lässt die Physik bis zu `frames` Bilder sichtbar laufen (Reduce Motion: sofort zur Ruhe).
    func settle(_ frames: Int) {
        if reduceMotion {
            var physics = self.physics
            physics.run(frames * 2)
            self.physics = physics
            if follows { jump(to: fittingCamera()) }
            return
        }
        self.frames = max(self.frames, frames)
        startLoop()
    }

    /// „Physik anstoßen“: frisch heizen und laufen lassen.
    func kick() {
        physics.heat(0.9)
        settle(180)
    }

    /// Bildschirm weg: anhalten (die Lage bleibt).
    func stop() {
        loop?.cancel()
        loop = nil
        frames = 0
        target = nil
    }

    private func startLoop() {
        guard loop == nil else { return }
        loopID += 1
        let mine = loopID
        loop = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.tick() else { break }
                try? await Task.sleep(nanoseconds: GraphScreenSimulation.frame)
            }
            guard let self, self.loopID == mine else { return }
            self.loop = nil
        }
    }

    /// Ein Bild: Physik einen Schritt, Kamera ein Stück zum Ziel. false = alles ruht.
    private func tick() -> Bool {
        var busy = false
        if dragged != nil || (frames > 0 && !physics.isSettled) {
            if dragged != nil, physics.isSettled { physics.heat(0.08) }
            physics.step()
            frames = max(0, frames - 1)
            busy = dragged != nil || (frames > 0 && !physics.isSettled)
        } else {
            frames = 0
        }
        if follows, dragged == nil, size != .zero { target = fittingCamera() }
        if let target {
            if camera.isClose(to: target) {
                camera = target
                self.target = nil
            } else {
                camera = camera.approaching(target, 0.2)
                busy = true
            }
        }
        return busy
    }

    // MARK: Kamera

    /// „Alles zeigen“: einpassen und dem Graphen wieder folgen.
    func fit() {
        follows = true
        move(to: fittingCamera())
    }

    /// Plus- und Minus-Knopf: um die Mitte der Fläche.
    func zoom(by factor: CGFloat) {
        follows = false
        let base = target ?? camera
        move(to: base.zoomed(by: factor, anchor: CGPoint(x: size.width / 2, y: size.height / 2), in: size))
    }

    /// Verschieben und Zoomen mit den Fingern: sofort, ohne Nachlaufen.
    func setCamera(_ camera: GraphScreenCamera) {
        follows = false
        target = nil
        self.camera = camera
    }

    private func move(to camera: GraphScreenCamera) {
        if reduceMotion {
            jump(to: camera)
        } else {
            target = camera
            startLoop()
        }
    }

    private func jump(to camera: GraphScreenCamera) {
        target = nil
        self.camera = camera
    }

    func fittingCamera() -> GraphScreenCamera {
        guard size != .zero else { return camera }
        var only: Set<Int>?
        if let visibleIDs {
            only = Set(visibleIDs.compactMap { physics.index[$0] })
        }
        guard let rect = physics.bounds(only) ?? physics.bounds() else { return camera }
        return GraphScreenCamera.fitting(rect, in: size, padding: Self.padding)
    }

    // MARK: Ziehen

    func beginDrag(_ id: String) {
        guard physics.index[id] != nil else { return }
        dragged = id
        physics.pin(id, true)
        physics.heat(0.15)
        startLoop()
    }

    /// Knoten folgt dem Finger (Bildschirmpunkt), die Nachbarn ziehen nach.
    func drag(to point: CGPoint) {
        guard let dragged else { return }
        physics.move(dragged, to: camera.graph(point, in: size))
        physics.heat(0.2)
        startLoop()
    }

    func endDrag() {
        guard let id = dragged else { return }
        dragged = nil
        if id != center { physics.pin(id, false) }
        physics.heat(0.3)
        settle(60)
    }
}
