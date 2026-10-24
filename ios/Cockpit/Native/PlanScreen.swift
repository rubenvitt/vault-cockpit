import CockpitShared
import SwiftUI

/// Woche planen nativ (`/planen` im Web), aus der Woche geschoben: Zunder-Aufgaben suchen und in
/// die Woche holen, Vorschläge aus den Bereichen der Big Rocks, Flamme einplanen und was schon in
/// der Woche steht. „Holen“ und „Aus der Woche“ zeigen das Ergebnis sofort, danach lädt die Seite
/// neu (geplant wird nur in Zunder). Gespeicherter Stand und Blättern wie in der Woche.
@MainActor
struct PlanScreen: View {
    let model: AppModel
    let store: PlanStore
    let toasts: ToastCenter
    /// Was das Cockpit anbietet (aus der Woche); ohne Aktionen kann man nicht planen.
    let can: WeekCapabilities
    /// Woche und Vorbelegung, mit denen der Bildschirm geschoben wurde.
    let week: String?
    let query: PlanQuery
    /// Gleich zu „Flamme einplanen“ (`#flamme`).
    var focusFlame = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Woher die neue Woche hereinkommt (vor: von rechts, zurück: von links).
    @State private var direction = Edge.trailing
    @State private var loaded = false
    /// Suchfeld und Bereich, bis „Suchen“ sie an den Store gibt.
    @State private var searchText = ""
    @State private var areaFilter = ""
    /// Zählt hoch, wenn eine Flamme eingeplant ist: das Formular fängt leer neu an.
    @State private var formResets = 0
    @FocusState private var searchFocused: Bool

    private var title: String {
        store.model.map { "Woche planen \($0.week.label)" } ?? "Woche planen"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    LoadStatusView(state: store.state, hasModel: store.model != nil)
                    content(env(proxy))
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
            .task { await appear(env(proxy)) }
        }
        .onChange(of: store.query) { _, query in
            searchText = query.q
            areaFilter = query.area
        }
        .toasts(toasts)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.state.isRefreshing && store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
    }

    private func env(_ proxy: ScrollViewProxy) -> PlanEnv {
        PlanEnv(store: store, model: model, toasts: toasts, scrollTo: { anchor in
            withAnimation(.snappy) { proxy.scrollTo(anchor, anchor: .top) }
        })
    }

    // MARK: Kopf

    /// „12.10.–18.10.“, Pager mit „Zur Woche“ in der Mitte.
    @ViewBuilder private var header: some View {
        if let week = store.model?.week {
            VStack(alignment: .leading, spacing: 10) {
                Text(CockpitFormat.planRange(week))
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                WeekPager(week: week, noun: "Woche planen", onPrevious: {
                    go(.leading) { await store.showPrevious() }
                }, onNext: {
                    go(.trailing) { await store.showNext() }
                }) {
                    Button("Zur Woche") {
                        toasts.signal(.selection)
                        model.open(.week(week.current ? nil : week.id))
                    }
                }
            }
        }
    }

    // MARK: Inhalt

    @ViewBuilder private func content(_ env: PlanEnv) -> some View {
        if let plan = store.model {
            Group {
                switch plan.content {
                case .failed(let error):
                    ProblemText(error, onSettings: { model.tab = .settings })
                        .cardStyle()
                case .ok(let content):
                    if can.actions {
                        PlanSections(
                            plan: plan,
                            content: content,
                            env: env,
                            searchText: $searchText,
                            areaFilter: $areaFilter,
                            searchFocused: $searchFocused,
                            formKey: "\(plan.week.id)|\(content.from?.id ?? "")|\(formResets)",
                            onSearch: { text, area in search(text, area: area) },
                            onFlameCreated: { formResets += 1 }
                        )
                    } else {
                        ProblemText(SectionError(error: "Planen braucht die Cockpit-Aktionen (Zunder-Zugang).", unconfigured: true))
                            .cardStyle()
                    }
                }
            }
            .id(plan.week.id)
            .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.asymmetric(insertion: .move(edge: direction).combined(with: .opacity), removal: .opacity))
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Planung nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else {
            WeekSkeleton(label: "Planung wird geladen")
        }
    }

    /// „Suchen“: Text und Bereich an den Store, Tastatur weg.
    private func search(_ text: String, area: String) {
        searchFocused = false
        toasts.signal(.selection)
        Task { await store.search(text, area: area) }
    }

    // MARK: Blättern

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

    /// Erster Auftritt: Woche und Vorbelegung laden (gespeicherter Stand zuerst), bei „Einplanen“
    /// und „Als Flamme“ zum Formular springen; danach beim Wiederkommen neu laden.
    private func appear(_ env: PlanEnv) async {
        guard !loaded else {
            if !store.state.isRefreshing { await store.refresh() }
            return
        }
        loaded = true
        searchText = query.q
        areaFilter = query.area
        let wantsFlame = focusFlame || !query.from.isEmpty
        let loading = Task { await store.load(week: week, query: query) }
        if wantsFlame {
            // Erst wenn der Bildschirm eingeschoben ist, und schon mit dem gespeicherten Stand.
            try? await Task.sleep(nanoseconds: 400_000_000)
            if store.model != nil { env.scrollTo(PlanAnchor.flame) }
        }
        await loading.value
        if wantsFlame { env.scrollTo(PlanAnchor.flame) }
    }
}

/// Sprungziele in der Planung.
enum PlanAnchor {
    static let search = "planen-suche"
    static let flame = "flamme"
}

/// Was die Teile der Planung brauchen: Store, App, Meldungen und Springen im Bildschirm.
@MainActor
struct PlanEnv {
    let store: PlanStore
    let model: AppModel
    let toasts: ToastCenter
    let scrollTo: (String) -> Void

    var timeZone: TimeZone {
        store.model.flatMap { TimeZone(identifier: $0.tz) } ?? .current
    }

    /// „Holen“: `wann` ist `schritt` oder ein Tag der Woche. Die Zeile zeigt sofort die Pille.
    func add(_ task: ZunderTask, when: String) {
        toasts.signal(.selection)
        Task {
            if await store.add(task, when: when == "schritt" ? .step : .day(when)) {
                toasts.signal(.success)
            }
        }
    }

    /// „Aus der Woche“ (Rückgängig stellt die Markierung wieder her).
    func remove(_ task: ZunderTask) {
        toasts.signal(.selection)
        Task { await store.remove(task) }
    }

    /// „Als Flamme“: Formular mit der Aufgabe als Wurzel, dorthin springen.
    func planFlame(from task: ZunderTask) {
        toasts.signal(.selection)
        scrollTo(PlanAnchor.flame)
        Task {
            await store.planFlame(from: task)
            scrollTo(PlanAnchor.flame)
        }
    }

    /// „ohne“: Formular wieder ohne Wurzelaufgabe.
    func clearFlameSource() {
        toasts.signal(.selection)
        Task { await store.clearFlameSource() }
    }

    /// „alle offenen“ eines Bereichs: Suche nach Bereich, oben zeigen.
    func showArea(_ areaID: String) {
        toasts.signal(.selection)
        scrollTo(PlanAnchor.search)
        Task { await store.load(week: store.requestedWeek, query: PlanQuery(area: areaID)) }
    }

    /// „zur Woche“: zurück in die Woche, die geplant wird.
    func showWeek() {
        guard let week = store.model?.week else { return }
        toasts.signal(.selection)
        model.open(.week(week.current ? nil : week.id))
    }
}
