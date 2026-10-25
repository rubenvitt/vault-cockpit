import Foundation
import Observation

/// Was an den Feeds gerade läuft (Knöpfe sperren).
public enum FeedOperation: Hashable, Sendable {
    case subscribe
    case createGroup
    case importOPML
    case exportOPML
    /// Feed (ID) ändern oder entfernen.
    case feed(String)
    /// Gruppe (ID) ändern, verschieben oder löschen.
    case group(String)
    /// Aktion für alle abgehakten Feeds (Sammeln).
    case bulk
}

/// Feeds und Gruppen: abonnieren, Einstellungen je Feed, Gruppen anlegen, ändern, sortieren
/// und löschen, OPML importieren und exportieren. Nach jeder Aktion lädt die Liste neu;
/// Verschieben ändert die Reihenfolge sofort und nimmt sie zurück, wenn der Server ablehnt.
///
/// Sammeln (VCP-110, „Feeds gesammelt bearbeiten“ im Web): Feeds abhaken (`selection`), mit
/// `filter` suchen oder auf die mit Fehlern beschränken, „Alle auswählen“ für die sichtbaren, dann
/// `applyBulk` für alle abgehakten auf einmal.
@MainActor
@Observable
public final class FeedsStore {
    public private(set) var busy: Set<FeedOperation> = []
    /// Zuletzt exportierte OPML-Datei (zum Teilen).
    public private(set) var exportedFile: URL?
    /// Abgehakte Feeds (IDs). Auch ausgefilterte bleiben abgehakt, wie im Web.
    public private(set) var selection: Set<String> = []
    /// Suche und „Nur mit Fehlern“.
    public var filter = FeedFilter()

    private let remote: RemoteModel<FeedsModel>
    private let context: CockpitContext
    private var runner: ReplyRunner { ReplyRunner(context: context) }

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: "api/lesen/feeds")
    }

    public var model: FeedsModel? { remote.model }
    public var state: LoadState { remote.state }
    public var limits: FeedLimits? { model?.limits }

    public func isBusy(_ operation: FeedOperation) -> Bool { busy.contains(operation) }

    // MARK: Laden

    public func load() async {
        remote.select(key: "lesen/feeds", query: []) { _ in true }
        await remote.refresh()
    }

    public func refresh() async {
        await remote.refresh()
        pruneSelection()
    }

    // MARK: Auswahl und Filter

    /// Sichtbare Feeds aus `feeds` (nach `filter`).
    public func visible(_ feeds: [ReadingFeed]) -> [ReadingFeed] {
        model?.matching(feeds, filter) ?? feeds
    }

    /// Alle sichtbaren Feeds in der Reihenfolge der Liste.
    public var visibleFeeds: [ReadingFeed] {
        guard let model else { return [] }
        return model.matching(model.allFeeds, filter)
    }

    public func isSelected(_ feed: ReadingFeed) -> Bool { selection.contains(feed.id) }

    /// Abgehakte Feeds, die es noch gibt, in der Reihenfolge der Liste.
    public var selectedFeeds: [ReadingFeed] {
        model?.allFeeds.filter { selection.contains($0.id) } ?? []
    }

    public var selectedCount: Int { selectedFeeds.count }

    /// „1 Feed abgehakt“ / „3 Feeds abgehakt“
    public var selectionText: String { "\(FeedFilter.feedsWord(selectedCount)) abgehakt" }

    /// Alle sichtbaren sind abgehakt (dann bietet die Leiste „Keine auswählen“ an).
    public var allVisibleSelected: Bool {
        let shown = visibleFeeds
        return !shown.isEmpty && shown.allSatisfy { selection.contains($0.id) }
    }

    public func toggleSelection(_ feed: ReadingFeed) {
        if selection.contains(feed.id) { selection.remove(feed.id) } else { selection.insert(feed.id) }
    }

    public func setSelected(_ feed: ReadingFeed, _ selected: Bool) {
        if selected { selection.insert(feed.id) } else { selection.remove(feed.id) }
    }

    /// „Alle auswählen“: hakt alle sichtbaren ab (ausgefilterte Häkchen bleiben).
    public func selectAllVisible() {
        selection.formUnion(visibleFeeds.map(\.id))
    }

    /// „Keine auswählen“
    public func selectNone() {
        selection.removeAll()
    }

    /// Häkchen von Feeds, die es nicht mehr gibt, vergessen.
    private func pruneSelection() {
        guard let model, !selection.isEmpty else { return }
        let ids = Set(model.allFeeds.map(\.id))
        let kept = selection.intersection(ids)
        if kept != selection { selection = kept }
    }

    // MARK: Sammeln

    /// Eine Aktion für alle abgehakten Feeds (`/aktion/lesen/feeds/auswahl`). Danach lädt die
    /// Liste neu, die Meldung des Servers kommt als Toast und die Häkchen sind weg. Der Abstand
    /// wird in die Grenzen gelegt; „Entfernen“ geht mit `bestaetigt=1`, die App fragt vorher.
    @discardableResult
    public func applyBulk(_ action: FeedBulkAction) async -> Bool {
        let ids = selectedFeeds.map(\.id)
        guard !ids.isEmpty else { return reject("Bitte zuerst Feeds abhaken") }
        var action = action
        switch action {
        case .move(.newGroup(let name)):
            guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return reject("Bitte einen Namen eingeben") }
        case .interval(let minutes):
            let limits = model?.limits
            action = .interval(min(limits?.maxInterval ?? 1440, max(limits?.minInterval ?? 5, minutes)))
        default:
            break
        }
        guard !busy.contains(.bulk) else { return false }
        busy.insert(.bulk)
        defer { busy.remove(.bulk) }
        let bulk = model?.bulk ?? .fallback
        do {
            let response = try await context.api.action(bulk.action, pairs: action.pairs(feeds: ids, newGroup: bulk.newGroup), as: MessageReply.self)
            context.toasts.signal(.success)
            if !response.message.isEmpty { context.toasts.show(response.message) }
            selection.removeAll()
            await refresh()
            return true
        } catch {
            context.report(error)
            return false
        }
    }

    // MARK: Feeds

    /// „Abonnieren“: Adresse eines Feeds oder einer Website (der Server sucht den Feed), optional
    /// gleich in eine Gruppe. 502, wenn die Adresse nicht erreichbar ist.
    @discardableResult
    public func subscribe(url: String, groupId: String? = nil) async -> Bool {
        let url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { return reject("Bitte eine Adresse eingeben") }
        var fields = ["url": url]
        if let groupId, !groupId.isEmpty { fields["gruppe"] = groupId }
        return await perform(.subscribe, FeedAction.subscribe, fields, success: true)
    }

    /// Einstellungen eines Feeds speichern (Pause, Stapel, Filter, Abstand, Gruppe). Der Abstand
    /// wird in die Grenzen gelegt (5–1440 Minuten).
    @discardableResult
    public func update(_ feed: ReadingFeed, _ settings: FeedSettings) async -> Bool {
        var settings = settings
        let limits = model?.limits
        settings.intervalMinutes = min(limits?.maxInterval ?? 1440, max(limits?.minInterval ?? 5, settings.intervalMinutes))
        return await perform(.feed(feed.id), FeedAction.update, settings.fields(id: feed.id))
    }

    /// „Feed entfernen“; gespeicherte Artikel bleiben.
    @discardableResult
    public func remove(_ feed: ReadingFeed) async -> Bool {
        await perform(.feed(feed.id), FeedAction.remove, ["id": feed.id])
    }

    // MARK: Gruppen

    /// „Gruppe anlegen“
    @discardableResult
    public func createGroup(name: String) async -> Bool {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return reject("Bitte einen Namen eingeben") }
        return await perform(.createGroup, FeedAction.createGroup, ["name": name], success: true)
    }

    /// „Gruppe bearbeiten“: Name, Pause und „direkt auf den Stapel“ für alle ihre Feeds.
    @discardableResult
    public func updateGroup(_ group: FeedGroup, name: String, paused: Bool, toStack: Bool) async -> Bool {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return reject("Bitte einen Namen eingeben") }
        var fields = ["id": group.id, "name": name]
        if paused { fields["pausiert"] = "1" }
        if toStack { fields["stapel"] = "1" }
        return await perform(.group(group.id), FeedAction.updateGroup, fields)
    }

    /// „Nach oben“ / „Nach unten“, sofort sichtbar.
    @discardableResult
    public func moveGroup(_ group: FeedGroup, up: Bool) async -> Bool {
        guard let before = remote.model, let i = before.groups.firstIndex(where: { $0.id == group.id }) else { return false }
        let j = up ? i - 1 : i + 1
        guard before.groups.indices.contains(j), !busy.contains(.group(group.id)) else { return false }
        var moved = before
        moved.groups.swapAt(i, j)
        moved.renumber()
        remote.model = moved
        context.toasts.signal(.selection)
        let ok = await perform(.group(group.id), FeedAction.moveGroup, ["id": group.id, "richtung": up ? "hoch" : "runter"], toast: false)
        if !ok, remote.model == moved { remote.model = before }
        return ok
    }

    /// „Gruppe löschen“; ihre Feeds bleiben, dann ohne Gruppe.
    @discardableResult
    public func removeGroup(_ group: FeedGroup) async -> Bool {
        await perform(.group(group.id), FeedAction.removeGroup, ["id": group.id])
    }

    // MARK: OPML

    /// OPML importieren (höchstens 2 MB); Ordner werden Gruppen.
    @discardableResult
    public func importOPML(_ data: Data, filename: String = "feeds.opml") async -> Bool {
        guard !data.isEmpty else { return reject("Bitte eine OPML-Datei wählen") }
        let limit = model?.limits.maxOpmlBytes ?? 2 * 1024 * 1024
        guard data.count <= limit else { return reject("Die Datei ist zu groß (höchstens \(limit / 1024 / 1024) MB).") }
        guard !busy.contains(.importOPML) else { return false }
        busy.insert(.importOPML)
        defer { busy.remove(.importOPML) }
        do {
            let file = UploadFile(filename: filename.isEmpty ? "feeds.opml" : filename, contentType: "text/x-opml", data: data)
            let response = try await context.api.upload(FeedAction.importOPML, fields: [:], file: file, as: MessageReply.self)
            context.toasts.signal(.success)
            context.toasts.show(response.message)
            await refresh()
            return true
        } catch {
            context.report(error)
            return false
        }
    }

    /// OPML aus einer Datei (Dokumenten-Picker; Zugriff vorher freigeben).
    @discardableResult
    public func importOPML(file url: URL) async -> Bool {
        guard let data = try? Data(contentsOf: url) else { return reject("Die Datei lässt sich nicht lesen.") }
        return await importOPML(data, filename: url.lastPathComponent)
    }

    /// „Als OPML exportieren“: legt `feeds.opml` zum Teilen ab.
    @discardableResult
    public func exportOPML() async -> URL? {
        guard !busy.contains(.exportOPML) else { return nil }
        busy.insert(.exportOPML)
        defer { busy.remove(.exportOPML) }
        do {
            let download = try await context.api.download(Self.relative(model?.opml ?? "/api/lesen/feeds.opml"))
            let url = try download.write(to: ShareFiles.directory("Feeds"), name: download.filename ?? "feeds.opml")
            exportedFile = url
            return url
        } catch {
            context.report(error, action: false)
            return nil
        }
    }

    // MARK: Aktionen

    private func perform(_ operation: FeedOperation, _ path: String, _ fields: [String: String], success: Bool = false, toast: Bool = true) async -> Bool {
        guard !busy.contains(operation) else { return false }
        busy.insert(operation)
        defer { busy.remove(operation) }
        do {
            let response = try await context.api.action(path, fields: fields, as: MessageReply.self)
            if success { context.toasts.signal(.success) }
            if toast, !response.message.isEmpty { context.toasts.show(response.message) }
            await refresh()
            return true
        } catch {
            context.report(error)
            return false
        }
    }

    private func reject(_ message: String) -> Bool {
        context.toasts.signal(.error)
        context.toasts.error(message)
        return false
    }

    private static func relative(_ path: String) -> String {
        let path = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return path.hasPrefix("/") ? String(path.dropFirst()) : path
    }
}
