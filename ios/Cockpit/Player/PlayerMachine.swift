import AVFoundation
import CockpitShared

/// Zustand des Players ohne Audio und Netz: Ereignisse rein, Wirkungen raus. `Player` führt die
/// Wirkungen aus (Sprachausgabe, Laden, Speichern). Pause bricht den Satz ab, Weiterhören
/// spricht ihn von vorn, auch nach Anruf oder abgezogenem Kopfhörer (wie `lesen-hoeren.js`).
struct PlayerMachine: Equatable {
    enum Event: Equatable {
        case queue([QueueItem])
        /// `text` nil: Text fehlt auf dem Server, überspringen.
        case loaded(id: String, text: SpeechText?)
        case loadFailed(id: String)
        case play, pause, toggle
        case sentenceFinished
        case previousSentence, nextSentence, nextText
        case interruptionBegan
        case interruptionEnded(shouldResume: Bool)
        /// Kopfhörer abgezogen o. Ä. (`.oldDeviceUnavailable`).
        case outputLost
    }

    enum Effect: Equatable {
        case speak(String)
        case stop
        case load(id: String)
        case save(ProgressUpdate)
        /// Liste zu Ende (oder leer).
        case finished
    }

    private(set) var items: [QueueItem] = []
    /// Stelle des geladenen oder gerade ladenden Textes in `items`.
    private(set) var index: Int?
    private(set) var text: SpeechText?
    private(set) var sentence = 0
    private(set) var isPlaying = false
    private(set) var isLoading = false
    private var resumesAfterInterruption = false

    var currentItem: QueueItem? { index.map { items[$0] } }
    var currentSentence: String? { text?.text(of: sentence) }
    var currentUtterance: Utterance? { text?.utterance(of: sentence) }
    /// Der Satz danach im selben Text, zum Vorladen.
    var nextUtterance: Utterance? {
        guard let text, sentence + 1 < text.sentences.count else { return nil }
        return text.utterance(of: sentence + 1)
    }

    mutating func handle(_ event: Event) -> [Effect] {
        switch event {
        case .queue(let items):
            self.items = items
            return [.stop] + load(0)
        case .loaded(let id, let loaded):
            guard isLoading, currentItem?.id == id, let index else { return [] }
            isLoading = false
            guard let loaded, !loaded.sentences.isEmpty else { return load(index + 1) }
            text = loaded
            sentence = loaded.startSentence
            return isPlaying ? speak() : []
        case .loadFailed(let id):
            guard isLoading, currentItem?.id == id else { return [] }
            isLoading = false
            isPlaying = false
            return [.stop]
        case .play:
            resumesAfterInterruption = false
            guard !isPlaying else { return [] }
            isPlaying = true
            if text != nil { return speak() }
            return isLoading ? [] : load(index ?? 0)
        case .pause:
            resumesAfterInterruption = false
            guard isPlaying else { return [] }
            isPlaying = false
            return [.stop]
        case .toggle:
            return handle(isPlaying ? .pause : .play)
        case .sentenceFinished:
            guard isPlaying, var current = text, let index else { return [] }
            let update = current.finish(sentence)
            text = current
            guard sentence + 1 < current.sentences.count else { return [.save(update)] + load(index + 1) }
            sentence += 1
            return [.save(update)] + speak()
        case .previousSentence:
            guard text != nil else { return [] }
            sentence = max(0, sentence - 1)
            return isPlaying ? speak() : []
        case .nextSentence:
            guard let text else { return [] }
            guard sentence + 1 < text.sentences.count else { return handle(.nextText) }
            sentence += 1
            return isPlaying ? speak() : []
        case .nextText:
            guard let index else { return [] }
            return [.stop] + load(index + 1)
        case .interruptionBegan:
            guard isPlaying else { return [] }
            isPlaying = false
            resumesAfterInterruption = true
            return [.stop]
        case .interruptionEnded(let shouldResume):
            let resume = resumesAfterInterruption && shouldResume
            resumesAfterInterruption = false
            return resume ? handle(.play) : []
        case .outputLost:
            return handle(.pause)
        }
    }

    private func speak() -> [Effect] {
        currentSentence.map { [.speak($0)] } ?? []
    }

    private mutating func load(_ i: Int) -> [Effect] {
        text = nil
        sentence = 0
        guard i < items.count else {
            index = nil
            isLoading = false
            isPlaying = false
            return [.finished]
        }
        index = i
        isLoading = true
        return [.load(id: items[i].id)]
    }
}

extension PlayerMachine.Event {
    /// Aus `AVAudioSession.interruptionNotification`: Anruf, Siri oder eine andere Audio-App.
    init?(interruption info: [AnyHashable: Any]) {
        guard let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return nil }
        switch type {
        case .began:
            self = .interruptionBegan
        case .ended:
            let options = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            self = .interruptionEnded(shouldResume: options.contains(.shouldResume))
        @unknown default:
            return nil
        }
    }

    /// Aus `AVAudioSession.routeChangeNotification`: nur das Abziehen des Kopfhörers hält an.
    init?(routeChange info: [AnyHashable: Any]) {
        guard let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
        else { return nil }
        self = .outputLost
    }
}
