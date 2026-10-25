import CockpitShared
import SwiftUI

/// Eingang nativ (`/lesen/eingang` im Web): eine Karte nach der anderen sichten. Wischen nach links
/// (weg), rechts (lesen) oder unten (Stapel) oder die Knöpfe darunter; die Karte fliegt sofort
/// hinaus, der Store sendet danach und bringt sie zurück, wenn es scheitert. Dazu Rückgängig der
/// letzten Entscheidung von heute, „Im Vault ablegen“, Gruppen-Chips und „Heute x von y gesichtet“.
@MainActor
struct EingangScreen: View {
    let model: AppModel
    let store: InboxStore
    let toasts: ToastCenter

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var swipe: EingangSwipe?
    @GestureState private var isDragging = false
    @State private var flight: EingangFlight?
    @State private var cardSize: CGSize = .zero
    @State private var screenSize: CGSize = .zero

    /// Wohin das Loslassen gerade entscheiden würde.
    private var toward: InboxDecision? {
        swipe?.target(card: cardSize)
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.bg)
            .background {
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { screenSize = proxy.size }
                        .onChange(of: proxy.size) { _, size in screenSize = size }
                }
            }
            .toasts(toasts)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let inbox = store.model {
                    actions(inbox)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if store.state.isRefreshing && store.model != nil {
                        ProgressView()
                            .accessibilityLabel("Lädt neu")
                    }
                }
            }
            .sensoryFeedback(.impact(weight: .light), trigger: toward) { old, new in
                new != nil && old != new
            }
            .onChange(of: isDragging) { _, dragging in
                // Abgebrochenes Ziehen (System-Geste): Karte zurück. Nach `onEnded` ist `swipe` schon nil.
                guard !dragging else { return }
                Task { @MainActor in
                    guard swipe != nil, flight == nil else { return }
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) { swipe = nil }
                }
            }
            .task { await appear() }
    }

    // MARK: Inhalt

    @ViewBuilder private var content: some View {
        if let inbox = store.model {
            VStack(spacing: 12) {
                if inbox.showGroups {
                    LesenGroupChips(groups: inbox.groups, current: store.group, noFeedCount: inbox.noFeedCount) { group in
                        guard group != store.group else { return }
                        toasts.signal(.selection)
                        Task { await store.load(group: group) }
                    }
                    .padding(.top, 4)
                }
                VStack(alignment: .leading, spacing: 10) {
                    LoadStatusView(state: store.state, hasModel: true)
                    progress(inbox)
                }
                .padding(.horizontal, 16)
                if let card = store.card {
                    cardArea(card, more: inbox.more)
                } else if store.isDeciding || flight != nil {
                    // Die Karte ist weg, die nächste kommt noch.
                    EingangPlaceholderCard()
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                        .transition(.opacity)
                } else {
                    empty
                }
            }
            .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.38, dampingFraction: 0.82), value: store.card?.id)
        } else if let error = store.state.error, !store.state.isRefreshing {
            LoadFailedView(title: "Eingang nicht geladen", error: error) {
                Task { await store.refresh() }
            }
        } else {
            EingangPlaceholderCard()
                .padding(16)
        }
    }

    /// „Heute 1 von 2 gesichtet“ mit Balken (nur, wenn es heute etwas zu sichten gab).
    @ViewBuilder
    private func progress(_ inbox: ReadingInboxModel) -> some View {
        if inbox.today.total > 0 {
            VStack(alignment: .leading, spacing: 6) {
                LesenBar(value: Double(inbox.today.seen) / Double(inbox.today.total))
                Text(inbox.progressLabel)
                    .font(.footnote)
                    .foregroundStyle(Theme.text3)
                    .contentTransition(.numericText(value: Double(inbox.today.seen)))
                    .animation(.snappy, value: inbox.today.seen)
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// Oberste Karte zum Wischen; bei mehr als einer Karte mit angedeuteten Karten darunter.
    private func cardArea(_ card: InboxCard, more: Bool) -> some View {
        EingangCard(card: card, more: more, toward: flight == nil ? toward : nil)
            .background {
                GeometryReader { proxy in
                    Color.clear
                        .onAppear { cardSize = proxy.size }
                        .onChange(of: proxy.size) { _, size in cardSize = size }
                }
            }
            .rotationEffect(.degrees(rotation(for: card)))
            .offset(offset(for: card))
            .opacity(flight?.id == card.id ? 0 : 1)
            .highPriorityGesture(drag)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Nach links wischen: weg. Nach rechts: jetzt lesen. Nach unten: auf den Stapel.")
            .accessibilityAction(named: "Weg") { decide(.weg) }
            .accessibilityAction(named: "Auf den Stapel") { decide(.stapel) }
            .accessibilityAction(named: "Jetzt lesen") { decide(.lesen) }
            .accessibilityAction(named: "Im Vault ablegen") { file() }
            .id(card.id)
            .transition(.asymmetric(insertion: .scale(scale: 0.96).combined(with: .opacity), removal: .opacity))
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, more ? 24 : 12)
            .frame(maxHeight: .infinity, alignment: .top)
            .zIndex(1)
    }

    /// „Eingang leer“ mit Weg zum Stapel, darunter gleich „Adresse speichern“ (offen wie im Web).
    private var empty: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(spacing: 6) {
                    Text("Eingang leer")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Theme.text)
                    HStack(spacing: 4) {
                        Text("Alles gesichtet.")
                            .foregroundStyle(Theme.text2)
                        Button("Zum Stapel") {
                            toasts.signal(.selection)
                            model.readingSection = .stapel
                        }
                        .foregroundStyle(Theme.accent)
                    }
                    .font(.subheadline)
                }
                .padding(.vertical, 36)
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity)
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Adresse speichern")
                        .font(.headline)
                        .foregroundStyle(Theme.text)
                        .accessibilityAddTraits(.isHeader)
                    EingangSaveForm(store: store)
                }
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.refresh() }
        .transition(.opacity)
    }

    // MARK: Entscheiden

    /// Knöpfe unten wie auf dem iPhone im Web: Rückgängig, Ablegen, Adresse speichern; darunter
    /// Weg, Stapel, Jetzt lesen.
    private func actions(_ inbox: ReadingInboxModel) -> some View {
        let hasCard = store.card != nil
        return VStack(spacing: 10) {
            HStack(spacing: 8) {
                if inbox.undo != nil {
                    Button {
                        toasts.signal(.selection)
                        Task { await store.undoLast() }
                    } label: {
                        Text("↶ Rückgängig")
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                    .disabled(store.isDeciding)
                    .accessibilityLabel(inbox.today.last.map { "Rückgängig: \($0.displayTitle)" } ?? "Rückgängig")
                    .transition(.opacity)
                }
                Spacer(minLength: 0)
                if inbox.vault && hasCard {
                    Button("Im Vault ablegen") { file() }
                        .buttonStyle(LesenQuietButtonStyle())
                        .disabled(store.isDeciding)
                        .transition(.opacity)
                }
                if hasCard {
                    Button {
                        toasts.signal(.selection)
                        model.showsAdd = true
                    } label: {
                        Image(systemName: "link.badge.plus")
                    }
                    .buttonStyle(LesenQuietButtonStyle())
                    .accessibilityLabel("Adresse speichern")
                }
            }
            if hasCard || store.isDeciding || flight != nil {
                HStack(spacing: 8) {
                    decideButton(.weg)
                    decideButton(.stapel)
                    decideButton(.lesen)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background(Theme.bg)
        .animation(.snappy, value: inbox.undo)
        .animation(.snappy, value: hasCard)
    }

    private func decideButton(_ decision: InboxDecision) -> some View {
        Button { decide(decision) } label: {
            Text(Self.buttonLabel(decision))
                .frame(maxWidth: .infinity, minHeight: 56)
        }
        .buttonStyle(EingangDecideStyle(decision: decision))
        .disabled(store.card == nil || store.isDeciding || flight != nil)
        .accessibilityLabel(Self.accessibilityLabel(decision))
    }

    /// „← Weg“, „↓ Stapel“, „Jetzt lesen →“ wie die Knöpfe im Web.
    static func buttonLabel(_ decision: InboxDecision) -> String {
        switch decision {
        case .weg: "← Weg"
        case .stapel: "↓ Stapel"
        case .lesen: "Jetzt lesen →"
        }
    }

    static func accessibilityLabel(_ decision: InboxDecision) -> String {
        switch decision {
        case .weg: "Weg"
        case .stapel: "Auf den Stapel"
        case .lesen: "Jetzt lesen"
        }
    }

    /// Ziehen der Karte; die Richtung legt `EingangSwipe` fest.
    private var drag: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($isDragging) { _, dragging, _ in dragging = true }
            .onChanged { value in
                guard flight == nil, !store.isDeciding else { return }
                var next = swipe ?? EingangSwipe(startX: value.startLocation.x, width: screenSize.width)
                next.update(value.translation)
                swipe = next
            }
            .onEnded { _ in
                guard let ended = swipe else { return }
                if let target = ended.target(card: cardSize) {
                    decide(target)
                } else {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) { swipe = nil }
                }
            }
    }

    /// Karte hinaus, dann senden; bei „Jetzt lesen“ geht die Leseansicht sofort auf. Scheitert es,
    /// federt die Karte zurück (der Store bringt sie wieder).
    private func decide(_ decision: InboxDecision) {
        guard let card = store.card, flight == nil, !store.isDeciding else { return }
        if decision == .lesen {
            model.readingPath.append(.reader(id: card.id, highlight: nil, resume: card.isStarted))
        }
        withAnimation(reduceMotion ? .easeOut(duration: 0.15) : .easeIn(duration: 0.22)) {
            swipe = nil
            flight = EingangFlight(id: card.id, decision: decision)
        }
        Task {
            // Erst fliegt die Karte hinaus, dann nimmt der Store sie weg und sendet.
            try? await Task.sleep(nanoseconds: 180_000_000)
            let ok = await store.decide(decision)
            if ok {
                flight = nil
            } else {
                withAnimation(.spring(response: 0.42, dampingFraction: 0.7)) { flight = nil }
            }
        }
    }

    /// „Im Vault ablegen“ (A): Karte weg, Meldung mit Rückgängig.
    private func file() {
        guard store.card != nil, store.model?.vault == true, flight == nil else { return }
        Task { await store.file() }
    }

    private func offset(for card: InboxCard) -> CGSize {
        guard let flight, flight.id == card.id else { return swipe?.offset ?? .zero }
        guard !reduceMotion else { return .zero }
        let width = max(screenSize.width, 320) * 1.2
        let height = max(screenSize.height, 480) * 0.6
        switch flight.decision {
        case .weg: return CGSize(width: -width, height: 0)
        case .lesen: return CGSize(width: width, height: 0)
        case .stapel: return CGSize(width: 0, height: height)
        }
    }

    private func rotation(for card: InboxCard) -> Double {
        guard !reduceMotion else { return 0 }
        guard let flight, flight.id == card.id else { return swipe?.rotation ?? 0 }
        switch flight.decision {
        case .weg: return -12
        case .lesen: return 12
        case .stapel: return 0
        }
    }

    // MARK: Laden

    /// Erster Auftritt: gespeicherter Stand und Laden; danach (zurück aus der Leseansicht, Bereich
    /// wieder gewählt) neu laden, wie das Web die Seite beim Zurückkommen neu holt.
    private func appear() async {
        if store.model == nil {
            await store.load(group: store.group)
        } else if !store.state.isRefreshing {
            await store.refresh()
        }
    }
}

/// Knöpfe der Entscheidung (`.inbox-decide .btn`): Jetzt lesen hervorgehoben, Weg in Rot.
struct EingangDecideStyle: ButtonStyle {
    let decision: InboxDecision
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let primary = decision == .lesen
        return configuration.label
            .font(.body.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(primary ? Theme.onAccent : (decision == .weg ? Theme.danger : Theme.text))
            .background(primary ? Theme.accent : Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                    .strokeBorder(primary ? Color.clear : Theme.line)
            }
            .shadow(color: .black.opacity(0.08), radius: 8, y: 3)
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}

/// „Adresse speichern“: Adresse in den Lesestapel (`/aktion/lesen/speichern`); bleibt stehen,
/// bis es geklappt hat, damit ein zweiter Versuch dieselbe `cid` hat.
@MainActor
struct EingangSaveForm: View {
    let store: InboxStore
    /// Nach dem Speichern, z. B. „Jetzt lesen“ im Blatt „Hinzufügen“.
    var onSaved: ((ReadingActionDoc) -> Void)?

    @State private var url = ""
    @State private var shake: CGFloat = 0
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField("https://… Artikel speichern", text: $url)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($focused)
                .onSubmit(save)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                        .strokeBorder(focused ? Theme.accentLine : Theme.line)
                }
                .modifier(ShakeEffect(animatableData: shake))
                .accessibilityLabel("Adresse des Artikels")
            Button(action: save) {
                ZStack {
                    Text("Speichern").opacity(store.isSaving ? 0 : 1)
                    if store.isSaving {
                        ProgressView()
                            .tint(Theme.onAccent)
                    }
                }
                .frame(minHeight: 44)
                .padding(.horizontal, 6)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: Theme.radius))
            .tint(Theme.accent)
            .disabled(store.isSaving)
            .accessibilityLabel(store.isSaving ? "Speichert" : "Speichern")
        }
    }

    private func save() {
        let text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty {
            withAnimation(.linear(duration: 0.3)) { shake += 1 }
        }
        Task {
            // Leer meldet der Store selbst („Bitte eine Adresse eingeben“).
            guard let doc = await store.save(url: text) else { return }
            url = ""
            focused = false
            onSaved?(doc)
        }
    }
}
