# Cockpit Sync (Obsidian-Plugin)

Client für den eigenen Sync des Vault-Cockpits (VCP-13): gleicht den Vault über
`/sync/v1` mit dem Cockpit ab, auf Desktop und iPhone/iPad. Eine Datei
(`main.js`), kein Build-Schritt; die Sync-Logik ist unter Node getestet
(`test/obsidian-plugin.test.js`).

## Einrichten

1. Im Cockpit unter **Einstellungen → Sync** „Eigener Sync“ wählen.
2. Unter **Einstellungen → API-Tokens** je Gerät einen Token mit dem Recht
   **Sync** anlegen (der Name wird der Gerätename, z. B. `iPhone`).
3. Plugin installieren (siehe unten), unter Einstellungen → Community-Plugins
   einschalten und in seinen Einstellungen Cockpit-URL und Token eintragen.

## Installieren

Am einfachsten über [BRAT](https://github.com/TfTHacker/obsidian42-brat), auf
Desktop und iPhone/iPad gleich:

1. In Obsidian unter Community-Plugins „BRAT“ installieren und einschalten.
2. In den BRAT-Einstellungen „Add Beta plugin“ wählen und
   `rubenvitt/vault-cockpit` eintragen.
3. „Cockpit Sync“ unter Community-Plugins einschalten.

Updates holt der BRAT-Befehl „Check for updates“.

Von Hand geht es auf dem Desktop auch: `main.js` und `manifest.json` nach
`<Vault>/.obsidian/plugins/cockpit-sync/` kopieren und Obsidian neu laden. Der
eigene Sync überträgt `.obsidian` bewusst nicht, das Plugin kommt also nicht
von selbst auf die anderen Geräte.

## Neue Version veröffentlichen

`version` in `manifest.json` anheben. Der Workflow `plugin-release` legt beim
Merge nach `main` den Release mit `main.js` und `manifest.json` an. Ohne neue
Version entsteht kein Release, Änderungen an `main.js` kommen dann nicht auf
die Geräte.

## Modi

- **Nur vergleichen** (Standard), solange noch Obsidian Sync läuft: schreibt
  nichts, weder im Vault noch im Cockpit. Beim Start, alle paar Minuten und
  beim Zurückkommen in die App vergleicht es jede Datei per SHA-256 mit dem
  Stand im Cockpit und meldet, was abweicht (nur hier, nur im Cockpit,
  verschieden), samt seit wann. Das Cockpit zeigt es unter Zustand → Sync und
  exportiert es als Bericht. Im Cockpit dafür unter Einstellungen → Sync den
  „Schattenbetrieb“ einschalten. Befehl „Abweichungen anzeigen“ listet sie hier.
- **Synchronisieren** erst nach dem Umstieg (Cockpit: „Eigener Sync“,
  Obsidian Sync aus). Gegen ein Cockpit im Schattenbetrieb verweigert das
  Plugin das Synchronisieren.

## Was es beim Synchronisieren tut

- Gleicht ab beim Start, kurz nach Änderungen, alle paar Minuten (einstellbar)
  und beim Zurückkommen in die App; per Ribbon-Symbol oder Befehl „Jetzt
  abgleichen“ jederzeit.
- Merkt sich je Datei die Fassung des Servers; offline Geändertes geht beim
  nächsten Abgleich mit dieser Basis hoch. Konflikte löst der Server:
  zusammenführen, sonst bleibt seine Fassung und die des Geräts liegt als
  „Notiz (Konflikt iPhone 2026-10-29).md“ daneben (Hinweis im Obsidian).
- Was auf einem anderen Gerät gelöscht wurde, landet hier im
  Obsidian-Papierkorb (`.trash`). Löschen gegen Ändern: Ändern gewinnt.
- Versteckte Pfade (`.obsidian`, `.trash` …) bleiben lokal.
- Status in der Statusleiste (Desktop) bzw. am Ribbon-Symbol (Mobil).
