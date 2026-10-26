import Foundation
import Observation

/// „Weiter“ (`/api/lesen/weiter`): wo jeder Text steht und was als Nächstes geht. Die Aktionen
/// sind die des Lesens (Ingest entwerfen, Nur in den Vault, Fertig, weg, Folge als gehört,
/// Erneut entwerfen bzw. einpflanzen); danach lädt die Seite neu, weil ein Text dabei die Stufe
/// wechselt. Was verschwindet („Fertig, weg“, „Nur in den Vault“, „Als gehört markieren“), geht
/// sofort aus der Liste und kommt bei Ablehnung zurück; die Meldung hat „Rückgängig“.
@MainActor
@Observable
public final class WeiterStore {
    /// Einträge (`WeiterItem.id`), an denen gerade eine Aktion läuft.
    public private(set) var busy: Set<String> = []
    /// „Alle entwerfen lassen“ läuft.
    public private(set) var isDraftingAll = false

    private let remote: RemoteModel<WeiterModel>
    private let context: CockpitContext
    private var actions: ReadingActions { ReadingActions(context: context) }

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: "api/lesen/weiter")
    }

    public var model: WeiterModel? { remote.model }
    public var state: LoadState { remote.state }

    // MARK: Laden

    public func load() async {
        remote.select(key: "lesen/weiter", query: []) { _ in true }
        await refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    // MARK: Aktionen

    /// „Ins Wiki: entwerfen“ (Entscheiden) bzw. „Erneut entwerfen“ (Fehler, `force`).
    @discardableResult
    public func draft(_ item: WeiterItem, force: Bool = false) async -> Bool {
        guard let doc = item.doc else { return false }
        var fields = ["id": doc.id]
        if force { fields["force"] = "1" }
        return await run(item, IngestAction.draft, fields)
    }

    /// „Erneut einpflanzen“ nach einem Fehler beim Einpflanzen.
    @discardableResult
    public func plant(_ item: WeiterItem) async -> Bool {
        guard let doc = item.doc else { return false }
        return await run(item, IngestAction.plant, ["id": doc.id])
    }

    /// „Nur in den Vault“: Lesestapel-Notiz mit Volltext, archiviert. Mit Rückgängig.
    @discardableResult
    public func toVault(_ item: WeiterItem) async -> Bool {
        guard let doc = item.doc, model?.vault == true else { return false }
        return await run(item, ReadingAction.vault, ["id": doc.id, "volltext": "1"], remove: true)
    }

    /// „Fertig, weg“: gelesen, ohne Notiz. Mit Rückgängig.
    @discardableResult
    public func finish(_ item: WeiterItem) async -> Bool {
        guard let doc = item.doc else { return false }
        return await run(item, ReadingAction.finish, ["id": doc.id], remove: true)
    }

    /// „Als gehört markieren“ einer Folge unter „Anhören“. Mit Rückgängig.
    @discardableResult
    public func markHeard(_ item: WeiterItem) async -> Bool {
        guard let episode = item.episode else { return false }
        return await run(item, ReadingAction.episodeHeard, ["id": episode.id, "gehoert": "1"], remove: true)
    }

    /// „Alle entwerfen lassen“: Ingest für alle gelesenen Texte ohne Entwurf.
    @discardableResult
    public func draftAll() async -> Bool {
        guard (model?.draftable ?? 0) > 0, model?.ingestAvailable == true, !isDraftingAll else { return false }
        isDraftingAll = true
        defer { isDraftingAll = false }
        guard await actions.run(ReadingAction.draftAllRead, [:]) != nil else { return false }
        context.toasts.signal(.success)
        await refresh()
        return true
    }

    /// Spielt ein Rückgängig ab und lädt neu.
    @discardableResult
    public func replay(_ undo: UndoAction) async -> Bool {
        guard await actions.run(undo.action, undo.fields) != nil else { return false }
        await refresh()
        return true
    }

    /// Senden; mit `remove` ist der Eintrag sofort weg und kommt bei Ablehnung zurück.
    private func run(_ item: WeiterItem, _ path: String, _ fields: [String: String], remove: Bool = false) async -> Bool {
        guard let before = remote.model, !busy.contains(item.id) else { return false }
        busy.insert(item.id)
        defer { busy.remove(item.id) }
        if remove { remote.model?.remove(itemID: item.id) }
        context.toasts.signal(.selection)
        do {
            let response = try await actions.send(path, fields)
            context.toasts.signal(.success)
            actions.show(response) { [weak self] undo in
                Task { await self?.replay(undo) }
            }
            await refresh()
            return true
        } catch {
            if remove { remote.model = before }
            context.report(error)
            return false
        }
    }
}
