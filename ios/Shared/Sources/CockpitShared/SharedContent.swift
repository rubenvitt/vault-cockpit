import Foundation

/// Was die Share Extension aus dem Geteilten macht: einen Link (mit Titel, falls der Text einen
/// hergibt) oder eine PDF-Datei.
public enum SharedContent: Equatable, Sendable {
    case link(URL, title: String?)
    /// Die Datei lädt die Extension danach selbst (`UTType.pdf`).
    case pdf(title: String?)

    /// Reine Erkennung aus dem, was die Anhänge liefern. Vorrang: PDF-Datei (Dateien und Mail
    /// schicken oft zusätzlich eine `file://`-Adresse), dann eine http(s)-Adresse, dann der erste
    /// Link in einem Text. Ein Text mit Link liefert den Titel („Titel — https://…“).
    public static func detect(urls: [URL], texts: [String], hasPDF: Bool) -> SharedContent? {
        let fromText = texts.lazy.compactMap(link(in:)).first
        if hasPDF { return .pdf(title: fromText?.title) }
        if let url = urls.first(where: isWeb) {
            return .link(url, title: fromText?.url == url ? fromText?.title : nil)
        }
        return fromText.map { .link($0.url, title: $0.title) }
    }

    /// Erste http(s)-Adresse im Text, der Rest ohne Trennzeichen als Titel.
    public static func link(in text: String) -> (url: URL, title: String?)? {
        guard let match = text.firstMatch(of: #/https?://\S+/#.ignoresCase()) else { return nil }
        // Satzzeichen und Anführungszeichen direkt hinter einem Link gehören nicht dazu.
        let raw = String(match.output).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?\"'»«“”„"))
        guard let url = URL(string: raw), isWeb(url) else { return nil }
        let rest = (text[..<match.range.lowerBound] + " " + text[match.range.upperBound...])
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "—–-|:·\"'»«“”„")))
        return (url, rest.isEmpty ? nil : rest)
    }

    private static func isWeb(_ url: URL) -> Bool {
        ["http", "https"].contains(url.scheme?.lowercased()) && url.host() != nil
    }
}
