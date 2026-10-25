import CockpitShared
import SwiftUI
import UIKit

/// Prüfansicht nativ (`/lesen/ingest/doc?id=…` im Web), der Lesemoment des Ingests: „Das
/// Wichtigste“ (Kernaussagen, Neu für dich, Bestätigt, Widerspricht, Dockt an), die Source-Page
/// mit änderbarem Titel, Summary (Zähler bis 80), Slug und Tags, dann die Vorschläge zum Abhaken
/// in Gruppen mit „alle“/„keine“. Ein Tipp auf eine Zeile schaltet das Häkchen, das Symbol daneben
/// öffnet die bestehende Seite als Notiz. Unten fest „Ins Wiki übernehmen (N)“; danach geht es
/// zum nächsten bereiten Entwurf. Daneben „Neu entwerfen“, „Ohne Wiki erledigen“ (mit
/// Rückgängig) und „Entwurf verwerfen“ (mit Rückfrage).
///
/// Ohne bereiten Entwurf zeigt sie den Stand (Claude entwirft, Fehler, schon im Wiki, noch kein
/// Entwurf) und fragt nach, solange Claude arbeitet.
@MainActor
struct IngestReviewScreen: View {
    let docID: String

    @Environment(AppModel.self) private var model
    @Environment(CockpitSession.self) private var session

    var body: some View {
        // Eigener Store je Anmeldung und Text.
        IngestReview(model: model, session: session, docID: docID)
            .id(ObjectIdentifier(session))
    }
}

/// Prüfansicht mit eigenem `IngestReviewStore`.
@MainActor
struct IngestReview: View {
    let model: AppModel
    let session: CockpitSession
    let docID: String

    @State private var store: IngestReviewStore
    @State private var confirmsRedraft = false
    @State private var confirmsDiscard = false
    @Environment(\.scenePhase) private var scenePhase

    init(model: AppModel, session: CockpitSession, docID: String) {
        self.model = model
        self.session = session
        self.docID = docID
        _store = State(initialValue: IngestReviewStore(context: session.context, docID: docID, overview: session.ingest))
    }

    private var toasts: ToastCenter { session.toasts }

    var body: some View {
        content
            .background(Theme.bg)
            .navigationTitle("Ingest")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarItems }
            // Wikilinks und Seiten im Text: Notiz als Blatt, eigene Seiten nativ, Fremdes in Safari.
            .environment(\.openURL, OpenURLAction { url in handle(url) })
            .confirmationDialog("Neu entwerfen?", isPresented: $confirmsRedraft, titleVisibility: .visible) {
                Button("Neu entwerfen", role: .destructive) { redraft() }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("Claude entwirft neu, der jetzige Entwurf geht verloren.")
            }
            .confirmationDialog("Entwurf verwerfen?", isPresented: $confirmsDiscard, titleVisibility: .visible) {
                Button("Entwurf verwerfen", role: .destructive) { run { await $0.discardDraft() } }
                Button("Abbrechen", role: .cancel) {}
            } message: {
                Text("Der Text bleibt auf dem Stapel.")
            }
            .onAppear {
                store.setActive(scenePhase == .active)
                store.startPolling()
            }
            .onDisappear { store.stopPolling() }
            .onChange(of: scenePhase) { _, phase in store.setActive(phase == .active) }
            .task { await appear() }
    }

    // MARK: Zustände

    @ViewBuilder private var content: some View {
        if store.isNotFound {
            ContentUnavailableView("Diesen Text gibt es nicht (mehr).", systemImage: "doc.questionmark")
                .toasts(toasts)
        } else if let doc = store.model {
            if !doc.enabled {
                ContentUnavailableView {
                    Label("Ingest ist nicht eingerichtet", systemImage: "books.vertical")
                } description: {
                    Text("Ingest ins Wiki braucht Claude im Cockpit.")
                }
                .toasts(toasts)
            } else if doc.isReady, let view = doc.view {
                form(doc, view)
            } else {
                stateView(doc)
            }
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Entwurf nicht geladen", error: error) {
                Task { await store.refresh() }
            }
            .toasts(toasts)
        } else {
            ScrollView {
                LesenSkeleton(label: "Entwurf wird geladen", rows: 4)
                    .padding(16)
            }
        }
    }

    // MARK: Prüfen

    private func form(_ doc: IngestDocModel, _ view: IngestDraftView) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                IngestReviewHead(doc: doc, readText: readText)
                LoadStatusView(state: store.state, hasModel: true)
                if !doc.available {
                    IngestUnavailableNote(reason: nil)
                }
                if let halted = view.halted {
                    IngestHaltedNote(halted: halted, openNote: { openNote($0) })
                }
                IngestDigestSection(view: view)
                IngestSourceSection(store: store, source: view.source, actions: blockActions)
                if doc.groups.isEmpty {
                    Text("Claude schlägt nichts über die Source-Page hinaus vor.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text3)
                        .cardStyle()
                }
                ForEach(doc.groups) { group in
                    IngestGroupSection(group: group, view: view, store: store, actions: blockActions, openNote: { openNote($0) })
                }
                sideActions(doc)
                    .padding(.top, 4)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.refresh() }
        .toasts(toasts)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            applyBar
        }
    }

    /// Unten fest: was übernommen wird und „Ins Wiki übernehmen“ mit der Zahl.
    private var applyBar: some View {
        let applying = store.busy.contains("uebernehmen")
        return VStack(alignment: .leading, spacing: 6) {
            Text(store.applySummary)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.text)
            Button {
                run { await $0.apply() }
            } label: {
                HStack(spacing: 8) {
                    if applying {
                        ProgressView()
                            .tint(Theme.onAccent)
                    }
                    Text("Ins Wiki übernehmen")
                    Text("\(store.applyCount)")
                        .monospacedDigit()
                        .padding(.horizontal, 8)
                        .padding(.vertical, 1)
                        .background(Theme.onAccent.opacity(0.22), in: Capsule())
                        .contentTransition(.numericText(value: Double(store.applyCount)))
                }
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 34)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .disabled(!store.canApply)
            .accessibilityLabel("Ins Wiki übernehmen: \(store.applySummary)")
            Text("Der Text kommt mit nach raw/ und gilt danach als gelesen.")
                .font(.caption)
                .foregroundStyle(Theme.text3)
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(Theme.bg)
        .overlay(alignment: .top) {
            Theme.line.frame(height: 0.5)
        }
        .animation(.snappy, value: store.applyCount)
    }

    /// „Neu entwerfen“, „Ohne Wiki erledigen“, „Entwurf verwerfen“.
    private func sideActions(_ doc: IngestDocModel) -> some View {
        FolgenActions {
            if doc.available {
                Button {
                    toasts.signal(.selection)
                    confirmsRedraft = true
                } label: {
                    Label("Neu entwerfen", systemImage: "arrow.clockwise")
                }
                .buttonStyle(LesenQuietButtonStyle())
            }
            Button {
                run { await $0.finishWithoutWiki() }
            } label: {
                Label("Ohne Wiki erledigen", systemImage: "checkmark.circle")
            }
            .buttonStyle(LesenQuietButtonStyle())
            .accessibilityHint("Gelesen und weg, mit Rückgängig")
            Button(role: .destructive) {
                toasts.signal(.selection)
                confirmsDiscard = true
            } label: {
                Label("Entwurf verwerfen", systemImage: "trash")
            }
            .buttonStyle(LesenQuietButtonStyle())
        }
        .disabled(!store.busy.isEmpty)
    }

    // MARK: Stand ohne Entwurf

    private func stateView(_ doc: IngestDocModel) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                IngestReviewHead(doc: doc, readText: readText)
                LoadStatusView(state: store.state, hasModel: true)
                if !doc.available {
                    IngestUnavailableNote(reason: nil)
                }
                stateCard(doc)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .refreshable { await store.refresh() }
        .toasts(toasts)
    }

    /// Wie `reviewState` im Web: Claude entwirft, Fehler, schon im Wiki, verworfen, noch keiner.
    @ViewBuilder
    private func stateCard(_ doc: IngestDocModel) -> some View {
        let status = doc.status
        let drafting = store.busy.contains("entwerfen")
        if IngestStatus.isBusy(status) {
            HStack(alignment: .top, spacing: 12) {
                ProgressView()
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(status == IngestStatus.waiting ? "Wartet auf Claude" : "Claude entwirft")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text)
                    Text("\(doc.ingest?.busyLabel ?? "Claude entwirft"). Die Ansicht aktualisiert sich, sobald der Entwurf da ist.")
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .cardStyle()
            .accessibilityElement(children: .combine)
        } else if status == IngestStatus.failed {
            VStack(alignment: .leading, spacing: 12) {
                Text(doc.ingest?.error ?? doc.error ?? "Der Entwurf ist fehlgeschlagen.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                FolgenActions {
                    if doc.available {
                        Button {
                            Task { await store.draft(force: true) }
                        } label: {
                            HStack(spacing: 6) {
                                if drafting {
                                    ProgressView()
                                        .controlSize(.small)
                                        .tint(Theme.onAccent)
                                }
                                Text("Erneut entwerfen")
                            }
                            .font(.subheadline.weight(.semibold))
                            .frame(minHeight: 26)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.accent)
                    }
                    Button("Verwerfen") {
                        run { await $0.discardDraft() }
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                }
                .disabled(!store.busy.isEmpty)
            }
            .cardStyle()
        } else if status == IngestStatus.applied {
            VStack(alignment: .leading, spacing: 12) {
                Text(appliedText(doc))
                    .font(.subheadline)
                    .foregroundStyle(Theme.text)
                if let source = doc.appliedSource {
                    Button {
                        openNote(source)
                    } label: {
                        Label("Source-Page öffnen", systemImage: "doc.text")
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                }
            }
            .cardStyle()
        } else if status == IngestStatus.discarded, let reason = doc.error {
            // Vom Dienst verworfen (der Skill war schneller): Grund nennen, kein neuer Entwurf.
            Text(reason)
                .font(.subheadline)
                .foregroundStyle(Theme.text2)
                .fixedSize(horizontal: false, vertical: true)
                .cardStyle()
        } else {
            VStack(alignment: .leading, spacing: 12) {
                Text(status == IngestStatus.discarded ? "Der letzte Entwurf wurde verworfen." : "Für diesen Text gibt es noch keinen Entwurf.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text2)
                if doc.available {
                    Button {
                        Task { await store.draft() }
                    } label: {
                        HStack(spacing: 6) {
                            if drafting {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(Theme.onAccent)
                            } else {
                                Image(systemName: "sparkles")
                                    .accessibilityHidden(true)
                            }
                            Text("Ingest entwerfen")
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 26)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .disabled(drafting)
                }
            }
            .cardStyle()
        }
    }

    /// „Schon im Wiki, seit 25. Okt., 03:10.“
    private func appliedText(_ doc: IngestDocModel) -> String {
        let since = doc.ingest?.appliedAt.flatMap(CockpitFormat.date(from:)).map { ", seit \(CockpitFormat.dayTime($0, timeZone: .current))" } ?? ""
        return "Schon im Wiki\(since)."
    }

    // MARK: Werkzeuge

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            if store.state.isRefreshing && store.model != nil && !store.isPolling {
                ProgressView()
                    .accessibilityLabel("Lädt neu")
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if let doc = store.model, doc.isReady, doc.position != nil, doc.total > 1 {
                Button {
                    if let prev = doc.prev { switchTo(prev) }
                } label: {
                    Image(systemName: "chevron.up")
                }
                .disabled(doc.prev == nil)
                .accessibilityLabel("Voriger Entwurf")
                Button {
                    if let next = doc.next { switchTo(next) }
                } label: {
                    Image(systemName: "chevron.down")
                }
                .disabled(doc.next == nil)
                .accessibilityLabel("Nächster Entwurf")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            if let doc = store.model, doc.isReady {
                Menu {
                    if doc.available {
                        Button {
                            confirmsRedraft = true
                        } label: {
                            Label("Neu entwerfen", systemImage: "arrow.clockwise")
                        }
                    }
                    Button {
                        run { await $0.finishWithoutWiki() }
                    } label: {
                        Label("Ohne Wiki erledigen", systemImage: "checkmark.circle")
                    }
                    Button(role: .destructive) {
                        confirmsDiscard = true
                    } label: {
                        Label("Entwurf verwerfen", systemImage: "trash")
                    }
                    Button {
                        readText()
                    } label: {
                        Label("Text lesen", systemImage: "book")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(!store.busy.isEmpty)
                .accessibilityLabel("Aktionen")
            }
        }
    }

    // MARK: Aktionen und Wege

    /// Aktion des Stores, danach dorthin, wohin der Server führt (nächster Entwurf, Übersicht).
    private func run(_ action: @escaping @MainActor (IngestReviewStore) async -> String?) {
        let store = store
        Task { go(await action(store)) }
    }

    private func redraft() {
        Task { await store.draft(force: true) }
    }

    /// `redirect` einer Aktion: der nächste Entwurf ersetzt diese Ansicht; die Übersicht heißt
    /// zurück, wenn die Prüfansicht obenauf liegt (sonst wie ein Link).
    private func go(_ path: String?) {
        guard let path else { return }
        if case .ingestReview(let id)? = ReadingRoute(webPath: path) {
            if id != docID { switchTo(id) }
        } else if model.readingPath.last == .ingestReview(id: docID) {
            model.readingPath.removeLast()
        } else {
            model.open(path: path)
        }
    }

    /// Anderer Entwurf an dieser Stelle des Stapels (Blättern, nach dem Übernehmen).
    private func switchTo(_ id: String) {
        toasts.signal(.selection)
        let route = ReadingRoute.ingestReview(id: id)
        if let last = model.readingPath.indices.last, model.readingPath[last] == .ingestReview(id: docID) {
            model.readingPath[last] = route
        } else {
            model.readingPath.append(route)
        }
    }

    private func readText() {
        toasts.signal(.selection)
        model.readingPath.append(.reader(id: docID, highlight: nil, resume: false))
    }

    private func openNote(_ path: String, anchor: String? = nil) {
        toasts.signal(.selection)
        model.open(page: .note(path: path, anchor: anchor))
    }

    /// Links im Text: Notizen aus den Wikilinks (`x-cockpit-notiz://`), sonst wie überall.
    private func handle(_ url: URL) -> OpenURLAction.Result {
        if let destination = NoteScreenLink.destination(of: url) {
            if case .note(let path, let anchor) = destination { openNote(path, anchor: anchor) }
            return .handled
        }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return .systemAction
        }
        model.open(url: url)
        return .handled
    }

    /// Für die Blöcke der Source-Page und der neuen Seiten: nur Anzeige, Links öffnen Notizen.
    private var blockActions: NoteScreenActions {
        let api = session.context.api
        return NoteScreenActions(
            canToggle: false,
            isBusy: { _ in false },
            toggle: { _ in },
            loadImage: { src in try? await api.resource(src).data },
            openImage: { _ in },
            openLink: { destination in
                if case .note(let path, let anchor) = destination { openNote(path, anchor: anchor) }
            },
            copy: { UIPasteboard.general.string = $0 }
        )
    }

    // MARK: Laden

    /// Erster Auftritt: gespeicherter Stand und Laden; danach neu laden.
    private func appear() async {
        if store.model == nil {
            await store.load()
        } else if !store.state.isRefreshing {
            await store.refresh()
        }
    }
}
