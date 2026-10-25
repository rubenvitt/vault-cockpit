import AVKit
import SwiftUI

/// Nativer Player für eine fertige Folge. Öffnet sich mit „Abspielen“ unter Lesen → Folgen
/// (`AppModel.episode`), spielt gleich los und läuft bei gesperrtem Bildschirm weiter.
struct EpisodePlayerView: View {
    @State private var player: EpisodePlayer
    @Environment(\.dismiss) private var dismiss

    init(request: AppModel.EpisodeRequest) {
        _player = State(initialValue: EpisodePlayer.live(id: request.episodeID, title: request.title, kind: request.kind, seconds: request.seconds, bytes: request.bytes))
    }

    init(player: EpisodePlayer) {
        _player = State(initialValue: player)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer(minLength: 0)
                cover
                VStack(spacing: 6) {
                    Text(player.kind.uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tint)
                    Text(player.title)
                        .font(.title3.weight(.semibold))
                        .multilineTextAlignment(.center)
                        .lineLimit(3)
                }
                if player.isLoading {
                    ProgressView("Folge wird geladen …")
                        .frame(height: 60)
                } else {
                    scrubber
                }
                controls
                HStack {
                    Menu {
                        Picker("Tempo", selection: $player.tempo) {
                            ForEach(EpisodePlayer.tempos, id: \.self) { Text("\($0.formatted(.number.precision(.fractionLength(1))))×").tag($0) }
                        }
                    } label: {
                        Label("\(player.tempo.formatted(.number.precision(.fractionLength(1))))×", systemImage: "speedometer")
                    }
                    .accessibilityLabel("Tempo")
                    Spacer()
                    RoutePicker()
                        .frame(width: 44, height: 44)
                        .accessibilityLabel("Ausgabe wählen")
                }
                if let message = player.message {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 16)
            .navigationTitle("Folge")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("Fertig") { dismiss() }
            }
        }
        // Akzent wie im Web-Cockpit (--accent).
        .tint(Color(red: 0.76, green: 0.25, blue: 0.05))
        .task { await player.start() }
        .onDisappear { player.close() }
    }

    private var cover: some View {
        RoundedRectangle(cornerRadius: 28, style: .continuous)
            .fill(LinearGradient(colors: [Color.orange, Color(red: 0.76, green: 0.25, blue: 0.05)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: 220, height: 220)
            .overlay {
                Image(systemName: player.kind == "Podcast" ? "person.2.wave.2.fill" : "waveform")
                    .font(.system(size: 76, weight: .semibold))
                    .foregroundStyle(.white)
                    .symbolEffect(.variableColor.iterative, isActive: player.isPlaying)
            }
            .shadow(color: .orange.opacity(0.35), radius: 24, y: 12)
            .scaleEffect(player.isPlaying ? 1 : 0.92)
            .animation(.spring(duration: 0.4), value: player.isPlaying)
            .accessibilityHidden(true)
    }

    private var scrubber: some View {
        VStack(spacing: 4) {
            Slider(value: $player.position, in: 0...max(player.duration, 1), onEditingChanged: { editing in
                player.isScrubbing = editing
                if !editing { player.seek(to: player.position) }
            })
            .accessibilityLabel("Stelle")
            .accessibilityValue(EpisodePlayer.clock(player.position))
            HStack {
                Text(EpisodePlayer.clock(player.position))
                Spacer()
                Text(player.duration > 0 ? "−\(EpisodePlayer.clock(player.duration - player.position))" : "–")
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .frame(height: 60)
    }

    private var controls: some View {
        HStack(spacing: 44) {
            Button { player.skip(by: -EpisodePlayer.skipBack) } label: {
                Image(systemName: "gobackward.15").font(.system(size: 32))
            }
            .accessibilityLabel("15 Sekunden zurück")
            Button { player.toggle() } label: {
                Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 76))
                    .contentTransition(.symbolEffect(.replace))
            }
            .accessibilityLabel(player.isPlaying ? "Pause" : "Abspielen")
            Button { player.skip(by: EpisodePlayer.skipForward) } label: {
                Image(systemName: "goforward.30").font(.system(size: 32))
            }
            .accessibilityLabel("30 Sekunden vor")
        }
        .buttonStyle(.borderless)
        .disabled(player.isLoading)
    }
}

/// AirPlay und Bluetooth-Ausgabe wählen.
private struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        return view
    }

    func updateUIView(_ view: AVRoutePickerView, context: Context) {}
}

#if DEBUG
#Preview {
    EpisodePlayerView(player: EpisodePlayer(id: "demo", title: "Podcast: Vom Lesen und 3 weitere", kind: "Podcast", api: nil, defaults: .standard))
}
#endif
