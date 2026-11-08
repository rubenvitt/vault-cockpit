#if targetEnvironment(macCatalyst)
import CockpitShared
import CryptoKit
import Darwin
import Foundation
import Observation
import OSLog
import SwiftUI

/// Selbst-Update der macOS-App im Direktvertrieb (Developer ID, siehe ios/README.md): sucht neue
/// Versionen im Release `macos-0.0.0` auf GitHub (`MacUpdateFeed`), lädt `Cockpit-mac-X.Y.Z.zip`, prüft Prüfsumme,
/// Signatur (Team, Bundle-ID) und Gatekeeper, ersetzt die App nach dem Beenden und startet sie neu.
///
/// Nur aktiv mit `CockpitSelfUpdate = YES` in der Info.plist (`scripts/mac-direct.sh`); die
/// TestFlight- und App-Store-Builds aktualisiert Apple. Sparkle läuft unter Mac Catalyst nicht
/// (AppKit), deshalb diese schlanke Variante.
@MainActor
@Observable
final class MacUpdater {
    static let shared = MacUpdater()

    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case available(MacUpdate)
        /// Schritt als Text: „Lädt …“, „Prüft …“, „Startet neu …“.
        case installing(MacUpdate, String)
        case failed(String)
    }

    /// Hinweis als Dialog: neue Version, aktuell (nur auf Nachfrage) oder Fehler beim Einspielen.
    enum Prompt: Identifiable {
        case available(MacUpdate)
        case upToDate(AppVersion)
        case failed(String, MacUpdate?)

        var id: String {
            switch self {
            case .available(let update): "available-\(update.version)"
            case .upToDate: "upToDate"
            case .failed(let message, _): "failed-\(message)"
            }
        }
    }

    let isEnabled: Bool
    let currentVersion: AppVersion?
    private(set) var state: State = .idle
    var prompt: Prompt?

    /// Team aus der Keychain-Gruppe (`$(AppIdentifierPrefix)…`): Das neue Bundle muss vom selben Team signiert sein.
    private let teamID: String
    private let bundleID: String
    /// „Später“ gilt bis zum nächsten Start für diese Version; die Suche im Menü zeigt sie trotzdem.
    private var postponed: AppVersion?
    private let log = Logger(subsystem: "dev.rubeen.cockpit", category: "update")

    /// Automatisch so oft suchen, solange die App läuft (GitHub erlaubt ohne Token 60 Abfragen pro Stunde).
    static let interval: Duration = .seconds(6 * 3600)

    init(info: [String: Any]? = Bundle.main.infoDictionary) {
        currentVersion = (info?["CFBundleShortVersionString"] as? String).flatMap(AppVersion.init)
        bundleID = info?["CFBundleIdentifier"] as? String ?? ""
        let group = info?["CockpitKeychainGroup"] as? String ?? ""
        teamID = group.split(separator: ".").first.map(String.init) ?? ""
        isEnabled = (info?["CockpitSelfUpdate"] as? String) == "YES" && currentVersion != nil && teamID.count == 10
    }

    // MARK: Suchen

    /// Kurz nach dem Start, danach alle `interval`; endet mit der Aufgabe (`.task`).
    func runPeriodically() async {
        guard isEnabled else { return }
        try? await Task.sleep(for: .seconds(5))
        while !Task.isCancelled {
            await check(userInitiated: false)
            try? await Task.sleep(for: Self.interval)
        }
    }

    /// `userInitiated`: aus dem Menü oder den Einstellungen, meldet auch „aktuell“ und Fehler.
    func check(userInitiated: Bool) async {
        guard isEnabled, let currentVersion else { return }
        switch state {
        case .checking, .installing: return
        default: break
        }
        state = .checking
        do {
            var request = URLRequest(url: MacUpdateFeed.releaseURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("Cockpit-macOS/\(currentVersion)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            // 404: Es gibt noch kein Release.
            guard status == 200 || status == 404 else { throw UpdateError("GitHub antwortet mit Status \(status).") }
            if status == 200, let update = try MacUpdateFeed.update(in: data, newerThan: currentVersion) {
                log.info("Update \(update.version, privacy: .public) verfügbar (installiert \(currentVersion, privacy: .public))")
                state = .available(update)
                if userInitiated || postponed != update.version { prompt = .available(update) }
            } else {
                state = .upToDate
                if userInitiated { prompt = .upToDate(currentVersion) }
            }
        } catch {
            let message = Self.message(error)
            log.error("Suche nach Updates fehlgeschlagen: \(message, privacy: .public)")
            state = .failed(message)
            if userInitiated { prompt = .failed(message, nil) }
        }
    }

    func postpone(_ update: MacUpdate) {
        postponed = update.version
    }

    // MARK: Einspielen

    func install(_ update: MacUpdate) {
        if case .installing = state { return }
        Task { await performInstall(update) }
    }

    private func performInstall(_ update: MacUpdate) async {
        state = .installing(update, "Lädt Cockpit \(update.version) …")
        do {
            let target = Bundle.main.bundleURL.resolvingSymlinksInPath()
            try Self.ensureReplaceable(target)
            let fm = FileManager.default
            // Auf demselben Volume wie die App, damit das Ersetzen ein schnelles Umbenennen ist.
            let staging = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: target, create: true)

            let (download, response) = try await URLSession.shared.download(from: update.archiveURL)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200 else { throw UpdateError("Download fehlgeschlagen (Status \(status)).") }
            let archive = staging.appending(path: MacUpdateFeed.archiveName(for: update.version))
            try fm.moveItem(at: download, to: archive)

            state = .installing(update, "Prüft Cockpit \(update.version) …")
            if let expected = update.archiveSHA256 {
                let data = try Data(contentsOf: archive, options: .mappedIfSafe)
                let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard actual == expected else { throw UpdateError("Prüfsumme des Downloads stimmt nicht.") }
            }
            let unpacked = staging.appending(path: "neu", directoryHint: .isDirectory)
            try await Subprocess.check("/usr/bin/ditto", ["-x", "-k", archive.path, unpacked.path], "Entpacken fehlgeschlagen.")
            let app = unpacked.appending(path: "Cockpit.app", directoryHint: .isDirectory)
            try await verify(app, version: update.version)

            state = .installing(update, "Startet neu …")
            let script = staging.appending(path: "ersetzen.sh")
            try Self.replaceScript.write(to: script, atomically: true, encoding: .utf8)
            try Subprocess.launchDetached("/bin/sh", [script.path, String(getpid()), target.path, app.path, staging.path])
            log.info("Update \(update.version, privacy: .public) geprüft, App beendet sich zum Ersetzen")
            // Kurz Zeit für die Anzeige, dann beenden; das Skript wartet darauf.
            try? await Task.sleep(for: .milliseconds(300))
            exit(0)
        } catch {
            let message = Self.message(error)
            log.error("Update \(update.version, privacy: .public) fehlgeschlagen: \(message, privacy: .public)")
            state = .failed(message)
            prompt = .failed(message, update)
        }
    }

    /// Signatur vom selben Team mit derselben Bundle-ID, von Gatekeeper akzeptiert (Developer ID,
    /// notarisiert), und die Version, die das Release verspricht.
    private func verify(_ app: URL, version: AppVersion) async throws {
        guard let info = NSDictionary(contentsOf: app.appending(path: "Contents/Info.plist")) as? [String: Any] else {
            throw UpdateError("Im Download steckt keine Cockpit-App.")
        }
        guard info["CFBundleIdentifier"] as? String == bundleID else { throw UpdateError("Der Download ist eine andere App.") }
        guard (info["CFBundleShortVersionString"] as? String).flatMap(AppVersion.init) == version else {
            throw UpdateError("Der Download hat nicht die Version \(version).")
        }
        let requirement = "=anchor apple generic and identifier \"\(bundleID)\" and certificate leaf[subject.OU] = \"\(teamID)\""
        try await Subprocess.check("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, app.path],
                                   "Die Signatur des Downloads ist ungültig.")
        try await Subprocess.check("/usr/sbin/spctl", ["--assess", "--type", "execute", app.path],
                                   "macOS lässt den Download nicht zu (nicht notarisiert).")
    }

    /// Ersetzen geht nur, wo die App schreiben darf: nicht von der DMG, nicht verschoben von
    /// Gatekeeper (App Translocation), nicht in einem fremden Ordner.
    private static func ensureReplaceable(_ target: URL) throws {
        let path = target.path
        if path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/") {
            throw UpdateError("Cockpit läuft nicht aus „Programme“. Ziehe Cockpit aus der DMG in den Ordner „Programme“ und starte es von dort.")
        }
        let parent = target.deletingLastPathComponent().path
        guard FileManager.default.isWritableFile(atPath: parent), FileManager.default.isWritableFile(atPath: path) else {
            throw UpdateError("Keine Schreibrechte für \(parent). Lade die DMG und ersetze Cockpit von Hand.")
        }
    }

    /// Wartet, bis die App beendet ist (höchstens 60 s), tauscht das Bundle aus (bei einem Fehler
    /// zurück) und startet die App. Argumente: PID, Ziel, neue App, Arbeitsordner.
    private static let replaceScript = """
    #!/bin/sh
    # Von Cockpit (MacUpdater) geschrieben: ersetzt die App nach dem Beenden und startet sie neu.
    pid="$1"; target="$2"; new="$3"; staging="$4"
    i=0
    while kill -0 "$pid" 2>/dev/null; do
      i=$((i + 1))
      [ "$i" -gt 300 ] && exit 1
      sleep 0.2
    done
    backup="$staging/alt.app"
    if mv "$target" "$backup"; then
      if mv "$new" "$target"; then
        rm -rf "$staging"
      else
        mv "$backup" "$target"
      fi
    fi
    /usr/bin/open "$target"
    """

    private static func message(_ error: Error) -> String {
        if let error = error as? UpdateError { return error.message }
        if let error = error as? URLError, error.code == .notConnectedToInternet { return "Keine Verbindung zum Internet." }
        return error.localizedDescription
    }
}

struct UpdateError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

/// Werkzeuge des Systems starten (`ditto`, `codesign`, `spctl`, das Ersetzen-Skript) über
/// `posix_spawn`: Unter Mac Catalyst ohne `Process`, mit eigenem PATH, Ausgaben nach /dev/null.
enum Subprocess {
    private static let environment = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C"]
    /// `POSIX_SPAWN_SETSID` aus <sys/spawn.h> (Darwin); als Zahl, weil Swift nicht jedes Makro übernimmt.
    static let setSessionFlag: Int16 = 0x0400

    /// Startet `tool` und wartet auf das Ende; wirft `failure`, wenn es nicht mit 0 endet.
    static func check(_ tool: String, _ arguments: [String], _ failure: String) async throws {
        let status = try await Task.detached(priority: .userInitiated) { try run(tool, arguments, detached: false) }.value
        guard status == 0 else { throw UpdateError(failure) }
    }

    /// Startet `tool` in einer eigenen Sitzung, ohne zu warten; läuft weiter, wenn die App endet.
    static func launchDetached(_ tool: String, _ arguments: [String]) throws {
        _ = try run(tool, arguments, detached: true)
    }

    /// Exit-Status (0 bei `detached`).
    private static func run(_ tool: String, _ arguments: [String], detached: Bool) throws -> Int32 {
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        // Eigene Sitzung, sonst räumt launchd das Skript mit der Prozessgruppe der App ab.
        if detached { posix_spawnattr_setflags(&attributes, Self.setSessionFlag) }

        let argv: [UnsafeMutablePointer<CChar>?] = ([tool] + arguments).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup($0) } + [nil]
        defer {
            argv.forEach { free($0) }
            envp.forEach { free($0) }
        }

        var pid = pid_t()
        let result = posix_spawn(&pid, tool, &actions, &attributes, argv, envp)
        guard result == 0 else { throw UpdateError("\(tool) startet nicht (\(String(cString: strerror(result))))") }
        if detached { return 0 }

        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 {
            guard errno == EINTR else { throw UpdateError("\(tool): Warten fehlgeschlagen") }
        }
        // WIFEXITED/WEXITSTATUS sind Makros und fehlen in Swift.
        return status & 0x7f == 0 ? (status >> 8) & 0xff : -1
    }
}

// MARK: Oberfläche

extension View {
    /// Dialoge des Updaters (neue Version, aktuell, Fehler) und die Anzeige beim Einspielen.
    func macUpdates(_ updater: MacUpdater) -> some View {
        modifier(MacUpdatePrompts(updater: updater))
    }
}

private struct MacUpdatePrompts: ViewModifier {
    @Bindable var updater: MacUpdater

    func body(content: Content) -> some View {
        content
            .task { await updater.runPeriodically() }
            .overlay(alignment: .top) {
                if case .installing(_, let step) = updater.state {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(step)
                            .font(.subheadline)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.top, 12)
                    .accessibilityElement(children: .combine)
                }
            }
            .alert(title(updater.prompt), isPresented: isPresented, presenting: updater.prompt) { prompt in
                switch prompt {
                case .available(let update):
                    Button("Jetzt aktualisieren") { updater.install(update) }
                    Button("Auf GitHub ansehen") { ExternalLink.present(update.pageURL) }
                    Button("Später", role: .cancel) { updater.postpone(update) }
                case .upToDate:
                    Button("OK", role: .cancel) {}
                case .failed(_, let update):
                    if let url = update?.diskImageURL ?? update?.pageURL {
                        Button("DMG laden") { ExternalLink.present(url) }
                    }
                    Button("OK", role: .cancel) {}
                }
            } message: { prompt in
                Text(message(prompt))
            }
    }

    private var isPresented: Binding<Bool> {
        Binding(get: { updater.prompt != nil }, set: { if !$0 { updater.prompt = nil } })
    }

    private func title(_ prompt: MacUpdater.Prompt?) -> String {
        switch prompt {
        case .available(let update)?: "Cockpit \(update.version) ist da"
        case .upToDate?: "Cockpit ist aktuell"
        case .failed?: "Update nicht möglich"
        case nil: ""
        }
    }

    private func message(_ prompt: MacUpdater.Prompt) -> String {
        switch prompt {
        case .available(let update):
            let notes = MacUpdateFeed.displayNotes(update.notes)
            let short = notes.count > 600 ? String(notes.prefix(600)) + " …" : notes
            let installed = updater.currentVersion.map { "Installiert ist \($0)." } ?? ""
            return [installed, short, "Cockpit beendet sich zum Aktualisieren und startet neu."]
                .filter { !$0.isEmpty }.joined(separator: "\n\n")
        case .upToDate(let version):
            return "Version \(version) ist die neueste."
        case .failed(let message, _):
            return message
        }
    }
}

/// Menü „Cockpit“ → „Nach Updates suchen …“.
struct MacUpdateCommands: Commands {
    let updater: MacUpdater

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            if updater.isEnabled {
                Button("Nach Updates suchen …") {
                    Task { await updater.check(userInitiated: true) }
                }
            }
        }
    }
}

/// Zeile in den Einstellungen („Diese App“): installierte Version und Suche nach Updates.
struct MacUpdateRow: View {
    let updater: MacUpdater

    var body: some View {
        if updater.isEnabled {
            HStack(spacing: 12) {
                SettingsSymbol(name: "arrow.down.app", color: Theme.text2)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Version \(updater.currentVersion?.description ?? "?")")
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(Theme.text3)
                }
                Spacer(minLength: 8)
                switch updater.state {
                case .checking, .installing:
                    ProgressView()
                case .available(let update):
                    Button("Aktualisieren") { updater.install(update) }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.accent)
                default:
                    Button("Nach Updates suchen") { Task { await updater.check(userInitiated: true) } }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.accent)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var status: String {
        switch updater.state {
        case .idle: "Sucht automatisch alle 6 Stunden"
        case .checking: "Sucht …"
        case .upToDate: "Aktuell"
        case .available(let update): "Cockpit \(update.version) ist da"
        case .installing(_, let step): step
        case .failed(let message): message
        }
    }
}
#endif
