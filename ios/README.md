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
- Server-URL: Release nutzt `https://vault.rubeen.dev` (`COCKPIT_SERVER_URL` in `project.yml`,
  dazu der Host in `COCKPIT_SERVER_HOST` für Associated Domains und App-Bound Domains).
  Für Debug `Config/Local.xcconfig.example` nach `Config/Local.xcconfig` kopieren und anpassen.

## Aufbau der App

- **Login** (`Login.swift`, `AppModel.swift`): Login-Blatt des Systems
  (`ASWebAuthenticationSession`, `prefersEphemeralWebBrowserSession = false`, damit Pocket ID
  angemeldet bleibt und Passkeys greifen) auf `/login?app=1&state&challenge` mit PKCE. Der Callback
  ist der Universal Link `https://<Host>/app/angemeldet` (`callback: .https(host:path:)`, ab
  iOS 17.4). Dafür stehen `applinks:` und `webcredentials:` des Hosts in den Entitlements, und der
  Server liefert `/.well-known/apple-app-site-association` (siehe README im Repo, „iOS-App: Login
  und App-API“). Danach `POST /api/app/einloesen`: das Cookie mit allen Attributen in
  `WKWebsiteDataStore.default().httpCookieStore`, der Geräte-Token in die geteilte Keychain-Gruppe.
  Gerätename: „iPhone · iPhone17,1 · 23.10.2026“ (`UIDevice.name` ist nur „iPhone“).
- **Web-Hülle** (`WebShell.swift`): WKWebView randlos (die Seite nutzt `viewport-fit=cover` und
  `env(safe-area-inset-*)`), Ziehen zum Neuladen, Zurück-Geste. Fremde Hosts öffnen sich in
  `SFSafariViewController`, `mailto:` usw. im System. Datei-Upload zeigt WebKit selbst an; Antworten
  mit `Content-Disposition: attachment` (OPML, Wochenexport `.md`) werden geladen und ins
  Teilen-Blatt gegeben. Navigation auf `/login` (Sitzung abgelaufen) startet den nativen Login und
  danach `next`. Service Worker laufen in einem WKWebView nur für App-Bound Domains:
  `WKAppBoundDomains` in der Info.plist, `limitsNavigationsToAppBoundDomains = true`.
- **Abmelden**: „Abmelden“ im Cockpit (`POST /logout`) geht normal zum Server; die Weiterleitung
  danach auf `/login` meldet nativ ab statt neu an. Dasselbe macht das native Menü (mit zwei Fingern
  lange drücken). Nativ abmelden heißt: `POST /api/app/abmelden` widerruft den Geräte-Token auf dem
  Server, dann werden Cookies, alle Website-Daten (auch Service Worker und Offline-Puffer) und der
  Token in der Keychain gelöscht. Ohne Netz wird lokal trotzdem gelöscht, und der Login-Bildschirm
  sagt, dass man den Token unter Einstellungen → API-Tokens widerrufen soll. Das Sitzungs-Cookie
  ist signiert und ohne Zustand auf dem Server: `POST /logout` löscht es nur im Client, eine Kopie
  gilt bis zum Ablauf oder bis „Überall abmelden“.
- **Brücke** `cockpit` (`window.webkit.messageHandlers.cockpit`): `/lesen/hoeren` schickt
  `{type: 'hoeren', zeit}`; die App öffnet `PlayerView(minutes:)`, bis VCP-94 nur ein Platzhalter.
  Nachrichten nimmt die App nur vom Hauptframe des eigenen Hosts an.

## `CockpitShared` für Share Extension (VCP-93) und Player (VCP-94)

```swift
let config = AppConfiguration()
guard let token = try KeychainStore(accessGroup: config.keychainGroup).token() else {
    // nicht angemeldet: „Bitte in der Cockpit-App anmelden“
}
let api = APIClient(baseURL: config.serverURL, token: token)
let saved = try await api.saveToReadingList(url: link, title: title)  // saved.message anzeigen
```

- `KeychainStore`: `token()`, `save(token:)`, `deleteToken()`; Eintrag `dev.rubeen.cockpit` /
  `device-token`, lesbar nach dem ersten Entsperren, nur auf diesem Gerät.
- `APIClient`: `me()`, `queue(minutes:)`, `text(id:)`, `saveProgress(id:progress:anchor:)`,
  `addHighlight(_:)`, `saveToReadingList(url:title:id:)`, `saveToReadingList(pdfFile:title:id:)`
  (Body als Stream aus der Datei), statisch `redeem(…)`. Fehler kommen als
  `APIError` (`status`, `code`, `message`); `isUnauthorized` heißt neu anmelden.
- Modelle: `Me`, `Queue`/`QueueItem`, `ListenText`, `NewHighlight`, `HighlightResult`,
  `SavedDocument`, `Redemption` (`SessionCookie` mit `httpCookie`, `DeviceToken`).
- `SharedContent.detect(urls:texts:hasPDF:)`: Inhaltserkennung der Share Extension (rein, getestet).
- `PendingShares`: Puffer im App-Group-Container (`init(appGroup:)`), `add`, `all`, `remove`,
  `send`, `flush(using:)`.

Tests (`CockpitTests`): API-Client und Einlösen über einen `URLProtocol`-Mock, Keychain über
`KeychainBackend` gemockt, dazu PKCE (Testvektor aus RFC 7636), Callback-Prüfung, Cookie-Umwandlung,
Navigationsregeln und Brücke. `ShareTests`: Inhaltserkennung, PDF-Upload (Body, Query, Header)
und Offline-Puffer in einem temporären Verzeichnis.

## Share Extension „Zum Lesestapel“ (VCP-93)

Target `ShareExtension` (`dev.rubeen.cockpit.share`), eingebettet unter `Cockpit.app/PlugIns`.
`ShareViewController` zeigt eine kleine SwiftUI-Ansicht.

- **Aktivierung** (`NSExtensionActivationRule` als Prädikat): Web-Adresse, Text oder PDF-Datei;
  andere Dateien (`public.file-url` ohne PDF) nicht.
- **Erkennung** (`SharedContent.detect`):
  - Eine PDF-Datei (`UTType.pdf`, aus Dateien oder Mail) hat Vorrang.
  - Danach kommt eine http(s)-Adresse.
  - Zuletzt der erste Link in einem Text. Bei „Titel — https://…“ wird der Rest des Textes zum
    Titel.
- **Senden**:
  - Jedes Teilen bekommt eine UUID als `id`. Die Anfrage liegt zuerst in `PendingShares`, beim
    PDF als kopierte Datei (höchstens 20 MB, vorher geprüft).
  - Danach geht sie mit dem Token aus der geteilten Keychain an `POST /lesestapel/speichern`;
    das PDF wird als Datei-Stream hochgeladen.
  - Nach Erfolg wird der Eintrag gelöscht. Die Ansicht zeigt „Im Eingang: <Titel>“ bzw.
    „Schon im Lesestapel“ und schließt sich nach 1,5 s.
- **Fehler**:
  - Alle Fehler zeigen „Erneut versuchen“ mit derselben `id`.
  - Ohne Token: „Bitte zuerst in der Cockpit-App anmelden“. Bei 401: „Anmeldung abgelaufen …“.
  - Ohne Netz und bei 5xx bleibt der Eintrag liegen.
  - Andere Fehler (z. B. ungültige Adresse) verwirft „Schließen“.
- **Nachsenden**: Die App ruft `AppModel.sendPendingShares()` auf, sobald sie aktiv und angemeldet
  ist, also beim Start, im Vordergrund und nach dem Login. Vom Server Abgelehntes wird gelöscht und
  geloggt. Wird die Extension mitten im Upload beendet, sendet die App ebenfalls nach; die `id`
  verhindert Doppeltes.
- **Kein Umschalter „Direkt auf den Stapel“**: Der Server kennt nur `source`
  (`kurzbefehl`/`import`, nur als Herkunft im Eingang angezeigt), aber keinen Status. Geteiltes
  landet immer im Eingang.
- Ohne Signieren (Simulator) fehlen App Group und Keychain-Gruppe. Die Extension zeigt dann
  „Bitte zuerst in der Cockpit-App anmelden“ und puffert im eigenen temporären Verzeichnis.

## Lokal testen

Gegen einen lokalen Server (`PUBLIC_URL=http://localhost:3000`) gibt es keine Universal Links,
dafür fehlt https. Der Server schickt deshalb nur bei `PUBLIC_URL` ohne https (und ohne
`NODE_ENV=production`) auf `cockpit://login`, und nur ein Debug-Build nimmt bei einer http-Server-URL das Schema an
(`.customScheme("cockpit")`, ohne Eintrag in `CFBundleURLTypes`). Ein Release-Build kennt das
Schema nicht.

1. `cp Config/Local.xcconfig.example Config/Local.xcconfig` (Server `http://localhost:3000`).
2. Server lokal mit `PUBLIC_URL=http://localhost:3000` starten.
3. App in Xcode auf einem Simulator starten. Mit Signieren (Team eingetragen) gibt es die
   Keychain-Gruppe; der Simulator-Build aus `make build` hat keine Entitlements, dort scheitert das
   Speichern des Tokens (wird geloggt, die Web-Hülle läuft über das Cookie trotzdem).

Nur mit signiertem Build auf dem Gerät (oder einem signierten Simulator-Build) prüfbar: der
Universal-Link-Callback gegen den echten Server (Apple holt die AASA über sein CDN, das dauert nach
dem ersten Deploy etwas), Associated Domains und Keychain-Gruppe. Ohne Signieren bricht das
Login-Blatt mit https-Callback sofort ab (wie „Abbrechen“, ohne Meldung).

Im Simulator geprüft (iOS 27, ohne Signieren, Testseite auf `localhost:3000`): `localhost` gilt
als App-Bound Domain, `navigator.serviceWorker` ist da, ein Service Worker registriert sich und
wird aktiv, die Brücke `cockpit` ist sichtbar, `/login` öffnet das Login-Blatt. Offline-Lesen
(VCP-80) mit dem echten Cockpit ist noch nicht auf dem Gerät geprüft.

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
| `ShareExtension/` | Share Extension „Zum Lesestapel“ (VCP-93) |

Neue Dateien in diesen Ordnern nimmt `make project` automatisch auf. `Cockpit/Info.plist` und
`Cockpit/Cockpit.entitlements` schreibt xcodegen bei jedem Lauf neu: Änderungen gehören unter
`info.properties` bzw. `entitlements.properties` in `project.yml`, nicht direkt in die Dateien. Ein neues Target kommt als
Eintrag unter `targets:` in `project.yml`; Muster für eine Extension ist `ShareExtension` (eigene
Info.plist mit den `Cockpit*`- und Versions-Schlüsseln, Entitlements, in der App unter
`dependencies: - target: …` eingebettet).

App Group `group.dev.rubeen.cockpit` und Keychain-Gruppe
`$(AppIdentifierPrefix)dev.rubeen.cockpit.shared` sind in den Entitlements der App eingetragen.
`AppConfiguration` liefert beide Namen. Ohne Signieren (Simulator-CI) fehlt das Team-Präfix,
und Keychain-Zugriffe mit Zugriffsgruppe scheitern. Keychain-Code daher nicht in den CI-Tests
gegen die echte Keychain prüfen.
