import CockpitShared
import SwiftUI
import UIKit

/// API-Tokens (`#tokens` im Web): Liste mit Recht, „angelegt am“ und „Widerrufen“ (mit
/// Rückfrage; der Token dieser App meldet sie danach ab), „Neuer Token“ mit Name und Recht. Den
/// Klartext zeigt das Blatt nur einmal direkt nach dem Anlegen, mit „Kopieren“.
@MainActor
struct SettingsTokensView: View {
    @Environment(CockpitSession.self) private var session
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var name = ""
    @State private var scope = "search"
    @State private var revoking: ApiToken?
    @State private var copied = 0
    @FocusState private var nameFocused: Bool

    private var store: TokensStore { session.tokens }
    private var tokens: [ApiToken] { store.model?.tokens ?? session.settings.model?.tokens ?? [] }
    private var scopes: [TokenScope] { store.model?.scopes ?? session.settings.model?.scopes ?? [] }
    private var intro: String? { session.settings.model?.section(SettingsSection.tokens)?.intro }

    var body: some View {
        Form {
            if let intro {
                Section {
                    SettingsIntro(text: intro, state: nil)
                }
            }
            if let created = store.created {
                createdSection(created)
                    .transition(.opacity)
            }
            listSection
            newSection
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await store.refresh() }
        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85), value: tokens.map(\.id))
        .animation(reduceMotion ? nil : .snappy, value: store.created?.id)
        .sensoryFeedback(.success, trigger: copied)
        .task {
            if store.model == nil { await store.load() } else { await store.refresh() }
        }
        .confirmationDialog(
            "„\(revoking?.name ?? "")“ widerrufen?",
            isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
            titleVisibility: .visible,
            presenting: revoking
        ) { token in
            Button(token.current ? "Widerrufen und abmelden" : "Widerrufen", role: .destructive) {
                Task { await store.revoke(token) }
            }
        } message: { token in
            Text(token.current
                ? "Das ist der Geräte-Token dieser App. Danach meldet sie sich ab, und du musst dich neu anmelden."
                : "Was diesen Token nutzt (Kurzbefehl, Raycast, Funke), bekommt danach keinen Zugriff mehr.")
        }
    }

    // MARK: Klartext

    private func createdSection(_ created: CreatedToken) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Text(created.name)
                        .font(.subheadline.weight(.semibold))
                    TokenScopePill(label: created.scopeLabel)
                }
                Text(created.token)
                    .font(.callout.monospaced())
                    .foregroundStyle(Theme.text)
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bgSunk, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                    .accessibilityLabel("Token")
                    .accessibilityValue(created.token)
                HStack(spacing: 10) {
                    Button {
                        UIPasteboard.general.string = created.token
                        copied += 1
                        session.toasts.show("Token kopiert")
                    } label: {
                        Label("Kopieren", systemImage: "doc.on.doc")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    Button("Fertig") {
                        session.toasts.signal(.selection)
                        store.dismissCreated()
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding(.vertical, 4)
        } header: {
            Text("Neuer Token")
        } footer: {
            Text("Nur jetzt sichtbar: Das Cockpit speichert nur einen Hash. Jetzt kopieren und dort eintragen, wo er gebraucht wird.")
        }
        .listRowBackground(Theme.accentSoft)
    }

    // MARK: Liste

    private var listSection: some View {
        Section {
            if tokens.isEmpty {
                if store.model == nil, store.state.isRefreshing {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Noch keine Tokens.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.text3)
                }
            }
            ForEach(tokens) { token in
                TokenRow(token: token, revoking: store.revoking.contains(token.id)) {
                    session.toasts.signal(.selection)
                    revoking = token
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button(role: .destructive) {
                        revoking = token
                    } label: {
                        Label("Widerrufen", systemImage: "xmark.circle")
                    }
                }
            }
        } header: {
            HStack {
                Text("Tokens")
                Spacer()
                Text("\(tokens.count)")
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(tokens.count)))
            }
        } footer: {
            if let error = store.state.error, store.model != nil, !error.isOffline {
                Text(error.message)
                    .foregroundStyle(Theme.danger)
            }
        }
    }

    // MARK: Anlegen

    private var newSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                TextField("Name, z. B. Raycast", text: $name)
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit(create)
                    .accessibilityLabel("Name")
                if let error = store.fieldErrors["name"] {
                    Label(error, systemImage: "exclamationmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                }
            }
            Picker("Recht", selection: $scope) {
                ForEach(scopes) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .pickerStyle(.menu)
            .tint(Theme.accent)
            if let error = store.fieldErrors["scope"] {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
            Button(action: create) {
                HStack {
                    Spacer()
                    if store.isCreating {
                        ProgressView()
                    } else {
                        Label("Token anlegen", systemImage: "plus")
                            .font(.body.weight(.semibold))
                    }
                    Spacer()
                }
            }
            .disabled(store.isCreating || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } header: {
            Text("Neuer Token")
        } footer: {
            if let text = scopes.first(where: { $0.value == scope })?.text {
                Text(text)
            }
        }
    }

    private func create() {
        let wanted = name
        guard !wanted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        nameFocused = false
        Task {
            if await store.create(name: wanted, scope: scope) != nil {
                name = ""
            }
        }
    }
}

/// Zeile eines Tokens: Name, Recht, „angelegt am“, „dieses Gerät“ und „Widerrufen“.
struct TokenRow: View {
    let token: ApiToken
    let revoking: Bool
    let onRevoke: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(token.name.isEmpty ? "Ohne Namen" : token.name)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Theme.text)
                    TokenScopePill(label: token.scopeLabel)
                }
                HStack(spacing: 6) {
                    if let date = token.createdDate {
                        Text("angelegt am \(Self.day(date))")
                    }
                    if token.current {
                        Label("dieses Gerät", systemImage: "iphone")
                            .foregroundStyle(Theme.accent)
                    }
                }
                .font(.footnote)
                .foregroundStyle(Theme.text3)
            }
            Spacer(minLength: 8)
            if revoking {
                ProgressView()
            } else {
                Button("Widerrufen", role: .destructive, action: onRevoke)
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.borderless)
                    .accessibilityLabel("\(token.name) widerrufen")
            }
        }
        .opacity(revoking ? 0.5 : 1)
        .accessibilityElement(children: .contain)
    }

    /// „25.10.2026“
    static func day(_ date: Date) -> String {
        let p = Calendar.current.dateComponents([.day, .month, .year], from: date)
        func pad(_ n: Int?) -> String { n.map { $0 < 10 ? "0\($0)" : "\($0)" } ?? "00" }
        return "\(pad(p.day)).\(pad(p.month)).\(p.year ?? 0)"
    }
}

/// Recht eines Tokens als Pille (`.pill` im Web).
struct TokenScopePill: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(Theme.accentSoft, in: Capsule())
    }
}
