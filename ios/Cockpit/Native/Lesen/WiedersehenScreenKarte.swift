import CockpitShared
import SwiftUI

/// Karte im Wiedersehen (`.wiedersehen-card`): Text · Quelle · „Box b von 5“, Zitat, Notiz;
/// darunter „Loslassen“ und „Behalten“ und, wenn die Vault-Inbox geht, „In eigenen Worten“.
///
/// Wischen nach rechts behält, nach links lässt los (ab 110 pt; senkrecht bleibt Scrollen). Für
/// VoiceOver stehen beide als Aktionen auf der Karte.
@MainActor
struct WiedersehenCard: View {
    let card: ReviewCard
    let maxBox: Int
    /// Es warten weitere Karten (angedeutet darunter).
    let more: Bool
    let canCapture: Bool
    /// Eine Entscheidung läuft schon oder der gezeigte Stand ist vorläufig.
    let busy: Bool
    let decide: (ReviewDecision) -> Void
    let ownWords: (String) async -> Bool
    let open: () -> Void

    static let commit: CGFloat = 110

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var drag: CGFloat = 0
    @State private var showsWords = false
    @State private var words = ""
    @State private var sending = false
    @FocusState private var wordsFocused: Bool

    /// Entscheidung, die das Loslassen des Fingers jetzt auslösen würde.
    private var toward: ReviewDecision? {
        if drag > Self.commit { return .behalten }
        if drag < -Self.commit { return .loslassen }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            face
            buttons
            if canCapture {
                wordsSection
            }
        }
    }

    // MARK: Karte

    private var face: some View {
        VStack(alignment: .leading, spacing: 14) {
            meta
            MarkiertQuote(text: card.quote, font: .system(.title3, design: .serif))
            if let note = card.note, !note.isEmpty {
                Text(note)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 15)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(toward.map(Self.color) ?? Theme.line, lineWidth: toward == nil ? 1 : 2)
        }
        .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
        .background(alignment: .bottom) {
            if more { stacked }
        }
        .overlay(alignment: .top) { hint }
        .offset(x: drag)
        .rotationEffect(.degrees(reduceMotion ? 0 : Double(drag / 30)), anchor: .bottom)
        .simultaneousGesture(swipe)
        .animation(.easeOut(duration: 0.12), value: toward)
        .sensoryFeedback(.selection, trigger: toward) { _, new in new != nil }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Behalten") { decide(.behalten) }
        .accessibilityAction(named: "Loslassen") { decide(.loslassen) }
        .accessibilityAction(named: "Im Text zeigen", open)
    }

    /// Titel (öffnet die Leseansicht an der Markierung) · Quelle · „Box b von 5“.
    private var meta: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button(action: open) {
                Text(card.docDisplayTitle)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.accent)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Öffnet den Text an dieser Stelle")
            Text([card.docSite, "Box \(min(maxBox, max(1, card.box))) von \(maxBox)"].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.footnote)
                .foregroundStyle(Theme.text3)
                .lineLimit(1)
        }
    }

    /// Angedeutete Karten darunter, wenn weitere warten.
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

    /// Wohin die Karte gleich geht, solange der Finger sie dort hält.
    @ViewBuilder private var hint: some View {
        if let toward {
            Text(toward == .behalten ? "Behalten →" : "← Loslassen")
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

    static func color(_ decision: ReviewDecision) -> Color {
        decision == .behalten ? Theme.ok : Theme.text2
    }

    private var swipe: some Gesture {
        // Global gemessen: Die Karte wandert mit dem Finger, lokal würde der Weg springen.
        DragGesture(minimumDistance: 24, coordinateSpace: .global)
            .onChanged { value in
                guard !busy else { return }
                let dx = value.translation.width
                let dy = value.translation.height
                // Nur deutlich seitlich; sonst gehört die Bewegung dem Scrollen.
                guard drag != 0 || abs(dx) > abs(dy) * 1.5 else { return }
                drag = dx
            }
            .onEnded { _ in
                if let toward, !busy {
                    decide(toward)
                    // Lehnt der Store ab, bleibt die Karte stehen: dann zurück in die Mitte.
                    Task {
                        try? await Task.sleep(for: .milliseconds(700))
                        if drag != 0 {
                            withAnimation(.snappy) { drag = 0 }
                        }
                    }
                } else if drag != 0 {
                    withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.35, dampingFraction: 0.72)) { drag = 0 }
                }
            }
    }

    // MARK: Knöpfe

    private var buttons: some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
        return layout {
            Button {
                decide(.loslassen)
            } label: {
                Text("Loslassen")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(Theme.text2)
            .accessibilityHint("Kommt nie wieder")
            Button {
                decide(.behalten)
            } label: {
                Text("Behalten")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .accessibilityHint("Kommt später wieder")
        }
        .font(.body.weight(.semibold))
        .controlSize(.large)
        .disabled(busy)
    }

    // MARK: In eigenen Worten

    private var trimmedWords: String {
        words.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var wordsSection: some View {
        DisclosureGroup(isExpanded: $showsWords) {
            VStack(alignment: .leading, spacing: 10) {
                ZStack(alignment: .topLeading) {
                    if words.isEmpty {
                        Text("Was heißt das für mich?")
                            .foregroundStyle(Theme.text3)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 8)
                            .accessibilityHidden(true)
                    }
                    TextEditor(text: $words)
                        .focused($wordsFocused)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 110)
                        .accessibilityLabel("In eigenen Worten")
                }
                .font(.body)
                .foregroundStyle(Theme.text)
                .padding(8)
                .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                        .strokeBorder(wordsFocused ? Theme.accentLine : Theme.line)
                }
                HStack(alignment: .center, spacing: 12) {
                    if words.count > ReviewCardsStore.maxWords - 500 {
                        Text("\(words.count) / \(ReviewCardsStore.maxWords)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(words.count >= ReviewCardsStore.maxWords ? Theme.warn : Theme.text3)
                            .contentTransition(.numericText(value: Double(words.count)))
                    }
                    Spacer(minLength: 0)
                    Button(action: send) {
                        HStack(spacing: 8) {
                            if sending {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(Theme.onAccent)
                            }
                            Text("In die Inbox und weiter")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .disabled(sending || busy || trimmedWords.isEmpty)
                    .accessibilityHint("Legt deine Worte mit dem Zitat in der Vault-Inbox ab; die Karte gilt als behalten")
                }
            }
            .padding(.top, 10)
        } label: {
            Label("In eigenen Worten", systemImage: "square.and.pencil")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.text)
        }
        .tint(Theme.text2)
        .onChange(of: showsWords) { _, open in
            wordsFocused = open
        }
        .onChange(of: words) { _, text in
            // Höchstlänge wie `maxlength` im Web.
            if text.count > ReviewCardsStore.maxWords {
                words = String(text.prefix(ReviewCardsStore.maxWords))
            }
        }
        .animation(.snappy, value: showsWords)
    }

    private func send() {
        guard !sending, !busy else { return }
        sending = true
        Task {
            let ok = await ownWords(words)
            sending = false
            if ok {
                words = ""
                wordsFocused = false
                showsWords = false
            }
        }
    }
}
