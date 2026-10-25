import Foundation
import Observation

/// Ingest-Übersicht (`/lesen/ingest` im Web), eine je Anmeldung: bereite Entwürfe, in Arbeit,
/// Fehler, „Ganzen Stapel entwerfen“ und die Zahl bereiter Entwürfe für die Unternavigation.
///
/// Stapel und Leseansicht fragen hier nach dem Stand eines Textes (`status(of:fallback:loadedAt:)`):
/// Was diese Sitzung selbst angestoßen hat (Entwerfen, Übernehmen, Verwerfen), gilt sofort; sonst
/// die Übersicht, wenn sie neuer ist als die Liste des Bildschirms. Solange ein Entwurf entsteht
/// und ein Bildschirm zuschaut (`startPolling`), fragt der Store alle 3 s nach, wie bei den Folgen.
@MainActor
@Observable
public final class IngestStore {
    /// Texte (IDs) bzw. `stapel`, an denen gerade eine Aktion läuft.
    public private(set) var busy: Set<String> = []
    /// Die Übersicht fragt gerade regelmäßig nach.
    public private(set) var isPolling = false

    /// „Prüfen“ in der Meldung „Entwurf bereit: …“ (öffnet die Prüfansicht).
    @ObservationIgnored public var onReview: (@MainActor (String) -> Void)?

    /// Stand aus einer Aktion dieser Sitzung, mit Zeitpunkt.
    struct Tracked: Equatable {
        let status: String?
        let at: Date
    }

    private(set) var tracked: [String: Tracked] = [:]
    private let remote: RemoteModel<IngestOverviewModel>
    private let context: CockpitContext
    private let pollInterval: UInt64
    @ObservationIgnored private var pollers: Set<String> = []
    @ObservationIgnored private var active = true
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    /// Schlüssel in `busy` für „Ganzen Stapel entwerfen“.
    public static let stackKey = "stapel"

    /// `pollInterval` in Sekunden (Tests verkürzen es).
    public init(context: CockpitContext, pollInterval: TimeInterval = 3) {
        self.context = context
        self.pollInterval = UInt64(max(0, pollInterval) * 1_000_000_000)
        remote = RemoteModel(context: context, path: "api/lesen/ingest")
    }

    public var model: IngestOverviewModel? { remote.model }
    public var state: LoadState { remote.state }

    /// Ingest eingerichtet? nil, solange nichts geladen ist.
    public var isEnabled: Bool? { model?.enabled }

    /// Bereite Entwürfe für die Unternavigation; nil ohne Ingest oder vor dem ersten Laden.
    public var readyCount: Int? {
        guard let model, model.enabled else { return nil }
        return model.ready.count
    }

    // MARK: Laden

    public func load() async {
        remote.select(key: "lesen/ingest", query: []) { _ in true }
        await refresh()
    }

    /// Lädt neu; meldet Entwürfe, die seit dem letzten Stand fertig geworden sind.
    public func refresh() async {
        let busyBefore = Set(remote.model?.busy.map(\.id) ?? []).union(tracked.filter { IngestStatus.isBusy($0.value.status) }.keys)
        let started = context.now()
        await remote.refresh()
        if remote.state.error == nil, let model = remote.model {
            // Der neue Stand kennt, was vorher angestoßen wurde; Übernommenes und Verworfenes steht
            // nicht in der Übersicht und bleibt gemerkt.
            tracked = tracked.filter { !IngestStatus.isActive($0.value.status) || $0.value.at > started }
            for entry in model.ready where busyBefore.contains(entry.id) {
                announce(entry)
            }
        }
        schedulePoll()
    }

    private func announce(_ entry: IngestEntry) {
        context.toasts.signal(.success)
        if let review = onReview {
            context.toasts.show("Entwurf bereit: \(entry.title)", action: Toast.Action(label: "Prüfen") { review(entry.id) })
        } else {
            context.toasts.show("Entwurf bereit: \(entry.title)")
        }
    }

    // MARK: Stand eines Textes

    /// Stand für Abzeichen in Stapel und Leseansicht. `fallback` ist der Stand aus der Liste des
    /// Bildschirms, `loadedAt` ihr Zeitpunkt: Neueres gewinnt.
    public func status(of docID: String, fallback: String?, loadedAt: Date?) -> String? {
        let since = loadedAt ?? .distantPast
        if let mine = tracked[docID], mine.at >= since { return mine.status }
        guard let model, model.enabled, let updated = remote.state.lastUpdated, !remote.state.isStale, updated >= since else { return fallback }
        if let status = model.status(of: docID) { return status }
        // Nicht mehr in der Übersicht: kein offener Entwurf (verworfen oder nie entworfen).
        return IngestStatus.isActive(fallback) ? nil : fallback
    }

    /// Merkt den Stand nach einer Aktion woanders (Prüfansicht) und lädt die Übersicht neu.
    public func record(_ docID: String, status: String?) {
        track(docID, status)
        Task { await refresh() }
    }

    private func track(_ docID: String, _ status: String?) {
        tracked[docID] = Tracked(status: status, at: context.now())
    }

    // MARK: Nachfragen

    /// Ein Bildschirm schaut zu (`owner` z. B. `uebersicht`, `stapel`, `leser-<id>`).
    public func startPolling(_ owner: String) {
        pollers.insert(owner)
        schedulePoll()
    }

    public func stopPolling(_ owner: String) {
        pollers.remove(owner)
        if pollers.isEmpty { cancelPoll() }
    }

    /// App vorne oder im Hintergrund: im Hintergrund wird nicht nachgefragt; zurück vorne gleich.
    public func setActive(_ active: Bool) {
        let back = active && !self.active
        self.active = active
        if !active {
            cancelPoll()
        } else if back, !pollers.isEmpty, needsPolling {
            Task { await refresh() }
        }
    }

    /// Ein Entwurf entsteht (laut Übersicht oder laut eigener Aktion).
    private var needsPolling: Bool {
        guard remote.model?.enabled != false else { return false }
        return remote.model?.hasBusy == true || tracked.values.contains { IngestStatus.isBusy($0.status) }
    }

    private func schedulePoll() {
        guard !pollers.isEmpty, active, pollTask == nil, needsPolling else {
            isPolling = pollTask != nil
            return
        }
        let interval = pollInterval
        pollTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: interval)
            guard !Task.isCancelled, let self else { return }
            self.pollTask = nil
            await self.refresh()
        }
        isPolling = true
    }

    private func cancelPoll() {
        pollTask?.cancel()
        pollTask = nil
        isPolling = false
    }

    // MARK: Aktionen

    /// „Ingest entwerfen“ (Stapel, Leseansicht) bzw. „Erneut entwerfen“ (`force`). Ein
    /// fehlgeschlagener Entwurf rückt sofort nach „In Arbeit“; lehnt der Server ab, kommt er zurück.
    @discardableResult
    public func draft(_ docID: String, force: Bool = false) async -> Bool {
        guard !busy.contains(docID) else { return false }
        busy.insert(docID)
        defer { busy.remove(docID) }
        let before = remote.model
        let previous = tracked[docID]
        if let index = remote.model?.failed.firstIndex(where: { $0.id == docID }), var entry = remote.model?.failed[index] {
            remote.model?.failed.remove(at: index)
            entry.status = IngestStatus.waiting
            entry.label = "Wartet, bis Claude frei ist"
            remote.model?.busy.append(entry)
        }
        track(docID, IngestStatus.waiting)
        context.toasts.signal(.selection)
        var fields = ["id": docID]
        if force { fields["force"] = "1" }
        do {
            let response = try await context.api.action(IngestAction.draft, fields: fields, as: IngestActionResponse.self)
            if let ref = response.ingest, ref.id == docID { track(docID, ref.status) }
            context.toasts.show(response.message)
            await refresh()
            return true
        } catch {
            if let before { remote.model = before }
            tracked[docID] = previous
            context.report(error)
            return false
        }
    }

    /// „Ganzen Stapel entwerfen“: Texte ohne Entwurf und fehlgeschlagene, einer nach dem anderen.
    @discardableResult
    public func draftStack() async -> Bool {
        guard !busy.contains(Self.stackKey), model?.available == true else { return false }
        busy.insert(Self.stackKey)
        defer { busy.remove(Self.stackKey) }
        context.toasts.signal(.selection)
        do {
            let response = try await context.api.action(IngestAction.draft, fields: ["stapel": "1"], as: IngestActionResponse.self)
            context.toasts.show(response.message)
            if (response.count ?? 0) > 0 { remote.model?.openOnStack = 0 }
            await refresh()
            return true
        } catch {
            context.report(error)
            return false
        }
    }

    /// „Verwerfen“ eines fehlgeschlagenen Entwurfs: sofort aus der Liste, der Text bleibt auf dem
    /// Stapel; lehnt der Server ab, kommt der Eintrag zurück.
    @discardableResult
    public func discard(_ docID: String) async -> Bool {
        guard !busy.contains(docID), let before = remote.model else { return false }
        busy.insert(docID)
        defer { busy.remove(docID) }
        let previous = tracked[docID]
        remote.model?.failed.removeAll { $0.id == docID }
        remote.model?.ready.removeAll { $0.id == docID }
        track(docID, IngestStatus.discarded)
        context.toasts.signal(.selection)
        do {
            let response = try await context.api.action(IngestAction.discard, fields: ["id": docID], as: IngestActionResponse.self)
            context.toasts.show(response.message)
            await refresh()
            return true
        } catch {
            remote.model = before
            tracked[docID] = previous
            context.report(error)
            return false
        }
    }
}

/// Prüfansicht eines Entwurfs (`/lesen/ingest/doc?id=` im Web), der Lesemoment des Ingests:
/// Digest, Source-Page mit änderbaren Feldern, Vorschläge zum Abhaken (Vorauswahl wie der Server,
/// alle/keine je Gruppe) und „Ins Wiki übernehmen“, dazu „Neu entwerfen“, „Ohne Wiki erledigen“
/// und „Entwurf verwerfen“.
///
/// Auswahl und Felder gehören dem Nutzer: Ein Neuladen desselben Entwurfs lässt sie stehen, ein
/// neuer Entwurf (oder ein Abbruch, der Felder sperrt) setzt sie neu. Solange Claude entwirft,
/// fragt der Store alle 3 s nach. Ohne Netz meldet jede Aktion „Keine Verbindung zum Cockpit.
/// Nichts gespeichert.“; gepuffert wird nichts.
@MainActor
@Observable
public final class IngestReviewStore {
    public let docID: String
    /// Gewählte Vorschläge (IDs).
    public private(set) var selection: Set<String> = []
    /// Felder der Source-Page (Titel, Summary, Slug, Tags durch Komma getrennt).
    public var title = ""
    public var summary = ""
    public var slug = ""
    public var tags = ""
    /// Laufende Aktion: `uebernehmen`, `entwerfen`, `erledigen`, `verwerfen`.
    public private(set) var busy: Set<String> = []
    public private(set) var isPolling = false

    private let remote: RemoteModel<IngestDocModel>
    private let context: CockpitContext
    private let overview: IngestStore?
    private let pollInterval: UInt64
    /// Entwurf, dessen Auswahl und Felder übernommen sind (Kennung aus Zeitpunkten und Sperren).
    @ObservationIgnored private var adopted: String?
    @ObservationIgnored private var wantsPolling = false
    @ObservationIgnored private var active = true
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    /// `overview` erfährt, was hier passiert (Abzeichen, Zähler); `pollInterval` in Sekunden.
    public init(context: CockpitContext, docID: String, overview: IngestStore? = nil, pollInterval: TimeInterval = 3) {
        self.context = context
        self.docID = docID
        self.overview = overview
        self.pollInterval = UInt64(max(0, pollInterval) * 1_000_000_000)
        remote = RemoteModel(context: context, path: "api/lesen/ingest/doc")
    }

    public var model: IngestDocModel? { remote.model }
    public var state: LoadState { remote.state }
    public var view: IngestDraftView? { remote.model?.view }

    /// „Diesen Text gibt es nicht (mehr).“ (404)
    public var isNotFound: Bool {
        if case .failed(404, _, _) = state.error { return true }
        return false
    }

    static func cacheKey(_ id: String) -> String {
        "lesen/ingest/doc/\(id)"
    }

    /// Rücksprung der Formulare im Web; damit liefert der Server beim Verwerfen den nächsten Entwurf.
    static func backPath(_ id: String) -> String {
        ReadingRoute.ingestReview(id: id).webPath
    }

    // MARK: Laden

    public func load() async {
        remote.select(key: Self.cacheKey(docID), query: CockpitAPI.docQuery(docID)) { [docID] model in
            model.ingest?.id == docID
        }
        adopt()
        await refresh()
    }

    /// Lädt neu; ist der Entwurf gerade fertig geworden, gibt es Haptik.
    public func refresh() async {
        let wasBusy = IngestStatus.isBusy(remote.model?.status)
        await remote.refresh()
        adopt()
        if wasBusy, remote.model?.isReady == true { context.toasts.signal(.success) }
        schedulePoll()
    }

    /// Auswahl und Felder zum geladenen Stand: neuer Entwurf → Vorauswahl und Felder des Servers;
    /// derselbe → was der Nutzer gewählt hat, ohne Vorschläge, die es nicht mehr gibt.
    private func adopt() {
        guard let model = remote.model, let view = model.view else {
            adopted = nil
            return
        }
        let ids = Set(view.items.map(\.id))
        let source = view.source
        let key = [model.ingest?.requestedAt ?? "-", model.ingest?.draftedAt ?? "-", source.locked ? "fest" : "frei", source.slugLocked ? source.slug : "-"].joined(separator: "|")
        if key != adopted {
            selection = Set(model.selected).intersection(ids)
            title = source.title
            summary = source.summary
            slug = source.slug
            tags = source.tags.joined(separator: ", ")
            adopted = key
        } else {
            selection.formIntersection(ids)
        }
    }

    // MARK: Abhaken

    public func isSelected(_ id: String) -> Bool {
        selection.contains(id)
    }

    /// Tipp auf eine Zeile: Häkchen umschalten.
    public func toggle(_ id: String) {
        guard view?.item(id) != nil else { return }
        if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }
        context.toasts.signal(.selection)
    }

    /// „alle“ einer Gruppe.
    public func selectAll(_ group: IngestGroup) {
        let ids = group.ids.filter { view?.item($0) != nil }
        guard !Set(ids).isSubset(of: selection) else { return }
        selection.formUnion(ids)
        context.toasts.signal(.selection)
    }

    /// „keine“ einer Gruppe.
    public func selectNone(_ group: IngestGroup) {
        guard !selection.isDisjoint(with: group.ids) else { return }
        selection.subtract(group.ids)
        context.toasts.signal(.selection)
    }

    public func allSelected(_ group: IngestGroup) -> Bool {
        Set(group.ids).isSubset(of: selection)
    }

    public func noneSelected(_ group: IngestGroup) -> Bool {
        selection.isDisjoint(with: group.ids)
    }

    /// Gewählte Vorschläge in der Reihenfolge des Entwurfs.
    public var chosen: [String] {
        view?.items.map(\.id).filter(selection.contains) ?? []
    }

    /// Zahl am Knopf: Source-Page plus gewählte Vorschläge.
    public var applyCount: Int { chosen.count + 1 }

    /// „Source-Page und 3 Vorschläge“ bzw. „Nur die Source-Page“.
    public var applySummary: String { CockpitFormat.ingestApplySummary(chosen.count) }

    // MARK: Felder

    public var fieldsLocked: Bool { view?.source.locked ?? false }
    public var slugLocked: Bool { view?.source.slugLocked ?? false }
    public var summaryLimit: Int { model?.summaryMax ?? 80 }
    /// Zeichen der Summary wie `length` im Browser (UTF-16).
    public var summaryCount: Int { summary.utf16.count }
    public var isSummaryOver: Bool { summaryCount > summaryLimit }

    /// Warum der Slug nicht geht (wie `pattern` im Web), nil = geht oder ist leer.
    public var slugProblem: String? {
        Self.isValidSlug(slug.trimmingCharacters(in: .whitespaces)) ? nil : "Kleinbuchstaben, Ziffern und Bindestriche"
    }

    /// `[a-z0-9]+(-[a-z0-9]+)*` oder leer.
    nonisolated static func isValidSlug(_ slug: String) -> Bool {
        guard !slug.isEmpty else { return true }
        guard slug.first != "-", slug.last != "-", !slug.contains("--") else { return false }
        return slug.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    /// Übernehmen geht mit bereitem Entwurf, Titel und gültigem Slug, einmal zugleich.
    public var canApply: Bool {
        guard model?.isReady == true, busy.isEmpty else { return false }
        if fieldsLocked { return true }
        return !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (slugLocked || slugProblem == nil)
    }

    // MARK: Aktionen

    /// „Ins Wiki übernehmen“: gewählte Vorschläge und die Felder der Source-Page (gesperrte so,
    /// wie der Server sie kennt). Liefert, wohin es danach geht (`redirect`: der nächste bereite
    /// Entwurf oder die Übersicht); nil bei Fehler. Nach einem Abbruch lädt die Ansicht neu und
    /// zeigt „Übernehmen unterbrochen“.
    @discardableResult
    public func apply() async -> String? {
        guard canApply, let source = view?.source else { return nil }
        busy.insert("uebernehmen")
        defer { busy.remove("uebernehmen") }
        context.toasts.signal(.selection)
        var pairs: [(String, String)] = [("id", docID)]
        pairs += chosen.map { ("item", $0) }
        pairs += [
            ("title", fieldsLocked ? source.title : title.trimmingCharacters(in: .whitespacesAndNewlines)),
            ("summary", fieldsLocked ? source.summary : summary.trimmingCharacters(in: .whitespacesAndNewlines)),
            ("slug", slugLocked ? source.slug : slug.trimmingCharacters(in: .whitespaces)),
            ("tags", fieldsLocked ? source.tags.joined(separator: ", ") : tags),
            ("back", Self.backPath(docID)),
        ]
        do {
            let response = try await context.api.action(IngestAction.apply, pairs: pairs, as: IngestActionResponse.self)
            context.toasts.signal(.success)
            if let link = response.link {
                let open = context.openPath
                context.toasts.show(response.message, action: Toast.Action(label: link.label) { open(link.href) })
            } else {
                context.toasts.show(response.message)
            }
            remote.model?.ingest?.status = IngestStatus.applied
            overview?.record(docID, status: IngestStatus.applied)
            return response.redirect ?? ReadingRoute.ingest.webPath
        } catch {
            context.report(error)
            // Abgebrochen statt abgelehnt: Der Server nennt jetzt, was schon geschrieben ist.
            if !CockpitError.from(error, action: true).isOffline { await refresh() }
            return nil
        }
    }

    /// „Ingest entwerfen“ (noch kein Entwurf) bzw. „Neu entwerfen“ / „Erneut entwerfen“ (`force`).
    @discardableResult
    public func draft(force: Bool = false) async -> Bool {
        guard busy.isEmpty else { return false }
        busy.insert("entwerfen")
        defer { busy.remove("entwerfen") }
        context.toasts.signal(.selection)
        var fields = ["id": docID]
        if force { fields["force"] = "1" }
        do {
            let response = try await context.api.action(IngestAction.draft, fields: fields, as: IngestActionResponse.self)
            context.toasts.show(response.message)
            let status = response.ingest?.status ?? IngestStatus.waiting
            remote.model?.ingest?.status = status
            overview?.record(docID, status: status)
            await refresh()
            return true
        } catch {
            context.report(error)
            return false
        }
    }

    /// „Ohne Wiki erledigen“: gelesen und weg, mit „Rückgängig“ (der Text kommt auf den Stapel
    /// zurück). Liefert den nächsten Ort wie `apply()`.
    @discardableResult
    public func finishWithoutWiki() async -> String? {
        await discard(done: true)
    }

    /// „Entwurf verwerfen“: der Text bleibt auf dem Stapel.
    @discardableResult
    public func discardDraft() async -> String? {
        await discard(done: false)
    }

    private func discard(done: Bool) async -> String? {
        guard busy.isEmpty else { return nil }
        let key = done ? "erledigen" : "verwerfen"
        busy.insert(key)
        defer { busy.remove(key) }
        context.toasts.signal(.selection)
        var fields = ["id": docID, "back": Self.backPath(docID)]
        if done { fields["done"] = "1" }
        do {
            let response = try await context.api.action(IngestAction.discard, fields: fields, as: IngestActionResponse.self)
            if done { context.toasts.signal(.success) }
            if let undo = response.undo {
                let context = context
                let overview = overview
                context.toasts.show(response.message, action: Toast.Action(label: "Rückgängig") {
                    Task {
                        _ = await ReadingActions(context: context).run(undo.action, undo.fields)
                        await overview?.refresh()
                    }
                })
            } else {
                context.toasts.show(response.message)
            }
            remote.model?.ingest?.status = IngestStatus.discarded
            overview?.record(docID, status: IngestStatus.discarded)
            return response.redirect ?? ReadingRoute.ingest.webPath
        } catch {
            context.report(error)
            return nil
        }
    }

    // MARK: Nachfragen

    /// Ansicht sichtbar: alle 3 s nachfragen, solange Claude entwirft.
    public func startPolling() {
        wantsPolling = true
        schedulePoll()
    }

    public func stopPolling() {
        wantsPolling = false
        cancelPoll()
    }

    public func setActive(_ active: Bool) {
        let back = active && !self.active
        self.active = active
        if !active {
            cancelPoll()
        } else if back, wantsPolling, IngestStatus.isBusy(remote.model?.status) {
            Task { await refresh() }
        }
    }

    private func schedulePoll() {
        guard wantsPolling, active, pollTask == nil, IngestStatus.isBusy(remote.model?.status) else {
            isPolling = pollTask != nil
            return
        }
        let interval = pollInterval
        pollTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: interval)
            guard !Task.isCancelled, let self else { return }
            self.pollTask = nil
            await self.refresh()
        }
        isPolling = true
    }

    private func cancelPoll() {
        pollTask?.cancel()
        pollTask = nil
        isPolling = false
    }
}
