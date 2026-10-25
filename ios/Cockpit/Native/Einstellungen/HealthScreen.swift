import CockpitShared
import SwiftUI

/// Zustand der Dienste nativ (`/zustand` im Web): oben „Stand …“ und die Übersicht („Alle
/// eingerichteten Dienste laufen.“ oder die gestörten Dienste, ein Tipp springt zur Karte),
/// darunter je Dienst eine Karte mit Pille (läuft, Fehler, aus, unbekannt), Zusammenfassung,
/// Angaben, „Letzter Erfolg“, Fehlerkasten (rot, solange er gilt, sonst grau) und je Kalender
/// bzw. Teil der Brücke eine Unterliste.
///
/// „Neu prüfen“ (oder Ziehen) lädt neu; der Server prüft Zunder und Kalender dabei frisch. Zeigt
/// sofort den gespeicherten Stand. Braucht einen `NavigationStack` und die Sitzung im Environment.
@MainActor
struct HealthScreen: View {
    @Environment(CockpitSession.self) private var session
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var store: HealthStore { session.health }
    /// Zeitzone des Cockpits (aus der Woche), sonst die des Geräts.
    private var timeZone: TimeZone { session.week.model?.timeZone ?? .current }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    LoadStatusView(state: store.state, hasModel: store.model != nil)
                    content(proxy)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 24)
                .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: store.model)
            }
        }
        .background(Theme.bg)
        .refreshable { await store.recheck() }
        .toasts(session.toasts)
        .navigationTitle("Zustand")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.isChecking, store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Prüft")
                } else {
                    Button {
                        session.toasts.signal(.selection)
                        Task { await store.recheck() }
                    } label: {
                        Label("Neu prüfen", systemImage: "arrow.clockwise")
                    }
                    .accessibilityHint("Prüft Zunder und die Kalender frisch")
                }
            }
        }
        .sensoryFeedback(trigger: store.model?.checkedAt) { old, new in
            // Nach „Neu prüfen“: Erfolg, wenn alles läuft, sonst Warnung.
            guard old != nil, new != nil, old != new else { return nil }
            return store.failing.isEmpty ? .success : .warning
        }
        .task { await appear() }
    }

    /// Erster Auftritt: gespeicherter Stand und Laden; danach (zurück zum Bildschirm) frisch prüfen.
    private func appear() async {
        if store.model == nil {
            await store.load()
        } else if !store.isChecking {
            await store.recheck()
        }
    }

    // MARK: Inhalt

    @ViewBuilder
    private func content(_ proxy: ScrollViewProxy) -> some View {
        if let health = store.model {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(alignment: .leading, spacing: 14) {
                    head(health, proxy: proxy)
                    ForEach(health.services) { service in
                        HealthServiceCard(service: service, timeZone: timeZone, now: context.date)
                            .id(Self.anchor(service.id))
                    }
                }
            }
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Zustand nicht geladen", error: error) {
                Task { await store.recheck() }
            }
        } else {
            WeekSkeleton(label: "Zustand wird geladen")
        }
    }

    static func anchor(_ id: String) -> String { "dienst-\(id)" }

    private func head(_ health: HealthModel, proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let date = health.checkedDate {
                    Text("Stand \(HealthModel.stamp(date, timeZone: timeZone))")
                        .monospacedDigit()
                        .contentTransition(.numericText())
                }
                Text("· Zunder und Kalender werden beim Laden frisch geprüft")
            }
            .font(.footnote)
            .foregroundStyle(Theme.text3)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)

            if health.failing.isEmpty {
                Label("Alle eingerichteten Dienste laufen.", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.ok)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.okSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Label(health.failing.count == 1 ? "Ein Dienst meldet einen Fehler:" : "\(health.failing.count) Dienste melden einen Fehler:", systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.medium))
                    ChipRow {
                        ForEach(health.failing) { failing in
                            Button {
                                session.toasts.signal(.selection)
                                withAnimation(reduceMotion ? nil : .snappy) {
                                    proxy.scrollTo(Self.anchor(failing.id), anchor: .top)
                                }
                            } label: {
                                Text(failing.name)
                                    .font(.footnote.weight(.semibold))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(Theme.surface, in: Capsule())
                                    .overlay { Capsule().strokeBorder(Theme.danger.opacity(0.35)) }
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Springt zur Karte")
                        }
                    }
                }
                .foregroundStyle(Theme.danger)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.dangerSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            }

            Button {
                session.toasts.signal(.selection)
                model.open(page: .settings(section: nil))
            } label: {
                Label("Einstellungen", systemImage: "gearshape")
                    .font(.subheadline.weight(.medium))
            }
            .buttonStyle(.borderless)
            .tint(Theme.accent)
        }
    }
}

/// Karte eines Dienstes (`.svc` im Web).
struct HealthServiceCard: View {
    let service: HealthService
    let timeZone: TimeZone
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(service.name)
                    .font(.headline)
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                HealthStatePill(state: service.state)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            if let summary = service.summary, !summary.isEmpty {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let facts = Self.facts(of: service, timeZone: timeZone, now: now)
            if !facts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(facts.enumerated()), id: \.offset) { _, fact in
                        HealthFactRow(label: fact.label, value: fact.value)
                    }
                }
            }
            if !service.items.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(service.items) { item in
                        HealthItemRow(item: item, timeZone: timeZone, now: now)
                    }
                }
                .padding(.top, 2)
            } else {
                HealthErrorBox(service: service, timeZone: timeZone, now: now)
            }
        }
        .cardStyle()
        .overlay(alignment: .leading) {
            // Rand links in der Farbe des Stands, wie `.svc.state-error` im Web.
            if service.state == .error {
                Capsule()
                    .fill(Theme.danger)
                    .frame(width: 4)
                    .padding(.vertical, 12)
                    .accessibilityHidden(true)
            }
        }
    }

    /// Angaben wie im Web: Werte oder Zeitpunkte, dazu „Letzter Erfolg“, wenn der Dienst nicht aus
    /// ist und keine Angabe denselben Zeitpunkt schon nennt.
    static func facts(of service: HealthService, timeZone: TimeZone, now: Date) -> [(label: String, value: String)] {
        var facts: [(label: String, value: String)] = service.facts.map { fact in
            (fact.label, fact.at != nil ? HealthModel.when(fact.at, now: now, timeZone: timeZone) : fact.value ?? "–")
        }
        let named = service.facts.contains { $0.at != nil && $0.at == service.lastOkAt }
        if service.state != .off, !named {
            facts.append(("Letzter Erfolg", HealthModel.when(service.lastOkAt, now: now, timeZone: timeZone)))
        }
        return facts
    }
}

/// „Name   Wert“ in der Karte (`dl.facts`).
struct HealthFactRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
                .foregroundStyle(Theme.text3)
                .frame(minWidth: 110, alignment: .leading)
            Text(value)
                .foregroundStyle(Theme.text)
                .monospacedDigit()
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.footnote)
        .accessibilityElement(children: .combine)
    }
}

/// Pille „läuft“, „Fehler“, „aus“, „unbekannt“.
struct HealthStatePill: View {
    let state: HealthState

    var body: some View {
        Text(state.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Self.color(state))
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Self.soft(state), in: Capsule())
            .accessibilityLabel("Stand: \(state.label)")
    }

    static func color(_ state: HealthState) -> Color {
        switch state {
        case .ok: Theme.ok
        case .error: Theme.danger
        case .off: Theme.text3
        case .unknown: Theme.warn
        }
    }

    static func soft(_ state: HealthState) -> Color {
        switch state {
        case .ok: Theme.okSoft
        case .error: Theme.dangerSoft
        case .off: Theme.bgSunk
        case .unknown: Theme.warnSoft
        }
    }
}

/// Eintrag der Unterliste (ein Kalender, ein Teil der Brücke): Punkt, Name, Pille, Zusammenfassung
/// mit „zuletzt ok …“ und Fehlerkasten.
struct HealthItemRow: View {
    let item: HealthService
    let timeZone: TimeZone
    let now: Date

    private var meta: String {
        var parts: [String] = []
        if let summary = item.summary, !summary.isEmpty { parts.append(summary) }
        if item.lastOkAt != nil { parts.append("zuletzt ok \(HealthModel.when(item.lastOkAt, now: now, timeZone: timeZone))") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle()
                    .fill(HealthStatePill.color(item.state))
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
                Text(item.name)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.text)
                HealthStatePill(state: item.state)
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
            if !meta.isEmpty {
                Text(meta)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HealthErrorBox(service: item, timeZone: timeZone, now: now)
        }
        .padding(.leading, 2)
    }
}

/// Letzter Fehler: rot, solange er gilt („Fehler …“), sonst grau als Vergangenheit („Letzter
/// Fehler …“). Ohne Fehler nichts.
struct HealthErrorBox: View {
    let service: HealthService
    let timeZone: TimeZone
    let now: Date

    var body: some View {
        if service.lastError != nil || (service.state == .error && service.lastErrorAt != nil) {
            let current = service.errorIsCurrent
            VStack(alignment: .leading, spacing: 4) {
                Text("\(current ? "Fehler" : "Letzter Fehler") \(HealthModel.when(service.lastErrorAt, now: now, timeZone: timeZone))")
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
                if let error = service.lastError, !error.isEmpty {
                    Text(error)
                        .font(.footnote.monospaced())
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .foregroundStyle(current ? Theme.danger : Theme.text2)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(current ? Theme.dangerSoft : Theme.bgSunk, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .accessibilityElement(children: .combine)
        }
    }
}
