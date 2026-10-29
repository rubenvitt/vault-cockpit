import CockpitShared
import SwiftUI

/// Was die Teile der Wochenseite brauchen: Store, App (Reiter, Blätter) und Meldungen.
@MainActor
struct WeekEnv {
    let store: WeekStore
    let model: AppModel
    let toasts: ToastCenter

    var timeZone: TimeZone { store.model?.timeZone ?? .current }
    var can: WeekCapabilities { store.model?.capabilities ?? .all }
    /// Heute in der Zeitzone des Cockpits (`JJJJ-MM-TT`), für „Heute“ und „Morgen“ an Fälligkeiten.
    var today: String? { store.model?.today }

    /// Titel einer Aufgabe: Zunder im `SFSafariViewController`.
    func open(_ task: ZunderTask) {
        if let link = task.link { ExternalLink.open(link) }
    }

    /// „Woche planen“ bzw. „Einplanen“ der gezeigten Woche; `flame` springt zu „Flamme einplanen“.
    func plan(from task: ZunderTask? = nil, flame: Bool = false) {
        toasts.signal(.selection)
        let week = store.model?.week
        model.weekPath.append(.plan(week?.current == true ? nil : week?.id, PlanQuery(from: task?.id ?? ""), flame: flame || task != nil))
    }

    func openSettings() {
        model.tab = .settings
    }
}

/// Knopf rechts im Kopf einer Karte („Einplanen“, „Woche planen“).
struct SectionLink {
    let label: String
    let action: () -> Void
}

/// Karte wie `section` im Web: Überschrift mit Hinweis, Zähler und Link, darunter der Inhalt.
struct CardSection<Content: View>: View {
    let title: String
    var hint: String?
    var badge: Int?
    var link: SectionLink?
    let content: Content

    init(_ title: String, hint: String? = nil, badge: Int? = nil, link: SectionLink? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.hint = hint
        self.badge = badge
        self.link = link
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                if let hint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
                if let badge, badge > 0 {
                    CountBadge(count: badge)
                }
                Spacer(minLength: 8)
                if let link {
                    Button(link.label, action: link.action)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.accent)
                        .buttonStyle(.borderless)
                }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(Theme.line)
        }
    }
}

/// Fälligkeit als Schild (`.due` im Web, VCP-54): heute in Akzent, überfällig rot.
struct DueBadge: View {
    let tag: DueTag
    /// Erledigt: ruhig, ohne Farbe.
    var muted = false

    var body: some View {
        Text(tag.text)
            .font(.caption.weight(tag.tone == .overdue && !muted ? .semibold : .medium).monospacedDigit())
            .foregroundStyle(foreground)
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(background, in: Capsule())
            .fixedSize()
            .accessibilityLabel(tag.accessibilityText)
    }

    private var foreground: Color {
        if muted { return Theme.text3 }
        switch tag.tone {
        case .overdue: return Theme.danger
        case .today: return Theme.accent
        case .plain: return Theme.text2
        }
    }

    private var background: Color {
        if muted { return .clear }
        switch tag.tone {
        case .overdue: return Theme.dangerSoft
        case .today: return Theme.accentSoft
        case .plain: return Theme.bgSunk
        }
    }
}

/// Zahl in der Überschrift (`count-badge`), zählt sichtbar hoch und runter.
struct CountBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.caption.weight(.semibold).monospacedDigit())
            .foregroundStyle(Theme.accent)
            .contentTransition(.numericText(value: Double(count)))
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(Theme.accentSoft, in: Capsule())
            .animation(.snappy, value: count)
            .accessibilityLabel("\(count)")
    }
}

/// Leerer Zustand (`p.empty`).
struct EmptyText: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Theme.text3)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Fehler eines Abschnitts (`p.problem`); nicht eingerichtet mit Verweis auf die Einstellungen.
struct ProblemText: View {
    let message: String
    var unconfigured = false
    var onSettings: (() -> Void)?

    init(_ error: SectionError, onSettings: (() -> Void)? = nil) {
        message = error.error
        unconfigured = error.unconfigured
        self.onSettings = onSettings
    }

    init(_ message: String) {
        self.message = message
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: unconfigured ? "gearshape" : "exclamationmark.triangle")
                .accessibilityHidden(true)
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
            if unconfigured, let onSettings {
                Button("Einstellungen", action: onSettings)
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.accent)
            }
        }
        .font(.footnote)
        .foregroundStyle(unconfigured ? Theme.text2 : Theme.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// „läuft“ mit blinkendem Punkt (`.live`).
struct LivePill: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .frame(width: 6, height: 6)
                .opacity(dim ? 0.3 : 1)
            Text("läuft")
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(Theme.accent)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { dim = true }
        }
    }
}

/// Haken im Kästchen (`CHECK_SVG`: `M3.5 8.5l3 3 6-7` in 16 × 16).
struct CheckShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let x = rect.minX, y = rect.minY, w = rect.width / 16, h = rect.height / 16
        path.move(to: CGPoint(x: x + 3.5 * w, y: y + 8.5 * h))
        path.addLine(to: CGPoint(x: x + 6.5 * w, y: y + 11.5 * h))
        path.addLine(to: CGPoint(x: x + 12.5 * w, y: y + 4.5 * h))
        return path
    }
}

/// Kästchen zum Abhaken: Haken zeichnet sich, das Kästchen springt kurz (`pop` im Web).
/// In Arbeit halb gefüllt (`working`), blockiert gestrichelt (`parked`).
@MainActor
struct TickButton: View {
    let status: TaskStatus
    let title: String
    let busy: Bool
    let action: () -> Void

    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 24
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var popped = false

    private var done: Bool { status == .done }
    /// „Abhaken: Titel“ bzw. „Wieder öffnen: Titel“ wie `aria-label` im Web.
    private var label: String { "\(done ? "Wieder öffnen" : "Abhaken"): \(title)" }

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(done ? Theme.ok : Theme.surface)
                if status == .inProgress && !done {
                    // Linke Hälfte in `--accent-soft`, wie der Verlauf im Web.
                    Circle()
                        .trim(from: 0.25, to: 0.75)
                        .fill(Theme.accentSoft)
                }
                Circle()
                    .strokeBorder(borderColor, style: StrokeStyle(lineWidth: 1.5, dash: status == .blocked && !done ? [3, 3] : []))
                CheckShape()
                    .trim(from: 0, to: done ? 1 : 0)
                    .stroke(Theme.surface, style: StrokeStyle(lineWidth: 2.4, lineCap: .round, lineJoin: .round))
                    .padding(size * 0.12)
            }
            .frame(width: size, height: size)
            .scaleEffect(popped ? 1.18 : 1)
            .opacity(busy ? 0.6 : 1)
            .frame(width: max(44, size + 16), height: max(44, size + 16))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.7), value: status)
        .onChange(of: done) { _, isDone in
            guard isDone, !reduceMotion else { return }
            withAnimation(.spring(response: 0.16, dampingFraction: 0.5)) { popped = true }
            Task {
                try? await Task.sleep(nanoseconds: 170_000_000)
                withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) { popped = false }
            }
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(done ? .isSelected : [])
    }

    private var borderColor: Color {
        if done { return Theme.ok }
        return status == .inProgress ? Theme.accent : Theme.lineStrong
    }
}

/// Wackeln des Eingabefelds, wenn leer abgeschickt wurde (`nudge`).
struct ShakeEffect: GeometryEffect {
    var animatableData: CGFloat

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 5 * sin(animatableData * .pi * 4), y: 0))
    }
}

/// Chips, die in die nächste Zeile umbrechen (`.chips` im Web).
struct ChipRow<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        FlowLayout(spacing: 8).callAsFunction { content }
    }
}

/// Zeilen umbrechendes Layout für `ChipRow`.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
