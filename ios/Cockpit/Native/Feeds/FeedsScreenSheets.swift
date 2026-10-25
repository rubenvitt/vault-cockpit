import CockpitShared
import SwiftUI
import UIKit

/// „Einstellungen“ eines Feeds (`details.feed-edit` im Web) als Blatt: Adresse, Pausiert, Direkt
/// auf den Stapel, Stichwort-Filter, Abstand in Minuten (5–1440), Gruppe; „Speichern“ oben rechts und
/// „Feed entfernen“ mit Rückfrage. Mit ungespeicherten Änderungen schließt Wischen das Blatt nicht.
@MainActor
struct FeedsScreenFeedSheet: View {
    let store: FeedsStore
    let feed: ReadingFeed
    let toasts: ToastCenter
    /// Entfernen übernimmt die Liste (sofort ausblenden, zurück bei Fehler).
    let remove: (ReadingFeed) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var settings: FeedSettings
    /// Abstand als Text, damit man frei tippen kann; gilt nur innerhalb der Grenzen.
    @State private var interval: String
    @State private var confirmsRemove = false
    @FocusState private var focus: Field?

    enum Field: Hashable { case url, filter, interval }

    init(store: FeedsStore, feed: ReadingFeed, toasts: ToastCenter, remove: @escaping (ReadingFeed) -> Void) {
        self.store = store
        self.feed = feed
        self.toasts = toasts
        self.remove = remove
        _settings = State(initialValue: feed.settings)
        _interval = State(initialValue: String(feed.intervalMinutes))
    }

    /// Grenzen des Servers; wie in `feeds-page.js`, solange nichts geladen ist.
    private var minInterval: Int { store.limits?.minInterval ?? 5 }
    private var maxInterval: Int { store.limits?.maxInterval ?? 1440 }
    private var defaultInterval: Int { store.limits?.defaultInterval ?? 30 }

    private var groups: [FeedGroup] { store.model?.groups ?? [] }
    private var busy: Bool { store.isBusy(.feed(feed.id)) }

    private var minutes: Int? {
        Int(interval.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var intervalValid: Bool {
        guard let minutes else { return false }
        return (minInterval...maxInterval).contains(minutes)
    }

    /// Was gespeichert würde.
    private var edited: FeedSettings {
        var next = settings
        next.filter = settings.filter.trimmingCharacters(in: .whitespacesAndNewlines)
        next.url = settings.url.trimmingCharacters(in: .whitespacesAndNewlines)
        next.intervalMinutes = minutes ?? feed.intervalMinutes
        return next
    }

    private var isDirty: Bool { edited != feed.settings }

    /// Leer ginge nicht: Dann bliebe die alte Adresse, obwohl man sie gelöscht hat.
    private var urlValid: Bool { !edited.url.isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    FeedsScreenFeedHead(feed: feed)
                }
                Section {
                    TextField("https://…", text: $settings.url)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($focus, equals: .url)
                        .accessibilityLabel("Adresse")
                } header: {
                    Text("Adresse")
                } footer: {
                    Text("Feed oder Website; wird beim Speichern geprüft.")
                        .foregroundStyle(urlValid ? Theme.text3 : Theme.danger)
                }
                Section {
                    Toggle(isOn: $settings.paused) {
                        Label("Pausiert", systemImage: "pause.circle")
                    }
                    Toggle(isOn: $settings.toStack) {
                        Label("Direkt auf den Stapel", systemImage: "square.stack")
                    }
                } footer: {
                    if let note = groupNote {
                        Text(note)
                    }
                }
                Section {
                    TextField("leer = alles", text: $settings.filter)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($focus, equals: .filter)
                        .accessibilityLabel("Stichwort-Filter")
                } header: {
                    Text("Stichwort-Filter")
                } footer: {
                    Text("Durch Komma getrennt; ein Begriff im Titel oder Text genügt.")
                }
                Section {
                    Stepper {
                        HStack(spacing: 6) {
                            Text("alle")
                                .foregroundStyle(Theme.text2)
                            TextField("\(defaultInterval)", text: $interval)
                                .keyboardType(.numberPad)
                                .multilineTextAlignment(.trailing)
                                .monospacedDigit()
                                .focused($focus, equals: .interval)
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
                    Text("Abstand in Minuten")
                } footer: {
                    Text("\(minInterval) bis \(maxInterval) Minuten (\(maxInterval / 60) Stunden).")
                        .foregroundStyle(intervalValid ? Theme.text3 : Theme.danger)
                }
                if !groups.isEmpty {
                    Section {
                        Picker("Gruppe", selection: groupBinding) {
                            Text("ohne Gruppe").tag("")
                            ForEach(groups) { group in
                                Text(group.name).tag(group.id)
                            }
                        }
                    }
                }
                Section {
                    Button(role: .destructive) {
                        toasts.signal(.selection)
                        confirmsRemove = true
                    } label: {
                        Label("Feed entfernen", systemImage: "trash")
                            .foregroundStyle(Theme.danger)
                    }
                    .disabled(busy)
                } footer: {
                    Text("Gespeicherte Artikel bleiben.")
                }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle("Einstellungen")
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
                        Button("Speichern", action: save)
                            .fontWeight(.semibold)
                            .disabled(!isDirty || !intervalValid || !urlValid)
                    }
                }
            }
            .confirmationDialog("Feed entfernen?", isPresented: $confirmsRemove, titleVisibility: .visible) {
                Button("Entfernen", role: .destructive) {
                    dismiss()
                    remove(feed)
                }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("„\(feed.title)“ wird nicht mehr abgerufen. Gespeicherte Artikel bleiben.")
            }
            .toasts(toasts)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isDirty || busy)
        .animation(.snappy, value: intervalValid)
    }

    /// Was die Gruppe zusätzlich vorgibt.
    private var groupNote: String? {
        let parts = [feed.groupPaused ? "pausiert" : nil, feed.groupToStack ? "direkt auf den Stapel" : nil].compactMap { $0 }
        return parts.isEmpty ? nil : "Die Gruppe ist \(parts.joined(separator: " und ")); das gilt zusätzlich."
    }

    private var groupBinding: Binding<String> {
        Binding(
            get: { settings.groupId ?? "" },
            set: { settings.groupId = $0.isEmpty ? nil : $0 }
        )
    }

    /// Plus und Minus springen durch übliche Abstände; getippte Werte dazwischen gehen auch.
    private func step(up: Bool) {
        let presets = Self.presets.filter { (minInterval...maxInterval).contains($0) }
        let current = min(maxInterval, max(minInterval, minutes ?? feed.intervalMinutes))
        let next = up ? presets.first { $0 > current } ?? maxInterval : presets.last { $0 < current } ?? minInterval
        guard next != minutes else { return }
        toasts.signal(.selection)
        interval = String(next)
    }

    static let presets = [5, 10, 15, 30, 45, 60, 120, 180, 360, 720, 1440]

    private func save() {
        guard isDirty, intervalValid, urlValid, !busy else { return }
        focus = nil
        let next = edited
        Task {
            if await store.update(feed, next) {
                toasts.signal(.success)
                dismiss()
            }
        }
    }
}

/// Kopf des Blatts: Icon, Titel, Feed-Adresse, Stand, „Website öffnen“.
struct FeedsScreenFeedHead: View {
    let feed: ReadingFeed

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                FeedsScreenIcon(feed: feed, size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    Text(feed.title)
                        .font(.headline)
                        .foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(feed.url)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Image(systemName: FeedsScreenFeedRow.symbol(feed.state))
                    .font(.caption.weight(.semibold))
                    .accessibilityHidden(true)
                Text(feed.status)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(FeedsScreenFeedRow.tint(feed.state))
            if let link = feed.siteLink {
                Button {
                    ExternalLink.open(link)
                } label: {
                    Label("Website öffnen", systemImage: "safari")
                        .font(.subheadline.weight(.medium))
                }
                .buttonStyle(.borderless)
                .tint(Theme.accent)
            }
        }
        .padding(.vertical, 4)
    }
}

/// „Gruppe bearbeiten“ als Blatt: Name, Pausiert, Direkt auf den Stapel (gilt für alle Feeds der
/// Gruppe), „Nach oben“ / „Nach unten“ (sofort) und „Gruppe löschen“ mit Rückfrage.
@MainActor
struct FeedsScreenGroupSheet: View {
    let store: FeedsStore
    let group: FeedGroup
    let toasts: ToastCenter
    /// Löschen übernimmt die Liste (sofort ausblenden, zurück bei Fehler).
    let remove: (FeedGroup) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var paused: Bool
    @State private var toStack: Bool
    @State private var confirmsDelete = false

    init(store: FeedsStore, group: FeedGroup, toasts: ToastCenter, remove: @escaping (FeedGroup) -> Void) {
        self.store = store
        self.group = group
        self.toasts = toasts
        self.remove = remove
        _name = State(initialValue: group.name)
        _paused = State(initialValue: group.paused)
        _toStack = State(initialValue: group.toStack)
    }

    /// Die Gruppe im aktuellen Stand (Reihenfolge ändert sich beim Verschieben).
    private var current: FeedGroup {
        store.model?.groups.first { $0.id == group.id } ?? group
    }

    private var position: Int? {
        store.model?.groups.firstIndex { $0.id == group.id }
    }

    private var busy: Bool { store.isBusy(.group(group.id)) }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var isDirty: Bool { trimmedName != current.name || paused != current.paused || toStack != current.toStack }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .submitLabel(.done)
                        .onSubmit(save)
                        .accessibilityLabel("Name der Gruppe")
                } header: {
                    Text("Name")
                }
                Section {
                    Toggle(isOn: $paused) {
                        Label("Pausiert", systemImage: "pause.circle")
                    }
                    Toggle(isOn: $toStack) {
                        Label("Direkt auf den Stapel", systemImage: "square.stack")
                    }
                } footer: {
                    Text("Gilt für alle Feeds der Gruppe, zusätzlich zu deren eigener Einstellung.")
                }
                Section {
                    Button {
                        move(up: true)
                    } label: {
                        Label("Nach oben", systemImage: "arrow.up")
                    }
                    .disabled(!current.canMoveUp || busy)
                    Button {
                        move(up: false)
                    } label: {
                        Label("Nach unten", systemImage: "arrow.down")
                    }
                    .disabled(!current.canMoveDown || busy)
                } header: {
                    Text("Reihenfolge")
                } footer: {
                    if let position, let count = store.model?.groups.count {
                        Text("Platz \(position + 1) von \(count)")
                            .contentTransition(.numericText(value: Double(position)))
                    }
                }
                Section {
                    Button(role: .destructive) {
                        toasts.signal(.selection)
                        confirmsDelete = true
                    } label: {
                        Label("Gruppe löschen", systemImage: "trash")
                            .foregroundStyle(Theme.danger)
                    }
                    .disabled(busy)
                } footer: {
                    Text("Die Feeds bleiben, dann ohne Gruppe.")
                }
            }
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle("Gruppe bearbeiten")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy && isDirty {
                        ProgressView()
                            .accessibilityLabel("Wird gespeichert")
                    } else {
                        Button("Speichern", action: save)
                            .fontWeight(.semibold)
                            .disabled(!isDirty || trimmedName.isEmpty || busy)
                    }
                }
            }
            .confirmationDialog("Gruppe löschen?", isPresented: $confirmsDelete, titleVisibility: .visible) {
                Button("Gruppe löschen", role: .destructive) {
                    dismiss()
                    remove(current)
                }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("„\(current.name)“ ist danach weg. Die Feeds bleiben, dann ohne Gruppe.")
            }
            .toasts(toasts)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isDirty)
        .animation(.snappy, value: position)
    }

    private func move(up: Bool) {
        Task { await store.moveGroup(current, up: up) }
    }

    private func save() {
        guard isDirty, !trimmedName.isEmpty, !busy else { return }
        Task {
            if await store.updateGroup(current, name: trimmedName, paused: paused, toStack: toStack) {
                toasts.signal(.success)
                dismiss()
            }
        }
    }
}
