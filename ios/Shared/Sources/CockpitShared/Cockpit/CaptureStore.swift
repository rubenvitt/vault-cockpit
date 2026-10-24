import Foundation
import Observation

/// Regeln der Schnelleingabe am Text, wie in cockpit.js und offline.js.
public enum CaptureText {
    /// `!` vorne: Aufgabe in Zunder, sonst Notiz (oder Artikel bei `> https://…`).
    public static func isTask(_ text: String) -> Bool {
        trimmedStart(text).hasPrefix("!")
    }

    /// „Aufgabe“, „Artikel“ oder „Notiz“.
    public static func kind(of text: String) -> String {
        if isTask(text) { return "Aufgabe" }
        return isArticle(text) ? "Artikel" : "Notiz"
    }

    /// Genau eine http(s)-Adresse nach `>` (`articleUrl` in src/capture/syntax.js).
    public static func isArticle(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix(">") else { return false }
        let url = t.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return (url.hasPrefix("http://") || url.hasPrefix("https://")) && !url.contains(where: \.isWhitespace)
    }

    /// Vorschau nur für Text mit `!` oder `>` vorne und etwas dahinter.
    public static func wantsPreview(_ text: String) -> Bool {
        let t = trimmedStart(text)
        guard let first = t.first, first == "!" || first == ">" else { return false }
        return !t.dropFirst().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Erste Zeile ohne `!`, für eine neue Aufgabe ohne Titel vom Server.
    public static func firstLine(_ text: String) -> String {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix("!") { t = t.dropFirst().trimmingCharacters(in: .whitespaces) }
        return t.split(separator: "\n", omittingEmptySubsequences: false).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
    }

    /// Anzeigename einer neuen Notiz: Dateiname ohne `.md` und ohne `2026-10-24 1427 - ` vorne.
    public static func noteLabel(path: String) -> String {
        var name = path.split(separator: "/").last.map(String.init) ?? path
        if name.lowercased().hasSuffix(".md") { name = String(name.dropLast(3)) }
        let shape = Array("0000-00-00 0000 - ")
        let chars = Array(name)
        if chars.count > shape.count, zip(chars, shape).allSatisfy({ $0.1 == "0" ? $0.0.isASCII && $0.0.isNumber : $0.0 == $0.1 }) {
            name = String(chars.dropFirst(shape.count))
        }
        return name
    }

    static func trimmedStart(_ text: String) -> Substring {
        text.drop(while: { $0.isWhitespace })
    }
}

/// Schnelleingabe der Woche: Feld, Vorschau, Senden mit Erfassungs-ID und der Puffer ohne Netz.
///
/// Ohne Verbindung (oder mit abgelaufener Anmeldung) wandert der Text mit seiner `cid` in den
/// `CaptureOutbox` und geht mit `flush()` raus, sobald das Cockpit wieder antwortet; der Server
/// legt bei gleicher `cid` nichts doppelt an.
@MainActor
@Observable
public final class CaptureStore {
    /// Text im Feld. Jede Änderung plant die Vorschau neu (250 ms Pause).
    public var text: String {
        get { storedText }
        set {
            storedText = newValue
            schedulePreview()
        }
    }
    /// Erfassungs-ID des aktuellen Textes; neu nach jedem Erfolg und nach dem Ablegen im Puffer.
    public private(set) var cid = UUID().uuidString
    public private(set) var isSending = false
    /// Vorschau unter dem Feld (nur Aufgaben und Artikel), nil = nichts zeigen.
    public private(set) var preview: CapturePreview?
    /// Zählt hoch, wenn leer abgeschickt wurde: die Oberfläche wackelt mit dem Feld.
    public private(set) var nudge = 0
    /// Puffer, ältester zuerst.
    public private(set) var entries: [CaptureOutbox.Entry] = []
    /// Nachsenden ist an 401 gescheitert: erst neu anmelden, dann geht der Puffer von selbst raus.
    public private(set) var loginNeeded = false
    public private(set) var isFlushing = false

    /// Neue Aufgabe oder Notiz ist angelegt (für die Inbox der Woche), mit dem gesendeten Text.
    @ObservationIgnored public var onCaptured: (@MainActor (CaptureResult, String) -> Void)?
    /// Einträge aus dem Puffer sind angekommen (die Woche lädt neu).
    @ObservationIgnored public var onFlushed: (@MainActor () -> Void)?

    private var storedText = ""
    private let context: CockpitContext
    private let previewDelay: UInt64
    private let retryInterval: UInt64
    @ObservationIgnored private var previewTask: Task<Void, Never>?
    @ObservationIgnored private var previewSerial = 0
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var flushing: Task<Void, Never>?

    /// `previewDelay` und `retryInterval` in Sekunden (Tests verkürzen sie).
    public init(context: CockpitContext, previewDelay: TimeInterval = 0.25, retryInterval: TimeInterval = 30) {
        self.context = context
        self.previewDelay = UInt64(max(0, previewDelay) * 1_000_000_000)
        self.retryInterval = UInt64(max(0, retryInterval) * 1_000_000_000)
        entries = context.outbox.all()
    }

    // MARK: Feld

    public var isTask: Bool { CaptureText.isTask(storedText) }
    /// Beschriftung des Feldes: „Aufgabe“ oder „Notiz“.
    public var label: String { isTask ? "Aufgabe" : "Notiz" }
    public var buttonTitle: String { isTask ? "Aufgabe anlegen" : "Notiz anlegen" }

    /// Sendet den Text. Leer: nur `nudge`. Ohne Netz: in den Puffer, das Feld wird frei.
    /// Lehnt der Server ab, bleibt der Text mit derselben `cid` im Feld.
    public func submit() async {
        let sent = storedText
        guard !sent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            nudge += 1
            return
        }
        guard !isSending else { return }
        isSending = true
        defer { isSending = false }
        do {
            let response = try await context.api.action("/aktion/erfassen", fields: ["text": sent, "cid": cid])
            reset()
            context.toasts.signal(.success)
            if let result = response.result {
                onCaptured?(result, sent)
                if result.kind == "task", let link = result.link {
                    let open = context.openURL
                    context.toasts.show(response.message, action: Toast.Action(label: "Öffnen") { open(link) })
                    return
                }
            }
            context.toasts.show(response.message)
        } catch let error as CockpitError where error.isOffline || error.isUnauthorized {
            park(sent, unauthorized: error.isUnauthorized)
        } catch {
            context.report(error)
        }
    }

    /// Text mit seiner `cid` in den Puffer; das Feld wird frei für den nächsten.
    private func park(_ sent: String, unauthorized: Bool) {
        let entry = CaptureOutbox.Entry(id: cid, text: sent, created: context.now())
        do {
            try context.outbox.put(entry)
        } catch {
            // Kann das Gerät nichts speichern, bleibt der Text im Feld.
            context.toasts.signal(.error)
            context.toasts.error("Keine Verbindung zum Cockpit. Nichts gespeichert.")
            return
        }
        reset()
        entries = context.outbox.all()
        context.toasts.show("\(CaptureText.kind(of: sent)) wartet auf Netz und geht automatisch raus.")
        if unauthorized {
            loginNeeded = true
            context.onUnauthorized()
        } else {
            scheduleRetry()
        }
    }

    private func reset() {
        text = ""
        cid = UUID().uuidString
    }

    // MARK: Vorschau

    private func schedulePreview() {
        previewTask?.cancel()
        guard CaptureText.wantsPreview(storedText) else {
            previewSerial += 1
            preview = nil
            return
        }
        let delay = previewDelay
        previewTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard !Task.isCancelled else { return }
            await self?.refreshPreview()
        }
    }

    /// Fragt den Server sofort nach der Vorschau des aktuellen Textes (ohne Pause).
    /// Ältere Antworten, die nach einer neueren ankommen, werden verworfen.
    public func refreshPreview() async {
        let current = CaptureText.trimmedStart(storedText)
        previewSerial += 1
        let serial = previewSerial
        guard CaptureText.wantsPreview(storedText) else {
            preview = nil
            return
        }
        do {
            let result = try await context.api.capturePreview(String(current.prefix(500)))
            guard serial == previewSerial else { return }
            preview = result.isShown ? result : nil
        } catch {
            // Ohne Netz rechnet niemand die Vorschau; der Puffer wertet den Text später aus.
            if serial == previewSerial { preview = nil }
        }
    }

    // MARK: Puffer

    /// Einträge, die noch warten (ohne Ablehnung).
    public var waitingCount: Int { entries.filter { $0.error == nil }.count }
    public var failedCount: Int { entries.count - waitingCount }

    /// „2 Einträge warten auf Netz · 1 nicht gesendet“
    public var outboxSummary: String {
        var parts: [String] = []
        if waitingCount > 0 { parts.append("\(waitingCount) \(waitingCount == 1 ? "Eintrag wartet" : "Einträge warten") auf Netz") }
        if failedCount > 0 { parts.append("\(failedCount) nicht gesendet") }
        return parts.joined(separator: " · ")
    }

    /// Sendet, was wartet; `retry` nimmt auch abgelehnte Einträge noch einmal. Läuft nie
    /// zweimal gleichzeitig: Ein zweiter Aufruf wartet auf den ersten.
    public func flush(retry: Bool = false) async {
        if let running = flushing {
            await running.value
            return
        }
        let run = Task { [weak self] in
            guard let self else { return }
            await self.sendAll(retry: retry)
        }
        flushing = run
        await run.value
        flushing = nil
    }

    /// Nach dem Login oder wenn das Netz zurück ist: alles noch einmal versuchen.
    public func resume() async {
        loginNeeded = false
        await flush()
    }

    private func sendAll(retry: Bool) async {
        entries = context.outbox.all()
        let todo = entries.filter { retry || $0.error == nil }
        guard !todo.isEmpty else { return }
        isFlushing = true
        defer { isFlushing = false }
        var sent: [String] = []
        var failed = 0
        var stopped = false
        for entry in todo {
            do {
                let response = try await context.api.action("/aktion/erfassen", fields: ["text": entry.text, "cid": entry.id])
                context.outbox.remove(entry.id)
                sent.append(response.message)
            } catch let error as CockpitError {
                if error.isUnauthorized {
                    loginNeeded = true
                    context.onUnauthorized()
                    stopped = true
                    break
                }
                if error.isOffline {
                    stopped = true
                    break
                }
                var rejected = entry
                rejected.error = error.message
                rejected.failedAt = context.now()
                try? context.outbox.put(rejected)
                failed += 1
            } catch {
                stopped = true
                break
            }
        }
        entries = context.outbox.all()
        if !sent.isEmpty {
            loginNeeded = false
            context.toasts.show(sent.count == 1 ? "Nachgesendet: \(sent[0])" : "\(sent.count) Einträge nachgesendet")
            onFlushed?()
        }
        if failed > 0 {
            context.toasts.signal(.error)
            context.toasts.error(failed == 1 ? "Ein Eintrag ließ sich nicht nachsenden. Er bleibt im Puffer, siehe Liste." : "\(failed) Einträge ließen sich nicht nachsenden. Sie bleiben im Puffer, siehe Liste.")
        }
        if stopped && !loginNeeded { scheduleRetry() }
    }

    /// Solange etwas wartet, alle 30 s ein neuer Versuch.
    private func scheduleRetry() {
        guard retryTask == nil else { return }
        let interval = retryInterval
        retryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: interval)
            guard !Task.isCancelled, let self else { return }
            self.retryTask = nil
            if self.waitingCount > 0 { await self.flush() }
        }
    }

    /// Verwirft einen Eintrag; er wird nicht gesendet.
    public func discard(_ entry: CaptureOutbox.Entry) {
        context.outbox.remove(entry.id)
        entries = context.outbox.all()
    }

    /// Holt einen abgelehnten Eintrag zurück ins Feld (das sicher nicht angekommen ist) und
    /// nimmt ihn aus dem Puffer. Steht schon Text im Feld, fragt die Oberfläche vorher.
    public func backToField(_ entry: CaptureOutbox.Entry) {
        text = entry.text
        context.outbox.remove(entry.id)
        entries = context.outbox.all()
    }

    /// Hält Vorschau und Wiederholung an (Abmelden, Bildschirm weg).
    public func stop() {
        previewTask?.cancel()
        retryTask?.cancel()
        retryTask = nil
    }
}
