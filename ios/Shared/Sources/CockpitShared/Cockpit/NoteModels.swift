import Foundation

// Modelle für `GET /api/notiz?pfad=…` (src/web/note-json.js): Kopf, Frontmatter, Text als Baum
// (`parseMarkdown` in src/web/markdown-render.js), Verwandte, Vorschläge und Belege.

/// Eine Notiz aus dem Vault, wie die Notizseite sie zeigt.
public struct NoteModel: Decodable, Equatable, Sendable {
    public let path: String
    public let title: String
    public let folder: String
    public var tags: [String]
    /// Liegt im Inbox-Ordner (dann gibt es Vorschläge).
    public let inInbox: Bool
    /// `type` aus der Frontmatter, z. B. `synthesis`.
    public let type: String?
    /// `obsidian://open?…`, nil ohne Vault-Namen in den Einstellungen.
    public let obsidian: String?
    /// Sichtbare Frontmatter ohne Tags.
    public let frontmatter: [FrontmatterField]
    /// Kopf einer Synthese (`type: synthesis`), sonst nil.
    public let synthesis: SynthesisHead?
    /// Passende Markierungen aus dem Lesestapel (nur Synthesen), sonst nil.
    public let evidence: [EvidenceSuggestion]?
    public var blocks: [NoteBlock]
    public var related: NoteRelated
    /// Nur Inbox-Notizen mit Schreibrecht.
    public let suggestions: NoteSuggestions?
    /// Ordner für „Ablegen“.
    public let targets: [String]
    /// Archivordner für „Ins Archiv“; nil, wenn es keinen gibt, die Notiz schon dort liegt oder
    /// das Cockpit nicht schreiben darf.
    public let archive: String?
    public let can: NoteCapabilities

    public var obsidianURL: URL? { obsidian.flatMap(URL.init(string:)) }
    public var isSynthesis: Bool { type == "synthesis" }
    /// Frontmatter für die zugeklappte Zeile: die ersten drei, „+N“ für den Rest.
    public var frontmatterPreview: (shown: [FrontmatterField], more: Int) {
        (Array(frontmatter.prefix(3)), max(0, frontmatter.count - 3))
    }

    /// Alle Checkboxen, die man abhaken kann (mit `n` und `line`), in Textreihenfolge.
    public var checkboxes: [NoteCheckbox] {
        NoteBlock.checkboxes(in: blocks)
    }

    /// Ändert die Checkbox Nummer `n` (überall im Baum).
    public mutating func updateCheckbox(n: Int, _ change: (inout NoteCheckbox) -> Void) {
        blocks = NoteBlock.updatingCheckbox(n: n, in: blocks, change)
    }
}

public struct NoteCapabilities: Decodable, Equatable, Sendable {
    /// Ablegen, Tags, Anhängen, Abhaken, Verlinken.
    public let write: Bool
    /// Graph der Notiz verfügbar.
    public let graph: Bool

    public init(write: Bool, graph: Bool) {
        self.write = write
        self.graph = graph
    }
}

/// Feld der Frontmatter: `text` kompakt (Wikilinks als Alias oder Ziel), `content` mit Links.
public struct FrontmatterField: Decodable, Equatable, Identifiable, Sendable {
    public let key: String
    public let text: String
    public let content: [NoteInline]

    public var id: String { key }
}

/// Kopf einer Synthese: Zusammenfassung, Chips, Thesen (H2-Anker) und offene Punkte.
public struct SynthesisHead: Decodable, Equatable, Sendable {
    public struct Thesis: Decodable, Equatable, Identifiable, Sendable {
        /// Anker der Überschrift (`h-…`), Ziel für `NoteBlock.heading(id:)`.
        public let id: String
        public let text: String
    }

    public let summary: [NoteInline]?
    /// Querverbindung („Brücke“, „Vertiefung“ …).
    public let art: String?
    public let status: String?
    /// Vertrauen.
    public let confidence: String?
    public let theses: [Thesis]
    public let openPoints: [String]
    /// „Als Aufgaben nach Zunder“ anbieten (Schreibrecht, Zunder eingerichtet, offene Punkte da).
    public let toZunder: Bool

    enum CodingKeys: String, CodingKey { case summary, art, status, confidence, theses, openPoints, toZunder }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        summary = try c.decodeIfPresent([NoteInline].self, forKey: .summary)
        art = try c.decodeIfPresent(String.self, forKey: .art)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        confidence = try c.decodeIfPresent(String.self, forKey: .confidence)
        theses = try c.decodeIfPresent([Thesis].self, forKey: .theses) ?? []
        openPoints = try c.decodeIfPresent([String].self, forKey: .openPoints) ?? []
        toZunder = try c.decodeIfPresent(Bool.self, forKey: .toZunder) ?? false
    }
}

/// Markierung aus dem Lesestapel, die zur Synthese passt („Als Beleg anhängen“).
public struct EvidenceSuggestion: Decodable, Equatable, Identifiable, Sendable {
    /// Markierungs-ID (`markierung` für `/aktion/synthese/beleg`).
    public let id: String
    public let text: String
    /// Titel des Artikels.
    public let title: String
    public let score: Double?
    public let docId: String?
    /// `/lesen/doc?id=…#h-…` (`ReadingRoute(webPath:)`).
    public let href: String?

    public var route: ReadingRoute? { href.flatMap(ReadingRoute.init(webPath:)) }
}

/// Notiz in einer Liste (Backlinks).
public struct NoteRef: Decodable, Equatable, Identifiable, Hashable, Sendable {
    public let path: String
    public let title: String

    public var id: String { path }
}

/// „Ähnlich“: bis zu sechs Notizen; `score` fehlt bei Volltext-Ähnlichkeit.
public struct SimilarNote: Decodable, Equatable, Identifiable, Sendable {
    public let path: String
    public let title: String
    public let type: String?
    public let folder: String?
    public let score: Double?
    /// Schon verlinkt (Hinweis „verlinkt“).
    public var linked: Bool

    public var id: String { path }
}

public struct NoteRelated: Decodable, Equatable, Sendable {
    public let backlinks: [NoteRef]
    public var similar: [SimilarNote]
    /// `semantic`, `text` oder nil.
    public let source: String?
    /// Warum nur Volltext (z. B. „Ohne Embeddings …“).
    public let problem: String?

    enum CodingKeys: String, CodingKey { case backlinks, similar, source, problem }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        backlinks = try c.decodeIfPresent([NoteRef].self, forKey: .backlinks) ?? []
        similar = try c.decodeIfPresent([SimilarNote].self, forKey: .similar) ?? []
        source = try c.decodeIfPresent(String.self, forKey: .source)
        problem = try c.decodeIfPresent(String.self, forKey: .problem)
    }
}

/// Vorschläge für eine Inbox-Notiz aus `of` ähnlichen Notizen.
public struct NoteSuggestions: Decodable, Equatable, Sendable {
    public struct TagCount: Decodable, Equatable, Identifiable, Sendable {
        public let tag: String
        public let count: Int
        public var id: String { tag }
    }

    public struct FolderCount: Decodable, Equatable, Identifiable, Sendable {
        public let folder: String
        public let count: Int
        public var id: String { folder }
    }

    public struct Unlinked: Decodable, Equatable, Identifiable, Sendable {
        public let path: String
        public let title: String
        public let score: Double?
        public var id: String { path }
    }

    /// Anzahl der ähnlichen Notizen, aus denen die Vorschläge stammen.
    public let of: Int
    public let source: String?
    public let problem: String?
    public let tags: [TagCount]
    public let folders: [FolderCount]
    public var unlinked: [Unlinked]

    /// Nichts vorzuschlagen.
    public var isEmpty: Bool { tags.isEmpty && folders.isEmpty && unlinked.isEmpty }

    /// Leertext wie auf der Seite.
    public var emptyText: String {
        if of > 0 { return "Aus den ähnlichen Notizen ergibt sich kein Vorschlag." }
        return "Keine Vorschläge: keine ähnlichen Notizen gefunden\(problem.map { " (\($0))" } ?? "")."
    }
}

// MARK: Text als Baum

/// Hervorhebung um Inline-Kinder.
public enum NoteTextStyle: String, Equatable, Sendable {
    case bold, italic, strike, mark
}

/// Inline-Knoten im Text einer Notiz.
public indirect enum NoteInline: Decodable, Equatable, Sendable {
    case text(String)
    /// Zeilenumbruch innerhalb eines Absatzes.
    case lineBreak
    case code(String)
    /// Fett, kursiv, durchgestrichen, `==markiert==`.
    case styled(NoteTextStyle, [NoteInline])
    /// `#tag` (ohne `#`).
    case tag(String)
    /// Markdown-Link, nur http/https.
    case link(url: String, text: String)
    /// Nackte Adresse.
    case url(String)
    case image(NoteImage)
    case wikilink(NoteWikilink)
    /// Unbekannter Typ eines neueren Servers: wird nicht gezeigt.
    case unknown(String)

    enum CodingKeys: String, CodingKey { case type, text, children, tag, url }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "text": self = .text(try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        case "break": self = .lineBreak
        case "code": self = .code(try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        case "bold", "italic", "strike", "mark":
            self = .styled(NoteTextStyle(rawValue: type) ?? .bold, try c.decodeIfPresent([NoteInline].self, forKey: .children) ?? [])
        case "tag": self = .tag(try c.decodeIfPresent(String.self, forKey: .tag) ?? "")
        case "link":
            let url = try c.decode(String.self, forKey: .url)
            self = .link(url: url, text: try c.decodeIfPresent(String.self, forKey: .text) ?? url)
        case "url": self = .url(try c.decode(String.self, forKey: .url))
        case "image": self = .image(try NoteImage(from: decoder))
        case "wikilink": self = .wikilink(try NoteWikilink(from: decoder))
        default: self = .unknown(type)
        }
    }

    /// Text ohne Auszeichnung (Vorlesen, Barrierefreiheit, Tests).
    public var plainText: String {
        switch self {
        case .text(let text), .code(let text): text
        case .lineBreak: "\n"
        case .styled(_, let children): NoteInline.plainText(children)
        case .tag(let tag): "#\(tag)"
        case .link(_, let text): text
        case .url(let url): url
        case .image(let image): image.alt
        case .wikilink(let link): link.text
        case .unknown: ""
        }
    }

    public static func plainText(_ content: [NoteInline]) -> String {
        content.map(\.plainText).joined()
    }
}

/// Eingebettetes Bild (`![[bild.png]]`, `![](bild.png)`); `src` ist `/notiz/bild?pfad=…` und
/// braucht den Geräte-Token (`CockpitAPI.resource`).
public struct NoteImage: Decodable, Equatable, Sendable {
    public let path: String
    public let src: String
    public let alt: String
    public let width: Int?
    public let height: Int?

    enum CodingKeys: String, CodingKey { case path, src, alt, width, height }

    public init(path: String, src: String, alt: String, width: Int? = nil, height: Int? = nil) {
        self.path = path
        self.src = src
        self.alt = alt
        self.width = width
        self.height = height
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decodeIfPresent(String.self, forKey: .path) ?? ""
        src = try c.decode(String.self, forKey: .src)
        alt = try c.decodeIfPresent(String.self, forKey: .alt) ?? ""
        width = try? c.decodeIfPresent(Int.self, forKey: .width)
        height = try? c.decodeIfPresent(Int.self, forKey: .height)
    }
}

/// Art eines Wikilinks: Notiz, Bild, andere Datei, fehlendes Ziel oder nur Text.
public enum WikilinkStatus: String, Decodable, Equatable, Sendable {
    case note, image, file, missing, plain

    public init(from decoder: Decoder) throws {
        self = WikilinkStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .plain
    }
}

/// Wohin ein Tipp auf einen Link führt.
public enum NoteLinkDestination: Equatable, Sendable {
    /// Andere Notiz, optional mit Überschrift (`h-…`).
    case note(path: String, anchor: String?)
    /// Überschrift in derselben Notiz.
    case heading(String)
    /// Bild (`/notiz/bild?pfad=…`).
    case image(src: String)
    /// Kein Ziel (fehlt, Datei ohne Vorschau, nur Text).
    case none
}

/// `[[Ziel#Überschrift|Alias]]` oder ein Markdown-Link auf eine Notiz.
public struct NoteWikilink: Decodable, Equatable, Sendable {
    public let status: WikilinkStatus
    /// Was angezeigt wird.
    public let text: String
    public let target: String
    public let heading: String?
    public let alias: String?
    /// `![[…]]`
    public let embed: Bool
    /// Pfad im Vault, nil wenn das Ziel fehlt.
    public let path: String?
    /// Verweist auf dieselbe Notiz (`[[#Überschrift]]`).
    public let isSelf: Bool
    /// Id der Überschrift (`h-…`), zu der gesprungen wird.
    public let anchor: String?
    /// Nur bei `status == .image`.
    public let src: String?

    enum CodingKeys: String, CodingKey {
        case status, text, target, heading, alias, embed, path, anchor, src
        case isSelf = "self"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(WikilinkStatus.self, forKey: .status) ?? .plain
        target = try c.decodeIfPresent(String.self, forKey: .target) ?? ""
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? target
        heading = try c.decodeIfPresent(String.self, forKey: .heading)
        alias = try c.decodeIfPresent(String.self, forKey: .alias)
        embed = try c.decodeIfPresent(Bool.self, forKey: .embed) ?? false
        path = try c.decodeIfPresent(String.self, forKey: .path)
        isSelf = try c.decodeIfPresent(Bool.self, forKey: .isSelf) ?? false
        anchor = try c.decodeIfPresent(String.self, forKey: .anchor)
        src = try c.decodeIfPresent(String.self, forKey: .src)
    }

    /// Ziel fehlt im Vault (Web: „fehlt“).
    public var isMissing: Bool { status == .missing }

    public var destination: NoteLinkDestination {
        switch status {
        case .note:
            if isSelf { return anchor.map { .heading($0) } ?? .none }
            return path.map { .note(path: $0, anchor: anchor) } ?? .none
        case .image:
            return src.map { .image(src: $0) } ?? .none
        case .file, .missing, .plain:
            return .none
        }
    }
}

/// Checkbox in einer Liste. `n` und `line` sind die Felder für `/aktion/notiz/checkbox`; in
/// Callouts sind beide nil (nur Anzeige).
public struct NoteCheckbox: Decodable, Equatable, Sendable {
    public var done: Bool
    public let n: Int?
    /// Getrimmte Zeile im Quelltext; nach dem Abhaken die neue Zeile laut Server.
    public var line: String?

    public init(done: Bool, n: Int?, line: String?) {
        self.done = done
        self.n = n
        self.line = line
    }

    /// Lässt sich abhaken (Schreibrecht vorausgesetzt).
    public var isToggleable: Bool { n != nil && line != nil }
}

public struct NoteListItem: Decodable, Equatable, Sendable {
    /// Einrückung 0–4.
    public let depth: Int
    public var task: NoteCheckbox?
    public let content: [NoteInline]
}

public struct NoteList: Decodable, Equatable, Sendable {
    public let ordered: Bool
    public var items: [NoteListItem]
}

/// Farbfamilie eines Callouts.
public enum CalloutFamily: String, Decodable, Equatable, Sendable {
    case info, ok, warn, bad, plain

    public init(from decoder: Decoder) throws {
        self = CalloutFamily(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .plain
    }
}

/// Obsidian-Callout (`> [!tip] Titel`), aufklappbar mit `+`/`-`.
public struct NoteCallout: Decodable, Equatable, Sendable {
    /// Art wie geschrieben (`tip`, `warning`, `faq` …).
    public let kind: String
    public let family: CalloutFamily
    /// Deutscher Name der Art („Tipp“, „Warnung“).
    public let label: String
    public let title: [NoteInline]
    public let foldable: Bool
    /// Anfangs offen.
    public let open: Bool
    public var children: [NoteBlock]
}

/// Ausrichtung einer Tabellenspalte.
public enum NoteColumnAlignment: String, Decodable, Equatable, Sendable {
    case leading, center, trailing

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = raw == "center" ? .center : raw == "right" ? .trailing : .leading
    }
}

/// Tabelle; jede Zeile hat so viele Zellen wie der Kopf.
public struct NoteTable: Decodable, Equatable, Sendable {
    /// nil = links.
    public let align: [NoteColumnAlignment?]
    public let head: [[NoteInline]]
    public let rows: [[[NoteInline]]]

    public func alignment(of column: Int) -> NoteColumnAlignment {
        column < align.count ? (align[column] ?? .leading) : .leading
    }
}

/// Block im Text einer Notiz.
public indirect enum NoteBlock: Decodable, Equatable, Sendable {
    /// Überschrift; `level` wie im Markdown (1–6), `id` ist der Anker (`h-…`).
    case heading(level: Int, id: String, content: [NoteInline])
    /// Absatz; Zeilen getrennt durch `NoteInline.lineBreak`.
    case paragraph([NoteInline])
    case list(NoteList)
    case quote([NoteInline])
    case callout(NoteCallout)
    case table(NoteTable)
    case code(lang: String?, text: String)
    case rule
    /// Absatz, der nur aus einem Bild besteht.
    case image(NoteImage)
    /// Absatz, der nur aus einer Einbettung besteht (`![[Notiz]]`, Datei, fehlend). Eine
    /// eingebettete Notiz bringt ihren Inhalt als `children` mit (VCP-63), sonst nil: fehlt,
    /// vertraulich, im Kreis oder über den Grenzen des Servers (Tiefe 2, 20 je Seite, 50.000
    /// Zeichen). Checkboxen darin sind nur Anzeige.
    case embed(NoteWikilink, children: [NoteBlock]?)
    /// Unbekannter Typ eines neueren Servers: wird nicht gezeigt.
    case unknown(String)

    enum CodingKeys: String, CodingKey { case type, level, id, content, lang, text, link, children }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "heading":
            self = .heading(level: try c.decodeIfPresent(Int.self, forKey: .level) ?? 1, id: try c.decodeIfPresent(String.self, forKey: .id) ?? "", content: try c.decodeIfPresent([NoteInline].self, forKey: .content) ?? [])
        case "paragraph": self = .paragraph(try c.decodeIfPresent([NoteInline].self, forKey: .content) ?? [])
        case "list": self = .list(try NoteList(from: decoder))
        case "quote": self = .quote(try c.decodeIfPresent([NoteInline].self, forKey: .content) ?? [])
        case "callout": self = .callout(try NoteCallout(from: decoder))
        case "table": self = .table(try NoteTable(from: decoder))
        case "code": self = .code(lang: try c.decodeIfPresent(String.self, forKey: .lang), text: try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        case "rule": self = .rule
        case "image": self = .image(try NoteImage(from: decoder))
        case "embed": self = .embed(try c.decode(NoteWikilink.self, forKey: .link), children: try c.decodeIfPresent([NoteBlock].self, forKey: .children))
        default: self = .unknown(type)
        }
    }

    /// Anker einer Überschrift, sonst nil (Sprungziel für Thesen und `[[#…]]`).
    public var anchor: String? {
        if case .heading(_, let id, _) = self { id } else { nil }
    }

    static func checkboxes(in blocks: [NoteBlock]) -> [NoteCheckbox] {
        blocks.flatMap { block -> [NoteCheckbox] in
            switch block {
            case .list(let list): list.items.compactMap(\.task).filter(\.isToggleable)
            case .callout(let callout): checkboxes(in: callout.children)
            default: []
            }
        }
    }

    static func updatingCheckbox(n: Int, in blocks: [NoteBlock], _ change: (inout NoteCheckbox) -> Void) -> [NoteBlock] {
        blocks.map { block in
            switch block {
            case .list(var list):
                for i in list.items.indices where list.items[i].task?.n == n {
                    if var task = list.items[i].task {
                        change(&task)
                        list.items[i].task = task
                    }
                }
                return .list(list)
            case .callout(var callout):
                callout.children = updatingCheckbox(n: n, in: callout.children, change)
                return .callout(callout)
            default:
                return block
            }
        }
    }
}

// MARK: Antworten

/// Antwort der Notiz-Aktionen (`/aktion/notiz/…`, `/aktion/verlinken`, `/aktion/synthese/…`).
/// Je nach Aktion sind andere Felder gesetzt.
public struct NoteActionResponse: UndoableReply, Equatable, Sendable {
    public let ok: Bool
    public let message: String
    public let undo: UndoAction?
    /// Ablegen: `/notiz?pfad=<neu>`, nur wenn `back` mit `/notiz` beginnt.
    public let redirect: String?
    /// Pfad der Notiz danach (Ablegen: der neue).
    public let path: String?
    /// Ablegen: alter Pfad und Zielordner.
    public let from: String?
    public let folder: String?
    /// Checkbox: Nummer, neue Zeile, neuer Stand.
    public let n: Int?
    public let line: String?
    public let done: Bool?
    /// Tags: der neue Stand.
    public let tags: [String]?
    /// Verlinken: Ziel, sein Titel, ob die Notiz sich geändert hat.
    public let target: String?
    public let title: String?
    public let changed: Bool?
    /// Aufgaben nach Zunder: neu angelegt, schon dort.
    public let created: Int?
    public let existing: Int?

    enum CodingKeys: String, CodingKey { case ok, message, undo, redirect, path, from, folder, n, line, done, tags, target, title, changed, created, existing }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
        undo = try c.decodeIfPresent(UndoAction.self, forKey: .undo)
        redirect = try c.decodeIfPresent(String.self, forKey: .redirect)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        from = try c.decodeIfPresent(String.self, forKey: .from)
        folder = try c.decodeIfPresent(String.self, forKey: .folder)
        n = try? c.decodeIfPresent(Int.self, forKey: .n)
        line = try c.decodeIfPresent(String.self, forKey: .line)
        done = try c.decodeIfPresent(Bool.self, forKey: .done)
        tags = try c.decodeIfPresent([String].self, forKey: .tags)
        target = try c.decodeIfPresent(String.self, forKey: .target)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        changed = try c.decodeIfPresent(Bool.self, forKey: .changed)
        created = try c.decodeIfPresent(Int.self, forKey: .created)
        existing = try c.decodeIfPresent(Int.self, forKey: .existing)
    }
}

/// Pfade der Notiz-Aktionen.
public enum NoteAction {
    public static let checkbox = "/aktion/notiz/checkbox"
    public static let tags = "/aktion/notiz/tags"
    public static let append = "/aktion/notiz/anhaengen"
    public static let file = "/aktion/notiz/ablegen"
    public static let link = "/aktion/verlinken"
    public static let tasks = "/aktion/synthese/aufgaben"
    public static let evidence = "/aktion/synthese/beleg"
    public static let evidenceRemove = "/aktion/synthese/beleg/entfernen"
}
