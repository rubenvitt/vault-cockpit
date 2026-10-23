import SwiftUI

/// Einstieg für den nativen Vorlese-Player (VCP-94). Öffnet sich, wenn `/lesen/hoeren` in der App
/// „Abspielen“ meldet (`BridgeMessage.listen`); `minutes` ist das Zeitfenster der Seite. Daten holt
/// der Player mit `APIClient` (`queue(minutes:)`, `text(id:)`, `saveProgress`, `addHighlight`) und
/// dem Token aus `KeychainStore`.
struct PlayerView: View {
    let minutes: Int

    var body: some View {
        ContentUnavailableView(
            "Nativer Player kommt (VCP-94)",
            systemImage: "headphones",
            description: Text("Zeitfenster: \(minutes) Minuten")
        )
        .presentationDetents([.medium])
    }
}

#Preview {
    PlayerView(minutes: 15)
}
