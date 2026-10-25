import Foundation
import Observation

/// Wofür „Verbinden“ sucht: eine Markierung oder eine Auswahl, die noch keine ist.
public enum ConnectionTarget: Equatable, Sendable {
    case highlight(String)
    case selection(HighlightAnchor)
}

/// Stand des Verbinden-Blatts.
public enum ConnectionsState: Equatable, Sendable {
    case idle
    /// „Suche passende Stellen …“
    case loading
    case loaded(ConnectionsModel)
    /// z. B. „Ohne Netz keine Querverbindungen“
    case failed(String)
}

/// Leseansicht eines Dokuments: Text als Blöcke, Markierungen, Notizen, Lesefortschritt,
/// Entscheidungen nach dem Lesen und Verbinden.
///
/// Markieren, Notiz, Fortschritt, Status, „Fertig, weg“ und „In den Vault“ ändern die Ansicht
/// sofort und gehen ohne Netz in den `ReadingBuffer` (wie offline.js im Web); wartende neue
/// Markierungen stehen mit `isPending` im Text. Alles andere braucht Netz und nimmt die Änderung
/// zurück, wenn es scheitert.
///
/// Fortschritt: Die Oberfläche meldet beim Scrollen `scrolled(progress:firstVisibleBlock:)`;
/// gespeichert wird 1,5 s nach dem letzten Scrollen (nie weniger als schon gelesen) und sofort
/// mit `flushProgress()` (App im Hintergrund, Ansicht weg).
@MainActor
@Observable
public final class ReaderStore {
    public let docID: String
    /// Lesetext für Anker und Auswahl, neu nach jedem Laden.
    public private(set) var text: ReaderText?
    /// Gelesener Anteil, nie weniger als beim Öffnen.
    public private(set) var progress: Double = 0
    /// Markierungen (IDs) und Knöpfe (`fertig`, `vault`, `status`), an denen gerade eine Aktion läuft.
    public private(set) var busy: Set<String> = []
    public private(set) var connections: ConnectionsState = .idle
    public private(set) var connectionTarget: ConnectionTarget?

    private let remote: RemoteModel<ReadingDocModel>
    private let context: CockpitContext
    private let buffer: ReadingBuffer
    private let saveDelay: UInt64
    private var actions: ReadingActions { ReadingActions(context: context) }
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var dirty = false
    @ObservationIgnored private var anchor: Int?
    @ObservationIgnored private var listener: UUID?
    @ObservationIgnored private var connectionsSerial = 0

    /// `saveDelay` in Sekunden (Tests verkürzen sie).
    public init(context: CockpitContext, docID: String, buffer: ReadingBuffer, saveDelay: TimeInterval = 1.5) {
        self.context = context
        self.docID = docID
        self.buffer = buffer
        self.saveDelay = UInt64(max(0, saveDelay) * 1_000_000_000)
        remote = RemoteModel(context: context, path: "api/lesen/doc")
        // Nachgesendetes aus dem Puffer: neu laden, damit wartende Markierungen echte werden.
        listener = buffer.addListener { [weak self] docs in
            guard let self, docs.contains(self.docID) else { return }
            Task { await self.refresh() }
        }
    }

    public var model: ReadingDocModel? { remote.model }
    public var state: LoadState { remote.state }

    /// „Diesen Artikel gibt es nicht (mehr).“ (404)
    public var isNotFound: Bool {
        if case .failed(404, _, _) = state.error { return true }
        return false
    }

    /// Markieren geht nur mit Lesetext.
    public var canMark: Bool { model?.hasText ?? false }

    /// „noch 8 min“, „gelesen“ oder leer, mit dem Fortschritt dieser Sitzung.
    public var restLabel: String {
        guard let minutes = model?.doc.readingMinutes else { return "" }
        if progress >= 1 { return "gelesen" }
        guard minutes > 0 else { return "" }
        return "noch \(max(1, Int((Double(minutes) * (1 - progress)).rounded(.up)))) min"
    }

    // MARK: Laden

    /// Zeigt sofort den gespeicherten Stand und lädt dann neu.
    public func load() async {
        remote.select(key: Self.cacheKey(docID), query: CockpitAPI.docQuery(docID)) { [docID] model in
            model.doc.id == docID
        }
        didLoad()
        await refresh()
    }

    public func refresh() async {
        await remote.refresh()
        didLoad()
    }

    /// Hört auf den Puffer nicht mehr und speichert den Fortschritt (Ansicht geschlossen).
    public func stop() async {
        if let listener { buffer.removeListener(listener) }
        listener = nil
        await flushProgress()
    }

    static func cacheKey(_ id: String) -> String {
        "lesen/doc/\(id)"
    }

    /// Text neu aufbauen, wartende Markierungen aus dem Puffer einsetzen, Fortschritt übernehmen.
    private func didLoad() {
        guard let model = remote.model else {
            text = nil
            return
        }
        let text = ReaderText(model: model)
        self.text = text
        progress = max(progress, model.doc.progress)
        let known = Set(model.highlights.map(\.id))
        let waiting = buffer.pendingHighlights(docID: docID).filter { !known.contains($0.id) }
        guard !waiting.isEmpty else { return }
        remote.model?.updateHighlights { highlights in
            for entry in waiting {
                let quote = entry.fields["quote"] ?? ""
                let start = entry.fields["start"].flatMap { Int($0) }
                let at = text.locate(quote: quote, prefix: entry.fields["prefix"] ?? "", suffix: entry.fields["suffix"] ?? "", startHint: start)
                let note = entry.fields["notiz"].flatMap { $0.isEmpty ? nil : $0 }
                highlights.append(ReadingHighlight(id: entry.id, docId: docID, quote: quote, prefix: entry.fields["prefix"] ?? "", suffix: entry.fields["suffix"] ?? "", startHint: start, note: note, createdAt: CockpitFormat.iso(entry.created), start: at?.lowerBound, end: at?.upperBound, lost: at == nil, isPending: true))
            }
        }
    }

    // MARK: Fortschritt

    /// Beim Scrollen: Anteil bis zum unteren Bildrand (0…1) und Index des ersten sichtbaren
    /// Blocks (seine `start` wird die Lesestelle). Gespeichert wird 1,5 s nach dem letzten Aufruf.
    public func scrolled(progress value: Double, firstVisibleBlock index: Int?) {
        let anchor = index.flatMap { i in model?.blocks.indices.contains(i) == true ? model?.blocks[i].start : nil }
        scrolled(progress: value, anchor: anchor ?? self.anchor ?? 0)
    }

    /// Wie oben, mit der Lesestelle als Zeichen im Lesetext.
    public func scrolled(progress value: Double, anchor: Int) {
        progress = max(progress, min(1, max(0, value)))
        self.anchor = max(0, anchor)
        dirty = true
        saveTask?.cancel()
        let delay = saveDelay
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled else { return }
            await self?.saveProgress()
        }
    }

    /// Speichert sofort, was noch nicht gespeichert ist (App im Hintergrund, Ansicht weg).
    public func flushProgress() async {
        saveTask?.cancel()
        saveTask = nil
        await saveProgress()
    }

    private func saveProgress() async {
        guard dirty else { return }
        dirty = false
        // Zurückblättern senkt den Fortschritt nicht, verschiebt aber die Stelle zum Weiterlesen.
        let fields = ["id": docID, "fortschritt": Self.decimal(progress), "anker": String(anchor ?? 0)]
        remote.model?.doc.progress = progress
        if let anchor { remote.model?.doc.scrollAnchor = anchor }
        guard buffer.isOnline else {
            park(ReadingAction.progress, fields, quiet: true)
            return
        }
        do {
            _ = try await actions.send(ReadingAction.progress, fields)
        } catch let error as CockpitError where error.isOffline || error.isUnauthorized {
            park(ReadingAction.progress, fields, quiet: true)
        } catch {
            // Wie im Web: Ein abgelehnter Fortschritt ist keine Meldung wert.
        }
    }

    /// `0.42` → `"0.420"` (`toFixed(3)`), unabhängig von der Sprache des Geräts.
    nonisolated static func decimal(_ value: Double) -> String {
        let thousandths = Int((min(1, max(0, value)) * 1000).rounded())
        let fraction = thousandths % 1000
        return "\(thousandths / 1000).\(fraction < 10 ? "00" : fraction < 100 ? "0" : "")\(fraction)"
    }

    // MARK: Markieren

    /// Markiert `range` (UTF-16 im Lesetext), auf Wunsch gleich mit Notiz. Die Markierung steht
    /// sofort im Text. Liefert ihre ID (ohne Netz die wartende `cid`), nil bei Fehler.
    @discardableResult
    public func mark(_ range: Range<Int>, note: String? = nil) async -> String? {
        guard canMark, let anchor = text?.anchor(for: range) else {
            context.toasts.error("Nichts ausgewählt")
            return nil
        }
        return await mark(anchor, note: note)
    }

    /// H ohne Auswahl: markiert den Block; ist er schon ganz markiert, wird die Markierung entfernt.
    @discardableResult
    public func toggleMark(block index: Int) async -> Bool {
        guard let model, canMark, model.blocks.indices.contains(index), let text else { return false }
        guard let anchor = text.anchor(for: model.blocks[index]) else {
            context.toasts.show("In diesem Absatz gibt es keinen Text zum Markieren.")
            return false
        }
        if let whole = model.highlight(covering: anchor.start..<anchor.end) {
            return await deleteHighlight(whole.id)
        }
        return await mark(anchor, note: nil) != nil
    }

    /// Anker für den ganzen Block (N und L ohne Auswahl), nil ohne Text.
    public func anchor(block index: Int) -> HighlightAnchor? {
        guard let model, model.blocks.indices.contains(index) else { return nil }
        return text?.anchor(for: model.blocks[index])
    }

    /// Markierung, die einen Block ganz abdeckt (dann wirken N und L auf sie).
    public func highlight(coveringBlock index: Int) -> ReadingHighlight? {
        guard let anchor = anchor(block: index) else { return nil }
        return model?.highlight(covering: anchor.start..<anchor.end)
    }

    private func mark(_ anchor: HighlightAnchor, note: String?) async -> String? {
        let cid = UUID().uuidString.lowercased()
        let note = note.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        var fields = anchor.fields
        fields["id"] = docID
        fields["cid"] = cid
        if let note { fields["notiz"] = note }
        let fresh = ReadingHighlight(id: cid, docId: docID, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix, startHint: anchor.start, note: note, createdAt: CockpitFormat.iso(context.now()), start: anchor.start, end: anchor.end)
        remote.model?.updateHighlights { $0.append(fresh) }
        context.toasts.signal(.success)
        switch await deliver(ReadingAction.markNew, fields) {
        case .sent(let response):
            actions.show(response) { [weak self] undo in
                Task { await self?.replay(undo) }
            }
            await refresh()
            return response.highlight?.id ?? cid
        case .parked:
            remote.model?.updateHighlights { list in
                if let i = list.firstIndex(where: { $0.id == cid }) { list[i].isPending = true }
            }
            return cid
        case .failed:
            remote.model?.updateHighlights { $0.removeAll { $0.id == cid } }
            return nil
        }
    }

    // MARK: Notizen

    /// Notiz an einer Auswahl, die noch keine Markierung ist: markiert mit Notiz.
    @discardableResult
    public func addNote(_ note: String, to range: Range<Int>) async -> String? {
        await mark(range, note: note)
    }

    /// Notiz einer Markierung setzen oder ändern; leer entfernt sie. Mit Rückgängig.
    @discardableResult
    public func setNote(_ note: String, for highlightID: String) async -> Bool {
        guard let old = model?.highlight(highlightID), !busy.contains(highlightID) else { return false }
        let value = note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : note
        setLocalNote(highlightID, value)
        if old.isPending {
            // Noch nicht beim Server: die wartende Markierung bekommt die Notiz mit.
            buffer.update(highlightID) { $0["notiz"] = value }
            return true
        }
        busy.insert(highlightID)
        defer { busy.remove(highlightID) }
        switch await deliver(ReadingAction.note, ["id": highlightID, "notiz": value]) {
        case .sent(let response):
            actions.show(response) { [weak self] undo in
                Task { await self?.replay(undo) }
            }
            return true
        case .parked:
            return true
        case .failed:
            setLocalNote(highlightID, old.note ?? "")
            return false
        }
    }

    /// Notiz entfernen.
    @discardableResult
    public func deleteNote(for highlightID: String) async -> Bool {
        await setNote("", for: highlightID)
    }

    private func setLocalNote(_ id: String, _ note: String) {
        remote.model?.updateHighlights { list in
            if let i = list.firstIndex(where: { $0.id == id }) { list[i].note = note.isEmpty ? nil : note }
        }
    }

    // MARK: Entfernen, In Inbox

    /// „Entfernen“: sofort weg, mit Rückgängig (stellt sie mit derselben ID wieder her).
    @discardableResult
    public func deleteHighlight(_ id: String) async -> Bool {
        guard let model, let index = model.highlights.firstIndex(where: { $0.id == id }), !busy.contains(id) else { return false }
        let old = model.highlights[index]
        remote.model?.updateHighlights { $0.removeAll { $0.id == id } }
        if old.isPending {
            if let entry = buffer.entries.first(where: { $0.id == id }) { buffer.discard(entry) }
            context.toasts.show("Markierung entfernt")
            return true
        }
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let response = try await actions.send(ReadingAction.markDelete, ["id": id])
            actions.show(response) { [weak self] undo in
                Task { await self?.replay(undo) }
            }
            return true
        } catch {
            remote.model?.updateHighlights { list in
                if !list.contains(where: { $0.id == id }) { list.insert(old, at: min(index, list.count)) }
            }
            context.report(error)
            return false
        }
    }

    /// „In Inbox“: Zitat (mit Notiz und Quelle) als Notiz in die Vault-Inbox.
    @discardableResult
    public func sendToInbox(highlight id: String) async -> Bool {
        await inbox(["markierung": id])
    }

    /// „In Inbox“ für eine Auswahl ohne Markierung.
    @discardableResult
    public func sendToInbox(_ range: Range<Int>) async -> Bool {
        guard let anchor = text?.anchor(for: range) else {
            context.toasts.error("Nichts ausgewählt")
            return false
        }
        var fields = anchor.fields
        fields["id"] = docID
        fields["cid"] = UUID().uuidString.lowercased()
        return await inbox(fields)
    }

    private func inbox(_ fields: [String: String]) async -> Bool {
        guard !busy.contains("inbox") else { return false }
        busy.insert("inbox")
        defer { busy.remove("inbox") }
        guard await actions.run(ReadingAction.markInbox, fields) != nil else { return false }
        context.toasts.signal(.success)
        return true
    }

    // MARK: Entscheidungen

    /// „Fertig, weg“ (E): gelesen, Status weg. Mit Rückgängig.
    @discardableResult
    public func finish() async -> Bool {
        await decide(ReadingAction.finish, ["id": docID], to: .gone, key: "fertig")
    }

    /// „In den Vault“ (V): Notiz (mit `fullText` samt Volltext), dann archiviert.
    @discardableResult
    public func moveToVault(fullText: Bool) async -> Bool {
        var fields = ["id": docID]
        if fullText { fields["volltext"] = "1" }
        return await decide(ReadingAction.vault, fields, to: .archive, key: "vault")
    }

    /// Status setzen, z. B. „Zurück auf den Stapel“ (`.stack`).
    @discardableResult
    public func setStatus(_ status: ReadingStatus) async -> Bool {
        await decide(ReadingAction.status, ["id": docID, "status": status.rawValue], to: status, key: "status")
    }

    private func decide(_ action: String, _ fields: [String: String], to status: ReadingStatus, key: String) async -> Bool {
        guard let before = model, !busy.contains(key) else { return false }
        busy.insert(key)
        defer { busy.remove(key) }
        remote.model?.doc.status = status
        remote.model?.decisions = ReaderDecisions.of(status: status, vault: before.vault)
        context.toasts.signal(.success)
        switch await deliver(action, fields) {
        case .sent(let response):
            actions.show(response) { [weak self] undo in
                Task { await self?.replay(undo) }
            }
            await refresh()
            return true
        case .parked:
            return true
        case .failed:
            remote.model?.doc.status = before.doc.status
            remote.model?.decisions = before.decisions
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

    // MARK: Senden oder puffern

    private enum Outcome {
        case sent(ReadingActionResponse)
        case parked
        case failed
    }

    /// Sendet; Aktionen aus `ReadingAction.buffered` gehen ohne Netz (oder mit abgelaufener
    /// Anmeldung) in den Puffer. Fehler sind dann schon gemeldet.
    private func deliver(_ action: String, _ fields: [String: String]) async -> Outcome {
        let bufferable = ReadingAction.buffered[action] != nil
        if bufferable, !buffer.isOnline {
            return park(action, fields, quiet: false) ? .parked : .failed
        }
        do {
            return .sent(try await actions.send(action, fields))
        } catch let error as CockpitError where bufferable && (error.isOffline || error.isUnauthorized) {
            let parked = park(action, fields, quiet: false)
            if error.isUnauthorized { context.onUnauthorized() }
            return parked ? .parked : .failed
        } catch {
            context.report(error)
            return .failed
        }
    }

    @discardableResult
    private func park(_ action: String, _ fields: [String: String], quiet: Bool) -> Bool {
        let title = model?.doc.displayTitle ?? ""
        guard buffer.queue(action, fields: fields, docID: docID, title: title, quiet: quiet) else {
            if !quiet {
                context.toasts.signal(.error)
                context.toasts.error("Ohne Netz, und dieses Gerät kann gerade nichts zwischenspeichern. Nichts gespeichert.")
            }
            return false
        }
        if !quiet { context.toasts.show("\(ReadingAction.buffered[action] ?? "Eintrag") wartet auf Netz und geht automatisch raus.") }
        return true
    }

    // MARK: Verbinden

    /// Öffnet Verbinden für eine Markierung oder Auswahl und sucht passende Stellen.
    public func loadConnections(for target: ConnectionTarget) async {
        connectionTarget = target
        connectionsSerial += 1
        let serial = connectionsSerial
        connections = .loading
        do {
            let result: ConnectionsModel
            switch target {
            case .highlight(let id): result = try await context.api.connections(highlightID: id)
            case .selection(let anchor): result = try await context.api.connections(docID: docID, text: anchor.quote)
            }
            guard serial == connectionsSerial else { return }
            connections = .loaded(result)
        } catch {
            guard serial == connectionsSerial, !CockpitError.isCancellation(error) else { return }
            let error = CockpitError.from(error, action: false)
            if error.isUnauthorized { context.onUnauthorized() }
            connections = .failed(error.isOffline ? "Ohne Netz keine Querverbindungen" : error.message)
        }
    }

    /// Verbinden für eine Auswahl (UTF-16 im Lesetext); eine ganz markierte Stelle nimmt die Markierung.
    public func loadConnections(for range: Range<Int>) async {
        if let whole = model?.highlight(covering: range), !whole.isPending {
            await loadConnections(for: .highlight(whole.id))
        } else if let anchor = text?.anchor(for: range) {
            await loadConnections(for: .selection(anchor))
        }
    }

    /// Blatt zu.
    public func closeConnections() {
        connectionsSerial += 1
        connections = .idle
        connectionTarget = nil
    }

    /// „Verknüpfen“ mit einer Notiz (Synthese, Konzept).
    @discardableResult
    public func link(note: ConnectionNote) async -> Bool {
        await link(["pfad": note.path, "abschnitt": note.heading ?? ""])
    }

    /// „Verknüpfen“ mit einer Markierung aus einem anderen Text.
    @discardableResult
    public func link(highlight: ConnectionHighlight) async -> Bool {
        await link(["zu": highlight.id])
    }

    /// Ist die Auswahl noch keine Markierung, wird sie erst markiert (mit Netz), dann verknüpft;
    /// danach sucht das Blatt neu, damit „Schon verknüpft“ stimmt.
    private func link(_ target: [String: String]) async -> Bool {
        guard let source = connectionTarget, !busy.contains("link") else { return false }
        busy.insert("link")
        defer { busy.remove("link") }
        var id: String
        switch source {
        case .highlight(let existing):
            id = existing
        case .selection(let anchor):
            if case .loaded(let found) = connections, let known = found.highlightId {
                id = known
            } else {
                var fields = anchor.fields
                fields["id"] = docID
                fields["cid"] = UUID().uuidString.lowercased()
                do {
                    let marked = try await actions.send(ReadingAction.markNew, fields)
                    id = marked.highlight?.id ?? fields["cid"]!
                } catch {
                    context.report(error)
                    return false
                }
                connectionTarget = .highlight(id)
                await refresh()
            }
        }
        guard await actions.run(ReadingAction.link, target.merging(["markierung": id]) { a, _ in a }) != nil else { return false }
        context.toasts.signal(.success)
        await loadConnections(for: .highlight(id))
        return true
    }
}
