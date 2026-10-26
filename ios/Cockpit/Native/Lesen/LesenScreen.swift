import CockpitShared
import SwiftUI

/// Bereiche der Unternavigation des Lesens (`MAIN` und `MORE` in src/lesen/pages.js), alle nativ:
/// vier Reiter für den Ablauf eines Textes, der Rest unter „Mehr“. „Ingest“ steht dort nur, wenn
/// der Server ihn eingerichtet hat.
enum LesenSection: String, CaseIterable, Hashable, Identifiable {
    case weiter, eingang, stapel, folgen, ingest, markiert, wiedersehen, wissen, feeds

    /// Die Reiter: Weiter · Eingang · Stapel · Folgen.
    static let tabs: [LesenSection] = [.weiter, .eingang, .stapel, .folgen]
    /// Unter „Mehr“.
    static let more: [LesenSection] = [.ingest, .markiert, .wiedersehen, .wissen, .feeds]

    var id: String { rawValue }

    var label: String {
        switch self {
        case .weiter: "Weiter"
        case .eingang: "Eingang"
        case .stapel: "Stapel"
        case .folgen: "Folgen"
        case .ingest: "Ingest"
        case .markiert: "Markiert"
        case .wiedersehen: "Wiedersehen"
        case .wissen: "Wissen"
        case .feeds: "Feeds"
        }
    }

    /// Zeile unter dem Namen im Menü „Mehr“ (wie im Web).
    var hint: String {
        switch self {
        case .ingest: "Entwürfe fürs Wiki abhaken"
        case .markiert: "Alle Markierungen nach Quelle und Thema"
        case .wiedersehen: "Markierungen wiederholen"
        case .wissen: "Im Vault suchen"
        case .feeds: "Abos verwalten"
        default: ""
        }
    }

    var symbol: String {
        switch self {
        case .weiter: "arrow.forward.circle"
        case .eingang: "tray"
        case .stapel: "books.vertical"
        case .folgen: "headphones"
        case .ingest: "checklist"
        case .markiert: "highlighter"
        case .wiedersehen: "arrow.clockwise.circle"
        case .wissen: "magnifyingglass"
        case .feeds: "dot.radiowaves.up.forward"
        }
    }
}

/// Reiter „Lesen“ nativ: Unternavigation oben, darunter der gewählte Bereich; Leseansicht und
/// „Neue Folge“ kommen auf den eigenen Stapel (`AppModel.readingPath`), Links aus anderen
/// Reitern und Web-Seiten landen über `AppModel.open(reading:)` hier.
@MainActor
struct LesenScreen: View {
    @Bindable var model: AppModel
    let session: CockpitSession

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        NavigationStack(path: $model.readingPath) {
            section(model.readingSection)
                .id(model.readingSection)
                .transition(.opacity)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.bg)
                .safeAreaInset(edge: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        LesenSubnav(model: model, session: session)
                        LesenPufferBanner(buffer: session.reading, toasts: session.toasts)
                    }
                    .background(Theme.bg)
                    .animation(.snappy, value: session.reading.entries.isEmpty)
                }
                .navigationTitle(model.readingSection.label)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            session.toasts.signal(.selection)
                            model.showsAdd = true
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("Hinzufügen")
                        .accessibilityHint("Adresse speichern oder PDF hochladen")
                    }
                }
                .navigationDestination(for: ReadingRoute.self) { route in
                    destination(route)
                }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: model.readingSection)
        }
        .sheet(isPresented: $model.showsAdd) {
            HinzufuegenSheet(model: model, store: session.inbox, toasts: session.toasts)
        }
        // Zahl bereiter Entwürfe in der Unternavigation (und ob es den Ingest gibt).
        .task {
            if session.ingest.model == nil { await session.ingest.load() }
        }
    }

    // MARK: Bereiche

    @ViewBuilder
    private func section(_ section: LesenSection) -> some View {
        switch section {
        case .weiter:
            WeiterScreen(model: model, store: session.weiter, toasts: session.toasts)
        case .eingang:
            EingangScreen(model: model, store: session.inbox, toasts: session.toasts)
        case .stapel:
            StapelScreen(model: model, store: session.stack, ingest: session.ingest, toasts: session.toasts)
        case .ingest:
            IngestScreen(model: model, store: session.ingest, toasts: session.toasts)
        case .folgen:
            FolgenScreen()
        case .markiert:
            MarkiertScreen()
        case .wiedersehen:
            // Neu, wenn ein Link eine andere Woche verlangt (Rückblick „wiedersehen“).
            WiedersehenScreen(week: model.reviewWeek)
                .id(model.reviewWeek ?? "")
        case .wissen:
            // Neu, wenn ein Link eine Frage oder einen Filter mitbringt (`/wissen?q=…`).
            WissenScreen(query: model.wissenQuery)
                .id(model.wissenQuery)
        case .feeds:
            FeedsScreen()
        }
    }

    /// Ziele auf dem Stapel. Bereiche kommen nur hierher, wenn jemand sie als Link auf den Stapel
    /// legt; `AppModel.open(reading:)` wählt sie sonst in der Unternavigation. Den Filter von
    /// „Markiert“ (`AppModel.highlightQuery`) und das Zeitfenster der neuen Folge
    /// (`AppModel.newEpisodeZeit`) hält die App (`@Environment(AppModel.self)`).
    @ViewBuilder
    private func destination(_ route: ReadingRoute) -> some View {
        switch route {
        case .weiter:
            WeiterScreen(model: model, store: session.weiter, toasts: session.toasts)
        case .reader(let id, let highlight, let resume):
            ReaderScreen(docID: id, anchor: ReaderAnchor(highlight: highlight, resume: resume))
        case .newEpisode:
            NeueFolgeScreen()
        case .ingestReview(let id):
            IngestReviewScreen(docID: id)
                .id(id)
        case .ingest:
            IngestScreen(model: model, store: session.ingest, toasts: session.toasts)
        case .inbox:
            EingangScreen(model: model, store: session.inbox, toasts: session.toasts)
        case .stack:
            StapelScreen(model: model, store: session.stack, ingest: session.ingest, toasts: session.toasts)
        case .highlights:
            MarkiertScreen()
        case .review(let week):
            WiedersehenScreen(week: week)
        case .episodes:
            FolgenScreen()
        case .add, .listen:
            // Blatt bzw. Player über `AppModel.open(reading:)`; hier nur der Vollständigkeit halber.
            EingangScreen(model: model, store: session.inbox, toasts: session.toasts)
        }
    }
}

/// Unternavigation wie `.lesen-tabs` im Web: vier Reiter (Weiter · Eingang · Stapel · Folgen) mit
/// Unterstrich, daneben das Menü „Mehr“ (Ingest, Markiert, Wiedersehen, Wissen, Feeds). Steht man
/// auf einem Bereich aus „Mehr“, trägt der Knopf seinen Namen. Die Zahl bereiter Ingest-Entwürfe
/// steht an „Weiter“ (dort unter „Prüfen“) und an „Ingest“.
@MainActor
struct LesenSubnav: View {
    let model: AppModel
    let session: CockpitSession

    var body: some View {
        HStack(spacing: 0) {
            ForEach(LesenSection.tabs) { section in
                tab(section)
            }
            moreMenu
        }
        .padding(.horizontal, 8)
        .background(Theme.bg)
        .overlay(alignment: .bottom) {
            Theme.line.frame(height: 0.5)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Lesen")
    }

    private func tab(_ section: LesenSection) -> some View {
        let selected = model.readingSection == section
        return Button {
            select(section)
        } label: {
            HStack(spacing: 4) {
                Text(section.label)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if let count = count(section) {
                    LesenTabBadge(count: count)
                }
            }
            .font(.subheadline.weight(selected ? .semibold : .medium))
            .foregroundStyle(selected ? Theme.accent : Theme.text2)
            .frame(maxWidth: .infinity, minHeight: 40)
            .overlay(alignment: .bottom) {
                Capsule()
                    .fill(selected ? Theme.accent : Color.clear)
                    .frame(height: 2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(.snappy, value: selected)
        .accessibilityLabel(count(section).map { "\(section.label), \($0) bereit" } ?? section.label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// „Mehr“ bzw. der Name des gewählten Bereichs daraus.
    private var moreMenu: some View {
        let current = LesenSection.more.contains(model.readingSection) ? model.readingSection : nil
        return Menu {
            ForEach(moreSections) { section in
                Button {
                    select(section)
                } label: {
                    Label {
                        Text(section.label + (count(section).map { " (\($0))" } ?? ""))
                        Text(section.hint)
                    } icon: {
                        Image(systemName: current == section ? "checkmark" : section.symbol)
                    }
                }
            }
        } label: {
            HStack(spacing: 3) {
                Text(current?.label ?? "Mehr")
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .accessibilityHidden(true)
            }
            .font(.subheadline.weight(current == nil ? .medium : .semibold))
            .foregroundStyle(current == nil ? Theme.text2 : Theme.accent)
            .frame(maxWidth: .infinity, minHeight: 40)
            .overlay(alignment: .bottom) {
                Capsule()
                    .fill(current == nil ? Color.clear : Theme.accent)
                    .frame(height: 2)
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel(current.map { "Mehr, gewählt: \($0.label)" } ?? "Mehr")
        .accessibilityHint("Ingest, Markiert, Wiedersehen, Wissen und Feeds")
    }

    private func select(_ section: LesenSection) {
        guard model.readingSection != section || !model.readingPath.isEmpty else { return }
        session.toasts.signal(.selection)
        model.readingPath = []
        // Wie der Link der Unternavigation im Web: Wiedersehen zeigt die laufende Woche.
        if section == .wiedersehen { model.reviewWeek = nil }
        if section == .wissen { model.wissenQuery = WissenQuery() }
        model.readingSection = section
    }

    /// Ingest nur, wenn der Server ihn kennt (vor dem ersten Laden noch nicht).
    private var moreSections: [LesenSection] {
        LesenSection.more.filter { $0 != .ingest || session.ingest.isEnabled == true || model.readingSection == .ingest }
    }

    /// Bereite Ingest-Entwürfe an „Weiter“ und „Ingest“ (ohne bereite keine Zahl, wie im Web).
    private func count(_ section: LesenSection) -> Int? {
        switch section {
        case .weiter, .ingest: session.ingest.readyCount.flatMap { $0 > 0 ? $0 : nil }
        default: nil
        }
    }
}

/// Kleine Zahl am Reiter (`.subnav-count` im Web).
struct LesenTabBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, 5)
            .frame(minWidth: 17, minHeight: 17)
            .background(Theme.accent, in: Capsule())
            .contentTransition(.numericText(value: Double(count)))
            .accessibilityHidden(true)
    }
}
