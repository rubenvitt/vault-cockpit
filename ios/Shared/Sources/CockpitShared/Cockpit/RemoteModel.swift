import Foundation
import Observation

/// Modell eines Bildschirms mit Zwischenspeicher: zeigt sofort den gespeicherten Stand und
/// lädt dann neu. Wechselt der Bildschirm (andere Woche), gewinnt immer die letzte Anfrage.
@MainActor
@Observable
final class RemoteModel<Model: Decodable> {
    var model: Model?
    var state = LoadState()

    private let context: CockpitContext
    private let path: String
    @ObservationIgnored private var key = ""
    @ObservationIgnored private var query: [URLQueryItem] = []
    @ObservationIgnored private var generation = 0

    init(context: CockpitContext, path: String) {
        self.context = context
        self.path = path
    }

    /// Wechselt auf `key`: gespeicherter Stand, sonst bleibt das Modell nur, wenn `keep` es erlaubt.
    func select(key: String, query: [URLQueryItem], keep: (Model) -> Bool) {
        generation += 1
        self.key = key
        self.query = query
        state.error = nil
        if let cached = context.cached(Model.self, key: key) {
            model = cached.value
            state.lastUpdated = cached.savedAt
            state.isStale = true
        } else if let model, keep(model) {
            state.isStale = true
        } else {
            model = nil
            state.lastUpdated = nil
            state.isStale = false
        }
    }

    /// Lädt den gewählten Stand neu. Ohne Netz bleibt der gezeigte Stand (`isStale`).
    func refresh() async {
        let mine = generation
        state.isRefreshing = true
        do {
            let fresh = try await context.fetch(Model.self, path: path, query: query, key: key)
            guard mine == generation else { return }
            model = fresh.value
            state.lastUpdated = fresh.savedAt
            state.isStale = false
            state.error = nil
        } catch {
            guard mine == generation else { return }
            // Bildschirm weg, bevor die Antwort kam: Der gezeigte Stand bleibt, kein Fehler.
            if !CockpitError.isCancellation(error) {
                let error = CockpitError.from(error, action: false)
                state.error = error
                if error.isUnauthorized { context.onUnauthorized() }
            }
        }
        state.isRefreshing = false
    }
}

/// Aktionen aller Stores: senden, Meldung mit „Rückgängig“ zeigen, Fehler melden.
@MainActor
struct ActionRunner {
    let context: CockpitContext

    /// Sendet `path` mit `fields`. Bei Erfolg Meldung (mit Rückgängig, wenn `offerUndo` und der
    /// Server eines liefert); bei Fehler Meldung, die stehen bleibt. nil bei Fehler.
    func run(_ path: String, _ fields: [String: String], offerUndo: Bool = true, undo: @escaping @MainActor (UndoAction) -> Void) async -> ActionResponse? {
        do {
            let response = try await context.api.action(path, fields: fields)
            if offerUndo, let action = response.undo {
                context.toasts.show(response.message, action: Toast.Action(label: "Rückgängig") { undo(action) })
            } else {
                context.toasts.show(response.message)
            }
            return response
        } catch {
            context.report(error)
            return nil
        }
    }
}
