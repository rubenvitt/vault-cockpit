import CockpitShared
import SwiftUI
import UIKit

// Zeilen und Köpfe der Feeds-Seite.

/// Ein Feed (`.feed` im Web): Icon, Titel, Kurzinfo (Host, Abstand, Stapel, Filter) und der
/// Stand (pausiert, Fehler, abgerufen). `paused` kann vom gespeicherten Stand abweichen, solange
/// eine Pause per Wischen unterwegs ist (`pending`). Im Auswahlmodus (`selected` nicht nil) steht
/// vorne das Häkchen und hinten kein Pfeil.
struct FeedsScreenFeedRow: View {
    let feed: ReadingFeed
    let paused: Bool
    var pending = false
    var busy = false
    var selected: Bool?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if let selected {
                FeedsScreenCheckmark(selected: selected)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
            FeedsScreenIcon(feed: feed, size: 30)
                .opacity(paused ? 0.55 : 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(feed.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(paused ? Theme.text2 : Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(feed.meta)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
                status
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if busy {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Wird gespeichert")
            } else if selected == nil {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .padding(.top, 4)
                    .accessibilityHidden(true)
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected == true ? .isSelected : [])
    }

    /// „pausiert“, „pausiert (Gruppe)“, „Fehler (2×): …“, „abgerufen …“, „noch nicht abgerufen“.
    private var status: some View {
        let state = shownState
        return HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: Self.symbol(state))
                .font(.caption.weight(.semibold))
                .accessibilityHidden(true)
            Text(statusText)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
        }
        .foregroundStyle(Self.tint(state))
        .animation(.snappy, value: paused)
    }

    /// Stand mit der Pause, die gerade unterwegs ist.
    private var shownState: FeedState {
        guard pending else { return feed.state }
        if paused { return .paused }
        return feed.state == .paused ? (feed.groupPaused ? .groupPaused : (feed.lastFetchAt == nil ? .new : .ok)) : feed.state
    }

    private var statusText: String {
        guard pending else { return feed.status }
        if paused { return "pausiert" }
        return feed.paused ? "fortgesetzt" : feed.status
    }

    static func symbol(_ state: FeedState) -> String {
        switch state {
        case .ok: "checkmark.circle"
        case .new: "clock"
        case .error: "exclamationmark.triangle.fill"
        case .paused, .groupPaused: "pause.circle"
        }
    }

    static func tint(_ state: FeedState) -> Color {
        switch state {
        case .error: Theme.danger
        case .paused, .groupPaused: Theme.warn
        case .ok, .new: Theme.text3
        }
    }
}

/// Favicon aus der `data:`-URI, sonst der Anfangsbuchstabe auf einer Fläche (`.feed-letter`).
struct FeedsScreenIcon: View {
    let feed: ReadingFeed
    var size: CGFloat = 30

    var body: some View {
        Group {
            if let image = FeedsScreenIconCache.image(feed) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.12)
            } else {
                Text(feed.letter)
                    .font(.system(size: size * 0.5, weight: .semibold, design: .rounded))
                    .foregroundStyle(Theme.accent)
            }
        }
        .frame(width: size, height: size)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .accessibilityHidden(true)
    }
}

/// Dekodierte Favicons je `data:`-URI, damit Scrollen nicht jedes Mal Base64 liest.
@MainActor
enum FeedsScreenIconCache {
    private static var images: [String: UIImage] = [:]
    /// URIs, die sich nicht als Bild lesen ließen.
    private static var broken: Set<String> = []

    static func image(_ feed: ReadingFeed) -> UIImage? {
        guard let icon = feed.icon else { return nil }
        if let image = images[icon] { return image }
        guard !broken.contains(icon) else { return nil }
        guard let data = feed.iconData, let image = UIImage(data: data) else {
            broken.insert(icon)
            return nil
        }
        if images.count > 300 { images.removeAll() }
        images[icon] = image
        return image
    }
}

/// Kopf einer Gruppe: Auf-/Zuklappen, Name, „n neu“ (Tipp öffnet den Eingang der Gruppe) und
/// das Menü „Gruppe bearbeiten“, „Nach oben“, „Nach unten“, „Gruppe löschen“.
struct FeedsScreenGroupHeader: View {
    let group: FeedGroup
    let collapsed: Bool
    let busy: Bool
    let toggle: () -> Void
    let openInbox: () -> Void
    let edit: () -> Void
    let move: (_ up: Bool) -> Void
    let delete: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            Button(action: toggle) {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.bold))
                        .foregroundStyle(Theme.text3)
                        .rotationEffect(.degrees(collapsed ? 0 : 90))
                        .animation(reduceMotion ? nil : .snappy, value: collapsed)
                        .accessibilityHidden(true)
                    Text(group.name)
                        .font(.headline)
                        .foregroundStyle(group.paused ? Theme.text2 : Theme.text)
                        .multilineTextAlignment(.leading)
                    if group.paused {
                        Image(systemName: "pause.circle")
                            .font(.subheadline)
                            .foregroundStyle(Theme.warn)
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(group.name)
            .accessibilityValue(collapsed ? "zugeklappt" : "aufgeklappt")
            .accessibilityHint(collapsed ? "Klappt die Gruppe auf" : "Klappt die Gruppe zu")
            .accessibilityAddTraits(.isHeader)
            Button(action: openInbox) {
                FeedsScreenBadge(count: group.inbox)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(group.inboxText)
            .accessibilityHint("Öffnet den Eingang dieser Gruppe")
            Spacer(minLength: 8)
            if busy {
                ProgressView()
                    .controlSize(.small)
            }
            Menu {
                Button(action: edit) {
                    Label("Gruppe bearbeiten", systemImage: "pencil")
                }
                Button {
                    move(true)
                } label: {
                    Label("Nach oben", systemImage: "arrow.up")
                }
                .disabled(!group.canMoveUp || busy)
                Button {
                    move(false)
                } label: {
                    Label("Nach unten", systemImage: "arrow.down")
                }
                .disabled(!group.canMoveDown || busy)
                Divider()
                Button(role: .destructive, action: delete) {
                    Label("Gruppe löschen", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(Theme.accent)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Gruppe \(group.name) bearbeiten")
        }
        .textCase(nil)
        .padding(.vertical, 2)
    }
}

/// „3 neu“ wie `.count-badge`; bei 0 zurückhaltend.
struct FeedsScreenBadge: View {
    let count: Int

    var body: some View {
        Text("\(count) neu")
            .font(.caption.weight(.semibold))
            .monospacedDigit()
            .contentTransition(.numericText(value: Double(count)))
            .animation(.snappy, value: count)
            .foregroundStyle(count > 0 ? Theme.accent : Theme.text3)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(count > 0 ? Theme.accentSoft : Theme.surface2, in: Capsule())
            .overlay { Capsule().strokeBorder(count > 0 ? Theme.accentLine : Theme.line) }
            .frame(minHeight: 32)
            .contentShape(Rectangle())
    }
}

/// „1 neuer Eintrag im Eingang · pausiert · direkt auf den Stapel“ als Zeile zum Eingang der Gruppe.
struct FeedsScreenInboxRow: View {
    let group: FeedGroup
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "tray")
                    .foregroundStyle(group.inbox > 0 ? Theme.accent : Theme.text3)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.inboxText)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(group.inbox > 0 ? Theme.accent : Theme.text2)
                        .contentTransition(.numericText(value: Double(group.inbox)))
                    if let flags = group.flags {
                        Text(flags)
                            .font(.footnote)
                            .foregroundStyle(Theme.text3)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Öffnet den Eingang dieser Gruppe")
    }
}

/// Kopf „Ohne Gruppe“ (nur, wenn es Gruppen gibt), aufklappbar wie die Gruppen.
struct FeedsScreenLooseHeader: View {
    let count: Int
    let collapsed: Bool
    let toggle: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Theme.text3)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                    .animation(reduceMotion ? nil : .snappy, value: collapsed)
                    .accessibilityHidden(true)
                Text("Ohne Gruppe")
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                Text("\(count)")
                    .font(.subheadline)
                    .monospacedDigit()
                    .foregroundStyle(Theme.text3)
                    .contentTransition(.numericText(value: Double(count)))
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .accessibilityLabel("Ohne Gruppe, \(count) \(count == 1 ? "Feed" : "Feeds")")
        .accessibilityValue(collapsed ? "zugeklappt" : "aufgeklappt")
        .accessibilityAddTraits(.isHeader)
    }
}

/// „3 Feeds“ über der Liste, wenn es keine Gruppen gibt.
struct FeedsScreenCount: View {
    let total: Int

    var body: some View {
        Text("\(total) \(total == 1 ? "Feed" : "Feeds")")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Theme.text2)
            .contentTransition(.numericText(value: Double(total)))
            .animation(.snappy, value: total)
            .textCase(nil)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Leertext als Fläche („Noch keine Feeds abonniert.“).
struct FeedsScreenEmpty: View {
    let text: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(Theme.text3)
                .accessibilityHidden(true)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
        }
        .cardStyle(padding: 16)
    }
}
