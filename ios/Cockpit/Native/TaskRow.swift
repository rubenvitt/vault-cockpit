import CockpitShared
import SwiftUI

/// Welche Gruppen das Menü einer Aufgabe zeigt (`taskMenu` in render.js).
enum TaskMenuKind {
    /// Status, Fällig, Phönix.
    case standard
    /// Flamme: statt Phönix „Aus der Woche nehmen“.
    case flame
    /// Zunder-Inbox: dazu „Zuordnen“ und „Verwerfen“.
    case inbox
}

/// Eine Aufgabe wie `taskItem` im Web: Kästchen, Titel (öffnet Zunder), Meta-Zeile,
/// Flammen-Knopf und Menü ⋯. Abhaken ändert die Zeile sofort, der Store sendet danach.
@MainActor
struct TaskRow: View {
    let task: ZunderTask
    let env: WeekEnv
    var meta = ""
    /// „läuft“ hinter der Meta-Zeile.
    var live = false
    /// Flamme starten/stoppen (Flammen und Big Rocks).
    var showsFlame = false
    var menu = TaskMenuKind.standard
    /// Zeichen ohne Schreibrecht statt des Status (🕯️ bei Flammen).
    var readOnlyMark: String?

    @State private var showsMenu = false
    @State private var flameTaps = 0

    private var busy: Bool { env.store.busy.contains(task.id) }
    private var menuHint: String { menu == .inbox ? "Zuordnen, Status, Fälligkeit" : "Status, Fälligkeit" }
    private var flameLabel: String { "\(task.running ? "Flamme stoppen" : "Flamme starten"): \(task.title)" }
    private var writable: Bool { env.can.actions }

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            lead
            VStack(alignment: .leading, spacing: 2) {
                title
                if !meta.isEmpty || live {
                    HStack(spacing: 6) {
                        if !meta.isEmpty {
                            Text(meta)
                                .font(.footnote)
                                .foregroundStyle(task.overdue ? Theme.warn : Theme.text2)
                        }
                        if live { LivePill() }
                    }
                }
            }
            .padding(.top, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            if writable && showsFlame && task.canFlame {
                flameButton
            }
            if writable {
                Button {
                    showsMenu = true
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text3)
                        .frame(width: 40, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mehr zu: \(task.title)")
                .accessibilityHint(menuHint)
            }
        }
        .sensoryFeedback(.selection, trigger: showsMenu) { _, open in open }
        .sheet(isPresented: $showsMenu) {
            TaskMenuSheet(task: task, env: env, kind: menu)
        }
    }

    @ViewBuilder private var lead: some View {
        if writable {
            TickButton(status: task.status, title: task.title, busy: busy) {
                Task { await env.store.toggle(task) }
            }
        } else {
            Text(readOnlyMark ?? task.status.mark)
                .font(.body)
                .foregroundStyle(task.isDone ? Theme.ok : Theme.text3)
                .frame(width: 44, height: 44)
                .accessibilityLabel(task.status.label)
        }
    }

    @ViewBuilder private var title: some View {
        let text = Text(task.title)
            .strikethrough(task.isDone, color: Theme.text3)
            .foregroundStyle(task.isDone ? Theme.text2 : Theme.text)
        if task.link != nil {
            Button {
                env.open(task)
            } label: {
                text
                    .font(.body)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Öffnet die Aufgabe in Zunder")
        } else {
            text.font(.body)
        }
    }

    private var flameButton: some View {
        Button {
            flameTaps += 1
            Task { await env.store.toggleFlame(task) }
        } label: {
            ZStack {
                Circle()
                    .fill(task.running ? Theme.accent : Theme.accentSoft)
                if busy {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(task.running ? Theme.onAccent : Theme.accent)
                } else {
                    Image(systemName: task.running ? "stop.fill" : "flame")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(task.running ? Theme.onAccent : Theme.accent)
                        .symbolEffect(.bounce, value: task.running)
                }
            }
            .frame(width: 30, height: 30)
            .frame(width: 40, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .sensoryFeedback(.impact(weight: .light), trigger: flameTaps)
        .accessibilityLabel(flameLabel)
    }
}

/// Menü ⋯ als Blatt: Zuordnen (Inbox), Status, Fällig mit Datum, Phönix bzw. „Aus der Woche
/// nehmen“. Jede Wahl schließt das Blatt sofort; die Meldung kommt, wenn der Server antwortet.
@MainActor
struct TaskMenuSheet: View {
    let task: ZunderTask
    let env: WeekEnv
    let kind: TaskMenuKind

    @Environment(\.dismiss) private var dismiss
    @State private var date: Date
    @State private var target = ""

    /// Wie `STATUS_CHOICES` in render.js.
    private static let statuses: [TaskStatus] = [.inProgress, .blocked, .open]

    init(task: ZunderTask, env: WeekEnv, kind: TaskMenuKind) {
        self.task = task
        self.env = env
        self.kind = kind
        let day = task.dueDay.isEmpty ? nil : CockpitFormat.day(from: task.dueDay, in: env.timeZone)
        _date = State(initialValue: day ?? Date())
    }

    var body: some View {
        NavigationStack {
            Form {
                if kind == .inbox { assignSection }
                statusSection
                dueSection
                // Wie `taskMenu`: Flammen nehmen statt Phönix „Aus der Woche“, auch unter „Aufgaben“.
                if kind == .flame || task.isFlame {
                    if env.can.plan {
                        Section("Woche") {
                            Button("Aus der Woche nehmen") {
                                run { _ = await env.store.removeFromWeek(task) }
                            }
                        }
                    }
                } else {
                    phoenixSection
                }
            }
            .navigationTitle(task.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    // MARK: Gruppen

    @ViewBuilder private var assignSection: some View {
        Section("Zuordnen") {
            if let targets = env.store.model?.inbox.targets {
                Picker("Bereich oder Projekt", selection: $target) {
                    Text("Bereich oder Projekt …").tag("")
                    ForEach(targets) { area in
                        Section(area.name) {
                            Text(area.name).tag("area:\(area.id)")
                            ForEach(area.projects) { project in
                                Text("\(area.name) / \(project.name)").tag("project:\(project.id)")
                            }
                        }
                    }
                    Text("Lose (ohne Bereich)").tag("loose")
                }
                .pickerStyle(.menu)
                Button("Zuordnen") {
                    guard let destination = Self.destination(target) else { return }
                    run { _ = await env.store.move(task, to: destination) }
                }
                .disabled(target.isEmpty)
            } else {
                ProblemText("Bereiche und Projekte aus Zunder sind gerade nicht abrufbar.")
            }
        }
    }

    private var statusSection: some View {
        Section("Status") {
            ChipRow {
                ForEach(Self.statuses, id: \.self) { status in
                    chip(status.label, current: task.status == status) {
                        run { _ = await env.store.setStatus(task, to: status) }
                    }
                }
                if kind == .inbox {
                    chip("Verwerfen", role: .destructive) {
                        run { _ = await env.store.setStatus(task, to: .dropped) }
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }

    private var dueSection: some View {
        Section {
            HStack {
                DatePicker("Datum", selection: $date, displayedComponents: .date)
                    .environment(\.timeZone, env.timeZone)
                    .environment(\.locale, Locale(identifier: "de_DE"))
                Button("Setzen") {
                    let day = CockpitFormat.dayString(date, in: env.timeZone)
                    run { _ = await env.store.setDue(task, .date(day)) }
                }
                .buttonStyle(.bordered)
            }
            ChipRow {
                chip("Heute") { run { _ = await env.store.setDue(task, .today) } }
                chip("Morgen") { run { _ = await env.store.setDue(task, .tomorrow) } }
                chip("Nächste Woche") { run { _ = await env.store.setDue(task, .nextWeek) } }
                if task.due != nil {
                    chip("Ohne", quiet: true) { run { _ = await env.store.setDue(task, .none) } }
                }
            }
            .padding(.vertical, 4)
        } header: {
            HStack(spacing: 6) {
                Text("Fällig")
                if task.due != nil {
                    Text("jetzt \(CockpitFormat.dueLabel(task.due, timeZone: env.timeZone))")
                        .textCase(nil)
                        .foregroundStyle(Theme.text3)
                }
            }
        }
    }

    private var phoenixSection: some View {
        let step = task.stepWeek
        let isStep = env.store.isStepOfShownWeek(task)
        return Section {
            if isStep {
                Button("Kein Phönix-Schritt") {
                    run { _ = await env.store.togglePhoenix(task) }
                }
                .foregroundStyle(Theme.text2)
            } else if let week = env.store.model?.week {
                Button("Schritt für \(week.label)") {
                    run { _ = await env.store.togglePhoenix(task) }
                }
            }
        } header: {
            HStack(spacing: 6) {
                Text("Phönix")
                if !step.isEmpty {
                    Text("Schritt \(CockpitFormat.weekLabel(step))")
                        .textCase(nil)
                        .foregroundStyle(Theme.text3)
                }
            }
        }
    }

    // MARK: Bausteine

    /// Chip wie `.chip`; der aktuelle Status ist ausgegraut (`aria-current`).
    private func chip(_ label: String, current: Bool = false, quiet: Bool = false, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role, action: action) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 4)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .tint(role == .destructive ? Theme.danger : (quiet ? Theme.text2 : Theme.accent))
        .disabled(current)
        .accessibilityAddTraits(current ? .isSelected : [])
    }

    /// Schließt das Blatt sofort und sendet; die Zeile zeigt solange, dass etwas läuft.
    private func run(_ action: @escaping @MainActor () async -> Void) {
        env.toasts.signal(.selection)
        dismiss()
        Task { await action() }
    }

    static func destination(_ value: String) -> MoveDestination? {
        if value == "loose" { return .loose }
        if value.hasPrefix("area:") { return .area(String(value.dropFirst(5))) }
        if value.hasPrefix("project:") { return .project(String(value.dropFirst(8))) }
        return nil
    }
}
