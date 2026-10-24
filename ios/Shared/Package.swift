// swift-tools-version:5.9
// Gemeinsamer Code für App und Extensions: Konfiguration, Keychain, API-Client.
import PackageDescription

let package = Package(
    name: "Shared",
    // macOS nur für `swift test` auf dem Mac (Observation braucht macOS 14).
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CockpitShared", targets: ["CockpitShared"]),
    ],
    targets: [
        .target(name: "CockpitShared"),
        // Logik ohne Oberfläche; läuft auch unter Linux (`swift test`).
        // Fixtures: echte Antworten des Servers (src/cockpit, src/web/http.js) mit Test-Attrappen.
        .testTarget(name: "CockpitSharedTests", dependencies: ["CockpitShared"], resources: [.copy("Fixtures")]),
    ]
)
