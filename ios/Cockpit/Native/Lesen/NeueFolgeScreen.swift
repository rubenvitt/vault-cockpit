import CockpitShared
import SwiftUI

/// „Neue Folge“ nativ (`/lesen/folgen/neu?zeit=` im Web) in Schritten: Welche Texte?
/// (Zeitfenster, alle passenden Texte vorausgewählt), Was soll daraus werden? (Vorlesen, Podcast,
/// Report; was nicht geht, mit Grund), bei Podcast und Report Wie lang?, Ton und Schwerpunkt
/// (Themen der Texte, eigener Wunsch) und Gleich mit Audio? (sonst erst nur das Transkript). Der Satz am Knopf
/// rechnet bei jeder Änderung neu; abgeschickt wird höchstens einmal, danach geht es zu den Folgen.
@MainActor
struct NeueFolgeScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(CockpitSession.self) private var session

    var body: some View {
        NeueFolgeForm(model: model, session: session)
            .id(ObjectIdentifier(session))
    }
}

/// Formular mit eigenem `NewEpisodeStore`.
@MainActor
struct NeueFolgeForm: View {
    let model: AppModel
    let session: CockpitSession

    @State private var store: NewEpisodeStore
    @FocusState private var focusField: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(model: AppModel, session: CockpitSession) {
        self.model = model
        self.session = session
        _store = State(initialValue: NewEpisodeStore(context: session.context))
    }

    private var toasts: ToastCenter { session.toasts }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                content
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let form = store.model, form.enabled, !form.docs.isEmpty {
                NeueFolgeSubmitBar(store: store, submit: submit)
            }
        }
        .refreshable { await store.refresh() }
        .toasts(toasts)
        .navigationTitle("Neue Folge")
        .navigationBarTitleDisplayMode(.inline)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.35, dampingFraction: 0.85), value: store.usesLength)
        .animation(reduceMotion ? nil : .snappy, value: store.model?.docs.map(\.id))
        .onAppear {
            store.onCreated = { [model] in
                // Zurück zur Liste; sie lädt neu und fragt nach, solange die Folge entsteht.
                model.open(reading: .episodes)
            }
        }
        .task { await appear() }
    }

    // MARK: Inhalt

    @ViewBuilder private var content: some View {
        if let form = store.model {
            LoadStatusView(state: store.state, hasModel: true)
            if !form.enabled {
                FolgenDisabledView(kinds: form.kinds) {
                    toasts.signal(.selection)
                    model.tab = .settings
                }
            } else {
                texts(form)
                if !form.docs.isEmpty {
                    kinds(form)
                    if store.usesLength {
                        Group {
                            lengths(form)
                            if !form.styles.isEmpty {
                                wishes(form)
                            }
                            if form.transcriptOnly {
                                audioChoice
                            }
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                    Text("Die Folge entsteht im Hintergrund, du kannst die Seite verlassen. Fertige stehen unter Folgen.")
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Neue Folge nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else {
            LesenSkeleton(label: "Texte werden geladen", rows: 4)
        }
    }

    // MARK: 1. Welche Texte?

    private func texts(_ form: NewEpisodeModel) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            NeueFolgeStepHead(number: 1, title: "Welche Texte?", hint: form.docs.isEmpty ? "Aus dem Stapel, passend zur Zeit, die du hast." : "Aus dem Stapel, passend zur Zeit, die du hast. Abwählen, was nicht hinein soll.")
            LesenChipScroller("Zeitfenster") {
                ForEach(form.windows, id: \.self) { minutes in
                    LesenChip(label: "\(minutes) Min.", selected: (store.zeit ?? form.zeit) == minutes) {
                        setZeit(minutes)
                    }
                }
            }
            .padding(.horizontal, -16)
            if form.docs.isEmpty {
                Text("Für dieses Zeitfenster passt nichts vom Stapel.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.text3)
                    .cardStyle()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(form.docs.enumerated()), id: \.element.id) { index, item in
                        if index > 0 {
                            Theme.line.frame(height: 0.5)
                                .padding(.leading, 44)
                        }
                        NeueFolgeTextRow(item: item, selected: store.selection.contains(item.id)) {
                            store.toggle(item.id)
                        }
                    }
                }
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                        .strokeBorder(Theme.line)
                }
                HStack {
                    Text("\(store.selection.count) von \(form.docs.count) gewählt")
                        .contentTransition(.numericText(value: Double(store.selection.count)))
                        .animation(.snappy, value: store.selection.count)
                    Spacer()
                    Button(store.selection.count == form.docs.count ? "Keinen" : "Alle") {
                        selectAll(store.selection.count != form.docs.count, form: form)
                    }
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.accent)
                }
                .font(.footnote)
                .foregroundStyle(Theme.text3)
                if store.selection.count > form.maxDocs {
                    Text("Höchstens \(form.maxDocs) Texte je Folge.")
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                }
            }
        }
    }

    // MARK: 2. Was soll daraus werden?

    private func kinds(_ form: NewEpisodeModel) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            NeueFolgeStepHead(number: 2, title: "Was soll daraus werden?", hint: nil)
            VStack(spacing: 8) {
                ForEach(form.kinds) { kind in
                    NeueFolgeKindCard(kind: kind, selected: store.kind == kind.kind) {
                        store.select(kind: kind.kind)
                    }
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Art")
        }
    }

    // MARK: 3. Wie lang?

    private func lengths(_ form: NewEpisodeModel) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            NeueFolgeStepHead(number: 3, title: "Wie lang?", hint: "Gilt für Podcast und Report; Vorlesen dauert so lange wie die Texte.")
            Picker("Länge", selection: Binding(get: { store.length }, set: { store.select(length: $0) })) {
                ForEach(form.lengths, id: \.self) { minutes in
                    Text("\(minutes) Min.").tag(minutes)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: 4. Ton und Schwerpunkt

    private func wishes(_ form: NewEpisodeModel) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            NeueFolgeStepHead(number: 4, title: "Ton und Schwerpunkt", hint: form.languageLabel.map { "Für Claude, auf \($0) (Sprache unter Einstellungen → Vorlesen → Folgen). Ohne Schwerpunkt geht es um alles in den Texten." } ?? "Für Claude. Ohne Schwerpunkt geht es um alles in den Texten.")
            VStack(alignment: .leading, spacing: 8) {
                Text("Ton")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                    .accessibilityAddTraits(.isHeader)
                ChipRow {
                    ForEach(form.styles) { style in
                        LesenChip(label: style.label, selected: store.style == style.style) {
                            store.select(style: style.style)
                        }
                        .accessibilityHint(style.description)
                    }
                }
                if let hint = store.styleHint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                        .contentTransition(.opacity)
                        .animation(.snappy, value: hint)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Schwerpunkt")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.text)
                        .accessibilityAddTraits(.isHeader)
                    Text(form.topics.isEmpty ? "optional" : "optional, höchstens \(form.maxTopics) Themen")
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
                if !form.topics.isEmpty {
                    ChipRow {
                        ForEach(form.topics) { topic in
                            let selected = store.topics.contains(topic.label)
                            LesenChip(label: topic.label, count: topic.count, selected: selected) {
                                store.toggle(topic: topic.label)
                            }
                            .disabled(!selected && !store.canAddTopic)
                            .opacity(!selected && !store.canAddTopic ? 0.45 : 1)
                            .accessibilityValue(selected ? "Gewählt" : "Nicht gewählt")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Themen der Texte")
                }
                TextField("Eigener Wunsch, z. B. Was heißt das für den Alltag?", text: Binding(get: { store.focus }, set: { store.set(focus: $0) }), axis: .vertical)
                    .lineLimit(1...3)
                    .submitLabel(.done)
                    .focused($focusField)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(minHeight: 44)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                            .strokeBorder(focusField ? Theme.accentLine : Theme.line)
                    }
                    .accessibilityLabel("Eigener Schwerpunkt")
            }
        }
    }

    // MARK: 5. Gleich mit Audio?

    private var audioChoice: some View {
        VStack(alignment: .leading, spacing: 12) {
            NeueFolgeStepHead(number: 5, title: "Gleich mit Audio?", hint: "Erst nur das Transkript kostet bei ElevenLabs nichts. Gefällt es dir, wird daraus auf Knopfdruck das Audio, ohne dass Claude noch einmal schreibt.")
            Picker("Audio", selection: Binding(get: { store.audio }, set: { store.select(audio: $0) })) {
                Text("Mit Audio").tag(true)
                Text("Erst nur Transkript").tag(false)
            }
            .pickerStyle(.segmented)
        }
    }

    // MARK: Aktionen

    private func setZeit(_ minutes: Int) {
        guard minutes != (store.zeit ?? store.model?.zeit) else { return }
        toasts.signal(.selection)
        model.newEpisodeZeit = minutes
        Task { await store.load(zeit: minutes) }
    }

    /// „Alle“ bzw. „Keinen“: schaltet die Texte um, die noch anders stehen.
    private func selectAll(_ all: Bool, form: NewEpisodeModel) {
        for item in form.docs where store.selection.contains(item.id) != all {
            store.toggle(item.id)
        }
    }

    private func submit() {
        Task { await store.submit() }
    }

    private func appear() async {
        if store.model == nil {
            await store.load(zeit: model.newEpisodeZeit)
        } else if !store.state.isRefreshing {
            await store.refresh()
        }
    }
}
