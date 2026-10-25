import CockpitShared
import SwiftUI

/// Schnelleingabe unten auf der Woche (`captureBar`): wächst beim Tippen, `!` vorne macht eine
/// Zunder-Aufgabe daraus, Return sendet. Darunter die Vorschau, darüber der Puffer ohne Netz.
@MainActor
struct CaptureBar: View {
    @Bindable var store: CaptureStore
    let model: AppModel
    var focused: FocusState<Bool>.Binding

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shake: CGFloat = 0
    @State private var showsOutbox = false
    @State private var lastSubmit = Date.distantPast

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !store.entries.isEmpty {
                outboxRow
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            HStack(alignment: .bottom, spacing: 8) {
                field
                sendButton
            }
            if let preview = store.preview {
                Text(preview.line)
                    .font(.caption)
                    .foregroundStyle(Theme.text2)
                    .lineLimit(3)
                    .padding(.horizontal, 12)
                    .transition(.opacity)
                    .accessibilityLabel("Vorschau: \(preview.line)")
            } else if focused.wrappedValue && store.text.isEmpty {
                // Der lange Platzhalter passte auf dem iPhone nicht in eine Zeile; der Hinweis steht darunter.
                Text("Mit ! vorne wird es eine Zunder-Aufgabe")
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
                    .padding(.horizontal, 12)
                    .transition(.opacity)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .animation(.snappy, value: store.preview?.line)
        .animation(.snappy, value: focused.wrappedValue)
        .animation(.snappy, value: store.entries.count)
        .onChange(of: store.nudge) { _, _ in
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 0.3)) { shake += 1 }
        }
        .sensoryFeedback(.warning, trigger: store.nudge)
        .sheet(isPresented: $showsOutbox) {
            OutboxSheet(store: store, model: model, focused: focused)
        }
    }

    private var field: some View {
        // Mitte statt Grundlinie: Mit dem mitwachsenden Feld meldete die Grundlinie die falsche
        // Zeile, das Kästchen stand über dem Text.
        HStack(alignment: .center, spacing: 8) {
            Text(store.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(store.isTask ? Theme.onAccent : Theme.text2)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(store.isTask ? Theme.accent : Theme.bgSunk, in: Capsule())
                .fixedSize()
                .contentTransition(.opacity)
                .accessibilityHidden(true)
            TextField("Gedanke festhalten …", text: $store.text, axis: .vertical)
                .font(.body)
                .lineLimit(1...6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .focused(focused)
                .submitLabel(.send)
                .onSubmit { send() }
                .onChange(of: store.text) { old, new in
                    returnTyped(old, new)
                }
                .accessibilityLabel("Schnelleingabe, \(store.label)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        // So hoch wie der Senden-Knopf, solange es eine Zeile ist.
        .frame(minHeight: 44)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(store.isTask ? Theme.accent : Theme.lineStrong, lineWidth: store.isTask ? 1.5 : 1)
        }
        .modifier(ShakeEffect(animatableData: shake))
        .animation(.snappy, value: store.isTask)
    }

    private var sendButton: some View {
        Button {
            send()
        } label: {
            ZStack {
                Circle().fill(Theme.accent)
                if store.isSending {
                    ProgressView().tint(Theme.onAccent)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.body.weight(.bold))
                        .foregroundStyle(Theme.onAccent)
                }
            }
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(store.isSending)
        // Wie `.capture-label` auf dem iPhone: sichtbar nur das Symbol, vorgelesen „Notiz anlegen“ bzw. „Aufgabe anlegen“.
        .accessibilityLabel(store.buttonTitle)
    }

    /// „2 Einträge warten auf Netz · 1 nicht gesendet“ mit „Jetzt senden“ bzw. „Erneut senden“.
    private var outboxRow: some View {
        HStack(spacing: 8) {
            Button {
                showsOutbox = true
            } label: {
                Label(store.outboxSummary, systemImage: store.failedCount > 0 ? "exclamationmark.icloud" : "icloud.and.arrow.up")
                    .font(.footnote)
                    .foregroundStyle(store.failedCount > 0 ? Theme.danger : Theme.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Zeigt die wartenden Einträge")
            if store.isFlushing {
                ProgressView().controlSize(.small)
            } else {
                Button(store.flushTitle) {
                    Task { await store.flush(retry: true) }
                }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.accent)
            }
        }
    }

    /// Return auf der Bildschirmtastatur fügt in einem mitwachsenden Feld einen Zeilenumbruch
    /// ein; wie Enter im Web sendet er stattdessen.
    private func returnTyped(_ old: String, _ new: String) {
        guard new.count == old.count + 1,
              new.filter({ $0 == "\n" }).count == old.filter({ $0 == "\n" }).count + 1
        else { return }
        store.text = old
        send()
    }

    private func send() {
        // `onSubmit` und der Zeilenumbruch können für denselben Tipp kommen.
        guard Date.now.timeIntervalSince(lastSubmit) > 0.3 else { return }
        lastSubmit = .now
        Task { await store.submit() }
    }
}

extension CaptureStore {
    /// „Jetzt senden“, mit abgelehnten Einträgen „Erneut senden“.
    var flushTitle: String { failedCount > 0 ? "Erneut senden" : "Jetzt senden" }
}

/// Puffer der Schnelleingabe (wie `.puffer` in offline.js): jeder Eintrag mit Art und Zeit,
/// abgelehnte mit Grund und „Ins Feld“, alle mit „Verwerfen“.
@MainActor
struct OutboxSheet: View {
    let store: CaptureStore
    let model: AppModel
    var focused: FocusState<Bool>.Binding

    @Environment(\.dismiss) private var dismiss
    @State private var discarding: CaptureOutbox.Entry?
    @State private var replacing: CaptureOutbox.Entry?

    var body: some View {
        NavigationStack {
            List {
                if store.loginNeeded {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Die Anmeldung ist abgelaufen. Nach dem Anmelden geht der Puffer von selbst raus. Nichts geht verloren.")
                                .font(.subheadline)
                            Button("Neu anmelden") {
                                dismiss()
                                model.sessionExpired(next: "/")
                            }
                        }
                    }
                }
                Section {
                    ForEach(store.entries) { entry in
                        row(entry)
                    }
                } footer: {
                    Text(store.outboxSummary)
                }
            }
            .navigationTitle("Puffer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fertig") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if store.isFlushing {
                        ProgressView()
                    } else {
                        Button(store.flushTitle) {
                            Task { await store.flush(retry: true) }
                        }
                    }
                }
            }
            .confirmationDialog(discardTitle, isPresented: isPresented($discarding), titleVisibility: .visible, presenting: discarding) { entry in
                Button("Verwerfen", role: .destructive) { store.discard(entry) }
            } message: { _ in
                Text("Der Eintrag wird nicht gesendet.")
            }
            .confirmationDialog("Im Feld steht schon Text. Ersetzen?", isPresented: isPresented($replacing), titleVisibility: .visible, presenting: replacing) { entry in
                Button("Ersetzen", role: .destructive) { backToField(entry) }
            }
            .onChange(of: store.entries.isEmpty) { _, empty in
                if empty { dismiss() }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var discardTitle: String {
        "\(discarding?.kind ?? "Eintrag") verwerfen?"
    }

    private func row(_ entry: CaptureOutbox.Entry) -> some View {
        let text = entry.text.count > 280 ? "\(entry.text.prefix(279))…" : entry.text
        let state = entry.error.map { " · Nicht gesendet: \($0)" } ?? " · wartet"
        let meta = "\(entry.kind) · erfasst \(CockpitFormat.savedAt(entry.created))\(state)"
        return VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(Theme.text)
            Text(meta)
                .font(.footnote)
                .foregroundStyle(entry.error == nil ? Theme.text2 : Theme.danger)
            HStack(spacing: 12) {
                // Zurück ins Feld nur, was der Server abgelehnt hat: Das ist sicher nicht angekommen.
                if entry.error != nil {
                    Button("Ins Feld") {
                        if store.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            backToField(entry)
                        } else {
                            replacing = entry
                        }
                    }
                    .buttonStyle(.bordered)
                }
                Button("Verwerfen", role: .destructive) { discarding = entry }
                    .buttonStyle(.bordered)
            }
            .font(.footnote.weight(.medium))
            .buttonBorderShape(.capsule)
        }
        .padding(.vertical, 4)
    }

    private func backToField(_ entry: CaptureOutbox.Entry) {
        store.backToField(entry)
        dismiss()
        focused.wrappedValue = true
    }

    /// Bindung „Dialog offen“ für einen optionalen Eintrag.
    private func isPresented(_ entry: Binding<CaptureOutbox.Entry?>) -> Binding<Bool> {
        Binding(get: { entry.wrappedValue != nil }, set: { if !$0 { entry.wrappedValue = nil } })
    }
}
