import CockpitShared
import SwiftUI

/// Rahmen nach dem Login: Woche, Lesen und Rückblick nativ, Einstellungen als Web-Reiter. App und
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
            webTab(model.settingsPath)
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
        .sheet(item: $model.webSheet) { page in
            WebSheet(model: model, page: page)
        }
        .environment(model)
        .environment(session)
        // Kontext und Puffer für Leseansichten, auch aus Blättern heraus.
        .readerServices(ReaderServices(context: session.context, buffer: session.reading))
    }

    /// Eigener WKWebView je Reiter; nach jedem Login neu (frisches Cookie).
    private func webTab(_ path: String) -> some View {
        WebShell(model: model, startPath: path)
            .id(model.webViewID)
            // Die Seite setzt oben selbst `env(safe-area-inset-top)`; unten endet sie an der Reiterleiste.
            .ignoresSafeArea(.container, edges: .top)
            .background(Theme.bg)
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
