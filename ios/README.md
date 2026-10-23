# Cockpit für iOS

Native Hülle ums Cockpit (Epic VCP-89). Das Xcode-Projekt entsteht aus `project.yml` mit
[xcodegen](https://github.com/yonaskolb/XcodeGen) und wird nicht eingecheckt.

## Bauen und testen

```sh
brew install xcodegen
cd ios
make project   # erzeugt Cockpit.xcodeproj
make build     # Simulator-Build ohne Signieren
make test      # Unit-Tests auf dem ersten verfügbaren iPhone-Simulator
```

- `DESTINATION='platform=iOS Simulator,name=iPhone 17'` wählt einen anderen Simulator.
- `BUILD_NUMBER=…` setzt die Build-Nummer (`CURRENT_PROJECT_VERSION`).
- Server-URL: Release nutzt `https://vault.rubeen.dev` (`COCKPIT_SERVER_URL` in `project.yml`).
  Für Debug `Config/Local.xcconfig.example` nach `Config/Local.xcconfig` kopieren und anpassen.

## TestFlight

Lokal, mit API-Key unter `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8`:

```sh
ASC_KEY_ID=… ASC_ISSUER_ID=… ios/scripts/testflight.sh
```

Das Skript erzeugt das Projekt, archiviert signiert (automatisch, `-allowProvisioningUpdates`)
und lädt hoch. Die Build-Nummer ist ein UTC-Zeitstempel (`JJJJMMTT.HHMM`) und steigt so von
selbst. `EXPORT_DESTINATION=export` signiert nur und legt die `.ipa` unter
`ios/build/testflight/export` ab, ohne Upload. Weitere Variablen stehen im Kopf des Skripts.

Auf diesem Mac (Xcode 27) scheitert das automatische Signieren mit dem API-Key an
„Authentication failed … bearer token“, obwohl der Key mit der API funktioniert. Lokal deshalb
mit dem in Xcode angemeldeten Account (Settings → Accounts):

```sh
XCODE_ACCOUNT=1 ios/scripts/testflight.sh
```

Per GitHub: Workflow „iOS TestFlight“ manuell starten. Er braucht die Repo-Secrets
`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (Inhalt der `.p8`, base64) und `APPLE_TEAM_ID`.

## Wohin mit neuem Code

| Ordner | Inhalt |
| --- | --- |
| `Cockpit/` | App-Target: SwiftUI, Web-Hülle (VCP-92), Login, Player (VCP-94) |
| `Shared/` | Lokales Swift Package `CockpitShared`: Konfiguration, Keychain, API-Client. Alles, was App und Extension teilen |
| `CockpitTests/` | Unit-Tests (laufen in der App als Host) |
| `ShareExtension/` | Share Extension (VCP-93), noch anzulegen |

Neue Dateien in diesen Ordnern nimmt `make project` automatisch auf. `Cockpit/Info.plist` und
`Cockpit/Cockpit.entitlements` schreibt xcodegen bei jedem Lauf neu: Änderungen gehören unter
`info.properties` bzw. `entitlements.properties` in `project.yml`, nicht direkt in die Dateien. Ein neues Target kommt als
Eintrag unter `targets:` in `project.yml`, für die Share Extension etwa:

```yaml
  ShareExtension:
    type: app-extension
    platform: iOS
    sources: [ShareExtension]
    dependencies:
      - package: Shared
        product: CockpitShared
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: dev.rubeen.cockpit.share
    info:
      path: ShareExtension/Info.plist
      properties:
        CFBundleShortVersionString: $(MARKETING_VERSION)
        CFBundleVersion: $(CURRENT_PROJECT_VERSION)
        # AppConfiguration liest die eigene Info.plist der Extension
        CockpitServerURL: $(COCKPIT_SERVER_URL)
        CockpitAppGroup: group.dev.rubeen.cockpit
        CockpitKeychainGroup: $(AppIdentifierPrefix)dev.rubeen.cockpit.shared
        NSExtension: { NSExtensionPointIdentifier: com.apple.share-services, … }
    entitlements:
      path: ShareExtension/ShareExtension.entitlements
      properties: { … gleiche App Group und Keychain-Gruppe wie die App … }
```

Dazu in der App `dependencies: - target: ShareExtension` eintragen, dann wird sie eingebettet.

App Group `group.dev.rubeen.cockpit` und Keychain-Gruppe
`$(AppIdentifierPrefix)dev.rubeen.cockpit.shared` sind in den Entitlements der App eingetragen.
`AppConfiguration` liefert beide Namen. Ohne Signieren (Simulator-CI) fehlt das Team-Präfix,
und Keychain-Zugriffe mit Zugriffsgruppe scheitern. Keychain-Code daher nicht in den CI-Tests
gegen die echte Keychain prüfen.
