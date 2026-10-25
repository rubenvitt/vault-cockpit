import Foundation
import Observation

/// Entscheidung im Eingang (`ziel` bei `/aktion/lesen/sortieren`): „← Weg“, „↓ Stapel“,
/// „Jetzt lesen →“.
public enum InboxDecision: String, Sendable {
    case weg
    case stapel
    case lesen
}

/// Eingang: eine Karte nach der anderen sichten, Adressen und PDFs speichern (auch für
/// „Hinzufügen“).
///
/// Eine Entscheidung nimmt die Karte sofort weg (Zähler und „Rückgängig“ stimmen gleich), sendet
/// dann und lädt die nächste Karte; lehnt der Server ab, kommt die Karte zurück. Bei „Jetzt
/// lesen“ öffnet die Oberfläche die Leseansicht der Karte gleich selbst.
@MainActor
@Observable
public final class InboxStore {
    /// Gruppenfilter (ID oder `ohne`), nil = alle.
    public private(set) var group: String?
    /// Eine Entscheidung läuft: Die Karte ist weg, die nächste kommt noch.
    public private(set) var isDeciding = false
    public private(set) var isSaving = false
    public private(set) var isUploading = false
    /// Erfassungs-ID der Adresse; bleibt bis zum Erfolg gleich, damit ein zweiter Versuch nichts
    /// doppelt speichert.
    public private(set) var saveCID = UUID().uuidString.lowercased()
    public private(set) var uploadCID = UUID().uuidString.lowercased()

    /// Höchstgröße einer PDF (`MAX_PDF` in src/lesen/pdf.js).
    nonisolated public static let maxPDFBytes = 20 * 1024 * 1024

    private let remote: RemoteModel<ReadingInboxModel>
    private let context: CockpitContext
    private var actions: ReadingActions { ReadingActions(context: context) }

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: "api/lesen/eingang")
    }

    public var model: ReadingInboxModel? { remote.model }
    public var state: LoadState { remote.state }
    /// Oberste Karte, nil = „Eingang leer“ (oder die nächste lädt, siehe `isDeciding`).
    public var card: InboxCard? { remote.model?.doc }

    // MARK: Laden

    /// Zeigt sofort den gespeicherten Stand der Gruppe und lädt dann neu.
    public func load(group: String? = nil) async {
        self.group = group
        remote.select(key: Self.cacheKey(group), query: CockpitAPI.groupQuery(group)) { model in
            model.filter.gruppe == group
        }
        await refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    static func cacheKey(_ group: String?) -> String {
        "lesen/eingang/\(group ?? "alle")"
    }

    // MARK: Sichten

    /// Weg, Stapel oder Jetzt lesen für die oberste Karte.
    @discardableResult
    public func decide(_ decision: InboxDecision) async -> Bool {
        await advance(ReadingAction.sort, ["ziel": decision.rawValue])
    }

    /// „Im Vault ablegen“ (A): Notiz mit Volltext, ungelesen; Rückgängig legt zurück.
    @discardableResult
    public func file() async -> Bool {
        guard model?.vault == true else { return false }
        return await advance(ReadingAction.file, [:])
    }

    /// Karte sofort weg, senden, nächste laden; bei Ablehnung kommt sie zurück.
    private func advance(_ path: String, _ extra: [String: String]) async -> Bool {
        guard let before = remote.model, let card = before.doc, !isDeciding else { return false }
        isDeciding = true
        defer { isDeciding = false }
        remote.model?.doc = nil
        remote.model?.left = max(0, before.left - 1)
        remote.model?.more = before.left - 1 > 1
        remote.model?.today.seen = before.today.seen + 1
        remote.model?.today.last = ReadingDocRef(id: card.id, title: card.doc.title, url: card.doc.url)
        remote.model?.undo = UndoAction(action: ReadingAction.sort, fields: ["id": card.id, "ziel": "eingang"])
        context.toasts.signal(.selection)
        do {
            let response = try await actions.send(path, extra.merging(["id": card.id]) { a, _ in a })
            actions.show(response) { [weak self] undo in
                Task { await self?.replay(undo) }
            }
            await refresh()
            return true
        } catch {
            // Nur zurück, wenn niemand inzwischen eine andere Gruppe gewählt hat.
            if remote.model?.filter == before.filter { remote.model = before }
            context.report(error)
            return false
        }
    }

    /// „↶ Rückgängig“ (Z): die letzte Entscheidung von heute zurück in den Eingang.
    @discardableResult
    public func undoLast() async -> Bool {
        guard let undo = model?.undo, !isDeciding else { return false }
        isDeciding = true
        defer { isDeciding = false }
        return await replay(undo)
    }

    /// Spielt ein Rückgängig ab und lädt neu.
    @discardableResult
    public func replay(_ undo: UndoAction) async -> Bool {
        guard await actions.run(undo.action, undo.fields) != nil else { return false }
        await refresh()
        return true
    }

    // MARK: Speichern

    /// „Adresse speichern“: legt die Adresse in den Lesestapel (`/aktion/lesen/speichern`).
    /// Liefert das gespeicherte Dokument; landet es im Eingang, lädt die Karte neu.
    @discardableResult
    public func save(url: String) async -> ReadingActionDoc? {
        let url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else {
            context.toasts.signal(.error)
            context.toasts.error("Bitte eine Adresse eingeben")
            return nil
        }
        guard !isSaving else { return nil }
        isSaving = true
        defer { isSaving = false }
        guard let response = await actions.run(ReadingAction.save, ["url": url, "cid": saveCID]) else { return nil }
        saveCID = UUID().uuidString.lowercased()
        context.toasts.signal(.success)
        if response.doc?.status == .inbox { await refresh() }
        return response.doc
    }

    /// PDF hochladen (höchstens 20 MB; nur der Text wird gespeichert).
    @discardableResult
    public func uploadPDF(_ data: Data, filename: String) async -> ReadingActionDoc? {
        guard !data.isEmpty else {
            context.toasts.signal(.error)
            context.toasts.error("Bitte eine PDF-Datei auswählen")
            return nil
        }
        guard data.count <= Self.maxPDFBytes else {
            context.toasts.signal(.error)
            context.toasts.error("Die Datei ist zu groß (höchstens 20 MB).")
            return nil
        }
        guard !isUploading else { return nil }
        isUploading = true
        defer { isUploading = false }
        do {
            let file = UploadFile(filename: filename.isEmpty ? "dokument.pdf" : filename, data: data)
            let response = try await context.api.upload(ReadingAction.pdf, fields: ["cid": uploadCID], file: file, as: ReadingActionResponse.self)
            uploadCID = UUID().uuidString.lowercased()
            context.toasts.signal(.success)
            context.toasts.show(response.message)
            if response.doc?.status == .inbox { await refresh() }
            return response.doc
        } catch {
            context.report(error)
            return nil
        }
    }
}

/// Stapel: Zeitfenster, Sortierung, Gruppe und „Im Vault ablegen“.
@MainActor
@Observable
public final class StackStore {
    public private(set) var query = StackQuery()
    /// Dokumente (IDs), an denen gerade eine Aktion läuft.
    public private(set) var busy: Set<String> = []

    private let remote: RemoteModel<ReadingStackModel>
    private let context: CockpitContext
    private var actions: ReadingActions { ReadingActions(context: context) }

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: "api/lesen/stapel")
    }

    public var model: ReadingStackModel? { remote.model }
    public var state: LoadState { remote.state }

    // MARK: Laden

    /// Zeigt sofort den gespeicherten Stand der Auswahl und lädt dann neu.
    public func load(_ query: StackQuery = StackQuery()) async {
        self.query = query
        remote.select(key: Self.cacheKey(query), query: CockpitAPI.stackQuery(query)) { model in
            model.zeit == query.zeit && model.filter.gruppe == query.group
        }
        await refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    /// Zeitfenster-Chip („Alle“ = nil).
    public func setZeit(_ zeit: Int?) async {
        var next = query
        next.zeit = zeit
        await load(next)
    }

    /// Sortier-Chip (nur ohne Zeitfenster sichtbar).
    public func setSort(_ sort: String) async {
        var next = query
        next.sort = sort
        await load(next)
    }

    /// Gruppen-Chip (ID, `ohne` oder nil für alle).
    public func setGroup(_ group: String?) async {
        var next = query
        next.group = group
        await load(next)
    }

    static func cacheKey(_ query: StackQuery) -> String {
        "lesen/stapel/\(query.zeit.map(String.init) ?? "alle")/\(query.sort ?? "-")/\(query.group ?? "alle")"
    }

    /// Legt die Leseansichten der ersten `limit` Texte der Liste in den Zwischenspeicher (wie die
    /// Offline-Liste im Web: die nächsten 30 Texte in „Passt jetzt“), damit sie ohne Netz
    /// aufgehen. Gespeicherte, die jünger als `maxAge` sind, bleiben. Ohne Netz hört es auf.
    /// Liefert die Zahl der neu geladenen.
    @discardableResult
    public func prefetchDocs(limit: Int = 30, maxAge: TimeInterval = 24 * 3600) async -> Int {
        guard let items = model?.items.prefix(limit) else { return 0 }
        var loaded = 0
        for item in items {
            let key = ReaderStore.cacheKey(item.id)
            if let saved = context.snapshots.load(key), context.now().timeIntervalSince(saved.savedAt) < maxAge { continue }
            do {
                _ = try await context.fetch(ReadingDocModel.self, path: "api/lesen/doc", query: CockpitAPI.docQuery(item.id), key: key)
                loaded += 1
            } catch let error as CockpitError where error.isOffline || error.isUnauthorized {
                break
            } catch {
                // Ein Text, der nicht (mehr) geht, hält die anderen nicht auf.
                continue
            }
        }
        return loaded
    }

    // MARK: Ablegen

    /// „Im Vault ablegen“: sofort aus der Liste, mit Rückgängig; lädt danach neu.
    @discardableResult
    public func file(_ item: StackItem) async -> Bool {
        guard let before = remote.model, model?.vault == true, !busy.contains(item.id) else { return false }
        busy.insert(item.id)
        defer { busy.remove(item.id) }
        remote.model?.items.removeAll { $0.id == item.id }
        remote.model?.count = max(0, before.count - 1)
        do {
            let response = try await actions.send(ReadingAction.file, ["id": item.id])
            context.toasts.signal(.success)
            actions.show(response) { [weak self] undo in
                Task { await self?.replay(undo) }
            }
            await refresh()
            return true
        } catch {
            if remote.model?.zeit == before.zeit, remote.model?.filter == before.filter { remote.model = before }
            context.report(error)
            return false
        }
    }

    /// Spielt ein Rückgängig ab und lädt neu.
    @discardableResult
    public func replay(_ undo: UndoAction) async -> Bool {
        guard await actions.run(undo.action, undo.fields) != nil else { return false }
        await refresh()
        return true
    }
}
