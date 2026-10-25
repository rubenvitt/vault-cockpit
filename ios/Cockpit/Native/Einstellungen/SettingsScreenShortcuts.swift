import CockpitShared
import SwiftUI

/// Kurzbefehle (`#kurzbefehle` im Web): je Kurzbefehl Titel und Erklärung, „Laden“ holt die
/// `.shortcut`-Datei mit dem Geräte-Token und öffnet das Teilen-Blatt (dort „Kurzbefehle“
/// wählen, um ihn zu importieren); danach „Öffnen oder teilen“.
@MainActor
struct SettingsShortcutsView: View {
    @Environment(CockpitSession.self) private var session

    @State private var share: ShareFileItem?

    private var store: ShortcutsStore { session.shortcuts }
    private var shortcuts: [ShortcutInfo] { store.model?.shortcuts ?? session.settings.model?.shortcuts ?? [] }
    private var captureEnabled: Bool { store.model?.captureEnabled ?? session.settings.model?.captureEnabled ?? true }
    private var intro: String? {
        if let intro = store.model?.intro, !intro.isEmpty { return intro }
        return session.settings.model?.section(SettingsSection.shortcuts)?.intro
    }

    var body: some View {
        Form {
            if let intro {
                Section {
                    SettingsIntro(text: intro, state: nil)
                    if !captureEnabled, session.settings.model?.section(SettingsSection.tokens) != nil {
                        NavigationLink(value: SettingsDestination.section(SettingsSection.tokens)) {
                            Label("Token mit dem Recht „Capture“ anlegen", systemImage: "key")
                                .foregroundStyle(Theme.accent)
                        }
                    }
                }
            }
            if shortcuts.isEmpty {
                Section {
                    if store.model == nil, store.state.isRefreshing {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Text("Keine Kurzbefehle.")
                            .foregroundStyle(Theme.text3)
                    }
                }
            }
            ForEach(shortcuts) { shortcut in
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(shortcut.title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Theme.text)
                        Text(shortcut.text)
                            .font(.footnote)
                            .foregroundStyle(Theme.text2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    if let file = store.files[shortcut.slug] {
                        ShareLink(item: file) {
                            Label("Öffnen oder teilen", systemImage: "square.and.arrow.up")
                        }
                        .tint(Theme.accent)
                    } else {
                        Button {
                            download(shortcut)
                        } label: {
                            HStack {
                                Label("Laden", systemImage: "arrow.down.circle")
                                Spacer()
                                if store.downloading.contains(shortcut.slug) { ProgressView() }
                            }
                        }
                        .tint(Theme.accent)
                        .disabled(store.downloading.contains(shortcut.slug))
                        .accessibilityLabel("\(shortcut.title) laden")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await store.refresh() }
        .task {
            if store.model == nil { await store.load() }
        }
        .sheet(item: $share) { item in
            ShareFileSheet(items: [item.url])
                .presentationDetents([.medium, .large])
        }
    }

    private func download(_ shortcut: ShortcutInfo) {
        session.toasts.signal(.selection)
        Task {
            if let url = await store.download(shortcut) {
                session.toasts.signal(.success)
                share = ShareFileItem(url: url)
            }
        }
    }
}
