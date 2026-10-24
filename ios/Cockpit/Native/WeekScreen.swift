import CockpitShared
import SwiftUI

/// Wochenseite nativ (`/` im Web): zeigt sofort den gespeicherten Stand, lädt im Hintergrund neu.
/// Blättern mit dem Pager oder seitlichem Wischen, Ziehen lädt neu, unten die Schnelleingabe.
@MainActor
struct WeekScreen: View {
    let model: AppModel
    let store: WeekStore
    let toasts: ToastCenter

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var captureFocused: Bool
    /// Woher die neue Woche hereinkommt (vor: von rechts, zurück: von links).
    @State private var direction = Edge.trailing

    private var env: WeekEnv { WeekEnv(store: store, model: model, toasts: toasts) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                status
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 24)
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: store.model?.week.id)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg)
        .refreshable { await store.refresh() }
        .simultaneousGesture(swipe)
        .toasts(toasts)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if store.model?.capabilities.actions ?? true {
                CaptureBar(store: store.capture, model: model, focused: $captureFocused)
            }
        }
        .navigationTitle(store.model?.week.label ?? "Woche")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.state.isRefreshing && store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        .task { await appear() }
        .onChange(of: model.captureFocusRequest) { _, _ in captureFocused = true }
    }

    // MARK: Kopf

    @ViewBuilder private var header: some View {
        if let week = store.model?.week {
            VStack(alignment: .leading, spacing: 10) {
                Text(CockpitFormat.weekRange(week))
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                WeekPager(week: week, onPrevious: {
                    go(.leading) { await store.showPrevious() }
                }, onNext: {
                    go(.trailing) { await store.showNext() }
                }) {
                    if week.current {
                        Text("Diese Woche")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Theme.text3)
                            .accessibilityAddTraits(.isSelected)
                    } else {
                        Button("Diese Woche") {
                            go(week.past ? .trailing : .leading) { await store.showCurrent() }
                        }
                    }
                }
            }
        }
    }

    /// „Stand von …“, solange der gezeigte Stand aus dem Zwischenspeicher kommt; Fehler beim Neuladen.
    private var status: some View {
        LoadStatusView(state: store.state, hasModel: store.model != nil)
    }

    // MARK: Inhalt

    @ViewBuilder private var content: some View {
        if let week = store.model {
            WeekSections(week: week, env: env)
                .id(week.week.id)
                .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.asymmetric(insertion: .move(edge: direction).combined(with: .opacity), removal: .opacity))
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Woche nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else {
            WeekSkeleton()
        }
    }

    // MARK: Blättern

    /// Seitlich wischen blättert; senkrecht bleibt Scrollen.
    private var swipe: some Gesture {
        WeekSwipe.gesture(enabled: store.model != nil, previous: {
            go(.leading) { await store.showPrevious() }
        }, next: {
            go(.trailing) { await store.showNext() }
        })
    }

    private func go(_ from: Edge, _ load: @escaping @MainActor () async -> Void) {
        direction = from
        toasts.signal(.selection)
        Task { await load() }
    }

    /// Erster Auftritt: gespeicherter Stand und Laden; danach (Reiter wieder da, zurück vom
    /// Planen) neu laden, wie das Web beim Wiederkommen die Seite neu holt.
    private func appear() async {
        if store.model == nil {
            await store.load(week: store.requestedWeek)
        } else if !store.state.isRefreshing {
            await store.refresh()
        }
    }
}

/// Platzhalter in Form der Woche, nur solange es gar keinen gespeicherten Stand gibt.
struct WeekSkeleton: View {
    /// VoiceOver: was gerade lädt (auch Rückblick und Planung nutzen den Platzhalter).
    var label = "Woche wird geladen"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(0..<4, id: \.self) { index in
                VStack(alignment: .leading, spacing: 10) {
                    Text("Abschnitt der Woche")
                        .font(.headline)
                    ForEach(0..<(index == 0 ? 2 : 3), id: \.self) { _ in
                        HStack(spacing: 12) {
                            Circle().frame(width: 24, height: 24)
                            Text("Eine Aufgabe dieser Woche, ungefähr so lang")
                        }
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            }
        }
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
