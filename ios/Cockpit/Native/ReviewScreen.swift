import CockpitShared
import SwiftUI

/// Wochenrückblick nativ (`/rueckblick` im Web): drei Kennzahlen, je Lebensbereich erledigt gegen
/// geplant und Flammen-Zeit, offen Gebliebenes zum Aufklappen, die Flammen der Woche. Nur lesen.
/// Zeigt sofort den gespeicherten Stand und lädt dann neu, Blättern wie in der Woche.
@MainActor
struct ReviewScreen: View {
    let model: AppModel
    let store: ReviewStore
    let toasts: ToastCenter

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Woher die neue Woche hereinkommt (vor: von rechts, zurück: von links).
    @State private var direction = Edge.trailing

    private var title: String {
        store.model.map { "Rückblick \($0.week.label)" } ?? "Rückblick"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    LoadStatusView(state: store.state, hasModel: store.model != nil)
                    content
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 24)
                .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: store.model?.week.id)
            }
            .background(Theme.bg)
            .refreshable { await store.refresh() }
            .simultaneousGesture(swipe)
            .toasts(toasts)
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if store.state.isRefreshing && store.model != nil {
                        ProgressView()
                            .accessibilityLabel("Lädt neu")
                    }
                }
            }
        }
        .task { await appear() }
    }

    // MARK: Kopf

    /// „12.10.2026 – 18.10.2026“, Pager mit „Zur Woche“ in der Mitte.
    @ViewBuilder private var header: some View {
        if let week = store.model?.week {
            VStack(alignment: .leading, spacing: 10) {
                Text(CockpitFormat.reviewRange(week))
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                WeekPager(week: week, onPrevious: {
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

    @ViewBuilder private var content: some View {
        if let review = store.model {
            ReviewContentView(review: review, model: model)
                .id(review.week.id)
                .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.asymmetric(insertion: .move(edge: direction).combined(with: .opacity), removal: .opacity))
            Button {
                model.openReading(path: "/lesen/wiedersehen?woche=\(review.week.id)")
            } label: {
                Label("Markierungen dieser Woche wiedersehen", systemImage: "highlighter")
                    .font(.subheadline.weight(.medium))
            }
            .buttonStyle(.borderless)
            .foregroundStyle(Theme.accent)
            .accessibilityHint("Öffnet den Reiter Lesen")
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Rückblick nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else {
            WeekSkeleton(label: "Rückblick wird geladen")
        }
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

    /// Erster Auftritt: gespeicherter Stand und Laden (die Woche kann ein Link schon gewählt
    /// haben, `AppModel.open(_:)`); danach beim Wiederkommen neu laden.
    private func appear() async {
        guard !store.state.isRefreshing else { return }
        if store.model == nil {
            await store.load(week: store.requestedWeek)
        } else {
            await store.refresh()
        }
    }
}

/// Alles unter dem Kopf: Fehler, leer oder Kennzahlen, Lebensbereiche und Flammen.
@MainActor
struct ReviewContentView: View {
    let review: ReviewModel
    let model: AppModel

    private var timeZone: TimeZone { TimeZone(identifier: review.tz) ?? .current }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch review.content {
            case .failed(let error):
                ProblemText(error, onSettings: { model.tab = .settings })
                    .cardStyle()
            case .ok(let content) where content.areas.isEmpty:
                EmptyText("In dieser Woche war nichts geplant und nichts wurde erledigt.")
                    .cardStyle()
            case .ok(let content):
                ReviewStats(totals: content.totals)
                CardSection("Je Lebensbereich") {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(content.areas.enumerated()), id: \.element.id) { index, area in
                            if index > 0 {
                                Divider()
                            }
                            ReviewAreaRow(area: area, maxMinutes: content.maxMinutes, order: index, timeZone: timeZone)
                                .padding(.vertical, 10)
                        }
                    }
                }
                if !content.flames.isEmpty {
                    CardSection("Flammen") {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(content.flames) { flame in
                                ReviewFlameRow(flame: flame)
                                if flame.id != content.flames.last?.id {
                                    Divider()
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: Kennzahlen

/// Drei Kennzahlen nebeneinander (`.stats`): geplant erledigt, außerdem erledigt, Flammen-Zeit.
@MainActor
struct ReviewStats: View {
    let totals: ReviewTotals

    /// „geplant erledigt · 40 %“, ohne Geplantes nur „geplant erledigt“.
    private var doneLabel: String {
        totals.planned > 0 ? "geplant erledigt · \(totals.percent) %" : "geplant erledigt"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            StatTile(label: doneLabel, accessibility: "\(totals.done) von \(totals.planned) geplanten erledigt") {
                Text("\(totals.done)")
                    + Text("/\(totals.planned)").font(.title3.weight(.medium)).foregroundColor(Theme.text3)
            }
            StatTile(label: "außerdem erledigt", accessibility: "\(totals.extra) außerdem erledigt") {
                Text("\(totals.extra)")
            }
            StatTile(label: "Flammen-Zeit", accessibility: "\(CockpitFormat.hours(totals.minutes)) Flammen-Zeit") {
                Text(CockpitFormat.hours(totals.minutes))
            }
        }
        .animation(.snappy, value: totals)
    }
}

/// Eine Kennzahl (`.stat`): Wert groß, Beschriftung klein darunter.
struct StatTile: View {
    let label: String
    let accessibility: String
    let value: Text

    init(label: String, accessibility: String, value: () -> Text) {
        self.label = label
        self.accessibility = accessibility
        self.value = value()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            value
                .font(.title.weight(.bold).monospacedDigit())
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .contentTransition(.numericText())
            Text(label)
                .font(.caption)
                .foregroundStyle(Theme.text2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
    }
}

// MARK: Lebensbereiche

/// Ein Lebensbereich: Name mit „+N außerdem“, Balken erledigt/geplant, Balken Flammen-Zeit
/// (am größten Bereich gemessen), „N offen geblieben“ zum Aufklappen.
@MainActor
struct ReviewAreaRow: View {
    let area: ReviewArea
    /// Größte Flammen-Zeit eines Bereichs der Woche (Maßstab).
    let maxMinutes: Int
    /// Stelle in der Liste: Balken wachsen nacheinander herein.
    let order: Int
    let timeZone: TimeZone

    @State private var expanded = false

    private var doneShare: Double {
        area.planned > 0 ? Double(area.done) / Double(area.planned) : 0
    }

    private var flameShare: Double {
        Double(area.minutes) / Double(max(1, maxMinutes))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(area.area)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                if area.extra > 0 {
                    Text("+\(area.extra) außerdem")
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
            }
            ReviewMeter(
                label: "erledigt",
                share: doneShare,
                tint: Theme.ok,
                text: area.planned > 0 ? "\(area.done)/\(area.planned)" : "–",
                accessibility: "\(area.done) von \(area.planned) geplanten erledigt",
                delay: Double(order) * 0.06
            )
            ReviewMeter(
                label: "Flammen",
                share: flameShare,
                tint: Theme.accent,
                text: area.minutes > 0 ? CockpitFormat.hours(area.minutes) : "–",
                accessibility: "\(CockpitFormat.hours(area.minutes)) Flammen-Zeit",
                delay: Double(order) * 0.06 + 0.08
            )
            if !area.open.isEmpty {
                DisclosureGroup(isExpanded: $expanded) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(area.open) { task in
                            ReviewOpenRow(task: task, timeZone: timeZone)
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Text("\(area.open.count) offen geblieben")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text2)
                }
                .tint(Theme.text2)
            }
        }
    }
}

/// Balken mit Zahl daneben (`.meter`). Wächst beim Erscheinen von links herein, ohne
/// Bewegung (Bewegung reduzieren) steht er gleich.
struct ReviewMeter: View {
    let label: String
    /// Anteil 0…1.
    let share: Double
    let tint: Color
    let text: String
    let accessibility: String
    var delay: Double = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    private var width: CGFloat { CGFloat(min(1, max(0, share))) }

    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(Theme.text3)
                .lineLimit(1)
                .frame(width: 64, alignment: .leading)
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Theme.line)
                    Capsule()
                        .fill(tint)
                        .frame(width: geometry.size.width * (shown ? width : 0))
                }
            }
            .frame(height: 8)
            .animation(reduceMotion ? nil : .snappy, value: width)
            Text(text)
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .frame(minWidth: 72, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
        .onAppear {
            guard !shown else { return }
            if reduceMotion {
                shown = true
            } else {
                withAnimation(.spring(response: 0.7, dampingFraction: 0.85).delay(delay)) { shown = true }
            }
        }
    }
}

/// Offen gebliebene Aufgabe: Titel öffnet Zunder, dahinter die Fälligkeit.
@MainActor
struct ReviewOpenRow: View {
    let task: ZunderTask
    let timeZone: TimeZone

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            ZunderTitle(task: task)
            if task.due != nil {
                Text(CockpitFormat.dueLabel(task.due, timeZone: timeZone))
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
            }
        }
        .frame(minHeight: 32)
    }
}

/// Flamme der Woche: Titel, rechts Bereich und Dauer.
@MainActor
struct ReviewFlameRow: View {
    let flame: ZunderTask

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            ZunderTitle(task: flame)
            Text("\(flame.area) · \(CockpitFormat.hours(flame.minutes ?? 0))")
                .font(.footnote)
                .foregroundStyle(Theme.text2)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 8)
    }
}

/// Titel einer Aufgabe als Link in die Zunder-Oberfläche (ohne Link nur Text).
@MainActor
struct ZunderTitle: View {
    let task: ZunderTask
    var font: Font = .subheadline

    var body: some View {
        if let link = task.link {
            Button {
                ExternalLink.open(link)
            } label: {
                label
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Öffnet die Aufgabe in Zunder")
        } else {
            label
        }
    }

    private var label: some View {
        Text(task.title)
            .font(font)
            .strikethrough(task.isDone, color: Theme.text3)
            .foregroundStyle(task.isDone ? Theme.text2 : Theme.text)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
