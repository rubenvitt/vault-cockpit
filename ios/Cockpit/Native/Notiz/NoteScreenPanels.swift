import CockpitShared
import SwiftUI

// MARK: Kopf

/// Titel, Pfad und die Links „Graph“ und „In Obsidian öffnen“ (`page-head` im Web); nach dem
/// Ablegen der Hinweis, woher die Notiz kam.
@MainActor
struct NoteScreenHeader: View {
    let model: NoteModel
    let movedFrom: String?
    let openGraph: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(model.title)
                .font(.title.weight(.bold))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(model.path)
                .font(.footnote)
                .foregroundStyle(Theme.text2)
                .textSelection(.enabled)
                .contentTransition(.opacity)
                .animation(.snappy, value: model.path)
            if model.can.graph || model.obsidianURL != nil {
                HStack(spacing: 16) {
                    if model.can.graph {
                        Button(action: openGraph) {
                            Label("Graph", systemImage: "point.3.connected.trianglepath.dotted")
                        }
                    }
                    if let obsidian = model.obsidianURL {
                        Button {
                            ExternalLink.open(obsidian)
                        } label: {
                            Label("In Obsidian öffnen", systemImage: "arrow.up.forward.app")
                        }
                    }
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.accent)
                .buttonStyle(.borderless)
            }
            if let movedFrom, movedFrom != model.path {
                Label("Abgelegt, vorher \(movedFrom)", systemImage: "folder")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Tags der Notiz (`#idee #hund`) über dem Text.
struct NoteScreenTags: View {
    let tags: [String]

    var body: some View {
        ChipRow {
            ForEach(tags, id: \.self) { tag in
                Text("#\(tag)")
                    .font(.subheadline)
                    .foregroundStyle(Theme.accent)
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: tags)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Tags: \(tags.joined(separator: ", "))")
    }
}

// MARK: Frontmatter

/// Frontmatter zugeklappt in einer Zeile (die ersten drei Felder, „+N“), aufgeklappt alle mit
/// klickbaren Wikilinks (`details.fm` im Web).
@MainActor
struct NoteScreenFrontmatter: View {
    let model: NoteModel

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded.animation(reduceMotion ? nil : .snappy)) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(model.frontmatter) { field in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(field.key)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.text2)
                            .frame(minWidth: 72, alignment: .leading)
                        Text(NoteScreenInline.attributed(field.content, style: NoteScreenTextStyle(textStyle: .footnote, color: Theme.text2)))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.top, 8)
        } label: {
            Text(summary)
                .font(.footnote)
                .foregroundStyle(Theme.text2)
                .lineLimit(expanded ? nil : 2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .tint(Theme.text2)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .accessibilityHint(expanded ? "Zuklappen" : "Alle Felder zeigen")
    }

    /// „projekt: Hund · status: offen +2“, lange Werte gekürzt wie im Web (40 Zeichen).
    private var summary: String {
        let preview = model.frontmatterPreview
        let line = preview.shown.map { field in
            let text = field.text.count > 40 ? "\(field.text.prefix(39))…" : field.text
            return "\(field.key): \(text)"
        }.joined(separator: " · ")
        return preview.more > 0 ? "\(line) +\(preview.more)" : line
    }
}

// MARK: Synthese

/// Chips „Art · Status · Vertrauen“ einer Synthese (`synthesisChips` im Web), auch in Wissen.
struct NoteScreenSynthChips: View {
    let art: String?
    let status: String?
    let confidence: String?

    private var chips: [(String, String)] {
        [("Art", art), ("Status", status), ("Vertrauen", confidence)].compactMap { label, value in
            guard let value, !value.isEmpty else { return nil }
            return (label, value)
        }
    }

    var body: some View {
        if !chips.isEmpty {
            ChipRow {
                ForEach(chips, id: \.0) { label, value in
                    HStack(spacing: 4) {
                        Text(label)
                            .foregroundStyle(Theme.text3)
                        Text(value)
                            .foregroundStyle(Theme.text)
                    }
                    .font(.footnote)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
                    .background(Theme.surface2, in: Capsule())
                    .overlay { Capsule().strokeBorder(Theme.line) }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// Kopf einer Synthese: Zusammenfassung groß, Chips, Thesen als Sprungmarken, offene Punkte und
/// „Als Aufgaben nach Zunder“.
@MainActor
struct NoteScreenSynthesis: View {
    let head: SynthesisHead
    let creatingTasks: Bool
    let jump: (String) -> Void
    let createTasks: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let summary = head.summary, !summary.isEmpty {
                Text(NoteScreenInline.attributed(summary, style: NoteScreenTextStyle(textStyle: .title3)))
                    .lineSpacing(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            NoteScreenSynthChips(art: head.art, status: head.status, confidence: head.confidence)
            if !head.theses.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    heading("Thesen")
                    ForEach(Array(head.theses.enumerated()), id: \.element.id) { index, thesis in
                        Button {
                            jump(thesis.id)
                        } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("\(index + 1).")
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.text3)
                                Text(thesis.text)
                                    .foregroundStyle(Theme.accent)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("These \(index + 1): \(thesis.text)")
                        .accessibilityHint("Springt zur Überschrift")
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                heading("Offene Punkte")
                if head.openPoints.isEmpty {
                    EmptyText("Keine offenen Punkte.")
                } else {
                    ForEach(Array(head.openPoints.enumerated()), id: \.offset) { _, point in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("•")
                                .foregroundStyle(Theme.text3)
                                .accessibilityHidden(true)
                            Text(point)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if head.toZunder {
                        Button(action: createTasks) {
                            HStack(spacing: 6) {
                                if creatingTasks {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Image(systemName: "flame")
                                        .accessibilityHidden(true)
                                }
                                Text("Als Aufgaben nach Zunder")
                            }
                        }
                        .buttonStyle(LesenQuietButtonStyle())
                        .disabled(creatingTasks)
                        .padding(.top, 4)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .strokeBorder(Theme.line)
        }
    }

    private func heading(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.text2)
            .accessibilityAddTraits(.isHeader)
    }
}

// MARK: Belege

/// „Aus dem Lesestapel passt dazu“: Markierungen, die zur Synthese passen; Zitat öffnet die
/// Leseansicht an der Markierung, „Als Beleg anhängen“ schreibt sie in die Notiz.
@MainActor
struct NoteScreenEvidence: View {
    let items: [EvidenceSuggestion]
    let canWrite: Bool
    let isBusy: (String) -> Bool
    let open: (EvidenceSuggestion) -> Void
    let attach: (EvidenceSuggestion) -> Void

    var body: some View {
        CardSection("Aus dem Lesestapel passt dazu", badge: items.count) {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Button {
                            open(item)
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Capsule()
                                    .fill(Theme.accentLine)
                                    .frame(width: 3)
                                    .accessibilityHidden(true)
                                Text("„\(item.text)“")
                                    .foregroundStyle(Theme.text)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .fixedSize(horizontal: false, vertical: true)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(item.href == nil)
                        .accessibilityHint("Öffnet die Markierung in der Leseansicht")
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(item.title)
                                .foregroundStyle(Theme.text2)
                            if let score = item.score {
                                Text(NoteScreenScore.text(score))
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.text3)
                            }
                        }
                        .font(.footnote)
                        if canWrite {
                            Button {
                                attach(item)
                            } label: {
                                HStack(spacing: 6) {
                                    if isBusy(item.id) {
                                        ProgressView()
                                            .controlSize(.small)
                                    }
                                    Text("Als Beleg anhängen")
                                }
                            }
                            .buttonStyle(LesenQuietButtonStyle())
                            .disabled(isBusy(item.id))
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .leading)))
                }
            }
        }
    }
}

/// Ähnlichkeit wie im Web: `Math.round(score * 100)` Prozent.
enum NoteScreenScore {
    static func text(_ score: Double) -> String {
        "\(Int((score * 100).rounded())) %"
    }
}

// MARK: Verwandte

/// „Verweist hierher“ (Backlinks) und „Ähnlich“ (bis zu sechs, mit Prozent und „verlinkt“).
@MainActor
struct NoteScreenRelated: View {
    let related: NoteRelated
    let open: (String) -> Void

    var body: some View {
        VStack(spacing: 16) {
            CardSection("Verweist hierher", badge: related.backlinks.count) {
                if related.backlinks.isEmpty {
                    EmptyText("Keine Backlinks.")
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(related.backlinks) { ref in
                            NoteScreenNoteRow(title: ref.title, path: ref.path, score: nil, linked: false) { open(ref.path) }
                        }
                    }
                }
            }
            CardSection("Ähnlich") {
                VStack(alignment: .leading, spacing: 10) {
                    if related.similar.isEmpty {
                        EmptyText("Keine ähnlichen Notizen.")
                    } else {
                        ForEach(related.similar.prefix(6)) { note in
                            NoteScreenNoteRow(title: note.title, path: note.path, score: note.score, linked: note.linked) { open(note.path) }
                        }
                    }
                    if let problem = related.problem {
                        Text(problem)
                            .font(.footnote)
                            .foregroundStyle(Theme.text3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }
}

/// Zeile mit einer Notiz: Titel als Link, Prozent, „verlinkt“, darunter der Pfad.
@MainActor
struct NoteScreenNoteRow: View {
    let title: String
    let path: String
    let score: Double?
    let linked: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(title)
                        .foregroundStyle(Theme.accent)
                        .fixedSize(horizontal: false, vertical: true)
                    if let score {
                        Text(NoteScreenScore.text(score))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(Theme.text2)
                    }
                    if linked {
                        Text("verlinkt")
                            .font(.footnote)
                            .foregroundStyle(Theme.text3)
                            .transition(.opacity)
                    }
                }
                Text(path)
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.snappy, value: linked)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Öffnet die Notiz")
    }
}

// MARK: Bausteine

/// Knopf als Chip (`.chip` im Web): „+ #tag“, „wiki/ 3 von 5“, „Verlinken“.
struct NoteScreenChip: View {
    let label: String
    var detail: String?
    var busy = false
    var systemImage: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if busy {
                    ProgressView()
                        .controlSize(.mini)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .accessibilityHidden(true)
                }
                Text(label)
                if let detail {
                    Text(detail)
                        .foregroundStyle(Theme.text3)
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: 34)
            .background(Theme.accentSoft, in: Capsule())
            .overlay { Capsule().strokeBorder(Theme.accentLine) }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

extension View {
    /// Eingabefeld wie `.note-actions input` im Web.
    func noteScreenField() -> some View {
        self
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(minHeight: 40)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Theme.line)
            }
    }
}
