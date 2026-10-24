import CockpitShared
import SwiftUI

/// Alle Abschnitte der Woche in der Reihenfolge des Webs (`renderWeek`).
@MainActor
struct WeekSections: View {
    let week: WeekModel
    let env: WeekEnv

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let burning = week.burning, env.can.actions {
                BurningBar(task: burning, env: env)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            FeuerSection(week: week, env: env)
            FlamesSection(week: week, env: env)
            RocksSection(week: week, env: env)
            CalendarSection(week: week, env: env)
            TasksSection(week: week, env: env)
            InboxSection(week: week, env: env)
        }
        .animation(.snappy, value: week.burning?.id)
    }
}

/// Liste von Aufgaben mit Trennlinien; neue und verschwundene gleiten ein und aus.
@MainActor
struct TaskList: View {
    let tasks: [ZunderTask]
    let env: WeekEnv
    var showArea = false
    var showsFlame = false
    var menu = TaskMenuKind.standard

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            ForEach(tasks) { task in
                TaskRow(
                    task: task,
                    env: env,
                    meta: CockpitFormat.meta([task.ref, showArea ? task.area : task.project, CockpitFormat.dueLabel(task.due, timeZone: env.timeZone)]),
                    live: task.running,
                    showsFlame: showsFlame,
                    menu: menu
                )
                .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .top).combined(with: .opacity))
                if task.id != tasks.last?.id {
                    Divider().padding(.leading, 44)
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: tasks.map(\.id))
    }
}

// MARK: Laufende Flamme

/// Leiste oben, solange irgendwo eine Flamme brennt: Zeit läuft mit, Stopp mit einem Tipp.
@MainActor
struct BurningBar: View {
    let task: ZunderTask
    let env: WeekEnv

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var busy: Bool { env.store.busy.contains(task.id) }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "flame.fill")
                .font(.title3)
                .foregroundStyle(Theme.accent)
                .symbolEffect(.pulse, isActive: !reduceMotion)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Flamme läuft")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                Button {
                    env.open(task)
                } label: {
                    Text(task.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.text)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 8)
            timer
            Button {
                Task { await env.store.stopBurning() }
            } label: {
                if busy {
                    ProgressView().tint(Theme.onAccent)
                } else {
                    Label("Stopp", systemImage: "stop.fill")
                        .font(.subheadline.weight(.semibold))
                }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .tint(Theme.accent)
            .disabled(busy)
            .sensoryFeedback(.impact(weight: .medium), trigger: busy) { _, now in now }
        }
        .padding(12)
        .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(Theme.accentLine)
        }
        .accessibilityElement(children: .contain)
    }

    /// Zähler wie in cockpit.js („04:05“, ab einer Stunde „1:04:05“); ohne Startzeit „läuft“.
    @ViewBuilder private var timer: some View {
        if let start = task.startedDate {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(CockpitFormat.elapsed(since: start, now: context.date))
                    .font(.subheadline.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Theme.accent)
            }
            .accessibilityLabel("seit \(CockpitFormat.time(start, timeZone: env.timeZone))")
        } else {
            Text("läuft")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.accent)
        }
    }
}

// MARK: Feuer und Flammen

@MainActor
struct FeuerSection: View {
    let week: WeekModel
    let env: WeekEnv

    @State private var editing: FeuerEdit?
    @State private var creating = false

    private var editable: Bool { env.can.notes && env.can.actions }

    var body: some View {
        CardSection("Feuer-Ziel") {
            switch week.feuer {
            case .failed(let error):
                ProblemText(error, onSettings: { env.openSettings() })
            case .ok(.none):
                EmptyText("Für diese Woche gibt es keine Feuer-Notiz.")
                if env.store.canCreateFeuer && env.can.actions {
                    Button {
                        creating = true
                    } label: {
                        Label("Feuer anlegen", systemImage: "plus")
                            .font(.subheadline.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .tint(Theme.accent)
                }
            case .ok(.some(let feuer)):
                note(feuer)
            }
        }
        .sheet(item: $editing) { edit in
            FeuerEditSheet(edit: edit, store: env.store)
        }
        .sheet(isPresented: $creating) {
            FeuerCreateSheet(store: env.store)
        }
        .sensoryFeedback(.selection, trigger: editing?.id) { _, now in now != nil }
    }

    @ViewBuilder private func note(_ feuer: Feuer) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Group {
                if let goal = feuer.goal {
                    Self.markdown(goal)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Theme.text)
                } else {
                    Text("Die Notiz hat keinen Abschnitt „Feuer-Ziel“.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
            if editable {
                pencil("Feuer-Ziel bearbeiten") { editing = FeuerEdit(field: .goal, text: feuer.goal ?? "") }
            }
        }
        if feuer.firstMove != nil || editable {
            HStack(alignment: .top, spacing: 8) {
                Group {
                    if let move = feuer.firstMove {
                        Text("Erster Zug ").font(.subheadline.weight(.semibold)).foregroundColor(Theme.text2)
                            + Self.markdown(move).font(.subheadline).foregroundColor(Theme.text)
                    } else {
                        Text("Erster Zug ").font(.subheadline.weight(.semibold)).foregroundColor(Theme.text2)
                            + Text("noch keiner").font(.subheadline).foregroundColor(Theme.text3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                if editable {
                    pencil("Erster Zug bearbeiten") { editing = FeuerEdit(field: .firstMove, text: feuer.firstMove ?? "") }
                }
            }
        }
        meta(feuer)
    }

    /// „Alignment: … · Notiztitel“, der Titel öffnet die Notiz in Obsidian.
    @ViewBuilder private func meta(_ feuer: Feuer) -> some View {
        let link = CockpitFormat.obsidianURL(path: feuer.path, vault: week.vaultName)
        HStack(spacing: 4) {
            if let alignment = feuer.alignment, !alignment.isEmpty {
                Text("Alignment: \(alignment) ·")
            }
            if let link {
                Button(feuer.title) { ExternalLink.open(link) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.accent)
                    .accessibilityHint("Öffnet die Notiz in Obsidian")
            } else {
                Text(feuer.title)
            }
        }
        .font(.footnote)
        .foregroundStyle(Theme.text2)
        .lineLimit(2)
    }

    private func pencil(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "pencil")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.text3)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    /// Das bisschen Markdown aus Feuer-Zielen (fett, kursiv, Code), Wikilinks als Text.
    static func markdown(_ md: String) -> Text {
        let source = CockpitFormat.inlineMarkdown(md)
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let attributed = try? AttributedString(markdown: source, options: options) {
            return Text(attributed)
        }
        return Text(source)
    }
}

@MainActor
struct FlamesSection: View {
    let week: WeekModel
    let env: WeekEnv

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        CardSection("Flammen", link: env.can.plan ? SectionLink(label: "Einplanen", action: { env.plan(flame: true) }) : nil) {
            switch week.flames {
            case .failed(let error):
                ProblemText(error, onSettings: { env.openSettings() })
            case .ok(let flames) where flames.isEmpty:
                EmptyText("Keine Flammen geplant.")
            case .ok(let flames):
                VStack(spacing: 0) {
                    ForEach(flames) { flame in
                        TaskRow(
                            task: flame,
                            env: env,
                            meta: CockpitFormat.meta([CockpitFormat.dueLabel(flame.due, timeZone: env.timeZone), Self.measured(flame)]),
                            live: flame.running,
                            showsFlame: true,
                            menu: .flame,
                            readOnlyMark: flame.isDone ? "✓" : "🕯️"
                        )
                        .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .top).combined(with: .opacity))
                        if flame.id != flames.last?.id {
                            Divider().padding(.leading, 44)
                        }
                    }
                }
                .animation(.snappy, value: flames.map(\.id))
            }
        }
    }

    /// „90 min“ bei beendeten, gemessenen Flammen.
    static func measured(_ flame: ZunderTask) -> String? {
        guard !flame.running, let minutes = flame.minutes else { return nil }
        return "\(minutes) min"
    }
}

// MARK: Big Rocks

@MainActor
struct RocksSection: View {
    let week: WeekModel
    let env: WeekEnv

    var body: some View {
        CardSection("Big Rocks", link: env.can.plan ? SectionLink(label: "Woche planen", action: { env.plan() }) : nil) {
            switch week.rocks {
            case .failed(let error):
                ProblemText(error, onSettings: { env.openSettings() })
            case .ok(let rocks):
                if rocks.groups.isEmpty {
                    EmptyText("Diese Woche ist nichts fällig und kein Phönix-Schritt markiert.")
                } else {
                    VStack(spacing: 12) {
                        ForEach(rocks.groups) { group in
                            RockCard(group: group, env: env)
                        }
                    }
                }
                if rocks.partial {
                    ProblemText("Nicht alle Zunder-Abfragen haben geantwortet; die Liste ist unvollständig.")
                }
            }
        }
    }
}

/// Karte eines Lebensbereichs: Zähler und Fortschritt folgen dem Abhaken sofort.
@MainActor
struct RockCard: View {
    let group: RockGroup
    let env: WeekEnv

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(group.area)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Text("\(group.done)/\(group.tasks.count)")
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .foregroundStyle(group.allDone ? Theme.ok : Theme.text2)
                    .contentTransition(.numericText(value: Double(group.done)))
                    .accessibilityLabel("\(group.done) von \(group.tasks.count) erledigt")
            }
            ProgressView(value: Double(group.done), total: Double(max(group.tasks.count, 1)))
                .tint(group.allDone ? Theme.ok : Theme.accent)
                .accessibilityHidden(true)
            TaskList(tasks: group.tasks, env: env, showsFlame: true)
        }
        .padding(12)
        .background(group.allDone ? Theme.okSoft : Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .animation(.snappy, value: group.done)
    }
}

// MARK: Termine

@MainActor
struct CalendarSection: View {
    let week: WeekModel
    let env: WeekEnv

    var body: some View {
        CardSection("Termine", hint: week.calendar.value?.todayHint) {
            switch week.calendar {
            case .failed(let error):
                ProblemText(error, onSettings: { env.openSettings() })
            case .ok(let calendar):
                ForEach(calendar.errors, id: \.calendar) { failure in
                    ProblemText("\(failure.calendar): \(failure.error)")
                }
                VStack(spacing: 6) {
                    ForEach(calendar.days) { day in
                        DayView(day: day, past: calendar.isPast(day), timeZone: env.timeZone)
                    }
                }
            }
        }
    }
}

/// Ein Tag: heute hervorgehoben, vergangene Tage der laufenden Woche eingeklappt mit Zahl.
@MainActor
struct DayView: View {
    let day: CalendarDay
    let past: Bool
    let timeZone: TimeZone

    @State private var expanded = false

    var body: some View {
        Group {
            if past {
                DisclosureGroup(isExpanded: $expanded) {
                    events
                } label: {
                    HStack(spacing: 8) {
                        Text(day.label).font(.subheadline.weight(.semibold))
                        if !day.events.isEmpty {
                            Text(CockpitFormat.events(day.events.count)).font(.footnote)
                        }
                    }
                    .foregroundStyle(Theme.text3)
                }
                .tint(Theme.text3)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(day.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(day.today ? Theme.accent : Theme.text)
                        if day.today {
                            Text("heute")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.onAccent)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Theme.accent, in: Capsule())
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                    events
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(day.today ? Theme.accentSoft : Color.clear, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }

    /// `HH:MM`; ganztägige Termine ohne Uhrzeit.
    private func time(of event: CalendarEvent) -> String {
        guard !event.allDay, let start = event.startDate else { return "" }
        return CockpitFormat.time(start, timeZone: timeZone)
    }

    @ViewBuilder private var events: some View {
        if day.events.isEmpty {
            EmptyText("frei")
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(day.events) { event in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(time(of: event))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(Theme.text2)
                            .frame(width: 44, alignment: .leading)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(event.title)
                                .font(.subheadline)
                                .foregroundStyle(Theme.text)
                            if let location = event.location, !location.isEmpty {
                                Text(location)
                                    .font(.footnote)
                                    .foregroundStyle(Theme.text2)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

// MARK: Aufgaben und Inbox

@MainActor
struct TasksSection: View {
    let week: WeekModel
    let env: WeekEnv

    var body: some View {
        CardSection("Aufgaben", hint: "in Arbeit und überfällig", badge: week.tasks.value?.count) {
            switch week.tasks {
            case .failed(let error):
                ProblemText(error, onSettings: { env.openSettings() })
            case .ok(let tasks) where tasks.isEmpty:
                EmptyText("Nichts in Arbeit, nichts überfällig.")
            case .ok(let tasks):
                TaskList(tasks: tasks, env: env, showArea: true)
            }
        }
    }
}

@MainActor
struct InboxSection: View {
    let week: WeekModel
    let env: WeekEnv

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        CardSection("Inbox", badge: week.inbox.count) {
            HStack(spacing: 6) {
                Text("Vault").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text2)
                if let folder = week.inbox.folder {
                    Text("\(folder)/").font(.footnote).foregroundStyle(Theme.text3)
                }
            }
            switch week.inbox.vault {
            case .failed(let error):
                ProblemText(error, onSettings: { env.openSettings() })
            case .ok(let notes) where notes.isEmpty:
                EmptyText("Leer.")
            case .ok(let notes):
                VStack(spacing: 0) {
                    ForEach(notes) { note in
                        noteRow(note)
                            .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .top).combined(with: .opacity))
                        if note.id != notes.last?.id { Divider() }
                    }
                }
                .animation(.snappy, value: notes.map(\.id))
            }
            Text("Zunder")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.text2)
                .padding(.top, 6)
            switch week.inbox.zunder {
            case .failed(let error):
                ProblemText(error, onSettings: { env.openSettings() })
            case .ok(let tasks) where tasks.isEmpty:
                EmptyText("Leer.")
            case .ok(let tasks):
                TaskList(tasks: tasks, env: env, menu: .inbox)
            }
        }
    }

    /// Mit Notiz-Vorschau öffnet der Titel die Notiz im Cockpit, Obsidian bleibt daneben;
    /// sonst ist der Titel der Obsidian-Link.
    private func noteRow(_ note: InboxNote) -> some View {
        let obsidian = CockpitFormat.obsidianURL(path: note.path, vault: week.vaultName)
        let notes = env.can.notes
        let hint = notes ? "Öffnet die Notiz" : "Öffnet die Notiz in Obsidian"
        return HStack(spacing: 8) {
            Button {
                if notes {
                    env.model.open(path: CockpitFormat.notePath(note.path))
                } else if let obsidian {
                    ExternalLink.open(obsidian)
                }
            } label: {
                Text(note.title)
                    .font(.body)
                    .foregroundStyle(notes || obsidian != nil ? Theme.text : Theme.text2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!notes && obsidian == nil)
            .accessibilityHint(hint)
            if notes, let obsidian {
                Button("Obsidian") { ExternalLink.open(obsidian) }
                    .font(.footnote.weight(.medium))
                    .buttonStyle(.borderless)
                    .foregroundStyle(Theme.accent)
                    .accessibilityLabel("In Obsidian öffnen: \(note.title)")
            }
        }
    }
}
