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

    func testLongSentenceIsCutForTheServer() {
        let long = String(repeating: "a", count: 4100) + "."
        let h1 = speechText(text: long, sentences: [[0, 4101]]).highlight(of: 0, cid: "c")
        XCTAssertEqual(h1.quote.utf16.count, SpeechText.maxQuote)
        XCTAssertEqual(h1.suffix, String(repeating: "a", count: 32), "Suffix schließt an das gekürzte Zitat an")
        // Schnitt bei 4000 fiele mitten in 🎉 (Einheiten 3999 und 4000): Zitat davor, Suffix ab dem Emoji.
        let emoji = String(repeating: "a", count: 3999) + "🎉 Ende."
        let h2 = speechText(text: emoji, sentences: [[0, 4008]]).highlight(of: 0, cid: "c")
        XCTAssertEqual(h2.quote, String(repeating: "a", count: 3999))
        XCTAssertEqual(h2.suffix, "🎉 Ende.")
    }

    func testStartSentenceFromAnchor() {
        XCTAssertEqual(speechText(anchor: 0).startSentence, 0)
        XCTAssertEqual(speechText(anchor: 21).startSentence, 1)
        XCTAssertEqual(speechText(anchor: 22).startSentence, 2)
        XCTAssertEqual(speechText(anchor: 999).startSentence, 0, "hinter dem letzten Satz: von vorn, wie im Web")
        XCTAssertEqual(speechText(progress: 0.5, anchor: 0).startSentence, 2, "ohne Anker ab dem Fortschritt (Einheit 25)")
        XCTAssertEqual(speechText(progress: 0.5, anchor: 21).startSentence, 1, "Anker geht vor")
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
    var onNotice: ((String) -> Void)?
    var spoken: [String] = []
    var prepared: [Utterance] = []
    var voices: [String?] = []
    func speak(_ utterance: Utterance, tempo: Double) { spoken.append(utterance.text) }
    func prepare(_ utterance: Utterance) { prepared.append(utterance) }
    func use(serverVoice: String?) { voices.append(serverVoice) }
    func stop() {}
}

private actor FakeService: ListenService {
    var offline = false
    var saved: [ProgressUpdate] = []
    var highlights: [NewHighlight] = []
    var rejectsHighlights = false
    var audioRequests: [[Int]] = []
    /// Antwort der Stimme vom Server; nil = Kontingent aufgebraucht.
    var audioData: Data?
    var voice: String?
    /// Langsames Netz beim Speichern des Fortschritts.
    let saveDelay: Duration

    init(saveDelay: Duration = .zero) {
        self.saveDelay = saveDelay
    }

    func setOffline(_ value: Bool) { offline = value }
    func setRejectsHighlights(_ value: Bool) { rejectsHighlights = value }
    func setVoice(_ value: String?) { voice = value }
    func setAudioData(_ value: Data?) { audioData = value }
    /// Kein Netz für Liste, Text und Audio (anders als `offline`, das nur das Senden trifft).
    var unreachable = false
    func setUnreachable(_ value: Bool) { unreachable = value }
    /// Zweiter Text „b“ in der Liste (zum Vorladen).
    var secondItem = false
    func setSecondItem(_ value: Bool) { secondItem = value }
    /// Angefragte Texte, in Reihenfolge.
    var textRequests: [String] = []
    /// Token abgelehnt (401) für Liste, Text und Senden.
    var revoked = false
    func setRevoked(_ value: Bool) { revoked = value }

    func queue(minutes: Int) async throws -> Queue {
        if unreachable { throw URLError(.notConnectedToInternet) }
        if revoked { throw APIError(status: 401, code: "unauthorized", message: "Token abgelehnt. Bitte in der App neu anmelden.") }
        var entries = [["id": "a", "title": "Erster Text", "url": "https://example.org/a", "site": "example.org", "kind": "article", "minutes": 3, "remaining": 2, "progress": 0.4]] as [[String: Any]]
        if secondItem { entries.append(["id": "b", "title": "Zweiter Text", "url": "https://example.org/b", "site": "example.org", "kind": "article", "minutes": 3, "remaining": 3, "progress": 0]) }
        var list = ["zeit": minutes, "items": entries] as [String: Any]
        if let voice { list["stimme"] = voice }
        return try JSONDecoder().decode(Queue.self, from: JSONSerialization.data(withJSONObject: list))
    }

    func audio(id: String, start: Int, end: Int) async throws -> Data {
        if unreachable { throw URLError(.notConnectedToInternet) }
        audioRequests.append([start, end])
        guard let audioData else { throw APIError(status: 502, code: "bad_request", message: "ElevenLabs: Kontingent aufgebraucht") }
        return audioData
    }

    /// Wie der Server: die zuletzt gespeicherte Lesestelle, sonst Satz 2.
    func text(id: String) async throws -> ListenText {
        if unreachable { throw URLError(.notConnectedToInternet) }
        textRequests.append(id)
        return listenText(id: id, anchor: saved.last { $0.id == id }?.anchor ?? 21)
    }

    func saveProgress(id: String, progress: Double, anchor: Int?) async throws -> Double {
        if offline { throw URLError(.notConnectedToInternet) }
        if revoked { throw APIError(status: 401, code: "unauthorized", message: "Token abgelehnt. Bitte in der App neu anmelden.") }
        try? await Task.sleep(for: saveDelay)
        saved.append(ProgressUpdate(id: id, progress: progress, anchor: anchor ?? 0))
        return progress
    }

    func addHighlight(_ highlight: NewHighlight) async throws -> HighlightResult {
        if offline { throw URLError(.notConnectedToInternet) }
        if rejectsHighlights { throw APIError(status: 400, code: "bad_request", message: "Die Auswahl ist zu lang (höchstens 4000 Zeichen)") }
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

    func testSendsBufferedProgressBeforeLoading() async {
        // Stand aus einer Sitzung ohne Netz: Satz 3 ist dran, der Server kennt noch Satz 2.
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        var buffered = PendingListening()
        buffered.add(ProgressUpdate(id: "a", progress: 34.0 / 51, anchor: 35))
        buffered.save(to: defaults)
        let speech = FakeSpeech()
        let service = FakeService(saveDelay: .milliseconds(100))
        let player = Player(minutes: 15, service: service, speech: speech, defaults: defaults)
        defer { player.close() }

        await player.start()
        await waitUntil { !speech.spoken.isEmpty }
        XCTAssertEqual(speech.spoken, ["Dritter 🎉 Satz."], "Text erst nach dem Nachsenden geladen")
        let saved = await service.saved
        XCTAssertEqual(saved, [.init(id: "a", progress: 34.0 / 51, anchor: 35)])
    }

    func testPreloadsTheNextTextSoTheSwitchWorksWithoutNetwork() async {
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        let speech = FakeSpeech()
        let service = FakeService()
        await service.setSecondItem(true)
        let player = Player(minutes: 15, service: service, speech: speech, defaults: defaults)
        defer { player.close() }

        await player.start()
        await waitUntil { player.prefetchedID == "b" }
        let requests = await service.textRequests
        XCTAssertEqual(requests, ["a", "b"], "der nächste Text lädt, während der erste spielt")

        await service.setUnreachable(true)
        player.send(.nextText)
        XCTAssertEqual(player.machine.currentItem?.id, "b")
        await waitUntil { speech.spoken.count == 2 }
        XCTAssertEqual(speech.spoken, ["Zweiter Satz!", "Zweiter Satz!"], "Wechsel ohne Netz aus dem Vorrat")
        XCTAssertNil(player.message)
    }

    func testRevokedTokenAsksForLoginWhileBufferStays() async {
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        var buffered = PendingListening()
        buffered.add(ProgressUpdate(id: "a", progress: 0.5, anchor: 21))
        buffered.save(to: defaults)
        let service = FakeService()
        await service.setRevoked(true)
        // Wie `AppModel.sendPendingListening`: ein Player nur zum Senden, nicht gestartet.
        let player = Player(minutes: 15, service: service, speech: FakeSpeech(), defaults: defaults)
        var unauthorized = 0
        player.onUnauthorized = { unauthorized += 1 }

        await player.flush()
        XCTAssertEqual(unauthorized, 1, "401 startet die neue Anmeldung")
        XCTAssertNotNil(PendingListening(defaults: defaults).next, "bleibt bis nach dem Login im Puffer")
    }

    func testRejectedHighlightIsNotReportedAsRemembered() async {
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        let speech = FakeSpeech()
        let service = FakeService()
        let player = Player(minutes: 15, service: service, speech: speech, defaults: defaults)
        defer { player.close() }

        await player.start()
        await waitUntil { !speech.spoken.isEmpty }
        await service.setRejectsHighlights(true)
        player.remember()
        await waitUntil { player.message != nil }
        XCTAssertEqual(player.message, "Nicht gemerkt: Die Auswahl ist zu lang (höchstens 4000 Zeichen)")
        XCTAssertNil(PendingListening(defaults: defaults).next, "Abgelehntes bleibt nicht im Puffer")

        await service.setRejectsHighlights(false)
        player.message = nil
        player.remember()
        await waitUntil { player.message != nil }
        XCTAssertEqual(player.message, "Gemerkt.")
    }
}

final class SpeechRateTests: XCTestCase {
    func testStartsAt15AndLearnsFromRealSentences() {
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        var rate = SpeechRate(defaults: defaults)
        XCTAssertEqual(rate.charactersPerSecond, 15)

        // 50 Einheiten in 2 s bei Tempo 1,25 sind 20 pro Sekunde bei Tempo 1: ein Zehntel davon.
        XCTAssertTrue(rate.record(units: 50, seconds: 2, tempo: 1.25))
        XCTAssertEqual(rate.charactersPerSecond, 15.5, accuracy: 0.0001)
        rate.save(to: defaults)
        XCTAssertEqual(SpeechRate(defaults: defaults).charactersPerSecond, 15.5, accuracy: 0.0001)
    }

    func testIgnoresShortSentencesAndClampsOutliers() {
        var rate = SpeechRate()
        XCTAssertFalse(rate.record(units: 10, seconds: 1, tempo: 1), "zu kurz")
        XCTAssertFalse(rate.record(units: 40, seconds: 0.2, tempo: 1), "zu schnell vorbei")
        XCTAssertEqual(rate.charactersPerSecond, 15)
        // Netz hing 60 s: gemessen 0,5, begrenzt auf 5.
        XCTAssertTrue(rate.record(units: 30, seconds: 60, tempo: 1))
        XCTAssertEqual(rate.charactersPerSecond, 14, accuracy: 0.0001)
    }

    func testUnusableSavedValueFallsBackToStart() {
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        defaults.set(500.0, forKey: SpeechRate.key)
        XCTAssertEqual(SpeechRate(defaults: defaults).charactersPerSecond, 15)
    }
}

@MainActor
final class ServerSpeechTests: XCTestCase {
    private func waitUntil(_ condition: () async -> Bool) async {
        for _ in 0..<200 where !(await condition()) { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private let first = Utterance(id: "a", text: "Erster Satz.", start: 0, end: 12)
    private let second = Utterance(id: "a", text: "Zweiter Satz.", start: 13, end: 26)

    func testWithoutServerVoiceTheDeviceSpeaks() async {
        let service = FakeService()
        let device = FakeSpeech()
        let speech = ServerSpeech(service: service, fallback: device)
        speech.use(serverVoice: nil)
        speech.prepare(second)
        speech.speak(first, tempo: 1)
        XCTAssertEqual(device.spoken, ["Erster Satz."])
        try? await Task.sleep(for: .milliseconds(50))
        let requests = await service.audioRequests
        XCTAssertEqual(requests, [], "ohne Stimme vom Server nichts holen")
    }

    func testFailureFallsBackToTheDeviceAndStaysThere() async {
        let service = FakeService()
        let device = FakeSpeech()
        let speech = ServerSpeech(service: service, fallback: device)
        var notices: [String] = []
        speech.onNotice = { notices.append($0) }
        var finished = 0
        speech.onFinish = { finished += 1 }
        speech.use(serverVoice: "ElevenLabs")

        speech.prepare(first)
        speech.speak(first, tempo: 1)
        await waitUntil { !device.spoken.isEmpty }
        XCTAssertEqual(device.spoken, ["Erster Satz."], "Gerätestimme übernimmt den Satz")
        XCTAssertEqual(notices, ["ElevenLabs: Kontingent aufgebraucht. Die Gerätestimme liest weiter."])
        let requests = await service.audioRequests
        XCTAssertEqual(requests, [[0, 12]], "Vorladen und Abspielen holen den Satz nur einmal")

        device.onFinish?()
        XCTAssertEqual(finished, 1, "Ende der Gerätestimme kommt beim Player an")
        speech.speak(second, tempo: 1)
        XCTAssertEqual(device.spoken, ["Erster Satz.", "Zweiter Satz."], "danach gleich das Gerät")
        let after = await service.audioRequests
        XCTAssertEqual(after.count, 1)
    }

    func testPlayerPassesVoiceAndPreparesTheNextSentence() async {
        let defaults = UserDefaults(suiteName: "test-\(UUID())")!
        let speech = FakeSpeech()
        let service = FakeService()
        await service.setVoice("ElevenLabs")
        let player = Player(minutes: 15, service: service, speech: speech, defaults: defaults)
        defer { player.close() }

        await player.start()
        await waitUntil { !speech.spoken.isEmpty }
        XCTAssertEqual(speech.voices, ["ElevenLabs"])
        XCTAssertEqual(speech.prepared, [Utterance(id: "a", text: "Dritter 🎉 Satz.", start: 35, end: 51)])
    }
}

@MainActor
final class OfflineTests: XCTestCase {
    private func waitUntil(_ condition: () async -> Bool) async {
        for _ in 0..<200 where !(await condition()) { try? await Task.sleep(for: .milliseconds(10)) }
    }

    private func store() -> OfflineStore {
        OfflineStore(root: FileManager.default.temporaryDirectory.appending(path: "offline-\(UUID())", directoryHint: .isDirectory))
    }

    func testDownloadKeepsTextAndEverySentenceAndWorksWithoutNetwork() async {
        let online = FakeService()
        await online.setVoice("ElevenLabs")
        await online.setAudioData(Data("mp3".utf8))
        let offline = store()
        let service = OfflineListenService(online: online, offline: offline)
        let speech = FakeSpeech()
        let player = Player(minutes: 15, service: service, speech: speech, defaults: UserDefaults(suiteName: "test-\(UUID())")!, offline: offline)
        defer { player.close() }

        await player.start()
        await waitUntil { !speech.spoken.isEmpty }
        let item = player.machine.items[0]
        player.download(item)
        await waitUntil { player.offlineIDs.contains(item.id) }
        XCTAssertEqual(player.message, "Offline gespeichert: Erster Text")
        let requests = await online.audioRequests
        XCTAssertEqual(requests, [[0, 20], [21, 34], [35, 51]], "alle Sätze, jeder einmal")
        let entries = await offline.entries()
        XCTAssertEqual(entries.map(\.item.id), ["a"])
        XCTAssertEqual(entries.first?.voice, "ElevenLabs")

        // Ohne Netz: Liste und Text aus der Kopie, Audio von der Platte.
        await online.setUnreachable(true)
        let queue = try? await service.queue(minutes: 15)
        XCTAssertEqual(queue?.items.map(\.id), ["a"])
        XCTAssertEqual(queue?.voice, "ElevenLabs")
        let text = try? await service.text(id: "a")
        XCTAssertEqual(text?.text, sample)
        let audio = try? await service.audio(id: "a", start: 21, end: 34)
        XCTAssertEqual(audio, Data("mp3".utf8))

        // Fortschritt geht in die Kopie, damit es offline an der richtigen Stelle weitergeht.
        _ = try? await service.saveProgress(id: "a", progress: 0.7, anchor: 35)
        let moved = await offline.entry(id: "a")
        XCTAssertEqual(moved?.text.anchor, 35)
        XCTAssertEqual(moved?.text.progress, 0.7)

        player.removeOffline(item)
        await waitUntil { await offline.entries().isEmpty }
        XCTAssertFalse(player.offlineIDs.contains(item.id))
    }

    func testWithoutServerVoiceOnlyTheTextIsStored() async {
        let online = FakeService()
        let offline = store()
        let player = Player(minutes: 15, service: OfflineListenService(online: online, offline: offline), speech: FakeSpeech(), defaults: UserDefaults(suiteName: "test-\(UUID())")!, offline: offline)
        defer { player.close() }
        await player.start()
        await waitUntil { !player.machine.items.isEmpty }
        player.download(player.machine.items[0])
        await waitUntil { !player.offlineIDs.isEmpty }
        let requests = await online.audioRequests
        XCTAssertEqual(requests, [], "Gerätestimme braucht kein Audio")
        let entry = await offline.entry(id: "a")
        XCTAssertNil(entry?.voice)
    }

    func testRejectedTokenIsNotHiddenByOfflineCopies() async {
        XCTAssertTrue(OfflineListenService.isUnreachable(URLError(.notConnectedToInternet)))
        XCTAssertTrue(OfflineListenService.isUnreachable(APIError(status: 502, code: nil, message: "")))
        XCTAssertFalse(OfflineListenService.isUnreachable(APIError(status: 401, code: "unauthorized", message: "")))
        XCTAssertFalse(OfflineListenService.isUnreachable(APIError(status: 404, code: "not_found", message: "")))
    }
}
