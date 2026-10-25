import CockpitShared
import SwiftUI

/// Kopf eines Schritts (`.folge-schritt-kopf`): Nummer, Frage und Hinweis.
struct NeueFolgeStepHead: View {
    let number: Int
    let title: String
    let hint: String?

    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 28

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(Theme.accent)
                .frame(width: size, height: size)
                .background(Theme.accentSoft, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                if let hint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Text zum Abhaken (`.folge-textwahl`): Titel und „8 Min. Lesezeit · Quelle“.
struct NeueFolgeTextRow: View {
    let item: StackItem
    let selected: Bool
    let toggle: () -> Void

    private var meta: String {
        CockpitFormat.meta(["\(item.readingMinutes) Min. Lesezeit", item.site])
    }

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: selected ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(selected ? Theme.accent : Theme.text3)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.displayTitle)
                        .font(.body.weight(.medium))
                        .foregroundStyle(selected ? Theme.text : Theme.text2)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                    Text(meta)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(NeueFolgePressStyle())
        .animation(.snappy(duration: 0.2), value: selected)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.displayTitle), \(meta)")
        .accessibilityValue(selected ? "Gewählt" : "Nicht gewählt")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
        .accessibilityAction { toggle() }
    }
}

/// Art als Auswahlkarte (`.folge-wahl`): Zeichen, Name, Beschreibung und Kosten; was nicht geht,
/// ist ausgegraut und nennt den Grund (ElevenLabs oder Claude fehlt).
struct NeueFolgeKindCard: View {
    let kind: EpisodeKindInfo
    let selected: Bool
    let select: () -> Void

    @ScaledMetric(relativeTo: .title3) private var iconSize: CGFloat = 44

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
    }

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: FolgenKind.icon(kind.kind))
                    .font(.title3)
                    .foregroundStyle(selected ? Theme.onAccent : Theme.accent)
                    .frame(width: iconSize, height: iconSize)
                    .background(selected ? Theme.accent : Theme.accentSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(kind.label)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text)
                    Text(kind.description)
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                    if let missing = kind.missing {
                        Label(missing, systemImage: "exclamationmark.circle")
                            .font(.footnote)
                            .foregroundStyle(Theme.warn)
                    } else {
                        Text(kind.cost)
                            .font(.footnote)
                            .foregroundStyle(Theme.text3)
                    }
                }
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Theme.accent : Theme.text3)
                    .contentTransition(.symbolEffect(.replace))
                    .accessibilityHidden(true)
            }
            .padding(14)
            .background(selected ? Theme.accentSoft : Theme.surface, in: shape)
            .overlay {
                shape.strokeBorder(selected ? Theme.accent : Theme.line, lineWidth: selected ? 1.5 : 1)
            }
            .contentShape(shape)
        }
        .buttonStyle(NeueFolgePressStyle())
        .disabled(!kind.isAvailable)
        .opacity(kind.isAvailable ? 1 : 0.6)
        .animation(.snappy(duration: 0.25), value: selected)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// Leiste am unteren Rand (`.folge-los`): der Satz zur Auswahl (live wie `newSummary`) und
/// „Folge erzeugen“, das nach dem ersten Tippen gesperrt bleibt.
struct NeueFolgeSubmitBar: View {
    let store: NewEpisodeStore
    let submit: () -> Void

    var body: some View {
        let summary = store.summary
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(summary.main)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .contentTransition(.numericText())
                if !summary.cost.isEmpty {
                    Text(summary.cost)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .contentTransition(.numericText())
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .animation(.snappy, value: summary)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.updatesFrequently)
            Button(action: submit) {
                HStack(spacing: 8) {
                    if store.isSubmitting {
                        ProgressView()
                            .tint(Theme.onAccent)
                    } else if store.didSubmit {
                        Image(systemName: "checkmark")
                            .accessibilityHidden(true)
                    }
                    Text(store.didSubmit ? "Folge entsteht" : "Folge erzeugen")
                }
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(!store.canSubmit)
            .accessibilityHint(store.canSubmit ? "Die Folge entsteht im Hintergrund" : "")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Theme.bg)
        .overlay(alignment: .top) {
            Theme.line.frame(height: 0.5)
        }
    }
}

/// Karten und Zeilen, die beim Drücken leicht nachgeben.
struct NeueFolgePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}
