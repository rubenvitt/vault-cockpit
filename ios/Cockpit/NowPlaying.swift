import SwiftUI

extension AppModel {
    /// Der eine Player, der gerade spielt oder angehalten bereitliegt: „Unterwegs hören“ oder eine Folge.
    @MainActor
    enum NowPlaying {
        case listening(Player)
        case episode(EpisodePlayer)

        var title: String {
            switch self {
            case .listening(let player): player.machine.currentItem?.title ?? "Unterwegs hören"
            case .episode(let player): player.title
            }
        }

        var subtitle: String {
            switch self {
            case .listening(let player):
                if player.machine.isLoading { return "Lädt …" }
                return player.machine.currentItem?.site ?? "Unterwegs hören"
            case .episode(let player):
                if player.isLoading { return "Lädt …" }
                let length = player.duration > 0 ? EpisodePlayer.clock(player.duration) : "–"
                return "\(player.kind) · \(EpisodePlayer.clock(player.position)) / \(length)"
            }
        }

        var symbol: String {
            switch self {
            case .listening: "text.bubble.fill"
            case .episode(let player): player.kind == "Podcast" ? "person.2.wave.2.fill" : "waveform"
            }
        }

        var isPlaying: Bool {
            switch self {
            case .listening(let player): player.machine.isPlaying
            case .episode(let player): player.isPlaying
            }
        }

        /// Stelle in der Folge, 0…1; beim Vorlesen gibt es keine feste Länge.
        var progress: Double? {
            guard case .episode(let player) = self, player.duration > 0 else { return nil }
            return min(1, max(0, player.position / player.duration))
        }

        func toggle() {
            switch self {
            case .listening(let player): player.send(.toggle)
            case .episode(let player): player.toggle()
            }
        }

        /// Anhalten und beim System abmelden (Sperrbildschirm, Fernbedienung, Audio-Sitzung).
        func close() {
            switch self {
            case .listening(let player): player.close()
            case .episode(let player): player.close()
            }
        }
    }

    /// Baut die Player mit Token aus der Keychain; Tests geben eigene ohne Netz und Ton.
    @MainActor
    struct PlayerFactory {
        var listening: @MainActor (Int) -> Player
        var episode: @MainActor (EpisodeRequest) -> EpisodePlayer

        static let live = PlayerFactory(
            listening: { Player.live(minutes: $0) },
            episode: { EpisodePlayer.live(id: $0.episodeID, title: $0.title, kind: $0.kind, seconds: $0.seconds, bytes: $0.bytes) }
        )
    }
}

/// Großer Player als Blatt (`AppModel.showsPlayer`). „Fertig“ schließt nur das Blatt, die
/// Wiedergabe läuft weiter und steht als Leiste über den Reitern.
struct NowPlayingSheet: View {
    let model: AppModel

    var body: some View {
        switch model.nowPlaying {
        case .listening(let player): PlayerView(player: player, stop: model.closePlayer)
        case .episode(let player): EpisodePlayerView(player: player, stop: model.closePlayer)
        case nil: EmptyView()
        }
    }
}

/// Leiste über der Tableiste mit dem, was gerade spielt: Tippen öffnet den großen Player,
/// daneben Abspielen/Pause und Beenden.
struct NowPlayingBar: View {
    let model: AppModel

    var body: some View {
        if let now = model.nowPlaying {
            HStack(spacing: 4) {
                Button { model.showsPlayer = true } label: {
                    HStack(spacing: 12) {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(LinearGradient(colors: [Color.orange, Theme.accent], startPoint: .topLeading, endPoint: .bottomTrailing))
                            .frame(width: 40, height: 40)
                            .overlay {
                                Image(systemName: now.symbol)
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .symbolEffect(.variableColor.iterative, isActive: now.isPlaying)
                            }
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(now.title)
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                            Text(now.subtitle)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .combine)
                .accessibilityHint("Öffnet den Player")
                Button { now.toggle() } label: {
                    Image(systemName: now.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title3)
                        .frame(width: 44, height: 44)
                        .contentTransition(.symbolEffect(.replace))
                }
                .accessibilityLabel(now.isPlaying ? "Pause" : "Abspielen")
                Button { model.closePlayer() } label: {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 44)
                }
                .accessibilityLabel("Wiedergabe beenden")
            }
            .buttonStyle(.borderless)
            .padding(.leading, 8)
            .padding(.trailing, 4)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(alignment: .bottom) {
                if let progress = now.progress {
                    GeometryReader { geo in
                        Capsule()
                            .fill(Theme.accent)
                            .frame(width: geo.size.width * progress, height: 2)
                    }
                    .frame(height: 2)
                    .padding(.horizontal, 14)
                    .accessibilityHidden(true)
                }
            }
            .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
            .padding(.horizontal, 8)
            .padding(.bottom, 6)
            .tint(Theme.accent)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

extension View {
    /// Leiste „Läuft gerade“ über der Tableiste; der Inhalt rückt nach oben, nichts liegt darunter.
    func nowPlayingBar(_ model: AppModel) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            NowPlayingBar(model: model)
                .animation(.spring(duration: 0.35), value: model.nowPlaying == nil)
        }
    }
}
