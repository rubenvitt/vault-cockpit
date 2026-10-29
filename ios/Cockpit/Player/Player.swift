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

    private(set) var machine = PlayerMachine()
    var minutes: Int
    var tempo: Double {
        didSet {
            defaults.set(tempo, forKey: Self.tempoKey)
            // Neues Tempo gleich hören: den laufenden Satz neu beginnen.
            if machine.isPlaying, let utterance = machine.currentUtterance {
                speaking = (Date(), utterance.end - utterance.start)
                speech.speak(utterance, tempo: tempo)
            }
            updateNowPlaying()
        }
    }
    /// Hinweis oder Fehler unter den Knöpfen.
    var message: String?
    /// Texte mit Offline-Kopie (`OfflineStore`).
    private(set) var offlineIDs: Set<String> = []
    /// Laufendes Offline-Laden je Text, 0…1.
    private(set) var downloads: [String: Double] = [:]
    /// Stimme vom Server laut letzter Wiedergabeliste; offline geladen werden dann auch die Sätze.
    private(set) var serverVoice: String?
    /// Der Server hat den Geräte-Token abgelehnt (401): Die App meldet neu an (`AppModel.apiUnauthorized`).
    @ObservationIgnored var onUnauthorized: (() -> Void)?

    private let service: (any ListenService)?
    private let offline: OfflineStore?
    private let speech: any SpeechOutput
    private let defaults: UserDefaults
    private var pending: PendingListening {
        didSet { pending.save(to: defaults) }
    }
    /// Laufendes Nachsenden; weitere `flush()` warten darauf, statt sofort zurückzukehren.
    @ObservationIgnored private var flushing: Task<[String: String], Never>?
    private var isStarted = false
    @ObservationIgnored private var commandTargets: [(MPRemoteCommand, Any)] = []
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    /// Der nächste Text der Liste, schon geladen, solange der laufende spielt: Der Wechsel klappt
    /// dann auch bei gesperrtem Bildschirm und ohne Netz. Nur einer, der Schlüssel ist seine ID.
    @ObservationIgnored private var prefetched: (id: String, text: SpeechText)?
    /// ID des vorgeladenen Textes (für Tests).
    var prefetchedID: String? { prefetched?.id }
    /// Gelernte Sprechgeschwindigkeit für Dauer und Stelle auf dem Sperrbildschirm.
    @ObservationIgnored private var rate: SpeechRate
    /// Beginn und Länge des Satzes, der gerade gesprochen wird, zum Nachmessen.
    @ObservationIgnored private var speaking: (start: Date, units: Int)?
    private let log = Logger(subsystem: "dev.rubeen.cockpit", category: "player")

    /// `service` nil: nicht angemeldet (kein Geräte-Token). `offline`: Offline-Kopien, nil = ohne.
    init(minutes: Int, service: (any ListenService)?, speech: any SpeechOutput, defaults: UserDefaults, offline: OfflineStore? = nil) {
        self.minutes = Self.windows.contains(minutes) ? minutes : 15
        self.service = service
        self.offline = offline
        self.speech = speech
        self.defaults = defaults
        let saved = defaults.double(forKey: Self.tempoKey)
        tempo = Self.tempos.contains(saved) ? saved : 1
        pending = PendingListening(defaults: defaults)
        rate = SpeechRate(defaults: defaults)
        speech.onFinish = { [weak self] in
            self?.measureSentence()
            self?.send(.sentenceFinished)
        }
        speech.onNotice = { [weak self] in self?.message = $0 }
    }

    /// Player mit Token aus der Keychain und Puffer in der App Group.
    static func live(minutes: Int) -> Player {
        let config = AppConfiguration()
        let defaults = config.appGroup.isEmpty ? .standard : UserDefaults(suiteName: config.appGroup) ?? .standard
        var service: (any ListenService)?
        let offline = OfflineStore(root: OfflineStore.defaultRoot)
        let keychain = KeychainStore(accessGroup: config.keychainGroup)
        if ((try? keychain.token()) ?? nil) != nil {
            service = OfflineListenService(online: KeychainListenService(baseURL: config.serverURL, keychain: keychain), offline: offline)
        }
        #if DEBUG
        if DemoListenService.isRequested { service = DemoListenService() }
        #endif
        // Stimme vom Server, wenn die Wiedergabeliste eine nennt; sonst und bei Ausfall die des Geräts.
        var speech: any SpeechOutput = SystemSpeech()
        if let service { speech = ServerSpeech(service: service, fallback: SystemSpeech()) }
        return Player(minutes: minutes, service: service, speech: speech, defaults: defaults, offline: offline)
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
        if let offline { offlineIDs = Set(await offline.entries().map(\.item.id)) }
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
            serverVoice = queue.voice
            speech.use(serverVoice: queue.voice)
            prefetched = nil
            send(.queue(queue.items))
        } catch {
            if (error as? APIError)?.isUnauthorized == true { onUnauthorized?() }
            message = "Wiedergabeliste ließ sich nicht laden: \(error.localizedDescription)"
        }
    }

    func send(_ event: PlayerMachine.Event) {
        // Nach `close` kommen noch Antworten laufender Abrufe: nicht wieder auf den Sperrbildschirm.
        guard isStarted else { return }
        for effect in machine.handle(event) {
            switch effect {
            case .speak:
                guard let utterance = machine.currentUtterance else { break }
                activateSession()
                speaking = (Date(), utterance.end - utterance.start)
                speech.speak(utterance, tempo: tempo)
                if let next = machine.nextUtterance { speech.prepare(next) }
            case .stop:
                speaking = nil
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
        let cid = UUID().uuidString
        pending.add(text.highlight(of: machine.sentence, cid: cid))
        Task {
            if let reason = await flush()[cid] {
                message = "Nicht gemerkt: \(reason)"
            } else {
                message = pending.contains(cid: cid) ? "Gemerkt. Wird gesendet, sobald wieder Netz da ist." : "Gemerkt."
            }
        }
    }

    /// Lädt Text und, mit Stimme vom Server, alle Sätze als Audio auf das Gerät. Schon geladene
    /// Sätze (abgebrochener Versuch, gerade gehört) holt es nicht noch einmal.
    func download(_ item: QueueItem) {
        guard let service, let offline, downloads[item.id] == nil else { return }
        downloads[item.id] = 0
        let voice = serverVoice
        Task {
            // Weiterladen, auch wenn die App kurz in den Hintergrund geht.
            let task = UIApplication.shared.beginBackgroundTask(withName: "Offline laden")
            defer {
                UIApplication.shared.endBackgroundTask(task)
                downloads[item.id] = nil
            }
            do {
                let listen = try await service.text(id: item.id)
                let text = SpeechText(listen)
                if voice != nil {
                    for (i, s) in text.sentences.enumerated() {
                        if await offline.audio(id: item.id, start: s.start, end: s.end) == nil {
                            let data = try await service.audio(id: item.id, start: s.start, end: s.end)
                            try await offline.saveAudio(data, id: item.id, start: s.start, end: s.end)
                        }
                        downloads[item.id] = Double(i + 1) / Double(max(text.sentences.count, 1))
                    }
                }
                try await offline.save(.init(item: item, text: listen, voice: voice, savedAt: Date()))
                offlineIDs.insert(item.id)
                message = "Offline gespeichert: \(item.title)"
            } catch {
                log.error("Offline laden: \(error.localizedDescription, privacy: .public)")
                message = "Offline laden fehlgeschlagen: \(error.localizedDescription)"
            }
        }
    }

    func removeOffline(_ item: QueueItem) {
        guard let offline else { return }
        offlineIDs.remove(item.id)
        Task { await offline.remove(id: item.id) }
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
        if let ready = prefetched, ready.id == id {
            prefetched = nil
            send(.loaded(id: id, text: ready.text))
            await prefetchNext()
            return
        }
        // Beim Textwechsel spielt kein Ton: ohne Hintergrund-Task könnte iOS die gesperrte App hier anhalten.
        let task = UIApplication.shared.beginBackgroundTask(withName: "Text laden")
        defer { UIApplication.shared.endBackgroundTask(task) }
        do {
            send(.loaded(id: id, text: SpeechText(try await service.text(id: id))))
        } catch let error as APIError where error.status == 404 {
            send(.loaded(id: id, text: nil))
            return
        } catch {
            if (error as? APIError)?.isUnauthorized == true { onUnauthorized?() }
            message = "Text ließ sich nicht laden: \(error.localizedDescription)"
            send(.loadFailed(id: id))
            return
        }
        await prefetchNext()
    }

    /// Lädt den Text nach dem laufenden vor, während dieser spielt (Audio-Sitzung aktiv, die App
    /// läuft also auch gesperrt). Fehler sind still: Beim Wechsel lädt `load` dann wie bisher.
    // shortcut: nur der Text; mit Stimme vom Server holt `ServerSpeech` den ersten Satz erst beim Wechsel und liest ohne Netz mit der Gerätestimme.
    private func prefetchNext() async {
        guard let service, let next = machine.nextItem, prefetched?.id != next.id else { return }
        let listen: ListenText
        do {
            listen = try await service.text(id: next.id)
        } catch {
            // Nur ein abgelehnter Token zählt: Sonst merkt die App ihn erst beim nächsten Wechsel.
            if (error as? APIError)?.isUnauthorized == true { onUnauthorized?() }
            return
        }
        // Inzwischen weitergesprungen: nur behalten, wenn er noch der nächste ist.
        if machine.nextItem?.id == next.id { prefetched = (next.id, SpeechText(listen)) }
    }

    /// Satz zu Ende gesprochen: echte Sprechzeit in die gelernte Geschwindigkeit. Abgebrochene
    /// Sätze (Pause, Sprung, neues Tempo) kommen nicht hier an, `speaking` ist dann neu oder nil.
    private func measureSentence() {
        guard let speaking, machine.isPlaying else { return }
        self.speaking = nil
        if rate.record(units: speaking.units, seconds: Date().timeIntervalSince(speaking.start), tempo: tempo) {
            rate.save(to: defaults)
        }
    }

    /// Schickt den Puffer ab, bis er leer ist oder das Netz fehlt. Läuft das schon, wartet es darauf;
    /// die Schleife nimmt auch Aufträge mit, die währenddessen dazukommen. Ergebnis je Auftrag:
    /// gesendet (aus dem Puffer), wartet (bleibt im Puffer) oder abgelehnt (zurückgegeben als
    /// `cid` → Meldung des Servers, nur Markierungen; abgelehnter Fortschritt wird nur geloggt).
    @discardableResult
    func flush() async -> [String: String] {
        guard let service else { return [:] }
        if flushing == nil {
            flushing = Task {
                // Ohne `await` dazwischen: Wer nach dem letzten Auftrag kommt, startet ein neues Senden.
                defer { flushing = nil }
                return await sendPending(using: service)
            }
        }
        return await flushing?.value ?? [:]
    }

    private func sendPending(using service: any ListenService) async -> [String: String] {
        var rejected: [String: String] = [:]
        while let job = pending.next {
            do {
                switch job {
                case .progress(let update): _ = try await service.saveProgress(id: update.id, progress: update.progress, anchor: update.anchor)
                case .highlight(let highlight): _ = try await service.addHighlight(highlight)
                }
            } catch where PendingListening.shouldRetry(error) {
                if (error as? APIError)?.isUnauthorized == true { onUnauthorized?() }
                return rejected
            } catch {
                log.error("Verworfen: \(error.localizedDescription, privacy: .public)")
                if case .highlight(let highlight) = job, let cid = highlight.cid { rejected[cid] = error.localizedDescription }
            }
            pending.remove(job)
        }
        return rejected
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
        on(center.playCommand, "play") { $0.send(.play) }
        on(center.pauseCommand, "pause") { $0.send(.pause) }
        on(center.togglePlayPauseCommand, "togglePlayPause") { $0.send(.toggle) }
        on(center.nextTrackCommand, "nextTrack") { $0.send(.nextText) }
        // Einen vorigen Text gibt es nicht; AirPods-Dreifachtipp heißt hier „Satz zurück“.
        on(center.previousTrackCommand, "previousTrack") { $0.send(.previousSentence) }
        on(center.skipBackwardCommand, "skipBackward") { $0.send(.previousSentence) }
        on(center.skipForwardCommand, "skipForward") { $0.send(.nextSentence) }
        on(center.likeCommand, "like") { $0.remember() }
        on(center.bookmarkCommand, "bookmark") { $0.remember() }
        center.likeCommand.localizedTitle = "Das hier merken"
        center.bookmarkCommand.localizedTitle = "Das hier merken"
        center.changePlaybackRateCommand.supportedPlaybackRates = Self.tempos.map { NSNumber(value: $0) }
        on(center.changePlaybackRateCommand, "changePlaybackRate") { player, event in
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

    private func on(_ command: MPRemoteCommand, _ name: String, _ action: @escaping (Player) -> Void) {
        on(command, name) { player, _ in action(player) }
    }

    /// `name` steht im Log (Kategorie `player`, Konsole am Mac): So lässt sich am Gerät ablesen,
    /// welche Befehle AirPods, Sperrbildschirm und CarPlay wirklich schicken.
    private func on(_ command: MPRemoteCommand, _ name: String, _ action: @escaping (Player, MPRemoteCommandEvent) -> Void) {
        command.isEnabled = true
        let target = command.addTarget { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return .commandFailed }
                self.log.info("Fernbedienung: \(name, privacy: .public)")
                action(self, event)
                return .success
            }
        }
        commandTargets.append((command, target))
    }

    /// Titel, Quelle und geschätzte Dauer/Stelle (Zeichen durch gelernte Sprechgeschwindigkeit) für Sperrbildschirm und CarPlay.
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
            info[MPMediaItemPropertyPlaybackDuration] = Double(text.length) / rate.charactersPerSecond
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = Double(text.sentences[machine.sentence].start) / rate.charactersPerSecond
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
