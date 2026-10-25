import CockpitShared
import SwiftUI

/// Hinweis unter der Unternavigation, solange im Puffer des Lesens etwas wartet (wie die Leiste
/// „n Einträge warten“ aus offline.js): antippen zeigt die Liste.
@MainActor
struct LesenPufferBanner: View {
    let buffer: ReadingBuffer
    let toasts: ToastCenter
    @State private var showsList = false

    var body: some View {
        if !buffer.entries.isEmpty {
            Button {
                toasts.signal(.selection)
                showsList = true
            } label: {
                HStack(spacing: 8) {
                    if buffer.isFlushing {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: buffer.failedCount > 0 ? "exclamationmark.icloud" : "icloud.and.arrow.up")
                            .accessibilityHidden(true)
                    }
                    Text(buffer.summary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .accessibilityHidden(true)
                }
                .font(.footnote)
                .foregroundStyle(buffer.failedCount > 0 ? Theme.danger : Theme.warn)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(buffer.failedCount > 0 ? Theme.dangerSoft : Theme.warnSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .accessibilityHint("Zeigt, was noch gesendet werden muss")
            .transition(.opacity.combined(with: .move(edge: .top)))
            .sheet(isPresented: $showsList) {
                LesenPufferSheet(buffer: buffer)
            }
        }
    }
}

/// Puffer des Lesens: jeder Eintrag mit Zeit, abgelehnte mit Grund; „Jetzt senden“ bzw.
/// „Erneut senden“ und „Verwerfen“ wie die Liste in offline.js.
@MainActor
struct LesenPufferSheet: View {
    let buffer: ReadingBuffer

    @Environment(\.dismiss) private var dismiss
    @State private var discarding: ReadingOutbox.Entry?

    private var flushTitle: String { buffer.failedCount > 0 ? "Erneut senden" : "Jetzt senden" }

    var body: some View {
        NavigationStack {
            List {
                if buffer.loginNeeded {
                    Section {
                        Text("Die Anmeldung ist abgelaufen. Nach dem Anmelden geht der Puffer von selbst raus. Nichts geht verloren.")
                            .font(.subheadline)
                    }
                }
                Section {
                    ForEach(buffer.entries) { entry in
                        row(entry)
                    }
                } footer: {
                    Text(buffer.summary)
                }
            }
            .navigationTitle("Puffer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Fertig") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if buffer.isFlushing {
                        ProgressView()
                    } else {
                        Button(flushTitle) {
                            Task { await buffer.flush(retry: true) }
                        }
                        .disabled(!buffer.isOnline)
                    }
                }
            }
            .confirmationDialog("Eintrag verwerfen?", isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } }), titleVisibility: .visible, presenting: discarding) { entry in
                Button("Verwerfen", role: .destructive) { buffer.discard(entry) }
            } message: { _ in
                Text("Der Eintrag wird nicht gesendet.")
            }
            .onChange(of: buffer.entries.isEmpty) { _, empty in
                if empty { dismiss() }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ entry: ReadingOutbox.Entry) -> some View {
        let state = entry.error.map { " · Nicht gesendet: \($0)" } ?? " · wartet"
        return VStack(alignment: .leading, spacing: 6) {
            Text(entry.label)
                .font(.subheadline)
                .foregroundStyle(Theme.text)
            Text("\(CockpitFormat.savedAt(entry.created))\(state)")
                .font(.footnote)
                .foregroundStyle(entry.error == nil ? Theme.text2 : Theme.danger)
            Button("Verwerfen", role: .destructive) { discarding = entry }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .font(.footnote.weight(.medium))
        }
        .padding(.vertical, 4)
    }
}
