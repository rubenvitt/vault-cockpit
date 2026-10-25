import CockpitShared
import SwiftUI
import UIKit

// MARK: Anzeige und Lesetext

/// Ordnet den angezeigten Text (Kopf, Blöcke mit Listenmarken und Zeilenenden, alles UTF-16 wie
/// `NSRange`) dem Lesetext zu, in dem Anker und Markierungen zählen. Je Block steht fest, wo sein
/// Absatz und wo seine Läufe in der Anzeige beginnen; innerhalb der Läufe rechnet `ReaderBlock`.
struct ReaderDisplayMap: Equatable {
    let blocks: [ReaderBlock]
    /// Anfang des Absatzes eines Blocks in der Anzeige (mit Listenmarke, Bild, Trennlinie).
    let paragraphStarts: [Int]
    /// Anfang der Läufe eines Blocks in der Anzeige.
    let textStarts: [Int]
    /// Länge der Läufe (`displayText`) eines Blocks.
    let lengths: [Int]
    /// Erste Stelle nach dem Kopf (Titel, Quelle, „Original“).
    let textStart: Int
    let length: Int

    static let empty = ReaderDisplayMap(blocks: [], paragraphStarts: [], textStarts: [], lengths: [], textStart: 0, length: 0)

    /// Block, dessen Absatz die Stelle `display` enthält; nil im Kopf.
    func blockIndex(atDisplay display: Int) -> Int? {
        guard !blocks.isEmpty, display >= textStart else { return nil }
        var low = 0
        var high = paragraphStarts.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if paragraphStarts[mid] <= display { low = mid } else { high = mid - 1 }
        }
        return low
    }

    /// Stelle im Lesetext zu einer Stelle der Anzeige. Anfang einer Auswahl (`isEnd` false) in
    /// Marke oder Zeilenende nimmt den Anfang des Blocks bzw. des nächsten, ein Ende das Ende des
    /// Blocks bzw. des vorigen. nil im Kopf.
    func documentOffset(atDisplay display: Int, isEnd: Bool) -> Int? {
        guard let index = blockIndex(atDisplay: display) else { return nil }
        let local = display - textStarts[index]
        if local <= 0 {
            if isEnd, index > 0 { return end(of: index - 1) }
            return blocks[index].documentOffset(atDisplay: 0, preferNext: true)
        }
        if local >= lengths[index] {
            if !isEnd, index + 1 < blocks.count { return blocks[index + 1].documentOffset(atDisplay: 0, preferNext: true) }
            return end(of: index)
        }
        return blocks[index].documentOffset(atDisplay: local, preferNext: !isEnd)
    }

    private func end(of index: Int) -> Int {
        blocks[index].documentOffset(atDisplay: lengths[index], preferNext: false)
    }

    /// Bereich im Lesetext zu einer Auswahl der Anzeige; nil, wenn sie nur im Kopf liegt oder leer ist.
    func documentRange(forDisplay range: NSRange) -> Range<Int>? {
        let upperDisplay = range.location + range.length
        guard range.length > 0, upperDisplay > textStart else { return nil }
        guard let lower = documentOffset(atDisplay: max(range.location, textStart), isEnd: false),
              let upper = documentOffset(atDisplay: upperDisplay, isEnd: true),
              lower < upper
        else { return nil }
        return lower..<upper
    }

    /// Stücke der Anzeige, die ein Bereich des Lesetexts abdeckt (je Block eins), zum Malen.
    func displaySegments(for range: Range<Int>) -> [NSRange] {
        guard !range.isEmpty, !blocks.isEmpty else { return [] }
        // Erster Block, der hinter dem Anfang endet (die Blöcke sind nach `start` geordnet).
        var low = 0
        var high = blocks.count
        while low < high {
            let mid = (low + high) / 2
            if blocks[mid].end <= range.lowerBound { low = mid + 1 } else { high = mid }
        }
        var out: [NSRange] = []
        var index = low
        while index < blocks.count, blocks[index].start < range.upperBound {
            if let local = blocks[index].displayRange(for: range) {
                out.append(NSRange(location: textStarts[index] + local.lowerBound, length: local.count))
            }
            index += 1
        }
        return out
    }

    /// Stelle der Anzeige zu einer Stelle im Lesetext (zum Hinscrollen); zwischen Blöcken der
    /// Anfang des nächsten, hinter dem letzten das Ende.
    func displayLocation(forDocument offset: Int) -> Int {
        guard let index = ReaderText.blockIndex(containing: offset, in: blocks) else { return length }
        let block = blocks[index]
        let local = block.displayOffset(atDocument: max(offset, block.start), preferNext: true) ?? 0
        return textStarts[index] + local
    }
}

// MARK: Satz

/// Darstellung des Lesetexts: Stufe 1…5 (Schriftgröße wie im Web), mit oder ohne Serifen.
enum ReaderAppearance {
    static let levelKey = "lesen-darstellung-groesse"
    static let sansKey = "lesen-darstellung-ohne-serifen"
    static let levels = 1...5
    static let defaultLevel = 3
    /// `--read-size` je Stufe (auf dem Telefon 18 statt 19 px in der Mitte), wächst mit Dynamic Type.
    static let sizes: [CGFloat] = [15, 17, 18, 21, 24]

    static func clamp(_ level: Int) -> Int {
        min(levels.upperBound, max(levels.lowerBound, level))
    }
}

/// Farben des Lesetexts für TextKit, dieselben Werte wie `Theme` (hell und dunkel).
enum ReaderPalette {
    static let text = UIColor(light: 0x1D1B18, dark: 0xEFEBE4)
    static let text2 = UIColor(light: 0x5F5A52, dark: 0xAAA398)
    static let text3 = UIColor(light: 0x8B857B, dark: 0x7C766C)
    static let sunk = UIColor(light: 0xEFEBE4, dark: 0x0E0D0C)
    static let warn = UIColor(light: 0xB45309, dark: 0xFBBF24)
    static let accent = UIColor.cockpitAccent
    /// `mark.hl`: #facc15 zu 38 %, wartende zu 22 %, angetippte kräftiger.
    static let mark = UIColor(red: 0.980, green: 0.800, blue: 0.082, alpha: 0.38)
    static let markPending = UIColor(red: 0.980, green: 0.800, blue: 0.082, alpha: 0.22)
    static let markFocus = UIColor(red: 0.980, green: 0.800, blue: 0.082, alpha: 0.68)
}

/// Was die Textansicht zeigt; ändert es sich, wird der Text neu gesetzt (Markierungen nicht:
/// die malt sie über den gesetzten Text).
struct ReaderDocument: Equatable {
    let docID: String
    let title: String
    /// „Quelle · Autor · 8 min“
    let meta: String
    let original: URL?
    let blocks: [ReaderBlock]
    let level: Int
    let sans: Bool
    let typeSize: DynamicTypeSize
}

/// Gesetzter Text: Anzeige, Zuordnung zum Lesetext und die Bilder darin.
struct ReaderBuild {
    let text: NSAttributedString
    let map: ReaderDisplayMap
    /// Bilder mit ihrer Stelle in der Anzeige.
    let images: [(attachment: ReaderImageAttachment, location: Int)]
}

/// Setzt die Blöcke als `NSAttributedString`: Schrift, Abstände und Einzüge wie `.lesen-text`
/// in cockpit.css. Listenmarken, Bilder und Trennlinien stehen nur in der Anzeige.
struct ReaderTypesetter {
    let level: Int
    let sans: Bool
    let typeSize: DynamicTypeSize

    /// Grundgröße der Stufe, mit Dynamic Type skaliert.
    var size: CGFloat {
        let base = ReaderAppearance.sizes[ReaderAppearance.clamp(level) - 1]
        let traits = UITraitCollection(preferredContentSizeCategory: Self.category(typeSize))
        return UIFontMetrics(forTextStyle: .body).scaledValue(for: base, compatibleWith: traits)
    }

    func build(_ document: ReaderDocument) -> ReaderBuild {
        let size = self.size
        let out = NSMutableAttributedString()

        // Kopf: Titel, dann „Quelle · Autor · 8 min · Original“. Gehört nicht zum Lesetext.
        let title = NSMutableParagraphStyle()
        title.paragraphSpacing = size * 0.45
        title.lineHeightMultiple = 1.1
        out.append(NSAttributedString(string: document.title + "\n", attributes: [
            .font: font(size * 1.4, bold: true),
            .foregroundColor: ReaderPalette.text,
            .paragraphStyle: title,
        ]))
        let metaStyle = NSMutableParagraphStyle()
        metaStyle.paragraphSpacing = size * 1.3
        let metaFont = UIFont.systemFont(ofSize: size * 0.74)
        let meta = NSMutableAttributedString(string: document.meta, attributes: [.font: metaFont, .foregroundColor: ReaderPalette.text2, .paragraphStyle: metaStyle])
        if let original = document.original {
            if !document.meta.isEmpty { meta.append(NSAttributedString(string: " · ", attributes: [.font: metaFont, .foregroundColor: ReaderPalette.text2, .paragraphStyle: metaStyle])) }
            meta.append(NSAttributedString(string: "Original", attributes: [.font: metaFont, .link: original, .paragraphStyle: metaStyle]))
        }
        meta.append(NSAttributedString(string: "\n", attributes: [.font: metaFont, .paragraphStyle: metaStyle]))
        out.append(meta)

        let textStart = out.length
        var paragraphStarts: [Int] = []
        var textStarts: [Int] = []
        var lengths: [Int] = []
        var images: [(ReaderImageAttachment, Int)] = []
        paragraphStarts.reserveCapacity(document.blocks.count)

        for block in document.blocks {
            paragraphStarts.append(out.length)
            let style = paragraphStyle(for: block, size: size)
            var base: [NSAttributedString.Key: Any] = [
                .font: blockFont(block, size: size),
                .foregroundColor: block.kind == .quote || block.quoted || block.kind == .caption ? ReaderPalette.text2 : ReaderPalette.text,
                .paragraphStyle: style,
            ]
            if block.kind == .code { base[.backgroundColor] = ReaderPalette.sunk }

            switch block.kind {
            case .image:
                let attachment = ReaderImageAttachment(source: block.src.flatMap { URL(string: $0) }, alt: block.alt)
                images.append((attachment, out.length))
                let piece = NSMutableAttributedString(attachment: attachment)
                piece.addAttributes([.paragraphStyle: style], range: NSRange(location: 0, length: piece.length))
                out.append(piece)
            case .rule:
                out.append(NSAttributedString(string: "· · ·", attributes: base.merging([.foregroundColor: ReaderPalette.text3]) { _, new in new }))
            case .listItem:
                let marker = block.ordered == true ? "\(block.number ?? 1)." : ((block.depth ?? 1) > 1 ? "◦" : "•")
                out.append(NSAttributedString(string: marker + "\t", attributes: base.merging([.foregroundColor: ReaderPalette.text2]) { _, new in new }))
            default:
                break
            }

            textStarts.append(out.length)
            for run in block.runs {
                // `<br>` und Zeilen im Code bleiben im selben Absatz (gleiche Länge in UTF-16).
                let text = run.text.replacingOccurrences(of: "\n", with: "\u{2028}")
                out.append(NSAttributedString(string: text, attributes: attributes(of: run, in: block, base: base, size: size)))
            }
            lengths.append(out.length - textStarts[textStarts.count - 1])
            out.append(NSAttributedString(string: "\n", attributes: base))
        }

        let map = ReaderDisplayMap(blocks: document.blocks, paragraphStarts: paragraphStarts, textStarts: textStarts, lengths: lengths, textStart: textStart, length: out.length)
        return ReaderBuild(text: out, map: map, images: images.map { (attachment: $0.0, location: $0.1) })
    }

    // MARK: Schriften

    /// Lesetext: Iowan Old Style wie `--font-read` (sonst New York), ohne Serifen die Systemschrift.
    func font(_ size: CGFloat, bold: Bool = false, italic: Bool = false) -> UIFont {
        var font: UIFont
        if sans {
            font = .systemFont(ofSize: size)
        } else if let iowan = UIFont(name: "IowanOldStyle-Roman", size: size) {
            font = iowan
        } else if let serif = UIFont.systemFont(ofSize: size).fontDescriptor.withDesign(.serif) {
            font = UIFont(descriptor: serif, size: size)
        } else {
            font = .systemFont(ofSize: size)
        }
        var traits: UIFontDescriptor.SymbolicTraits = []
        if bold { traits.insert(.traitBold) }
        if italic { traits.insert(.traitItalic) }
        if !traits.isEmpty, let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
            font = UIFont(descriptor: descriptor, size: size)
        }
        return font
    }

    private func blockFont(_ block: ReaderBlock, size: CGFloat) -> UIFont {
        switch block.kind {
        case .heading: font(size * (block.level == 1 ? 1.3 : 1.2), bold: true)
        case .code: .monospacedSystemFont(ofSize: size * 0.8, weight: .regular)
        case .caption: font(size * 0.85)
        case .row: font(size * 0.85, bold: block.header)
        default: font(size)
        }
    }

    private func attributes(of run: ReaderRun, in block: ReaderBlock, base: [NSAttributedString.Key: Any], size: CGFloat) -> [NSAttributedString.Key: Any] {
        var attributes = base
        let blockSize = (base[.font] as? UIFont)?.pointSize ?? size
        if run.code || block.kind == .code {
            attributes[.font] = UIFont.monospacedSystemFont(ofSize: block.kind == .code ? blockSize : blockSize * 0.85, weight: run.bold ? .semibold : .regular)
            attributes[.backgroundColor] = ReaderPalette.sunk
        } else if run.bold || run.italic {
            let bold = run.bold || block.kind == .heading || (block.kind == .row && block.header)
            attributes[.font] = font(blockSize, bold: bold, italic: run.italic)
        }
        if run.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        if let link = run.link, let url = URL(string: link) { attributes[.link] = url }
        if run.extra, run.text == "\t", block.kind == .row { attributes[.foregroundColor] = ReaderPalette.text3 }
        return attributes
    }

    // MARK: Absätze

    private func paragraphStyle(for block: ReaderBlock, size: CGFloat) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        // line-height 1.65 bei Fließtext, Absatzabstand 1em.
        style.lineHeightMultiple = 1.32
        style.paragraphSpacing = size * 0.9
        var indent: CGFloat = 0
        switch block.kind {
        case .heading:
            style.lineHeightMultiple = 1.1
            style.paragraphSpacingBefore = size * 0.8
            style.paragraphSpacing = size * 0.4
        case .listItem:
            let step = size * 1.4
            let depth = CGFloat(max(1, block.depth ?? 1))
            style.firstLineHeadIndent = (depth - 1) * step
            style.headIndent = depth * step
            style.tabStops = [NSTextTab(textAlignment: .left, location: depth * step)]
            style.paragraphSpacing = size * 0.35
        case .quote:
            indent = size
        case .code:
            style.lineHeightMultiple = 1.15
            style.firstLineHeadIndent = 8
            style.headIndent = 8
            style.tailIndent = -8
        case .caption:
            style.lineHeightMultiple = 1.15
            style.alignment = .center
        case .row:
            style.lineHeightMultiple = 1.15
            style.paragraphSpacing = size * 0.25
            style.defaultTabInterval = size * 7
            style.tabStops = (1...6).map { NSTextTab(textAlignment: .left, location: CGFloat($0) * size * 7) }
        case .image, .rule:
            style.alignment = .center
            style.lineHeightMultiple = 1
            style.paragraphSpacingBefore = size * 0.3
        case .paragraph:
            break
        }
        if block.quoted { indent += size }
        if indent > 0 {
            style.firstLineHeadIndent += indent
            style.headIndent += indent
        }
        return style
    }

    /// Dynamic Type der Umgebung als UIKit-Größe.
    static func category(_ size: DynamicTypeSize) -> UIContentSizeCategory {
        switch size {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}

// MARK: Bilder

/// Bild im Lesetext: so breit wie das Original, höchstens die Zeile; bis es geladen ist, ein
/// Platzhalter im Seitenverhältnis 16:9, fehlgeschlagen nichts.
final class ReaderImageAttachment: NSTextAttachment {
    let source: URL?
    let alt: String?
    var loaded: UIImage?
    var failed = false

    init(source: URL?, alt: String?) {
        self.source = source
        self.alt = alt
        super.init(data: nil, ofType: nil)
    }

    required init?(coder: NSCoder) {
        source = nil
        alt = nil
        super.init(coder: coder)
    }

    override func attachmentBounds(for textContainer: NSTextContainer?, proposedLineFragment lineFrag: CGRect, glyphPosition position: CGPoint, characterIndex charIndex: Int) -> CGRect {
        let width = max(0, lineFrag.width - 4)
        guard let loaded, loaded.size.width > 0 else {
            return failed ? .zero : CGRect(x: 0, y: 0, width: width, height: (width * 9 / 16).rounded())
        }
        let fit = min(width, loaded.size.width)
        return CGRect(x: 0, y: 0, width: fit, height: (fit * loaded.size.height / loaded.size.width).rounded())
    }

    override func image(forBounds imageBounds: CGRect, textContainer: NSTextContainer?, characterIndex charIndex: Int) -> UIImage? {
        if let loaded { return loaded }
        return failed ? nil : Self.placeholder
    }

    /// Fläche in `--bg-sunk`, auf die Größe des Platzhalters gezogen.
    private static let placeholder: UIImage = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { context in
        ReaderPalette.sunk.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
    }
}

/// Lädt Bilder des Lesetexts: direkt vom Original, vom eigenen Server mit dem Geräte-Token.
@MainActor
final class ReaderImageLoader {
    private let cache = NSCache<NSURL, UIImage>()
    private let authorization: String?
    private let host: String?

    init(api: CockpitAPI) {
        authorization = api.getRequest("api/lesen/doc").value(forHTTPHeaderField: "Authorization")
        host = api.baseURL.host()
    }

    func image(_ url: URL) async -> UIImage? {
        if let hit = cache.object(forKey: url as NSURL) { return hit }
        var request = URLRequest(url: url)
        if let authorization, let host, url.host() == host {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        guard let (data, response) = try? await URLSession.shared.data(for: request) else { return nil }
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { return nil }
        guard let decoded = UIImage(data: data) else { return nil }
        let image = await decoded.byPreparingForDisplay() ?? decoded
        cache.setObject(image, forKey: url as NSURL)
        return image
    }
}

// MARK: Textansicht

/// Kommandos der Auswahl (Leiste unten und Menü an der Auswahl).
enum ReaderCommand: Equatable {
    case mark, note, connect, inbox, delete
}

/// Gewünschter Sprung im Text (Lesestelle, Markierung, „Weiterlesen“); jede Anfrage einmal.
struct ReaderScrollRequest: Equatable {
    let id = UUID()
    let offset: Int
    var animated = false
}

/// Was die Textansicht meldet.
struct ReaderTextActions {
    /// Auswahl im Lesetext (UTF-16), nil = keine.
    var select: @MainActor (Range<Int>?) -> Void
    /// Markierung angetippt (ohne Auswahl).
    var tapMark: @MainActor (String) -> Void
    /// Tipp auf Text ohne Markierung.
    var tapText: @MainActor () -> Void
    /// Vom Finger gescrollt: Anteil bis zum unteren Rand und erster sichtbarer Block.
    var scrolled: @MainActor (Double, Int?) -> Void
    /// Link angetippt (auch „Original“).
    var open: @MainActor (URL) -> Void
    /// Kommando aus dem Menü an der Auswahl.
    var command: @MainActor (ReaderCommand, Range<Int>) -> Void
}

/// `UITextView` mit TextKit 1 (feste Geometrie für Fortschritt, Sprünge und Antippen), das nach
/// jedem Layout Bescheid gibt.
final class ReaderUITextView: UITextView {
    var onLayout: (@MainActor () -> Void)?
    /// Der Layout-Manager hält seinen Text nicht fest; ohne diese Referenz wäre er gleich weg.
    var storage: NSTextStorage?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

/// Der ganze Lesetext in einer Textansicht: auswählbar, nicht bearbeitbar. Auswahl über Absätze
/// hinweg, Markierungen als Hintergrund (mit Notiz gepunktet unterstrichen, wartende gestrichelt),
/// Bilder als Anhang, Fortschritt aus der Scrollposition.
@MainActor
struct ReaderTextView: UIViewRepresentable {
    let document: ReaderDocument
    let ranges: [HighlightRange]
    let focusedMark: String?
    let scrollRequest: ReaderScrollRequest?
    /// Zählt hoch, wenn die Auswahl weg soll (nach einem Kommando).
    let clearSelection: Int
    let canMark: Bool
    let images: ReaderImageLoader
    let actions: ReaderTextActions

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> ReaderUITextView {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        layout.allowsNonContiguousLayout = false
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layout.addTextContainer(container)

        let view = ReaderUITextView(frame: .zero, textContainer: container)
        view.storage = storage
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.alwaysBounceVertical = true
        view.dataDetectorTypes = []
        view.adjustsFontForContentSizeCategory = false
        view.textContainerInset = UIEdgeInsets(top: 16, left: 20, bottom: 48, right: 20)
        view.linkTextAttributes = [
            .foregroundColor: ReaderPalette.accent,
            .underlineStyle: NSUnderlineStyle.single.rawValue,
            .underlineColor: ReaderPalette.accent.withAlphaComponent(0.4),
        ]
        view.delegate = context.coordinator
        context.coordinator.textView = view

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = context.coordinator
        view.addGestureRecognizer(tap)

        view.onLayout = { [weak coordinator = context.coordinator, weak view] in
            guard let coordinator, let view else { return }
            coordinator.didLayout(view)
        }
        return view
    }

    func updateUIView(_ view: ReaderUITextView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        // Ohne Lesetext (nur Anriss) gibt es nichts zu markieren.
        view.accessibilityHint = canMark ? "Text auswählen, um zu markieren, eine Notiz anzulegen oder zu verbinden." : nil
        if coordinator.document != document {
            coordinator.rebuild(view, document)
        }
        let focus = focusedMark
        if coordinator.ranges != ranges || coordinator.focused != focus {
            coordinator.paint(view, ranges, focus: focus)
        }
        if clearSelection != coordinator.clearSelection {
            coordinator.clearSelection = clearSelection
            coordinator.dropSelection(view)
        }
        if let request = scrollRequest, request.id != coordinator.lastRequest {
            coordinator.lastRequest = request.id
            coordinator.pending = request
            coordinator.applyPending(view)
        }
    }

    static func dismantleUIView(_ view: ReaderUITextView, coordinator: Coordinator) {
        coordinator.cancelImages()
        view.onLayout = nil
    }

    // MARK: Coordinator

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        var parent: ReaderTextView
        weak var textView: ReaderUITextView?

        private(set) var document: ReaderDocument?
        private(set) var map = ReaderDisplayMap.empty
        /// Gesetzter Text ohne Markierungen, um gemalte Stellen zurückzusetzen.
        private var base = NSAttributedString(string: "")
        private(set) var ranges: [HighlightRange] = []
        private(set) var focused: String?
        private var painted: [NSRange] = []
        /// Gemalte Stücke je Markierung, für das Antippen.
        private var marks: [(range: NSRange, id: String)] = []
        private var imageSlots: [(attachment: ReaderImageAttachment, location: Int)] = []
        private var imageTasks: [Task<Void, Never>] = []

        var clearSelection = 0
        var lastRequest: UUID?
        var pending: ReaderScrollRequest?
        /// Eigene Änderungen an Text oder Auswahl melden keine Auswahl.
        private var applying = false
        private var lastWidth: CGFloat = 0
        private var lastProgress = -1.0
        private var lastBlock: Int?

        init(parent: ReaderTextView) {
            self.parent = parent
        }

        // MARK: Setzen und Malen

        /// Setzt den Text neu (Dokument, Schrift, Dynamic Type) und bleibt an der Stelle im Lesetext.
        func rebuild(_ view: ReaderUITextView, _ document: ReaderDocument) {
            let keep = self.document == nil ? nil : topDocumentOffset(view)
            let build = ReaderTypesetter(level: document.level, sans: document.sans, typeSize: document.typeSize).build(document)
            applying = true
            view.attributedText = build.text
            applying = false
            base = build.text
            map = build.map
            imageSlots = build.images
            painted = []
            marks = []
            ranges = []
            focused = nil
            self.document = document
            if let keep, pending == nil {
                pending = ReaderScrollRequest(offset: keep)
            }
            // Der neue Text hat keine Auswahl mehr; gemeldet nach dem laufenden Update.
            let report = parent.actions.select
            Task { report(nil) }
            loadImages(view)
        }

        /// Malt die Markierungen: erst die alten Stellen zurück auf den gesetzten Text, dann neu.
        func paint(_ view: ReaderUITextView, _ ranges: [HighlightRange], focus: String?) {
            let storage = view.textStorage
            storage.beginEditing()
            for range in painted where NSMaxRange(range) <= base.length && NSMaxRange(range) <= storage.length {
                base.enumerateAttributes(in: range, options: []) { attributes, sub, _ in
                    storage.setAttributes(attributes, range: sub)
                }
            }
            painted = []
            marks = []
            for mark in ranges {
                var attributes: [NSAttributedString.Key: Any] = [
                    .backgroundColor: mark.id == focus ? ReaderPalette.markFocus : mark.isPending ? ReaderPalette.markPending : ReaderPalette.mark,
                ]
                if mark.isPending {
                    attributes[.underlineStyle] = NSUnderlineStyle.single.union(.patternDash).rawValue
                    attributes[.underlineColor] = ReaderPalette.warn
                } else if let note = mark.note, !note.isEmpty {
                    attributes[.underlineStyle] = NSUnderlineStyle.thick.union(.patternDot).rawValue
                    attributes[.underlineColor] = ReaderPalette.accent
                }
                for segment in map.displaySegments(for: mark.range) where NSMaxRange(segment) <= storage.length {
                    storage.addAttributes(attributes, range: segment)
                    painted.append(segment)
                    marks.append((segment, mark.id))
                }
            }
            storage.endEditing()
            self.ranges = ranges
            focused = focus
        }

        func dropSelection(_ view: ReaderUITextView) {
            guard view.selectedRange.length > 0 else { return }
            let offset = view.contentOffset
            applying = true
            view.selectedTextRange = nil
            applying = false
            view.setContentOffset(offset, animated: false)
        }

        // MARK: Layout und Sprünge

        func didLayout(_ view: ReaderUITextView) {
            let width = view.bounds.width
            if width != lastWidth {
                lastWidth = width
                // Lesebreite wie `max-width: 72ch`, auf dem iPad mittig.
                let side = max(20, ((width - 680) / 2).rounded())
                if view.textContainerInset.left != side {
                    view.textContainerInset = UIEdgeInsets(top: 16, left: side, bottom: 48, right: side)
                }
            }
            applyPending(view)
        }

        /// Springt zur gewünschten Stelle, sobald der Text Breite hat.
        func applyPending(_ view: ReaderUITextView) {
            guard let request = pending, view.bounds.width > 0, view.textStorage.length > 0 else { return }
            pending = nil
            let location = map.displayLocation(forDocument: request.offset)
            view.layoutManager.ensureLayout(for: view.textContainer)
            view.layoutIfNeeded()
            let y = lineTop(view, location) - 12 - view.adjustedContentInset.top
            let maxY = max(-view.adjustedContentInset.top, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
            let target = CGPoint(x: view.contentOffset.x, y: min(maxY, max(-view.adjustedContentInset.top, y)))
            view.setContentOffset(target, animated: request.animated)
        }

        /// Oberkante der Zeile mit `location` in Inhaltskoordinaten.
        private func lineTop(_ view: UITextView, _ location: Int) -> CGFloat {
            let layout = view.layoutManager
            let length = view.textStorage.length
            guard length > 0 else { return 0 }
            let glyph = layout.glyphIndexForCharacter(at: min(max(0, location), length - 1))
            return layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY + view.textContainerInset.top
        }

        /// Stelle der Anzeige oben im sichtbaren Bereich.
        private func topDisplayLocation(_ view: UITextView) -> Int {
            let y = view.contentOffset.y + view.adjustedContentInset.top + 4 - view.textContainerInset.top
            let glyph = view.layoutManager.glyphIndex(for: CGPoint(x: 1, y: max(0, y)), in: view.textContainer)
            return view.layoutManager.characterIndexForGlyph(at: glyph)
        }

        /// Stelle im Lesetext oben im sichtbaren Bereich (bleibt beim Neusetzen stehen).
        private func topDocumentOffset(_ view: UITextView) -> Int? {
            guard view.textStorage.length > 0, view.bounds.width > 0 else { return nil }
            let location = topDisplayLocation(view)
            guard location >= map.textStart else { return nil }
            return map.documentOffset(atDisplay: location, isEnd: false)
        }

        // MARK: Bilder

        private func loadImages(_ view: ReaderUITextView) {
            cancelImages()
            let loader = parent.images
            imageTasks = imageSlots.map { slot in
                Task { [weak self, weak view] in
                    var image: UIImage?
                    if let source = slot.attachment.source { image = await loader.image(source) }
                    guard !Task.isCancelled, let self, let view else { return }
                    if let image { slot.attachment.loaded = image } else { slot.attachment.failed = true }
                    self.relayout(view, at: slot.location)
                }
            }
        }

        func cancelImages() {
            imageTasks.forEach { $0.cancel() }
            imageTasks = []
        }

        /// Ein Bild hat seine Größe: neu umbrechen, ohne dass der sichtbare Text springt.
        private func relayout(_ view: ReaderUITextView, at location: Int) {
            guard location < view.textStorage.length else { return }
            let top = topDisplayLocation(view)
            let before = lineTop(view, top) - view.contentOffset.y
            let range = NSRange(location: location, length: 1)
            view.layoutManager.invalidateLayout(forCharacterRange: range, actualCharacterRange: nil)
            view.layoutManager.invalidateDisplay(forCharacterRange: range)
            view.layoutManager.ensureLayout(for: view.textContainer)
            view.setNeedsLayout()
            view.layoutIfNeeded()
            if location < top, !view.isTracking {
                let y = lineTop(view, top) - before
                view.setContentOffset(CGPoint(x: view.contentOffset.x, y: y), animated: false)
            }
        }

        // MARK: Fortschritt

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            // Nur was der Finger scrollt, zählt (nicht der Sprung zur Lesestelle beim Öffnen).
            guard scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating,
                  let view = scrollView as? UITextView, view.textStorage.length > 0
            else { return }
            let layout = view.layoutManager
            let top = map.textStart < view.textStorage.length ? lineTop(view, map.textStart) : 0
            let bottom = layout.usedRect(for: view.textContainer).maxY + view.textContainerInset.top
            let visibleBottom = view.contentOffset.y + view.bounds.height - view.adjustedContentInset.bottom
            let progress = bottom > top ? min(1, max(0, (visibleBottom - top) / (bottom - top))) : 1
            let block = map.blockIndex(atDisplay: topDisplayLocation(view)) ?? (map.blocks.isEmpty ? nil : 0)
            guard abs(progress - lastProgress) >= 0.002 || block != lastBlock else { return }
            lastProgress = progress
            lastBlock = block
            parent.actions.scrolled(progress, block)
        }

        // MARK: Auswahl und Antippen

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !applying else { return }
            let range = textView.selectedRange
            parent.actions.select(range.length > 0 ? map.documentRange(forDisplay: range) : nil)
        }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard parent.canMark, let selection = map.documentRange(forDisplay: range) else { return nil }
            let command = parent.actions.command
            let items: [(String, String, ReaderCommand)] = [
                ("Markieren", "highlighter", .mark),
                ("Notiz", "note.text", .note),
                ("Verbinden", "point.3.connected.trianglepath.dotted", .connect),
                ("In Inbox", "tray.and.arrow.down", .inbox),
            ]
            let own = items.map { title, image, kind in
                UIAction(title: title, image: UIImage(systemName: image)) { _ in command(kind, selection) }
            }
            return UIMenu(children: [UIMenu(title: "", options: .displayInline, children: own)] + suggestedActions)
        }

        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            let open = parent.actions.open
            return UIAction { _ in open(url) }
        }

        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard gesture.state == .ended, let view = textView else { return }
            // Ein Tipp bei Auswahl hebt sie auf; das macht die Textansicht selbst.
            guard view.selectedRange.length == 0 else { return }
            if let index = characterIndex(view, at: gesture.location(in: view)),
               let hit = marks.first(where: { NSLocationInRange(index, $0.range) }) {
                parent.actions.tapMark(hit.id)
            } else {
                parent.actions.tapText()
            }
        }

        /// Zeichen unter dem Finger, nur wenn der Finger wirklich auf ihm liegt.
        private func characterIndex(_ view: UITextView, at point: CGPoint) -> Int? {
            guard view.textStorage.length > 0 else { return nil }
            let inner = CGPoint(x: point.x - view.textContainerInset.left, y: point.y - view.textContainerInset.top)
            let layout = view.layoutManager
            let glyph = layout.glyphIndex(for: inner, in: view.textContainer)
            let rect = layout.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: view.textContainer)
            guard rect.insetBy(dx: -6, dy: -6).contains(inner) else { return nil }
            return layout.characterIndexForGlyph(at: glyph)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
