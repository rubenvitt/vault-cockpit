import Foundation

/// Antwort einer Aktion, die ein „Rückgängig“ mitbringen kann.
public protocol UndoableReply: ActionReply {
    var undo: UndoAction? { get }
}

extension ActionResponse: UndoableReply {}

/// Antwort `{ok, message}` ohne weitere Felder: Feeds, Einstellungen speichern, „Überall abmelden“.
public struct MessageReply: ActionReply, Equatable, Sendable {
    public let ok: Bool
    public let message: String

    public init(ok: Bool = true, message: String) {
        self.ok = ok
        self.message = message
    }

    enum CodingKeys: String, CodingKey { case ok, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
    }
}

/// Aktionen mit eigenem Antwortmodell: senden, Meldung zeigen (mit „Rückgängig“, wenn der
/// Server eines liefert und `undo` gesetzt ist), Fehler melden. nil bei Fehler.
@MainActor
struct ReplyRunner {
    let context: CockpitContext

    func run<R: ActionReply & Sendable>(_ path: String, _ fields: [String: String], as type: R.Type) async -> R? {
        do {
            let response = try await context.api.action(path, fields: fields, as: R.self)
            if !response.message.isEmpty { context.toasts.show(response.message) }
            return response
        } catch {
            context.report(error)
            return nil
        }
    }

    func run<R: UndoableReply & Sendable>(_ path: String, _ fields: [String: String], as type: R.Type, undo: (@MainActor (UndoAction) -> Void)?) async -> R? {
        do {
            let response = try await context.api.action(path, fields: fields, as: R.self)
            show(response, undo: undo)
            return response
        } catch {
            context.report(error)
            return nil
        }
    }

    func show<R: UndoableReply>(_ response: R, undo: (@MainActor (UndoAction) -> Void)?) {
        guard !response.message.isEmpty else { return }
        if let undo, let action = response.undo {
            context.toasts.show(response.message, action: Toast.Action(label: "Rückgängig") { undo(action) })
        } else {
            context.toasts.show(response.message)
        }
    }

    /// Fehler eines Formulars: abgelehntes Feld (`FieldRejection`) nach `fields`, sonst Meldung.
    /// Liefert das Feld, wenn der Server eines nennt.
    @discardableResult
    func reportForm(_ error: Error) -> String? {
        if let rejection = error as? FieldRejection {
            context.toasts.signal(.error)
            context.toasts.error(rejection.message)
            return rejection.field
        }
        context.report(error)
        return nil
    }
}

/// Ordner für Dateien zum Teilen (Sicherung, OPML, Kurzbefehle): je Art ein Unterordner im
/// temporären Verzeichnis, der beim nächsten Laden derselben Art ersetzt wird.
enum ShareFiles {
    static func directory(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appending(path: "Teilen", directoryHint: .isDirectory).appending(path: name, directoryHint: .isDirectory)
    }
}
