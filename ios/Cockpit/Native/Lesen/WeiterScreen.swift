import CockpitShared
import SwiftUI

/// „Weiter“ nativ (`/lesen/weiter` im Web): oben „Als Nächstes“, der eine Schritt mit dem meisten
/// Wert, darunter die Stufen Prüfen · Anhören · Entscheiden · Fehler · Weiterlesen · Läuft mit
/// ihren Einträgen, je Text die Spur (Gelesen/Gehört · Entwurf · Im Wiki · Eingepflanzt) und die
/// Knöpfe dazu, unten Eingang und Stapel als Zahl. Solange Claude an etwas arbeitet und der
/// Bildschirm zu sehen ist, lädt er alle 5 s neu.
@MainActor
struct WeiterScreen: View {
    let model: AppModel
    let store: WeiterStore
    let toasts: ToastCenter

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    content(proxy)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .background(Theme.bg)
            .refreshable { await store.refresh() }
        }
        .toasts(toasts)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if store.state.isRefreshing && store.model != nil {
                    ProgressView()
                        .accessibilityLabel("Lädt neu")
                }
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.4, dampingFraction: 0.85), value: listKey)
        .task { await appear() }
        .task(id: watching) { await watch() }
    }

    /// Reihenfolge aller Einträge (für die Animation beim Wechsel).
    private var listKey: [String] {
        store.model?.stages.flatMap { stage in stage.items.map { "\(stage.key):\($0.id)" } } ?? []
    }

    /// Etwas läuft (Claude entwirft oder pflanzt ein) und die App ist vorne.
    private var watching: Bool {
        scenePhase == .active && !(store.model?.stages.first { $0.key == "laeuft" }?.items.isEmpty ?? true)
    }

    // MARK: Inhalt

    @ViewBuilder
    private func content(_ proxy: ScrollViewProxy) -> some View {
        if let weiter = store.model {
            WeiterNextCard(next: weiter.next, isClear: weiter.isClear, isWorking: store.isDraftingAll) {
                follow(weiter.next, proxy: proxy)
            }
            LoadStatusView(state: store.state, hasModel: true)
            ForEach(weiter.visibleStages) { stage in
                section(stage, in: weiter)
            }
            WeiterUnreadCard(counts: weiter.counts, episodes: weiter.episodes, open: openSection, listen: {
                toasts.signal(.selection)
                model.open(reading: .listen(zeit: 15))
            }, newEpisode: {
                toasts.signal(.selection)
                model.open(reading: .newEpisode(zeit: 30))
            })
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "„Weiter“ nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else {
            LesenSkeleton(label: "Wird geladen", rows: 4)
                .padding(.top, 8)
        }
    }

    @ViewBuilder
    private func section(_ stage: WeiterStage, in weiter: WeiterModel) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            IngestSectionHeader(title: stage.label, count: stage.items.count)
            if !stage.hint.isEmpty {
                Text(stage.hint)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // Sprungziel für „Als Nächstes“ (`#entscheiden`).
        .id(stage.key)
        if stage.key == "entscheiden", weiter.ingestAvailable, weiter.draftable > 1 {
            Button {
                Task { await store.draftAll() }
            } label: {
                HStack(spacing: 6) {
                    if store.isDraftingAll {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "sparkles")
                            .accessibilityHidden(true)
                    }
                    Text("Alle \(weiter.draftable) entwerfen lassen")
                }
            }
            .buttonStyle(LesenQuietButtonStyle())
            .disabled(store.isDraftingAll)
            .accessibilityHint("Claude entwirft einen nach dem anderen; ins Wiki kommt nur, was du danach abhakst")
        }
        ForEach(stage.items) { item in
            WeiterItemCard(
                item: item,
                weiter: weiter,
                isBusy: store.busy.contains(item.id),
                open: { open(item) },
                act: { action in perform(action, on: item) },
                openDoc: { id in
                    toasts.signal(.selection)
                    model.open(reading: .reader(id: id, highlight: nil, resume: false))
                }
            )
            .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .scale(scale: 0.95).combined(with: .opacity)))
        }
    }

    // MARK: Aktionen

    /// Knopf von „Als Nächstes“: Aktion, Sprung auf eine Stufe dieser Seite, eine Folge abspielen
    /// oder ein Link des Lesens.
    private func follow(_ next: WeiterNext, proxy: ScrollViewProxy) {
        toasts.signal(.selection)
        if next.action == ReadingAction.draftAllRead {
            Task { await store.draftAll() }
        } else if let anchor = next.anchor {
            withAnimation(reduceMotion ? nil : .snappy) { proxy.scrollTo(anchor, anchor: .top) }
        } else if next.stage == "anhoeren", let item = store.model?.stages.first(where: { $0.key == "anhoeren" })?.items.first {
            play(item)
        } else if let href = next.href {
            model.open(path: href)
        }
    }

    /// Titel antippen: Prüfansicht (Prüfen, Fehler), Folge abspielen (Anhören) oder Leseansicht.
    private func open(_ item: WeiterItem) {
        toasts.signal(.selection)
        if item.episode != nil {
            play(item)
        } else if let doc = item.doc {
            switch item.stage {
            case "pruefen", "fehler": model.open(reading: .ingestReview(id: doc.id))
            default: model.open(reading: .reader(id: doc.id, highlight: nil, resume: item.stage == "weiterlesen"))
            }
        }
    }

    private func perform(_ action: WeiterAction, on item: WeiterItem) {
        switch action {
        case .review, .read:
            open(item)
        case .play:
            toasts.signal(.selection)
            play(item)
        case .draft:
            Task { await store.draft(item) }
        case .redraft:
            Task { await store.draft(item, force: true) }
        case .replant:
            Task { await store.plant(item) }
        case .vault:
            Task { await store.toVault(item) }
        case .finish:
            Task { await store.finish(item) }
        case .heard:
            Task { await store.markHeard(item) }
        }
    }

    /// Ungehörte Folge im nativen Player (wie „Abspielen“ unter Folgen).
    private func play(_ item: WeiterItem) {
        guard let episode = item.episode else { return }
        model.episode = AppModel.EpisodeRequest(episodeID: episode.id, title: episode.title, kind: episode.kindLabel, seconds: Double(episode.seconds ?? 0), bytes: episode.bytes ?? 0)
    }

    private func openSection(_ section: LesenSection) {
        toasts.signal(.selection)
        model.readingPath = []
        model.readingSection = section
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

    /// Solange etwas läuft: alle 5 s neu laden.
    private func watch() async {
        guard watching else { return }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            guard !Task.isCancelled else { return }
            await store.refresh()
        }
    }
}

/// Was ein Knopf an einem Eintrag tut.
enum WeiterAction {
    case review, read, play, draft, redraft, replant, vault, finish, heard
}

/// Ein Knopf an einem Eintrag; `primary` in Akzentfarbe.
struct WeiterButton: Identifiable {
    let label: String
    let action: WeiterAction
    var primary = false

    init(_ label: String, _ action: WeiterAction, primary: Bool = false) {
        self.label = label
        self.action = action
        self.primary = primary
    }

    var id: String { label }
}

// MARK: Karten

/// „Als Nächstes“ (`.weiter-next`): Satz und ein Knopf; grün, wenn nichts wartet.
struct WeiterNextCard: View {
    let next: WeiterNext
    let isClear: Bool
    let isWorking: Bool
    let follow: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ALS NÄCHSTES")
                .font(.caption.weight(.bold))
                .tracking(0.8)
                .foregroundStyle(isClear ? Theme.ok : Theme.accent)
            Text(next.text)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            if let label = next.label {
                Button(action: follow) {
                    HStack(spacing: 6) {
                        if isWorking {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.onAccent)
                        }
                        Text(label)
                    }
                    .font(.body.weight(.semibold))
                    .frame(minHeight: 32)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .disabled(isWorking)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isClear ? Theme.okSoft : Theme.accentSoft, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(isClear ? Color.clear : Theme.accentLine)
        }
        .accessibilityElement(children: .contain)
    }
}

/// Ein Eintrag (`.weiter-item`): Titel, Meta, Stand, Spur und die Knöpfe seiner Stufe. Unter
/// „Anhören“ eine Folge mit ihren Texten.
struct WeiterItemCard: View {
    let item: WeiterItem
    let weiter: WeiterModel
    let isBusy: Bool
    let open: () -> Void
    let act: (WeiterAction) -> Void
    let openDoc: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: open) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if item.stage == "laeuft" {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(item.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            let meta = item.meta()
            if !meta.isEmpty {
                Text(meta)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let state = item.state {
                Text(state)
                    .font(.footnote)
                    .foregroundStyle(item.stage == "fehler" ? Theme.text : Theme.text2)
                    .padding(item.stage == "fehler" ? 8 : 0)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(item.stage == "fehler" ? Theme.warnSoft : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !item.docs.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.docs.count == 1 ? "Text" : "\(item.docs.count) Texte")
                        .font(.caption)
                        .foregroundStyle(Theme.text3)
                    ForEach(item.docs) { doc in
                        Button {
                            openDoc(doc.id)
                        } label: {
                            Label(doc.label, systemImage: "doc.text")
                                .font(.footnote)
                                .foregroundStyle(Theme.text2)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            if !item.track.isEmpty {
                WeiterTrack(steps: item.track)
            }
            let buttons = actions
            if !buttons.isEmpty {
                FlowLayout(spacing: 8) {
                    ForEach(buttons) { button in
                        if button.primary {
                            Button(button.label) { act(button.action) }
                                .font(.subheadline.weight(.semibold))
                                .buttonStyle(.borderedProminent)
                                .tint(Theme.accent)
                        } else {
                            Button(button.label) { act(button.action) }
                                .buttonStyle(LesenQuietButtonStyle())
                        }
                    }
                }
            }
        }
        .cardStyle()
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(borderColor)
        }
        .opacity(isBusy ? 0.5 : 1)
        .disabled(isBusy)
        .accessibilityElement(children: .contain)
    }

    private var borderColor: Color {
        switch item.stage {
        case "pruefen", "anhoeren": Theme.accentLine
        case "fehler": Theme.danger.opacity(0.3)
        default: Color.clear
        }
    }

    /// Knöpfe je Stufe wie `actions` in src/lesen/weiter.js.
    private var actions: [WeiterButton] {
        switch item.stage {
        case "pruefen":
            return [WeiterButton("Prüfen", .review, primary: true)]
        case "anhoeren":
            return [WeiterButton(item.episode?.isStarted == true ? "Weiterhören" : "Anhören", .play, primary: true), WeiterButton("Als gehört markieren", .heard)]
        case "entscheiden":
            var list: [WeiterButton] = []
            if weiter.ingestAvailable, item.ingest?.status != "uebernommen" { list.append(WeiterButton("Ins Wiki: entwerfen", .draft, primary: true)) }
            if weiter.vault { list.append(WeiterButton("Nur in den Vault", .vault)) }
            list.append(WeiterButton("Fertig, weg", .finish))
            return list
        case "fehler":
            let look = WeiterButton("Ansehen", .review)
            if item.isPlantFailure {
                return weiter.plantAvailable ? [WeiterButton("Erneut einpflanzen", .replant, primary: true), look] : [look]
            }
            return weiter.ingestAvailable ? [WeiterButton("Erneut entwerfen", .redraft, primary: true), look] : [look]
        case "weiterlesen":
            return [WeiterButton("Weiterlesen", .read, primary: true)]
        default:
            return []
        }
    }
}

/// Spur Gelesen/Gehört · Entwurf · Im Wiki · Eingepflanzt (`.weiter-spur`).
struct WeiterTrack: View {
    let steps: [WeiterStep]

    var body: some View {
        FlowLayout(spacing: 4) {
            ForEach(steps) { step in
                HStack(spacing: 3) {
                    if let mark = mark(step.state) {
                        Text(mark)
                            .accessibilityHidden(true)
                    }
                    Text(step.label)
                }
                .font(.caption2.weight(step.state == "todo" || step.state == "busy" ? .regular : .semibold))
                .foregroundStyle(foreground(step.state))
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(background(step.state), in: Capsule())
                .overlay {
                    Capsule().strokeBorder(border(step.state), style: StrokeStyle(lineWidth: 1, dash: step.state == "todo" ? [3, 2] : []))
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(step.label): \(spoken(step.state))")
            }
        }
    }

    private func mark(_ state: String) -> String? {
        switch state {
        case "done": "✓"
        case "busy": "…"
        case "failed": "!"
        default: nil
        }
    }

    private func foreground(_ state: String) -> Color {
        switch state {
        case "done": Theme.ok
        case "busy": Theme.accent
        case "failed": Theme.danger
        default: Theme.text3
        }
    }

    private func background(_ state: String) -> Color {
        switch state {
        case "done": Theme.okSoft
        case "busy": Theme.accentSoft
        case "failed": Theme.dangerSoft
        default: Color.clear
        }
    }

    private func border(_ state: String) -> Color {
        switch state {
        case "busy": Theme.accentLine
        case "failed": Theme.danger.opacity(0.3)
        case "todo": Theme.lineStrong
        default: Color.clear
        }
    }

    private func spoken(_ state: String) -> String {
        switch state {
        case "done": "erledigt"
        case "busy": "läuft"
        case "failed": "fehlgeschlagen"
        default: "offen"
        }
    }
}

/// „Noch ungelesen“: Eingang und Stapel als Zahl mit dem Weg dorthin.
struct WeiterUnreadCard: View {
    let counts: WeiterCounts
    let episodes: Bool
    let open: (LesenSection) -> Void
    let listen: () -> Void
    let newEpisode: () -> Void

    var body: some View {
        if counts.eingang > 0 || counts.stapel > 0 {
            VStack(alignment: .leading, spacing: 10) {
                IngestSectionHeader(title: "Noch ungelesen", count: counts.eingang + counts.stapel)
                Text("Was du hörst oder zu Ende liest, landet von selbst oben unter „Entscheiden“.")
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .fixedSize(horizontal: false, vertical: true)
                if counts.eingang > 0 {
                    row(.eingang, "\(counts.eingang) \(counts.eingang == 1 ? "Text" : "Texte") zu sichten")
                }
                if counts.stapel > 0 {
                    row(.stapel, "\(counts.stapel) \(counts.stapel == 1 ? "Text" : "Texte"), etwa \(counts.stapelMinutes) Min.")
                    FlowLayout(spacing: 8) {
                        Button("Unterwegs hören", action: listen)
                            .buttonStyle(LesenQuietButtonStyle())
                        if episodes {
                            Button("Folge erzeugen", action: newEpisode)
                                .buttonStyle(LesenQuietButtonStyle())
                        }
                    }
                }
            }
        }
    }

    private func row(_ section: LesenSection, _ detail: String) -> some View {
        Button {
            open(section)
        } label: {
            HStack {
                Label(section.label, systemImage: section.symbol)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.text)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .accessibilityHidden(true)
            }
            .cardStyle(padding: 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
