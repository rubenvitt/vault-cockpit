import CockpitShared
import SwiftUI

/// Bereiche der Unternavigation des Lesens (`SUB` in src/lesen/pages.js), alle nativ. „Ingest“
/// steht wie im Web zwischen Stapel und Folgen, nur wenn der Server ihn eingerichtet hat.
enum LesenSection: String, CaseIterable, Hashable, Identifiable {
    case eingang, stapel, ingest, folgen, markiert, wiedersehen, wissen, feeds

    var id: String { rawValue }

    var label: String {
        switch self {
        case .eingang: "Eingang"
        case .stapel: "Stapel"
        case .ingest: "Ingest"
        case .folgen: "Folgen"
        case .markiert: "Markiert"
        case .wiedersehen: "Wiedersehen"
        case .wissen: "Wissen"
        case .feeds: "Feeds"
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

/// Unternavigation „Eingang · Stapel · Ingest · Folgen · Markiert · Wiedersehen · Wissen · Feeds“
/// (`.subnav` im Web). Eingang und Stapel zeigen, was dort liegt, Ingest die bereiten Entwürfe,
/// sobald es geladen ist; ohne Ingest-Dienst fehlt der Eintrag.
@MainActor
struct LesenSubnav: View {
    let model: AppModel
    let session: CockpitSession

    var body: some View {
        ScrollViewReader { proxy in
            LesenChipScroller("Lesen") {
                ForEach(sections) { section in
                    item(section)
                        .id(section)
                }
            }
            .onChange(of: model.readingSection) { _, section in
                withAnimation(.snappy) { proxy.scrollTo(section, anchor: .center) }
            }
            .onAppear { proxy.scrollTo(model.readingSection, anchor: .center) }
        }
        .padding(.vertical, 8)
        .background(Theme.bg)
        .overlay(alignment: .bottom) {
            Theme.line.frame(height: 0.5)
        }
    }

    private func item(_ section: LesenSection) -> some View {
        LesenChip(label: section.label, count: count(section), selected: model.readingSection == section) {
            guard model.readingSection != section || !model.readingPath.isEmpty else { return }
            session.toasts.signal(.selection)
            model.readingPath = []
            // Wie der Link der Unternavigation im Web: Wiedersehen zeigt die laufende Woche.
            if section == .wiedersehen { model.reviewWeek = nil }
            if section == .wissen { model.wissenQuery = WissenQuery() }
            model.readingSection = section
        }
    }

    /// Ingest nur, wenn der Server ihn kennt (vor dem ersten Laden noch nicht).
    private var sections: [LesenSection] {
        LesenSection.allCases.filter { $0 != .ingest || session.ingest.isEnabled == true || model.readingSection == .ingest }
    }

    /// Eingang: was noch zu sichten ist; Stapel: was darauf liegt (mit dem gewählten Filter);
    /// Ingest: bereite Entwürfe (ohne bereite keine Zahl, wie im Web).
    private func count(_ section: LesenSection) -> Int? {
        switch section {
        case .eingang: session.inbox.model?.left
        case .stapel: session.stack.model?.count
        case .ingest: session.ingest.readyCount.flatMap { $0 > 0 ? $0 : nil }
        default: nil
        }
    }
}
