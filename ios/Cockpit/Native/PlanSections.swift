import CockpitShared
import SwiftUI

/// Alle Abschnitte der Planung in der Reihenfolge des Webs (`renderPlan`).
@MainActor
struct PlanSections: View {
    let plan: PlanModel
    let content: PlanContent
    let env: PlanEnv
    @Binding var searchText: String
    @Binding var areaFilter: String
    var searchFocused: FocusState<Bool>.Binding
    /// Woche, Wurzelaufgabe und Zähler: ändert sich einer, fängt „Flamme einplanen“ neu an.
    let formKey: String
    /// Suchen mit Text und Bereich.
    let onSearch: (String, String) -> Void
    let onFlameCreated: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            PlanFindSection(plan: plan, content: content, env: env, text: $searchText, area: $areaFilter, focused: searchFocused, onSearch: onSearch)
                .id(PlanAnchor.search)
            PlanSuggestSection(plan: plan, content: content, env: env)
            CardSection("Flamme einplanen", hint: "Deep-Work-Block für \(plan.week.label)") {
                FlameForm(plan: plan, content: content, env: env, onCreated: onFlameCreated)
                    .id(formKey)
            }
            .id(PlanAnchor.flame)
            PlannedSection(plan: plan, planned: content.planned, env: env)
        }
    }
}

// MARK: Zur Woche hinzufügen

/// Suche (Text oder Kennung wie VCP-47) mit Bereichsfilter, darunter die Treffer.
@MainActor
struct PlanFindSection: View {
    let plan: PlanModel
    let content: PlanContent
    let env: PlanEnv
    @Binding var text: String
    @Binding var area: String
    var focused: FocusState<Bool>.Binding
    /// Suchen mit Text und Bereich.
    let onSearch: (String, String) -> Void

    var body: some View {
        CardSection("Zur Woche hinzufügen") {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
                TextField("Aufgabe suchen oder Kennung wie VCP-47", text: $text)
                    .focused(focused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .onSubmit { onSearch(text, area) }
                    .accessibilityLabel("Zunder durchsuchen")
                if !text.isEmpty {
                    Button {
                        text = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Theme.text3)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Suchbegriff löschen")
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                    .strokeBorder(Theme.line)
            }
            HStack(spacing: 8) {
                Picker("Bereich", selection: $area) {
                    Text("Alle Bereiche").tag("")
                    ForEach(content.areas ?? []) { option in
                        Text(option.name).tag(option.id)
                    }
                }
                .pickerStyle(.menu)
                .tint(Theme.text)
                // Ein anderer Bereich sucht gleich (im Web erst mit „Suchen“); nicht, wenn der Store
                // ihn selbst gesetzt hat („alle offenen“, Blättern).
                .onChange(of: area) { _, value in
                    if value != env.store.query.area { onSearch(text, value) }
                }
                Spacer(minLength: 0)
                if env.store.state.isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                }
                Button("Suchen") { onSearch(text, area) }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
            }
            results
        }
    }

    @ViewBuilder private var results: some View {
        switch content.results {
        case .none:
            Text("Suchbegriff eingeben oder einen Bereich wählen. Aufgaben aus Dev-Projekten bleiben außen vor.")
                .font(.footnote)
                .foregroundStyle(Theme.text2)
                .fixedSize(horizontal: false, vertical: true)
        case .some(.failed(let error)):
            ProblemText(error, onSettings: { env.model.tab = .settings })
        case .some(.ok(let tasks)) where tasks.isEmpty:
            EmptyText(plan.query.q.isEmpty ? "Keine offene Aufgabe gefunden." : "Keine offene Aufgabe gefunden für „\(plan.query.q)“.")
        case .some(.ok(let tasks)):
            PlanCandidateList(tasks: tasks, plan: plan, env: env)
        }
    }
}

/// Aufgaben zum Holen mit Trennlinien; neue gleiten ein.
@MainActor
struct PlanCandidateList: View {
    let tasks: [ZunderTask]
    let plan: PlanModel
    let env: PlanEnv
    var showArea = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(tasks) { task in
                PlanCandidateRow(task: task, plan: plan, env: env, showArea: showArea)
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .top).combined(with: .opacity))
                if task.id != tasks.last?.id {
                    Divider()
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: tasks.map(\.id))
    }
}

/// Eine Aufgabe zum Holen (`candidate`): Titel (öffnet Zunder), Kennung · Ort · Fälligkeit ·
/// Status, darunter „wann“ mit „Holen“ und „Als Flamme“, oder die Pille, wenn sie schon in der
/// Woche steht, mit „Aus der Woche“ (außer sie ist nur fällig).
@MainActor
struct PlanCandidateRow: View {
    let task: ZunderTask
    let plan: PlanModel
    let env: PlanEnv
    var showArea = true

    /// `schritt` oder ein Tag der Woche.
    @State private var when = "schritt"

    private var reason: String? { env.store.plannedReason(task) }
    private var busy: Bool { env.store.busy.contains(task.id) }
    private var meta: String { task.planMeta(timeZone: env.timeZone, showArea: showArea) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZunderTitle(task: task, font: .body)
            if !meta.isEmpty {
                Text(meta)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
            }
            side
                .animation(.snappy, value: reason)
        }
        .padding(.vertical, 10)
    }

    @ViewBuilder private var side: some View {
        if let reason {
            HStack(spacing: 8) {
                PlanPill(text: PlanReason.label(reason, week: plan.week))
                if reason != PlanReason.due {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Button("Aus der Woche") { env.remove(task) }
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                            .tint(Theme.text2)
                            .accessibilityLabel("Aus der Woche nehmen: \(task.title)")
                    }
                }
            }
            .transition(.scale(scale: 0.9).combined(with: .opacity))
        } else {
            ChipRow {
                Picker("Wann", selection: $when) {
                    Text("Phönix-Schritt \(plan.week.label)").tag("schritt")
                    Section("Fällig am") {
                        ForEach(plan.week.days) { day in
                            Text(day.today ? "\(day.label) (heute)" : day.label).tag(day.date)
                        }
                    }
                }
                .pickerStyle(.menu)
                .tint(Theme.text)
                .accessibilityLabel("Wann")
                Button {
                    env.add(task, when: when)
                } label: {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text("Holen")
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                .tint(Theme.accent)
                .disabled(busy)
                .accessibilityLabel("In die Woche holen: \(task.title)")
                Button("Als Flamme") { env.planFlame(from: task) }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(Theme.accent)
                    .accessibilityLabel("Als Flamme einplanen: \(task.title)")
            }
            .transition(.opacity)
        }
    }
}

/// Pille „Flamme KW 42“ (`.pill.ok`).
struct PlanPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.ok)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.okSoft, in: Capsule())
    }
}

// MARK: Aus den Bereichen

/// Je Bereich der Big Rocks: offene Aufgaben ohne Termin, fünf und „und N weitere“.
@MainActor
struct PlanSuggestSection: View {
    let plan: PlanModel
    let content: PlanContent
    let env: PlanEnv

    var body: some View {
        CardSection("Aus den Bereichen", hint: "offen und ohne Termin, je Big Rock") {
            if content.suggestions.isEmpty {
                EmptyText("Noch keine Big Rocks in dieser Woche. Über die Suche oder einen Bereich die erste Aufgabe holen.")
            } else {
                VStack(spacing: 12) {
                    ForEach(content.suggestions) { suggestion in
                        suggestionCard(suggestion)
                    }
                }
            }
        }
    }

    private func suggestionCard(_ suggestion: PlanSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(suggestion.area)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Button("alle offenen") { env.showArea(suggestion.areaId) }
                    .font(.footnote.weight(.medium))
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.accent)
                    .accessibilityLabel("Alle offenen Aufgaben in \(suggestion.area)")
            }
            if !suggestion.ok {
                ProblemText(suggestion.error ?? "Zunder hat nicht geantwortet.")
            } else if suggestion.tasks.isEmpty {
                EmptyText("Nichts offen ohne Termin.")
            } else {
                PlanCandidateList(tasks: suggestion.tasks, plan: plan, env: env, showArea: false)
                if suggestion.more > 0 {
                    Text("und \(suggestion.more) weitere")
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }
}

// MARK: Flamme einplanen

/// Formular „Flamme einplanen“: Titel, Tag, optional Uhrzeit (5-Minuten-Schritte) und Bereich;
/// aus einer Aufgabe („Als Flamme“) wird die Flamme ihre Unteraufgabe, ohne Bereich.
@MainActor
struct FlameForm: View {
    let plan: PlanModel
    let content: PlanContent
    let env: PlanEnv
    let onCreated: () -> Void

    @State private var draft: FlameDraft
    @State private var withTime = false
    @State private var hour = 9
    @State private var minute = 0

    /// Höchstlänge des Titels (`maxlength` im Web).
    static let titleLimit = 500
    private static let minutes = Array(stride(from: 0, to: 60, by: 5))

    init(plan: PlanModel, content: PlanContent, env: PlanEnv, onCreated: @escaping () -> Void) {
        self.plan = plan
        self.content = content
        self.env = env
        self.onCreated = onCreated
        _draft = State(initialValue: FlameDraft(title: content.from?.title ?? "", day: plan.defaultFlameDay))
    }

    private var saving: Bool { env.store.busy.contains("flamme") }
    private var empty: Bool { draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let from = content.from {
                source(from)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Titel")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.text2)
                TextField("z. B. Folien für den Workshop", text: $draft.title, axis: .vertical)
                    .lineLimit(1...3)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                            .strokeBorder(Theme.line)
                    }
                    .accessibilityLabel("Titel")
                    .onChange(of: draft.title) { _, title in
                        if title.count > Self.titleLimit { draft.title = String(title.prefix(Self.titleLimit)) }
                    }
            }
            LabeledContent("Tag") {
                Picker("Tag", selection: $draft.day) {
                    ForEach(plan.week.days) { day in
                        Text(day.today ? "\(day.label) (heute)" : day.label).tag(day.date)
                    }
                }
                .pickerStyle(.menu)
                .tint(Theme.text)
            }
            Toggle(isOn: $withTime.animation(.snappy)) {
                HStack(spacing: 4) {
                    Text("Uhrzeit")
                    Text("optional")
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
            }
            .tint(Theme.accent)
            if withTime {
                HStack(spacing: 4) {
                    Spacer(minLength: 0)
                    Picker("Stunde", selection: $hour) {
                        ForEach(0..<24, id: \.self) { value in
                            Text(Self.two(value)).tag(value)
                        }
                    }
                    .pickerStyle(.menu)
                    Text(":")
                        .font(.body.monospacedDigit())
                    Picker("Minute", selection: $minute) {
                        ForEach(Self.minutes, id: \.self) { value in
                            Text(Self.two(value)).tag(value)
                        }
                    }
                    .pickerStyle(.menu)
                }
                .tint(Theme.text)
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Uhrzeit")
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
            if content.from == nil {
                LabeledContent("Bereich") {
                    Picker("Bereich", selection: $draft.place) {
                        Text("Ohne Bereich").tag(PlanPlace.loose)
                        ForEach(content.areas ?? []) { area in
                            Text(area.name).tag(PlanPlace.area(area.id))
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(Theme.text)
                }
            }
            Button {
                submit()
            } label: {
                Group {
                    if saving {
                        ProgressView()
                            .tint(Theme.onAccent)
                    } else {
                        Text("Flamme einplanen")
                            .font(.body.weight(.semibold))
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 32)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(empty || saving)
        }
        .font(.subheadline)
    }

    /// „Als Unteraufgabe von <Aufgabe> · ohne“
    private func source(_ from: ZunderTask) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("Als Unteraufgabe von")
                .foregroundStyle(Theme.text2)
            if let link = from.link {
                Button(from.name) { ExternalLink.open(link) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.accent)
                    .lineLimit(2)
            } else {
                Text(from.name)
                    .foregroundStyle(Theme.text)
            }
            Text("·")
                .foregroundStyle(Theme.text3)
            Button("ohne") { env.clearFlameSource() }
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.accent)
                .accessibilityLabel("Ohne Wurzelaufgabe einplanen")
        }
        .font(.footnote)
    }

    private func submit() {
        guard !empty, !saving else { return }
        var flame = draft
        flame.time = withTime ? "\(Self.two(hour)):\(Self.two(minute))" : ""
        env.toasts.signal(.selection)
        Task {
            if await env.store.createFlame(flame) {
                env.toasts.signal(.success)
                onCreated()
            }
        }
    }

    private static func two(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }
}

// MARK: In KW n

/// Was schon in der Woche steht: Flammen, Big Rocks je Bereich, mit „Aus der Woche“.
@MainActor
struct PlannedSection: View {
    let plan: PlanModel
    let planned: PlannedWeek
    let env: PlanEnv

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        CardSection("In \(plan.week.label)", link: SectionLink(label: "zur Woche", action: { env.showWeek() })) {
            if !planned.ok {
                ProblemText(planned.error ?? "Zunder hat nicht geantwortet.")
            } else {
                subheading("Flammen", count: nil)
                if planned.flames.isEmpty {
                    EmptyText("Keine Flammen geplant.")
                } else {
                    rows(planned.flames, showArea: true)
                }
                subheading("Big Rocks", count: nil)
                    .padding(.top, 4)
                if planned.rocks.isEmpty {
                    EmptyText("Nichts fällig und kein Phönix-Schritt markiert.")
                } else {
                    ForEach(planned.rocks) { group in
                        subheading(group.area, count: group.tasks.count, small: true)
                        rows(group.tasks, showArea: false)
                    }
                }
                if planned.partial {
                    ProblemText(partialText)
                }
            }
        }
    }

    /// Hinweis, wenn nur eine der beiden Zunder-Abfragen geantwortet hat, mit dem Fehler der anderen.
    private var partialText: String {
        let text = "Nicht alle Zunder-Abfragen haben geantwortet; die Liste ist unvollständig."
        guard let error = planned.error, !error.isEmpty else { return text }
        return "\(text) \(error)"
    }

    private func subheading(_ title: String, count: Int?, small: Bool = false) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(small ? Font.footnote.weight(.semibold) : Font.subheadline.weight(.semibold))
                .foregroundStyle(small ? Theme.text2 : Theme.text)
                .accessibilityAddTraits(.isHeader)
            if let count {
                CountBadge(count: count)
            }
        }
    }

    private func rows(_ tasks: [ZunderTask], showArea: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(tasks) { task in
                PlannedRow(task: task, env: env, showArea: showArea)
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .top).combined(with: .opacity))
                if task.id != tasks.last?.id {
                    Divider().padding(.leading, 28)
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: tasks.map(\.id))
    }
}

/// Zeile in „In KW n“: Zeichen (✓, 🕯️, ○), Titel, Meta; rechts „Aus der Woche“ für offene
/// Phönix-Aufgaben, „fällig“ für nur fällige. Gerade herausgenommen: blass, bis neu geladen ist.
@MainActor
struct PlannedRow: View {
    let task: ZunderTask
    let env: PlanEnv
    var showArea = false

    private var busy: Bool { env.store.busy.contains(task.id) }
    private var leaving: Bool { task.planned != nil && env.store.plannedReason(task) == nil }
    private var meta: String { task.planMeta(timeZone: env.timeZone, showArea: showArea) }
    private var markLabel: String { task.isDone ? "Erledigt" : task.isFlame ? "Flamme" : "Offen" }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(task.planMark)
                .font(.subheadline)
                .foregroundStyle(task.isDone ? Theme.ok : Theme.text3)
                .frame(width: 22, alignment: .leading)
                .accessibilityLabel(markLabel)
            VStack(alignment: .leading, spacing: 2) {
                ZunderTitle(task: task)
                if !meta.isEmpty {
                    Text(meta)
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                }
            }
            side
        }
        .padding(.vertical, 8)
        .opacity(leaving ? 0.45 : 1)
        .animation(.snappy, value: leaving)
    }

    @ViewBuilder private var side: some View {
        if task.planned == PlanReason.due {
            Text("fällig")
                .font(.footnote)
                .foregroundStyle(Theme.text3)
        } else if !task.isClosed {
            if busy {
                ProgressView()
                    .controlSize(.small)
            } else {
                Button("Aus der Woche") { env.remove(task) }
                    .font(.footnote.weight(.medium))
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(Theme.text2)
                    .accessibilityLabel("Aus der Woche nehmen: \(task.title)")
            }
        }
    }
}
