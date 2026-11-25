# Cockpit Sync als Hintergrunddienst (Desktop)

Gleicht den Vault-Ordner mit dem Cockpit ab, auch wenn Obsidian nicht läuft
(VCP-152). Die Sync-Logik ist dieselbe wie im Obsidian-Plugin
(`../obsidian-plugin/main.js`), nur mit dem Dateisystem statt der Vault-API.

**Genau ein Sync je Ordner:** Auf einem Gerät mit diesem Dienst bleibt das
Plugin „Cockpit Sync“ aus, ebenso Obsidian Sync. Obsidian merkt die Änderungen
über seinen eigenen Dateiwächter.

## Einrichten (macOS)

1. Im Cockpit unter Einstellungen → API-Tokens einen Token mit dem Recht
   **Sync** anlegen. Der Name ist der Gerätename, etwa `r-mac`.
2. `desktop-sync/install.sh https://<cockpit> ~/rnotes` aufrufen. Das Skript
   fragt beim ersten Mal nach dem Token und legt ihn im Schlüsselbund ab
   (Dienst `dev.rubeen.cockpit-sync`). Danach kopiert es den Code nach
   `~/Library/Application Support/cockpit-sync/app` und startet den
   launchd-Agenten `dev.rubeen.cockpit-sync`.
3. Das Log steht unter `~/Library/Logs/cockpit-sync/cockpit-sync.log`.

Aktualisieren heißt: das Skript erneut aufrufen. Entfernen geht mit
`install.sh --uninstall`.

## Verhalten

- Abgleich beim Start, nach Dateiänderungen (3 s Ruhe), sofort bei Änderungen
  auf dem Server (Long-Polling) und alle 5 Minuten als Netz.
- Versteckte Pfade (`.obsidian`, `.trash`, `.git` …) bleiben außen vor.
- Was ein anderes Gerät löscht, landet hier in `.trash` im Vault.
- Der Zustand (Cursor und bekannte Fassungen) liegt in
  `~/Library/Application Support/cockpit-sync/state.json`. Löschen heißt:
  beim nächsten Start einmal komplett abgleichen, ohne Verlust.
