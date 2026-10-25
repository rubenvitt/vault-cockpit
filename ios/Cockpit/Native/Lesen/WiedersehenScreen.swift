import CockpitShared
import SwiftUI

/// Wiedersehen nativ (`/lesen/wiedersehen?woche=` im Web): oben die fälligen Karten des Tages
/// (Leitner-Boxen, höchstens 20 am Tag) mit „Heute x von y gesehen · n weitere morgen“, Loslassen,
/// Behalten und „In eigenen Worten“; darunter die Woche mit Zahlen, Themen, Querverbindungen und
/// Markdown-Export.
///
/// Eine Entscheidung nimmt die Karte sofort weg (rechts hinaus behalten, links loslassen) und
/// zeigt „Rückgängig“ in der Meldung. Zeigt sofort den gespeicherten Stand; beim Blättern in eine
/// Woche ohne gespeicherten Stand bleibt die alte Woche gedimmt stehen, bis die neue da ist.
@MainActor
struct WiedersehenScreen: View {
    /// Woche aus dem Link (`2026-W43`), nil = die laufende.
    let week: String?

    @Environment(AppModel.self) private var model
    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var store: ReviewCardsStore?
    /// Letzter geladener Stand, solange eine andere Woche lädt.
    @State private var lastModel: ReviewCardsModel?
    /// Wohin die Karte hinausgeht: rechts behalten, links loslassen.
    @State private var exit = Edge.trailing

    init(week: String? = nil) {
        self.week = week
    }

    var body: some View {
        Group {
            if let store {
                screen(store)
            } else {
                WiedersehenSkeleton()
                    .padding(16)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .background(Theme.bg)
        .toasts(session.toasts)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let store, store.state.isRefreshing, store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        .task { await start() }
        .onChange(of: store?.model) { _, fresh in
            if let fresh { lastModel = fresh }
        }
    }

    /// Erster Auftritt: Store anlegen, gespeicherten Stand zeigen und laden; beim Wiederkommen
    /// (z. B. zurück aus der Leseansicht) neu laden.
    private func start() async {
        if let store {
            if !store.state.isRefreshing { await store.refresh() }
            return
        }
        let store = ReviewCardsStore(context: session.context)
        self.store = store
        await store.load(week: week)
    }

    // MARK: Bildschirm

    private func screen(_ store: ReviewCardsStore) -> some View {
        let shown = store.model ?? (store.state.isRefreshing ? lastModel : nil)
        return ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                LoadStatusView(state: store.state, hasModel: store.model != nil)
                if let shown {
                    today(store, shown, live: store.model != nil)
                    WiedersehenWeekSection(
                        week: shown.week,
                        store: store,
                        canCapture: shown.canCapture,
                        isPlaceholder: store.model == nil,
                        api: session.context.api,
                        toasts: session.toasts,
                        open: { open($0) }
                    )
                } else if let error = store.state.error, !store.state.isRefreshing {
                    LoadFailedView(title: "Wiedersehen nicht geladen", error: error) {
                        Task { await store.refresh() }
                    }
                } else {
                    WiedersehenSkeleton()
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.refresh() }
    }

    // MARK: Heute

    /// Fortschritt, die Karte, die dran ist (darunter angedeutet die nächsten), oder der leere Zustand.
    private func today(_ store: ReviewCardsStore, _ cards: ReviewCardsModel, live: Bool) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if cards.total > 0 {
                VStack(alignment: .leading, spacing: 6) {
                    LesenBar(value: Double(cards.seen) / Double(max(1, cards.total)), tint: Theme.accent)
                    Text(cards.progressLabel)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .contentTransition(.numericText(value: Double(cards.seen)))
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(cards.progressLabel)
                .animation(.snappy, value: cards.seen)
            }
            ZStack(alignment: .top) {
                if let card = cards.cards.first {
                    WiedersehenCard(
                        card: card,
                        maxBox: cards.maxBox,
                        more: cards.cards.count > 1,
                        canCapture: cards.canCapture,
                        busy: !live || store.busy.contains(card.id),
                        decide: { decision in decide(store, card, decision) },
                        ownWords: { words in
                            exit = .trailing
                            return await store.ownWords(card, words)
                        },
                        open: { open(card.highlight) }
                    )
                    .id(card.id)
                    .transition(cardTransition)
                } else {
                    WiedersehenEmpty(title: cards.emptyTitle, detail: cards.emptyDetail, later: cards.later) {
                        session.toasts.signal(.selection)
                        model.open(reading: .highlights(HighlightQuery()))
                    }
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.scale(scale: 0.96).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.82), value: cards.cards.first?.id)
        }
    }

    /// Neue Karte wächst herein; die alte fliegt zur Seite der Entscheidung hinaus.
    private var cardTransition: AnyTransition {
        guard !reduceMotion else { return .opacity }
        return .asymmetric(
            insertion: .scale(scale: 0.94, anchor: .top).combined(with: .opacity),
            removal: .move(edge: exit).combined(with: .opacity)
        )
    }

    private func decide(_ store: ReviewCardsStore, _ card: ReviewCard, _ decision: ReviewDecision) {
        // Erst die Richtung setzen, damit die Karte in diese Richtung hinausgeht.
        exit = decision == .behalten ? .trailing : .leading
        Task { await store.decide(card, decision) }
    }

    /// Leseansicht an der Markierung (`doc#h-…`), obendrauf auf dem Stapel des Lesens.
    private func open(_ highlight: ReadingHighlight) {
        session.toasts.signal(.selection)
        model.open(reading: .reader(id: highlight.docId, highlight: highlight.id, resume: false))
    }
}

// MARK: Leer

/// Keine Karte mehr: „Für heute reicht es“ (morgen kommen welche) oder „Nichts fällig“ mit dem
/// Weg zu allen Markierungen (`.inbox-empty`).
struct WiedersehenEmpty: View {
    let title: String
    let detail: String
    let later: Int
    let openAll: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: later > 0 ? "moon.zzz" : "checkmark.circle")
                .font(.largeTitle)
                .foregroundStyle(later > 0 ? Theme.text3 : Theme.ok)
                .symbolRenderingMode(.hierarchical)
                .accessibilityHidden(true)
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if later == 0 {
                Button("Alle Markierungen", action: openAll)
                    .buttonStyle(LesenQuietButtonStyle())
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .cardStyle(padding: 20)
        .accessibilityElement(children: .contain)
    }
}

/// Platzhalter in Form von Karte und Woche, nur solange es keinen gespeicherten Stand gibt.
struct WiedersehenSkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Heute 0 von 4 gesehen")
                .font(.footnote)
            VStack(alignment: .leading, spacing: 12) {
                Text("Titel des Texts · quelle.de · Box 1 von 5")
                    .font(.footnote)
                Text("Eine Markierung, die wiederkommt, ungefähr zwei Zeilen lang, damit die Karte ihre Form hat.")
                    .font(.system(.title3, design: .serif))
            }
            .cardStyle(padding: 20)
            Text("Die Woche")
                .font(.title3.weight(.semibold))
            HStack(spacing: 8) {
                ForEach(0..<3, id: \.self) { _ in
                    Text("12").font(.title.weight(.bold)).cardStyle(padding: 12)
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
        .accessibilityLabel("Wiedersehen wird geladen")
    }
}
