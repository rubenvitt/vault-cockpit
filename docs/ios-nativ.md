# iOS-App nativ

Ziel: Die iOS-App kann alles, was das Web-Cockpit kann, in SwiftUI statt im WKWebView. Das
Web-Cockpit bleibt für Desktop und Browser; beide sprechen mit demselben Server.

## Warum

In der Web-Hülle ist jeder Tipp ein Seitenwechsel zum Server, und die Wochenseite wartet bei jedem
Aufruf auf Zunder und den Kalender. Nativ zeigt die App sofort den letzten Stand (lokal gespeichert)
und holt im Hintergrund den neuen; Abhaken und Menüs ändern die Ansicht sofort und senden danach.

## Bauweise

- **Server**: Die App meldet sich mit ihrem Geräte-Token (`Authorization: Bearer vct_…`, Recht
  `app`) an. Damit gelten alle JSON-Endpunkte unter `/api/…`, alle Aktionen unter `/aktion/…` (ohne
  CSRF, mit `Accept: application/json`) und `/notiz/bild` (src/web/http.js, `appSessionOf`). Seiten,
  Einstellungen, Tokens und Sicherung bleiben beim Cookie. Fehlende JSON-Lesewege kommen Phase für
  Phase dazu (`/api/rueckblick`, `/api/planen`, …).
- **`CockpitShared`** (ios/Shared): alles ohne Oberfläche, nur Foundation und Observation, baut
  und testet auch unter Linux (`swift build`, `swift test`): Modelle, `CockpitAPI`, Zwischenspeicher
  (`SnapshotStore`), die Stores der Bildschirme mit optimistischen Änderungen und Rückgängig.
- **App** (ios/Cockpit): SwiftUI-Ansichten auf diesen Stores. Was noch nicht nativ ist, zeigt ein
  eigener WKWebView pro Reiter; Links auf schon native Seiten wechseln den Reiter.
- **Sofort statt warten**: Jeder Store zeigt zuerst den gespeicherten Stand (mit „Stand von …“,
  wenn er alt ist), lädt dann neu. Ohne Netz bleibt der gespeicherte Stand, Schreibendes wartet in
  einem Puffer (wie `offline.js` im Web).

## Phasen

Jede Phase ist ein eigener PR; `ios-test` (macOS) baut und testet, `swift test` die Logik.

| Phase | Inhalt | Server |
|---|---|---|
| 0 | Fundament: Geräte-Token für `/api` und `/aktion`, Linux-Build von `CockpitShared`, App-Rahmen mit Reitern, **Woche nativ** (Feuer, Flammen, Big Rocks, Termine, Aufgaben, Inbox, Menüs, Schnelleingabe mit Vorschau, laufende Flamme, Rückgängig), **Rückblick** und **Planen** nativ | `appSessionOf`, `/api/rueckblick`, `/api/planen` |
| 1 | Lesen I: Eingang (Karten wischen), Stapel, Folgen-Liste und „Neue Folge“, Player eingebunden, Hinzufügen | JSON für Eingang, Stapel, Folgen, Kosten der neuen Folge |
| 2 | Lesen II: Leseansicht mit Markierungen, Notizen, Fortschritt, Verbinden; Markiert; Wiedersehen | JSON für Dokument, Markierungen, Wiedersehen |
| 3 | Feeds und Gruppen, OPML; Suche, Wissen, Notiz (Markdown nativ), Graph | JSON für Feeds, Notiz (als Blöcke), Wissen |
| 4 | Einstellungen, Tokens, Sicherung, Zustand; Offline-Puffer für alles; WKWebView entfällt | JSON für Einstellungen (Entscheidung: Geräte-Token darf Einstellungen?) |

Die Bestandsaufnahme der Funktionen je Bereich (Felder, Aktionen, Meldungen) ist die Prüfliste für
„gleiche Funktionen“.
