import Foundation
import Observation

/// Wissen: Synthesen nach Frage, Querverbindung, Status und „Passt zu meinem Lesen“, dazu
/// „Zuletzt bewegt“. Jeder Filter hat seinen gespeicherten Stand.
@MainActor
@Observable
public final class WissenStore {
    /// Gezeigte Auswahl (die zuletzt geladene).
    public private(set) var query = WissenQuery()

    private let remote: RemoteModel<WissenModel>

    public init(context: CockpitContext) {
        remote = RemoteModel(context: context, path: "api/wissen")
    }

    public var model: WissenModel? { remote.model }
    public var state: LoadState { remote.state }

    /// Lädt mit Filter (gespeicherter Stand zuerst); ohne Treffer bleibt die vorige Liste
    /// sichtbar, bis die neue da ist.
    public func load(_ query: WissenQuery = WissenQuery()) async {
        var query = query
        query.q = query.q.trimmingCharacters(in: .whitespacesAndNewlines)
        self.query = query
        remote.select(key: Self.cacheKey(query), query: CockpitAPI.wissenQuery(query)) { _ in true }
        await remote.refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    static func cacheKey(_ query: WissenQuery) -> String {
        guard !query.isEmpty else { return "wissen" }
        return "wissen/\(CockpitAPI.formBody(Dictionary(uniqueKeysWithValues: CockpitAPI.wissenQuery(query).map { ($0.name, $0.value ?? "") })))"
    }
}

/// Zustand der Dienste; „Neu prüfen“ lädt neu (der Server prüft Zunder und Kalender frisch).
@MainActor
@Observable
public final class HealthStore {
    private let remote: RemoteModel<HealthModel>

    public init(context: CockpitContext) {
        remote = RemoteModel(context: context, path: "api/zustand")
    }

    public var model: HealthModel? { remote.model }
    public var state: LoadState { remote.state }
    /// Gestörte Dienste (leer = alles läuft).
    public var failing: [ServiceAlert] { model?.failing ?? [] }
    /// „Neu prüfen“ läuft.
    public var isChecking: Bool { remote.state.isRefreshing }

    public func load() async {
        remote.select(key: "zustand", query: []) { _ in true }
        await remote.refresh()
    }

    /// „Neu prüfen“
    public func recheck() async {
        await remote.refresh()
    }
}
