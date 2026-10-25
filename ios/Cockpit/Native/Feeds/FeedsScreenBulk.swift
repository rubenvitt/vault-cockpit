import CockpitShared
import SwiftUI

// Sammeln (VCP-110, „Feeds gesammelt bearbeiten“ im Web): Suche und „Nur mit Fehlern“ über der
// Liste, Häkchen an den Feeds im Auswahlmodus und die Leiste unten mit den Aktionen für alle
// abgehakten Feeds (src/lesen/feeds-page.js, `bulkBar`; src/web/static/lesen-feeds.js).

/// Überblick („4 Feeds · 1 pausiert · 2 mit Fehlern“), Suche über Titel, Host und Gruppe und
/// „Nur mit Fehlern“ (nur, wenn es Feeds mit Fehlern gibt); beim Filtern „n Feeds gefunden“.
@MainActor
struct FeedsScreenFilterBar: View {
    let store: FeedsStore
    let toasts: ToastCenter

    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var query: Binding<String> {
        Binding(get: { store.filter.query }, set: { store.filter.query = $0 })
    }

    private var failing: Int { store.model?.failingCount ?? 0 }
    private var onlyFailing: Bool { store.filter.onlyFailing }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(store.model?.summary ?? "")
                .font(.footnote)
                .foregroundStyle(Theme.text3)
                .contentTransition(.numericText())
            searchField
            if failing > 0 || onlyFailing {
                failingChip
                    .transition(.opacity)
            }
            if store.filter.isActive {
                Text(FeedFilter.hits(store.visibleFeeds.count))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(store.visibleFeeds.isEmpty ? Theme.warn : Theme.text2)
                    .contentTransition(.numericText())
                    .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .snappy, value: store.filter)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Theme.text3)
                .accessibilityHidden(true)
            TextField("Feeds durchsuchen", text: query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($focused)
                .onSubmit { focused = false }
                .accessibilityLabel("Feeds durchsuchen")
            if !store.filter.query.isEmpty {
                Button {
                    store.filter.query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Theme.text3)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Suche leeren")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .strokeBorder(focused ? Theme.accentLine : Theme.line)
        }
    }

    /// „Nur mit Fehlern“ als Schalter-Kapsel.
    private var failingChip: some View {
        Button {
            toasts.signal(.selection)
            store.filter.onlyFailing.toggle()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: onlyFailing ? "checkmark.circle.fill" : "exclamationmark.triangle")
                    .contentTransition(.symbolEffect(.replace))
                    .accessibilityHidden(true)
                Text("Nur mit Fehlern")
                Text("\(failing)")
                    .monospacedDigit()
                    .foregroundStyle(onlyFailing ? Theme.accent : Theme.text3)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(onlyFailing ? Theme.accent : Theme.text2)
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(onlyFailing ? Theme.accentSoft : Theme.surface, in: Capsule())
            .overlay { Capsule().strokeBorder(onlyFailing ? Theme.accentLine : Theme.line) }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Nur mit Fehlern")
        .accessibilityValue(onlyFailing ? "an" : "aus")
        .accessibilityAddTraits(onlyFailing ? .isSelected : [])
    }
}

/// Häkchen eines Feeds im Auswahlmodus.
struct FeedsScreenCheckmark: View {
    let selected: Bool

    var body: some View {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.title3)
            .foregroundStyle(selected ? Theme.accent : Theme.text3)
            .contentTransition(.symbolEffect(.replace))
            .frame(width: 28, height: 30)
            .accessibilityHidden(true)
    }
}

/// Leiste unten im Auswahlmodus: „Alle auswählen“ / „Keine auswählen“, „n Feeds abgehakt“ und
/// das Menü mit den Aktionen (`ACTIONS` im Web).
@MainActor
struct FeedsScreenBulkBar: View {
    let store: FeedsStore
    let toasts: ToastCenter
    /// Pausieren, Fortsetzen, Stapel an/aus: sofort.
    let apply: (FeedBulkAction) -> Void
    let move: () -> Void
    let interval: () -> Void
    let remove: () -> Void

    private var count: Int { store.selectedCount }
    private var busy: Bool { store.isBusy(.bulk) }

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(Theme.line)
                .frame(height: 1)
            HStack(spacing: 12) {
                pickAll
                Spacer(minLength: 4)
                Text(store.selectionText)
                    .font(.subheadline.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(count > 0 ? Theme.text : Theme.text3)
                    .contentTransition(.numericText(value: Double(count)))
                    .animation(.snappy, value: count)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                actions
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Abgehakte Feeds bearbeiten")
    }

    private var pickAll: some View {
        let all = store.allVisibleSelected
        return Button(all ? "Keine auswählen" : "Alle auswählen") {
            toasts.signal(.selection)
            withAnimation(.snappy) {
                if all { store.selectNone() } else { store.selectAllVisible() }
            }
        }
        .font(.subheadline)
        .tint(Theme.accent)
        .disabled(busy || (store.visibleFeeds.isEmpty && count == 0))
        .accessibilityLabel(all ? "Keine auswählen" : "Alle sichtbaren auswählen")
    }

    private var actions: some View {
        Menu {
            Button(action: move) {
                Label("In Gruppe verschieben …", systemImage: "folder")
            }
            Section {
                Button {
                    apply(.pause)
                } label: {
                    Label("Pausieren", systemImage: "pause")
                }
                Button {
                    apply(.resume)
                } label: {
                    Label("Fortsetzen", systemImage: "play")
                }
            }
            Section {
                Button {
                    apply(.stackOn)
                } label: {
                    Label("Direkt auf den Stapel", systemImage: "square.stack")
                }
                Button {
                    apply(.stackOff)
                } label: {
                    Label("In den Eingang", systemImage: "tray")
                }
            }
            Button(action: interval) {
                Label("Abstand ändern …", systemImage: "clock.arrow.circlepath")
            }
            Divider()
            Button(role: .destructive, action: remove) {
                Label("Entfernen …", systemImage: "trash")
            }
        } label: {
            HStack(spacing: 6) {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Theme.onAccent)
                }
                Text("Aktionen")
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, 14)
            .frame(minHeight: 36)
            .background(count > 0 && !busy ? Theme.accent : Theme.text3, in: Capsule())
            .contentShape(Capsule())
        }
        .disabled(count == 0 || busy)
        .accessibilityLabel("Aktionen für \(FeedFilter.feedsWord(count))")
    }
}

/// „In Gruppe verschieben …“: vorhandene Gruppe, „ohne Gruppe“ oder „Neue Gruppe …“ mit Namen.
@MainActor
struct FeedsScreenBulkMoveSheet: View {
    let store: FeedsStore
    let toasts: ToastCenter
    /// Nach dem Verschieben (Auswahlmodus beenden).
    let done: () -> Void

    /// Wahl im Blatt; die neue Gruppe übersetzt `FeedBulkAction.pairs` in `ziel`/`neu`.
    enum Choice: Hashable {
        case ungrouped
        case group(String)
        case new
    }

    @Environment(\.dismiss) private var dismiss
    @State private var choice: Choice?
    @State private var name = ""
    @FocusState private var nameFocused: Bool

    private var groups: [FeedGroup] { store.model?.groups ?? [] }
    private var busy: Bool { store.isBusy(.bulk) }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Ohne Wahl die erste Gruppe, ohne Gruppen „Neue Gruppe …“.
    private var current: Choice { choice ?? groups.first.map { .group($0.id) } ?? .new }
    private var canSave: Bool { !busy && store.selectedCount > 0 && (current != .new || !trimmedName.isEmpty) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    option(.ungrouped, title: "ohne Gruppe", systemImage: "tray")
                    ForEach(groups) { group in
                        option(.group(group.id), title: group.name, systemImage: "folder")
                    }
                    option(.new, title: "Neue Gruppe …", systemImage: "folder.badge.plus")
                } header: {
                    Text(FeedFilter.feedsWord(store.selectedCount))
                } footer: {
                    Text("Pausieren und „direkt auf den Stapel“ der Gruppe gelten dann auch für diese Feeds.")
                }
                if current == .new {
                    Section {
                        TextField("Name der neuen Gruppe", text: $name)
                            .submitLabel(.done)
                            .focused($nameFocused)
                            .onSubmit(save)
                            .accessibilityLabel("Name der neuen Gruppe")
                    } header: {
                        Text("Neue Gruppe")
                    }
                    .transition(.opacity)
                }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle("In Gruppe verschieben")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                            .accessibilityLabel("Wird verschoben")
                    } else {
                        Button("Verschieben", action: save)
                            .fontWeight(.semibold)
                            .disabled(!canSave)
                    }
                }
            }
            .toasts(toasts)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
        .animation(.snappy, value: current)
    }

    private func option(_ value: Choice, title: String, systemImage: String) -> some View {
        let selected = current == value
        return Button {
            toasts.signal(.selection)
            choice = value
            nameFocused = value == .new
        } label: {
            HStack(spacing: 12) {
                Label(title, systemImage: systemImage)
                    .foregroundStyle(Theme.text)
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .transition(.scale.combined(with: .opacity))
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func save() {
        guard canSave else { return }
        nameFocused = false
        let target: FeedBulkTarget
        switch current {
        case .ungrouped: target = .ungrouped
        case .group(let id): target = .group(id)
        case .new: target = .newGroup(trimmedName)
        }
        Task {
            if await store.applyBulk(.move(target)) {
                dismiss()
                done()
            }
        }
    }
}

/// „Abstand ändern …“: Minuten für alle abgehakten Feeds (Grenzen vom Server, 5–1440).
@MainActor
struct FeedsScreenBulkIntervalSheet: View {
    let store: FeedsStore
    let toasts: ToastCenter
    let done: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var interval: String
    @FocusState private var focused: Bool

    init(store: FeedsStore, toasts: ToastCenter, done: @escaping () -> Void) {
        self.store = store
        self.toasts = toasts
        self.done = done
        // Gemeinsamer Abstand der abgehakten Feeds, sonst der übliche.
        let minutes = Set(store.selectedFeeds.map(\.intervalMinutes))
        let start = minutes.count == 1 ? minutes.first : nil
        _interval = State(initialValue: String(start ?? store.limits?.defaultInterval ?? 30))
    }

    private var minInterval: Int { store.limits?.minInterval ?? 5 }
    private var maxInterval: Int { store.limits?.maxInterval ?? 1440 }
    private var busy: Bool { store.isBusy(.bulk) }
    private var minutes: Int? { Int(interval.trimmingCharacters(in: .whitespacesAndNewlines)) }

    private var valid: Bool {
        guard let minutes else { return false }
        return (minInterval...maxInterval).contains(minutes)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Stepper {
                        HStack(spacing: 6) {
                            Text("alle")
                                .foregroundStyle(Theme.text2)
                            TextField("\(store.limits?.defaultInterval ?? 30)", text: $interval)
                                .keyboardType(.numberPad)
                                .multilineTextAlignment(.trailing)
                                .monospacedDigit()
                                .focused($focused)
                                .frame(maxWidth: 72)
                                .accessibilityLabel("Abstand in Minuten")
                            Text("min")
                                .foregroundStyle(Theme.text2)
                        }
                    } onIncrement: {
                        step(up: true)
                    } onDecrement: {
                        step(up: false)
                    }
                    .accessibilityValue(minutes.map { "\($0) Minuten" } ?? "ungültig")
                } header: {
                    Text("Abstand für \(FeedFilter.feedsWord(store.selectedCount))")
                } footer: {
                    Text("\(minInterval) bis \(maxInterval) Minuten (\(maxInterval / 60) Stunden).")
                        .foregroundStyle(valid ? Theme.text3 : Theme.danger)
                }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle("Abstand ändern")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                            .accessibilityLabel("Wird gespeichert")
                    } else {
                        Button("Ändern", action: save)
                            .fontWeight(.semibold)
                            .disabled(!valid || store.selectedCount == 0)
                    }
                }
            }
            .toasts(toasts)
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(busy)
        .animation(.snappy, value: valid)
    }

    /// Plus und Minus springen durch übliche Abstände wie in den Einstellungen eines Feeds.
    private func step(up: Bool) {
        let presets = FeedsScreenFeedSheet.presets.filter { (minInterval...maxInterval).contains($0) }
        let current = min(maxInterval, max(minInterval, minutes ?? store.limits?.defaultInterval ?? 30))
        let next = up ? presets.first { $0 > current } ?? maxInterval : presets.last { $0 < current } ?? minInterval
        guard next != minutes else { return }
        toasts.signal(.selection)
        interval = String(next)
    }

    private func save() {
        guard valid, let minutes, !busy else { return }
        focused = false
        Task {
            if await store.applyBulk(.interval(minutes)) {
                dismiss()
                done()
            }
        }
    }
}
