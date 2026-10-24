import Foundation
import Observation

/// Wann eine Aufgabe in die Woche kommt (`wann` bei `/aktion/woche/holen`).
public enum PlanWhen: Equatable, Sendable {
    /// Phönix-Schritt der Woche.
    case step
    /// Fällig an einem Tag der Woche (`JJJJ-MM-TT`).
    case day(String)

    var value: String {
        switch self {
        case .step: "schritt"
        case .day(let date): date
        }
    }
}

/// Ort einer neuen Flamme (`ort`): ohne Bereich, ein Bereich oder ein Projekt.
public enum PlanPlace: Equatable, Hashable, Sendable {
    case loose
    case area(String)
    case project(String)

    var value: String {
        switch self {
        case .loose: "loose"
        case .area(let id): "area:\(id)"
        case .project(let id): "project:\(id)"
        }
    }
}

/// Formular „Flamme einplanen“.
public struct FlameDraft: Equatable, Sendable {
    public var title: String
    /// Tag der Woche (`JJJJ-MM-TT`).
    public var day: String
    /// Uhrzeit `HH:MM` oder leer.
    public var time: String
    public var place: PlanPlace

    public init(title: String = "", day: String, time: String = "", place: PlanPlace = .loose) {
        self.title = title
        self.day = day
        self.time = time
        self.place = place
    }
}

/// Wochenplanung: suchen, in die Woche holen, aus der Woche nehmen, Flammen einplanen.
/// Nach jeder Aktion lädt die Seite neu (geplant wird nur in Zunder).
@MainActor
@Observable
public final class PlanStore {
    public private(set) var requestedWeek: String?
    /// Suche, Bereich und „Als Flamme“ der gezeigten Seite.
    public private(set) var query = PlanQuery()
    /// Aufgaben (IDs) und Formulare, an denen gerade eine Aktion läuft.
    public private(set) var busy: Set<String> = []
    /// Sofort sichtbarer Stand nach „Holen“ und „Aus der Woche“, bis die Seite neu geladen ist:
    /// Aufgaben-ID → Grund (`PlanReason`), leer = nicht mehr in der Woche.
    public private(set) var pending: [String: String] = [:]

    private let remote: RemoteModel<PlanModel>
    private let context: CockpitContext

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: "api/planen")
    }

    public var model: PlanModel? { remote.model }
    public var state: LoadState { remote.state }

    // MARK: Laden

    public func load(week: String? = nil, query: PlanQuery = PlanQuery()) async {
        requestedWeek = week
        self.query = query
        let items = CockpitAPI.planQuery(week, query)
        let key = "planen/\(week ?? "aktuell")?\(items.filter { $0.name != "woche" }.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&"))"
        remote.select(key: key, query: items) { model in
            week == nil ? model.week.current : model.week.id == week
        }
        await remote.refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    public func showPrevious() async {
        guard let week = model?.week else { return }
        await load(week: week.prev, query: PlanQuery(q: query.q, area: query.area))
    }

    public func showNext() async {
        guard let week = model?.week else { return }
        await load(week: week.next, query: PlanQuery(q: query.q, area: query.area))
    }

    /// Suchen (Text oder Kennung wie VCP-47) und/oder nach Bereich filtern.
    public func search(_ text: String, area: String = "") async {
        await load(week: requestedWeek, query: PlanQuery(q: text.trimmingCharacters(in: .whitespacesAndNewlines), area: area, from: query.from))
    }

    /// „Als Flamme“: füllt „Flamme einplanen“ mit dieser Aufgabe als Wurzel.
    public func planFlame(from task: ZunderTask) async {
        await load(week: requestedWeek, query: PlanQuery(q: query.q, area: query.area, from: task.id))
    }

    /// „ohne“: „Flamme einplanen“ wieder ohne Wurzelaufgabe.
    public func clearFlameSource() async {
        await load(week: requestedWeek, query: PlanQuery(q: query.q, area: query.area))
    }

    /// Warum die Aufgabe in der Woche steht (`PlanReason`), mit dem sofort sichtbaren Stand
    /// einer laufenden Aktion; nil = nicht in der Woche.
    public func plannedReason(_ task: ZunderTask) -> String? {
        if let reason = pending[task.id] { return reason.isEmpty ? nil : reason }
        return task.planned
    }

    /// Leeres Formular „Flamme einplanen“ mit dem Tag als Vorgabe.
    public func flameDraft() -> FlameDraft {
        FlameDraft(day: model?.defaultFlameDay ?? "")
    }

    // MARK: Aktionen

    /// „Holen“: Phönix-Schritt der Woche oder fällig an einem Tag. Die Aufgabe steht sofort als
    /// geplant da; lehnt der Server ab, wieder wie vorher.
    @discardableResult
    public func add(_ task: ZunderTask, when: PlanWhen) async -> Bool {
        guard let week = model?.week, !busy.contains(task.id) else { return false }
        pending[task.id] = when == .step ? PlanReason.step : PlanReason.due
        defer { pending.removeValue(forKey: task.id) }
        return await perform("/aktion/woche/holen", ["id": task.id, "woche": week.id, "wann": when.value], busy: task.id)
    }

    /// „Aus der Woche“: entfernt die Phönix-Markierung, sofort sichtbar.
    @discardableResult
    public func remove(_ task: ZunderTask) async -> Bool {
        guard !busy.contains(task.id) else { return false }
        pending[task.id] = ""
        defer { pending.removeValue(forKey: task.id) }
        return await perform("/aktion/woche/raus", ["id": task.id], busy: task.id)
    }

    /// Plant eine Flamme; mit `query.from` als Unteraufgabe dieser Aufgabe (der Ort entfällt).
    /// Danach ist das Formular wieder leer (ohne Wurzelaufgabe).
    @discardableResult
    public func createFlame(_ draft: FlameDraft) async -> Bool {
        guard let week = model?.week else { return false }
        var fields = ["woche": week.id, "titel": draft.title.trimmingCharacters(in: .whitespacesAndNewlines), "tag": draft.day, "zeit": draft.time]
        if query.from.isEmpty {
            fields["ort"] = draft.place.value
        } else {
            fields["aus"] = query.from
        }
        return await perform("/aktion/woche/flamme", fields, busy: "flamme")
    }

    /// Spielt „Rückgängig“ ab und lädt neu.
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
        // `redirect` nach einer Flamme aus einer Aufgabe heißt: zurück zum leeren Formular.
        if response.redirect != nil, !query.from.isEmpty {
            await clearFlameSource()
        } else {
            await refresh()
        }
        return true
    }
}
