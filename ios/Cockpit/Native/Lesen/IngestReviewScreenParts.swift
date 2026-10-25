import CockpitShared
import SwiftUI

// Bausteine der Prüfansicht (`IngestReviewScreen`): Kopf, Abbruch, Digest, Source-Page und die
// Gruppen mit den Vorschlägen. Claudes Text kommt als Baum (`NoteInline`, `NoteBlock`) und wird
// mit dem Renderer der Notiz gesetzt; Wikilinks auf bestehende Seiten sind Links
// (`x-cockpit-notiz://`), die die Prüfansicht über `OpenURLAction` öffnet.

// MARK: Kopf

/// Quelle, Lesezeit, Stelle unter den bereiten Entwürfen, Titel des Textes, „Text lesen“ und „Original“.
struct IngestReviewHead: View {
    let doc: IngestDocModel
    let readText: () -> Void

    private var meta: String {
        let minutes = doc.ingest?.readingMinutes.flatMap { $0 > 0 ? "\($0) Min. Lesezeit" : nil }
        let position = doc.isReady ? doc.position.map { "\($0) von \(doc.total)" } : nil
        let text = CockpitFormat.meta([doc.ingest?.site, minutes, position])
        return text.isEmpty ? "Ingest-Entwurf" : text
    }

    private var original: URL? {
        guard let raw = doc.ingest?.url, let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(meta)
                .font(.footnote)
                .foregroundStyle(Theme.text3)
            Text(doc.ingest?.docTitle ?? "Ingest")
                .font(.title2.weight(.bold))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
                Button(action: readText) {
                    Label("Text lesen", systemImage: "book")
                }
                .buttonStyle(LesenQuietButtonStyle())
                if let original {
                    Button {
                        ExternalLink.open(original)
                    } label: {
                        Label("Original", systemImage: "safari")
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                }
            }
        }
    }
}

/// Unterbrochenes Übernehmen (`haltedBlock` im Web): was schiefging, was schon steht, und dass
/// „Ins Wiki übernehmen“ dort fortsetzt.
struct IngestHaltedNote: View {
    let halted: IngestHalted
    let openNote: (String) -> Void

    private var slug: String? {
        halted.source.map { ($0 as NSString).lastPathComponent.replacingOccurrences(of: ".md", with: "") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text("Übernehmen unterbrochen: \(halted.message)")
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill")
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.danger)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(Theme.text2)
                .fixedSize(horizontal: false, vertical: true)
            if let source = halted.source {
                Button {
                    openNote(source)
                } label: {
                    Label("Source-Page öffnen", systemImage: "doc.text")
                }
                .buttonStyle(LesenQuietButtonStyle())
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.dangerSoft, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private var detail: String {
        let written = slug.map { "Die Source-Page „\($0)“ ist schon geschrieben; ihre Felder lassen sich hier nicht mehr ändern." } ?? "Ein Teil ist schon geschrieben."
        return "\(written) „Ins Wiki übernehmen“ setzt dort fort, ohne etwas doppelt zu schreiben."
    }
}

// MARK: Karten

/// Fläche mit Überschrift (`section` im Web) für Digest und Source-Page.
struct IngestCard<Content: View>: View {
    let title: String
    var trailing: String?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                if let trailing, !trailing.isEmpty {
                    Text(trailing)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
            }
            content
        }
        .cardStyle()
    }
}

/// Teil des Digests mit kleiner Überschrift („Neu für dich“, „Bestätigt“ …).
struct IngestDigestPart<Content: View>: View {
    let title: String
    var tint: Color = Theme.text2
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
                .accessibilityAddTraits(.isHeader)
            content
        }
    }
}

/// Seite und Aussage in einer Zeile: der Titel als Link auf die Notiz, wenn es sie gibt.
/// Attribute ausdrücklich je Bereich gesetzt wie in `NoteScreenInline` (`font` gäbe es auch in UIKit).
enum IngestRefText {
    static func attributed(_ page: IngestPageRef, _ text: [NoteInline]?, separator: String = " – ") -> AttributedString {
        var out = run(page.title, font: .subheadline.weight(.semibold), color: page.path == nil ? Theme.text : Theme.accent, link: page.path.flatMap { NoteScreenLink.url(.note(path: $0, anchor: nil)) })
        if let text, !text.isEmpty {
            out.append(run(separator, font: .subheadline, color: Theme.text3))
            out.append(NoteScreenInline.attributed(text, style: NoteScreenTextStyle(textStyle: .subheadline, color: Theme.text2)))
        }
        return out
    }

    /// „Beteiligt: RAG, Context Engineering“ mit Links auf bestehende Seiten.
    static func involved(_ pages: [IngestPageRef]) -> AttributedString {
        var out = run("Beteiligt: ", font: .footnote, color: Theme.text3)
        for (index, page) in pages.enumerated() {
            if index > 0 { out.append(run(", ", font: .footnote, color: Theme.text3)) }
            out.append(run(page.title, font: .footnote, color: page.path == nil ? Theme.text2 : Theme.accent, link: page.path.flatMap { NoteScreenLink.url(.note(path: $0, anchor: nil)) }))
        }
        return out
    }

    /// „Vorschlag: …“
    static func proposal(_ content: [NoteInline]) -> AttributedString {
        var out = run("Vorschlag: ", font: .footnote.weight(.semibold), color: Theme.text2)
        out.append(NoteScreenInline.attributed(content, style: NoteScreenTextStyle(textStyle: .footnote, color: Theme.text2)))
        return out
    }

    private static func run(_ text: String, font: Font, color: Color, link: URL? = nil) -> AttributedString {
        var container = AttributeContainer()
        container[AttributeScopes.SwiftUIAttributes.FontAttribute.self] = font
        container[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = color
        if let link {
            container[AttributeScopes.FoundationAttributes.LinkAttribute.self] = link
        }
        return AttributedString(text, attributes: container)
    }
}

// MARK: Digest

/// „Das Wichtigste“ (`digestBlock`): Kernaussagen, Neu für dich, Bestätigt, Widerspricht (mit
/// dem Hinweis auf `/wiki-lint`), Dockt an und Claudes Hinweise.
struct IngestDigestSection: View {
    let view: IngestDraftView

    var body: some View {
        IngestCard(title: "Das Wichtigste") {
            if view.kernaussagen.isEmpty {
                Text("Claude hat keine Kernaussagen notiert.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(view.kernaussagen.enumerated()), id: \.offset) { _, line in
                        IngestBullet(content: line)
                    }
                }
            }
            if !view.neu.isEmpty {
                IngestDigestPart(title: "Neu für dich", tint: Theme.ok) {
                    ForEach(Array(view.neu.enumerated()), id: \.offset) { _, line in
                        IngestBullet(content: line, style: NoteScreenTextStyle(textStyle: .subheadline))
                    }
                }
            }
            if !view.bestaetigt.isEmpty {
                IngestDigestPart(title: "Bestätigt") {
                    ForEach(Array(view.bestaetigt.enumerated()), id: \.offset) { _, ref in
                        Text(IngestRefText.attributed(ref.page, ref.text))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if !view.widerspricht.isEmpty {
                IngestDigestPart(title: "Widerspricht", tint: Theme.warn) {
                    ForEach(Array(view.widerspricht.enumerated()), id: \.offset) { _, ref in
                        contradiction(ref)
                    }
                }
            }
            if !view.docktAn.isEmpty {
                IngestDigestPart(title: "Dockt an") {
                    ForEach(Array(view.docktAn.enumerated()), id: \.offset) { _, ref in
                        Text(IngestRefText.attributed(ref.page, ref.text))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if !view.hinweise.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(view.hinweise.enumerated()), id: \.offset) { _, line in
                        IngestBullet(content: line, style: NoteScreenTextStyle(textStyle: .footnote, color: Theme.text3))
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    /// Widerspruch als Hinweis: Seite, Aussage, Vorschlag; aufgelöst wird per `/wiki-lint`.
    private func contradiction(_ ref: IngestDigestRef) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(IngestRefText.attributed(ref.page, ref.text, separator: ": "))
                .fixedSize(horizontal: false, vertical: true)
            if let proposal = ref.vorschlag, !proposal.isEmpty {
                Text(IngestRefText.proposal(proposal))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Das Cockpit ändert die Seite nicht. Auflösung per /wiki-lint.")
                .font(.footnote)
                .foregroundStyle(Theme.text3)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.warnSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }
}

// MARK: Source-Page

/// Source-Page (`sourceBlock`): Titel, Summary mit Zähler, Slug, Tags; nach einem Abbruch fest.
/// Der Text der Seite lässt sich aufklappen.
@MainActor
struct IngestSourceSection: View {
    @Bindable var store: IngestReviewStore
    let source: IngestSourceView
    let actions: NoteScreenActions

    @State private var showsBody = false

    var body: some View {
        IngestCard(title: "Source-Page", trailing: source.meta) {
            IngestField(label: "Titel", locked: store.fieldsLocked) {
                TextField("Titel", text: $store.title)
                    .disabled(store.fieldsLocked)
            }
            IngestField(label: "Summary", counter: "\(store.summaryCount)/\(store.summaryLimit)", over: store.isSummaryOver, locked: store.fieldsLocked) {
                TextField("Einzeiler", text: $store.summary, axis: .vertical)
                    .lineLimit(1...3)
                    .disabled(store.fieldsLocked)
            }
            IngestField(label: "Slug", problem: store.slugLocked ? nil : store.slugProblem, locked: store.slugLocked) {
                TextField("slug", text: $store.slug)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(store.slugLocked)
            }
            IngestField(label: "Tags", locked: store.fieldsLocked) {
                TextField("englisch, mit Komma", text: $store.tags)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(store.fieldsLocked)
            }
            if let blocks = source.body, !blocks.isEmpty {
                DisclosureGroup(isExpanded: $showsBody) {
                    NoteScreenBlocks(blocks: blocks, actions: actions, prefix: "quelle-")
                        .padding(.top, 8)
                } label: {
                    Text("Text der Source-Page ansehen")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                }
                .tint(Theme.text2)
            }
        }
    }
}

/// Feld mit Beschriftung, optional Zähler („42/80“, rot darüber), Schloss und Fehlertext.
struct IngestField<Field: View>: View {
    let label: String
    var counter: String?
    var over = false
    var problem: String?
    var locked = false
    @ViewBuilder let field: Field

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(label)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text2)
                if locked {
                    Image(systemName: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(Theme.text3)
                        .accessibilityLabel("fest")
                }
                Spacer(minLength: 4)
                if let counter {
                    Text(counter)
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(over ? Theme.danger : Theme.text3)
                        .accessibilityLabel(over ? "\(counter) Zeichen, zu lang" : "\(counter) Zeichen")
                }
            }
            field
                .font(.body)
                .foregroundStyle(locked ? Theme.text2 : Theme.text)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(locked ? Theme.bgSunk : Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                        .strokeBorder(problem == nil && !over ? Theme.line : Theme.danger)
                }
            if let problem {
                Text(problem)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
    }
}

// MARK: Vorschläge

/// Gruppe der Vorschläge (`itemGroups`): Überschrift mit Zahl, „alle“/„keine“, Hinweis und die
/// Zeilen. „Synthesen & Fragen“ ist hervorgehoben.
@MainActor
struct IngestGroupSection: View {
    let group: IngestGroup
    let view: IngestDraftView
    let store: IngestReviewStore
    let actions: NoteScreenActions
    let openNote: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if group.featured {
                        Image(systemName: "sparkles")
                            .foregroundStyle(Theme.accent)
                            .accessibilityHidden(true)
                    }
                    Text(group.label)
                        .font(.headline)
                        .foregroundStyle(group.featured ? Theme.accent : Theme.text)
                    Text("\(group.items.count)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(Theme.text3)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 4)
                if group.items.count > 1 {
                    LesenChip(label: "alle", selected: store.allSelected(group)) { store.selectAll(group) }
                        .accessibilityLabel("\(group.label): alle abhaken")
                    LesenChip(label: "keine", selected: store.noneSelected(group)) { store.selectNone(group) }
                        .accessibilityLabel("\(group.label): keine abhaken")
                }
            }
            if !group.hint.isEmpty {
                Text(group.hint)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(group.items, id: \.id) { ref in
                if let item = view.item(ref.id) {
                    IngestItemRow(
                        item: item,
                        featured: group.featured,
                        selected: store.isSelected(item.id),
                        actions: actions,
                        toggle: { store.toggle(item.id) },
                        open: openNote
                    )
                }
            }
        }
        .padding(.top, 4)
    }
}

/// Ein Vorschlag (`itemRow`): Häkchen, Kennzeichen, Titel (Relation mit Typ), Aussage oder
/// Summary, warum, bei neuen Seiten der Slug. Ein Tipp auf die Zeile schaltet das Häkchen; das
/// Symbol daneben öffnet die bestehende Seite. Text und Beteiligte stehen außerhalb des Knopfs,
/// damit ihre Links und das Aufklappen nicht das Häkchen umschalten.
@MainActor
struct IngestItemRow: View {
    let item: IngestItemView
    let featured: Bool
    let selected: Bool
    let actions: NoteScreenActions
    let toggle: () -> Void
    let open: (String) -> Void

    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 6) {
                Button(action: toggle) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(selected ? Theme.accent : Theme.lineStrong)
                            .contentTransition(.symbolEffect(.replace))
                            .accessibilityHidden(true)
                        texts
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(selected ? [.isSelected] : [])
                .accessibilityHint(selected ? "Abgehakt; tippen nimmt es heraus" : "Tippen hakt es ab")
                if let path = item.open {
                    Button {
                        open(path)
                    } label: {
                        Image(systemName: "arrow.up.right.square")
                            .font(.body)
                            .foregroundStyle(Theme.accent)
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("„\(item.title)“ öffnen")
                }
            }
            if !item.beteiligte.isEmpty {
                Text(IngestRefText.involved(item.beteiligte))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 34)
            }
            if let blocks = item.body, !blocks.isEmpty {
                DisclosureGroup(isExpanded: $expanded) {
                    NoteScreenBlocks(blocks: blocks, actions: actions, prefix: "\(item.id)-")
                        .padding(.top, 6)
                } label: {
                    Text(featured ? "Ganzen Text lesen" : "Text der Seite ansehen")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                }
                .tint(Theme.text2)
                .padding(.leading, 34)
            }
        }
        .padding(featured ? 14 : 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Theme.accentSoft : Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(selected || featured ? Theme.accentLine : Theme.line, lineWidth: featured ? 1.5 : 1)
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: selected)
    }

    /// Kennzeichen, Titel und die kurzen Texte im Knopf.
    private var texts: some View {
        VStack(alignment: .leading, spacing: 4) {
            if item.showsLabel {
                IngestPill(label: item.label, featured: featured)
            }
            if let relation = item.relation {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(relation)
                        .italic()
                        .foregroundStyle(Theme.text2)
                    Text(item.title)
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.text)
                }
                .font(.body)
            } else {
                Text(item.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let claim = item.claim, !claim.isEmpty {
                Text(NoteScreenInline.attributed(claim, style: NoteScreenTextStyle(textStyle: .subheadline, color: Theme.text2)))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let summary = item.summary, !summary.isEmpty {
                Text(NoteScreenInline.attributed(summary, style: NoteScreenTextStyle(textStyle: .subheadline, color: Theme.text2)))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let why = item.warum, !why.isEmpty {
                Text(NoteScreenInline.attributed(why, style: NoteScreenTextStyle(textStyle: .footnote, color: Theme.text3)))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let slug = item.slug {
                Text("neu: \(slug)")
                    .font(.caption.monospaced())
                    .foregroundStyle(Theme.text3)
            }
        }
    }
}
