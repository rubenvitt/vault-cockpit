import CockpitShared
import SwiftUI
import UIKit

/// Ein Abschnitt der Einstellungen: API-Tokens, Kurzbefehle und Sicherung mit eigenem Inhalt,
/// alle anderen als Formular mit den Feldern des Servers (`SettingsFormView`).
@MainActor
struct SettingsSectionScreen: View {
    let sectionID: String

    @Environment(CockpitSession.self) private var session

    var body: some View {
        Group {
            switch sectionID {
            case SettingsSection.tokens:
                SettingsTokensView()
            case SettingsSection.shortcuts:
                SettingsShortcutsView()
            case SettingsSection.backup:
                SettingsBackupView()
            default:
                SettingsFormView(sectionID: sectionID)
            }
        }
        .background(Theme.bg)
        .toasts(session.toasts)
        .navigationTitle(session.settings.model?.section(sectionID)?.title ?? Self.fallbackTitle(sectionID))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Titel, solange nichts geladen ist (Sprung aus einem Link, `/einstellungen#tokens`).
    static func fallbackTitle(_ id: String) -> String {
        switch id {
        case SettingsSection.tokens: "API-Tokens"
        case SettingsSection.shortcuts: "Kurzbefehle"
        case SettingsSection.backup: "Sicherung"
        case SettingsSection.calendars: "Kalender"
        default: "Einstellungen"
        }
    }
}

/// Abschnitt als Formular: Erklärung und Stand, die Felder (Untergruppen aufklappbar), beim
/// Kalender die Liste der Kalender, bei der Anmeldung „Überall abmelden“. „Speichern“ schickt nur
/// diesen Abschnitt; abgelehnte Felder zeigen die Meldung des Servers darunter.
@MainActor
struct SettingsFormView: View {
    let sectionID: String

    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Aufgeklappte Untergruppen (anfangs offen, wenn der Server sie nicht zuklappt).
    @State private var expanded: Set<String> = []
    @State private var calendarDraft: CalendarDraft?
    @State private var removing: CalendarEntry?
    @State private var confirmsSignOut = false

    private var store: SettingsStore { session.settings }

    var body: some View {
        if let settings = store.model, let section = settings.section(sectionID) {
            form(settings, section)
        } else if store.model == nil, let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Einstellungen nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else if store.model == nil {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .task { await store.load() }
        } else {
            ContentUnavailableView {
                Label("Abschnitt nicht gefunden", systemImage: "questionmark.folder")
            } description: {
                Text("Diesen Abschnitt gibt es auf dem Server nicht (mehr).")
            }
        }
    }

    private func isSaving(_ section: SettingsSection) -> Bool {
        store.saving.contains(section.id)
    }

    // MARK: Formular

    private func form(_ settings: SettingsModel, _ section: SettingsSection) -> some View {
        Form {
            if section.intro != nil || section.state != nil {
                Section {
                    SettingsIntro(text: section.intro, state: section.state)
                }
            }
            if section.id == SettingsSection.calendars {
                SettingsCalendarList(
                    calendars: settings.calendars,
                    store: store,
                    onEdit: { draft in calendarDraft = draft },
                    onRemove: { entry in removing = entry }
                )
            }
            ForEach(Array(section.fieldGroups.enumerated()), id: \.offset) { _, group in
                fieldGroup(section, title: group.title, fields: group.fields)
            }
            if !section.fields.isEmpty {
                saveSection(section)
            }
            if section.id == "anmeldung", let signOut = settings.signOutEverywhere {
                Section {
                    Button(role: .destructive) {
                        confirmsSignOut = true
                    } label: {
                        HStack {
                            Text(signOut.label)
                            Spacer()
                            if store.isSigningOut { ProgressView() }
                        }
                    }
                    .disabled(store.isSigningOut)
                } footer: {
                    Text(signOut.text)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.refresh() }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if isSaving(section) {
                    ProgressView()
                        .accessibilityLabel("Speichert")
                } else if store.isDirty(section) {
                    Button("Speichern") { save(section) }
                        .transition(.opacity)
                }
            }
        }
        .animation(reduceMotion ? nil : .snappy, value: store.isDirty(section))
        .confirmationDialog("Überall abmelden?", isPresented: $confirmsSignOut, titleVisibility: .visible) {
            Button(settings.signOutEverywhere?.label ?? "Überall abmelden", role: .destructive) {
                Task { await store.signOutEverywhere() }
            }
        } message: {
            Text(settings.signOutEverywhere?.text ?? "")
        }
        .onAppear {
            if expanded.isEmpty {
                expanded = Set(section.fields.filter { !$0.collapsed }.compactMap(\.group))
            }
        }
        .sheet(item: $calendarDraft) { draft in
            SettingsCalendarEditor(draft: draft, entry: settings.calendars.items.first { $0.index == draft.index && !draft.isNew }, kinds: settings.calendars.kinds, store: store)
        }
        .confirmationDialog(
            "Kalender „\(removing?.name ?? "")“ entfernen?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible,
            presenting: removing
        ) { entry in
            Button("Kalender entfernen", role: .destructive) {
                Task { await store.removeCalendar(entry) }
            }
        } message: { _ in
            Text("Seine Termine erscheinen danach nicht mehr in der Woche.")
        }
    }

    private func save(_ section: SettingsSection) {
        // Meldung „Gespeichert.“ und Haptik kommen vom Store.
        Task { await store.save(section) }
    }

    /// Felder ohne Untergruppe direkt, Untergruppen aufklappbar (wie `<details>` im Web).
    @ViewBuilder
    private func fieldGroup(_ section: SettingsSection, title: String?, fields: [SettingsField]) -> some View {
        if let title {
            Section {
                DisclosureGroup(isExpanded: Binding(
                    get: { expanded.contains(title) || fields.contains { store.error(for: $0.name) != nil } },
                    set: { open in
                        if open { expanded.insert(title) } else { expanded.remove(title) }
                    }
                )) {
                    ForEach(fields) { field in
                        SettingsFieldRow(field: field, store: store)
                    }
                } label: {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.text)
                }
            } footer: {
                if let text = section.groups[title] {
                    Text(text)
                }
            }
        } else {
            Section {
                ForEach(fields) { field in
                    SettingsFieldRow(field: field, store: store)
                }
            } footer: {
                if fields.contains(where: \.isSecret), let hint = store.model?.secretHint {
                    Text(hint)
                }
            }
        }
    }

    /// „Speichern“ und „Verwerfen“ am Ende des Abschnitts (dazu oben rechts in der Leiste).
    private func saveSection(_ section: SettingsSection) -> some View {
        Section {
            Button {
                save(section)
            } label: {
                HStack {
                    Spacer()
                    if isSaving(section) {
                        ProgressView()
                    } else {
                        Text("Speichern")
                            .font(.body.weight(.semibold))
                    }
                    Spacer()
                }
            }
            .disabled(!store.isDirty(section) || isSaving(section))
            if store.isDirty(section) {
                Button("Änderungen verwerfen", role: .destructive) {
                    session.toasts.signal(.selection)
                    withAnimation(reduceMotion ? nil : .snappy) { store.discard(section) }
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// Erklärung eines Abschnitts mit seinem Stand (Punkt und Text).
struct SettingsIntro: View {
    let text: String?
    let state: SettingsSectionState?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let state {
                HStack(spacing: 8) {
                    SettingsStateDot(color: SettingsSectionRow.color(state.tone))
                    Text(state.text)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.text)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Stand: \(state.text)")
            }
            if let text, !text.isEmpty {
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Ein Feld wie im Formular des Webs: Text, Zahl, Liste (mit Komma), Auswahl oder Geheimnis
/// (leer = unverändert, dazu das Häkchen „eigenen … löschen“). Darunter Hinweis und Fehler.
@MainActor
struct SettingsFieldRow: View {
    let field: SettingsField
    let store: SettingsStore

    private var value: Binding<String> {
        Binding(get: { store.value(of: field) }, set: { store.setValue($0, for: field) })
    }

    private var error: String? { store.error(for: field.name) ?? field.clear.flatMap { store.error(for: $0) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch field.kind {
            case .select:
                Picker(field.label, selection: value) {
                    ForEach(field.options) { option in
                        Text(option.label).tag(option.value)
                    }
                }
                .pickerStyle(.menu)
                .tint(Theme.accent)
            case .secret:
                label
                SecureField(field.placeholder.isEmpty ? field.label : field.placeholder, text: value)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
                    .accessibilityLabel(field.label)
                    .accessibilityValue(field.isSet ? "gesetzt" : "nicht gesetzt")
                if field.clear != nil, field.isSet {
                    Toggle(isOn: Binding(get: { store.isCleared(field) }, set: { store.setCleared($0, for: field) })) {
                        Text(field.clearLabel ?? "Eigenen Wert löschen")
                            .font(.subheadline)
                            .foregroundStyle(store.isCleared(field) ? Theme.danger : Theme.text)
                    }
                    .tint(Theme.danger)
                }
            case .text, .number, .list:
                label
                TextField(field.placeholder.isEmpty ? field.label : field.placeholder, text: value, axis: field.kind == .list ? .vertical : .horizontal)
                    .keyboardType(Self.keyboard(for: field))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(field.kind == .list ? 4 : 1)
                    .accessibilityLabel(field.label)
            }
            if let hint = field.hint, !hint.isEmpty {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(Theme.text3)
            }
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .transition(.opacity)
            }
        }
        .padding(.vertical, 2)
    }

    private var label: some View {
        HStack(spacing: 6) {
            Text(field.label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Theme.text)
            if field.isSecret, field.isSet {
                Text(store.isCleared(field) ? "wird gelöscht" : "gesetzt")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(store.isCleared(field) ? Theme.danger : Theme.ok)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(store.isCleared(field) ? Theme.dangerSoft : Theme.okSoft, in: Capsule())
            }
            if store.value(of: field) != (field.isSecret ? "" : field.value) {
                // Geändert, noch nicht gespeichert.
                Circle()
                    .fill(Theme.accent)
                    .frame(width: 6, height: 6)
                    .accessibilityLabel("geändert")
            }
        }
        .accessibilityHidden(true)
    }

    static func keyboard(for field: SettingsField) -> UIKeyboardType {
        if field.kind == .number { return .numberPad }
        if field.name.hasSuffix(".url") { return .URL }
        return .default
    }
}
