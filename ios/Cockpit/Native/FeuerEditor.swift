import CockpitShared
import SwiftUI

/// Abschnitt der Feuer-Notiz, der gerade bearbeitet wird (für `sheet(item:)`).
struct FeuerEdit: Identifiable {
    let field: FeuerField
    let text: String
    var id: String { field.rawValue }
}

/// Stift an Feuer-Ziel und Erstem Zug (`feuerEdit`): Text bearbeiten, in die Feuer-Notiz speichern.
/// Das Blatt bleibt offen, bis der Server bestätigt; bei Fehler bleibt der Text stehen.
@MainActor
struct FeuerEditSheet: View {
    let edit: FeuerEdit
    let store: WeekStore

    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @FocusState private var focused: Bool

    init(edit: FeuerEdit, store: WeekStore) {
        self.edit = edit
        self.store = store
        _text = State(initialValue: edit.text)
    }

    private var saving: Bool { store.busy.contains("feuer-\(edit.field.rawValue)") }
    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .focused($focused)
                        .frame(minHeight: edit.field == .goal ? 120 : 80)
                        .accessibilityLabel(edit.field.title)
                } footer: {
                    Text("\(text.count) / \(WeekStore.feuerLimit) Zeichen")
                        .monospacedDigit()
                        .foregroundStyle(text.count > WeekStore.feuerLimit ? Theme.danger : Theme.text3)
                }
            }
            .navigationTitle(edit.field.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Speichern") {
                            Task {
                                if await store.saveFeuer(edit.field, text: text) { dismiss() }
                            }
                        }
                        .disabled(empty || text.count > WeekStore.feuerLimit)
                    }
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(saving)
    }
}

/// „＋ Feuer anlegen“ (`feuerCreate`): Feuer-Ziel ist Pflicht, der Erste Zug kann später kommen.
@MainActor
struct FeuerCreateSheet: View {
    let store: WeekStore

    @Environment(\.dismiss) private var dismiss
    @State private var goal = ""
    @State private var firstMove = ""

    private var saving: Bool { store.busy.contains("feuer-anlegen") }

    var body: some View {
        NavigationStack {
            Form {
                Section("Feuer-Ziel") {
                    TextEditor(text: $goal)
                        .frame(minHeight: 100)
                        .accessibilityLabel("Feuer-Ziel")
                }
                Section {
                    TextEditor(text: $firstMove)
                        .frame(minHeight: 70)
                        .accessibilityLabel("Erster Zug (optional)")
                } header: {
                    HStack(spacing: 4) {
                        Text("Erster Zug")
                        Text("(optional)").textCase(nil).foregroundStyle(Theme.text3)
                    }
                }
            }
            .navigationTitle("Feuer anlegen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Anlegen") {
                            Task {
                                if await store.createFeuer(goal: String(goal.prefix(WeekStore.feuerLimit)), firstMove: String(firstMove.prefix(WeekStore.feuerLimit))) { dismiss() }
                            }
                        }
                        .disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(saving)
    }
}
