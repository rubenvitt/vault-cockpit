import CockpitShared
import SwiftUI

/// Die Woche im Wiedersehen (`.wiedersehen-week`): Blättern „‹ KW 42 | KW 43 | KW 44 ›“ (auch
/// per Wischen), Markierungen, Texte, Themen und Quellen, Balken je Thema (sonst Quelle), bis zu
/// drei „Querverbindung entdeckt“ und „Als Markdown exportieren“.
@MainActor
struct WiedersehenWeekSection: View {
    let week: ReadingWeek
    let store: ReviewCardsStore
    let canCapture: Bool
    /// Alte Woche, während die gewählte lädt: gedimmt und ohne Knöpfe.
    let isPlaceholder: Bool
    let api: CockpitAPI
    let toasts: ToastCenter
    let open: (ReadingHighlight) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Woher die neue Woche hereinkommt (vor: von rechts, zurück: von links).
    @State private var direction = Edge.trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Die Woche")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                Text(week.label)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
            }
            pager
            content
                .id(week.id)
                .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.asymmetric(insertion: .move(edge: direction).combined(with: .opacity), removal: .opacity))
                .opacity(isPlaceholder ? 0.5 : 1)
                .allowsHitTesting(!isPlaceholder)
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy, value: week.id)
        .simultaneousGesture(WeekSwipe.gesture(enabled: !isPlaceholder, previous: {
            go(.leading) { await store.showPrevious() }
        }, next: {
            go(.trailing) { await store.showNext() }
        }))
    }

    // MARK: Blättern

    /// Wie `.pager` im Web; die Mitte führt zurück zur laufenden Woche, wenn eine andere gewählt ist.
    private var pager: some View {
        HStack(spacing: 8) {
            Button {
                go(.leading) { await store.showPrevious() }
            } label: {
                Label("KW \(week.prev.week)", systemImage: "chevron.left")
            }
            .accessibilityLabel("Vorige Woche, KW \(week.prev.week)")
            Spacer(minLength: 0)
            if store.requestedWeek != nil {
                Button("KW \(week.week)") {
                    go(.trailing) { await store.showCurrent() }
                }
                .accessibilityLabel("KW \(week.week)")
                .accessibilityHint("Zurück zur laufenden Woche")
            } else {
                Text("KW \(week.week)")
                    .foregroundStyle(Theme.text)
                    .accessibilityLabel("Diese Woche, KW \(week.week)")
            }
            Spacer(minLength: 0)
            Button {
                go(.trailing) { await store.showNext() }
            } label: {
                HStack(spacing: 4) {
                    Text("KW \(week.next.week)")
                    Image(systemName: "chevron.right")
                }
            }
            .accessibilityLabel("Nächste Woche, KW \(week.next.week)")
        }
        .font(.subheadline.weight(.medium))
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .tint(Theme.accent)
        .disabled(isPlaceholder)
    }

    private func go(_ from: Edge, _ load: @escaping @MainActor () async -> Void) {
        direction = from
        toasts.signal(.selection)
        Task { await load() }
    }

    // MARK: Inhalt

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            stats
            if week.topics.isEmpty {
                EmptyText("In dieser Woche ist nichts markiert.")
                    .cardStyle()
            } else {
                WiedersehenTopicBars(topics: week.topics)
            }
            ForEach(week.clusters.prefix(3)) { cluster in
                WiedersehenClusterBox(
                    cluster: cluster,
                    canCapture: canCapture,
                    busy: store.busy.contains(cluster.id),
                    linked: store.linkedClusters.contains(cluster.id),
                    open: open
                ) {
                    Task { await store.createNote(for: cluster) }
                }
            }
            if week.export != nil, week.stats.highlights > 0 {
                WiedersehenExportButton(week: week, store: store, api: api, toasts: toasts, isPlaceholder: isPlaceholder)
            }
        }
    }

    /// Drei Zahlen nebeneinander (`.stats`), zählen beim Blättern sichtbar um.
    private var stats: some View {
        HStack(alignment: .top, spacing: 8) {
            StatTile(label: week.stats.highlights == 1 ? "Markierung" : "Markierungen", accessibility: "\(week.stats.highlights) \(week.stats.highlights == 1 ? "Markierung" : "Markierungen")") {
                Text("\(week.stats.highlights)")
            }
            StatTile(label: week.stats.texts == 1 ? "Text" : "Texte", accessibility: "\(week.stats.texts) \(week.stats.texts == 1 ? "Text" : "Texte")") {
                Text("\(week.stats.texts)")
            }
            StatTile(label: "Themen und Quellen", accessibility: "\(week.stats.topics) Themen und Quellen") {
                Text("\(week.stats.topics)")
            }
        }
        .animation(.snappy, value: week.stats.highlights)
    }
}

// MARK: Themen

/// Balken je Thema (sonst Quelle), am häufigsten gemessen; wachsen nacheinander herein.
struct WiedersehenTopicBars: View {
    let topics: [TopicCount]

    var body: some View {
        let top = max(1, topics.map(\.count).max() ?? 1)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(topics.enumerated()), id: \.element.label) { index, topic in
                WiedersehenTopicBar(topic: topic, share: Double(topic.count) / Double(top), delay: Double(min(index, 10)) * 0.05)
            }
        }
        .cardStyle()
    }
}

/// Ein Thema: Name und Zahl, darunter der Balken (`progress` im Web).
struct WiedersehenTopicBar: View {
    let topic: TopicCount
    /// Anteil am häufigsten Thema, 0…1.
    let share: Double
    var delay: Double = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(topic.label)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text("\(topic.count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(Theme.text2)
                    .contentTransition(.numericText(value: Double(topic.count)))
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Theme.line)
                    Capsule()
                        .fill(Theme.accent)
                        .frame(width: geometry.size.width * (shown ? CGFloat(min(1, max(0, share))) : 0))
                }
            }
            .frame(height: 6)
            .animation(reduceMotion ? nil : .snappy, value: share)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(topic.label): \(topic.count)")
        .onAppear {
            guard !shown else { return }
            if reduceMotion {
                shown = true
            } else {
                withAnimation(.spring(response: 0.7, dampingFraction: 0.85).delay(delay)) { shown = true }
            }
        }
    }
}

// MARK: Querverbindung

/// „Querverbindung entdeckt“ (`.wiedersehen-link`): ähnliche Markierungen aus verschiedenen
/// Texten, jede mit Titel (öffnet die Stelle) und Themen; „Als eigene Notiz anlegen“ legt eine
/// Notiz in der Vault-Inbox an und wird danach zum Haken.
@MainActor
struct WiedersehenClusterBox: View {
    let cluster: HighlightCluster
    let canCapture: Bool
    let busy: Bool
    let linked: Bool
    let open: (ReadingHighlight) -> Void
    let create: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Querverbindung entdeckt", systemImage: "point.3.connected.trianglepath.dotted")
                .font(.headline)
                .foregroundStyle(Theme.accent)
                .accessibilityAddTraits(.isHeader)
            ForEach(cluster.items) { item in
                VStack(alignment: .leading, spacing: 6) {
                    MarkiertQuote(text: item.quote, font: .system(.subheadline, design: .serif))
                    Button {
                        open(item)
                    } label: {
                        (Text(item.docDisplayTitle).foregroundStyle(Theme.accent)
                            + Text(Self.topics(item)).foregroundStyle(Theme.text3))
                            .font(.footnote)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Öffnet den Text an dieser Stelle")
                }
            }
            if canCapture {
                Group {
                    if linked {
                        Label("Als Notiz angelegt", systemImage: "checkmark.circle.fill")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Theme.ok)
                            .transition(.scale(scale: 0.9).combined(with: .opacity))
                    } else {
                        Button(action: create) {
                            HStack(spacing: 8) {
                                if busy {
                                    ProgressView()
                                        .controlSize(.small)
                                }
                                Text("Als eigene Notiz anlegen")
                            }
                        }
                        .buttonStyle(LesenQuietButtonStyle())
                        .disabled(busy)
                        .transition(.opacity)
                    }
                }
                .animation(.snappy, value: linked)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(Theme.accentLine)
        }
        .accessibilityElement(children: .contain)
    }

    /// „ · Thema, Thema“, leer ohne Themen.
    static func topics(_ item: ReadingHighlight) -> String {
        item.docTopics.isEmpty ? "" : " · " + item.docTopics.joined(separator: ", ")
    }
}

// MARK: Export

/// „Als Markdown exportieren“: Die Datei `markierungen-2026-W43.md` wird mit dem Token geladen,
/// sobald die Woche zu sehen ist, und dann direkt geteilt (Teilen-Blatt: Dateien, Mail, …).
/// Klappt das Vorladen nicht (ohne Netz), lädt ein Tipp sie nach und meldet Fehler.
@MainActor
struct WiedersehenExportButton: View {
    let week: ReadingWeek
    let store: ReviewCardsStore
    let api: CockpitAPI
    let toasts: ToastCenter
    let isPlaceholder: Bool

    @State private var file: URL?
    @State private var loading = false

    private var filename: String { "markierungen-\(week.id).md" }

    var body: some View {
        Group {
            if let file {
                ShareLink(item: file, preview: SharePreview(filename)) {
                    Label("Als Markdown exportieren", systemImage: "square.and.arrow.up")
                }
                .accessibilityHint("Teilt \(filename)")
            } else {
                Button {
                    Task { await download() }
                } label: {
                    HStack(spacing: 8) {
                        if loading {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "square.and.arrow.down")
                                .accessibilityHidden(true)
                        }
                        Text("Als Markdown exportieren")
                    }
                }
                .disabled(loading)
            }
        }
        .buttonStyle(LesenQuietButtonStyle())
        // Neu vorladen, wenn eine andere Woche oder neue Markierungen da sind.
        .task(id: "\(week.id) \(week.stats.highlights)") { await prefetch() }
    }

    /// Leise vorladen: ohne Netz bleibt der Knopf zum Nachladen.
    private func prefetch() async {
        file = nil
        guard !isPlaceholder else { return }
        guard let markdown = try? await api.reviewMarkdown(week: week.id) else { return }
        file = try? Self.write(markdown, name: filename)
    }

    /// Auf Tipp laden (meldet Fehler); danach steht „Teilen“ bereit.
    private func download() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        guard let markdown = await store.exportMarkdown() else { return }
        do {
            file = try Self.write(markdown, name: filename)
            toasts.signal(.success)
            toasts.show("\(filename) ist bereit zum Teilen")
        } catch {
            toasts.signal(.error)
            toasts.error("Export nicht gespeichert: \(error.localizedDescription)")
        }
    }

    /// Legt die Datei in einem eigenen Ordner im temporären Verzeichnis ab (der Name bleibt der
    /// aus dem Web).
    static func write(_ markdown: String, name: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Wiedersehen", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: name, directoryHint: .notDirectory)
        try Data(markdown.utf8).write(to: file, options: .atomic)
        return file
    }
}
