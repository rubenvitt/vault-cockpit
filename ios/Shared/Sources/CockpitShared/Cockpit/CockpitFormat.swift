import Foundation

/// Datumsangaben und Dauern wie im Web-Cockpit (src/web/render.js, review-render.js, cockpit.js).
public enum CockpitFormat {
    private static let weekdays = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"]
    private static let months = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]

    /// RFC 3339 mit oder ohne Millisekunden (`2026-10-14T12:00:00.000Z`, `…+02:00`).
    public static func date(from text: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) { return date }
        return try? Date.ISO8601FormatStyle().parse(text)
    }

    /// `JJJJ-MM-TT` als Mitternacht in `timeZone`.
    public static func day(from text: String, in timeZone: TimeZone) -> Date? {
        guard let (y, m, d) = parts(of: text) else { return nil }
        return calendar(timeZone).date(from: DateComponents(year: y, month: m, day: d))
    }

    /// Tag eines Zeitpunkts als `JJJJ-MM-TT` in `timeZone` (für `/aktion/faellig`, `tag`).
    public static func dayString(_ date: Date, in timeZone: TimeZone) -> String {
        let c = calendar(timeZone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Fälligkeit wie `dueLabel` im Web: „Fr 16.10.“, mit Uhrzeit „Mi 14.10. 08:00“.
    public static func dueLabel(_ due: String?, timeZone: TimeZone) -> String {
        guard let due, !due.isEmpty else { return "" }
        if due.count == 10, let (y, m, d) = parts(of: due) {
            var utc = Calendar(identifier: .gregorian)
            utc.timeZone = TimeZone(identifier: "UTC") ?? .current
            guard let date = utc.date(from: DateComponents(year: y, month: m, day: d)) else { return "" }
            return "\(weekdays[utc.component(.weekday, from: date) - 1]) \(two(d)).\(two(m))."
        }
        guard let date = date(from: due) else { return "" }
        let cal = calendar(timeZone)
        let c = cal.dateComponents([.weekday, .day, .month, .hour, .minute], from: date)
        return "\(weekdays[(c.weekday ?? 1) - 1]) \(two(c.day ?? 0)).\(two(c.month ?? 0)). \(two(c.hour ?? 0)):\(two(c.minute ?? 0))"
    }

    /// Uhrzeit `HH:MM` in `timeZone` (Termine, „seit 09:40“).
    public static func time(_ date: Date, timeZone: TimeZone) -> String {
        let c = calendar(timeZone).dateComponents([.hour, .minute], from: date)
        return "\(two(c.hour ?? 0)):\(two(c.minute ?? 0))"
    }

    /// Zeitraum der Woche wie `weekTitle`: „12.–18. Oktober 2026“, über Monats- und Jahresgrenzen ausgeschrieben.
    public static func weekRange(_ week: WeekInfo) -> String {
        guard let (y1, m1, d1) = parts(of: week.monday), let (y2, m2, d2) = parts(of: week.sunday) else { return "" }
        if m1 == m2 { return "\(d1).–\(d2). \(months[m2 - 1]) \(y2)" }
        if y1 == y2 { return "\(d1). \(months[m1 - 1]) – \(d2). \(months[m2 - 1]) \(y2)" }
        return "\(d1). \(months[m1 - 1]) \(y1) – \(d2). \(months[m2 - 1]) \(y2)"
    }

    /// Kurz `dd.mm.` eines Tages (`2026-10-12` → „12.10.“).
    public static func shortDay(_ day: String) -> String {
        guard let (_, m, d) = parts(of: day) else { return day }
        return "\(two(d)).\(two(m))."
    }

    /// Tag ausgeschrieben wie im Kopf des Rückblicks: `2026-10-12` → „12.10.2026“.
    public static func fullDay(_ day: String) -> String {
        day.split(separator: "-").reversed().joined(separator: ".")
    }

    /// Zeitraum im Rückblick (`review-render.js`): „12.10.2026 – 18.10.2026“.
    public static func reviewRange(_ week: WeekInfo) -> String {
        "\(fullDay(week.monday)) – \(fullDay(week.sunday))"
    }

    /// Zeitraum der Planung (`plan-page.js`): „12.10.–18.10.“
    public static func planRange(_ week: WeekInfo) -> String {
        "\(shortDay(week.monday))–\(shortDay(week.sunday))"
    }

    /// Flammen-Zeit wie im Rückblick: „45 min“, „1 h“, „1 h 30 min“.
    public static func hours(_ minutes: Int) -> String {
        guard minutes >= 60 else { return "\(minutes) min" }
        let rest = minutes % 60
        return rest > 0 ? "\(minutes / 60) h \(rest) min" : "\(minutes / 60) h"
    }

    /// Laufende Flamme wie der Zähler in cockpit.js: „04:05“, ab einer Stunde „1:04:05“.
    public static func elapsed(since start: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(start)))
        let h = s / 3600
        return "\(h > 0 ? "\(h):" : "")\(two(s / 60 % 60)):\(two(s % 60))"
    }

    /// „KW 42“ aus `2026-W42`.
    public static func weekLabel(_ id: String) -> String {
        "KW \(Int(id.suffix(2)) ?? 0)"
    }

    /// Zeitpunkt eines gespeicherten Stands wie das Offline-Banner im Web: „Sa 24.10. 14:27“.
    public static func savedAt(_ date: Date, timeZone: TimeZone = .current) -> String {
        let c = calendar(timeZone).dateComponents([.weekday, .day, .month, .hour, .minute], from: date)
        return "\(weekdays[(c.weekday ?? 1) - 1]) \(two(c.day ?? 0)).\(two(c.month ?? 0)). \(two(c.hour ?? 0)):\(two(c.minute ?? 0))"
    }

    /// Teile einer Meta-Zeile, leere fallen weg: „VCP-47 · Finanzen · Fr 16.10.“
    public static func meta(_ parts: [String?]) -> String {
        parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Feuer-Ziel und Erster Zug: Wikilinks werden Text (`[[a|b]]` → b, `[[a]]` → a); fett,
    /// kursiv und Code bleiben als Markdown für die Anzeige (`inline` in render.js).
    public static func inlineMarkdown(_ md: String) -> String {
        var out = ""
        var rest = Substring(md)
        while let open = rest.range(of: "[["), let close = rest[open.upperBound...].range(of: "]]") {
            out += rest[..<open.lowerBound]
            let inner = rest[open.upperBound..<close.lowerBound]
            out += inner.split(separator: "|", maxSplits: 1).last.map(String.init) ?? ""
            rest = rest[close.upperBound...]
        }
        return out + rest
    }

    /// `obsidian://open?vault=…&file=…` ohne `.md`, wie `obsidianLink` in render.js; nil ohne Vault-Namen.
    public static func obsidianURL(path: String, vault: String?) -> URL? {
        guard let vault, !vault.isEmpty else { return nil }
        let file = path.lowercased().hasSuffix(".md") ? String(path.dropLast(3)) : path
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        let encode = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s }
        return URL(string: "obsidian://open?vault=\(encode(vault))&file=\(encode(file))")
    }

    /// Notiz im Cockpit (`/notiz?pfad=…`), Pfad kodiert wie `encodeURIComponent`.
    public static func notePath(_ path: String) -> String {
        "/notiz?pfad=\(CockpitAPI.formEncode(path))"
    }

    /// „1 Termin“, „3 Termine“
    public static func events(_ count: Int) -> String {
        "\(count) \(count == 1 ? "Termin" : "Termine")"
    }

    private static func parts(of day: String) -> (Int, Int, Int)? {
        let p = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return (p[0], p[1], p[2])
    }

    private static func calendar(_ timeZone: TimeZone) -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return cal
    }

    private static func two(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}
