import AVFoundation
import OSLog

/// Sprachausgabe hinter einem Protokoll, damit Tests ohne Audio laufen.
@MainActor
protocol SpeechOutput: AnyObject {
    /// Der zuletzt mit `speak` begonnene Satz ist zu Ende (nicht nach `stop`).
    var onFinish: (() -> Void)? { get set }
    /// Spricht `text` und bricht einen laufenden Satz ab. `tempo` 1 = normal.
    func speak(_ text: String, tempo: Double)
    func stop()
}

@MainActor
final class SystemSpeech: NSObject, SpeechOutput, AVSpeechSynthesizerDelegate {
    var onFinish: (() -> Void)?
    private let synthesizer = AVSpeechSynthesizer()
    private let voice = SystemSpeech.bestGermanVoice()
    private var current: AVSpeechUtterance?
    private let log = Logger(subsystem: "dev.rubeen.cockpit", category: "player")

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Beste installierte `de-DE`-Stimme: Premium vor Enhanced; ohne solche die Standardstimme.
    /// Spaßstimmen (Eloquence u. Ä.) und die eigene Stimme bleiben außen vor.
    static func bestGermanVoice() -> AVSpeechSynthesisVoice? {
        let better = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == "de-DE" && $0.quality != .default && $0.voiceTraits.isDisjoint(with: [.isNoveltyVoice, .isPersonalVoice]) }
            .max { $0.quality.rawValue < $1.quality.rawValue }
        return better ?? AVSpeechSynthesisVoice(language: "de-DE")
    }

    func speak(_ text: String, tempo: Double) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        // `rate` läuft 0…1 mit 0,5 als normal, nicht linear; für 0,8–1,8 reicht die Näherung.
        utterance.rate = min(AVSpeechUtteranceDefaultSpeechRate * Float(tempo), AVSpeechUtteranceMaximumSpeechRate)
        current = utterance
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        synthesizer.speak(utterance)
        log.debug("Spricht mit \(self.voice?.identifier ?? "?", privacy: .public): \(text, privacy: .private)")
    }

    func stop() {
        current = nil
        synthesizer.stopSpeaking(at: .immediate)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let finished = ObjectIdentifier(utterance)
        Task { @MainActor in
            // Späte Meldungen abgebrochener Sätze ignorieren.
            guard let current, ObjectIdentifier(current) == finished else { return }
            self.current = nil
            onFinish?()
        }
    }
}
