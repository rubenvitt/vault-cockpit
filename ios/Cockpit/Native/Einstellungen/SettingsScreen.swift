import CockpitShared
import SwiftUI

/// Einstellungen nativ (`/einstellungen` im Web): je Abschnitt eine Zeile mit Zeichen und dem
/// Stand als farbigem Punkt (wie die Navigation im Web), ein Tipp öffnet den Abschnitt
/// (`SettingsSectionScreen`). Darunter „Zustand der Dienste“ und für diese App Server und
/// „Abmelden“ (widerruft den Geräte-Token und löscht die Daten der App auf dem Gerät).
///
/// Zeigt sofort den gespeicherten Stand; beim Laden prüft der Server die Kalender. Braucht einen
/// `NavigationStack` mit `SettingsDestination` (`SettingsTab`) und die Sitzung im Environment.
@MainActor
struct SettingsScreen: View {
    @Environment(CockpitSession.self) private var session
    @Environment(AppModel.self) private var model

    @State private var confirmsLogout = false
    @State private var isLoggingOut = false

    private var store: SettingsStore { session.settings }

    /// Gestörte Dienste: aus dem Zustand, wenn er geladen ist, sonst aus der Woche.
    private var failing: [ServiceAlert] {
        session.health.model != nil ? session.health.failing : session.week.alert
    }

    var body: some View {
        Group {
            if let settings = store.model {
                list(settings)
            } else if let error = store.state.error, !store.state.isRefreshing {
                LoadFailedView(title: "Einstellungen nicht geladen", error: error) {
                    Task { await store.refresh() }
                }
            } else {
                ScrollView {
                    WeekSkeleton(label: "Einstellungen werden geladen")
                        .padding(16)
                }
            }
        }
        .background(Theme.bg)
        .toasts(session.toasts)
        .navigationTitle("Einstellungen")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.state.isRefreshing, store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        .task { await appear() }
        .confirmationDialog("Abmelden?", isPresented: $confirmsLogout, titleVisibility: .visible) {
            Button("Abmelden", role: .destructive) { logout() }
        } message: {
            Text("Widerruft den Geräte-Token dieser App und löscht ihre Daten auf diesem iPhone. Danach meldest du dich neu an.")
        }
    }

    /// Erster Auftritt: gespeicherter Stand und Laden; zurück aus einem Abschnitt nur, wenn der
    /// Stand älter als eine Minute ist (Laden prüft jedes Mal die Kalender).
    private func appear() async {
        if store.model == nil {
            await store.load()
        } else if !store.state.isRefreshing, let updated = store.state.lastUpdated, Date.now.timeIntervalSince(updated) > 60 {
            await store.refresh()
        }
    }

    private func logout() {
        guard !isLoggingOut else { return }
        isLoggingOut = true
        session.toasts.signal(.selection)
        Task {
            await model.logout()
            isLoggingOut = false
        }
    }

    // MARK: Liste

    private func list(_ settings: SettingsModel) -> some View {
        List {
            if showsStatus {
                LoadStatusView(state: store.state, hasModel: true)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
            }
            if let backup = settings.backup, backup.empty {
                Section {
                    NavigationLink(value: SettingsDestination.section(SettingsSection.backup)) {
                        Label("Das Cockpit ist noch leer. Sicherung einspielen?", systemImage: "externaldrive.badge.plus")
                            .foregroundStyle(Theme.accent)
                    }
                }
            }
            Section {
                ForEach(settings.sections) { section in
                    NavigationLink(value: SettingsDestination.section(section.id)) {
                        SettingsSectionRow(section: section, count: count(section, in: settings))
                    }
                }
            } header: {
                Text("Cockpit")
            }
            Section {
                NavigationLink(value: SettingsDestination.health) {
                    HStack(spacing: 12) {
                        SettingsSymbol(name: "waveform.path.ecg", color: failing.isEmpty ? Theme.ok : Theme.danger)
                        Text("Zustand der Dienste")
                            .foregroundStyle(Theme.text)
                        Spacer(minLength: 8)
                        if !failing.isEmpty {
                            SettingsStateDot(color: Theme.danger)
                            Text("Störung")
                                .font(.subheadline)
                                .foregroundStyle(Theme.danger)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityValue(failing.isEmpty ? "" : "Störung: \(failing.map(\.name).joined(separator: ", "))")
                }
            } footer: {
                Text("Sync, Index, Embeddings, Mail, Zunder, Kalender und Feeds: läuft, Fehler, letzter Erfolg.")
            }
            Section {
                HStack(spacing: 12) {
                    SettingsSymbol(name: "server.rack", color: Theme.text2)
                    Text("Server")
                    Spacer(minLength: 8)
                    Text(model.config.serverURL.host() ?? model.config.serverURL.absoluteString)
                        .font(.subheadline.monospaced())
                        .foregroundStyle(Theme.text3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .accessibilityElement(children: .combine)
                Button(role: .destructive) {
                    confirmsLogout = true
                } label: {
                    HStack(spacing: 12) {
                        SettingsSymbol(name: "rectangle.portrait.and.arrow.right", color: Theme.danger)
                        Text("Abmelden")
                            .foregroundStyle(Theme.danger)
                        Spacer(minLength: 8)
                        if isLoggingOut { ProgressView() }
                    }
                }
                .disabled(isLoggingOut)
            } header: {
                Text("Diese App")
            } footer: {
                Text("Abmelden widerruft den Geräte-Token dieser App. Was die Schnelleingabe ohne Netz gepuffert hat, geht nach dem nächsten Login raus.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .refreshable { await store.refresh() }
    }

    /// „Stand von …“ oder ein Fehler beim Neuladen (wie `LoadStatusView`), sonst keine Zeile.
    private var showsStatus: Bool {
        let state = store.state
        if let error = state.error, !error.isOffline, !error.isUnauthorized { return true }
        guard state.isStale, let updated = state.lastUpdated else { return false }
        return !state.isRefreshing || LoadStatusView.isOld(updated)
    }

    /// Zahl rechts: Tokens und Kurzbefehle.
    private func count(_ section: SettingsSection, in settings: SettingsModel) -> Int? {
        switch section.id {
        case SettingsSection.tokens: (session.tokens.model?.tokens ?? settings.tokens)?.count
        case SettingsSection.shortcuts: settings.shortcuts.count
        case SettingsSection.calendars: settings.calendars.items.count
        default: nil
        }
    }
}

/// Zeile eines Abschnitts: Zeichen, Titel, Stand mit Punkt (bzw. Anzahl).
struct SettingsSectionRow: View {
    let section: SettingsSection
    var count: Int?

    var body: some View {
        HStack(spacing: 12) {
            SettingsSymbol(name: Self.symbol(section.id), color: Theme.accent)
            Text(section.title)
                .foregroundStyle(Theme.text)
            Spacer(minLength: 8)
            if let state = section.state {
                Text(state.text)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .lineLimit(1)
                    .truncationMode(.tail)
                SettingsStateDot(color: Self.color(state.tone))
            } else if let count, count > 0 {
                Text("\(count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(Theme.text3)
                    .contentTransition(.numericText(value: Double(count)))
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Zeichen je Abschnitt (SF Symbols).
    static func symbol(_ id: String) -> String {
        switch id {
        case "kalender": "calendar"
        case "zunder": "checklist"
        case "bruecke": "arrow.triangle.2.circlepath"
        case "feuer-notiz": "flame"
        case "mail": "envelope"
        case "lesestapel": "books.vertical"
        case "embeddings": "brain"
        case "vorlesen": "speaker.wave.2"
        case "anzeige": "textformat.size"
        case "anmeldung": "person.badge.key"
        case SettingsSection.tokens: "key"
        case SettingsSection.shortcuts: "square.stack.3d.up"
        case SettingsSection.backup: "externaldrive"
        default: "gearshape"
        }
    }

    /// Farbe des Punkts wie `.dot` im Web: läuft grün, Warnung orange, aus grau.
    static func color(_ tone: SettingsSectionState.Tone) -> Color {
        switch tone {
        case .ok: Theme.ok
        case .warn: Theme.warn
        case .off: Theme.text3
        }
    }
}

/// Punkt für den Stand eines Abschnitts.
struct SettingsStateDot: View {
    let color: Color

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

/// Zeichen links in einer Zeile, in fester Breite (Dynamic Type skaliert mit).
struct SettingsSymbol: View {
    let name: String
    let color: Color
    @ScaledMetric(relativeTo: .body) private var width: CGFloat = 26

    var body: some View {
        Image(systemName: name)
            .foregroundStyle(color)
            .frame(width: width)
            .accessibilityHidden(true)
    }
}
