import CockpitShared
import SwiftUI
import UIKit

// MARK: Karten

/// Fertige Folge (`.folge.is-ready`): Abspielen, Art, Titel, „5:12 · 25.10.2026, 09:07 · 8.642
/// Zeichen“, darunter „Report-Notiz“, „Herunterladen“ und „Löschen“.
struct FolgenDoneCard: View {
    let episode: Episode
    let isBusy: Bool
    let isDownloading: Bool
    let play: () -> Void
    let openNote: (String) -> Void
    let download: () -> Void
    let delete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Button(action: play) {
                    Image(systemName: "play.fill")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Theme.onAccent)
                        .frame(width: 48, height: 48)
                        .background(Theme.accent, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(FolgenPressStyle())
                .accessibilityLabel("Abspielen: \(episode.title)")
                FolgenHead(episode: episode, meta: FolgenFormat.meta(episode, withChars: true))
                    // Tippen auf den Text spielt auch; VoiceOver hat dafür den Knopf daneben.
                    .contentShape(Rectangle())
                    .onTapGesture(perform: play)
            }
            FolgenActions {
                if let note = episode.note, !note.isEmpty {
                    Button {
                        openNote(note)
                    } label: {
                        Label(episode.kind == "report" ? "Report-Notiz" : "Transkript", systemImage: "doc.text")
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                }
                Button(action: download) {
                    HStack(spacing: 6) {
                        if isDownloading {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "arrow.down.circle")
                                .accessibilityHidden(true)
                        }
                        Text("Herunterladen")
                    }
                }
                .buttonStyle(LesenQuietButtonStyle())
                .disabled(isDownloading)
                .accessibilityLabel(isDownloading ? "Wird geladen" : "Herunterladen")
                .accessibilityHint("MP3 sichern oder teilen")
                Button(role: .destructive, action: delete) {
                    Label("Löschen", systemImage: "trash")
                }
                .buttonStyle(LesenQuietButtonStyle())
            }
        }
        .cardStyle()
        .opacity(isBusy ? 0.5 : 1)
        .disabled(isBusy)
        .accessibilityElement(children: .contain)
    }
}

/// Erst nur das Transkript (`.folge.is-transcript`): „Transkript lesen“ (die Notiz im Vault),
/// „Audio erzeugen“ mit dem, was es bei ElevenLabs kostet, und „Löschen“.
struct FolgenTranscriptCard: View {
    let episode: Episode
    let isBusy: Bool
    let openNote: (String) -> Void
    let speak: () -> Void
    let delete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "doc.text")
                    .font(.title3)
                    .foregroundStyle(Theme.accent)
                    .frame(width: 48, height: 48)
                    .background(Theme.accentSoft, in: Circle())
                    .accessibilityHidden(true)
                FolgenHead(episode: episode, meta: CockpitFormat.meta(["Transkript", FolgenFormat.meta(episode, withChars: false)]))
            }
            FolgenActions {
                if let note = episode.note, !note.isEmpty {
                    Button {
                        openNote(note)
                    } label: {
                        Label("Transkript lesen", systemImage: "doc.text")
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                }
                Button(action: speak) {
                    HStack(spacing: 6) {
                        if isBusy {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.onAccent)
                        } else {
                            Image(systemName: "waveform")
                                .accessibilityHidden(true)
                        }
                        Text(episode.speak?.label ?? "Audio erzeugen")
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 26)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .accessibilityHint(episode.speak?.hint ?? "")
                Button(role: .destructive, action: delete) {
                    Label("Löschen", systemImage: "trash")
                }
                .buttonStyle(LesenQuietButtonStyle())
            }
            .disabled(isBusy)
            if episode.note?.isEmpty ?? true {
                Text("Das Transkript ließ sich nicht im Vault anlegen; das Skript liegt im Cockpit.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let hint = episode.speak?.hint {
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .cardStyle()
        .accessibilityElement(children: .contain)
    }
}

/// Fehlgeschlagene Folge (`.folge.is-failed`): Fehler, „Fortsetzen“ bzw. „Erneut versuchen“ mit
/// der Erklärung, was es kostet, und „Löschen“.
struct FolgenFailedCard: View {
    let episode: Episode
    let isBusy: Bool
    let retry: () -> Void
    let delete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title3)
                    .foregroundStyle(Theme.danger)
                    .frame(width: 48, height: 48)
                    .background(Theme.dangerSoft, in: Circle())
                    .accessibilityHidden(true)
                FolgenHead(episode: episode, meta: FolgenFormat.meta(episode, withChars: false))
            }
            Text(episode.error ?? "Unbekannter Fehler")
                .font(.subheadline)
                .foregroundStyle(Theme.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Fehler: \(episode.error ?? "Unbekannter Fehler")")
            FolgenActions {
                Button(action: retry) {
                    HStack(spacing: 6) {
                        if isBusy {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.onAccent)
                        }
                        Text(episode.retry?.label ?? (episode.resumable ? "Fortsetzen" : "Erneut versuchen"))
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 26)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .accessibilityHint(episode.retry?.hint ?? "")
                Button(role: .destructive, action: delete) {
                    Label("Löschen", systemImage: "trash")
                }
                .buttonStyle(LesenQuietButtonStyle())
            }
            .disabled(isBusy)
            if let hint = episode.retry?.hint {
                Text(hint)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .cardStyle()
        .accessibilityElement(children: .contain)
    }
}

/// Entstehende Folge (`.folge.is-busy`): Schritte, Balken (unbestimmt, solange Claude schreibt)
/// und der Satz dazu mit der geschätzten Restzeit.
struct FolgenBusyCard: View {
    let episode: Episode

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ProgressView()
                    .tint(Theme.accent)
                    .frame(width: 48, height: 48)
                    .background(Theme.accentSoft, in: Circle())
                    .accessibilityHidden(true)
                FolgenHead(episode: episode, meta: FolgenFormat.meta(episode, withChars: false))
            }
            if let progress = episode.progress {
                FolgenSteps(steps: progress.steps, current: progress.step)
                VStack(alignment: .leading, spacing: 6) {
                    if progress.percent == nil {
                        FolgenIndeterminateBar()
                    } else {
                        LesenBar(value: progress.fraction ?? Double(progress.percent ?? 0) / 100, tint: Theme.accent)
                    }
                    Text(progress.label)
                        .font(.footnote)
                        .foregroundStyle(Theme.text2)
                        .contentTransition(.numericText())
                        .animation(.snappy, value: progress.label)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(progress.label)
                .accessibilityValue(progress.percent.map { "\($0) Prozent" } ?? "")
            }
        }
        .cardStyle()
        .accessibilityElement(children: .contain)
    }
}

// MARK: Teile

/// Art, Titel und Meta-Zeile einer Folge (`.folge-text`).
struct FolgenHead: View {
    let episode: Episode
    let meta: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            FolgenKindBadge(kind: episode.kind, label: episode.kindLabel)
            Text(episode.title)
                .font(.body.weight(.semibold))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            if !meta.isEmpty {
                Text(meta)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
            // Ton und Schwerpunkt, wenn gewählt.
            if let wishes = episode.wishes {
                Text(wishes)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Art als Plakette (`.folge-art`): „Vorlesen“, „Podcast“, „Report“.
struct FolgenKindBadge: View {
    let kind: String
    let label: String

    var body: some View {
        Label(label, systemImage: FolgenKind.icon(kind))
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Theme.accentSoft, in: Capsule())
    }
}

/// Schritte „Eingereiht → Claude schreibt → Stimmen sprechen → Fertig“ (`.folge-steps`):
/// erledigte mit Haken, der aktuelle betont. Nebeneinander, bei großer Schrift untereinander.
struct FolgenSteps: View {
    let steps: [String]
    let current: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { items }
            VStack(alignment: .leading, spacing: 6) { items }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(steps.indices.contains(current) ? "Schritt \(current + 1) von \(steps.count): \(steps[current])" : "")
    }

    private var items: some View {
        ForEach(Array(steps.enumerated()), id: \.offset) { index, label in
            HStack(spacing: 4) {
                Image(systemName: index < current ? "checkmark.circle.fill" : index == current ? "circle.inset.filled" : "circle")
                    .foregroundStyle(index < current ? Theme.ok : index == current ? Theme.accent : Theme.text3)
                    .symbolEffect(.pulse, options: .repeating, isActive: index == current && !reduceMotion)
                    .contentTransition(.symbolEffect(.replace))
                Text(label)
                    .foregroundStyle(index == current ? Theme.text : Theme.text3)
                    .fontWeight(index == current ? .semibold : .regular)
                    .fixedSize()
            }
            .font(.footnote)
        }
    }
}

/// Unbestimmter Balken, solange Claude schreibt (`.folge-wait`): ein Stück läuft durch; mit
/// „Bewegung reduzieren“ steht es still.
struct FolgenIndeterminateBar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = 0

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.line)
                Capsule()
                    .fill(Theme.accent)
                    .frame(width: width * 0.3)
                    .offset(x: reduceMotion ? width * 0.35 : width * 1.3 * phase - width * 0.3)
            }
            .clipShape(Capsule())
        }
        .frame(height: 4)
        .accessibilityHidden(true)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.3).repeatForever(autoreverses: false)) { phase = 1 }
        }
    }
}

/// Knöpfe unter einer Karte (`.folge-actions`): nebeneinander, bei großer Schrift untereinander.
struct FolgenActions<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { content }
            VStack(alignment: .leading, spacing: 8) { content }
        }
    }
}

/// Runder Knopf, der beim Drücken nachgibt.
struct FolgenPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.9 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}

// MARK: Arten und Formate

/// Zeichen der Arten wie `KIND_ICONS` im Web (Kopfhörer, Mikrofon, Dokument).
enum FolgenKind {
    static func icon(_ kind: String) -> String {
        switch kind {
        case "vorlesen": "headphones"
        case "podcast": "mic"
        case "report": "doc.text"
        default: "waveform"
        }
    }
}

/// Meta-Zeilen der Karten wie `episodeCard` in src/lesen/folgen-page.js.
@MainActor
enum FolgenFormat {
    /// Fertig: „5:12 · 25.10.2026, 09:07 · 8.642 Zeichen“; sonst „10 Min. · 25.10.2026, 09:07“.
    static func meta(_ episode: Episode, withChars: Bool) -> String {
        let length = withChars ? episode.durationLabel : episode.minutes.map { "\($0) Min." }
        return CockpitFormat.meta([
            length,
            created(episode.createdAt),
            withChars ? "\(NewEpisodeStore.grouped(episode.chars)) Zeichen" : nil,
        ])
    }

    /// `dateStyle: 'medium', timeStyle: 'short'` in de-DE: „25.10.2026, 09:07“.
    static func created(_ iso: String) -> String? {
        CockpitFormat.date(from: iso).map { formatter.string(from: $0) }
    }

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "de_DE")
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}

// MARK: Herunterladen

/// „Herunterladen“: Die MP3 kommt über `/api/app/folge` in denselben Cache wie beim Abspielen
/// (`EpisodePlayer.file(for:)`), danach als Kopie mit dem Titel als Namen ins Teilen-Blatt
/// („In Dateien sichern“, AirDrop …).
@MainActor
@Observable
final class FolgenDownloads {
    struct SharedFile: Identifiable {
        let id = UUID()
        let url: URL
    }

    /// Folgen (IDs), deren MP3 gerade lädt.
    private(set) var loading: Set<String> = []
    /// Fertig geladen: das Teilen-Blatt zeigt diese Datei.
    var shared: SharedFile?

    func download(_ episode: Episode, context: CockpitContext) async {
        guard !loading.contains(episode.id) else { return }
        let cache = EpisodePlayer.file(for: episode.id)
        if !EpisodePlayer.isCached(cache, bytes: episode.bytes ?? 0) {
            loading.insert(episode.id)
            defer { loading.remove(episode.id) }
            do {
                try await Self.fetch(episode.id, api: context.api, to: cache)
            } catch FolgenDownloadError.unauthorized {
                context.onUnauthorized()
                return
            } catch {
                guard !(error is CancellationError) else { return }
                context.toasts.signal(.error)
                context.toasts.error("Folge ließ sich nicht laden: \(error.localizedDescription)")
                return
            }
        }
        do {
            shared = SharedFile(url: try Self.namedCopy(of: cache, title: episode.title))
        } catch {
            context.toasts.signal(.error)
            context.toasts.error("Folge ließ sich nicht sichern: \(error.localizedDescription)")
        }
    }

    /// Lädt die MP3 mit dem Geräte-Token nach `destination`.
    nonisolated static func fetch(_ id: String, api: CockpitAPI, to destination: URL) async throws {
        var request = api.getRequest("api/app/folge", query: [URLQueryItem(name: "id", value: id)])
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        let (file, response) = try await URLSession.shared.download(for: request)
        let files = FileManager.default
        defer { try? files.removeItem(at: file) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw FolgenDownloadError.unauthorized }
        guard (200..<300).contains(status) else {
            // Bei einem Fehler steht die Meldung des Servers (JSON) in der Datei.
            struct Problem: Decodable { let message: String }
            let problem = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Problem.self, from: $0) }
            throw FolgenDownloadError.failed(problem?.message ?? "Der Server antwortete mit \(status).")
        }
        try files.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        if files.fileExists(atPath: destination.path) { try files.removeItem(at: destination) }
        try files.moveItem(at: file, to: destination)
    }

    /// Kopie im temporären Ordner, benannt wie `download` im Web: Titel ohne `\/:*?"<>|`, `.mp3`.
    nonisolated static func namedCopy(of file: URL, title: String) throws -> URL {
        let files = FileManager.default
        let folder = files.temporaryDirectory.appending(path: "Folgen", directoryHint: .isDirectory)
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        let copy = folder.appending(path: "\(fileName(title)).mp3")
        if files.fileExists(atPath: copy.path) { try files.removeItem(at: copy) }
        try files.copyItem(at: file, to: copy)
        return copy
    }

    nonisolated static func fileName(_ title: String) -> String {
        let name = title
            .replacingOccurrences(of: "[\\\\/:*?\"<>|]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "Folge" : String(name.prefix(120))
    }
}

enum FolgenDownloadError: LocalizedError {
    case unauthorized
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: "Bitte neu anmelden."
        case .failed(let message): message
        }
    }
}

/// Teilen-Blatt des Systems für die geladene MP3.
struct FolgenShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
