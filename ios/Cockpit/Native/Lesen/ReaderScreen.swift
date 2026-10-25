import CockpitShared
import SwiftUI
import UIKit

/// Sprungziel beim Öffnen der Leseansicht: `#weiter` (gespeicherte Lesestelle) oder `#h-<id>`
/// (eine Markierung).
enum ReaderAnchor: Hashable, Sendable {
    case resume
    case highlight(String)

    /// Wie `ReadingRoute.reader(id:highlight:resume:)`: die Markierung geht vor; nil = oben anfangen.
    init?(highlight: String?, resume: Bool) {
        if let highlight, !highlight.isEmpty {
            self = .highlight(highlight)
        } else if resume {
            self = .resume
        } else {
            return nil
        }
    }
}

/// Was die Leseansicht von der Anmeldung braucht: Kontext (API, Meldungen, Links) und den einen
/// Puffer des Lesens (`ReadingBuffer`). Setzt, wer die Leseansicht zeigt, mit `.readerServices(_:)`.
struct ReaderServices {
    let context: CockpitContext
    let buffer: ReadingBuffer
    /// Ingest der Anmeldung (Abzeichen „Ingest bereit“, „Ingest entwerfen“).
    var ingest: IngestStore?
}

private struct ReaderServicesKey: EnvironmentKey {
    static var defaultValue: ReaderServices? { nil }
}

extension EnvironmentValues {
    var readerServices: ReaderServices? {
        get { self[ReaderServicesKey.self] }
        set { self[ReaderServicesKey.self] = newValue }
    }
}

extension View {
    /// Gibt Leseansichten darunter (auch im Stapel geöffnete) Kontext und Puffer der Anmeldung.
    func readerServices(_ services: ReaderServices?) -> some View {
        environment(\.readerServices, services)
    }
}

/// Hält den Store einer Leseansicht. Geht die Ansicht weg (zurück, neue Anmeldung), hört der
/// Store auf den Puffer nicht mehr und speichert den Fortschritt.
final class ReaderKeeper {
    let store: ReaderStore
    let images: ReaderImageLoader
    /// Erster sichtbarer Block (für „Absatz markieren“), ohne die Ansicht neu zu zeichnen.
    var topBlock: Int?

    init(store: ReaderStore, images: ReaderImageLoader) {
        self.store = store
        self.images = images
    }

    deinit {
        let store = store
        Task { @MainActor in await store.stop() }
    }
}

/// Anderer Artikel aus der Leseansicht (Stapel, Querverbindung, Link im Text).
struct ReaderLinkTarget: Hashable {
    let docID: String
    let anchor: ReaderAnchor?
}

/// Leseansicht nativ (`/lesen/doc?id=…` im Web): Text mit Markierungen und Notizen, Schriftgröße
/// und Schriftart, Fortschritt mit „noch n min“, Auswahl mit Markieren, Notiz, Verbinden und In
/// Inbox, die Entscheidungen nach dem Lesen, Markierungen und Stapel als Blatt.
///
/// Zeigt sofort den gespeicherten Stand und lädt dann neu; ohne Netz gehen Markieren, Notiz,
/// Fortschritt und Entscheidungen in den Puffer (wartende Markierungen gestrichelt).
@MainActor
struct ReaderScreen: View {
    let docID: String
    let anchor: ReaderAnchor?

    @Environment(\.readerServices) private var services
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @AppStorage(ReaderAppearance.levelKey) private var level = ReaderAppearance.defaultLevel
    @AppStorage(ReaderAppearance.sansKey) private var sans = false

    @State private var keeper: ReaderKeeper?
    @State private var selection: ReaderSelection?
    /// Kurz hervorgehoben nach einem Sprung zu einer Markierung (`mark:target` im Web).
    @State private var flashMark: String?
    @State private var scrollRequest: ReaderScrollRequest?
    @State private var clearSelection = 0
    @State private var activeSheet: ReaderSheet?
    /// Welches Blatt zuletzt offen war (für das Aufräumen beim Schließen).
    @State private var shownSheet: ReaderSheet?
    /// Läuft, wenn das Blatt zu ist (Blatt wechseln, Seite öffnen).
    @State private var afterSheet: (@MainActor () -> Void)?
    @State private var next: ReaderLinkTarget?
    @State private var positioned = false
    @State private var showsAppearance = false
    @State private var decisionsClosed = false
    /// In dieser Sitzung bis zum Ende gescrollt (dann „Fertig, weg“ und „In den Vault“ unten).
    /// Eigener Zustand statt `store.progress`, damit nicht jeder Fortschritt die Ansicht neu baut.
    @State private var reachedEnd = false

    init(docID: String, anchor: ReaderAnchor? = nil) {
        self.docID = docID
        self.anchor = anchor
    }

    private var store: ReaderStore? { keeper?.store }

    var body: some View {
        Group {
            if let services {
                screen(services)
            } else {
                ContentUnavailableView("Leseansicht nicht bereit", systemImage: "book.closed", description: Text("Die Anmeldung fehlt. Bitte die App neu öffnen."))
            }
        }
        .background(Theme.bg)
        .navigationTitle(store?.model?.doc.site ?? "")
        .navigationBarTitleDisplayMode(.inline)
        // Auch neu, wenn die Anmeldung die Dienste erst später setzt.
        .task(id: "\(docID) \(services != nil)") { await start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background, let store { Task { await store.flushProgress() } }
        }
        .onAppear { services?.ingest?.startPolling(ingestPollKey) }
        .onDisappear {
            services?.ingest?.stopPolling(ingestPollKey)
            if let store { Task { await store.flushProgress() } }
        }
        .navigationDestination(item: $next) { target in
            ReaderScreen(docID: target.docID, anchor: target.anchor)
                .readerServices(services)
        }
    }

    // MARK: Zustände

    @ViewBuilder
    private func screen(_ services: ReaderServices) -> some View {
        if let keeper {
            let store = keeper.store
            if store.isNotFound {
                ContentUnavailableView("Diesen Artikel gibt es nicht (mehr).", systemImage: "doc.questionmark")
                    .toasts(services.context.toasts)
            } else if let model = store.model {
                reader(keeper, model, services)
            } else if let error = store.state.error, !store.state.isRefreshing {
                LoadFailedView(title: "Artikel nicht geladen", error: error) {
                    Task { await store.refresh() }
                }
                .toasts(services.context.toasts)
            } else {
                ReaderSkeleton()
            }
        } else {
            ReaderSkeleton()
        }
    }

    // MARK: Lesen

    private func reader(_ keeper: ReaderKeeper, _ model: ReadingDocModel, _ services: ReaderServices) -> some View {
        let store = keeper.store
        return VStack(spacing: 0) {
            ReaderProgressBar(store: store, buffer: services.buffer, toasts: services.context.toasts, showsResume: model.anchor > 0 && model.weiter > 0 && model.doc.progress < 1) {
                services.context.toasts.signal(.selection)
                scrollRequest = ReaderScrollRequest(offset: model.weiter, animated: !reduceMotion)
            }
            LoadStatusView(state: store.state, hasModel: true)
                .padding(.horizontal, 16)
            ReaderTextView(
                document: document(model),
                ranges: model.ranges,
                focusedMark: selection?.markID ?? flashMark,
                scrollRequest: scrollRequest,
                clearSelection: clearSelection,
                canMark: store.canMark,
                images: keeper.images,
                actions: textActions(keeper, services)
            )
            .toasts(services.context.toasts)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomBar(store, model)
        }
        .toolbar { toolbarItems(keeper, model) }
        .sheet(item: $activeSheet, onDismiss: sheetDismissed) { sheet in
            sheetContent(sheet, store, services)
        }
        .onChange(of: positionKey(store), initial: true) {
            positionIfNeeded()
        }
    }

    /// Was die Textansicht setzt; neu gesetzt wird nur, wenn sich davon etwas ändert.
    private func document(_ model: ReadingDocModel) -> ReaderDocument {
        let doc = model.doc
        return ReaderDocument(
            docID: docID,
            title: doc.displayTitle,
            meta: CockpitFormat.meta([doc.site, doc.author, doc.readingMinutes > 0 ? "\(doc.readingMinutes) min" : nil]),
            original: original(model),
            comments: comments(model),
            blocks: model.blocks,
            level: ReaderAppearance.clamp(level),
            sans: sans,
            typeSize: typeSize
        )
    }

    /// „Original“: nur Web-Adressen (PDFs haben keine).
    private func original(_ model: ReadingDocModel) -> URL? {
        guard let url = URL(string: model.doc.url), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    /// „Kommentare“: Diskussion zum Feed-Eintrag, nur Web-Adressen.
    private func comments(_ model: ReadingDocModel) -> URL? {
        guard let raw = model.doc.commentsUrl, let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        return url
    }

    private func textActions(_ keeper: ReaderKeeper, _ services: ReaderServices) -> ReaderTextActions {
        let store = keeper.store
        return ReaderTextActions(
            select: { range in
                if let range {
                    selection = .range(range)
                } else if case .range = selection {
                    // Leere Auswahl hebt nur eine Auswahl auf, nicht die angetippte Markierung.
                    selection = nil
                }
            },
            tapMark: { id in
                services.context.toasts.signal(.selection)
                selection = selection?.markID == id ? nil : .mark(id)
            },
            tapText: {
                if selection?.markID != nil { selection = nil }
            },
            scrolled: { progress, block in
                keeper.topBlock = block
                if progress >= 1, !reachedEnd { reachedEnd = true }
                store.scrolled(progress: progress, firstVisibleBlock: block)
            },
            open: { url in open(url, services) },
            command: { command, range in run(command, on: .range(range), store) }
        )
    }

    // MARK: Leiste unten

    private func bottomBar(_ store: ReaderStore, _ model: ReadingDocModel) -> some View {
        VStack(spacing: 0) {
            if let selection, store.canMark {
                ReaderSelectionBar(selection: selection, isPending: selection.markID.flatMap { model.highlight($0)?.isPending } ?? false, busy: store.busy) { command in
                    run(command, on: selection, store)
                }
                .transition(barTransition)
            }
            if selection == nil || !store.canMark, showsIngest(store, model) {
                ReaderIngestBar(
                    status: ingestStatus(store, model),
                    available: model.ingest?.available ?? false,
                    isDrafting: services?.ingest?.busy.contains(docID) ?? false,
                    review: { openIngestReview() },
                    draft: { draftIngest() }
                )
                .transition(barTransition)
            }
            if selection == nil || !store.canMark, showsDecisions(store, model) {
                ReaderDecisionBar(fertig: model.decisions.fertig, vault: model.vault, busy: store.busy, onFinish: {
                    decide(store) { await $0.finish() }
                }, onVault: { fullText in
                    decide(store) { await $0.moveToVault(fullText: fullText) }
                }, onClose: {
                    services?.context.toasts.signal(.selection)
                    decisionsClosed = true
                })
                .transition(barTransition)
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.35, dampingFraction: 0.85), value: barKey(store, model))
    }

    /// Am Ende angekommen und noch nicht entschieden (Eingang oder Stapel).
    private func showsDecisions(_ store: ReaderStore, _ model: ReadingDocModel) -> Bool {
        guard !decisionsClosed, reachedEnd else { return false }
        let open = model.doc.status == .inbox || model.doc.status == .stack
        return open && (model.decisions.fertig || model.vault)
    }

    private func barKey(_ store: ReaderStore, _ model: ReadingDocModel) -> String {
        let ingest = showsIngest(store, model) ? "ingest-\(ingestStatus(store, model) ?? "-")" : ""
        switch selection {
        case .range?: return "auswahl"
        case .mark(let id)?: return "markierung-\(id)"
        case nil: return (showsDecisions(store, model) ? "entscheiden" : "") + ingest
        }
    }

    // MARK: Ingest

    private var ingestPollKey: String { "leser-\(docID)" }

    /// Stand des Ingest-Entwurfs: was der `IngestStore` neuer weiß, sonst die Leseansicht.
    private func ingestStatus(_ store: ReaderStore, _ model: ReadingDocModel) -> String? {
        guard let ingest = services?.ingest else { return model.ingest?.status }
        return ingest.status(of: docID, fallback: model.ingest?.status, loadedAt: store.state.lastUpdated)
    }

    /// Am Ende angekommen: das Abzeichen des Ingests (wie `.lesen-decide` im Web), wenn es etwas
    /// zu zeigen oder zu tun gibt.
    private func showsIngest(_ store: ReaderStore, _ model: ReadingDocModel) -> Bool {
        guard let ingest = model.ingest, !decisionsClosed, reachedEnd else { return false }
        let status = ingestStatus(store, model)
        if IngestStatus.isActive(status) || status == IngestStatus.applied { return true }
        return ingest.available
    }

    /// Einträge im Menü „Aktionen“: Prüfen, Fehler ansehen, Stand oder „Ingest entwerfen“.
    @ViewBuilder
    private func ingestMenuItems(_ status: String?, available: Bool) -> some View {
        if status == IngestStatus.ready {
            Button {
                openIngestReview()
            } label: {
                Label("Ingest prüfen", systemImage: "checklist")
            }
        } else if status == IngestStatus.failed {
            Button {
                openIngestReview()
            } label: {
                Label("Ingest-Fehler ansehen", systemImage: "exclamationmark.triangle")
            }
        } else if IngestStatus.isBusy(status) {
            Button {} label: {
                Label(status == IngestStatus.waiting ? "Wartet auf Claude …" : "Ingest wird entworfen …", systemImage: "hourglass")
            }
            .disabled(true)
        } else if status == IngestStatus.applied {
            Button {} label: {
                Label("Im Wiki", systemImage: "checkmark")
            }
            .disabled(true)
        } else if available {
            Button {
                draftIngest()
            } label: {
                Label("Ingest entwerfen", systemImage: "sparkles")
            }
            .disabled(services?.ingest?.busy.contains(docID) ?? false)
        }
    }

    /// Prüfansicht auf den Stapel des Lesens (über die App, wie ein Link auf `/lesen/ingest/doc`).
    private func openIngestReview() {
        guard let services else { return }
        services.context.toasts.signal(.selection)
        services.context.openPath(ReadingRoute.ingestReview(id: docID).webPath)
    }

    private func draftIngest() {
        guard let ingest = services?.ingest else { return }
        let id = docID
        Task { await ingest.draft(id) }
    }

    private var barTransition: AnyTransition {
        reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity)
    }

    // MARK: Werkzeuge

    @ToolbarContentBuilder
    private func toolbarItems(_ keeper: ReaderKeeper, _ model: ReadingDocModel) -> some ToolbarContent {
        let store = keeper.store
        ToolbarItem(placement: .topBarTrailing) {
            if store.state.isRefreshing {
                ProgressView()
                    .accessibilityLabel("Lädt neu")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                services?.context.toasts.signal(.selection)
                showsAppearance = true
            } label: {
                Image(systemName: "textformat.size")
            }
            .accessibilityLabel("Darstellung")
            .popover(isPresented: $showsAppearance) {
                ReaderAppearancePanel(level: $level, sans: $sans)
                    .presentationCompactAdaptation(.popover)
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            let count = model.highlights.count
            Button {
                present(.side(.marks))
            } label: {
                Image(systemName: "highlighter")
                    .overlay(alignment: .topTrailing) {
                        if count > 0 {
                            Text("\(count)")
                                .font(.caption2.weight(.bold).monospacedDigit())
                                .foregroundStyle(Theme.onAccent)
                                .padding(.horizontal, 4)
                                .frame(minWidth: 16, minHeight: 16)
                                .background(Theme.accent, in: Capsule())
                                .contentTransition(.numericText(value: Double(count)))
                                .offset(x: 9, y: -7)
                        }
                    }
                    .animation(.snappy, value: count)
            }
            .accessibilityLabel(count == 1 ? "Markierungen, eine" : "Markierungen, \(count)")
        }
        ToolbarItem(placement: .topBarTrailing) {
            actionsMenu(keeper, model)
        }
    }

    /// Entscheidungen nach dem Lesen, Absatz markieren, Stapel, Original und Teilen.
    private func actionsMenu(_ keeper: ReaderKeeper, _ model: ReadingDocModel) -> some View {
        let store = keeper.store
        return Menu {
            Section {
                if model.decisions.fertig {
                    Button {
                        decide(store) { await $0.finish() }
                    } label: {
                        Label("Fertig, weg", systemImage: "checkmark.circle")
                    }
                    .disabled(store.busy.contains("fertig"))
                }
                if model.vault {
                    Button {
                        decide(store) { await $0.moveToVault(fullText: true) }
                    } label: {
                        Label("In den Vault", systemImage: "archivebox")
                    }
                    .disabled(store.busy.contains("vault"))
                    Button {
                        decide(store) { await $0.moveToVault(fullText: false) }
                    } label: {
                        Label("In den Vault ohne Volltext", systemImage: "doc")
                    }
                    .disabled(store.busy.contains("vault"))
                }
                if model.decisions.zurueck {
                    Button {
                        decide(store) { await $0.setStatus(.stack) }
                    } label: {
                        Label("Zurück auf den Stapel", systemImage: "arrow.uturn.backward")
                    }
                    .disabled(store.busy.contains("status"))
                }
            } header: {
                Text("Status: \(model.doc.status.label)")
            }
            if let ingest = model.ingest {
                Section {
                    ingestMenuItems(ingestStatus(store, model), available: ingest.available)
                } header: {
                    Text("Wiki")
                }
            }
            Section {
                if store.canMark {
                    Button {
                        services?.context.toasts.signal(.selection)
                        let block = keeper.topBlock ?? 0
                        Task { await store.toggleMark(block: block) }
                    } label: {
                        Label("Absatz markieren", systemImage: "highlighter")
                    }
                }
                Button {
                    present(.side(.stack))
                } label: {
                    Label("Stapel", systemImage: "books.vertical")
                }
                if let url = original(model) {
                    Button {
                        ExternalLink.open(url)
                    } label: {
                        Label("Original", systemImage: "safari")
                    }
                    if let comments = comments(model) {
                        Button {
                            ExternalLink.open(comments)
                        } label: {
                            Label("Kommentare", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                    ShareLink(item: url) {
                        Label("Teilen", systemImage: "square.and.arrow.up")
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Aktionen")
    }

    // MARK: Blätter

    @ViewBuilder
    private func sheetContent(_ sheet: ReaderSheet, _ store: ReaderStore, _ services: ReaderServices) -> some View {
        switch sheet {
        case .side(let tab):
            ReaderSideSheet(store: store, tab: tab, sans: sans, onJump: { id in
                after { jump(toHighlight: id) }
            }, onNote: { id in
                after { present(.note(.highlight(id))) }
            }, onConnect: { id in
                after { run(.connect, on: .mark(id), store) }
            }, onOpenDoc: { entry in
                after { next = ReaderLinkTarget(docID: entry.id, anchor: entry.started ? .resume : nil) }
            }, onOpenPath: { path in
                after { openWebPath(path, services) }
            })
        case .note(let target):
            let existing = highlight(of: target, store)
            ReaderNoteSheet(quote: quote(of: target, store), initial: existing?.note ?? "", sans: sans, canDelete: existing?.note?.isEmpty == false, onSave: { text in
                saveNote(text, target, store)
            }, onDelete: {
                if case .highlight(let id) = target { Task { await store.deleteNote(for: id) } }
            })
        case .connections:
            ReaderConnectionsSheet(store: store, sans: sans) { path in
                afterSheet = { openWebPath(path, services) }
            }
        }
    }

    private func present(_ sheet: ReaderSheet) {
        services?.context.toasts.signal(.selection)
        shownSheet = sheet
        activeSheet = sheet
    }

    /// Erst das Blatt schließen, dann `action` (ein Blatt über dem Blatt geht nicht).
    private func after(_ action: @escaping @MainActor () -> Void) {
        afterSheet = action
        activeSheet = nil
    }

    private func sheetDismissed() {
        switch shownSheet {
        case .connections?:
            store?.closeConnections()
            endSelection()
        case .note?:
            endSelection()
        default:
            break
        }
        shownSheet = nil
        let action = afterSheet
        afterSheet = nil
        action?()
    }

    private func highlight(of target: ReaderNoteTarget, _ store: ReaderStore) -> ReadingHighlight? {
        guard case .highlight(let id) = target else { return nil }
        return store.model?.highlight(id)
    }

    private func quote(of target: ReaderNoteTarget, _ store: ReaderStore) -> String {
        switch target {
        case .range(let range): store.text?.slice(range) ?? ""
        case .highlight(let id): store.model?.highlight(id)?.quote ?? ""
        }
    }

    private func saveNote(_ text: String, _ target: ReaderNoteTarget, _ store: ReaderStore) {
        services?.context.toasts.signal(.selection)
        switch target {
        case .range(let range):
            Task { await store.addNote(text, to: range) }
        case .highlight(let id):
            Task { await store.setNote(text, for: id) }
        }
    }

    // MARK: Kommandos

    /// Kommando der Leiste oder des Menüs an der Auswahl; die Stores ändern die Ansicht sofort.
    private func run(_ command: ReaderCommand, on target: ReaderSelection, _ store: ReaderStore) {
        services?.context.toasts.signal(.selection)
        switch (command, target) {
        case (.mark, .range(let range)):
            endSelection()
            Task { await store.mark(range) }
        case (.note, .range(let range)):
            present(.note(.range(range)))
        case (.note, .mark(let id)):
            present(.note(.highlight(id)))
        case (.connect, .range(let range)):
            Task { await store.loadConnections(for: range) }
            present(.connections)
        case (.connect, .mark(let id)):
            if let highlight = store.model?.highlight(id), highlight.isPending, let range = highlight.range {
                Task { await store.loadConnections(for: range) }
            } else {
                Task { await store.loadConnections(for: .highlight(id)) }
            }
            present(.connections)
        case (.inbox, .range(let range)):
            endSelection()
            Task { await store.sendToInbox(range) }
        case (.inbox, .mark(let id)):
            endSelection()
            Task { await store.sendToInbox(highlight: id) }
        case (.delete, .mark(let id)):
            endSelection()
            Task { await store.deleteHighlight(id) }
        case (.mark, .mark), (.delete, .range):
            break
        }
    }

    private func endSelection() {
        selection = nil
        clearSelection += 1
    }

    /// „Fertig, weg“, „In den Vault“, „Zurück auf den Stapel“; danach keine Leiste am Ende mehr.
    private func decide(_ store: ReaderStore, _ action: @escaping @MainActor (ReaderStore) async -> Bool) {
        services?.context.toasts.signal(.selection)
        Task {
            if await action(store) { decisionsClosed = true }
        }
    }

    // MARK: Springen und Öffnen

    /// Einmal nach dem ersten Stand: zur Lesestelle (`#weiter`) oder Markierung (`#h-…`).
    private func positionIfNeeded() {
        guard !positioned, let store, let model = store.model else { return }
        switch anchor {
        case nil:
            positioned = true
        case .resume?:
            positioned = true
            if model.weiter > 0 { scrollRequest = ReaderScrollRequest(offset: model.weiter) }
        case .highlight(let id)?:
            if let highlight = model.highlight(id), let range = highlight.range, !highlight.lost {
                positioned = true
                scrollRequest = ReaderScrollRequest(offset: range.lowerBound)
                flash(id)
            } else if !store.state.isRefreshing {
                // Erst nach dem Neuladen aufgeben: im gespeicherten Stand kann sie noch fehlen.
                positioned = true
                if model.highlight(id) != nil { services?.context.toasts.show("Stelle nicht mehr im Text") }
            }
        }
    }

    private func positionKey(_ store: ReaderStore) -> String {
        "\(store.model != nil) \(store.state.isRefreshing) \(store.model?.highlights.count ?? 0)"
    }

    private func jump(toHighlight id: String) {
        guard let highlight = store?.model?.highlight(id) else { return }
        guard let range = highlight.range, !highlight.lost else {
            services?.context.toasts.show("Stelle nicht mehr im Text")
            return
        }
        scrollRequest = ReaderScrollRequest(offset: range.lowerBound, animated: !reduceMotion)
        flash(id)
    }

    private func flash(_ id: String) {
        flashMark = id
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if flashMark == id { flashMark = nil }
        }
    }

    /// Link im Text: eigener Server nativ (Leseansicht) oder als Pfad an die App, sonst Safari.
    private func open(_ url: URL, _ services: ReaderServices) {
        services.context.toasts.signal(.selection)
        guard let host = url.host(), host == services.context.api.baseURL.host() else {
            ExternalLink.open(url)
            return
        }
        var path = url.path()
        if let query = url.query() { path += "?\(query)" }
        if let fragment = url.fragment() { path += "#\(fragment)" }
        openWebPath(path, services)
    }

    /// Web-Pfad eines Treffers oder Bereichs: Artikel nativ, alles andere entscheidet die App.
    private func openWebPath(_ path: String, _ services: ReaderServices) {
        if case .reader(let id, let highlight, let resume)? = ReadingRoute(webPath: path) {
            if id == docID {
                if let highlight { jump(toHighlight: highlight) }
            } else {
                next = ReaderLinkTarget(docID: id, anchor: ReaderAnchor(highlight: highlight, resume: resume))
            }
        } else {
            services.context.openPath(path)
        }
    }

    // MARK: Laden

    /// Erster Auftritt: Store anlegen, gespeicherten Stand zeigen und laden; danach beim
    /// Wiederkommen (zurück aus einem anderen Artikel) neu laden.
    private func start() async {
        guard let services else { return }
        if let store {
            if !store.state.isRefreshing { await store.refresh() }
            return
        }
        let store = ReaderStore(context: services.context, docID: docID, buffer: services.buffer)
        keeper = ReaderKeeper(store: store, images: ReaderImageLoader(api: services.context.api))
        await store.load()
    }
}
