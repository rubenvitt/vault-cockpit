import CockpitShared
import SwiftUI

/// Listen unter dem Graphen (`.graph-lists` im Web): Verlinkt von hier, Verweist hierher, Ähnlich,
/// nicht verlinkt (mit Ähnlichkeit und Verlinken), Aufgaben (Status, Kennung, „aus …“) und bei
/// Tagesnotizen die Termine. Ein Tipp auf eine Notiz macht sie zur Mitte.
@MainActor
struct GraphScreenLists: View {
    let model: GraphModel
    /// Pfade, deren Verlinken gerade läuft.
    let linking: Set<String>
    /// Neue Mitte (Pfad, Titel).
    let recenter: (String, String) -> Void
    let openNote: (String) -> Void
    let openURL: (URL) -> Void
    let link: (String) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var lists: GraphLists { model.lists }

    var body: some View {
        VStack(spacing: 12) {
            CardSection("Verlinkt von hier", badge: lists.outgoing.count) {
                notes(lists.outgoing, empty: "Keine ausgehenden Links.")
            }
            CardSection("Verweist hierher", badge: lists.incoming.count) {
                notes(lists.incoming, empty: "Keine Backlinks.")
            }
            CardSection("Ähnlich, nicht verlinkt", badge: lists.similar.count) {
                if lists.similar.isEmpty {
                    EmptyText("Keine Vorschläge.")
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(lists.similar) { note in
                            GraphScreenNoteRow(note: note, canOpenNote: model.can.notes, recenter: recenter, openNote: openNote) {
                                HStack(spacing: 8) {
                                    if let score = note.score {
                                        Text(Self.percent(score))
                                            .font(.footnote.monospacedDigit())
                                            .foregroundStyle(Theme.accent)
                                            .accessibilityLabel("ähnlich \(Self.percent(score))")
                                    }
                                    if model.can.link {
                                        GraphScreenChip(label: "Verlinken", busy: linking.contains(note.path)) { link(note.path) }
                                            .accessibilityHint("Hängt einen Link auf diese Notiz an \(model.label) an")
                                    }
                                }
                            }
                            .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .trailing).combined(with: .opacity))
                        }
                    }
                }
            }
            CardSection("Aufgaben", badge: lists.tasks.count) {
                if lists.tasks.isEmpty {
                    EmptyText("Keine Zunder-Links.")
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(lists.tasks) { task in
                            GraphScreenTaskRow(task: task, openURL: openURL)
                        }
                    }
                }
            }
            if !lists.events.isEmpty {
                CardSection("Termine", badge: lists.events.count) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(lists.events.enumerated()), id: \.offset) { _, event in
                            GraphScreenEventRow(event: event)
                        }
                    }
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: lists.similar.map(\.path))
    }

    @ViewBuilder
    private func notes(_ notes: [GraphNoteRef], empty: String) -> some View {
        if notes.isEmpty {
            EmptyText(empty)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(notes) { note in
                    GraphScreenNoteRow(note: note, canOpenNote: model.can.notes, recenter: recenter, openNote: openNote) {
                        EmptyView()
                    }
                }
            }
        }
    }

    /// „73 %“
    static func percent(_ score: Double) -> String {
        "\(Int((score * 100).rounded())) %"
    }

    /// „09:30“ in der Zeitzone des Geräts.
    static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}

/// Notiz in einer Liste: Titel und Pfad; Tipp macht sie zur Mitte, lange drücken bietet die
/// Notizseite an. `trailing`: Ähnlichkeit und Verlinken.
@MainActor
struct GraphScreenNoteRow<Trailing: View>: View {
    let note: GraphNoteRef
    let canOpenNote: Bool
    let recenter: (String, String) -> Void
    let openNote: (String) -> Void
    let trailing: Trailing

    init(note: GraphNoteRef, canOpenNote: Bool, recenter: @escaping (String, String) -> Void, openNote: @escaping (String) -> Void, @ViewBuilder trailing: () -> Trailing) {
        self.note = note
        self.canOpenNote = canOpenNote
        self.recenter = recenter
        self.openNote = openNote
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Button {
                recenter(note.path, note.label)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(note.label)
                        .font(.body)
                        .foregroundStyle(Theme.text)
                        .multilineTextAlignment(.leading)
                    Text(note.path)
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Macht die Notiz zur Mitte des Graphen")
            .contextMenu {
                Button {
                    recenter(note.path, note.label)
                } label: {
                    Label("Zur Mitte", systemImage: "scope")
                }
                if canOpenNote {
                    Button {
                        openNote(note.path)
                    } label: {
                        Label("Notiz ansehen", systemImage: "doc.text")
                    }
                }
            }
            trailing
        }
    }
}

/// Aufgabe aus einem Zunder-Link: Zeichen für den Status, Titel (öffnet Zunder), Kennung und
/// „aus Notiz“, wenn der Link aus einer Nachbarnotiz stammt.
@MainActor
struct GraphScreenTaskRow: View {
    let task: GraphTaskRef
    let openURL: (URL) -> Void

    private var closed: Bool { task.status == .done || task.status == .dropped }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(task.mark)
                .font(.body.monospaced())
                .foregroundStyle(task.status == .done ? Theme.ok : task.status == .blocked ? Theme.warn : Theme.text3)
                .frame(minWidth: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                if let url = task.link {
                    Button {
                        openURL(url)
                    } label: {
                        Text(task.label)
                            .strikethrough(closed)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(closed ? Theme.text3 : Theme.accent)
                    .accessibilityHint("Öffnet die Aufgabe in Zunder")
                } else {
                    Text(task.label)
                        .strikethrough(closed)
                        .foregroundStyle(closed ? Theme.text3 : Theme.text)
                }
                if !meta.isEmpty {
                    Text(meta)
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                }
            }
            .font(.body)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(GraphScreenStatus.text(task.status))
    }

    private var meta: String {
        [task.ref, task.from.map { "aus \($0)" }].compactMap { $0 }.joined(separator: " · ")
    }
}

/// Status einer Aufgabe in Worten (wie die Karte im Graphen).
enum GraphScreenStatus {
    static func text(_ status: TaskStatus) -> String {
        switch status {
        case .done: "erledigt"
        case .inProgress: "in Arbeit"
        case .blocked: "blockiert"
        case .review: "in Review"
        case .dropped: "verworfen"
        default: "offen"
        }
    }
}

/// Termin einer Tagesnotiz: Uhrzeit (ganztägige ohne) und Titel.
@MainActor
struct GraphScreenEventRow: View {
    let event: GraphEventRef

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(time)
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(Theme.text2)
                .frame(minWidth: 54, alignment: .leading)
            Text(event.label)
                .font(.body)
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }

    private var time: String {
        if event.allDay { return "ganztägig" }
        guard let start = event.startDate else { return "" }
        return GraphScreenLists.clock(start)
    }
}
