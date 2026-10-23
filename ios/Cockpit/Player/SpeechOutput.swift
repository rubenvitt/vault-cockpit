import AVFoundation
import OSLog
import UIKit

/// Ein Satz zum Vorlesen mit seiner Stelle im Text (UTF-16-Einheiten wie der Server), damit die
/// Stimme vom Server ihn über `/api/app/audio` holen kann.
struct Utterance: Hashable {
    let id: String
    let text: String
    let start: Int
    let end: Int
}

/// Sprachausgabe hinter einem Protokoll, damit Tests ohne Audio laufen.
@MainActor
protocol SpeechOutput: AnyObject {
    /// Der zuletzt mit `speak` begonnene Satz ist zu Ende (nicht nach `stop`).
    var onFinish: (() -> Void)? { get set }
    /// Hinweis für den Player, z. B. dass die Gerätestimme übernimmt.
    var onNotice: ((String) -> Void)? { get set }
    /// Spricht den Satz und bricht einen laufenden ab. `tempo` 1 = normal.
    func speak(_ utterance: Utterance, tempo: Double)
    /// Holt einen Satz schon vorab, damit zwischen zwei Sätzen keine Pause entsteht.
    func prepare(_ utterance: Utterance)
    /// Anbieter der Stimme vom Server laut Wiedergabeliste, nil = Gerät.
    func use(serverVoice: String?)
    func stop()
}

extension SpeechOutput {
    func prepare(_ utterance: Utterance) {}
    func use(serverVoice: String?) {}
}

@MainActor
final class SystemSpeech: NSObject, SpeechOutput, AVSpeechSynthesizerDelegate {
    var onFinish: (() -> Void)?
    var onNotice: ((String) -> Void)?
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

    func speak(_ sentence: Utterance, tempo: Double) {
        let text = sentence.text
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

/// Stimme vom Server (z. B. ElevenLabs): holt jeden Satz als MP3 über die App-API und spielt ihn mit
/// `AVAudioPlayer`, den nächsten lädt sie schon vorab. Ohne Stimme in der Wiedergabeliste oder nach
/// einem Fehler (Kontingent, kein Netz) liest `fallback` vor, bis der Player schließt.
@MainActor
final class ServerSpeech: NSObject, SpeechOutput, AVAudioPlayerDelegate {
    var onFinish: (() -> Void)?
    var onNotice: ((String) -> Void)?
    private let service: any ListenService
    private let fallback: any SpeechOutput
    private var voice: String?
    private var isDown = false
    private var audio: AVAudioPlayer?
    /// Geladene oder ladende Sätze, höchstens `keep`; `order` vom ältesten zum neuesten.
    private var clips: [Utterance: Task<Data, Error>] = [:]
    private var order: [Utterance] = []
    private let keep = 4
    /// Verwirft Ergebnisse abgebrochener Sätze.
    private var generation = 0
    private let log = Logger(subsystem: "dev.rubeen.cockpit", category: "player")

    private struct PlaybackFailed: LocalizedError {
        var errorDescription: String? { "Audio ließ sich nicht abspielen" }
    }

    init(service: any ListenService, fallback: any SpeechOutput) {
        self.service = service
        self.fallback = fallback
        super.init()
        fallback.onFinish = { [weak self] in self?.onFinish?() }
    }

    private var usesServer: Bool { voice != nil && !isDown }

    func use(serverVoice: String?) {
        voice = serverVoice
        if serverVoice == nil { forgetAll() }
    }

    func speak(_ utterance: Utterance, tempo: Double) {
        generation += 1
        audio?.stop()
        audio = nil
        guard usesServer else { return fallback.speak(utterance, tempo: tempo) }
        let mine = generation
        let pending = clip(for: utterance)
        Task {
            // Beim Laden spielt kein Ton: ohne Hintergrund-Task könnte iOS die gesperrte App hier anhalten.
            let background = UIApplication.shared.beginBackgroundTask(withName: "Satz laden")
            defer { UIApplication.shared.endBackgroundTask(background) }
            do {
                let data = try await pending.value
                guard mine == generation else { return }
                try play(data, tempo: tempo)
            } catch {
                guard mine == generation else { return }
                isDown = true
                forgetAll()
                log.error("Stimme vom Server: \(error.localizedDescription, privacy: .public)")
                let reason = error.localizedDescription.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
                onNotice?("\(reason). Die Gerätestimme liest weiter.")
                fallback.speak(utterance, tempo: tempo)
            }
        }
    }

    func prepare(_ utterance: Utterance) {
        guard usesServer else { return }
        _ = clip(for: utterance)
    }

    func stop() {
        generation += 1
        audio?.stop()
        audio = nil
        fallback.stop()
    }

    private func play(_ data: Data, tempo: Double) throws {
        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        player.enableRate = true
        player.rate = Float(tempo)
        player.prepareToPlay()
        audio = player
        guard player.play() else {
            audio = nil
            throw PlaybackFailed()
        }
    }

    private func clip(for utterance: Utterance) -> Task<Data, Error> {
        if let task = clips[utterance] { return task }
        let service = self.service
        let task = Task { try await service.audio(id: utterance.id, start: utterance.start, end: utterance.end) }
        clips[utterance] = task
        order.append(utterance)
        // Ältere nur vergessen, nicht abbrechen: Ein laufender `speak` wartet vielleicht noch darauf.
        while order.count > keep { clips[order.removeFirst()] = nil }
        return task
    }

    private func forgetAll() {
        clips = [:]
        order = []
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let finished = ObjectIdentifier(player)
        Task { @MainActor in
            // Späte Meldungen abgebrochener Sätze ignorieren.
            guard let audio, ObjectIdentifier(audio) == finished else { return }
            self.audio = nil
            onFinish?()
        }
    }
}
