import CockpitShared
import SwiftUI
import UIKit

extension View {
    /// Meldungen des Cockpits unten über diesem Bildschirm (über der Reiterleiste und einer Leiste
    /// am unteren Rand, wenn der Bildschirm sie mit `safeAreaInset` setzt).
    @MainActor
    func toasts(_ center: ToastCenter) -> some View {
        overlay(alignment: .bottom) { ToastStack(center: center) }
    }
}

/// Bis zu vier Meldungen übereinander, die neueste unten (wie `.toasts` in cockpit.css).
@MainActor
struct ToastStack: View {
    let center: ToastCenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 8) {
            ForEach(center.toasts) { toast in
                ToastView(toast: toast, center: center)
                    .transition(reduceMotion ? AnyTransition.opacity : AnyTransition.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.35, dampingFraction: 0.85), value: center.toasts.map(\.id))
    }
}

@MainActor
struct ToastView: View {
    let toast: Toast
    let center: ToastCenter

    private var isError: Bool { toast.kind == .error }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            if isError {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.danger)
                    .accessibilityHidden(true)
            }
            Text(toast.message)
                .font(.subheadline)
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                // Finger darauf hält die Meldung an, wie Maus darüber im Web.
                .onLongPressGesture(minimumDuration: 0.2, perform: {}, onPressingChanged: { pressing in
                    if pressing { center.pause(toast.id) } else { center.resume(toast.id) }
                })
            if let action = toast.action {
                Button(action.label) { center.perform(toast.id) }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .buttonStyle(.borderless)
            }
            Button {
                center.dismiss(toast.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.text3)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Schließen")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 8)
        .background(isError ? Theme.dangerSoft : Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .strokeBorder(isError ? Theme.danger.opacity(0.35) : Theme.line)
        }
        .shadow(color: .black.opacity(0.14), radius: 16, y: 6)
        .accessibilityElement(children: .contain)
        .onAppear {
            // VoiceOver liest neue Meldungen vor, wie `aria-live` im Web.
            UIAccessibility.post(notification: .announcement, argument: toast.message)
        }
    }
}
