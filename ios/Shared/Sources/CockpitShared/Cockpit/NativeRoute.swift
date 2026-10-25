import Foundation

/// Seiten des Cockpits mit eigenem Reiter (Woche, Rückblick, Planen). Links auf diese Pfade
/// wechseln den Reiter; `redirect` aus Aktionen landet ebenfalls hier.
public enum NativeRoute: Equatable, Hashable, Sendable {
    /// `/?woche=…`, nil = laufende Woche. `focusCapture`: `?erfassen=1` (Kurzbefehl „Schnelleingabe“).
    case week(String?, focusCapture: Bool = false)
    /// `/rueckblick?woche=…`
    case review(String?)
    /// `/planen?woche=…&q=…&bereich=…&aus=…`
    case plan(String?, PlanQuery)

    /// Pfad mit Query, z. B. aus `redirect` (`/planen?woche=2026-W42#flamme`) oder `next`.
    public init?(webPath: String) {
        guard webPath.hasPrefix("/"), !webPath.hasPrefix("//"), let components = URLComponents(string: webPath) else { return nil }
        self.init(path: components.path, query: components.queryItems ?? [])
    }

    /// Adresse auf dem eigenen Server (Host und Port geprüft vom Aufrufer).
    public init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        self.init(path: components.path.isEmpty ? "/" : components.path, query: components.queryItems ?? [])
    }

    public init?(path: String, query: [URLQueryItem]) {
        func value(_ name: String) -> String {
            query.first { $0.name == name }?.value ?? ""
        }
        let week = value("woche").isEmpty ? nil : value("woche")
        switch path {
        case "/", "":
            self = .week(week, focusCapture: query.contains { $0.name == "erfassen" })
        case "/rueckblick":
            self = .review(week)
        case "/planen":
            self = .plan(week, PlanQuery(q: value("q"), area: value("bereich"), from: value("aus")))
        default:
            return nil
        }
    }

    /// Pfad der Web-Seite (`/`, `/rueckblick`, `/planen`), ohne Query.
    public var path: String {
        switch self {
        case .week: "/"
        case .review: "/rueckblick"
        case .plan: "/planen"
        }
    }

    /// Pfad mit Query wie im Web, z. B. `/planen?woche=2026-W42&aus=t1`.
    public var webPath: String {
        var items: [URLQueryItem]
        switch self {
        case .week(let week, let focus):
            items = CockpitAPI.weekQuery(week)
            if focus { items.append(URLQueryItem(name: "erfassen", value: "1")) }
        case .review(let week):
            items = CockpitAPI.weekQuery(week)
        case .plan(let week, let query):
            items = CockpitAPI.planQuery(week, query)
        }
        var components = URLComponents()
        components.path = path
        components.queryItems = items.isEmpty ? nil : items
        return components.string ?? path
    }
}
