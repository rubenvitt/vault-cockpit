import CockpitShared
import SwiftUI

/// Blättern zwischen Wochen wie `.pager` im Web: „‹ KW 41“, in der Mitte „Diese Woche“ bzw.
/// „Zur Woche“, „KW 43 ›“. Woche, Rückblick und Planung teilen ihn; `noun` ergänzt die
/// VoiceOver-Beschriftung („Vorige Woche planen, KW 41“).
struct WeekPager<Middle: View>: View {
    let week: WeekInfo
    let noun: String
    let onPrevious: () -> Void
    let onNext: () -> Void
    let middle: Middle

    init(week: WeekInfo, noun: String = "Woche", onPrevious: @escaping () -> Void, onNext: @escaping () -> Void, @ViewBuilder middle: () -> Middle) {
        self.week = week
        self.noun = noun
        self.onPrevious = onPrevious
        self.onNext = onNext
        self.middle = middle()
    }

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onPrevious) {
                Label(CockpitFormat.weekLabel(week.prev), systemImage: "chevron.left")
            }
            .accessibilityLabel("Vorige \(noun), \(CockpitFormat.weekLabel(week.prev))")
            Spacer(minLength: 0)
            middle
            Spacer(minLength: 0)
            Button(action: onNext) {
                HStack(spacing: 4) {
                    Text(CockpitFormat.weekLabel(week.next))
                    Image(systemName: "chevron.right")
                }
            }
            .accessibilityLabel("Nächste \(noun), \(CockpitFormat.weekLabel(week.next))")
        }
        .font(.subheadline.weight(.medium))
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .tint(Theme.accent)
    }
}

/// Seitlich wischen blättert; senkrecht bleibt Scrollen. `next`: nach links gewischt.
@MainActor
enum WeekSwipe {
    static func gesture(enabled: Bool, previous: @escaping () -> Void, next: @escaping () -> Void) -> some Gesture {
        DragGesture(minimumDistance: 30)
            .onEnded { value in
                let dx = value.translation.width
                let dy = value.translation.height
                guard enabled, abs(dx) > 80, abs(dx) > abs(dy) * 2 else { return }
                if dx < 0 { next() } else { previous() }
            }
    }
}

/// „Stand von …“, solange der gezeigte Stand aus dem Zwischenspeicher kommt (ohne Netz wie das
/// Banner im Web „Offline, Stand von ….“); darunter ein Fehler beim Neuladen.
struct LoadStatusView: View {
    let state: LoadState
    /// Es wird überhaupt ein Stand gezeigt (sonst sagt der leere Bildschirm, was los ist).
    let hasModel: Bool

    var body: some View {
        Group {
            if hasModel, state.isStale, let updated = state.lastUpdated, !state.isRefreshing || Self.isOld(updated) {
                Label(Self.staleText(updated, offline: state.isOffline), systemImage: state.isOffline ? "wifi.slash" : "clock.arrow.circlepath")
                    .font(.footnote)
                    .foregroundStyle(Theme.warn)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.warnSoft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                    .transition(.opacity)
            }
            if hasModel, let error = state.error, !error.isOffline, !error.isUnauthorized {
                ProblemText(error.message)
            }
        }
    }

    /// Gespeicherter Stand älter als eine Minute: „Stand von …“ auch während des Ladens zeigen.
    static func isOld(_ date: Date) -> Bool {
        Date.now.timeIntervalSince(date) > 60
    }

    /// „Stand von Sa 24.10. 14:27“, ohne Netz „Offline, Stand von Sa 24.10. 14:27.“
    static func staleText(_ date: Date, offline: Bool) -> String {
        offline ? "Offline, Stand von \(CockpitFormat.savedAt(date))." : "Stand von \(CockpitFormat.savedAt(date))"
    }
}

/// Nichts gespeichert und das Laden schlug fehl: Grund und „Erneut versuchen“.
struct LoadFailedView: View {
    let title: String
    let error: CockpitError
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: error.isOffline ? "wifi.slash" : "exclamationmark.triangle")
        } description: {
            Text(error.message)
        } actions: {
            Button("Erneut versuchen", action: retry)
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
        }
    }
}

extension View {
    /// Fläche wie `section` im Web, ohne Überschrift (Leer- und Fehlertexte, Kennzahlen).
    func cardStyle(padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                    .strokeBorder(Theme.line)
            }
    }
}
