import Foundation
import Observation

/// Wochenrückblick: nur lesen, mit Zwischenspeicher und Blättern.
@MainActor
@Observable
public final class ReviewStore {
    /// Gewünschte Woche, nil = die laufende.
    public private(set) var requestedWeek: String?

    private let remote: RemoteModel<ReviewModel>

    public init(context: CockpitContext) {
        remote = RemoteModel(context: context, path: "api/rueckblick")
    }

    public var model: ReviewModel? { remote.model }
    public var state: LoadState { remote.state }

    public func load(week: String? = nil) async {
        requestedWeek = week
        remote.select(key: "rueckblick/\(week ?? "aktuell")", query: CockpitAPI.weekQuery(week)) { model in
            week == nil ? model.week.current : model.week.id == week
        }
        await remote.refresh()
    }

    public func refresh() async {
        await remote.refresh()
    }

    public func showPrevious() async {
        guard let week = model?.week else { return }
        await load(week: week.prev)
    }

    public func showNext() async {
        guard let week = model?.week else { return }
        await load(week: week.next)
    }
}
