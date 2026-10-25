import CockpitShared
import SwiftUI

/// Rahmen nach dem Login: Reiter Woche, Lesen, Rückblick und Einstellungen, alle nativ. Notiz,
/// Graph, Suche und Zustand kommen als Blatt mit eigenem Stapel (`AppModel.pageSheet`). App und
/// Sitzung stehen im Environment (`@Environment(AppModel.self)`, `@Environment(CockpitSession.self)`).
@MainActor
struct MainView: View {
    @Bindable var model: AppModel
    let session: CockpitSession

    var body: some View {
        TabView(selection: $model.tab) {
            WeekTab(model: model, session: session)
                .tabItem { Label("Woche", systemImage: "calendar") }
                .tag(AppTab.week)
            LesenScreen(model: model, session: session)
                .tabItem { Label("Lesen", systemImage: "book") }
                .tag(AppTab.reading)
            ReviewScreen(model: model, store: session.review, toasts: session.toasts)
                .tabItem { Label("Rückblick", systemImage: "chart.bar") }
                .tag(AppTab.review)
            SettingsTab(model: model, session: session)
                .tabItem { Label("Einstellungen", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
        .tint(Theme.accent)
        .sensoryFeedback(.selection, trigger: model.tab)
        .onChange(of: model.tab) { old, new in model.tabChanged(from: old, to: new) }
        // Haptik der Stores (Abhaken, Fehler, Auswahl), wie `{type: 'haptik'}` im Web.
        .sensoryFeedback(trigger: session.toasts.haptic) { _, event in
            guard let event else { return nil }
            switch event.intent {
            case .selection: return SensoryFeedback.selection
            case .success: return SensoryFeedback.success
            case .error: return SensoryFeedback.error
            }
        }
        .sheet(item: $model.pageSheet) { sheet in
            // App, Sitzung und Lesedienste ausdrücklich auch im Blatt (Notiz, Graph, Zustand …).
            PageSheetView(model: model, sheet: sheet)
                .environment(model)
                .environment(session)
                .readerServices(ReaderServices(context: session.context, buffer: session.reading, ingest: session.ingest))
        }
        .environment(model)
        .environment(session)
        // Kontext und Puffer für Leseansichten, auch aus Blättern heraus.
        .readerServices(ReaderServices(context: session.context, buffer: session.reading, ingest: session.ingest))
    }
}

/// Reiter „Woche“ mit eigenem Stapel für „Woche planen“.
@MainActor
struct WeekTab: View {
    @Bindable var model: AppModel
    let session: CockpitSession

    var body: some View {
        NavigationStack(path: $model.weekPath) {
            WeekScreen(model: model, store: session.week, toasts: session.toasts)
                .navigationDestination(for: WeekDestination.self) { destination in
                    switch destination {
                    case .plan(let week, let query, let flame):
                        PlanScreen(model: model, store: session.plan, toasts: session.toasts, can: session.week.model?.capabilities ?? .all, week: week, query: query, focusFlame: flame)
                    }
                }
        }
    }
}

/// Reiter „Einstellungen“ mit eigenem Stapel: Abschnitte und „Zustand der Dienste“.
@MainActor
struct SettingsTab: View {
    @Bindable var model: AppModel
    let session: CockpitSession

    var body: some View {
        NavigationStack(path: $model.settingsPath) {
            SettingsScreen()
                .navigationDestination(for: SettingsDestination.self) { destination in
                    switch destination {
                    case .section(let id):
                        SettingsSectionScreen(sectionID: id)
                    case .health:
                        HealthScreen()
                    }
                }
        }
    }
}

/// Blatt mit einer Seite (Notiz, Graph, Suche, Zustand) und eigenem Stapel: Links darin legen die
/// nächste Seite obendrauf (`AppModel.open(page:)`), „Fertig“ schließt alles.
@MainActor
struct PageSheetView: View {
    @Bindable var model: AppModel
    let sheet: PageSheet

    var body: some View {
        NavigationStack(path: $model.pageSheetPath) {
            PageView(route: sheet.root)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Fertig") { model.closePageSheet() }
                    }
                }
                .navigationDestination(for: PageRoute.self) { route in
                    PageView(route: route)
                }
        }
    }
}

/// Bildschirm zu einer Seite des Cockpits (`PageRoute`). Braucht einen `NavigationStack`.
@MainActor
struct PageView: View {
    let route: PageRoute

    var body: some View {
        switch route {
        case .note(let path, let anchor):
            NoteScreen(path: path, anchor: anchor)
        case .graph(let path):
            GraphScreen(path: path)
        case .search(let query):
            SearchScreen(query: query)
        case .wissen(let query):
            WissenScreen(query: query)
                .navigationTitle("Wissen")
                .navigationBarTitleDisplayMode(.inline)
        case .health:
            HealthScreen()
        case .settings:
            SettingsScreen()
        case .feeds:
            FeedsScreen()
                .navigationTitle("Feeds")
                .navigationBarTitleDisplayMode(.inline)
        }
    }
}
