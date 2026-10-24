import Foundation
import Observation

/// Fälligkeit aus dem Menü (`/aktion/faellig`).
public enum DueChoice: Equatable, Sendable {
    case today
    case tomorrow
    /// Montag der Folgewoche.
    case nextWeek
    case none
    /// Tag als `JJJJ-MM-TT` (Datumsfeld mit „Setzen“).
    case date(String)

    var fields: [String: String] {
        switch self {
        case .today: ["due": "heute"]
        case .tomorrow: ["due": "morgen"]
        case .nextWeek: ["due": "naechste-woche"]
        case .none: ["due": "keine"]
        case .date(let day): ["due": "datum", "date": day]
        }
    }
}

/// Ziel für „Zuordnen“ aus der Zunder-Inbox (`/aktion/zuordnen`).
public enum MoveDestination: Equatable, Sendable {
    case area(String)
    case project(String)
    /// „Lose (ohne Bereich)“
    case loose

    var value: String {
        switch self {
        case .area(let id): "area:\(id)"
        case .project(let id): "project:\(id)"
        case .loose: "loose"
        }
    }
}

/// Abschnitt der Feuer-Notiz, den der Stift bearbeitet (`/aktion/feuer`, `feld`).
public enum FeuerField: String, Sendable {
    case goal = "ziel"
    case firstMove = "zug"

    public var title: String { self == .goal ? "Feuer-Ziel" : "Erster Zug" }
}

/// Wochenseite: Laden mit Zwischenspeicher, Blättern und alle schreibenden Aktionen der Woche.
///
/// Abhaken ändert die Ansicht sofort (und zählt die Big Rocks neu), sendet dann und nimmt die
/// Änderung zurück, wenn der Server ablehnt; wie im Web wird danach nicht neu geladen. Alle
/// anderen Aktionen laden nach Erfolg die Woche neu, damit eine Aufgabe dort steht, wo sie jetzt
/// hingehört.
@MainActor
@Observable
public final class WeekStore {
    /// Gewünschte Woche (`2026-W42`), nil = die laufende.
    public private(set) var requestedWeek: String?
    /// Aufgaben (IDs) und Formulare, an denen gerade eine Aktion läuft.
    public private(set) var busy: Set<String> = []
    public let capture: CaptureStore

    private let remote: RemoteModel<WeekModel>
    private let context: CockpitContext

    public init(context: CockpitContext, capture: CaptureStore? = nil) {
        self.context = context
        remote = RemoteModel(context: context, path: "api/woche")
        self.capture = capture ?? CaptureStore(context: context)
        self.capture.onCaptured = { [weak self] result, text in self?.insertCaptured(result, text: text) }
        self.capture.onFlushed = { [weak self] in
            Task { await self?.refresh() }
        }
    }

    public var model: WeekModel? { remote.model }
    public var state: LoadState { remote.state }

    // MARK: Laden und Blättern

    /// Zeigt sofort den gespeicherten Stand der Woche und lädt dann neu.
    public func load(week: String? = nil) async {
        requestedWeek = week
        remote.select(key: Self.cacheKey(week), query: CockpitAPI.weekQuery(week)) { model in
            week == nil ? model.week.current : model.week.id == week
        }
        await refresh()
    }

    /// Lädt die gezeigte Woche neu (Ziehen zum Aktualisieren, nach Aktionen).
    public func refresh() async {
        await remote.refresh()
    }

    public func showPrevious() async {
        guard let week = model?.week else { return }
        await load(week: week.prev)
    }

    public func showNext() async {
        guard let week = model?.week else { return }
        await load(week: week.next)
    }

    /// „Diese Woche“
    public func showCurrent() async {
        await load(week: nil)
    }

    static func cacheKey(_ week: String?) -> String {
        "woche/\(week ?? "aktuell")"
    }

    // MARK: Abhaken

    /// Kästchen: erledigt ↔ offen, sofort sichtbar, mit Rückgängig.
    public func toggle(_ task: ZunderTask) async {
        await tick(task.id, to: task.isDone ? .open : .done)
    }

    private func tick(_ id: String, to status: TaskStatus) async {
        guard let before = model?.tasks(withID: id).first?.status, !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        remote.model?.updateTask(id: id) { $0.status = status }
        if status == .done { context.toasts.signal(.success) }
        do {
            let response = try await context.api.action("/aktion/status", fields: ["id": id, "status": status.rawValue, "prev": before.rawValue])
            if let confirmed = response.task?.status { remote.model?.updateTask(id: id) { $0.status = confirmed } }
            if let undo = response.undo {
                context.toasts.show(response.message, action: Toast.Action(label: "Rückgängig") { [weak self] in
                    Task { await self?.undoTick(undo) }
                })
            } else {
                context.toasts.show(response.message)
            }
        } catch {
            remote.model?.updateTask(id: id) { $0.status = before }
            context.report(error)
        }
    }

    /// Rückgängig nach dem Abhaken: steht die Aufgabe noch da, wieder optimistisch, sonst das Formular.
    private func undoTick(_ undo: UndoAction) async {
        if let id = undo.fields["id"], let status = undo.fields["status"], !(model?.tasks(withID: id).isEmpty ?? true) {
            await tick(id, to: TaskStatus(rawValue: status))
        } else {
            await self.undo(undo)
        }
    }

    // MARK: Menü einer Aufgabe

    /// Status-Chips (In Arbeit, Blockiert, Offen; Verwerfen in der Inbox).
    @discardableResult
    public func setStatus(_ task: ZunderTask, to status: TaskStatus) async -> Bool {
        await perform("/aktion/status", ["id": task.id, "status": status.rawValue, "prev": task.status.rawValue], busy: task.id)
    }

    /// Fällig: Heute, Morgen, Nächste Woche, Ohne oder ein Datum.
    @discardableResult
    public func setDue(_ task: ZunderTask, _ choice: DueChoice) async -> Bool {
        await perform("/aktion/faellig", choice.fields.merging(["id": task.id, "prev": task.dueDay]) { a, _ in a }, busy: task.id)
    }

    /// Zuordnen aus der Zunder-Inbox in einen Bereich, ein Projekt oder „Lose“.
    @discardableResult
    public func move(_ task: ZunderTask, to destination: MoveDestination) async -> Bool {
        await perform("/aktion/zuordnen", ["id": task.id, "ziel": destination.value, "prev": "inbox"], busy: task.id)
    }

    /// „Schritt für KW n“ bzw. „Kein Phönix-Schritt“ für die gezeigte Woche.
    @discardableResult
    public func togglePhoenix(_ task: ZunderTask) async -> Bool {
        guard let week = model?.week else { return false }
        let step = task.stepWeek
        return await perform("/aktion/phoenix", ["id": task.id, "fire": step == week.id ? "" : week.id, "prev": step], busy: task.id)
    }

    /// Ist die Aufgabe Phönix-Schritt der gezeigten Woche? (Beschriftung im Menü)
    public func isStepOfShownWeek(_ task: ZunderTask) -> Bool {
        guard let week = model?.week else { return false }
        return task.stepWeek == week.id
    }

    /// Flamme starten oder stoppen. Ein Start beendet eine andere laufende Flamme in Zunder.
    @discardableResult
    public func toggleFlame(_ task: ZunderTask) async -> Bool {
        await perform("/aktion/flamme", ["id": task.id, "an": task.running ? "0" : "1"], busy: task.id)
    }

    /// „Stopp“ in der Leiste der laufenden Flamme.
    @discardableResult
    public func stopBurning() async -> Bool {
        guard let burning = model?.burning else { return false }
        return await perform("/aktion/flamme", ["id": burning.id, "an": "0"], busy: burning.id)
    }

    /// Flamme „Aus der Woche nehmen“ (Rückgängig stellt die Markierung wieder her).
    @discardableResult
    public func removeFromWeek(_ task: ZunderTask) async -> Bool {
        await perform("/aktion/woche/raus", ["id": task.id], busy: task.id)
    }

    // MARK: Feuer

    /// Höchstlänge von Feuer-Ziel und Erstem Zug.
    public static let feuerLimit = 2000

    /// Speichert Feuer-Ziel oder Ersten Zug in der Feuer-Notiz der Woche.
    @discardableResult
    public func saveFeuer(_ field: FeuerField, text: String) async -> Bool {
        guard let feuer = model?.feuer.value ?? nil else { return false }
        return await perform("/aktion/feuer", ["pfad": feuer.path, "feld": field.rawValue, "text": String(text.prefix(Self.feuerLimit))], busy: "feuer-\(field.rawValue)")
    }

    /// Feuer-Notiz für die Woche anlegen geht, wenn es keine gibt, die Woche nicht vorbei ist und
    /// das Cockpit Notizen schreiben darf.
    public var canCreateFeuer: Bool {
        guard let model, case .ok(let feuer) = model.feuer, feuer == nil else { return false }
        return !model.week.past && model.capabilities.notes
    }

    /// „＋ Feuer anlegen“: neue Notiz nach dem Muster der letzten.
    @discardableResult
    public func createFeuer(goal: String, firstMove: String) async -> Bool {
        guard let week = model?.week else { return false }
        let goal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty else {
            context.toasts.signal(.error)
            context.toasts.error("Bitte ein Feuer-Ziel angeben.")
            return false
        }
        return await perform("/aktion/feuer/anlegen", ["woche": week.id, "ziel": goal, "zug": firstMove.trimmingCharacters(in: .whitespacesAndNewlines)], busy: "feuer-anlegen")
    }

    // MARK: Rückgängig und Aktionen

    /// Spielt das Formular aus „Rückgängig“ ab und lädt neu.
    public func undo(_ undo: UndoAction) async {
        await perform(undo.action, undo.fields, offerUndo: false)
    }

    @discardableResult
    private func perform(_ path: String, _ fields: [String: String], busy key: String? = nil, offerUndo: Bool = true) async -> Bool {
        if let key {
            guard !busy.contains(key) else { return false }
            busy.insert(key)
        }
        defer { if let key { busy.remove(key) } }
        let runner = ActionRunner(context: context)
        let response = await runner.run(path, fields, offerUndo: offerUndo) { [weak self] undo in
            Task { await self?.undo(undo) }
        }
        guard let response else { return false }
        if let redirect = response.redirect { context.openPath(redirect) }
        await refresh()
        return true
    }

    // MARK: Schnelleingabe

    /// Neue Notiz oder Inbox-Aufgabe gleich oben in die Inbox, wie `prepend` in cockpit.js.
    /// Nicht für Doppelte, Artikel und Aufgaben mit Ziel außerhalb der Inbox.
    func insertCaptured(_ result: CaptureResult, text: String) {
        guard !result.duplicate else { return }
        if result.kind == "task", result.landsInInbox, let id = result.id {
            let line = CaptureText.firstLine(text)
            let title = result.title.flatMap { $0.isEmpty ? nil : $0 } ?? (line.isEmpty ? "Neue Aufgabe" : line)
            let task = ZunderTask(id: id, ref: result.ref, title: title, status: .open, due: result.due, area: "Inbox", url: result.url)
            remote.model?.inbox.zunder.update { $0.insert(task, at: 0) }
        } else if result.kind == "note", let path = result.path {
            remote.model?.inbox.vault.update { $0.insert(InboxNote(path: path, title: CaptureText.noteLabel(path: path)), at: 0) }
        }
    }
}
