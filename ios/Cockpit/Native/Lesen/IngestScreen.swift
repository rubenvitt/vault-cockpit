import CockpitShared
import SwiftUI

/// Ingest nativ (`/lesen/ingest` im Web): bereite Entwürfe als Karten (Quelle, zwei bis drei
/// Kernaussagen, „3 Verknüpfungen · 1 Synthese“), darunter „In Arbeit“ und „Fehler“ (mit „Erneut
/// entwerfen“), oben „Ganzen Stapel entwerfen“. Eine Karte öffnet die Prüfansicht. Solange
/// Claude entwirft und die Übersicht sichtbar ist, fragt der Store alle 3 s nach; wird ein
/// Entwurf fertig, meldet er „Entwurf bereit: …“ mit „Prüfen“.
@MainActor
struct IngestScreen: View {
    let model: AppModel
    let store: IngestStore
    let toasts: ToastCenter

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let pollKey = "uebersicht"

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                header
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .background(Theme.bg)
        .refreshable { await store.refresh() }
        .toasts(toasts)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.state.isRefreshing && store.model != nil && !store.isPolling {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.4, dampingFraction: 0.85), value: listKey)
        .onAppear {
            store.setActive(scenePhase == .active)
            store.startPolling(Self.pollKey)
        }
        .onDisappear { store.stopPolling(Self.pollKey) }
        .onChange(of: scenePhase) { _, phase in store.setActive(phase == .active) }
        .task { await appear() }
    }

    /// Reihenfolge und Stand aller Einträge (für die Animation beim Wechsel).
    private var listKey: [String] {
        guard let overview = store.model else { return [] }
        return overview.ready.map { "b\($0.id)" } + overview.busy.map { "a\($0.id)\($0.status ?? "")" } + overview.failed.map { "f\($0.id)" }
    }

    // MARK: Kopf

    /// Hinweis ohne Claude, „Ganzen Stapel entwerfen“ und „Stand von …“.
    @ViewBuilder private var header: some View {
        if let overview = store.model, overview.enabled {
            if !overview.available {
                IngestUnavailableNote(reason: overview.reason)
            } else if let open = overview.openLabel {
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        Task { await store.draftStack() }
                    } label: {
                        HStack(spacing: 6) {
                            if store.busy.contains(IngestStore.stackKey) {
                                ProgressView()
                                    .controlSize(.small)
                            } else {
                                Image(systemName: "sparkles")
                                    .accessibilityHidden(true)
                            }
                            Text("Ganzen Stapel entwerfen")
                        }
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                    .disabled(store.busy.contains(IngestStore.stackKey))
                    Text("\(open) Claude entwirft einen nach dem anderen.")
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        if store.model != nil {
            LoadStatusView(state: store.state, hasModel: true)
        }
    }

    // MARK: Liste

    @ViewBuilder private var content: some View {
        if let overview = store.model {
            if !overview.enabled {
                ContentUnavailableView {
                    Label("Ingest ist nicht eingerichtet", systemImage: "books.vertical")
                } description: {
                    Text("Ingest ins Wiki braucht Claude im Cockpit (CLAUDE_CODE_OAUTH_TOKEN im Deployment).")
                }
            } else if overview.isEmpty {
                empty(overview)
            } else {
                IngestSectionHeader(title: "Bereit zum Abhaken", count: overview.ready.count)
                if overview.ready.isEmpty {
                    Text("Gerade keiner. Was in Arbeit ist, erscheint hier, sobald Claude fertig ist.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .cardStyle()
                } else {
                    ForEach(overview.ready) { entry in
                        NavigationLink(value: ReadingRoute.ingestReview(id: entry.id)) {
                            IngestReadyCard(entry: entry)
                        }
                        .buttonStyle(.plain)
                        .transition(cardTransition)
                    }
                }
                if !overview.busy.isEmpty {
                    IngestSectionHeader(title: "In Arbeit", count: overview.busy.count)
                    ForEach(overview.busy) { entry in
                        NavigationLink(value: ReadingRoute.reader(id: entry.id, highlight: nil, resume: false)) {
                            IngestBusyRow(entry: entry)
                        }
                        .buttonStyle(.plain)
                        .transition(cardTransition)
                    }
                }
                if !overview.failed.isEmpty {
                    IngestSectionHeader(title: "Fehler", count: overview.failed.count)
                    ForEach(overview.failed) { entry in
                        IngestFailedCard(
                            entry: entry,
                            canDraft: overview.available,
                            isBusy: store.busy.contains(entry.id),
                            retry: { Task { await store.draft(entry.id, force: true) } },
                            discard: { Task { await store.discard(entry.id) } },
                            read: {
                                toasts.signal(.selection)
                                model.readingPath.append(.reader(id: entry.id, highlight: nil, resume: false))
                            }
                        )
                        .transition(cardTransition)
                    }
                }
            }
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Ingest nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else {
            LesenSkeleton(label: "Entwürfe werden geladen", rows: 3)
                .padding(.top, 8)
        }
    }

    /// „Nichts zum Abhaken“ mit der Erklärung wie im Web.
    private func empty(_ overview: IngestOverviewModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Nichts zum Abhaken")
                .font(.headline)
                .foregroundStyle(Theme.text)
            Text("Claude liest die Texte auf deinem Stapel und schlägt vor, was davon ins Wiki gehört: Source-Page, Verknüpfungen, neue Seiten, Synthesen. Nachts von selbst, oder jetzt per Knopf. Ins Wiki kommt nur, was du hier abhakst.")
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .fixedSize(horizontal: false, vertical: true)
            if overview.openOnStack == 0 {
                Text("Gerade liegt nichts ohne Entwurf auf dem Stapel.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
        }
        .cardStyle()
    }

    private var cardTransition: AnyTransition {
        reduceMotion ? AnyTransition.opacity : AnyTransition.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .scale(scale: 0.95).combined(with: .opacity))
    }

    // MARK: Laden

    /// Erster Auftritt: gespeicherter Stand und Laden; danach neu laden.
    private func appear() async {
        if store.model == nil {
            await store.load()
        } else if !store.state.isRefreshing {
            await store.refresh()
        }
    }
}

// MARK: Karten

/// Überschrift einer Gruppe mit Zahl (`h2` mit `.hint` im Web).
struct IngestSectionHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title)
                .font(.headline)
                .foregroundStyle(Theme.text)
            Text("\(count)")
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(Theme.text3)
                .contentTransition(.numericText(value: Double(count)))
        }
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Bereiter Entwurf (`.ingest-card`): Meta, Titel, bis zu drei Kernaussagen, Zählung, „Synthese
/// angeboten“ und „Prüfen“. Die ganze Karte öffnet die Prüfansicht.
struct IngestReadyCard: View {
    let entry: IngestEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                let meta = entry.meta()
                if !meta.isEmpty {
                    Text(meta)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
                Text(entry.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !entry.kern.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(entry.kern.enumerated()), id: \.offset) { _, line in
                        IngestBullet(content: line, style: NoteScreenTextStyle(textStyle: .subheadline, color: Theme.text2))
                    }
                }
            }
            HStack(alignment: .center, spacing: 8) {
                Text(entry.tallyLabel)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let offer = entry.tally.offerLabel {
                    IngestPill(label: offer, featured: true)
                }
                Text("Prüfen")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.onAccent)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(Theme.accent, in: Capsule())
            }
        }
        .cardStyle()
        .contentShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityHint("Öffnet die Prüfansicht")
    }
}

/// Entwurf in Arbeit (`.ingest-row.is-busy`): Kreisel, Titel des Textes, „Claude entwirft, seit 2 Min.“.
struct IngestBusyRow: View {
    let entry: IngestEntry

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProgressView()
                .controlSize(.small)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.docTitle)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text(entry.busyLabel)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .cardStyle(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

/// Fehlgeschlagener Entwurf (`.ingest-row.is-failed`): Titel, Meta, Fehler in Rot, „Erneut
/// entwerfen“ (nur mit Claude) und „Verwerfen“.
struct IngestFailedCard: View {
    let entry: IngestEntry
    let canDraft: Bool
    let isBusy: Bool
    let retry: () -> Void
    let discard: () -> Void
    let read: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: read) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.docTitle)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                    let meta = CockpitFormat.meta([entry.site, entry.updatedAt.flatMap(CockpitFormat.date(from:)).map { CockpitFormat.dayTime($0, timeZone: .current) }])
                    if !meta.isEmpty {
                        Text(meta)
                            .font(.footnote)
                            .foregroundStyle(Theme.text3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Öffnet den Text")
            Text(entry.error ?? "Der Entwurf ist fehlgeschlagen.")
                .font(.subheadline)
                .foregroundStyle(Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Fehler: \(entry.error ?? "Der Entwurf ist fehlgeschlagen.")")
            FolgenActions {
                if canDraft {
                    Button(action: retry) {
                        HStack(spacing: 6) {
                            if isBusy {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(Theme.onAccent)
                            }
                            Text("Erneut entwerfen")
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 26)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                }
                Button("Verwerfen", action: discard)
                    .buttonStyle(LesenQuietButtonStyle())
            }
            .disabled(isBusy)
        }
        .cardStyle()
        .accessibilityElement(children: .contain)
    }
}

/// Hinweis, wenn Claude fehlt: Entwürfe abhaken geht trotzdem.
struct IngestUnavailableNote: View {
    let reason: String?

    var body: some View {
        Label {
            Text("Claude ist gerade nicht verfügbar\(reason.map { ": \($0)" } ?? ""). Neue Entwürfe entstehen erst wieder, wenn Claude angebunden ist; fertige lassen sich weiter abhaken.")
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "gearshape")
        }
        .font(.footnote)
        .foregroundStyle(Theme.warn)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.warnSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }
}

// MARK: Bausteine

/// Kennzeichen als Pille (`.ingest-pill`): „Konzept“, „Person“; `featured` (Synthesen, Fragen,
/// „Synthese angeboten“) in Akzentfarbe.
struct IngestPill: View {
    let label: String
    var featured = false

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(featured ? Theme.accent : Theme.text2)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(featured ? Theme.accentSoft : Theme.surface2, in: Capsule())
            .overlay { Capsule().strokeBorder(featured ? Theme.accentLine : Theme.line) }
            .fixedSize()
    }
}

/// Aufzählungspunkt mit Text als Baum (Kernaussagen, „Neu für dich“, Hinweise).
struct IngestBullet: View {
    let content: [NoteInline]
    var style = NoteScreenTextStyle.body

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("•")
                .font(.system(style.textStyle))
                .foregroundStyle(Theme.text3)
                .accessibilityHidden(true)
            Text(NoteScreenInline.attributed(content, style: style))
                .lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Abzeichen eines Textes (`ingestBadge` im Web): „Ingest bereit“, „wartet auf Claude…“, „wird
/// entworfen…“, „Ingest-Fehler“, „Im Wiki“; ohne Entwurf nichts.
struct IngestBadge: View {
    let status: String?
    var readyLabel = "Ingest bereit"

    var body: some View {
        if let look {
            HStack(spacing: 5) {
                if IngestStatus.isBusy(status) {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: look.icon)
                        .accessibilityHidden(true)
                }
                Text(look.label)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(look.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(look.background, in: Capsule())
            .fixedSize()
        }
    }

    /// Text, Symbol und Farben je Stand.
    private struct Look {
        let label: String
        let icon: String
        let color: Color
        let background: Color
    }

    private var look: Look? {
        if status == IngestStatus.ready { return Look(label: readyLabel, icon: "checklist", color: Theme.accent, background: Theme.accentSoft) }
        if status == IngestStatus.waiting { return Look(label: "wartet auf Claude…", icon: "hourglass", color: Theme.text2, background: Theme.surface2) }
        if status == IngestStatus.drafting { return Look(label: "wird entworfen…", icon: "hourglass", color: Theme.text2, background: Theme.surface2) }
        if status == IngestStatus.failed { return Look(label: "Ingest-Fehler", icon: "exclamationmark.triangle", color: Theme.danger, background: Theme.dangerSoft) }
        if status == IngestStatus.applied { return Look(label: "Im Wiki", icon: "checkmark", color: Theme.ok, background: Theme.okSoft) }
        return nil
    }

    /// Öffnet ein Tipp die Prüfansicht? (bereit oder Fehler)
    static func opensReview(_ status: String?) -> Bool {
        status == IngestStatus.ready || status == IngestStatus.failed
    }
}

/// Leiste der Leseansicht am Ende des Texts, über „Gelesen“ (`.lesen-decide` im Web): „Ingest
/// prüfen“ bzw. „Ingest-Fehler“ öffnen die Prüfansicht, „wird entworfen…“ zeigt den Stand, sonst
/// „Ingest entwerfen“, wenn Claude da ist.
@MainActor
struct ReaderIngestBar: View {
    let status: String?
    let available: Bool
    let isDrafting: Bool
    let review: () -> Void
    let draft: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "books.vertical")
                .foregroundStyle(Theme.text3)
                .accessibilityHidden(true)
            Text("Wiki")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.text)
            Spacer(minLength: 4)
            if status == IngestStatus.ready {
                Button("Ingest prüfen", action: review)
                    .buttonStyle(.borderedProminent)
                    .accessibilityHint("Öffnet die Prüfansicht")
            } else if status == IngestStatus.failed {
                Button("Ingest-Fehler", action: review)
                    .buttonStyle(.bordered)
                    .accessibilityHint("Öffnet die Prüfansicht mit dem Fehler")
            } else if IngestStatus.isBusy(status) || status == IngestStatus.applied {
                IngestBadge(status: status)
            } else if available {
                Button(action: draft) {
                    HStack(spacing: 6) {
                        if isDrafting {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text("Ingest entwerfen")
                    }
                }
                .buttonStyle(.bordered)
                .disabled(isDrafting)
            }
        }
        .tint(Theme.accent)
        .controlSize(.small)
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 48)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Theme.line)
        }
        .shadow(color: .black.opacity(0.14), radius: 16, y: 6)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
}
