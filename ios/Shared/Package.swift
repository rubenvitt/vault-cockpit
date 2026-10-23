// swift-tools-version:5.9
// Gemeinsamer Code für App und Extensions: Konfiguration, Keychain, API-Client.
import PackageDescription

let package = Package(
    name: "Shared",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "CockpitShared", targets: ["CockpitShared"]),
    ],
    targets: [
        .target(name: "CockpitShared"),
    ]
)
