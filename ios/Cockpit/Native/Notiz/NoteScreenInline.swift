import CockpitShared
import SwiftUI

// MARK: Links im Notiztext

/// Links im Text einer Notiz, die in der App bleiben: Wikilinks auf Notizen und Überschriften,
/// Bilder. Sie stehen als `x-cockpit-notiz://…` im `AttributedString`; `NoteScreen` fängt sie über
/// `OpenURLAction` ab. Alles andere (http, https, obsidian) geht wie gewohnt nach außen.
enum NoteScreenLink {
    static let scheme = "x-cockpit-notiz"

    /// Nur ASCII-Buchstaben, Ziffern und `-_.~` bleiben stehen, damit der Weg hin und zurück
    /// jeden Pfad übersteht (auch `&`, `#`, `+` und Umlaute).
    private static let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~")

    static func url(_ destination: NoteLinkDestination) -> URL? {
        let host: String
        let items: [(String, String)]
        switch destination {
        case .note(let path, let anchor):
            host = "notiz"
            items = [("pfad", path)] + (anchor.map { [("anker", $0)] } ?? [])
        case .heading(let id):
            host = "anker"
            items = [("id", id)]
        case .image(let src):
            host = "bild"
            items = [("src", src)]
        case .none:
            return nil
        }
        let query = items.map { "\($0.0)=\(encode($0.1))" }.joined(separator: "&")
        return URL(string: "\(scheme)://\(host)?\(query)")
    }

    /// Ziel eines abgefangenen Links; nil für fremde Adressen.
    static func destination(of url: URL) -> NoteLinkDestination? {
        guard url.scheme?.lowercased() == scheme, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var values: [String: String] = [:]
        for pair in (components.percentEncodedQuery ?? "").split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            values[parts[0]] = parts[1].removingPercentEncoding ?? parts[1]
        }
        switch components.host {
        case "notiz": return values["pfad"].map { .note(path: $0, anchor: values["anker"]) }
        case "anker": return values["id"].map { .heading($0) }
        case "bild": return values["src"].map { .image(src: $0) }
        default: return nil
        }
    }

    private static func encode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}

// MARK: Satz

/// Schrift und Hervorhebung eines Textlaufs; Überschriften, Tabellenköpfe und erledigte
/// Checkboxen setzen ihre Grundform, fett, kursiv, Code usw. kommen aus dem Baum dazu.
struct NoteScreenTextStyle {
    var textStyle: Font.TextStyle = .body
    var weight: Font.Weight = .regular
    var color: Color = Theme.text
    var bold = false
    var italic = false
    var strike = false
    var mark = false
    var code = false

    static let body = NoteScreenTextStyle()

    /// Schrift mit Dynamic Type (`Font.system(_:design:weight:)` wächst mit).
    var font: Font {
        let font = Font.system(textStyle, design: code ? .monospaced : .default, weight: bold ? .semibold : weight)
        return italic ? font.italic() : font
    }
}

/// Inline-Knoten (`NoteInline`) als `AttributedString` für `Text`: fett, kursiv, durchgestrichen,
/// `==markiert==` (Hintergrund), Code, #tags, Links, nackte Adressen, Bilder und Wikilinks
/// (fehlende als „(fehlt)“ grau mit gestrichelter Linie, Dateien grau, nur in Obsidian).
enum NoteScreenInline {
    static func attributed(_ content: [NoteInline], style: NoteScreenTextStyle = .body) -> AttributedString {
        var out = AttributedString()
        for node in content { append(node, style: style, to: &out) }
        return out
    }

    /// Text für VoiceOver und Kopieren.
    static func plain(_ content: [NoteInline]) -> String {
        NoteInline.plainText(content)
    }

    private static func append(_ node: NoteInline, style: NoteScreenTextStyle, to out: inout AttributedString) {
        switch node {
        case .text(let text):
            out.append(run(text, style))
        case .lineBreak:
            out.append(run("\n", style))
        case .code(let text):
            var code = style
            code.code = true
            out.append(run(text, code, background: Theme.bgSunk))
        case .styled(let kind, let children):
            var inner = style
            switch kind {
            case .bold: inner.bold = true
            case .italic: inner.italic = true
            case .strike: inner.strike = true
            case .mark: inner.mark = true
            }
            for child in children { append(child, style: inner, to: &out) }
        case .tag(let tag):
            out.append(run("#\(tag)", style, color: Theme.accent))
        case .link(let url, let text):
            out.append(run(text, style, color: Theme.accent, link: URL(string: url)))
        case .url(let url):
            out.append(run(url, style, color: Theme.accent, link: URL(string: url)))
        case .image(let image):
            out.append(run(imageLabel(image), style, color: Theme.accent, link: NoteScreenLink.url(.image(src: image.src))))
        case .wikilink(let link):
            append(link, style: style, to: &out)
        case .unknown:
            break
        }
    }

    private static func append(_ link: NoteWikilink, style: NoteScreenTextStyle, to out: inout AttributedString) {
        switch link.status {
        case .note, .image:
            let text = link.embed && link.status == .note ? "↪ \(link.text)" : link.text
            out.append(run(text, style, color: Theme.accent, link: NoteScreenLink.url(link.destination)))
        case .file:
            out.append(run(link.text, style, color: Theme.text3))
        case .missing:
            out.append(run(link.text, style, color: Theme.text3, underline: Text.LineStyle(pattern: .dash, color: Theme.lineStrong)))
            var hint = style
            hint.textStyle = .footnote
            hint.bold = false
            out.append(run(" (fehlt)", hint, color: Theme.text3))
        case .plain:
            out.append(run(link.text, style))
        }
    }

    /// „Bild: Skizze“ für ein Bild mitten im Text (Tipp öffnet es groß).
    static func imageLabel(_ image: NoteImage) -> String {
        let name = image.alt.isEmpty ? (image.path.split(separator: "/").last.map(String.init) ?? image.path) : image.alt
        return "Bild: \(name)"
    }

    private static func run(_ text: String, _ style: NoteScreenTextStyle, color: Color? = nil, link: URL? = nil, background: Color? = nil, underline: Text.LineStyle? = nil) -> AttributedString {
        var container = AttributeContainer()
        container[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = style.font
        container[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = color ?? style.color
        if style.strike {
            container[AttributeScopes.SwiftUIAttributes.StrikethroughStyleAttribute.self] = Text.LineStyle.single
        }
        if let background = background ?? (style.mark ? Theme.accentSoft : nil) {
            container[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] = background
        }
        if let underline {
            container[AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute.self] = underline
        }
        if let link {
            container[AttributeScopes.FoundationAttributes.LinkAttribute.self] = link
        }
        return AttributedString(text, attributes: container)
    }
}
