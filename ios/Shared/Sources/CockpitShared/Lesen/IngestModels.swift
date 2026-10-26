import Foundation

// Modelle für den Ingest ins Wiki (`/api/lesen/ingest`, `/api/lesen/ingest/doc?id=`,
// src/lesen/ingest-page.js). Claudes Texte kommen als Baum wie in `/api/notiz` (`NoteInline`,
// `NoteBlock`), Wikilinks schon wie in der Prüfansicht des Webs umgeschrieben: bekannte Seiten
// als Link mit Titel, alles andere als Text.

/// Status eines Entwurfs: `wartet`, `entwirft`, `bereit`, `fehler`, `uebernommen`, `verworfen`.
public enum IngestStatus {
    public static let waiting = "wartet"
    public static let drafting = "entwirft"
    public static let ready = "bereit"
    public static let failed = "fehler"
    public static let applied = "uebernommen"
    public static let discarded = "verworfen"

    /// Claude arbeitet daran (`wartet`, `entwirft`).
    public static func isBusy(_ status: String?) -> Bool {
        status == waiting || status == drafting
    }

    /// Steht in der Übersicht (`bereit`, in Arbeit, `fehler`).
    public static func isActive(_ status: String?) -> Bool {
        isBusy(status) || status == ready || status == failed
    }
}

/// Was ein Entwurf anbietet, nach Art (`tally` im Web).
public struct IngestTally: Decodable, Equatable, Sendable {
    public let verknuepfen: Int
    public let bestaetigung: Int
    public let synthese: Int
    /// Ergänzungen bestehender Synthesen („Synthese ergänzen“).
    public let ergaenzung: Int
    public let frage: Int
    public let neu: Int
    public let relation: Int

    enum CodingKeys: String, CodingKey { case verknuepfen, bestaetigung, synthese, ergaenzung, frage, neu, relation }

    public init(verknuepfen: Int = 0, bestaetigung: Int = 0, synthese: Int = 0, ergaenzung: Int = 0, frage: Int = 0, neu: Int = 0, relation: Int = 0) {
        self.verknuepfen = verknuepfen
        self.bestaetigung = bestaetigung
        self.synthese = synthese
        self.ergaenzung = ergaenzung
        self.frage = frage
        self.neu = neu
        self.relation = relation
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        verknuepfen = try c.decodeIfPresent(Int.self, forKey: .verknuepfen) ?? 0
        bestaetigung = try c.decodeIfPresent(Int.self, forKey: .bestaetigung) ?? 0
        synthese = try c.decodeIfPresent(Int.self, forKey: .synthese) ?? 0
        ergaenzung = try c.decodeIfPresent(Int.self, forKey: .ergaenzung) ?? 0
        frage = try c.decodeIfPresent(Int.self, forKey: .frage) ?? 0
        neu = try c.decodeIfPresent(Int.self, forKey: .neu) ?? 0
        relation = try c.decodeIfPresent(Int.self, forKey: .relation) ?? 0
    }

    /// Hinweis an der Karte, wenn Claude über den Text hinaus etwas anbietet (`offerLabel` im Web).
    public var offerLabel: String? {
        if synthese > 0 { return synthese == 1 ? "Synthese angeboten" : "Synthesen angeboten" }
        if ergaenzung > 0 { return ergaenzung == 1 ? "Ergänzung angeboten" : "Ergänzungen angeboten" }
        return frage > 0 ? "Frage angeboten" : nil
    }
}

/// Zähler der Entwürfe je Status (`ingest.counts()`).
public struct IngestCounts: Decodable, Equatable, Sendable {
    public let wartet: Int
    public let entwirft: Int
    public let bereit: Int
    public let fehler: Int

    enum CodingKeys: String, CodingKey { case wartet, entwirft, bereit, fehler }

    public init(wartet: Int = 0, entwirft: Int = 0, bereit: Int = 0, fehler: Int = 0) {
        self.wartet = wartet
        self.entwirft = entwirft
        self.bereit = bereit
        self.fehler = fehler
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        wartet = try c.decodeIfPresent(Int.self, forKey: .wartet) ?? 0
        entwirft = try c.decodeIfPresent(Int.self, forKey: .entwirft) ?? 0
        bereit = try c.decodeIfPresent(Int.self, forKey: .bereit) ?? 0
        fehler = try c.decodeIfPresent(Int.self, forKey: .fehler) ?? 0
    }
}

/// Ein Eintrag (`ingestJson`): Dokument, Status und Zählung, ohne die Texte des Entwurfs.
/// `status` ist nil für einen Text ohne Entwurf (nur in `/api/lesen/ingest/doc`).
public struct IngestEntry: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public var status: String?
    /// `nacht` oder `knopf`.
    public let origin: String?
    /// Titel der Source-Page, sonst des Dokuments.
    public let title: String
    /// Titel des Dokuments.
    public let docTitle: String
    public let url: String?
    public let site: String?
    public let readingMinutes: Int?
    /// Status des Dokuments (`stapel`, `archiv` …).
    public let docStatus: ReadingStatus?
    /// Nur bei `fehler`: warum der Entwurf scheiterte.
    public let error: String?
    public let model: String?
    public let requestedAt: String?
    public let draftedAt: String?
    public let appliedAt: String?
    public let updatedAt: String?
    public let kernaussagen: [String]
    /// Die ersten drei Kernaussagen als Baum (für die Karten).
    public let kern: [[NoteInline]]
    public let tally: IngestTally
    /// „3 Verknüpfungen · 1 Synthese“, „nur die Source-Page“.
    public let tallyLabel: String
    /// In Arbeit: „Claude entwirft, seit 2 Min. (meist 1 bis 3 Minuten)“.
    public var label: String?

    enum CodingKeys: String, CodingKey {
        case id, status, origin, title, docTitle, url, site, readingMinutes, docStatus, error, model, requestedAt, draftedAt, appliedAt, updatedAt, kernaussagen, kern, tally, tallyLabel, label
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        origin = try c.decodeIfPresent(String.self, forKey: .origin)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Ohne Titel"
        docTitle = try c.decodeIfPresent(String.self, forKey: .docTitle) ?? title
        url = try c.decodeIfPresent(String.self, forKey: .url)
        site = try c.decodeIfPresent(String.self, forKey: .site)
        readingMinutes = try? c.decodeIfPresent(Int.self, forKey: .readingMinutes)
        docStatus = try c.decodeIfPresent(ReadingStatus.self, forKey: .docStatus)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        requestedAt = try c.decodeIfPresent(String.self, forKey: .requestedAt)
        draftedAt = try c.decodeIfPresent(String.self, forKey: .draftedAt)
        appliedAt = try c.decodeIfPresent(String.self, forKey: .appliedAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        kernaussagen = try c.decodeIfPresent([String].self, forKey: .kernaussagen) ?? []
        kern = try c.decodeIfPresent([[NoteInline]].self, forKey: .kern) ?? []
        tally = try c.decodeIfPresent(IngestTally.self, forKey: .tally) ?? IngestTally()
        tallyLabel = try c.decodeIfPresent(String.self, forKey: .tallyLabel) ?? "nur die Source-Page"
        label = try c.decodeIfPresent(String.self, forKey: .label)
    }

    public var isBusy: Bool { IngestStatus.isBusy(status) }

    /// Meta der Karte wie `readyCard`: „Blatt · 7 Min. · nachts entworfen · 25. Okt., 03:10“.
    public func meta(timeZone: TimeZone = .current) -> String {
        CockpitFormat.meta([
            site,
            readingMinutes.flatMap { $0 > 0 ? "\($0) Min." : nil },
            origin == "nacht" ? "nachts entworfen" : nil,
            draftedAt.flatMap(CockpitFormat.date(from:)).map { CockpitFormat.dayTime($0, timeZone: timeZone) },
        ])
    }

    /// Satz zu einem Entwurf in Arbeit; ohne `label` vom Server wie `busyLabel` ohne Minuten.
    public var busyLabel: String {
        if let label, !label.isEmpty { return label }
        if status == IngestStatus.waiting { return origin == "nacht" ? "Wartet auf den Nachtlauf" : "Wartet, bis Claude frei ist" }
        return "Claude entwirft (meist 1 bis 3 Minuten)"
    }
}

/// `GET /api/lesen/ingest`: bereite Entwürfe, in Arbeit, fehlgeschlagene. Ohne Ingest-Dienst
/// `enabled: false` (dann gibt es den Bereich nicht).
public struct IngestOverviewModel: Decodable, Equatable, Sendable {
    public let enabled: Bool
    /// Claude ist angebunden; ohne entstehen keine neuen Entwürfe, fertige lassen sich abhaken.
    public let available: Bool
    public let reason: String?
    public var counts: IngestCounts
    /// Texte auf dem Stapel ohne fertigen Entwurf („Ganzen Stapel entwerfen“).
    public var openOnStack: Int
    public var ready: [IngestEntry]
    public var busy: [IngestEntry]
    public var failed: [IngestEntry]

    enum CodingKeys: String, CodingKey { case enabled, available, reason, counts, openOnStack, ready, busy, failed }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
        counts = try c.decodeIfPresent(IngestCounts.self, forKey: .counts) ?? IngestCounts()
        openOnStack = try c.decodeIfPresent(Int.self, forKey: .openOnStack) ?? 0
        ready = try c.decodeIfPresent([IngestEntry].self, forKey: .ready) ?? []
        busy = try c.decodeIfPresent([IngestEntry].self, forKey: .busy) ?? []
        failed = try c.decodeIfPresent([IngestEntry].self, forKey: .failed) ?? []
    }

    /// Ein Entwurf entsteht gerade (dann fragt die Übersicht nach).
    public var hasBusy: Bool { !busy.isEmpty }
    /// „Nichts zum Abhaken“
    public var isEmpty: Bool { ready.isEmpty && busy.isEmpty && failed.isEmpty }

    /// Status eines Dokuments, wenn es in der Übersicht steht (bereit, in Arbeit, Fehler).
    public func status(of docID: String) -> String? {
        if ready.contains(where: { $0.id == docID }) { return IngestStatus.ready }
        if let entry = busy.first(where: { $0.id == docID }) { return entry.status ?? IngestStatus.waiting }
        if failed.contains(where: { $0.id == docID }) { return IngestStatus.failed }
        return nil
    }

    /// „Ein Text auf dem Stapel hat noch keinen fertigen Entwurf.“
    public var openLabel: String? {
        guard openOnStack > 0 else { return nil }
        return openOnStack == 1 ? "Ein Text auf dem Stapel hat noch keinen fertigen Entwurf." : "\(openOnStack) Texte auf dem Stapel haben noch keinen fertigen Entwurf."
    }
}

// MARK: Prüfansicht

/// Seite im Wiki: `path` nur für bestehende Seiten (dann öffnet ein Tipp die Notiz).
public struct IngestPageRef: Decodable, Equatable, Hashable, Sendable {
    public let path: String?
    public let title: String

    public init(path: String?, title: String) {
        self.path = path
        self.title = title
    }
}

/// Eintrag des Digests: Bestätigt (`claim`), Widerspricht (`claim`, `vorschlag`), Dockt an (`warum`).
public struct IngestDigestRef: Decodable, Equatable, Sendable {
    public let page: IngestPageRef
    /// Bestätigte bzw. widersprochene Aussage oder warum der Text andockt.
    public let text: [NoteInline]?
    /// Vorschlag zur Auflösung eines Widerspruchs.
    public let vorschlag: [NoteInline]?

    enum CodingKeys: String, CodingKey { case path, title, claim, warum, vorschlag }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        page = IngestPageRef(path: try c.decodeIfPresent(String.self, forKey: .path), title: try c.decodeIfPresent(String.self, forKey: .title) ?? "Seite")
        text = try c.decodeIfPresent([NoteInline].self, forKey: .claim) ?? c.decodeIfPresent([NoteInline].self, forKey: .warum)
        vorschlag = try c.decodeIfPresent([NoteInline].self, forKey: .vorschlag)
    }
}

/// Die Source-Page: Felder zum Ändern, Body als Blöcke, Sperren eines unterbrochenen Übernehmens.
public struct IngestSourceView: Decodable, Equatable, Sendable {
    public let title: String
    public let summary: String
    public let slug: String
    public let tags: [String]
    public let confidence: String?
    /// „hoch“, „mittel“, „niedrig“, „spekulativ“
    public let confidenceLabel: String?
    /// `wiki/sources/<slug>.md`
    public let path: String?
    public let body: [NoteBlock]?
    /// Die Seite steht schon im Wiki: Titel, Summary und Tags sind fest.
    public let locked: Bool
    /// Der Slug ist ab dem ersten Schreiben fest.
    public let slugLocked: Bool

    enum CodingKeys: String, CodingKey { case title, summary, slug, tags, confidence, confidenceLabel, path, body, locked, slugLocked }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        slug = try c.decodeIfPresent(String.self, forKey: .slug) ?? ""
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        confidence = try c.decodeIfPresent(String.self, forKey: .confidence)
        confidenceLabel = try c.decodeIfPresent(String.self, forKey: .confidenceLabel)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        body = try c.decodeIfPresent([NoteBlock].self, forKey: .body)
        locked = try c.decodeIfPresent(Bool.self, forKey: .locked) ?? false
        slugLocked = try c.decodeIfPresent(Bool.self, forKey: .slugLocked) ?? locked
    }

    /// „Konfidenz: mittel · wiki/sources/slug.md“
    public var meta: String {
        CockpitFormat.meta([confidenceLabel.map { "Konfidenz: \($0)" }, path])
    }
}

/// Ein Vorschlag zum Abhaken (`itemRow` im Web): Kennzeichen, Titel, Texte, `open` nur für
/// bestehende Seiten.
public struct IngestItemView: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    /// `concept`, `entity`, `source`, `synthesis`, `question`, `bestaetigung`, `relation`. Als Text,
    /// nicht als Enum: Eine neue Art vom Server darf die Prüfansicht nicht brechen.
    public let kind: String?
    /// `verknuepfen`, `neu`, `ergaenzen` (bestehende Synthese um einen Abschnitt ergänzen) oder nil.
    public let action: String?
    /// „Konzept“, „Person“, „Synthese · Vergleich“ … (`kindLabel`).
    public let label: String
    public let title: String
    public let isDefault: Bool
    /// Pfad der bestehenden Seite (Symbol „öffnen“), nil für Neues.
    public let open: String?
    /// Neue Seite: ihr Slug („neu: slug“).
    public let slug: String?
    /// Relation auf Deutsch: „nutzt“, „verfasst von“.
    public let relation: String?
    public let claim: [NoteInline]?
    public let summary: [NoteInline]?
    public let warum: [NoteInline]?
    public let body: [NoteBlock]?
    public let beteiligte: [IngestPageRef]

    enum CodingKeys: String, CodingKey {
        case id, kind, action, label, title, open, slug, relation, claim, summary, warum, body, beteiligte
        case isDefault = "default"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        action = try c.decodeIfPresent(String.self, forKey: .action)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? "Vorschlag"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
        open = try c.decodeIfPresent(String.self, forKey: .open)
        slug = try c.decodeIfPresent(String.self, forKey: .slug)
        relation = try c.decodeIfPresent(String.self, forKey: .relation)
        claim = try c.decodeIfPresent([NoteInline].self, forKey: .claim)
        summary = try c.decodeIfPresent([NoteInline].self, forKey: .summary)
        warum = try c.decodeIfPresent([NoteInline].self, forKey: .warum)
        body = try c.decodeIfPresent([NoteBlock].self, forKey: .body)
        beteiligte = try c.decodeIfPresent([IngestPageRef].self, forKey: .beteiligte) ?? []
    }

    /// Relationen und Bestätigungen tragen ihr Kennzeichen nicht als Pille (wie im Web).
    public var showsLabel: Bool { kind != "relation" && kind != "bestaetigung" }

    /// Ergänzt eine bestehende Synthese (`open` ist dann diese Synthese).
    public var isExtension: Bool { action == "ergaenzen" }

    /// Slug der Synthese, die ergänzt wird („ergänzt: slug“ wie `ingest-path` im Web).
    public var extendedSlug: String? {
        guard isExtension, let path = open else { return nil }
        let name = path.split(separator: "/").last.map(String.init) ?? path
        return name.hasSuffix(".md") ? String(name.dropLast(3)) : name
    }

    /// Beschriftung des aufklappbaren Texts (`bodyLabel` im Web).
    public func bodyLabel(featured: Bool) -> String {
        if isExtension { return "Was ergänzt wird" }
        return featured ? "Ganzen Text lesen" : "Text der Seite ansehen"
    }
}

/// Unterbrochenes Übernehmen: Meldung und, falls schon geschrieben, die Source-Page.
public struct IngestHalted: Decodable, Equatable, Sendable {
    public let message: String
    public let source: String?
}

/// Entwurf als Baum (`view`).
public struct IngestDraftView: Decodable, Equatable, Sendable {
    public let kernaussagen: [[NoteInline]]
    public let neu: [[NoteInline]]
    public let bestaetigt: [IngestDigestRef]
    public let widerspricht: [IngestDigestRef]
    public let docktAn: [IngestDigestRef]
    public let hinweise: [[NoteInline]]
    public let source: IngestSourceView
    public let items: [IngestItemView]
    public let halted: IngestHalted?

    enum CodingKeys: String, CodingKey { case kernaussagen, neu, bestaetigt, widerspricht, docktAn, hinweise, source, items, halted }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kernaussagen = try c.decodeIfPresent([[NoteInline]].self, forKey: .kernaussagen) ?? []
        neu = try c.decodeIfPresent([[NoteInline]].self, forKey: .neu) ?? []
        bestaetigt = try c.decodeIfPresent([IngestDigestRef].self, forKey: .bestaetigt) ?? []
        widerspricht = try c.decodeIfPresent([IngestDigestRef].self, forKey: .widerspricht) ?? []
        docktAn = try c.decodeIfPresent([IngestDigestRef].self, forKey: .docktAn) ?? []
        hinweise = try c.decodeIfPresent([[NoteInline]].self, forKey: .hinweise) ?? []
        source = try c.decode(IngestSourceView.self, forKey: .source)
        items = try c.decodeIfPresent([IngestItemView].self, forKey: .items) ?? []
        halted = try c.decodeIfPresent(IngestHalted.self, forKey: .halted)
    }

    public func item(_ id: String) -> IngestItemView? {
        items.first { $0.id == id }
    }
}

/// Vorschlag in einer Gruppe (Kennung, Kennzeichen, vorausgewählt).
public struct IngestGroupItem: Decodable, Equatable, Hashable, Sendable {
    public let id: String
    public let label: String
    public let isDefault: Bool

    enum CodingKeys: String, CodingKey {
        case id, label
        case isDefault = "default"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        isDefault = try c.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
    }
}

/// Gruppe der Prüfansicht (`groupItems` im Web): Verknüpfen, Bestätigungen, Synthesen & Fragen
/// (`featured`, als Karten), Neue Seiten, Relationen, Weitere.
public struct IngestGroup: Decodable, Equatable, Identifiable, Sendable {
    public let key: String
    public let label: String
    public let hint: String
    public let featured: Bool
    public let items: [IngestGroupItem]

    public var id: String { key }

    enum CodingKeys: String, CodingKey { case key, label, hint, featured, items }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? key
        hint = try c.decodeIfPresent(String.self, forKey: .hint) ?? ""
        featured = try c.decodeIfPresent(Bool.self, forKey: .featured) ?? false
        items = try c.decodeIfPresent([IngestGroupItem].self, forKey: .items) ?? []
    }

    public var ids: [String] { items.map(\.id) }
}

/// `GET /api/lesen/ingest/doc?id=`: Eintrag, Entwurf als Baum, Gruppen, Vorauswahl und die
/// Stelle unter den bereiten Entwürfen.
public struct IngestDocModel: Decodable, Equatable, Sendable {
    public let enabled: Bool
    /// Claude ist angebunden („Neu entwerfen“, „Ingest entwerfen“).
    public let available: Bool
    /// Eintrag; `ingest.status` nil heißt: noch kein Entwurf.
    public var ingest: IngestEntry?
    /// Roher Fehler des Eintrags: Abbruch beim Übernehmen, Fehler des Entwurfs oder der Grund,
    /// warum der Dienst verworfen hat (z. B. „Schon im Wiki …“).
    public let error: String?
    public let view: IngestDraftView?
    public let groups: [IngestGroup]
    /// Vorausgewählt (`default`).
    public let selected: [String]
    public let summaryMax: Int
    public let prev: String?
    public let next: String?
    public let position: Int?
    public let total: Int
    /// Source-Page eines übernommenen (oder angefangenen) Entwurfs (`applied.source`).
    public let appliedSource: String?

    enum CodingKeys: String, CodingKey { case enabled, available, ingest, error, view, groups, selected, summaryMax, prev, next, position, total, applied }

    /// Nur `source` aus dem Fortschritt des Übernehmens.
    private struct Applied: Decodable {
        let source: String?
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        ingest = try c.decodeIfPresent(IngestEntry.self, forKey: .ingest)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        view = try c.decodeIfPresent(IngestDraftView.self, forKey: .view)
        groups = try c.decodeIfPresent([IngestGroup].self, forKey: .groups) ?? []
        selected = try c.decodeIfPresent([String].self, forKey: .selected) ?? []
        summaryMax = try c.decodeIfPresent(Int.self, forKey: .summaryMax) ?? 80
        prev = try c.decodeIfPresent(String.self, forKey: .prev)
        next = try c.decodeIfPresent(String.self, forKey: .next)
        position = try c.decodeIfPresent(Int.self, forKey: .position)
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        appliedSource = (try? c.decodeIfPresent(Applied.self, forKey: .applied))?.source
    }

    public var status: String? { ingest?.status }
    /// Bereit zum Abhaken (mit Entwurf).
    public var isReady: Bool { status == IngestStatus.ready && view != nil }
}

// MARK: Antworten der Aktionen

/// Link in der Meldung nach dem Übernehmen: „Source-Page öffnen“ (`/notiz?pfad=…`).
public struct IngestLink: Decodable, Equatable, Sendable {
    public let href: String
    public let label: String
}

/// Ergebnis des Übernehmens: Source-Page, Rohquelle, Neues, Verknüpftes, Bestätigtes, ergänzte
/// Synthesen (ältere Server liefern `confirmed` und `extended` nicht).
public struct IngestApplyResult: Decodable, Equatable, Sendable {
    public let source: String?
    public let raw: String?
    public let written: [String]
    public let linked: [String]
    public let confirmed: [String]
    public let extended: [String]

    enum CodingKeys: String, CodingKey { case source, raw, written, linked, confirmed, extended }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        raw = try c.decodeIfPresent(String.self, forKey: .raw)
        written = try c.decodeIfPresent([String].self, forKey: .written) ?? []
        linked = try c.decodeIfPresent([String].self, forKey: .linked) ?? []
        confirmed = try c.decodeIfPresent([String].self, forKey: .confirmed) ?? []
        extended = try c.decodeIfPresent([String].self, forKey: .extended) ?? []
    }
}

/// Stand eines Dokuments nach „Entwerfen“.
public struct IngestStatusRef: Decodable, Equatable, Sendable {
    public let id: String
    public let status: String?
}

/// Antwort der Aktionen unter `/aktion/lesen/ingest/…`: Meldung, `undo` (ohne Wiki erledigt),
/// `redirect` (nächster bereiter Entwurf), `link` und `result` (übernommen), `ingest`
/// (entworfen) bzw. `count` (ganzer Stapel).
public struct IngestActionResponse: ActionReply, Equatable, Sendable {
    public let ok: Bool
    public let message: String
    public let undo: UndoAction?
    public let redirect: String?
    public let link: IngestLink?
    public let result: IngestApplyResult?
    public let ingest: IngestStatusRef?
    public let count: Int?

    enum CodingKeys: String, CodingKey { case ok, message, undo, redirect, link, result, ingest, count }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        undo = try c.decodeIfPresent(UndoAction.self, forKey: .undo)
        redirect = try c.decodeIfPresent(String.self, forKey: .redirect)
        link = try c.decodeIfPresent(IngestLink.self, forKey: .link)
        result = try c.decodeIfPresent(IngestApplyResult.self, forKey: .result)
        ingest = try c.decodeIfPresent(IngestStatusRef.self, forKey: .ingest)
        count = try? c.decodeIfPresent(Int.self, forKey: .count)
    }
}

/// Aktionen des Ingests.
public enum IngestAction {
    /// `id` (mit `force=1` neu) oder `stapel=1`.
    public static let draft = "/aktion/lesen/ingest/entwerfen"
    /// `id`, `item` mehrfach, `title`, `summary`, `slug`, `tags`.
    public static let apply = "/aktion/lesen/ingest/uebernehmen"
    /// `id`, mit `done=1` „ohne Wiki erledigen“.
    public static let discard = "/aktion/lesen/ingest/verwerfen"
    /// `id`: Einpflanzen (noch einmal) anstoßen.
    public static let plant = "/aktion/lesen/ingest/einpflanzen"
}

/// Stand des Ingests in der Leseansicht (`ingest` in `/api/lesen/doc`).
public struct ReaderIngest: Decodable, Equatable, Sendable {
    public var status: String?
    /// „Ingest entwerfen“ geht (Claude da, Text im Eingang oder auf dem Stapel).
    public let available: Bool

    public init(status: String?, available: Bool) {
        self.status = status
        self.available = available
    }

    enum CodingKeys: String, CodingKey { case status, available }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
    }
}

extension CockpitFormat {
    private static let shortMonths = ["Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez."]

    /// Tag und Uhrzeit wie `when` in src/lesen/ingest-page.js: „25. Okt., 03:10“.
    public static func dayTime(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.day, .month, .hour, .minute], from: date)
        let hour = c.hour ?? 0
        let minute = c.minute ?? 0
        return "\(c.day ?? 0). \(shortMonths[max(0, min(11, (c.month ?? 1) - 1))]), \(hour < 10 ? "0" : "")\(hour):\(minute < 10 ? "0" : "")\(minute)"
    }

    /// Satz am Knopf „Ins Wiki übernehmen“ (`applySummary` im Web).
    public static func ingestApplySummary(_ chosen: Int) -> String {
        chosen > 0 ? "Source-Page und \(chosen) \(chosen == 1 ? "Vorschlag" : "Vorschläge")" : "Nur die Source-Page"
    }
}
