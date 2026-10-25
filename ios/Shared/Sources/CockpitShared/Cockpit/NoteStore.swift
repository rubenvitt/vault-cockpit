import Foundation
import Observation

/// Was an einer Notiz gerade läuft (Knöpfe sperren, Fortschritt zeigen).
public enum NoteOperation: Hashable, Sendable {
    /// Checkbox Nummer `n`.
    case checkbox(Int)
    /// Ablegen oder Ins Archiv.
    case file
    case tags
    case append
    /// Verlinken mit diesem Ziel (Pfad).
    case link(String)
    /// Als Aufgaben nach Zunder.
    case tasks
    /// Beleg (Markierungs-ID) anhängen oder entfernen.
    case evidence(String)
}

/// Notizseite: Text als Baum, Verwandte, Vorschläge und alle Aktionen der Seite (Abhaken mit
/// Rückgängig, Ablegen, Tags, Anhängen, Verlinken, Aufgaben nach Zunder, Belege).
///
/// Abhaken ändert die Ansicht sofort und nimmt die Änderung zurück, wenn der Server ablehnt
/// (steht die Checkbox nicht mehr dort, lädt die Notiz neu). Ablegen wechselt auf den neuen Pfad
/// (`path`, `movedFrom`), die übrigen Aktionen laden die Notiz danach neu.
@MainActor
@Observable
public final class NoteStore {
    /// Pfad der gezeigten Notiz; ändert sich beim Ablegen und Rückgängig.
    public private(set) var path: String
    /// Vorheriger Pfad nach dem Ablegen (die Oberfläche passt Titel und Weg an), sonst nil.
    public private(set) var movedFrom: String?
    public private(set) var busy: Set<NoteOperation> = []
    /// Text für „Anhängen“; bleibt stehen, bis er angehängt ist.
    public var appendDraft = ""

    /// Höchstlänge beim Anhängen (wie `maxlength` im Web).
    public static let appendLimit = 20_000

    private let remote: RemoteModel<NoteModel>
    private let context: CockpitContext
    @ObservationIgnored private var images: [String: Data] = [:]
    private var runner: ReplyRunner { ReplyRunner(context: context) }

    public init(context: CockpitContext, path: String) {
        self.context = context
        self.path = path
        remote = RemoteModel(context: context, path: "api/notiz")
    }

    public var model: NoteModel? { remote.model }
    public var state: LoadState { remote.state }
    /// Darf schreiben (Aktionen, Abhaken).
    public var canWrite: Bool { model?.can.write ?? false }
    /// Tags wie im Feld „Tags“: `idee, hund`.
    public var tagsText: String { model?.tags.joined(separator: ", ") ?? "" }

    public func isBusy(_ operation: NoteOperation) -> Bool { busy.contains(operation) }

    // MARK: Laden

    /// Zeigt sofort den gespeicherten Stand und lädt dann neu.
    public func load() async {
        await load(path: path)
    }

    /// Wechselt auf eine andere Notiz (Link, Ablegen).
    public func load(path: String) async {
        await load(path: path, keeping: nil)
    }

    /// `keeping`: Pfad, dessen Stand bis zur Antwort stehen bleiben darf (dieselbe Notiz nach
    /// dem Ablegen an anderer Stelle).
    private func load(path: String, keeping previous: String?) async {
        if path != self.path { images = [:] }
        self.path = path
        remote.select(key: Self.cacheKey(path), query: CockpitAPI.pathQuery(path)) { $0.path == path || $0.path == previous }
        await refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    static func cacheKey(_ path: String) -> String {
        "notiz/\(path)"
    }

    /// Bild aus der Notiz (`NoteImage.src`, `NoteWikilink.src`) mit Geräte-Token; nil, wenn es
    /// nicht lädt. Einmal geladene Bilder bleiben im Speicher, solange die Notiz gezeigt wird.
    public func imageData(_ src: String) async -> Data? {
        if let data = images[src] { return data }
        guard let file = try? await context.api.resource(src) else { return nil }
        images[src] = file.data
        return file.data
    }

    // MARK: Abhaken

    /// Checkbox umschalten, sofort sichtbar, mit Rückgängig. Nur mit `n` und `line` (nicht in Callouts).
    @discardableResult
    public func toggle(_ checkbox: NoteCheckbox) async -> Bool {
        guard let n = checkbox.n, let line = checkbox.line else { return false }
        return await setCheckbox(n: n, line: line, done: !checkbox.done, offerUndo: true)
    }

    private func setCheckbox(n: Int, line: String, done: Bool, offerUndo: Bool) async -> Bool {
        let operation = NoteOperation.checkbox(n)
        guard canWrite, !busy.contains(operation) else { return false }
        busy.insert(operation)
        defer { busy.remove(operation) }
        let notePath = path
        let before = model?.checkboxes.first { $0.n == n }
        remote.model?.updateCheckbox(n: n) { $0.done = done }
        if done { context.toasts.signal(.success) }
        do {
            let fields = ["pfad": notePath, "n": String(n), "line": line, "erledigt": done ? "1" : "0"]
            let response = try await context.api.action(NoteAction.checkbox, fields: fields, as: NoteActionResponse.self)
            if path == notePath {
                remote.model?.updateCheckbox(n: n) { box in
                    box.done = response.done ?? done
                    if let line = response.line { box.line = line }
                }
            }
            runner.show(response, undo: offerUndo ? checkboxUndo() : nil)
            return true
        } catch {
            if path == notePath, let before { remote.model?.updateCheckbox(n: n) { $0 = before } }
            context.report(error)
            // Zeile veraltet (400, „Bitte neu laden“): Nummern und Zeilen neu holen.
            if case .failed(let status, _, _) = CockpitError.from(error, action: true), status == 400, path == notePath { await refresh() }
            return false
        }
    }

    private func checkboxUndo() -> @MainActor (UndoAction) -> Void {
        { [weak self] undo in
            Task { await self?.undoCheckbox(undo) }
        }
    }

    /// Rückgängig nach dem Abhaken: wieder sofort sichtbar, sonst das Formular.
    private func undoCheckbox(_ undo: UndoAction) async {
        if let n = undo.fields["n"].flatMap({ Int($0) }), let line = undo.fields["line"], undo.fields["pfad"] == path {
            _ = await setCheckbox(n: n, line: line, done: undo.fields["erledigt"] == "1", offerUndo: false)
        } else {
            await replay(undo)
        }
    }

    // MARK: Ablegen

    /// „Ablegen“ in einen Ordner (`targets` als Vorschläge). Danach zeigt der Store die Notiz am
    /// neuen Pfad; „Rückgängig“ legt sie zurück.
    @discardableResult
    public func file(to folder: String) async -> Bool {
        let folder = folder.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !folder.isEmpty else {
            context.toasts.signal(.error)
            context.toasts.error("Bitte einen Zielordner angeben.")
            return false
        }
        guard canWrite, !busy.contains(.file) else { return false }
        busy.insert(.file)
        defer { busy.remove(.file) }
        let fields = ["pfad": path, "ordner": folder, "back": PageRoute.note(path: path, anchor: nil).webPath]
        guard let response = await runner.run(NoteAction.file, fields, as: NoteActionResponse.self, undo: { [weak self] undo in
            Task { await self?.replay(undo) }
        }) else { return false }
        context.toasts.signal(.success)
        await follow(response)
        return true
    }

    /// „Ins Archiv“ (nur wenn `model.archive` gesetzt ist).
    @discardableResult
    public func archive() async -> Bool {
        guard let archive = model?.archive else { return false }
        return await file(to: archive)
    }

    /// Spielt ein Rückgängig ab (Ablegen, Beleg) und folgt einem neuen Pfad.
    @discardableResult
    public func replay(_ undo: UndoAction) async -> Bool {
        guard let response = await runner.run(undo.action, undo.fields, as: NoteActionResponse.self, undo: nil) else { return false }
        await follow(response)
        return true
    }

    /// Nach einer Aktion: neuer Pfad (Ablegen) → dorthin wechseln, sonst neu laden.
    private func follow(_ response: NoteActionResponse) async {
        if let newPath = response.path, !newPath.isEmpty, newPath != path {
            let old = path
            movedFrom = old
            await load(path: newPath, keeping: old)
        } else {
            await refresh()
        }
    }

    // MARK: Tags, Anhängen

    /// „Setzen“: Tags durch Komma oder Leerzeichen, `#` optional; leer entfernt alle.
    @discardableResult
    public func setTags(_ text: String) async -> Bool {
        guard canWrite, !busy.contains(.tags) else { return false }
        busy.insert(.tags)
        defer { busy.remove(.tags) }
        let notePath = path
        guard let response = await runner.run(NoteAction.tags, ["pfad": notePath, "tags": text], as: NoteActionResponse.self, undo: nil) else { return false }
        if let tags = response.tags, path == notePath { remote.model?.tags = tags }
        await refresh()
        return true
    }

    /// Vorgeschlagene Tags übernehmen („+ #tag“, „Alle übernehmen“): zu den vorhandenen dazu.
    @discardableResult
    public func addTags(_ tags: [String]) async -> Bool {
        let current = model?.tags ?? []
        let added = tags.filter { !current.contains($0) }
        return await setTags((current + added).joined(separator: ", "))
    }

    /// „Anhängen“: Text ans Ende der Notiz (ohne `text`: `appendDraft`, der danach leer ist).
    @discardableResult
    public func append(_ text: String? = nil) async -> Bool {
        let usesDraft = text == nil
        let body = (text ?? appendDraft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else {
            context.toasts.signal(.error)
            context.toasts.error("Bitte einen Text eingeben.")
            return false
        }
        guard body.count <= Self.appendLimit else {
            context.toasts.signal(.error)
            context.toasts.error("Der Text ist zu lang (höchstens \(Self.appendLimit) Zeichen).")
            return false
        }
        guard canWrite, !busy.contains(.append) else { return false }
        busy.insert(.append)
        defer { busy.remove(.append) }
        guard await runner.run(NoteAction.append, ["pfad": path, "text": body], as: NoteActionResponse.self, undo: nil) != nil else { return false }
        if usesDraft { appendDraft = "" }
        context.toasts.signal(.success)
        await refresh()
        return true
    }

    // MARK: Verlinken, Synthese

    /// „Verlinken“: hängt `- [[Ziel]]` an diese Notiz an (Vorschläge, Ähnlich).
    @discardableResult
    public func link(to target: String) async -> Bool {
        let operation = NoteOperation.link(target)
        guard canWrite, !busy.contains(operation) else { return false }
        busy.insert(operation)
        defer { busy.remove(operation) }
        let notePath = path
        guard await runner.run(NoteAction.link, ["pfad": notePath, "ziel": target], as: NoteActionResponse.self, undo: nil) != nil else { return false }
        if path == notePath, var model = remote.model {
            for i in model.related.similar.indices where model.related.similar[i].path == target { model.related.similar[i].linked = true }
            remote.model = model
        }
        await refresh()
        return true
    }

    /// „Als Aufgaben nach Zunder“: offene Punkte der Synthese als Aufgaben.
    @discardableResult
    public func createTasks() async -> Bool {
        guard model?.synthesis?.toZunder == true, !busy.contains(.tasks) else { return false }
        busy.insert(.tasks)
        defer { busy.remove(.tasks) }
        guard await runner.run(NoteAction.tasks, ["pfad": path], as: NoteActionResponse.self, undo: nil) != nil else { return false }
        context.toasts.signal(.success)
        await refresh()
        return true
    }

    /// „Als Beleg anhängen“ (mit Rückgängig, das ihn wieder entfernt).
    @discardableResult
    public func attachEvidence(_ evidence: EvidenceSuggestion) async -> Bool {
        let operation = NoteOperation.evidence(evidence.id)
        guard canWrite, !busy.contains(operation) else { return false }
        busy.insert(operation)
        defer { busy.remove(operation) }
        guard await runner.run(NoteAction.evidence, ["pfad": path, "markierung": evidence.id], as: NoteActionResponse.self, undo: { [weak self] undo in
            Task { await self?.replay(undo) }
        }) != nil else { return false }
        context.toasts.signal(.success)
        await refresh()
        return true
    }

    /// Beleg wieder entfernen.
    @discardableResult
    public func detachEvidence(id: String) async -> Bool {
        let operation = NoteOperation.evidence(id)
        guard canWrite, !busy.contains(operation) else { return false }
        busy.insert(operation)
        defer { busy.remove(operation) }
        guard await runner.run(NoteAction.evidenceRemove, ["pfad": path, "markierung": id], as: NoteActionResponse.self, undo: nil) != nil else { return false }
        await refresh()
        return true
    }
}
