import CockpitShared
import SwiftUI

/// Karte zum gewählten Knoten (`.graph-card` im Web). Notiz: Pfad, „ähnlich, 73 %“, Zur Mitte,
/// Notiz ansehen, Verlinken (nur ähnliche zur Mitte), Nachbarn laden. Aufgabe: Kennung und
/// Status, In Zunder öffnen. Termin: Zeit oder „ganztägig“ und Kalender.
@MainActor
struct GraphScreenCard: View {
    let node: GraphNode
    let meta: String
    let isCenter: Bool
    let canOpenNote: Bool
    let canLink: Bool
    let isLinking: Bool
    let canExpand: Bool
    let isExpanding: Bool
    let recenter: () -> Void
    let openNote: () -> Void
    let link: () -> Void
    let expand: () -> Void
    let openURL: (URL) -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: symbol)
                    .font(.footnote)
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                Text(node.label)
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Schließen")
            }
            if !meta.isEmpty {
                Text(meta)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(3)
                    .contentTransition(.opacity)
            }
            actions
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .animation(.snappy, value: canLink)
        .animation(.snappy, value: canExpand)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var actions: some View {
        switch node.kind {
        case .note:
            if !isCenter || canOpenNote || canLink || canExpand {
                ChipRow {
                    if !isCenter {
                        GraphScreenChip(label: "Zur Mitte", systemImage: "scope", action: recenter)
                    }
                    if canOpenNote {
                        GraphScreenChip(label: "Notiz ansehen", systemImage: "doc.text", action: openNote)
                    }
                    if canLink {
                        GraphScreenChip(label: "Verlinken", systemImage: "link", prominent: true, busy: isLinking, action: link)
                            .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    }
                    if canExpand {
                        GraphScreenChip(label: "Nachbarn laden", systemImage: "circle.grid.cross", busy: isExpanding, action: expand)
                            .transition(.opacity.combined(with: .scale(scale: 0.9)))
                    }
                }
                .padding(.trailing, 8)
            }
        case .task:
            if let url = node.link {
                GraphScreenChip(label: "In Zunder öffnen", systemImage: "arrow.up.right.square") { openURL(url) }
            }
        case .event:
            EmptyView()
        }
    }

    private var symbol: String {
        switch node.kind {
        case .note: isCenter ? "smallcircle.filled.circle" : "circle.fill"
        case .task: node.status == .done ? "checkmark.square.fill" : "square.fill"
        case .event: "calendar"
        }
    }

    private var tint: Color {
        GraphScreenScene.nodeColor(node, isCenter: isCenter, onlySimilar: false)
    }
}

/// Kleiner Knopf in Karte und Listen (`.chip` im Web); `prominent` in Akzent, `busy` mit Kreisel.
@MainActor
struct GraphScreenChip: View {
    let label: String
    var systemImage: String?
    var prominent = false
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if busy {
                    ProgressView()
                        .controlSize(.mini)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.caption)
                        .accessibilityHidden(true)
                }
                Text(label)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(prominent ? Theme.accent : Theme.text)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .frame(minHeight: 32)
            .background(prominent ? Theme.accentSoft : Theme.surface2, in: Capsule())
            .overlay { Capsule().strokeBorder(prominent ? Theme.accentLine : Theme.line) }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .animation(.snappy, value: busy)
        .accessibilityLabel(label)
    }
}
