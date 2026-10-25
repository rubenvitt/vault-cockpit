import Foundation
import Observation

/// Folgen: Liste, Stand der entstehenden (alle 3 s, solange eine entsteht und die App vorne
/// ist), Löschen, Fortsetzen, „Audio erzeugen“ zu einem Transkript und die Meldung „Fertig: …“
/// bzw. „Transkript fertig: …“, wenn eine fertig wird.
@MainActor
@Observable
public final class EpisodesStore {
    /// Folgen (IDs), an denen gerade eine Aktion läuft.
    public private(set) var busy: Set<String> = []
    /// Die Liste fragt gerade regelmäßig nach.
    public private(set) var isPolling = false

    /// „Abspielen“ in der Meldung „Fertig: …“ (der native Player).
    @ObservationIgnored public var onPlay: (@MainActor (Episode) -> Void)?

    private let remote: RemoteModel<EpisodeListModel>
    private let context: CockpitContext
    private let pollInterval: UInt64
    private var actions: ReadingActions { ReadingActions(context: context) }
    @ObservationIgnored private var wantsPolling = false
    @ObservationIgnored private var active = true
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    /// `pollInterval` in Sekunden (Tests verkürzen es).
    public init(context: CockpitContext, pollInterval: TimeInterval = 3) {
        self.context = context
        self.pollInterval = UInt64(max(0, pollInterval) * 1_000_000_000)
        remote = RemoteModel(context: context, path: "api/lesen/folgen")
    }

    public var model: EpisodeListModel? { remote.model }
    public var state: LoadState { remote.state }

    // MARK: Laden

    public func load() async {
        remote.select(key: "lesen/folgen", query: []) { _ in true }
        await refresh()
    }

    /// Lädt neu; meldet Folgen, die seit dem letzten Stand fertig geworden sind.
    public func refresh() async {
        let busyBefore = Set(remote.model?.items.filter(\.busy).map(\.id) ?? [])
        await remote.refresh()
        if let items = remote.model?.items {
            for episode in items where busyBefore.contains(episode.id) && (episode.isDone || episode.isTranscript) {
                announce(episode)
            }
        }
        schedulePoll()
    }

    private func announce(_ episode: Episode) {
        context.toasts.signal(.success)
        if episode.isTranscript {
            context.toasts.show("Transkript fertig: \(episode.title)")
        } else if let play = onPlay {
            context.toasts.show("Fertig: \(episode.title)", action: Toast.Action(label: "Abspielen") { play(episode) })
        } else {
            context.toasts.show("Fertig: \(episode.title)")
        }
    }

    // MARK: Nachfragen

    /// Liste sichtbar: alle 3 s nachfragen, solange eine Folge entsteht.
    public func startPolling() {
        wantsPolling = true
        schedulePoll()
    }

    /// Liste weg.
    public func stopPolling() {
        wantsPolling = false
        cancelPoll()
    }

    /// App vorne oder im Hintergrund: im Hintergrund wird nicht nachgefragt; zurück vorne gleich.
    public func setActive(_ active: Bool) {
        let back = active && !self.active
        self.active = active
        if !active {
            cancelPoll()
        } else if back, wantsPolling, model?.hasBusy == true {
            Task { await refresh() }
        }
    }

    private func schedulePoll() {
        guard wantsPolling, active, pollTask == nil, remote.model?.hasBusy == true else {
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

    /// „Löschen“: sofort aus der Liste; scheitert es (etwa weil sie gerade entsteht), kommt sie zurück.
    @discardableResult
    public func delete(_ episode: Episode) async -> Bool {
        guard let before = remote.model, let index = before.items.firstIndex(where: { $0.id == episode.id }), !busy.contains(episode.id) else { return false }
        busy.insert(episode.id)
        defer { busy.remove(episode.id) }
        remote.model?.items.remove(at: index)
        guard await actions.run(ReadingAction.episodeDelete, ["id": episode.id]) != nil else {
            if let items = remote.model?.items, !items.contains(where: { $0.id == episode.id }) {
                remote.model?.items.insert(episode, at: min(index, items.count))
            }
            return false
        }
        await refresh()
        return true
    }

    /// „Fortsetzen“ bzw. „Erneut versuchen“ einer fehlgeschlagenen Folge.
    @discardableResult
    public func resume(_ episode: Episode) async -> Bool {
        guard !busy.contains(episode.id) else { return false }
        busy.insert(episode.id)
        defer { busy.remove(episode.id) }
        guard await actions.run(ReadingAction.episodeResume, ["id": episode.id]) != nil else { return false }
        await refresh()
        return true
    }

    /// „Audio erzeugen“ zu einem fertigen Transkript: aus demselben Skript, Claude schreibt nicht
    /// noch einmal.
    @discardableResult
    public func speak(_ episode: Episode) async -> Bool {
        guard episode.isTranscript, !busy.contains(episode.id) else { return false }
        busy.insert(episode.id)
        defer { busy.remove(episode.id) }
        guard await actions.run(ReadingAction.episodeSpeak, ["id": episode.id]) != nil else { return false }
        await refresh()
        return true
    }
}

/// „Neue Folge“ in Schritten: Texte des Zeitfensters (alle vorausgewählt), Art (Vorlesen,
/// Podcast, Report), bei Podcast und Report Länge, Ton, Schwerpunkt (Themen der Texte, eigener
/// Wunsch) und ob gleich das Audio entsteht oder erst nur das Transkript. Der Satz am Knopf rechnet bei jeder Änderung
/// neu wie `newSummary` (src/lesen/folgen-page.js). Abgeschickt wird höchstens einmal: Doppelt
/// abgeschickt würde zwei Folgen bezahlen.
@MainActor
@Observable
public final class NewEpisodeStore {
    /// Gewähltes Zeitfenster, nil = 30 Min. (Server).
    public private(set) var zeit: Int?
    /// Gewählte Texte (IDs).
    public private(set) var selection: Set<String> = []
    /// Gewählte Art, nil = keine geht.
    public private(set) var kind: String?
    /// Länge in Minuten (Podcast, Report).
    public private(set) var length = 10
    /// Ton (Podcast, Report), nil = der Server kennt keinen.
    public private(set) var style: String?
    /// Themen des Schwerpunkts (höchstens `maxTopics`).
    public private(set) var topics: Set<String> = []
    /// Eigener Schwerpunkt (höchstens `maxFocus` Zeichen).
    public private(set) var focus = ""
    /// false: erst nur das Transkript, Audio später auf Knopfdruck.
    public private(set) var audio = true
    public private(set) var isSubmitting = false
    /// Abgeschickt: kein zweites Mal.
    public private(set) var didSubmit = false

    /// Folge angelegt (die Liste lädt neu und fragt nach).
    @ObservationIgnored public var onCreated: (@MainActor () -> Void)?

    private let remote: RemoteModel<NewEpisodeModel>
    private let context: CockpitContext
    /// Zeitfenster, für das die Auswahl gilt; ein anderes wählt wieder alle Texte.
    @ObservationIgnored private var selectionZeit: Int??

    public init(context: CockpitContext) {
        self.context = context
        remote = RemoteModel(context: context, path: "api/lesen/folgen/neu")
    }

    public var model: NewEpisodeModel? { remote.model }
    public var state: LoadState { remote.state }

    // MARK: Laden

    public func load(zeit: Int? = nil) async {
        self.zeit = zeit
        remote.select(key: "lesen/folgen/neu/\(zeit.map(String.init) ?? "standard")", query: CockpitAPI.zeitQuery(zeit)) { model in
            zeit == nil || model.zeit == zeit
        }
        adopt()
        await remote.refresh()
        adopt()
    }

    public func refresh() async {
        await remote.refresh()
        adopt()
    }

    /// Auswahl, Art und Länge zum geladenen Stand: neues Zeitfenster wählt alle Texte, eine Art,
    /// die nicht (mehr) geht, wird die erste mögliche.
    private func adopt() {
        guard let model else { return }
        if selectionZeit != .some(model.zeit) {
            selection = Set(model.docs.map(\.id))
            selectionZeit = .some(model.zeit)
        } else {
            selection.formIntersection(model.docs.map(\.id))
        }
        if kind == nil || !isAvailable(kind!) { kind = model.defaultKind }
        if !model.lengths.contains(length) { length = model.defaultLength }
        if style == nil || !model.styles.contains(where: { $0.style == style }) {
            let fallback = model.styles.first?.style
            if let key = model.defaultStyle, model.styles.contains(where: { $0.style == key }) {
                style = key
            } else {
                style = fallback
            }
        }
        topics.formIntersection(model.topics.map(\.label))
        if !model.transcriptOnly { audio = true }
    }

    // MARK: Auswahl

    public func isAvailable(_ kind: String) -> Bool {
        model?.kinds.first { $0.kind == kind }?.isAvailable ?? false
    }

    public func toggle(_ docID: String) {
        guard model?.docs.contains(where: { $0.id == docID }) == true else { return }
        if selection.contains(docID) { selection.remove(docID) } else { selection.insert(docID) }
        context.toasts.signal(.selection)
    }

    /// Art wählen; Arten mit Grund (`missing`) gehen nicht.
    public func select(kind: String) {
        guard isAvailable(kind) else { return }
        self.kind = kind
        context.toasts.signal(.selection)
    }

    public func select(length: Int) {
        guard model?.lengths.contains(length) ?? false else { return }
        self.length = length
        context.toasts.signal(.selection)
    }

    public func select(style: String) {
        guard model?.styles.contains(where: { $0.style == style }) == true else { return }
        self.style = style
        context.toasts.signal(.selection)
    }

    /// Thema an oder ab; mehr als `maxTopics` gehen nicht.
    public func toggle(topic: String) {
        guard let model, model.topics.contains(where: { $0.label == topic }) else { return }
        if topics.contains(topic) {
            topics.remove(topic)
        } else {
            guard topics.count < model.maxTopics else { return }
            topics.insert(topic)
        }
        context.toasts.signal(.selection)
    }

    /// Ein weiteres Thema geht noch (sonst sind die übrigen gesperrt).
    public var canAddTopic: Bool { topics.count < (model?.maxTopics ?? 5) }

    public func set(focus: String) {
        self.focus = String(focus.prefix(model?.maxFocus ?? 200))
    }

    /// Gleich mit Audio oder erst nur das Transkript (nur, wenn der Server das kann).
    public func select(audio: Bool) {
        guard audio || model?.transcriptOnly == true else { return }
        self.audio = audio
        context.toasts.signal(.selection)
    }

    /// Erklärung zum gewählten Ton.
    public var styleHint: String? {
        model?.styles.first { $0.style == style }?.description
    }

    /// Themen in der Reihenfolge der Liste (häufigste zuerst).
    public var selectedTopics: [String] {
        model?.topics.map(\.label).filter { topics.contains($0) } ?? []
    }

    /// Gewählte Texte in der Reihenfolge der Liste.
    public var selectedDocs: [StackItem] {
        model?.docs.filter { selection.contains($0.id) } ?? []
    }

    /// Zeichen fürs Vorlesen der gewählten Texte.
    public var selectedChars: Int {
        selectedDocs.reduce(0) { $0 + ($1.chars ?? 0) }
    }

    /// Länge gilt nur für Podcast und Report.
    public var usesLength: Bool { kind != nil && kind != "vorlesen" }

    /// Satz am Knopf: „Vorlesen · 3 Texte · etwa 10 Min.“ und die Kosten.
    public var summary: EpisodeSummary {
        guard let model else { return EpisodeSummary(main: "", cost: "") }
        guard let kind else { return model.summary ?? EpisodeSummary(main: "Folgen brauchen ElevenLabs", cost: "Einstellungen → Vorlesen") }
        let label = model.kinds.first { $0.kind == kind }?.label
        return Self.summary(kind: kind, label: label, texts: selection.count, chars: selectedChars, minutes: length, charsPerMinute: model.spokenCharsPerMinute, audio: !usesLength || audio)
    }

    /// Abschicken geht mit einer Art, mindestens einem und höchstens `maxDocs` Texten, einmal.
    public var canSubmit: Bool {
        guard let model, model.enabled, let kind, isAvailable(kind) else { return false }
        return !selection.isEmpty && selection.count <= model.maxDocs && !isSubmitting && !didSubmit
    }

    // MARK: Abschicken

    /// Legt die Folge an (`/aktion/lesen/folge/neu`); sie entsteht im Hintergrund.
    @discardableResult
    public func submit() async -> Bool {
        guard canSubmit, let kind else { return false }
        isSubmitting = true
        defer { isSubmitting = false }
        var pairs: [(String, String)] = [("art", kind)] + selectedDocs.map { ("doc", $0.id) } + [("laenge", String(length))]
        if usesLength {
            if let style { pairs.append(("stil", style)) }
            pairs += selectedTopics.map { ("thema", $0) }
            let wish = focus.trimmingCharacters(in: .whitespacesAndNewlines)
            if !wish.isEmpty { pairs.append(("fokus", wish)) }
            if model?.transcriptOnly == true { pairs.append(("audio", audio ? "1" : "0")) }
        }
        do {
            let response = try await context.api.action(ReadingAction.episodeNew, pairs: pairs, as: ReadingActionResponse.self)
            didSubmit = true
            context.toasts.signal(.success)
            context.toasts.show(response.message)
            onCreated?()
            return true
        } catch {
            context.report(error)
            return false
        }
    }

    // MARK: Rechnen wie newSummary

    /// `newSummary` aus src/lesen/folgen-page.js (und lesen-folgen.js beim Umschalten).
    nonisolated public static func summary(kind: String, label: String? = nil, texts: Int, chars: Int, minutes: Int, charsPerMinute: Int = 900, audio: Bool = true) -> EpisodeSummary {
        guard texts > 0 else { return EpisodeSummary(main: "Bitte mindestens einen Text wählen", cost: "") }
        let n = "\(texts) \(texts == 1 ? "Text" : "Texte")"
        let name = label ?? kindLabels[kind] ?? kind
        if kind == "vorlesen" {
            let spoken = max(1, Int((Double(chars) / Double(max(1, charsPerMinute))).rounded()))
            return EpisodeSummary(main: "\(name) · \(n) · etwa \(spoken) Min.", cost: chars > 0 ? "rund \(grouped(chars)) Zeichen bei ElevenLabs" : "Schon alles gehört, kostet nichts")
        }
        if !audio {
            return EpisodeSummary(main: "\(name) · \(n) · \(minutes) Min. · erst Transkript", cost: "Nur dein Claude-Abo; Audio später auf Knopfdruck")
        }
        return EpisodeSummary(main: "\(name) · \(n) · \(minutes) Min.", cost: "rund \(grouped(minutes * charsPerMinute)) Zeichen bei ElevenLabs, dazu dein Claude-Abo")
    }

    nonisolated static let kindLabels = ["vorlesen": "Vorlesen", "podcast": "Podcast", "report": "Report"]

    /// Ganze Zahl mit Tausenderpunkten wie `Intl.NumberFormat('de-DE')`: `8642` → `8.642`.
    nonisolated public static func grouped(_ value: Int) -> String {
        let digits = String(abs(value))
        var out = ""
        for (index, digit) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { out.append(".") }
            out.append(digit)
        }
        return value < 0 ? "-\(out)" : out
    }
}

extension CockpitFormat {
    /// Zeitpunkt als ISO-Text wie in der Datenbank (`2026-10-25T09:07:32.037Z`).
    static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
