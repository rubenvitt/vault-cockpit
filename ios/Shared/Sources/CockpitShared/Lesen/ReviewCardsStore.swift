import Foundation
import Observation

/// Markiert: alle Markierungen, neueste zuerst, gefiltert nach Quelle und Thema.
@MainActor
@Observable
public final class HighlightsStore {
    public private(set) var query = HighlightQuery()

    private let remote: RemoteModel<HighlightListModel>

    public init(context: CockpitContext) {
        remote = RemoteModel(context: context, path: "api/lesen/markiert")
    }

    public var model: HighlightListModel? { remote.model }
    public var state: LoadState { remote.state }

    /// Zeigt sofort den gespeicherten Stand des Filters und lädt dann neu („Alle zeigen“ = leer).
    public func load(_ query: HighlightQuery = HighlightQuery()) async {
        self.query = query
        remote.select(key: Self.cacheKey(query), query: CockpitAPI.highlightQuery(query)) { model in
            model.filter.quelle == query.site && model.filter.thema == query.topic
        }
        await refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    static func cacheKey(_ query: HighlightQuery) -> String {
        "lesen/markiert/\(query.site ?? "-")/\(query.topic ?? "-")"
    }
}

/// „Behalten“ oder „Loslassen“ einer Karte im Wiedersehen.
public enum ReviewDecision: String, Sendable {
    case behalten
    case loslassen
}

/// Wiedersehen: fällige Karten (Leitner-Boxen), „In eigenen Worten“, die Woche mit Zahlen,
/// Themen und Querverbindungen, Markdown-Export.
///
/// Eine Entscheidung nimmt die Karte sofort weg, zählt „gesehen“ hoch und bietet sie gleich als
/// „Rückgängig“ an; lehnt der Server ab, kommt sie zurück. Die letzte Entscheidung von heute
/// liefert der Server auch nach einem Neuladen (`undo`, `last`). „Rückgängig“ setzt Box und
/// Fälligkeit zurück und lädt neu; nach „In eigenen Worten“ sagt die Meldung, dass die Notiz in
/// der Inbox bleibt.
@MainActor
@Observable
public final class ReviewCardsStore {
    /// Gewünschte Woche (`2026-W43`), nil = die laufende.
    public private(set) var requestedWeek: String?
    /// Karten (IDs) und Querverbindungen, an denen gerade eine Aktion läuft.
    public private(set) var busy: Set<String> = []
    /// Querverbindungen, die schon als Notiz angelegt sind (`HighlightCluster.id`).
    public private(set) var linkedClusters: Set<String> = []

    /// Höchstlänge von „In eigenen Worten“.
    nonisolated public static let maxWords = 4000

    private let remote: RemoteModel<ReviewCardsModel>
    private let context: CockpitContext
    private var actions: ReadingActions { ReadingActions(context: context) }
    /// Erfassungs-ID je Karte für „In eigenen Worten“: ein zweiter Versuch legt nichts doppelt an.
    @ObservationIgnored private var wordIDs: [String: String] = [:]
    /// Entscheidungen seit dem letzten ruhigen Stand, älteste zuerst. Scheitert eine, zeigt
    /// „Rückgängig“ die neueste übrige (oder den Stand davor), nie eine, die nicht durchging.
    @ObservationIgnored private var decisions: [(last: ReviewLast, undo: UndoAction, pending: Bool)] = []
    /// `last`/`undo` vor der ersten Entscheidung in `decisions`.
    @ObservationIgnored private var settled: (last: ReviewLast?, undo: UndoAction?) = (nil, nil)

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: "api/lesen/wiedersehen")
    }

    public var model: ReviewCardsModel? { remote.model }
    public var state: LoadState { remote.state }
    /// Die Karte, die gerade dran ist.
    public var current: ReviewCard? { remote.model?.cards.first }

    // MARK: Laden und Blättern

    public func load(week: String? = nil) async {
        requestedWeek = week
        remote.select(key: "lesen/wiedersehen/\(week ?? "aktuell")", query: CockpitAPI.weekQuery(week)) { model in
            week == nil || model.week.id == week
        }
        await refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    public func showPrevious() async {
        guard let week = model?.week else { return }
        await load(week: week.prev.id)
    }

    public func showNext() async {
        guard let week = model?.week else { return }
        await load(week: week.next.id)
    }

    public func showCurrent() async {
        await load(week: nil)
    }

    // MARK: Karten

    /// „Behalten“ (nächste Box) oder „Loslassen“ (kommt nie wieder).
    @discardableResult
    public func decide(_ card: ReviewCard, _ decision: ReviewDecision) async -> Bool {
        await answer(card, ["id": card.id, "ziel": decision.rawValue])
    }

    /// „In die Inbox und weiter“: eigene Worte mit Zitat als Notiz in die Vault-Inbox, die Karte
    /// gilt als behalten.
    @discardableResult
    public func ownWords(_ card: ReviewCard, _ words: String) async -> Bool {
        let words = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else {
            context.toasts.signal(.error)
            context.toasts.error("Bitte in eigenen Worten etwas schreiben")
            return false
        }
        guard words.count <= Self.maxWords else {
            context.toasts.signal(.error)
            context.toasts.error("Der Text ist zu lang (höchstens \(Self.maxWords) Zeichen)")
            return false
        }
        let cid = wordIDs[card.id] ?? UUID().uuidString.lowercased()
        wordIDs[card.id] = cid
        let ok = await answer(card, ["id": card.id, "ziel": "worte", "worte": words, "cid": cid])
        if ok { wordIDs[card.id] = nil }
        return ok
    }

    private func answer(_ card: ReviewCard, _ fields: [String: String]) async -> Bool {
        guard let before = remote.model, let index = before.cards.firstIndex(where: { $0.id == card.id }), !busy.contains(card.id) else { return false }
        busy.insert(card.id)
        defer { busy.remove(card.id) }
        remote.model?.cards.remove(at: index)
        remote.model?.seen = before.seen + 1
        remote.model?.left = max(0, before.left - 1)
        if !decisions.contains(where: \.pending) {
            decisions = []
            settled = (before.last, before.undo)
        }
        let last = ReviewLast(highlight: card.highlight, decision: fields["ziel"])
        decisions.append((last, UndoAction(action: ReadingAction.reviewUndo, fields: ["id": card.id]), true))
        showNewestDecision()
        context.toasts.signal(fields["ziel"] == ReviewDecision.loslassen.rawValue ? .selection : .success)
        do {
            let response = try await actions.send(ReadingAction.review, fields)
            if let i = decisions.firstIndex(where: { $0.last.id == card.id }) {
                decisions[i].pending = false
                if let undo = response.undo { decisions[i].undo = undo }
                if remote.model?.last?.id == card.id { showNewestDecision() }
            }
            actions.show(response) { [weak self] undo in
                Task { await self?.replay(undo) }
            }
            return true
        } catch {
            if remote.model?.week.id == before.week.id, let cards = remote.model?.cards, !cards.contains(where: { $0.id == card.id }) {
                remote.model?.cards.insert(card, at: min(index, cards.count))
                remote.model?.seen = before.seen
                remote.model?.left = before.left
            }
            decisions.removeAll { $0.last.id == card.id }
            if remote.model?.last?.id == card.id { showNewestDecision() }
            context.report(error)
            return false
        }
    }

    /// `last`/`undo` auf die neueste Entscheidung, die nicht gescheitert ist.
    private func showNewestDecision() {
        if let newest = decisions.last {
            remote.model?.last = newest.last
            remote.model?.undo = newest.undo
        } else {
            remote.model?.last = settled.last
            remote.model?.undo = settled.undo
        }
    }

    /// „↶ Rückgängig“: die letzte Entscheidung von heute zurücknehmen, auch nach einem Neuladen.
    @discardableResult
    public func undoLast() async -> Bool {
        guard let undo = model?.undo else { return false }
        return await replay(undo)
    }

    /// Ein Rückgängig läuft gerade (für den Knopf).
    public var isUndoing: Bool {
        model?.undo?.fields["id"].map { busy.contains($0) } ?? false
    }

    /// Spielt ein Rückgängig ab („Wieder dran“) und lädt neu; die Karte ist danach wieder dran.
    @discardableResult
    public func replay(_ undo: UndoAction) async -> Bool {
        let id = undo.fields["id"] ?? undo.action
        guard !busy.contains(id) else { return false }
        busy.insert(id)
        defer { busy.remove(id) }
        guard await actions.run(undo.action, undo.fields) != nil else { return false }
        decisions.removeAll { $0.undo == undo }
        if settled.undo == undo { settled = (nil, nil) }
        // Bis das Neuladen die nächste Entscheidung bringt, nicht dasselbe zweimal anbieten.
        if remote.model?.undo == undo {
            remote.model?.undo = nil
            remote.model?.last = nil
        }
        await refresh()
        return true
    }

    // MARK: Woche

    /// „Als eigene Notiz anlegen“ für eine entdeckte Querverbindung.
    @discardableResult
    public func createNote(for cluster: HighlightCluster) async -> Bool {
        guard !busy.contains(cluster.id), !linkedClusters.contains(cluster.id) else { return false }
        busy.insert(cluster.id)
        defer { busy.remove(cluster.id) }
        guard await actions.run(ReadingAction.reviewLink, ["ids": cluster.ids.joined(separator: ",")]) != nil else { return false }
        linkedClusters.insert(cluster.id)
        context.toasts.signal(.success)
        return true
    }

    /// Markdown der gezeigten Woche („Als Markdown exportieren“), nil ohne Markierungen oder bei Fehler.
    public func exportMarkdown() async -> String? {
        guard let week = model?.week, week.export != nil else { return nil }
        do {
            return try await context.api.reviewMarkdown(week: week.id)
        } catch {
            context.report(error, action: false)
            return nil
        }
    }

    /// Dateiname des Exports wie im Web: `markierungen-2026-W43.md`.
    public var exportFilename: String? {
        model.map { "markierungen-\($0.week.id).md" }
    }
}
