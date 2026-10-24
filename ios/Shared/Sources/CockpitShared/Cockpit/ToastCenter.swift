import Foundation
import Observation

/// Meldung unten am Bildschirm, wie die Toasts in cockpit.js.
public struct Toast: Identifiable {
    public enum Kind: Equatable, Sendable { case ok, error }

    /// Knopf in der Meldung, z. B. „Rückgängig“ oder „Öffnen“.
    public struct Action {
        public let label: String
        public let run: @MainActor () -> Void

        public init(label: String, run: @escaping @MainActor () -> Void) {
            self.label = label
            self.run = run
        }
    }

    public let id: UUID
    public let message: String
    public let kind: Kind
    public let action: Action?

    public init(id: UUID = UUID(), message: String, kind: Kind = .ok, action: Action? = nil) {
        self.id = id
        self.message = message
        self.kind = kind
        self.action = action
    }
}

/// Haptik, die die Oberfläche auf `sensoryFeedback` abbildet (wie `{type: 'haptik', art}` im Web).
public enum HapticIntent: Equatable, Sendable {
    /// Menü auf, Auswahl getroffen.
    case selection
    /// Abgehakt, angelegt.
    case success
    /// Etwas ist schiefgegangen.
    case error
}

/// Jedes Signal ist neu, auch zweimal dieselbe Art hintereinander (Auslöser für `sensoryFeedback`).
public struct HapticEvent: Equatable, Sendable {
    public let intent: HapticIntent
    public let serial: Int
}

/// Meldungen und Haptik für alle Bildschirme. Höchstens vier Meldungen; erfolgreiche
/// verschwinden nach 6 s, Fehler bleiben, bis man sie schließt: nichts soll still verschwinden.
@MainActor
@Observable
public final class ToastCenter {
    public private(set) var toasts: [Toast] = []
    /// Letztes Haptik-Signal; die Oberfläche reagiert auf jede Änderung.
    public private(set) var haptic: HapticEvent?

    public static let limit = 4
    /// Standzeit einer Erfolgsmeldung.
    public let okLifetime: TimeInterval
    /// Standzeit nach dem Loslassen einer angehaltenen Meldung (`resume`).
    public let resumeLifetime: TimeInterval

    @ObservationIgnored private var timers: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var serial = 0

    public init(okLifetime: TimeInterval = 6, resumeLifetime: TimeInterval = 2.5) {
        self.okLifetime = okLifetime
        self.resumeLifetime = resumeLifetime
    }

    /// Zeigt eine Meldung; die älteste fällt weg, wenn es mehr als vier sind.
    @discardableResult
    public func show(_ message: String, kind: Toast.Kind = .ok, action: Toast.Action? = nil) -> Toast {
        let toast = Toast(message: message, kind: kind, action: action)
        toasts.append(toast)
        while toasts.count > Self.limit { dismiss(toasts[0].id) }
        if kind == .ok { schedule(toast.id, after: okLifetime) }
        return toast
    }

    public func error(_ message: String) {
        show(message, kind: .error)
    }

    public func dismiss(_ id: UUID) {
        timers.removeValue(forKey: id)?.cancel()
        toasts.removeAll { $0.id == id }
    }

    public func dismissAll() {
        for timer in timers.values { timer.cancel() }
        timers = [:]
        toasts = []
    }

    /// Knopf in der Meldung: schließt sie und führt die Aktion aus.
    public func perform(_ id: UUID) {
        guard let action = toasts.first(where: { $0.id == id })?.action else { return }
        dismiss(id)
        action.run()
    }

    /// Hält eine Erfolgsmeldung an (Finger darauf, wie Maus darüber im Web).
    public func pause(_ id: UUID) {
        timers.removeValue(forKey: id)?.cancel()
    }

    /// Lässt sie wieder laufen; sie verschwindet nach `resumeLifetime`.
    public func resume(_ id: UUID) {
        guard toasts.first(where: { $0.id == id })?.kind == .ok else { return }
        schedule(id, after: resumeLifetime)
    }

    public func signal(_ intent: HapticIntent) {
        serial += 1
        haptic = HapticEvent(intent: intent, serial: serial)
    }

    private func schedule(_ id: UUID, after seconds: TimeInterval) {
        timers[id]?.cancel()
        timers[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.dismiss(id)
        }
    }
}
