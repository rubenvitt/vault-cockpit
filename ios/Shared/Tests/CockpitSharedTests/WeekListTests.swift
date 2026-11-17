import XCTest
@testable import CockpitShared

/// Ordnung der Wochenlisten wie im Web (VCP-145, VCP-148).
final class WeekListTests: XCTestCase {
    private func task(_ id: String, phoenix: String? = nil, fire: String? = nil) -> ZunderTask {
        ZunderTask(id: id, title: id, phoenix: phoenix, fire: fire)
    }

    func testStepsOfShownWeekComeFirst() {
        let group = RockGroup(area: "Gesundheit", tasks: [
            task("fällig"),
            task("schritt", phoenix: PhoenixRole.step, fire: "2026-W47"),
            task("alter-schritt", phoenix: PhoenixRole.step, fire: "2026-W46"),
            task("flamme", phoenix: PhoenixRole.flame, fire: "2026-W47"),
            task("schritt-2", phoenix: PhoenixRole.step, fire: "2026-W47"),
        ], done: 0)
        XCTAssertEqual(group.stepsFirst(week: "2026-W47").map(\.id), ["schritt", "schritt-2", "fällig", "alter-schritt", "flamme"])
        XCTAssertEqual(group.stepsFirst(week: "").map(\.id), group.tasks.map(\.id))
    }

    func testShortListKeepsASingleOverhang() {
        XCTAssertEqual(ShortList.split(Array(1...5)).rest, [])
        XCTAssertEqual(ShortList.split(Array(1...6)).head, Array(1...6))
        XCTAssertEqual(ShortList.split(Array(1...6)).rest, [])
        XCTAssertEqual(ShortList.split(Array(1...7)).head, Array(1...5))
        XCTAssertEqual(ShortList.split(Array(1...7)).rest, [6, 7])
        XCTAssertEqual(ShortList.split([Int]()).head, [])
    }
}
