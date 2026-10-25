@testable import Cockpit
import CockpitShared
import XCTest

extension AppModel.PlayerFactory {
    /// Ohne Token: `start()` meldet nur „neu anmelden“, nichts spielt, nichts geht ans Netz.
    static let silent = AppModel.PlayerFactory(
        listening: { Player(minutes: $0, service: nil, speech: SystemSpeech(), defaults: UserDefaults(suiteName: "NowPlayingTests") ?? .standard) },
        episode: { EpisodePlayer(id: $0.episodeID, title: $0.title, kind: $0.kind, api: nil, defaults: UserDefaults(suiteName: "NowPlayingTests") ?? .standard) }
    )
}

/// Der Player gehört der App (`AppModel.nowPlaying`), nicht dem Blatt: Er läuft nach „Fertig“ als
/// Leiste über den Reitern weiter, und es läuft immer nur einer.
final class NowPlayingTests: XCTestCase {
    @MainActor
    private func app() -> AppModel {
        let model = AppModel(config: AppConfiguration(info: ["CockpitServerURL": "https://vault.test"]))
        model.players = .silent
        return model
    }

    @MainActor
    func testPlayerOutlivesItsSheet() {
        let model = app()
        XCTAssertNil(model.nowPlaying)
        model.open(path: "/lesen/hoeren?zeit=30")
        guard case .listening(let listening) = model.nowPlaying else { return XCTFail("Hören läuft nicht") }
        XCTAssertEqual(listening.minutes, 30)
        XCTAssertTrue(model.showsPlayer)

        // „Fertig“ schließt nur das Blatt.
        model.showsPlayer = false
        XCTAssertNotNil(model.nowPlaying, "Leiste über den Reitern")

        // Derselbe Wunsch zeigt wieder das Blatt, ohne neuen Player.
        model.open(path: "/lesen/hoeren?zeit=30")
        guard case .listening(let again) = model.nowPlaying else { return XCTFail("Hören läuft nicht mehr") }
        XCTAssertTrue(again === listening)
        XCTAssertTrue(model.showsPlayer)

        // Anderes Zeitfenster: neue Wiedergabeliste.
        model.open(path: "/lesen/hoeren?zeit=60")
        guard case .listening(let other) = model.nowPlaying else { return XCTFail("Hören läuft nicht mehr") }
        XCTAssertFalse(other === listening)
        XCTAssertEqual(other.minutes, 60)
    }

    @MainActor
    func testOnlyOnePlayerAtATime() {
        let model = app()
        model.open(path: "/lesen/hoeren?zeit=15")
        let request = AppModel.EpisodeRequest(episodeID: "f1", title: "Vom Lesen", kind: "Podcast")
        model.episode = request
        guard case .episode(let episode) = model.nowPlaying else { return XCTFail("Folge löst das Hören ab") }
        XCTAssertEqual(episode.id, "f1")
        XCTAssertEqual(model.nowPlaying?.title, "Vom Lesen")
        XCTAssertEqual(model.nowPlaying?.symbol, "person.2.wave.2.fill")
        XCTAssertNil(model.nowPlaying?.progress, "Länge noch unbekannt")

        model.showsPlayer = false
        model.episode = AppModel.EpisodeRequest(episodeID: "f1", title: "Vom Lesen", kind: "Podcast")
        guard case .episode(let same) = model.nowPlaying else { return XCTFail("Folge läuft nicht mehr") }
        XCTAssertTrue(same === episode, "dieselbe Folge spielt weiter")
        XCTAssertTrue(model.showsPlayer)

        model.closePlayer()
        XCTAssertNil(model.nowPlaying)
        XCTAssertFalse(model.showsPlayer)
    }
}
