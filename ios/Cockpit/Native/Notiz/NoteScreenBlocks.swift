import CockpitShared
import SwiftUI
import UIKit

/// Was die Blöcke einer Notiz vom Bildschirm brauchen: Abhaken, Bilder mit Geräte-Token, Links
/// und Kopieren. `NoteScreen` baut ihn aus dem `NoteStore`.
@MainActor
struct NoteScreenActions {
    /// Schreibrecht: Checkboxen mit `n` und `line` lassen sich abhaken.
    let canToggle: Bool
    /// Checkbox Nummer `n` wird gerade gesendet.
    let isBusy: (Int) -> Bool
    let toggle: (NoteCheckbox) -> Void
    /// Bild (`/notiz/bild?pfad=…`) mit Geräte-Token, nil wenn es nicht lädt.
    let loadImage: (String) async -> Data?
    let openImage: (NoteScreenImageItem) -> Void
    let openLink: (NoteLinkDestination) -> Void
    let copy: (String) -> Void
}

/// Block mit fester Kennung: Überschriften mit ihrem Anker (`h-…`, Sprungziel für Thesen und
/// `[[#…]]`), alle anderen mit ihrer Stelle im Baum.
struct NoteScreenIndexedBlock: Identifiable {
    let id: String
    let block: NoteBlock

    static func index(_ blocks: [NoteBlock], prefix: String) -> [NoteScreenIndexedBlock] {
        var seen = Set<String>()
        return blocks.enumerated().map { offset, block in
            var id = block.anchor ?? "\(prefix)\(offset)"
            if !seen.insert(id).inserted { id = "\(prefix)\(offset)" }
            return NoteScreenIndexedBlock(id: id, block: block)
        }
    }
}

/// Text der Notiz als Blöcke (wie `.md` im Web), in Callouts verschachtelt. Jeder Block trägt
/// seine Kennung als `.id`, damit `ScrollViewReader` zu Überschriften springen kann.
@MainActor
struct NoteScreenBlocks: View {
    let blocks: [NoteBlock]
    let actions: NoteScreenActions
    /// Vorsilbe der Kennungen (Callouts haben eigene).
    var prefix = "b"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(NoteScreenIndexedBlock.index(blocks, prefix: prefix)) { item in
                NoteScreenBlockView(block: item.block, id: item.id, actions: actions)
                    .id(item.id)
            }
        }
    }
}

/// Ein Block: Überschrift, Absatz, Liste, Zitat, Callout, Tabelle, Code, Linie, Bild, Einbettung.
@MainActor
struct NoteScreenBlockView: View {
    let block: NoteBlock
    let id: String
    let actions: NoteScreenActions

    var body: some View {
        switch block {
        case .heading(let level, _, let content):
            Text(NoteScreenInline.attributed(content, style: Self.headingStyle(level)))
                .padding(.top, level <= 2 ? 10 : 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let content):
            Text(NoteScreenInline.attributed(content))
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        case .list(let list):
            NoteScreenList(list: list, actions: actions)
        case .quote(let content):
            HStack(alignment: .top, spacing: 10) {
                Capsule()
                    .fill(Theme.lineStrong)
                    .frame(width: 3)
                    .accessibilityHidden(true)
                Text(NoteScreenInline.attributed(content, style: NoteScreenTextStyle(color: Theme.text2)))
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Zitat: \(NoteScreenInline.plain(content))")
        case .callout(let callout):
            NoteScreenCallout(callout: callout, id: id, actions: actions)
        case .table(let table):
            NoteScreenTable(table: table)
        case .code(let lang, let text):
            NoteScreenCode(lang: lang, text: text, copy: actions.copy)
        case .rule:
            Rectangle()
                .fill(Theme.line)
                .frame(height: 1)
                .padding(.vertical, 6)
                .accessibilityHidden(true)
        case .image(let image):
            NoteScreenImage(image: image, actions: actions)
        case .embed(let link):
            NoteScreenEmbed(link: link, actions: actions)
        case .unknown:
            EmptyView()
        }
    }

    /// Wie im Web eine Stufe kleiner als im Markdown: `#` wie `h2` (20 px), `##` wie `h3` (17 px).
    static func headingStyle(_ level: Int) -> NoteScreenTextStyle {
        switch level {
        case ...1: NoteScreenTextStyle(textStyle: .title2, weight: .bold)
        case 2: NoteScreenTextStyle(textStyle: .title3, weight: .semibold)
        case 3: NoteScreenTextStyle(textStyle: .headline, weight: .semibold)
        default: NoteScreenTextStyle(textStyle: .subheadline, weight: .semibold)
        }
    }
}

// MARK: Liste

/// Liste mit Einrückung (0–4), Nummern oder Punkten und Checkboxen zum Abhaken.
@MainActor
struct NoteScreenList: View {
    let list: NoteList
    let actions: NoteScreenActions

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(Self.markers(list).enumerated()), id: \.offset) { offset, marker in
                row(list.items[offset], marker: marker)
            }
        }
    }

    @ViewBuilder
    private func row(_ item: NoteListItem, marker: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            if let task = item.task {
                NoteScreenCheckbox(
                    task: task,
                    text: NoteScreenInline.plain(item.content),
                    enabled: actions.canToggle && task.isToggleable,
                    busy: task.n.map(actions.isBusy) ?? false
                ) {
                    actions.toggle(task)
                }
            } else {
                Text(marker)
                    .font(.body.monospacedDigit())
                    .foregroundStyle(Theme.text2)
                    .frame(minWidth: 16, alignment: .trailing)
                    .accessibilityHidden(true)
            }
            Text(NoteScreenInline.attributed(item.content, style: item.task?.done == true ? NoteScreenTextStyle(color: Theme.text3, strike: true) : .body))
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .animation(.snappy, value: item.task?.done)
        }
        .padding(.leading, CGFloat(min(4, max(0, item.depth))) * 20)
    }

    /// Nummer je Einrückung (wie verschachtelte `<ol>`), sonst Punkte; eine flachere Zeile
    /// beginnt die tieferen neu.
    static func markers(_ list: NoteList) -> [String] {
        var counters: [Int] = Array(repeating: 0, count: 5)
        return list.items.map { item in
            let depth = min(4, max(0, item.depth))
            counters[depth] += 1
            for deeper in (depth + 1)..<counters.count { counters[deeper] = 0 }
            if list.ordered { return "\(counters[depth])." }
            return depth == 0 ? "•" : depth == 1 ? "◦" : "▪"
        }
    }
}

/// Kästchen einer Checkbox (`.box` im Web): Haken zeichnet sich, springt kurz. Ohne Schreibrecht
/// oder in Callouts nur Anzeige.
@MainActor
struct NoteScreenCheckbox: View {
    let task: NoteCheckbox
    let text: String
    let enabled: Bool
    let busy: Bool
    let action: () -> Void

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 20
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var popped = false

    var body: some View {
        Group {
            if enabled {
                Button(action: action) { box }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .accessibilityLabel("\(task.done ? "Wieder öffnen" : "Abhaken"): \(text)")
            } else {
                box
                    .accessibilityLabel(task.done ? "Erledigt" : "Offen")
            }
        }
        .accessibilityAddTraits(task.done ? .isSelected : [])
        .onChange(of: task.done) { _, done in
            guard done, !reduceMotion else { return }
            withAnimation(.spring(response: 0.16, dampingFraction: 0.5)) { popped = true }
            Task {
                try? await Task.sleep(nanoseconds: 170_000_000)
                withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) { popped = false }
            }
        }
    }

    private var box: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(task.done ? Theme.ok : Theme.surface)
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .strokeBorder(task.done ? Theme.ok : Theme.lineStrong, lineWidth: 1.5)
            CheckShape()
                .trim(from: 0, to: task.done ? 1 : 0)
                .stroke(Theme.surface, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                .padding(size * 0.1)
        }
        .frame(width: size, height: size)
        .scaleEffect(popped ? 1.18 : 1)
        .opacity(busy ? 0.55 : enabled ? 1 : 0.7)
        .padding(.top, 2)
        // Größere Trefferfläche, ohne die Zeile zu verschieben.
        .padding(10)
        .contentShape(Rectangle())
        .padding(-10)
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.7), value: task.done)
    }
}

// MARK: Callout

/// Obsidian-Callout: farbiger Rand nach Familie, Zeichen nach Art, aufklappbar mit `+`/`-`.
@MainActor
struct NoteScreenCallout: View {
    let callout: NoteCallout
    let id: String
    let actions: NoteScreenActions

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var open: Bool

    init(callout: NoteCallout, id: String, actions: NoteScreenActions) {
        self.callout = callout
        self.id = id
        self.actions = actions
        _open = State(initialValue: callout.open || !callout.foldable)
    }

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(Self.color(callout.family))
                .frame(width: 3)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                header
                if open, !callout.children.isEmpty {
                    NoteScreenBlocks(blocks: callout.children, actions: actions, prefix: "\(id)-")
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.bg)
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var header: some View {
        let title = HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: Self.symbol(callout.kind))
                .foregroundStyle(Self.color(callout.family))
                .accessibilityHidden(true)
            Text(NoteScreenInline.attributed(callout.title, style: NoteScreenTextStyle(weight: .semibold)))
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            if callout.foldable {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .accessibilityHidden(true)
            }
        }
        if callout.foldable {
            Button {
                withAnimation(reduceMotion ? nil : .snappy) { open.toggle() }
            } label: {
                title.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(callout.label): \(NoteScreenInline.plain(callout.title))")
            .accessibilityValue(open ? "aufgeklappt" : "zugeklappt")
            .accessibilityHint(open ? "Zuklappen" : "Aufklappen")
        } else {
            title
                .accessibilityElement(children: .combine)
        }
    }

    /// Randfarbe wie `.callout-ok` usw. in note-render.js.
    static func color(_ family: CalloutFamily) -> Color {
        switch family {
        case .info: Theme.accent
        case .ok: Theme.ok
        case .warn: Theme.warn
        case .bad: Theme.danger
        case .plain: Theme.lineStrong
        }
    }

    /// Zeichen nach der Art, angelehnt an Obsidian.
    static func symbol(_ kind: String) -> String {
        switch kind {
        case "note": "pencil"
        case "todo": "checkmark.circle"
        case "abstract", "summary", "tldr": "doc.text"
        case "tip", "hint": "flame"
        case "important": "exclamationmark.circle"
        case "success", "check", "done": "checkmark"
        case "question", "help", "faq": "questionmark.circle"
        case "warning", "caution", "attention": "exclamationmark.triangle"
        case "failure", "fail", "missing": "xmark"
        case "danger", "error": "bolt"
        case "bug": "ladybug"
        case "example": "list.bullet"
        case "quote", "cite": "text.quote"
        default: "info.circle"
        }
    }
}

// MARK: Tabelle

/// Tabelle seitlich scrollbar, Spalten nach `align` ausgerichtet, Kopf fett mit kräftiger Linie.
@MainActor
struct NoteScreenTable: View {
    let table: NoteTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.head.enumerated()), id: \.offset) { column, cell in
                        self.cell(cell, column: column, head: true)
                            .gridColumnAlignment(Self.horizontal(table.alignment(of: column)))
                    }
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { index, row in
                    // Unter dem Kopf kräftiger, zwischen den Zeilen fein.
                    Rectangle()
                        .fill(index == 0 ? Theme.lineStrong : Theme.line)
                        .frame(height: 1)
                        .gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, cell in
                            self.cell(cell, column: column, head: false)
                        }
                    }
                }
            }
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Theme.line)
            }
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .padding(.bottom, 4)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Tabelle, \(table.head.count) Spalten, \(table.rows.count) Zeilen")
    }

    private func cell(_ content: [NoteInline], column: Int, head: Bool) -> some View {
        NoteScreenCellLayout(minWidth: 44, maxWidth: 280) {
            Text(NoteScreenInline.attributed(content, style: NoteScreenTextStyle(textStyle: .subheadline, weight: head ? .semibold : .regular)))
                .multilineTextAlignment(Self.text(table.alignment(of: column)))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    static func horizontal(_ alignment: NoteColumnAlignment) -> HorizontalAlignment {
        switch alignment {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    static func text(_ alignment: NoteColumnAlignment) -> TextAlignment {
        switch alignment {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

/// Zelle so breit wie ihr Text, höchstens `maxWidth` (dann umbrochen). In der seitlich
/// scrollenden Tabelle gibt es keine Breite von außen, deshalb misst das Layout selbst.
struct NoteScreenCellLayout: Layout {
    let minWidth: CGFloat
    let maxWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let width = min(maxWidth, subview.sizeThatFits(.unspecified).width)
        let size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
        return CGSize(width: max(minWidth, width), height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        let width = min(maxWidth, subview.sizeThatFits(.unspecified).width)
        subview.place(at: bounds.origin, proposal: ProposedViewSize(width: width, height: nil))
    }
}

// MARK: Code

/// Codeblock: Schreibmaschinenschrift, seitlich scrollbar, auswählbar; lange drücken kopiert.
@MainActor
struct NoteScreenCode: View {
    let lang: String?
    let text: String
    let copy: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let lang, !lang.isEmpty {
                Text(lang)
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: text)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.text)
                    .textSelection(.enabled)
                    .padding(12)
            }
            .background(Theme.bgSunk, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                    .strokeBorder(Theme.line)
            }
        }
        .contextMenu {
            Button {
                copy(text)
            } label: {
                Label("Kopieren", systemImage: "doc.on.doc")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Code\(lang.map { " \($0)" } ?? ""): \(text)")
    }
}

// MARK: Einbettung

/// `![[Notiz]]` als Verweis, `![[bild.png]]` als Bild, Dateien und fehlende Ziele nur benannt.
@MainActor
struct NoteScreenEmbed: View {
    let link: NoteWikilink
    let actions: NoteScreenActions

    var body: some View {
        switch link.status {
        case .image:
            if let src = link.src {
                NoteScreenImage(image: NoteImage(path: link.path ?? link.target, src: src, alt: link.text), actions: actions)
            } else {
                named("photo", hint: "Bild fehlt", color: Theme.text3)
            }
        case .note:
            Button {
                actions.openLink(link.destination)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "arrow.turn.down.right")
                        .foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)
                    Text(link.text)
                        .foregroundStyle(Theme.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                        .accessibilityHidden(true)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                        .strokeBorder(Theme.line)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Eingebettet: \(link.text)")
            .accessibilityHint("Öffnet die Notiz")
        case .file:
            named("paperclip", hint: "nur in Obsidian", color: Theme.text2)
        case .missing:
            named("questionmark.square.dashed", hint: "fehlt", color: Theme.text3)
        case .plain:
            Text(link.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func named(_ symbol: String, hint: String, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .accessibilityHidden(true)
            Text(link.text)
            Text(hint)
                .font(.footnote)
                .foregroundStyle(Theme.text3)
        }
        .foregroundStyle(color)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
