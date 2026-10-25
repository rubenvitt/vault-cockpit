import CockpitShared
import SwiftUI
import UIKit

/// Bild, das groß gezeigt wird (`/notiz/bild?pfad=…`).
struct NoteScreenImageItem: Identifiable, Hashable {
    let src: String
    let alt: String

    var id: String { src }
}

/// Bild im Text (`![[bild.png]]`, `![](bild.png)`): lädt mit dem Geräte-Token, höchstens so
/// breit wie das Bild selbst (oder die Breite aus `|300`); Tipp zeigt es groß zum Zoomen.
@MainActor
struct NoteScreenImage: View {
    let image: NoteImage
    let actions: NoteScreenActions

    private enum Phase {
        case loading
        case loaded(UIImage)
        case failed
    }

    @State private var phase = Phase.loading

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .task(id: image.src) { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loaded(let picture):
            Button {
                actions.openImage(NoteScreenImageItem(src: image.src, alt: image.alt))
            } label: {
                Image(uiImage: picture)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: maxWidth(picture), maxHeight: image.height.map { CGFloat($0) })
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(image.alt.isEmpty ? "Bild" : image.alt)
            .accessibilityHint("Zeigt das Bild groß")
        case .loading:
            RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
                .fill(Theme.bgSunk)
                .frame(height: 140)
                .overlay { ProgressView() }
                .accessibilityLabel("Bild wird geladen")
        case .failed:
            Label("\(NoteScreenInline.imageLabel(image)) (nicht geladen)", systemImage: "photo")
                .font(.footnote)
                .foregroundStyle(Theme.text3)
        }
    }

    /// Nicht über die eigene Größe hinaus aufblasen (wie `<img>` mit `max-width: 100%`).
    private func maxWidth(_ picture: UIImage) -> CGFloat {
        let natural = picture.size.width > 0 ? picture.size.width : .infinity
        return min(natural, image.width.map { CGFloat($0) } ?? .infinity)
    }

    private func load() async {
        guard let data = await actions.loadImage(image.src), let picture = UIImage(data: data) else {
            phase = .failed
            return
        }
        // Entpacken außerhalb des Hauptthreads, damit das Scrollen nicht hakt.
        let prepared = await picture.byPreparingForDisplay() ?? picture
        phase = .loaded(prepared)
    }
}

/// Bild bildschirmfüllend: zwei Finger zoomen, Doppeltipp wechselt 1× und 2,5×, gezoomt
/// verschieben, ungezoomt nach unten wischen schließt.
@MainActor
struct NoteScreenImageViewer: View {
    let item: NoteScreenImageItem
    let load: (String) async -> Data?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var picture: UIImage?
    @State private var failed = false
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset = CGSize.zero
    @State private var lastOffset = CGSize.zero

    private static let maxScale: CGFloat = 6

    /// Beim Wischen nach unten wird der Hintergrund heller (zeigt: loslassen schließt).
    private var backdropOpacity: Double {
        guard scale <= 1 else { return 1 }
        let pulled = Double(offset.height) / 400
        return max(0.35, 1 - pulled)
    }

    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()
                .opacity(backdropOpacity)
            if let picture {
                Image(uiImage: picture)
                    .resizable()
                    .scaledToFit()
                    .scaleEffect(scale)
                    .offset(offset)
                    .gesture(drag)
                    .simultaneousGesture(magnify)
                    .onTapGesture(count: 2) { toggleZoom() }
                    .accessibilityLabel(item.alt.isEmpty ? "Bild" : item.alt)
                    .accessibilityAction(named: scale > 1 ? "Verkleinern" : "Vergrößern") { toggleZoom() }
            } else if failed {
                ContentUnavailableView("Bild nicht geladen", systemImage: "photo", description: Text("Das Bild ließ sich nicht vom Cockpit laden."))
                    .foregroundStyle(Color.white)
            } else {
                ProgressView()
                    .tint(.white)
                    .accessibilityLabel("Bild wird geladen")
            }
        }
        .overlay(alignment: .topTrailing) {
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.white)
                    .frame(width: 44, height: 44)
                    .background(Color.black.opacity(0.45), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .padding(16)
            .accessibilityLabel("Schließen")
        }
        .task(id: item.src) {
            guard picture == nil else { return }
            if let data = await load(item.src), let image = UIImage(data: data) {
                let prepared = await image.byPreparingForDisplay() ?? image
                picture = prepared
            } else {
                failed = true
            }
        }
    }

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = min(Self.maxScale, max(1, lastScale * value.magnification))
            }
            .onEnded { _ in
                lastScale = scale
                if scale <= 1 { reset() }
            }
    }

    private var drag: some Gesture {
        DragGesture()
            .onChanged { value in
                if scale > 1 {
                    offset = CGSize(width: lastOffset.width + value.translation.width, height: lastOffset.height + value.translation.height)
                } else {
                    offset = CGSize(width: 0, height: max(0, value.translation.height))
                }
            }
            .onEnded { value in
                if scale > 1 {
                    lastOffset = offset
                } else if value.translation.height > 120 {
                    dismiss()
                } else {
                    reset()
                }
            }
    }

    private func toggleZoom() {
        withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85)) {
            if scale > 1 {
                scale = 1
                lastScale = 1
                offset = .zero
                lastOffset = .zero
            } else {
                scale = 2.5
                lastScale = 2.5
            }
        }
    }

    private func reset() {
        withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85)) {
            scale = 1
            lastScale = 1
            offset = .zero
            lastOffset = .zero
        }
    }
}
