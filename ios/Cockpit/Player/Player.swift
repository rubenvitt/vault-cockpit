import AVFoundation
import CockpitShared
import MediaPlayer
import Network
import Observation
import OSLog
import UIKit

/// Führt aus, was `PlayerMachine` entscheidet: Sprachausgabe, Audio-Sitzung, Sperrbildschirm,
/// Fernbedienung (AirPods, Sperrbildschirm, CarPlay), Laden und Speichern mit Puffer ohne Netz.
@MainActor
@Observable
final class Player {
    static let windows = [5, 15, 30, 60]
    static let tempos = [0.8, 1.0, 1.2, 1.5, 1.8]
    static let tempoKey = "player.tempo"
    /// Grobe Sprechgeschwindigkeit bei Tempo 1 für die Zeitangaben auf dem Sperrbildschirm.
    static let charactersPerSecond = 15.0

    private(set) var machine = PlayerMachine()
    var minutes: Int
    var tempo: Double {
        didSet {
            defaults.set(tempo, forKey: Self.tempoKey)
            // Neues Tempo gleich hören: den laufenden Satz neu beginnen.
            if machine.isPlaying, let sentence = machine.currentSentence { speech.speak(sentence, tempo: tempo) }
            updateNowPlaying()
        }
    }
    /// Hinweis oder Fehler unter den Knöpfen.
    var message: String?

    private let service: (any ListenService)?
    private let speech: any SpeechOutput
    private let defaults: UserDefaults
    private var pending: PendingListening {
        didSet { pending.save(to: defaults) }
    }
    /// Laufendes Nachsenden; weitere `flush()` warten darauf, statt sofort zurückzukehren.
    @ObservationIgnored private var flushing: Task<Void, Never>?
    private var isStarted = false
    @ObservationIgnored private var commandTargets: [(MPRemoteCommand, Any)] = []
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    private let log = Logger(subsystem: "dev.rubeen.cockpit", category: "player")

    /// `service` nil: nicht angemeldet (kein Geräte-Token).
    init(minutes: Int, service: (any ListenService)?, speech: any SpeechOutput, defaults: UserDefaults) {
        self.minutes = Self.windows.contains(minutes) ? minutes : 15
        self.service = service
        self.speech = speech
        self.defaults = defaults
        let saved = defaults.double(forKey: Self.tempoKey)
        tempo = Self.tempos.contains(saved) ? saved : 1
        pending = PendingListening(defaults: defaults)
        speech.onFinish = { [weak self] in self?.send(.sentenceFinished) }
    }

    /// Player mit Token aus der Keychain und Puffer in der App Group.
    static func live(minutes: Int) -> Player {
        let config = AppConfiguration()
        let defaults = config.appGroup.isEmpty ? .standard : UserDefaults(suiteName: config.appGroup) ?? .standard
        var service: (any ListenService)?
        if let token = (try? KeychainStore(accessGroup: config.keychainGroup).token()) ?? nil {
            service = APIClient(baseURL: config.serverURL, token: token)
        }
        #if DEBUG
        if DemoListenService.isRequested { service = DemoListenService() }
        #endif
        return Player(minutes: minutes, service: service, speech: SystemSpeech(), defaults: defaults)
    }

    // MARK: Ablauf

    /// Beim Öffnen: gleich abspielen, denn die Seite hat „Abspielen“ gemeldet.
    func start() async {
        guard !isStarted else { return }
        guard service != nil else {
            message = "Bitte in der Cockpit-App neu anmelden."
            return
        }
        isStarted = true
        setUpSystem()
        // Erst den Puffer nachsenden: Sonst liefern Liste und Text den alten Stand, und der nächste
        // Satz überschreibt den höheren Fortschritt aus dem Puffer.
        await flush()
        await loadQueue()
        send(.play)
    }

    func loadQueue() async {
        guard let service else { return }
        do {
            let queue = try await service.queue(minutes: minutes)
            message = nil
            send(.queue(queue.items))
        } catch {
            message = "Wiedergabeliste ließ sich nicht laden: \(error.localizedDescription)"
        }
    }

    func send(_ event: PlayerMachine.Event) {
        // Nach `close` kommen noch Antworten laufender Abrufe: nicht wieder auf den Sperrbildschirm.
        guard isStarted else { return }
        for effect in machine.handle(event) {
            switch effect {
            case .speak(let sentence):
                activateSession()
                speech.speak(sentence, tempo: tempo)
            case .stop:
                speech.stop()
            case .load(let id):
                Task { await load(id) }
            case .save(let update):
                pending.add(update)
                Task { await flush() }
            case .finished:
                message = machine.items.isEmpty ? "Für dieses Zeitfenster passt nichts vom Stapel." : "Alles gehört."
                deactivateSession()
            }
        }
        updateNowPlaying()
    }

    /// „Das hier merken“: markiert den laufenden Satz; ohne Netz kommt die Markierung in den Puffer.
    // shortcut: merkt den Satz, der gerade läuft; wer kurz nach einem Satzwechsel tippt, bekommt den neuen (wie im Web).
    func remember() {
        guard let text = machine.text else { return }
        let highlight = text.highlight(of: machine.sentence, cid: UUID().uuidString)
        pending.add(highlight)
        Task {
            await flush()
            message = pending.contains(cid: highlight.cid ?? "") ? "Gemerkt. Wird gesendet, sobald wieder Netz da ist." : "Gemerkt."
        }
    }

    /// Beim Schließen: anhalten und alles beim System abmelden.
    func close() {
        send(.pause)
        speech.stop()
        for (command, target) in commandTargets { command.removeTarget(target) }
        commandTargets = []
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        pathMonitor?.cancel()
        pathMonitor = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        deactivateSession()
        isStarted = false
    }

    private func load(_ id: String) async {
        guard let service else { return }
        // Beim Textwechsel spielt kein Ton: ohne Hintergrund-Task könnte iOS die gesperrte App hier anhalten.
        let task = UIApplication.shared.beginBackgroundTask(withName: "Text laden")
        defer { UIApplication.shared.endBackgroundTask(task) }
        do {
            send(.loaded(id: id, text: SpeechText(try await service.text(id: id))))
        } catch let error as APIError where error.status == 404 {
            send(.loaded(id: id, text: nil))
        } catch {
            message = "Text ließ sich nicht laden: \(error.localizedDescription)"
            send(.loadFailed(id: id))
        }
    }

    /// Schickt den Puffer ab, bis er leer ist oder das Netz fehlt. Läuft das schon, wartet es darauf;
    /// die Schleife nimmt auch Aufträge mit, die währenddessen dazukommen.
    func flush() async {
        guard let service else { return }
        if flushing == nil {
            flushing = Task {
                // Ohne `await` dazwischen: Wer nach dem letzten Auftrag kommt, startet ein neues Senden.
                defer { flushing = nil }
                await sendPending(using: service)
            }
        }
        await flushing?.value
    }

    private func sendPending(using service: any ListenService) async {
        while let job = pending.next {
            do {
                switch job {
                case .progress(let update): _ = try await service.saveProgress(id: update.id, progress: update.progress, anchor: update.anchor)
                case .highlight(let highlight): _ = try await service.addHighlight(highlight)
                }
            } catch where PendingListening.shouldRetry(error) {
                return
            } catch {
                log.error("Verworfen: \(error.localizedDescription, privacy: .public)")
            }
            pending.remove(job)
        }
    }

    // MARK: System

    private func activateSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            log.error("Audio-Sitzung: \(error.localizedDescription, privacy: .public)")
        }
    }

    // Bei Pause bleibt die Sitzung aktiv, damit Sperrbildschirm und AirPods weiter an diese App gehen.
    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func setUpSystem() {
        let center = MPRemoteCommandCenter.shared()
        on(center.playCommand) { $0.send(.play) }
        on(center.pauseCommand) { $0.send(.pause) }
        on(center.togglePlayPauseCommand) { $0.send(.toggle) }
        on(center.nextTrackCommand) { $0.send(.nextText) }
        // Einen vorigen Text gibt es nicht; AirPods-Dreifachtipp heißt hier „Satz zurück“.
        on(center.previousTrackCommand) { $0.send(.previousSentence) }
        on(center.skipBackwardCommand) { $0.send(.previousSentence) }
        on(center.skipForwardCommand) { $0.send(.nextSentence) }
        on(center.likeCommand) { $0.remember() }
        on(center.bookmarkCommand) { $0.remember() }
        center.likeCommand.localizedTitle = "Das hier merken"
        center.bookmarkCommand.localizedTitle = "Das hier merken"
        center.changePlaybackRateCommand.supportedPlaybackRates = Self.tempos.map { NSNumber(value: $0) }
        on(center.changePlaybackRateCommand) { player, event in
            guard let rate = (event as? MPChangePlaybackRateCommandEvent)?.playbackRate else { return }
            player.tempo = Self.tempos.min { abs($0 - Double(rate)) < abs($1 - Double(rate)) } ?? 1
        }

        let notifications = NotificationCenter.default
        observers.append(notifications.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let event = note.userInfo.flatMap(PlayerMachine.Event.init(interruption:)) else { return }
            MainActor.assumeIsolated { self?.send(event) }
        })
        observers.append(notifications.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let event = note.userInfo.flatMap(PlayerMachine.Event.init(routeChange:)) else { return }
            MainActor.assumeIsolated { self?.send(event) }
        })

        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in await self?.flush() }
        }
        monitor.start(queue: .main)
        pathMonitor = monitor
    }

    private func on(_ command: MPRemoteCommand, _ action: @escaping (Player) -> Void) {
        on(command) { player, _ in action(player) }
    }

    private func on(_ command: MPRemoteCommand, _ action: @escaping (Player, MPRemoteCommandEvent) -> Void) {
        command.isEnabled = true
        let target = command.addTarget { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return .commandFailed }
                action(self, event)
                return .success
            }
        }
        commandTargets.append((command, target))
    }

    /// Titel, Quelle und geschätzte Dauer/Stelle (Zeichen durch Sprechgeschwindigkeit) für Sperrbildschirm und CarPlay.
    private func updateNowPlaying() {
        guard let item = machine.currentItem else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.site ?? "Cockpit",
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            // Bei Pause 0, sonst zählt der Sperrbildschirm weiter.
            MPNowPlayingInfoPropertyPlaybackRate: machine.isPlaying ? tempo : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]
        if let text = machine.text {
            info[MPMediaItemPropertyPlaybackDuration] = Double(text.length) / Self.charactersPerSecond
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = Double(text.sentences[machine.sentence].start) / Self.charactersPerSecond
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
