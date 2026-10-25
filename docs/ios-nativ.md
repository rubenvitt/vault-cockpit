# iOS-App nativ

Ziel: Die iOS-App kann alles, was das Web-Cockpit kann, in SwiftUI statt im WKWebView. Das
Web-Cockpit bleibt für Desktop und Browser; beide sprechen mit demselben Server.

**Stand:** erreicht (Phasen 0 bis 4). Jede Seite des Cockpits hat einen nativen Bildschirm, die
App enthält keinen WKWebView mehr. Nur der Login läuft im Login-Blatt des Systems
(`ASWebAuthenticationSession`, wegen Pocket ID und Passkeys).

## Warum

In der Web-Hülle ist jeder Tipp ein Seitenwechsel zum Server, und die Wochenseite wartet bei jedem
Aufruf auf Zunder und den Kalender. Nativ zeigt die App sofort den letzten Stand (lokal gespeichert)
und holt im Hintergrund den neuen; Abhaken und Menüs ändern die Ansicht sofort und senden danach.

## Bauweise

- **Server**: Die App meldet sich mit ihrem Geräte-Token (`Authorization: Bearer vct_…`, Recht
  `app`) an. Damit gelten alle JSON-Endpunkte unter `/api/…`, alle Aktionen unter `/aktion/…` (ohne
  CSRF, mit `Accept: application/json`), `/notiz/bild` und `/kurzbefehle/*.shortcut`
  (src/web/http.js, `appSessionOf`). Entscheidung: Der Geräte-Token darf auch Einstellungen,
  API-Tokens und Sicherung (`/api/einstellungen…`); er ist auf dem Gerät so vertrauenswürdig wie
  das Sitzungs-Cookie. Geheimnisse gibt der Server nie zurück (leeres Feld = unverändert).
- **`CockpitShared`** (ios/Shared): alles ohne Oberfläche, nur Foundation und Observation, baut
  und testet auch unter Linux (`swift build`, `swift test`): Modelle, `CockpitAPI`, Zwischenspeicher
  (`SnapshotStore`), die Stores der Bildschirme mit optimistischen Änderungen und Rückgängig.
- **App** (ios/Cockpit): SwiftUI-Ansichten auf diesen Stores, je Bereich ein Ordner unter
  `Cockpit/Native/`. Links aus nativen Inhalten (Notiz, Leseansicht, `redirect`) entscheidet
  `NavigationDecision` (`Links.swift`): Reiter wechseln, Bereich im Lesen wählen, Abschnitt der
  Einstellungen öffnen oder Notiz, Graph, Suche und Zustand als Blatt mit eigenem Stapel zeigen.
- **Sofort statt warten**: Jeder Store zeigt zuerst den gespeicherten Stand (mit „Stand von …“,
  wenn er alt ist), lädt dann neu. Ohne Netz bleibt der gespeicherte Stand; Schnelleingabe und
  Leseansicht puffern Schreibendes (wie `offline.js` im Web), andere Aktionen melden „Keine
  Verbindung zum Cockpit. Nichts gespeichert.“ und lassen die Ansicht, wie sie war.

## Phasen

Jede Phase ist ein eigener PR; `ios-test` (macOS) baut und testet, `swift test` die Logik.

| Phase | Inhalt | Server | Stand |
|---|---|---|---|
| 0 | Fundament: Geräte-Token für `/api` und `/aktion`, Linux-Build von `CockpitShared`, App-Rahmen mit Reitern, **Woche nativ** (Feuer, Flammen, Big Rocks, Termine, Aufgaben, Inbox, Menüs, Schnelleingabe mit Vorschau, laufende Flamme, Rückgängig), **Rückblick** und **Planen** nativ | `appSessionOf`, `/api/rueckblick`, `/api/planen` | fertig |
| 1 | Lesen I: Eingang (Karten wischen), Stapel, Folgen-Liste und „Neue Folge“, Player eingebunden, Hinzufügen | JSON für Eingang, Stapel, Folgen, Kosten der neuen Folge | fertig |
| 2 | Lesen II: Leseansicht mit Markierungen, Notizen, Fortschritt, Verbinden; Markiert; Wiedersehen | JSON für Dokument, Markierungen, Wiedersehen | fertig |
| 3 | Feeds und Gruppen, OPML; Suche, Wissen, Notiz (Markdown nativ), Graph | JSON für Feeds, Notiz (als Blöcke), Wissen, Suche, Graph mit Listen | fertig |
| 4 | Einstellungen (alle Abschnitte, Kalender), API-Tokens, Kurzbefehle, Sicherung, Zustand mit „Störung“ in der Woche, natives Abmelden; WKWebView entfällt | `/api/einstellungen…` mit Geräte-Token, `/api/zustand`, `alert` in `/api/woche` | fertig |

Die Bestandsaufnahme der Funktionen je Bereich (Felder, Aktionen, Meldungen) ist die Prüfliste für
„gleiche Funktionen“.

## Was wo nativ ist

| Web | App |
|---|---|
| `/` Woche, `/planen` | Reiter Woche (`WeekScreen`, `PlanScreen`), Hinweis „Störung“ im Kopf |
| `/rueckblick` | Reiter Rückblick (`ReviewScreen`) |
| `/lesen/…` Eingang, Stapel, Folgen, Markiert, Wiedersehen, Leseansicht | Reiter Lesen (`Native/Lesen/`) |
| `/wissen` | Reiter Lesen → Wissen (`WissenScreen`) |
| `/lesen/feeds` | Reiter Lesen → Feeds (`FeedsScreen`) |
| `/notiz?pfad=` | Blatt bzw. Stapel (`NoteScreen`) |
| `/graph?pfad=`, `/graph?q=` | Blatt bzw. Stapel (`GraphScreen`, `SearchScreen`) |
| `/einstellungen#abschnitt` | Reiter Einstellungen (`SettingsScreen`, `SettingsSectionScreen`) |
| `/zustand` | Einstellungen → Zustand der Dienste bzw. Blatt aus der Woche (`HealthScreen`) |
| `POST /logout` | Einstellungen → Diese App → Abmelden (widerruft den Geräte-Token) |
