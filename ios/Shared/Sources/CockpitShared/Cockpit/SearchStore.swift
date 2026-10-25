import Foundation
import Observation

/// Suche im Vault wie im Web: ab zwei Zeichen live (180 ms nach dem letzten Tippen) die besten
/// acht Treffer, „Alle N Treffer zeigen“ bzw. Eingabe lädt die ganze Liste. Die letzte Eingabe
/// gewinnt: Antworten zu älteren Begriffen fallen weg.
@MainActor
@Observable
public final class SearchStore {
    /// Suchbegriff; jede Änderung plant die Live-Suche neu.
    public var query = "" {
        didSet {
            guard query != oldValue else { return }
            if let full, full.query != trimmedQuery { self.full = nil }
            scheduleLive()
        }
    }
    /// Beste Treffer zum aktuellen Begriff (höchstens acht), nil unter zwei Zeichen.
    public private(set) var live: SearchModel?
    /// Alle Treffer (nach `showAll`), nil sonst.
    public private(set) var full: SearchModel?
    /// Live-Suche läuft.
    public private(set) var isSearching = false
    /// Ganze Liste lädt.
    public private(set) var isLoadingAll = false
    /// Fehler der letzten Suche, z. B. „Keine Verbindung zum Cockpit.“
    public private(set) var error: CockpitError?

    /// Ab so vielen Zeichen sucht die App live.
    public static let minLength = 2
    /// Eingrenzung auf einen Notiztyp (z. B. `synthesis`), nil = alle.
    public let type: String?
    private let delay: TimeInterval
    private let context: CockpitContext
    @ObservationIgnored private var liveTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0

    public init(context: CockpitContext, type: String? = nil, debounce: TimeInterval = 0.18) {
        self.context = context
        self.type = type
        delay = debounce
    }

    public var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Lang genug für die Live-Suche.
    public var isActive: Bool { trimmedQuery.count >= Self.minLength }
    /// „Bedeutungssuche gerade nicht verfügbar, nur Volltext“, sonst nil.
    public var degraded: String? { full?.degraded ?? live?.degraded }
    /// Treffer zum Zeigen: die ganze Liste, wenn geladen, sonst die besten.
    public var results: [SearchHit] { full?.results ?? live?.results ?? [] }
    /// Mehr Treffer als gezeigt („Alle N Treffer zeigen“).
    public var hasMore: Bool { full == nil && (live?.hasMore ?? false) }
    /// Anzahl aller Treffer zum Begriff.
    public var total: Int { full?.total ?? live?.total ?? 0 }
    /// Treffer führen zur Notizseite (sonst zum Graphen).
    public var opensNotes: Bool { (full ?? live)?.notes ?? true }

    // MARK: Suchen

    /// Suchseite mit Begriff (`/graph?q=…`): Begriff setzen und gleich alle Treffer laden.
    public func open(query: String) async {
        self.query = query
        if !trimmedQuery.isEmpty { await showAll() }
    }

    /// „Alle N Treffer zeigen“ oder Eingabe: die ganze Liste zum aktuellen Begriff.
    public func showAll() async {
        let q = trimmedQuery
        guard !q.isEmpty else { return }
        liveTask?.cancel()
        isSearching = false
        generation += 1
        let mine = generation
        isLoadingAll = true
        defer { if mine == generation { isLoadingAll = false } }
        do {
            let result = try await context.api.search(q, all: true, type: type)
            guard mine == generation else { return }
            full = result
            live = result
            error = nil
        } catch {
            guard mine == generation else { return }
            handle(error)
        }
    }

    /// Leert Begriff und Treffer.
    public func clear() {
        liveTask?.cancel()
        generation += 1
        query = ""
        live = nil
        full = nil
        error = nil
        isSearching = false
        isLoadingAll = false
    }

    private func scheduleLive() {
        liveTask?.cancel()
        generation += 1
        let mine = generation
        guard isActive else {
            live = nil
            error = nil
            isSearching = false
            return
        }
        let q = trimmedQuery
        let wait = UInt64(max(0, delay) * 1_000_000_000)
        isSearching = true
        liveTask = Task { [weak self] in
            if wait > 0 { try? await Task.sleep(nanoseconds: wait) }
            guard !Task.isCancelled else { return }
            await self?.runLive(q, generation: mine)
        }
    }

    private func runLive(_ q: String, generation mine: Int) async {
        do {
            let result = try await context.api.search(q, all: false, type: type)
            guard mine == generation else { return }
            live = result
            error = nil
        } catch {
            guard mine == generation else { return }
            handle(error)
        }
        isSearching = false
    }

    private func handle(_ error: Error) {
        guard !CockpitError.isCancellation(error) else { return }
        let error = CockpitError.from(error, action: false)
        self.error = error
        if error.isUnauthorized { context.onUnauthorized() }
    }
}
