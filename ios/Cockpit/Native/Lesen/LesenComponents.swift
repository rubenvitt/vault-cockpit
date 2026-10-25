import CockpitShared
import SwiftUI

/// Chip wie `.chip` im Web: Kapsel, der gewählte in Akzentfarbe (`aria-current`). Ein Tipp
/// wählt sofort aus; geladen wird danach.
struct LesenChip: View {
    let label: String
    var count: Int?
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Text(label)
                if let count {
                    Text("\(count)")
                        .monospacedDigit()
                        .foregroundStyle(selected ? Theme.accent : Theme.text3)
                        .contentTransition(.numericText(value: Double(count)))
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(selected ? Theme.accent : Theme.text2)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: 34)
            .background(selected ? Theme.accentSoft : Theme.surface, in: Capsule())
            .overlay {
                Capsule().strokeBorder(selected ? Theme.accentLine : Theme.line)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .animation(.snappy, value: selected)
        .accessibilityLabel(count.map { "\(label), \($0)" } ?? label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Chips in einer seitlich scrollenden Zeile (Unternavigation, Gruppen, Zeitfenster), damit die
/// Zeile bei großer Schrift nicht umbricht.
struct LesenChipScroller<Content: View>: View {
    let label: String
    let content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) { content }
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

/// Gruppen-Chips „Alle · Gruppe · Ohne Feed“ (`groupChips` im Web), im Eingang mit Zählern.
/// `current`: Gruppen-ID, `ohne` oder nil (alle).
struct LesenGroupChips: View {
    let groups: [ReadingGroup]
    let current: String?
    /// Dokumente ohne Feed (nur im Eingang).
    var noFeedCount: Int?
    let select: (String?) -> Void

    var body: some View {
        LesenChipScroller("Gruppe") {
            LesenChip(label: "Alle", selected: current == nil) { select(nil) }
            ForEach(groups) { group in
                LesenChip(label: group.name, count: group.count, selected: current == group.id) { select(group.id) }
            }
            LesenChip(label: "Ohne Feed", count: noFeedCount, selected: current == ReadingGroupFilter.noFeed) { select(ReadingGroupFilter.noFeed) }
        }
    }
}

/// Fortschrittsbalken wie `progress` im Web (`.inbox-progress`, `.stapel-bar`): 4 pt, runde Enden.
struct LesenBar: View {
    let value: Double
    var tint: Color = Theme.ok

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.line)
                Capsule()
                    .fill(tint)
                    .frame(width: proxy.size.width * min(1, max(0, value)))
            }
        }
        .frame(height: 4)
        .animation(.snappy, value: value)
        .accessibilityHidden(true)
    }
}

/// Knopf „Im Vault ablegen“, „Unterwegs hören“ usw. (`.btn.quiet`).
struct LesenQuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 38)
            .background(Theme.surface, in: Capsule())
            .overlay { Capsule().strokeBorder(Theme.line) }
            .opacity(configuration.isPressed ? 0.7 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}

/// Platzhalter in Form von Listenzeilen, nur solange es keinen gespeicherten Stand gibt.
struct LesenSkeleton: View {
    let label: String
    var rows = 5
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(0..<rows, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 6) {
                    Text("Ein Text auf dem Stapel, ungefähr so lang")
                        .font(.body.weight(.semibold))
                    Text("noch 8 Min. · Quelle")
                        .font(.footnote)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .redacted(reason: .placeholder)
        .opacity(dim ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}
