import AVFoundation
import CockpitShared
import MediaPlayer
import Observation
import OSLog
import UIKit

/// Spielt eine fertige Folge (`/lesen/folgen`, Podcast, Report, Vorlesen) als MP3 mit `AVPlayer`:
/// Sperrbildschirm und Kontrollzentrum (Titel, Stelle, Tempo), Fernbedienung (AirPods, CarPlay),
/// läuft bei gesperrtem Gerät weiter. Die MP3 kommt einmal über `/api/app/folge` in den Cache und
/// spielt danach auch ohne Netz; die Stelle bleibt je Folge gemerkt.
@MainActor
@Observable
final class EpisodePlayer {
    static let tempos = [0.8, 1.0, 1.2, 1.5, 1.8]
    static let skipBack = 15.0
    static let skipForward = 30.0

    let id: String
    let title: String
    let kind: String
    private(set) var isLoading = false
    private(set) var isPlaying = false
    /// Länge in Sekunden, 0 bis sie bekannt ist.
    private(set) var duration: Double = 0
    /// Stelle in Sekunden; beim Ziehen des Reglers setzt die Ansicht sie selbst.
    var position: Double = 0
    var isScrubbing = false
    var message: String?
    var tempo: Double {
        didSet {
            defaults.set(tempo, forKey: Player.tempoKey)
            player?.defaultRate = Float(tempo)
            if isPlaying { player?.rate = Float(tempo) }
            updateNowPlaying()
        }
    }

    private let api: APIClient?
    private let defaults: UserDefaults
    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var commandTargets: [(MPRemoteCommand, Any)] = []
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var lastSaved = Date.distantPast
    @ObservationIgnored private var interrupted = false
    private let log = Logger(subsystem: "dev.rubeen.cockpit", category: "folge")

    /// `api` nil: nicht angemeldet; eine Folge im Cache spielt trotzdem.
    init(id: String, title: String, kind: String, api: APIClient?, defaults: UserDefaults) {
        self.id = id
        self.title = title
        self.kind = kind
        self.api = api
        self.defaults = defaults
        let saved = defaults.double(forKey: Player.tempoKey)
        tempo = Self.tempos.contains(saved) ? saved : 1
    }

    static func live(id: String, title: String, kind: String) -> EpisodePlayer {
        let config = AppConfiguration()
        let defaults = config.appGroup.isEmpty ? .standard : UserDefaults(suiteName: config.appGroup) ?? .standard
        var api: APIClient?
        if let token = (try? KeychainStore(accessGroup: config.keychainGroup).token()) ?? nil {
            api = APIClient(baseURL: config.serverURL, token: token)
        }
        return EpisodePlayer(id: id, title: title, kind: kind, api: api, defaults: defaults)
    }

    /// Ablage im Cache; die ID kommt von der Seite, deshalb nur sichere Zeichen im Dateinamen.
    nonisolated static func file(for id: String) -> URL {
        let safe = String(id.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" }.prefix(80).map(Character.init))
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appending(path: "Folgen", directoryHint: .isDirectory).appending(path: "\(safe.isEmpty ? "folge" : safe).mp3")
    }

    /// `75` → `1:15`, `3725` → `1:02:05`.
    nonisolated static func clock(_ seconds: Double) -> String {
        let t = seconds.isFinite ? max(0, Int(seconds)) : 0
        let (h, m, s) = (t / 3600, t % 3600 / 60, t % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    private var spotKey: String { "folge.stelle.\(id)" }

    // MARK: Ablauf

    /// Beim Öffnen: laden (falls nicht im Cache), an der gemerkten Stelle ansetzen, abspielen.
    func start() async {
        guard player == nil, !isLoading else { return }
        let file = Self.file(for: id)
        if !FileManager.default.fileExists(atPath: file.path) {
            guard let api else {
                message = "Bitte in der Cockpit-App neu anmelden."
                return
            }
            isLoading = true
            // Weiterladen, auch wenn die App kurz in den Hintergrund geht.
            let task = UIApplication.shared.beginBackgroundTask(withName: "Folge laden")
            defer {
                UIApplication.shared.endBackgroundTask(task)
                isLoading = false
            }
            do {
                try await api.downloadEpisode(id: id, to: file)
            } catch {
                log.error("Folge laden: \(error.localizedDescription, privacy: .public)")
                message = "Folge ließ sich nicht laden: \(error.localizedDescription)"
                return
            }
        }
        let item = AVPlayerItem(url: file)
        let player = AVPlayer(playerItem: item)
        player.defaultRate = Float(tempo)
        self.player = player
        let length = (try? await item.asset.load(.duration))?.seconds ?? 0
        duration = length.isFinite ? length : 0
        let saved = defaults.double(forKey: spotKey)
        if saved > 3, duration == 0 || saved < duration - 5 {
            position = saved
            _ = await player.seek(to: CMTime(seconds: saved, preferredTimescale: 600))
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            MainActor.assumeIsolated { self?.tick(time.seconds) }
        }
        observers.append(NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.finished() }
        })
        setUpSystem()
        play()
    }

    func play() {
        guard let player else { return }
        activateSession()
        player.defaultRate = Float(tempo)
        player.play()
        isPlaying = true
        updateNowPlaying()
    }

    func pause() {
        player?.pause()
        isPlaying = false
        saveSpot(force: true)
        updateNowPlaying()
    }

    func toggle() {
        if isPlaying { pause() } else { play() }
    }

    func skip(by seconds: Double) {
        seek(to: position + seconds)
    }

    func seek(to seconds: Double) {
        guard let player else { return }
        let target = min(max(0, seconds), duration > 0 ? duration : seconds)
        position = target
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        saveSpot(force: true)
        updateNowPlaying()
    }

    /// Beim Schließen: anhalten, Stelle merken, beim System abmelden.
    func close() {
        if player != nil { pause() }
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        timeObserver = nil
        player = nil
        for (command, target) in commandTargets { command.removeTarget(target) }
        commandTargets = []
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func tick(_ seconds: Double) {
        guard seconds.isFinite, !isScrubbing else { return }
        position = seconds
        saveSpot()
    }

    private func finished() {
        isPlaying = false
        position = 0
        defaults.removeObject(forKey: spotKey)
        player?.seek(to: .zero)
        updateNowPlaying()
    }

    /// Höchstens alle 5 Sekunden; am Anfang und kurz vor Schluss gibt es keine Stelle zu merken.
    private func saveSpot(force: Bool = false) {
        guard force || Date.now.timeIntervalSince(lastSaved) > 5 else { return }
        lastSaved = .now
        if position > 3, duration == 0 || duration - position > 5 {
            defaults.set(position, forKey: spotKey)
        } else {
            defaults.removeObject(forKey: spotKey)
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

    private func setUpSystem() {
        let center = MPRemoteCommandCenter.shared()
        on(center.playCommand) { $0.play() }
        on(center.pauseCommand) { $0.pause() }
        on(center.togglePlayPauseCommand) { $0.toggle() }
        center.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.skipBack)]
        center.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.skipForward)]
        on(center.skipBackwardCommand) { $0.skip(by: -Self.skipBack) }
        on(center.skipForwardCommand) { $0.skip(by: Self.skipForward) }
        on(center.changePlaybackPositionCommand) { player, event in
            guard let time = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime else { return }
            player.seek(to: time)
        }
        center.changePlaybackRateCommand.supportedPlaybackRates = Self.tempos.map { NSNumber(value: $0) }
        on(center.changePlaybackRateCommand) { player, event in
            guard let rate = (event as? MPChangePlaybackRateCommandEvent)?.playbackRate else { return }
            player.tempo = Self.tempos.min { abs($0 - Double(rate)) < abs($1 - Double(rate)) } ?? 1
        }
        // Ohne vorige/nächste Folge zeigt der Sperrbildschirm sonst Titel-Sprünge statt ±Sekunden.
        for command in [center.nextTrackCommand, center.previousTrackCommand, center.likeCommand, center.bookmarkCommand] {
            command.isEnabled = false
        }

        let notifications = NotificationCenter.default
        observers.append(notifications.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }
            let options = AVAudioSession.InterruptionOptions(rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            MainActor.assumeIsolated {
                guard let self else { return }
                switch type {
                case .began:
                    // Anruf, Siri, Wecker: anhalten und danach fortsetzen, wenn das System es erlaubt.
                    if self.isPlaying {
                        self.interrupted = true
                        self.pause()
                    }
                case .ended:
                    if self.interrupted, options.contains(.shouldResume) { self.play() }
                    self.interrupted = false
                @unknown default:
                    break
                }
            }
        })
        observers.append(notifications.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
            else { return }
            // Kopfhörer ab: anhalten statt laut weiterzuspielen.
            MainActor.assumeIsolated { self?.pause() }
        })
    }

    private func on(_ command: MPRemoteCommand, _ action: @escaping (EpisodePlayer) -> Void) {
        on(command) { player, _ in action(player) }
    }

    private func on(_ command: MPRemoteCommand, _ action: @escaping (EpisodePlayer, MPRemoteCommandEvent) -> Void) {
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

    /// Titel, Art, Länge und Stelle für Sperrbildschirm, Kontrollzentrum und CarPlay.
    private func updateNowPlaying() {
        guard player != nil else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: "Cockpit · \(kind)",
            MPMediaItemPropertyAlbumTitle: "Folgen aus dem Lesestapel",
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            // Bei Pause 0, sonst zählt der Sperrbildschirm weiter.
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? tempo : 0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        if let image = UIImage(named: "Logo") {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
