import SwiftUI

/// Nativer Vorlese-Player „Unterwegs hören“ (VCP-94). Öffnet sich, wenn `/lesen/hoeren` in der App
/// „Abspielen“ meldet (`BridgeMessage.listen`); `minutes` ist das Zeitfenster der Seite. Spielt
/// gleich los und läuft bei gesperrtem Bildschirm weiter (Hintergrundmodus `audio`).
struct PlayerView: View {
    @State private var player: Player
    /// Text, für den „Offline laden“ noch bestätigt werden muss (kostet Zeichen bei der Stimme vom Server).
    @State private var confirmDownload: QueueItem?
    @Environment(\.dismiss) private var dismiss

    init(minutes: Int) {
        _player = State(initialValue: Player.live(minutes: minutes))
    }

    init(player: Player) {
        _player = State(initialValue: player)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Zeitfenster", selection: $player.minutes) {
                        ForEach(Player.windows, id: \.self) { Text("\($0) Min.").tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                Section { nowPlaying }
                Section("Wiedergabeliste") {
                    ForEach(player.machine.items) { item in
                        let isCurrent = item.id == player.machine.currentItem?.id
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title)
                                Text([item.progress > 0 ? "noch \(item.remaining) Min." : "\(item.remaining) Min.", item.site].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if isCurrent {
                                Image(systemName: "speaker.wave.2.fill")
                                    .foregroundStyle(.tint)
                                    .accessibilityLabel("Läuft gerade")
                            }
                            offlineButton(item)
                        }
                        .swipeActions {
                            if player.offlineIDs.contains(item.id) {
                                Button("Offline löschen", role: .destructive) { player.removeOffline(item) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Unterwegs hören")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("Fertig") { dismiss() }
            }
            .confirmationDialog(
                "Offline laden?",
                isPresented: Binding(get: { confirmDownload != nil }, set: { if !$0 { confirmDownload = nil } }),
                titleVisibility: .visible,
                presenting: confirmDownload
            ) { item in
                Button("Offline laden") { player.download(item) }
            } message: { item in
                Text("\(player.serverVoice ?? "Die Stimme vom Server") liest dafür den ganzen Text (\(item.minutes) Min.) auf einmal vor. Das kostet Zeichen, auch für Teile, die du nicht hörst.")
            }
        }
        .task { await player.start() }
        .onDisappear { player.close() }
        .onChange(of: player.minutes) { Task { await player.loadQueue() } }
    }

    private var nowPlaying: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(player.machine.currentItem?.title ?? "Bereit")
                    .font(.headline)
                if let site = player.machine.currentItem?.site {
                    Text(site).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(player.machine.currentSentence ?? (player.machine.isLoading ? "Lädt …" : ""))
                .font(.title3)
                .frame(maxWidth: .infinity, minHeight: 80, alignment: .topLeading)
            HStack {
                control("Satz zurück", "backward.end.fill") { player.send(.previousSentence) }
                control(player.machine.isPlaying ? "Pause" : "Abspielen", player.machine.isPlaying ? "pause.circle.fill" : "play.circle.fill", size: 56) { player.send(.toggle) }
                control("Nächster Satz", "forward.end.fill") { player.send(.nextSentence) }
                control("Nächster Text", "forward.fill") { player.send(.nextText) }
            }
            .buttonStyle(.borderless)
            HStack {
                Button { player.remember() } label: {
                    Label("Das hier merken", systemImage: "highlighter")
                }
                .buttonStyle(.bordered)
                .disabled(player.machine.text == nil)
                Spacer()
                Picker("Tempo", selection: $player.tempo) {
                    ForEach(Player.tempos, id: \.self) { Text("\($0.formatted(.number.precision(.fractionLength(1))))×").tag($0) }
                }
                .accessibilityLabel("Tempo")
            }
            if let message = player.message {
                Text(message).font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 8)
    }

    /// Laden, Fortschritt oder „liegt offline“; ohne Stimme vom Server ohne Rückfrage (nur Text).
    @ViewBuilder
    private func offlineButton(_ item: QueueItem) -> some View {
        if let progress = player.downloads[item.id] {
            ProgressView(value: progress)
                .progressViewStyle(.circular)
                .accessibilityLabel("Wird offline geladen")
        } else if player.offlineIDs.contains(item.id) {
            Image(systemName: "arrow.down.circle.fill")
                .foregroundStyle(.secondary)
                .accessibilityLabel("Offline verfügbar, zum Löschen wischen")
        } else {
            Button {
                if player.serverVoice == nil { player.download(item) } else { confirmDownload = item }
            } label: {
                Image(systemName: "arrow.down.circle")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Offline laden")
        }
    }

    private func control(_ label: String, _ image: String, size: CGFloat = 28, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: image)
                .font(.system(size: size))
                .frame(maxWidth: .infinity)
        }
        .accessibilityLabel(label)
    }
}

#if DEBUG
#Preview {
    PlayerView(player: Player(minutes: 15, service: DemoListenService(), speech: SystemSpeech(), defaults: .standard))
}
#endif
