import AVFoundation
@testable import Cockpit
import CockpitShared
import XCTest

// Text mit Umlauten und Emojis: In UTF-16 (wie JS und der Server) ist 👋🏽 vier Einheiten lang,
// 🎉 zwei; als Swift-`Character` je eines. Die Offsets unten sind UTF-16.
// "Grüße 👋🏽 aus Köln." [0, 20)  "Zweiter Satz!" [21, 34)  "Dritter 🎉 Satz." [35, 51)
private let sample = "Grüße 👋🏽 aus Köln. Zweiter Satz! Dritter 🎉 Satz."
private let sampleSentences = [[0, 20], [21, 34], [35, 51]]

private func listenText(id: String = "a", text: String = sample, sentences: [[Int]] = sampleSentences, progress: Double = 0, anchor: Int = 0) -> ListenText {
    let body: [String: Any] = ["id": id, "title": id, "text": text, "sentences": sentences, "progress": progress, "anchor": anchor]
    return try! JSONDecoder().decode(ListenText.self, from: JSONSerialization.data(withJSONObject: body))
}

private func speechText(id: String = "a", text: String = sample, sentences: [[Int]] = sampleSentences, progress: Double = 0, anchor: Int = 0) -> SpeechText {
    SpeechText(listenText(id: id, text: text, sentences: sentences, progress: progress, anchor: anchor))
}

private func items(_ ids: String...) -> [QueueItem] {
    let list = ids.map { ["id": $0, "title": $0, "url": "https://example.org/\($0)", "site": "example.org", "kind": "article", "minutes": 3, "remaining": 3, "progress": 0] as [String: Any] }
    return try! JSONDecoder().decode([QueueItem].self, from: JSONSerialization.data(withJSONObject: list))
}

final class SpeechTextTests: XCTestCase {
    func testSentencesUseUTF16Offsets() {
        let text = speechText()
        XCTAssertEqual(text.length, 51, "JS-Länge, nicht Anzahl der Zeichen (\(sample.count))")
        XCTAssertEqual((0..<3).map(text.text(of:)), ["Grüße 👋🏽 aus Köln.", "Zweiter Satz!", "Dritter 🎉 Satz."])
    }

    func testHighlightLikeAnchorAt() {
        let text = speechText()
        let last = text.highlight(of: 2, cid: "c1")
        XCTAssertEqual(last, NewHighlight(id: "a", quote: "Dritter 🎉 Satz.", prefix: "ße 👋🏽 aus Köln. Zweiter Satz! ", suffix: "", start: 35, cid: "c1"))
        let first = text.highlight(of: 0, cid: "c2")
        XCTAssertEqual(first.prefix, "")
        XCTAssertEqual(first.suffix, " Zweiter Satz! Dritter 🎉 Satz.")
        XCTAssertEqual(first.start, 0)
    }

    func testAnchorContextNeverSplitsAnEmoji() {
        // Präfix-Anfang (Satzanfang 34 − 32 = 2) fällt mitten in 🎉 (Einheiten 1 und 2).
        let before = "x🎉" + String(repeating: "a", count: 30) + " Satz."
        let h1 = speechText(text: before, sentences: [[34, 39]]).highlight(of: 0, cid: "c")
        XCTAssertEqual(h1.quote, "Satz.")
        XCTAssertEqual(h1.prefix, String(repeating: "a", count: 30) + " ")
        // Suffix-Ende (5 + 32 = 37) fällt mitten in 🎉 (Einheiten 36 und 37).
        let after = "Satz." + String(repeating: "b", count: 31) + "🎉"
        let h2 = speechText(text: after, sentences: [[0, 5]]).highlight(of: 0, cid: "c")
        XCTAssertEqual(h2.suffix, String(repeating: "b", count: 31))
        XCTAssertFalse((h1.prefix! + h2.suffix!).contains("\u{FFFD}"))
    }

    func testStartSentenceFromAnchor() {
        XCTAssertEqual(speechText(anchor: 0).startSentence, 0)
        XCTAssertEqual(speechText(anchor: 21).startSentence, 1)
        XCTAssertEqual(speechText(anchor: 22).startSentence, 2)
        XCTAssertEqual(speechText(anchor: 999).startSentence, 0, "hinter dem letzten Satz: von vorn, wie im Web")
    }

    func testServerOffsetsAreClamped() {
        let text = speechText(sentences: [[0, 999], [5], [-3, -1], [10, 10]])
        XCTAssertEqual(text.sentences, [.init(start: 0, end: 51)])
    }

    func testProgressNeverSinksAndEndsAtOne() {
        var text = speechText()
        XCTAssertEqual(text.finish(0), ProgressUpdate(id: "a", progress: 20.0 / 51, anchor: 21))
        XCTAssertEqual(text.finish(1), ProgressUpdate(id: "a", progress: 34.0 / 51, anchor: 35))
        XCTAssertEqual(text.finish(0), ProgressUpdate(id: "a", progress: 34.0 / 51, anchor: 21), "Satz zurück: Anker wandert, Fortschritt bleibt")
        XCTAssertEqual(text.finish(2), ProgressUpdate(id: "a", progress: 1, anchor: 35))

        var ahead = speechText(progress: 0.9)
        XCTAssertEqual(ahead.finish(0).progress, 0.9, "Stand vom Server sinkt nicht")
    }
}

final class PlayerMachineTests: XCTestCase {
    /// Maschine mit Texten a und b, a geladen ab `anchor`, abspielend.
    private func playing(anchor: Int = 0) -> PlayerMachine {
        var machine = PlayerMachine()
        XCTAssertEqual(machine.handle(.queue(items("a", "b"))), [.stop, .load(id: "a")])
        XCTAssertEqual(machine.handle(.play), [], "spricht erst, wenn der Text da ist")
        XCTAssertEqual(machine.handle(.loaded(id: "a", text: speechText(anchor: anchor))), [.speak(["Grüße 👋🏽 aus Köln.", "Zweiter Satz!", "Dritter 🎉 Satz."][speechText(anchor: anchor).startSentence])])
        return machine
    }

    func testPlaysSentencesInOrderAndSavesAfterEach() {
        var machine = playing(anchor: 21)
        XCTAssertEqual(machine.sentence, 1, "Start an der gespeicherten Stelle")
        XCTAssertEqual(machine.handle(.sentenceFinished), [.save(.init(id: "a", progress: 34.0 / 51, anchor: 35)), .speak("Dritter 🎉 Satz.")])
        XCTAssertEqual(machine.handle(.sentenceFinished), [.save(.init(id: "a", progress: 1, anchor: 35)), .load(id: "b")])
        XCTAssertTrue(machine.isPlaying)
        XCTAssertEqual(machine.handle(.loaded(id: "b", text: speechText(id: "b"))), [.speak("Grüße 👋🏽 aus Köln.")])
        XCTAssertEqual(machine.currentItem?.id, "b")
    }

    func testSkipsTextsWithoutSentencesAndFinishes() {
        var machine = PlayerMachine()
        _ = machine.handle(.queue(items("a", "b")))
        _ = machine.handle(.play)
        XCTAssertEqual(machine.handle(.loaded(id: "a", text: speechText(sentences: []))), [.load(id: "b")])
        XCTAssertEqual(machine.handle(.loaded(id: "b", text: nil)), [.finished])
        XCTAssertFalse(machine.isPlaying)
        XCTAssertEqual(machine.handle(.play), [.load(id: "a")], "nach dem Ende von vorn")
    }

    func testEmptyQueueFinishesAtOnce() {
        var machine = PlayerMachine()
        XCTAssertEqual(machine.handle(.queue([])), [.stop, .finished])
    }

    func testSentenceNavigation() {
        var machine = playing()
        XCTAssertEqual(machine.handle(.previousSentence), [.speak("Grüße 👋🏽 aus Köln.")], "am Anfang: Satz neu")
        XCTAssertEqual(machine.handle(.nextSentence), [.speak("Zweiter Satz!")])
        XCTAssertEqual(machine.handle(.nextSentence), [.speak("Dritter 🎉 Satz.")])
        XCTAssertEqual(machine.handle(.previousSentence), [.speak("Zweiter Satz!")])
        _ = machine.handle(.nextSentence)
        XCTAssertEqual(machine.handle(.nextSentence), [.stop, .load(id: "b")], "nach dem letzten Satz: nächster Text")
    }

    func testNextTextIgnoresLateLoadOfThePreviousOne() {
        var machine = PlayerMachine()
        _ = machine.handle(.queue(items("a", "b")))
        XCTAssertEqual(machine.handle(.nextText), [.stop, .load(id: "b")])
        XCTAssertEqual(machine.handle(.loaded(id: "a", text: speechText())), [])
        XCTAssertNil(machine.text)
    }

    func testPauseAndPlayRepeatTheSentence() {
        var machine = playing()
        _ = machine.handle(.nextSentence)
        XCTAssertEqual(machine.handle(.toggle), [.stop])
        XCTAssertEqual(machine.handle(.sentenceFinished), [], "abgebrochener Satz zählt nicht")
        XCTAssertEqual(machine.handle(.toggle), [.speak("Zweiter Satz!")])
    }

    func testLoadFailureStopsAndPlayRetries() {
        var machine = PlayerMachine()
        _ = machine.handle(.queue(items("a", "b")))
        _ = machine.handle(.play)
        XCTAssertEqual(machine.handle(.loadFailed(id: "a")), [.stop])
        XCTAssertFalse(machine.isPlaying)
        XCTAssertEqual(machine.handle(.play), [.load(id: "a")])
    }

    func testInterruptionResumesAtSentenceStart() {
        var machine = playing()
        _ = machine.handle(.nextSentence)
        XCTAssertEqual(machine.handle(.interruptionBegan), [.stop])
        XCTAssertFalse(machine.isPlaying)
        XCTAssertEqual(machine.handle(.interruptionEnded(shouldResume: true)), [.speak("Zweiter Satz!")])
        XCTAssertTrue(machine.isPlaying)
    }

    func testInterruptionStaysPausedWithoutShouldResumeOrWhenPausedBefore() {
        var machine = playing()
        _ = machine.handle(.interruptionBegan)
        XCTAssertEqual(machine.handle(.interruptionEnded(shouldResume: false)), [])
        XCTAssertFalse(machine.isPlaying)

        var paused = playing()
        _ = paused.handle(.pause)
        XCTAssertEqual(paused.handle(.interruptionBegan), [])
        XCTAssertEqual(paused.handle(.interruptionEnded(shouldResume: true)), [])
    }

    func testHeadphonesUnpluggedPauses() {
        var machine = playing()
        XCTAssertEqual(machine.handle(.outputLost), [.stop])
        XCTAssertFalse(machine.isPlaying)
        XCTAssertEqual(machine.handle(.interruptionEnded(shouldResume: true)), [])
    }

    func testEventsFromAudioSessionNotifications() {
        typealias Event = PlayerMachine.Event
        XCTAssertEqual(Event(interruption: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue]), .interruptionBegan)
        XCTAssertEqual(Event(interruption: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue,
                                            AVAudioSessionInterruptionOptionKey: AVAudioSession.InterruptionOptions.shouldResume.rawValue]),
                       .interruptionEnded(shouldResume: true))
        XCTAssertEqual(Event(interruption: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.ended.rawValue]), .interruptionEnded(shouldResume: false))
        XCTAssertEqual(Event(routeChange: [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue]), .outputLost)
        XCTAssertNil(Event(routeChange: [AVAudioSessionRouteChangeReasonKey: AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue]))
        XCTAssertNil(Event(interruption: [:]))
    }
}

final class PendingListeningTests: XCTestCase {
    func testKeepsOnlyLatestStatePerTextAndNeverLowersProgress() {
        var pending = PendingListening()
        pending.add(ProgressUpdate(id: "a", progress: 0.5, anchor: 100))
        pending.add(ProgressUpdate(id: "b", progress: 0.1, anchor: 5))
        pending.add(ProgressUpdate(id: "a", progress: 0.3, anchor: 40))
        XCTAssertEqual(pending.progress, [.init(id: "a", progress: 0.5, anchor: 40), .init(id: "b", progress: 0.1, anchor: 5)])
    }

    func testRemoveKeepsNewerState() {
        var pending = PendingListening()
        pending.add(ProgressUpdate(id: "a", progress: 0.2, anchor: 10))
        let sending = pending.next!
        pending.add(ProgressUpdate(id: "a", progress: 0.4, anchor: 20))
        pending.remove(sending)
        XCTAssertEqual(pending.next, .progress(.init(id: "a", progress: 0.4, anchor: 20)))
        pending.remove(pending.next!)
        XCTAssertNil(pending.next)
    }

    func testHighlightsByCidWithLimit() {
        var pending = PendingListening()
        let highlight = NewHighlight(id: "a", quote: "Satz.", cid: "c1")
        pending.add(highlight)
        pending.add(highlight)
        XCTAssertEqual(pending.highlights.count, 1)
        XCTAssertTrue(pending.contains(cid: "c1"))
        for i in 0..<(PendingListening.maxHighlights + 5) { pending.add(NewHighlight(id: "a", quote: "q", cid: "x\(i)")) }
        XCTAssertEqual(pending.highlights.count, PendingListening.maxHighlights)
        XCTAssertFalse(pending.contains(cid: "c1"), "die älteste fällt raus")
    }

    func testSurvivesRestart() {
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        var pending = PendingListening()
        pending.add(ProgressUpdate(id: "a", progress: 0.5, anchor: 100))
        pending.add(NewHighlight(id: "a", quote: "Grüße 👋🏽", prefix: "", suffix: " aus", start: 0, cid: "c1"))
        pending.save(to: defaults)
        XCTAssertEqual(PendingListening(defaults: defaults), pending)
        XCTAssertEqual(PendingListening(defaults: UserDefaults(suiteName: "test-\(UUID())")!), PendingListening())
    }

    func testRetriesOnlyWhatCanSucceedLater() {
        XCTAssertTrue(PendingListening.shouldRetry(URLError(.notConnectedToInternet)))
        for status in [401, 429, 500, 503] { XCTAssertTrue(PendingListening.shouldRetry(status: status), "\(status)") }
        for status in [400, 403, 404, 409, 413] { XCTAssertFalse(PendingListening.shouldRetry(status: status), "\(status)") }
    }
}

// MARK: Player mit falscher Sprachausgabe und falschem Server

@MainActor
private final class FakeSpeech: SpeechOutput {
    var onFinish: (() -> Void)?
    var spoken: [String] = []
    func speak(_ text: String, tempo: Double) { spoken.append(text) }
    func stop() {}
}

private actor FakeService: ListenService {
    var offline = false
    var saved: [ProgressUpdate] = []
    var highlights: [NewHighlight] = []

    func setOffline(_ value: Bool) { offline = value }

    func queue(minutes: Int) async throws -> Queue {
        let list = ["zeit": minutes, "items": [["id": "a", "title": "Erster Text", "url": "https://example.org/a", "site": "example.org", "kind": "article", "minutes": 3, "remaining": 2, "progress": 0.4]]] as [String: Any]
        return try JSONDecoder().decode(Queue.self, from: JSONSerialization.data(withJSONObject: list))
    }

    func text(id: String) async throws -> ListenText { listenText(id: id, anchor: 21) }

    func saveProgress(id: String, progress: Double, anchor: Int?) async throws -> Double {
        if offline { throw URLError(.notConnectedToInternet) }
        saved.append(ProgressUpdate(id: id, progress: progress, anchor: anchor ?? 0))
        return progress
    }

    func addHighlight(_ highlight: NewHighlight) async throws -> HighlightResult {
        if offline { throw URLError(.notConnectedToInternet) }
        highlights.append(highlight)
        return try JSONDecoder().decode(HighlightResult.self, from: Data(#"{"id":"h","duplicate":false,"message":"ok"}"#.utf8))
    }
}

@MainActor
final class PlayerTests: XCTestCase {
    private func waitUntil(_ condition: () async -> Bool) async {
        for _ in 0..<200 where !(await condition()) { try? await Task.sleep(for: .milliseconds(10)) }
    }

    func testPlaysFromAnchorSavesProgressAndBuffersOffline() async {
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        let speech = FakeSpeech()
        let service = FakeService()
        let player = Player(minutes: 15, service: service, speech: speech, defaults: defaults)
        defer { player.close() }

        await player.start()
        await waitUntil { !speech.spoken.isEmpty }
        XCTAssertEqual(speech.spoken, ["Zweiter Satz!"], "spielt gleich los, ab der Lesestelle")

        await service.setOffline(true)
        speech.onFinish?()
        player.remember()
        await waitUntil { player.message != nil }
        XCTAssertEqual(speech.spoken.last, "Dritter 🎉 Satz.")
        let buffered = PendingListening(defaults: defaults)
        XCTAssertEqual(buffered.progress, [.init(id: "a", progress: 34.0 / 51, anchor: 35)], "ohne Netz in den Puffer")
        XCTAssertEqual(buffered.highlights.map(\.quote), ["Dritter 🎉 Satz."])

        await service.setOffline(false)
        await player.flush()
        let saved = await service.saved
        let highlights = await service.highlights
        XCTAssertEqual(saved, [.init(id: "a", progress: 34.0 / 51, anchor: 35)])
        XCTAssertEqual(highlights.map(\.start), [35])
        XCTAssertNil(PendingListening(defaults: defaults).next, "nachgesendet und leer")
    }
}
