import CockpitShared
import SwiftUI

/// Wischen auf der Karte wie src/web/static/lesen-eingang.js: links weg, rechts lesen, nach unten
/// auf den Stapel. Die Richtung steht erst nach 32 pt fest und muss 1,5-mal überwiegen (schräg
/// bleibt die Karte liegen); ausgelöst wird ab 30 % der Kartenbreite bzw. -höhe. Am Rand (24 pt)
/// gehört die Berührung der Zurück-Geste von iOS.
struct EingangSwipe: Equatable {
    enum Axis: Equatable { case horizontal, vertical }

    static let edge: CGFloat = 24
    static let lock: CGFloat = 32
    static let dominance: CGFloat = 1.5
    static let commit: CGFloat = 0.3

    /// Festgelegte Richtung, nil = noch offen.
    private(set) var axis: Axis?
    /// Schräg oder am Rand begonnen: Die Karte bleibt liegen, bis der Finger loslässt.
    private(set) var isRejected: Bool
    /// Verschiebung der Karte, nur entlang der Achse (nach unten nur positiv).
    private(set) var offset: CGSize = .zero

    /// `startX`: wo der Finger aufsetzte, `width`: Breite des Bildschirms (beides global).
    init(startX: CGFloat, width: CGFloat) {
        isRejected = startX < Self.edge || startX > width - Self.edge
    }

    /// Neue Strecke des Fingers seit dem Aufsetzen.
    mutating func update(_ translation: CGSize) {
        guard !isRejected else { return }
        let dx = translation.width, dy = translation.height
        if axis == nil {
            guard (dx * dx + dy * dy).squareRoot() >= Self.lock else { return }
            if abs(dx) > Self.dominance * abs(dy) {
                axis = .horizontal
            } else if dy > Self.dominance * abs(dx) {
                axis = .vertical
            } else {
                isRejected = true
                return
            }
        }
        offset = axis == .horizontal ? CGSize(width: dx, height: 0) : CGSize(width: 0, height: max(0, dy))
    }

    /// Drehung in Grad wie `rotate(dx / 30 deg)`.
    var rotation: Double { Double(offset.width / 30) }

    /// Entscheidung, die das Loslassen jetzt auslösen würde (`toward` im Web).
    func target(card: CGSize) -> InboxDecision? {
        guard !isRejected, axis != nil else { return nil }
        if offset.width < -card.width * Self.commit { return .weg }
        if offset.width > card.width * Self.commit { return .lesen }
        if offset.height > card.height * Self.commit { return .stapel }
        return nil
    }
}

/// Karte, die gerade hinausfliegt (`fly-weg`, `fly-lesen`, `fly-stapel`).
struct EingangFlight: Equatable {
    let id: String
    let decision: InboxDecision
}

/// Oberste Karte im Eingang (`.inbox-card`): Quelle · Art · Lesezeit, Titel, Auszug, Themen,
/// „Warum hier?“. Bei mehr als einer Karte liegen angedeutete Karten darunter.
@MainActor
struct EingangCard: View {
    let card: InboxCard
    let more: Bool
    /// Richtung, in die das Loslassen gerade entscheiden würde (Rand in deren Farbe).
    let toward: InboxDecision?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            meta
            Text(card.displayTitle)
                .font(.system(.title3, design: .serif).weight(.semibold))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let excerpt = card.excerpt, !excerpt.isEmpty {
                Text(excerpt)
                    .font(.system(.body, design: .serif))
                    .foregroundStyle(Theme.text2)
                    .lineSpacing(3)
                    // Bei wenig Platz kürzt zuerst der Auszug.
                    .layoutPriority(-1)
            }
            if !card.topics.isEmpty {
                ChipRow {
                    ForEach(card.topics, id: \.self) { topic in
                        Text(topic)
                            .font(.footnote)
                            .foregroundStyle(Theme.text2)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 2)
                            .background(Theme.surface2, in: Capsule())
                            .overlay { Capsule().strokeBorder(Theme.line) }
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Themen: \(card.topics.joined(separator: ", "))")
            }
            Spacer(minLength: 0)
            why
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(borderColor, lineWidth: toward == nil ? 1 : 2)
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
        .background(alignment: .bottom) {
            if more { stacked }
        }
        .overlay(alignment: .top) { hint }
        .animation(.easeOut(duration: 0.12), value: toward)
    }

    /// Quelle (Link zum Original), Art, Lesezeit.
    private var meta: some View {
        HStack(spacing: 6) {
            if let site = card.siteLabel, let url = URL(string: card.url), url.scheme?.hasPrefix("http") == true {
                Button { ExternalLink.open(url) } label: {
                    Text(site).underline()
                }
                .buttonStyle(.plain)
                .accessibilityHint("Öffnet das Original")
                Text("·").accessibilityHidden(true)
            } else if let site = card.siteLabel {
                Text(site)
                Text("·").accessibilityHidden(true)
            }
            Text(card.kindLabel)
            if card.readingMinutes > 0 {
                Text("·").accessibilityHidden(true)
                Text("\(card.readingMinutes) min")
            }
        }
        .font(.subheadline)
        .foregroundStyle(Theme.text2)
        .lineLimit(1)
    }

    /// „Warum hier? Feed Beispiel-Blog, abonniert im Oktober 2026 · 23. Okt.“
    private var why: some View {
        VStack(alignment: .leading, spacing: 0) {
            Theme.line.frame(height: 1)
                .padding(.bottom, 10)
            (Text("Warum hier? ").fontWeight(.semibold).foregroundStyle(Theme.text)
                + Text([card.why, card.savedLabel].filter { !$0.isEmpty }.joined(separator: " · ")))
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Angedeutete Karten darunter (`.inbox-card.more`).
    private var stacked: some View {
        ZStack(alignment: .bottom) {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Theme.surface)
                .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.lineStrong) }
                .padding(.horizontal, 14)
                .offset(y: 12)
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Theme.surface)
                .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.lineStrong) }
                .padding(.horizontal, 7)
                .offset(y: 6)
        }
        .accessibilityHidden(true)
    }

    /// Wohin die Karte gleich geht, groß über der Karte, solange der Finger sie dort hält.
    @ViewBuilder private var hint: some View {
        if let toward {
            Text(Self.hintLabel(toward))
                .font(.headline)
                .foregroundStyle(Theme.onAccent)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(Self.color(toward), in: Capsule())
                .padding(.top, -14)
                .transition(.scale(scale: 0.8).combined(with: .opacity))
                .accessibilityHidden(true)
        }
    }

    private var borderColor: Color {
        toward.map(Self.color) ?? Theme.line
    }

    /// Farbe der Richtung: weg rot, Stapel grün, lesen Akzent (`data-toward`).
    static func color(_ decision: InboxDecision) -> Color {
        switch decision {
        case .weg: Theme.danger
        case .stapel: Theme.ok
        case .lesen: Theme.accent
        }
    }

    static func hintLabel(_ decision: InboxDecision) -> String {
        switch decision {
        case .weg: "← Weg"
        case .stapel: "↓ Stapel"
        case .lesen: "Lesen →"
        }
    }
}

/// Platzhalter, solange die nächste Karte lädt oder noch nichts gespeichert ist.
struct EingangPlaceholderCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Quelle · Artikel · 5 min")
                .font(.subheadline)
            Text("Ein Titel für die nächste Karte, ungefähr so lang")
                .font(.system(.title3, design: .serif).weight(.semibold))
            Text("Ein Auszug aus dem Text, ein paar Sätze lang, damit die Karte ihre Form hat.")
                .font(.system(.body, design: .serif))
            Spacer(minLength: 0)
            Text("Warum hier? Über den Kurzbefehl gespeichert")
                .font(.subheadline)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.line) }
        .redacted(reason: .placeholder)
        .opacity(dim ? 0.55 : 1)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Nächste Karte wird geladen")
    }
}
