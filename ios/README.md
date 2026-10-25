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
  Für Debug `Config/Local.xcconfig.example` nach `Config/Local.xcconfig` kopieren und anpassen
  (gilt für App und Share Extension).

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
- **Rahmen** (`Cockpit/Native/MainView.swift`, docs/ios-nativ.md): nach dem Login Reiter Woche
  (nativ), Lesen (Web), Rückblick (nativ) und Einstellungen (Web). Die
  nativen Bildschirme nehmen die Stores aus `CockpitShared` (`CockpitSession`: API mit dem
  Geräte-Token, Zwischenspeicher, Meldungen); 401 von der API startet den nativen Login wie ein
  abgelaufenes Cookie. Links im WKWebView auf `/`, `/rueckblick` und `/planen` wechseln den Reiter
  (`NavigationDecision.native`), Notiz und Suche aus nativen Bildschirmen öffnen als Web-Blatt.
  Die Leiste unten der Web-Seiten blendet ein Nutzerskript aus (die App hat ihre eigene).
- **Woche** (`Cockpit/Native/WeekScreen.swift` und Nachbarn): zeigt sofort den gespeicherten
  Stand („Stand von …“), Abhaken ändert die Zeile vor der Antwort des Servers, Menü ⋯ als Blatt,
  Schnelleingabe unten mit Vorschau und Puffer ohne Netz, Meldungen mit „Rückgängig“ und Haptik.
  Farben aus den Tokens von cockpit.css (`Theme.swift`, hell und dunkel).
- **Rückblick** (`Cockpit/Native/ReviewScreen.swift`): Kennzahlen, je Lebensbereich die Balken
  erledigt/geplant und Flammen-Zeit (wachsen beim Erscheinen herein), offen Gebliebenes zum
  Aufklappen, Flammen; „Markierungen dieser Woche wiedersehen“ öffnet den Reiter Lesen. Gespeicherter
  Stand und Blättern wie in der Woche (`WeekPaging.swift`).
- **Woche planen** (`Cockpit/Native/PlanScreen.swift`, `PlanSections.swift`), aus der Woche
  geschoben: Suche mit Bereich, „Holen“ als Phönix-Schritt oder an einem Tag, „Als Flamme“,
  Vorschläge aus den Bereichen, „Flamme einplanen“ und „In KW n“. „Holen“ und „Aus der Woche“ zeigen
  das Ergebnis sofort (`PlanStore.pending`), danach lädt die Seite neu.
- **Web-Hülle** (`WebShell.swift`): ein WKWebView je Web-Reiter bzw. Blatt, randlos (die Seite nutzt `viewport-fit=cover` und
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
  `{type: 'hoeren', zeit}`; die App öffnet den nativen Player `PlayerView(minutes:)` (unten).
  `/lesen/folgen` schickt `{type: 'folge', id, titel, art}`; die App öffnet `EpisodePlayerView`
  (Folgen, unten). Jede Seite (`/static/ui.js`) schickt `{type: 'haptik', art}` mit `auswahl`
  (Reiter, Menü), `leicht`, `erfolg` (abgehakt) oder `fehler`; die App gibt das passende
  Haptik-Signal.
  Nachrichten nimmt die App nur vom Hauptframe des eigenen Hosts an.
- **Rückmeldung beim Tippen** (`/static/ui.js`, `cockpit.css`): Der getippte Link bleibt gedrückt,
  der Reiter unten wechselt sofort, unter der Statusleiste wächst eine Ladeleiste, und dauert es
  länger als 0,3 s, tritt der alte Inhalt zurück. Seitenwechsel blenden über (Cross-Document View
  Transitions, ab iOS 18.2). Bis die erste Seite malt, zeigt der WKWebView den Hintergrund des
  Cockpits statt Weiß.

## Player „Unterwegs hören“ (VCP-94)

`speechSynthesis` in der PWA stoppt beim Sperren des Bildschirms, der native Player nicht
(Hintergrundmodus `audio`). Er öffnet sich über die Brücke und spielt gleich los.

- **Ablauf** wie `src/web/static/lesen-hoeren.js`: Wiedergabeliste aus `GET /api/app/stapel`
  (5/15/30/60 Min., Start mit `zeit` der Seite), je Text `GET /api/app/text`, satzweise ab dem
  ersten Satz mit `start >= anchor`. Texte ohne Sätze und gelöschte (404) überspringt er.
- **Bedienung:** Abspielen/Pause, Satz zurück, nächster Satz, nächster Text, Tempo 0,8–1,8
  (`UserDefaults`, Schlüssel `player.tempo`), Liste mit Restzeit, „Das hier merken“. Pause bricht
  den Satz ab, Weiterhören beginnt ihn neu (auch nach Anruf oder abgezogenem Kopfhörer).
- **Stimme:** Nennt `GET /api/app/stapel` eine `stimme` (ElevenLabs, im Cockpit unter
  Einstellungen → Vorlesen), holt `ServerSpeech` jeden Satz als MP3 von `GET /api/app/audio`
  (`von`/`bis` = Satzgrenzen in UTF-16) und spielt ihn mit `AVAudioPlayer` (`enableRate` für das
  Tempo); den nächsten Satz lädt er schon während des laufenden, das Laden läuft als
  Hintergrund-Task. Lehnt der Server ab oder fehlt das Netz, zeigt der Player den Grund und liest
  bis zum Schließen mit der Gerätestimme weiter. Gerätestimme: beste installierte `de-DE`-Stimme
  (Premium vor Enhanced, ohne Spaß- und eigene Stimme), sonst die Standardstimme. `AVAudioSession` `.playback`/`.spokenAudio`, aktiv ab dem
  ersten Satz; bei Pause bleibt sie aktiv, damit Sperrbildschirm und AirPods bei der App bleiben.
- **Offline:** Je Text in der Liste ein Knopf (Pfeil nach unten) lädt den Text auf das Gerät
  (`OfflineStore`, Application Support/Offline, nicht im Backup), mit Stimme vom Server auch jeden
  Satz als MP3; weil das den ganzen Text auf einmal kostet, fragt die App vorher. Wischen löscht
  die Kopie. `OfflineListenService` fragt erst den Server und nimmt ohne Netz (oder bei 5xx) die
  Kopien: Wiedergabeliste aus den nicht fertigen Kopien, Text samt mitgeführter Lesestelle, Audio
  gespeicherter Sätze immer von der Platte. Ein abgelehnter Token (401) bleibt ein Fehler.
- **Sperrbildschirm:** `MPNowPlayingInfoCenter` mit Titel, Quelle, Dauer und Stelle als Schätzung
  (15 Zeichen pro Sekunde bei Tempo 1) und Tempo. `MPRemoteCommandCenter`: Play, Pause, Umschalten,
  nächster Titel = nächster Text, vorheriger Titel = Satz zurück (einen vorigen Text gibt es nicht),
  `skipBackward`/`skipForward` = Satz zurück/vor, `changePlaybackRate`, `like` und `bookmark` =
  merken. Mit Skip-Befehlen zeigt der Sperrbildschirm Skip-Knöpfe statt Titel-Knöpfen.
  AirPods schicken Play/Pause, Doppeltipp (nächster Titel) und Dreifachtipp (vorheriger Titel);
  `like`/`bookmark` kommen von AirPods nicht, ob Sperrbildschirm oder CarPlay sie anbieten, ist
  auf dem Gerät noch zu prüfen.
- **Fortschritt:** nach jedem Satz `POST /api/app/fortschritt`, Anker = Anfang des nächsten
  Satzes, Fortschritt nie sinkend (der Server nimmt jeden Wert), nach dem letzten Satz 1.
- **Merken:** markiert den laufenden Satz, Anker wie `anchorAt` in `src/lesen/anchor.js`
  (`quote`, je 32 Zeichen `prefix`/`suffix`, `start`), `cid` = UUID. Sätze über 4000 Zeichen
  (`MAX_QUOTE` in `src/lesen/highlights.js`) werden gekürzt. Lehnt der Server ab, zeigt der Player
  „Nicht gemerkt: …“ mit der Meldung des Servers.
- **Ohne Netz:** Fortschritt (nur der letzte Stand je Text) und Markierungen (höchstens 100) kommen
  in einen Puffer in den `UserDefaults` der App Group (`player.pending`) und gehen raus, sobald
  `NWPathMonitor` wieder Netz meldet, beim nächsten Öffnen des Players (vor dem Laden von Liste und Text, damit
  sie den nachgesendeten Stand zeigen) oder nach dem nächsten Satz.
  Andere 4xx-Antworten als 401/429 verwirft der Puffer. Texte lädt der Player erst, wenn er sie
  braucht: Ohne Netz geht es nach dem laufenden Text nicht weiter.
- **Zeichen:** Server und Leseansicht zählen in UTF-16 (JS-Strings). `SpeechText` rechnet deshalb
  über `String.UTF16View`; fällt eine Kontextgrenze mitten in ein Emoji, rückt sie nach innen.

Code in `Cockpit/Player/`: `SpeechText` (Sätze, Anker, Fortschritt), `PlayerMachine`
(Zustandsmaschine: Ereignisse rein, Wirkungen raus), `PendingListening` (Puffer) sind reine
Typen mit Tests in `CockpitTests/PlayerTests.swift`. `SpeechOutput` kapselt `AVSpeechSynthesizer`,
`ListenService` den Server (`APIClient`), `Player` verbindet alles mit dem System.

Im Simulator ohne Anmeldung vorführen (Debug-Build, fester Text statt Server):

```sh
make build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Cockpit.app
xcrun simctl launch booted dev.rubeen.cockpit -PlayerDemo
```

Der erste Satz braucht im Simulator einige Sekunden, bis die Sprachausgabe geladen ist.
Nur auf dem Gerät prüfbar: gesperrter Bildschirm, AirPods-Gesten, CarPlay-Audio, Premium-Stimme
(Einstellungen → Bedienungshilfen → Gesprochene Inhalte → Stimmen → Deutsch laden).

## Player für Folgen

`EpisodePlayerView` mit `Cockpit/Player/EpisodePlayer.swift`: lädt die fertige MP3 einmal über
`GET /api/app/folge?id=…` (Geräte-Token) nach `Caches/Folgen/<id>.mp3` und spielt sie mit
`AVPlayer`, danach auch ohne Netz. Sperrbildschirm und Kontrollzentrum zeigen Titel, Art, Länge
und Stelle; Fernbedienung mit Abspielen/Pause, ±15/30 Sekunden, Stelle ziehen und Tempo. Anrufe
unterbrechen und setzen fort, Kopfhörer ab hält an, AirPlay über `AVRoutePickerView`. Die Stelle
je Folge bleibt in den UserDefaults der App Group.

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
Login-Blatt mit https-Callback sofort ab, ebenso ohne erreichbare AASA (Server ohne App-Login,
Antwort 404). iOS meldet das wie „Abbrechen“; kommt es in unter einer Sekunde (oder liefert `start()`
`false`), zeigt die App „Anmeldung konnte nicht starten …“ mit „Erneut versuchen“ und loggt
Fehler-Domain, Code und Host (Kategorie `login`).

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

Per GitHub: Jeder Push auf `main`, der `ios/` ändert, lädt automatisch zu TestFlight hoch. Sonst den Workflow „iOS TestFlight“ manuell starten oder einen Tag `ios/v…` pushen (z. B. `git tag ios/v1.0-1 && git push origin ios/v1.0-1`). Mit einer Xcode-Beta lädt App Store Connect nichts an, lokal geht dann nur `EXPORT_DESTINATION=export`. Er braucht die Repo-Secrets
`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (Inhalt der `.p8`, base64) und `APPLE_TEAM_ID`.

Der frische Mac jedes Laufs hat kein Zertifikat, also legt das automatische Signieren mit dem
API-Key jedes Mal ein neues „Apple Development“-Zertifikat an. Damit Apples Höchstzahl nicht
erreicht wird, widerruft `ios/scripts/certificates-cleanup.js` vor und nach dem Archivieren die
Entwicklungszertifikate „Created via API“; die eigenen aus Xcode und das Distributionszertifikat
bleiben. Nur auflisten: `DRY_RUN=1 node ios/scripts/certificates-cleanup.js`.

### An Testgruppen verteilen

Nach dem Upload verteilt der Job `distribute` den Build an die Gruppen aus der Repo-Variable
`TESTFLIGHT_GROUPS` (Settings → Secrets and variables → Actions → Variables, kommagetrennt, z. B.
`Extern`). Ohne die Variable bleibt es beim Upload. Der Job wartet, bis App Store Connect den
Build verarbeitet hat, setzt „Was testen“ aus den Commit-Betreffs seit dem letzten Push, hängt
den Build an die Gruppen und reicht ihn zur Beta-Prüfung ein, sobald eine externe Gruppe dabei
ist. Lokal: `BUILD_NUMBER=… TESTFLIGHT_GROUPS=Extern ios/scripts/testflight-distribute.js`.

Einmal von Hand in App Store Connect (TestFlight):

- Die Gruppe anlegen; der Name muss genau zu `TESTFLIGHT_GROUPS` passen.
- „Testinformationen“ ausfüllen: Beschreibung, Feedback-E-Mail und die Angaben zur Beta-Prüfung
  (Kontakt, Demo-Zugang). Ohne sie lehnt Apple das Einreichen ab.
- Der API-Key braucht die Rolle „App Manager“ oder „Admin“; mit „Developer“ darf er hochladen,
  aber keine Gruppen und keine Beta-Prüfung verwalten.

Den ersten Build einer Version prüft Apple (meist unter einem Tag), weitere Builds derselben
`MARKETING_VERSION` gibt Apple meist sofort frei.

## Wohin mit neuem Code

| Ordner | Inhalt |
| --- | --- |
| `Cockpit/` | App-Target: SwiftUI, Web-Hülle (VCP-92), Login, Player (VCP-94, `Cockpit/Player/`), native Bildschirme (`Cockpit/Native/`) |
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
