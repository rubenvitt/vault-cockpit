import CockpitShared
import Foundation
import Network

/// Was die nativen Bildschirme einer Anmeldung teilen: API mit dem Geräte-Token, Zwischenspeicher,
/// Meldungen und die Stores. `AppModel` legt sie nach jedem Login neu an.
@MainActor
final class CockpitSession {
    let context: CockpitContext
    let week: WeekStore
    let review: ReviewStore
    let plan: PlanStore

    private var monitor: NWPathMonitor?
    private var online = true

    init(serverURL: URL, token: String) {
        context = CockpitContext(
            api: CockpitAPI(baseURL: serverURL, token: token),
            snapshots: .applicationSupport(),
            outbox: .applicationSupport()
        )
        week = WeekStore(context: context)
        review = ReviewStore(context: context)
        plan = PlanStore(context: context)
    }

    var toasts: ToastCenter { context.toasts }

    /// Beobachtet das Netz und schickt, was im Puffer der Schnelleingabe wartet (auch nach dem Login).
    func start() {
        let monitor = NWPathMonitor()
        // Läuft auf der Queue des Monitors, nicht auf dem Main Actor; deshalb ausdrücklich @Sendable.
        monitor.pathUpdateHandler = { @Sendable [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.network(online: online) }
        }
        monitor.start(queue: DispatchQueue(label: "dev.rubeen.cockpit.netz"))
        self.monitor = monitor
        Task { await week.capture.resume() }
    }

    /// Abmelden oder neue Anmeldung: Netz, Vorschau und Wiederholung anhalten, Meldungen weg.
    func stop() {
        monitor?.cancel()
        monitor = nil
        week.capture.stop()
        context.toasts.dismissAll()
    }

    /// App wieder im Vordergrund: Puffer senden, eine ältere Woche neu laden (wie `visibilitychange` im Web).
    func foreground() async {
        await week.capture.flush()
        if let updated = week.state.lastUpdated, context.now().timeIntervalSince(updated) > 60, !week.state.isRefreshing {
            await week.refresh()
        }
    }

    /// Netz zurück: Puffer senden, und was ohne Netz alt blieb, neu laden.
    private func network(online: Bool) {
        let back = online && !self.online
        self.online = online
        guard back else { return }
        Task {
            await week.capture.flush()
            if week.state.isStale || week.state.isOffline { await week.refresh() }
            // Rückblick und Planung nur, wenn sie schon etwas zeigen.
            if review.model != nil, review.state.isStale || review.state.isOffline { await review.refresh() }
            if plan.model != nil, plan.state.isStale || plan.state.isOffline { await plan.refresh() }
        }
    }
}
