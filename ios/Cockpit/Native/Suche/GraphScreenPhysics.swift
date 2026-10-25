import Foundation

/// Kräfte für die Lage der Knoten im Graphen (wie ForceAtlas2 im Web, nur einfacher): Knoten
/// stoßen sich ab, Kanten ziehen wie Federn auf ihre Länge, eine schwache Schwerkraft hält alles
/// bei der Mitte. Die Mitte bleibt im Ursprung. Nur Werte, damit ein Durchlauf auch abseits des
/// Main Actors rechnen kann.
struct GraphScreenPhysics: Sendable {
    /// Feder zwischen zwei Knoten (Indizes).
    struct Spring: Sendable, Equatable {
        var a: Int
        var b: Int
        var length: Double
        var strength: Double
    }

    private(set) var ids: [String] = []
    private(set) var index: [String: Int] = [:]
    private(set) var x: [Double] = []
    private(set) var y: [Double] = []
    private var vx: [Double] = []
    private var vy: [Double] = []
    private(set) var springs: [Spring] = []
    /// Bewegen sich nicht (Mitte, gezogener Knoten).
    private(set) var pinned: Set<Int> = []
    /// Temperatur: 1 = frisch angestoßen, unter `restAlpha` ruht der Graph.
    private(set) var alpha: Double = 0

    static let repulsion = 5200.0
    static let gravity = 0.012
    static let damping = 0.55
    static let maxSpeed = 36.0
    static let cooling = 0.965
    static let restAlpha = 0.02

    init() {}

    /// Knoten mit Startlage; `edges` als Indexpaare mit Art (für Länge und Stärke der Feder).
    init(ids: [String], positions: [CGPoint], edges: [(Int, Int, Kind)], pinned: Set<Int>) {
        self.ids = ids
        index = Dictionary(ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        x = positions.map { Double($0.x) }
        y = positions.map { Double($0.y) }
        vx = Array(repeating: 0, count: ids.count)
        vy = Array(repeating: 0, count: ids.count)
        springs = edges.map { Spring(a: $0.0, b: $0.1, length: $0.2.length, strength: $0.2.strength) }
        self.pinned = pinned
    }

    /// Art einer Feder: Links kurz und straff, „ähnlich“ länger und lockerer, Aufgaben und Termine
    /// dicht an ihrer Notiz.
    enum Kind: Sendable {
        case link, semantic, satellite

        var length: Double {
            switch self {
            case .link: 95
            case .semantic: 135
            case .satellite: 62
            }
        }

        var strength: Double {
            switch self {
            case .link: 0.06
            case .semantic: 0.03
            case .satellite: 0.08
            }
        }
    }

    var count: Int { ids.count }
    var isEmpty: Bool { ids.isEmpty }
    var isSettled: Bool { alpha < Self.restAlpha }

    func position(of id: String) -> CGPoint? {
        guard let i = index[id] else { return nil }
        return CGPoint(x: x[i], y: y[i])
    }

    func position(at i: Int) -> CGPoint {
        CGPoint(x: x[i], y: y[i])
    }

    /// Alle Lagen nach Id (zum Merken, wenn sich der Graph ändert).
    var positions: [String: CGPoint] {
        var result: [String: CGPoint] = [:]
        for (i, id) in ids.enumerated() { result[id] = CGPoint(x: x[i], y: y[i]) }
        return result
    }

    /// Umschließendes Rechteck der Knoten mit den Indizes `only` (nil = alle).
    func bounds(_ only: Set<Int>? = nil) -> CGRect? {
        var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
        for i in 0..<count where only?.contains(i) ?? true {
            minX = min(minX, x[i]); maxX = max(maxX, x[i])
            minY = min(minY, y[i]); maxY = max(maxY, y[i])
        }
        guard minX.isFinite else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    // MARK: Anstoßen und Ziehen

    /// Weckt die Physik auf (mindestens `alpha`).
    mutating func heat(_ value: Double) {
        alpha = max(alpha, min(1, value))
    }

    mutating func move(_ id: String, to point: CGPoint) {
        guard let i = index[id] else { return }
        x[i] = Double(point.x)
        y[i] = Double(point.y)
        vx[i] = 0
        vy[i] = 0
    }

    mutating func pin(_ id: String, _ on: Bool) {
        guard let i = index[id] else { return }
        if on { pinned.insert(i) } else { pinned.remove(i) }
    }

    /// Verschiebt alle Knoten (die neue Mitte in den Ursprung).
    mutating func shift(by dx: Double, _ dy: Double) {
        for i in 0..<count {
            x[i] += dx
            y[i] += dy
        }
    }

    // MARK: Rechnen

    /// `steps` Schritte am Stück, endet früher, wenn der Graph ruht.
    mutating func run(_ steps: Int) {
        for _ in 0..<steps {
            guard !isSettled else { return }
            step()
        }
    }

    /// Ein Schritt: Kräfte summieren, Geschwindigkeit dämpfen, bewegen, abkühlen.
    mutating func step() {
        let n = count
        guard n > 0 else {
            alpha = 0
            return
        }
        var fx = [Double](repeating: 0, count: n)
        var fy = [Double](repeating: 0, count: n)

        // Abstoßung zwischen allen Paaren (bis 80 Knoten je Antwort, aufgeklappt einige Hundert).
        for i in 0..<n {
            for j in (i + 1)..<n {
                var dx = x[i] - x[j]
                var dy = y[i] - y[j]
                var d2 = dx * dx + dy * dy
                if d2 < 0.01 {
                    // Genau übereinander: feste, aber je Paar andere Richtung.
                    let angle = Double((i * 7919 + j * 104_729) % 360) * .pi / 180
                    dx = cos(angle)
                    dy = sin(angle)
                    d2 = 1
                }
                let d = d2.squareRoot()
                let force = Self.repulsion / max(d2, 100)
                let ux = dx / d * force
                let uy = dy / d * force
                fx[i] += ux; fy[i] += uy
                fx[j] -= ux; fy[j] -= uy
            }
        }

        // Federn entlang der Kanten.
        for spring in springs {
            let dx = x[spring.b] - x[spring.a]
            let dy = y[spring.b] - y[spring.a]
            let d = max((dx * dx + dy * dy).squareRoot(), 0.01)
            let force = (d - spring.length) * spring.strength
            let ux = dx / d * force
            let uy = dy / d * force
            fx[spring.a] += ux; fy[spring.a] += uy
            fx[spring.b] -= ux; fy[spring.b] -= uy
        }

        // Schwerkraft zum Ursprung, Bewegung mit Dämpfung.
        for i in 0..<n {
            guard !pinned.contains(i) else {
                vx[i] = 0
                vy[i] = 0
                continue
            }
            fx[i] -= x[i] * Self.gravity
            fy[i] -= y[i] * Self.gravity
            vx[i] = (vx[i] + fx[i] * alpha) * Self.damping
            vy[i] = (vy[i] + fy[i] * alpha) * Self.damping
            let speed = (vx[i] * vx[i] + vy[i] * vy[i]).squareRoot()
            if speed > Self.maxSpeed {
                vx[i] *= Self.maxSpeed / speed
                vy[i] *= Self.maxSpeed / speed
            }
            x[i] += vx[i]
            y[i] += vy[i]
        }
        alpha *= Self.cooling
        if alpha < Self.restAlpha { alpha = 0 }
    }

    // MARK: Startlage

    /// Feste Pseudo-Zufallszahl 0..<1 aus einer Id (FNV-1a), damit derselbe Graph gleich aufgeht.
    static func unit(_ id: String, salt: UInt64 = 0) -> Double {
        var hash: UInt64 = 0xCBF2_9CE4_8422_2325 ^ salt
        for byte in id.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return Double(hash % 10_000) / 10_000
    }

    /// Startlage eines neuen Knotens: im Kreis um `origin`, Winkel und Abstand aus der Id.
    static func seed(_ id: String, around origin: CGPoint, radius: Double) -> CGPoint {
        let angle = unit(id) * 2 * .pi
        let r = radius * (0.7 + 0.6 * unit(id, salt: 17))
        return CGPoint(x: Double(origin.x) + cos(angle) * r, y: Double(origin.y) + sin(angle) * r)
    }
}
