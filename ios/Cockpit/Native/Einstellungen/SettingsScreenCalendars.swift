import CockpitShared
import SwiftUI

/// Kalender im Abschnitt „Kalender“: je Kalender Name, Art und Host mit dem Ergebnis der Prüfung
/// („✓ 3 Termine diese Woche“ oder der Fehler); Tipp bearbeitet, Wischen entfernt. Dazu
/// „＋ Neuer Kalender“ (höchstens 20) und „Prüfen“ (lädt neu, der Server ruft jeden Kalender ab).
@MainActor
struct SettingsCalendarList: View {
    let calendars: CalendarSettings
    let store: SettingsStore
    let onEdit: (CalendarDraft) -> Void
    let onRemove: (CalendarEntry) -> Void

    @Environment(CockpitSession.self) private var session

    var body: some View {
        Section {
            if calendars.items.isEmpty {
                Text("Noch kein Kalender eingerichtet.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
            }
            ForEach(calendars.items) { entry in
                Button {
                    session.toasts.signal(.selection)
                    onEdit(store.calendarDraft(for: entry))
                } label: {
                    SettingsCalendarRow(entry: entry, saving: store.saving.contains("cal.\(entry.index)"))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Bearbeiten")
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        onRemove(entry)
                    } label: {
                        Label("Entfernen", systemImage: "trash")
                    }
                }
                .contextMenu {
                    Button {
                        onEdit(store.calendarDraft(for: entry))
                    } label: {
                        Label("Bearbeiten", systemImage: "pencil")
                    }
                    Button(role: .destructive) {
                        onRemove(entry)
                    } label: {
                        Label("Kalender entfernen", systemImage: "trash")
                    }
                }
            }
            if calendars.canAdd {
                Button {
                    session.toasts.signal(.selection)
                    if let draft = store.newCalendarDraft() { onEdit(draft) }
                } label: {
                    Label("Neuer Kalender", systemImage: "plus.circle.fill")
                        .foregroundStyle(Theme.accent)
                }
            } else {
                Text("Höchstens \(calendars.max) Kalender.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
        } header: {
            HStack {
                Text("Kalender")
                Spacer()
                Button {
                    session.toasts.signal(.selection)
                    Task { await store.checkCalendars() }
                } label: {
                    if store.state.isRefreshing {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Label("Prüfen", systemImage: "arrow.clockwise")
                            .labelStyle(.titleAndIcon)
                    }
                }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.borderless)
                .tint(Theme.accent)
                .disabled(store.state.isRefreshing)
                .accessibilityLabel("Kalender prüfen")
            }
        } footer: {
            Text("iCal-Abos (Outlook, Google) und CalDAV (Fastmail, iCloud). Adresse und Passwort zeigt das Cockpit nie wieder an; leer lassen heißt unverändert.")
        }
    }
}

/// Zeile eines Kalenders.
struct SettingsCalendarRow: View {
    let entry: CalendarEntry
    let saving: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            SettingsSymbol(name: entry.isCalDAV ? "server.rack" : "link", color: Theme.text2)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.name.isEmpty ? "Ohne Namen" : entry.name)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.text)
                Text(CockpitFormat.meta([entry.kindLabel, entry.host, entry.auth ? "mit Anmeldung" : nil]))
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                if let check = entry.check {
                    SettingsCheckPill(check: check)
                }
            }
            Spacer(minLength: 0)
            if saving {
                ProgressView()
            } else {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Ergebnis der Prüfung eines Kalenders.
struct SettingsCheckPill: View {
    let check: CalendarCheck

    var body: some View {
        Label(check.text, systemImage: check.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
            .font(.caption.weight(.medium))
            .foregroundStyle(check.ok ? Theme.ok : Theme.danger)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(check.ok ? Theme.okSoft : Theme.dangerSoft, in: Capsule())
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Kalender anlegen oder bearbeiten: Name, Art (iCal-Abo, CalDAV), Adresse (leer = unverändert),
/// „Mit Anmeldung“ (nur iCal; CalDAV meldet sich immer an), Benutzer, Passwort (leer =
/// unverändert), „Nur diese Kalender“ (nur CalDAV). Das Blatt bleibt offen, bis der Server
/// bestätigt; abgelehnte Felder zeigen die Meldung darunter.
@MainActor
struct SettingsCalendarEditor: View {
    let entry: CalendarEntry?
    let kinds: [SettingsOption]
    let store: SettingsStore

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft: CalendarDraft
    @State private var confirmsRemove = false
    @FocusState private var focused: Bool

    init(draft: CalendarDraft, entry: CalendarEntry?, kinds: [SettingsOption], store: SettingsStore) {
        self.entry = entry
        self.kinds = kinds
        self.store = store
        _draft = State(initialValue: draft)
    }

    private var saving: Bool { store.saving.contains("cal.\(draft.index)") }
    private var canSave: Bool {
        !draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (!draft.isNew || !draft.url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    field("Name", key: "name") {
                        TextField("z. B. Privat", text: $draft.name)
                            .focused($focused)
                    }
                    Picker("Art", selection: $draft.kind) {
                        ForEach(kinds) { kind in
                            Text(kind.label).tag(kind.value)
                        }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel("Art")
                }
                Section {
                    field("Adresse", key: "url") {
                        TextField(entry?.address ?? (draft.isCalDAV ? "https://caldav.example.com/" : "https://…/kalender.ics"), text: $draft.url)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                } footer: {
                    Text(entry == nil ? (draft.isCalDAV ? "Adresse des CalDAV-Servers." : "Adresse des Abos (.ics, webcal:// geht auch).") : "Leer lassen: Die gespeicherte Adresse bleibt.")
                }
                Section {
                    if !draft.isCalDAV {
                        Toggle(isOn: $draft.auth.animation(reduceMotion ? nil : .snappy)) {
                            Text("Mit Anmeldung")
                        }
                        .tint(Theme.accent)
                    }
                    if draft.usesLogin {
                        field("Benutzer", key: "username") {
                            TextField("Benutzer", text: $draft.username)
                                .textContentType(.username)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        field("Passwort", key: "password") {
                            SecureField(entry?.passwordSet == true ? "gesetzt (leer lassen = unverändert)" : "App-Passwort", text: $draft.password)
                                .textContentType(.password)
                        }
                    }
                } footer: {
                    if draft.usesLogin {
                        Text(draft.isCalDAV ? "CalDAV meldet sich immer an, am besten mit einem App-Passwort." : "Für Abos, die Benutzer und Passwort verlangen.")
                    }
                }
                if draft.isCalDAV {
                    Section {
                        field("Nur diese Kalender", key: "filter") {
                            TextField("alle", text: $draft.filter)
                                .autocorrectionDisabled()
                        }
                    } footer: {
                        Text("Namen der Kalender auf dem Server, durch Komma getrennt; leer = alle.")
                    }
                }
                if let entry {
                    Section {
                        if let check = entry.check {
                            SettingsCheckPill(check: check)
                        }
                        Button("Kalender entfernen", role: .destructive) {
                            confirmsRemove = true
                        }
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(draft.isNew ? "Neuer Kalender" : (entry?.name ?? "Kalender"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(draft.isNew ? "Anlegen" : "Sichern") {
                            Task {
                                if await store.saveCalendar(draft) { dismiss() }
                            }
                        }
                        .disabled(!canSave)
                    }
                }
            }
            .animation(reduceMotion ? nil : .snappy, value: draft.kind)
            .confirmationDialog("Kalender entfernen?", isPresented: $confirmsRemove, titleVisibility: .visible) {
                Button("Kalender entfernen", role: .destructive) {
                    guard let entry else { return }
                    Task {
                        if await store.removeCalendar(entry) { dismiss() }
                    }
                }
            } message: {
                Text("Seine Termine erscheinen danach nicht mehr in der Woche.")
            }
            .onAppear { if draft.isNew { focused = true } }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
    }

    /// Feld mit Beschriftung und Fehler des Servers (`cal.N.key`).
    private func field<Content: View>(_ label: String, key: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.text)
                .accessibilityHidden(true)
            content()
                .accessibilityLabel(label)
            if let error = store.error(for: draft.fieldName(key)) {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
        .padding(.vertical, 2)
    }
}
