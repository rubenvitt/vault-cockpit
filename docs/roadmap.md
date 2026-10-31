# Roadmap: vom Vault-MCP zum Cockpit

## Problem

Obsidian als Editor und die Apps sind gut, aber der Vault ist schwer zugänglich und
kaum in das restliche Setup integriert (Aufgaben in Zunder, Zeiterfassung in Timing,
Mail und Kalender in Fastmail).

## Leitidee

Der Vault bleibt Source of Truth. Ein Service legt sich als Layer drumherum, liest,
indiziert und schreibt nur in klar definierte Zonen (Inbox, generierte Abschnitte).
Daraus wird ein **Cockpit** — nicht auf den Vault beschränkt, aber mit guter
Vault-Integration.

## Architektur

1. **Sync-Adapter:** [Obsidian Headless](https://www.npmjs.com/package/obsidian-headless)
   (offizieller CLI-Client, Node 22+, open beta) hält eine Vault-Kopie auf dem Server
   aktuell. Er läuft als Sidecar-Container im Stack des Cockpits (siehe „Sync“ unten).
   Austauschbar gebaut, damit ein eigener Sync später nur ein weiterer Adapter ist.
2. **Kern:** Index (SQLite mit Volltext, Links, Frontmatter — existiert), lokale
   Embeddings (z. B. bge-m3), Konnektoren zu Zunder, Timing und Kalender per CalDAV.
3. **Oberflächen:** MCP (existiert), Web-UI als Cockpit, Capture-Endpunkte.

### Sync

**Heute:** `ob sync --continuous` läuft direkt auf dem Host als systemd-User-Unit,
ohne Container. Der Prozess schreibt in denselben Ordner, den der MCP-Container
als `/vault` mountet. Was der Connector schreibt, verteilt dieser Prozess also
weiter. Die Unit steht in keinem Deploy- oder Update-Skript, deshalb bleibt die
Client-Version stehen, bis jemand sie von Hand anhebt.

**Ziel (entschieden 13.10.2026): Sidecar im Cockpit-Stack.**
Umgesetzt mit eigenem Image (`sync/`, Client gepinnt statt `:latest` der
Community-Variante). Den Zustand liest der Adapter aus einer Statusdatei, die ein
schmaler Wrapper um `ob sync --continuous` aus dessen Ausgabe ableitet; Änderungen
erkennt er über die Dateien im gemeinsamen Ordner.

- Ein eigener Dienst `vault-sync` in der Compose-Datei führt `ob sync --continuous`
  aus. Cockpit und Sidecar teilen sich das Vault-Volume. Der Sync-Client kommt so
  nicht ins Cockpit-Image, und das Cockpit bleibt frei von proprietärem Code.
- Der Sidecar wird mit dem Stack deployt und aktualisiert. Die Version von
  `obsidian-headless` wird gepinnt, weil der Client noch Beta ist und
  bidirektional in den Vault schreibt.
- Login-Zustand und Gerätename liegen in einem eigenen Config-Volume des
  Sidecars. Beide Container laufen mit derselben UID (1000), damit
  Dateirechte stimmen.
- Im Cockpit ist der **Sync-Adapter** schmal: Er meldet Dateiänderungen
  (inkrementeller Reindex statt nur Komplettaufbau im Intervall) und den Zustand
  des Syncs (läuft, letzter Abgleich, Fehler). Ein eigener Sync aus Schritt 5
  ersetzt nur den Sidecar und seinen Adapter.
- **Genau ein Sync pro Ordner.** Beim Umstieg wird die Host-Unit gestoppt und
  deaktiviert, bevor der Sidecar startet. Sonst schreiben zwei Clients in
  dieselben Dateien.

### Kein eigenes LLM im Service

Der Service liefert nur Werkzeuge und Zustand. Intelligenz kommt von außen per MCP
(Claude-Chat, Claude Code, Routinen). Keine API-Kosten. Für Server-Automationen evtl.
`claude -p` — vorher Nutzungsbedingungen prüfen.

Ausnahme (VCP-136, 31.10.2026 von Ruben freigegeben): Das Vorsortieren des Feed-Eingangs
fragt optional ein Entscheidungsmodell (Jev von TypeSafe AI, `src/lesen/jev.js`). Es ist
ein Pilot: nur mit Key in den Einstellungen, nur Vorschlag und Reihenfolge, nur öffentliche
Feed-Auszüge, Version gepinnt. Die Folgequote unter Zustand entscheidet nach 2 bis 4
Wochen, ob es bleibt.

## Features

- **Capture von überall:** Mail-Adresse, iOS-Kurzbefehl, Sprachmemo (transkribiert) → Inbox.
  Mit Präfix (z. B. `!`) direkt als Zunder-Aufgabe.
- **Inbox-Agent:** verarbeitet die Inbox über MCP-Werkzeuge, schlägt Ablage, Tags und
  Querverbindungen vor. Die Werkzeuge dafür gibt es: lesen, taggen
  (`vault_set_frontmatter`) und ablegen (`vault_move`).
- **Zunder-Brücke:** markierte Checkboxen → Zunder-Aufgaben, mit Rücklink zur Notiz.
- **Kalender-Brücke:** Termine sichtbar im Cockpit; Meeting-Notizen nur optional.
- **Timing-Anreicherung:** Zeiten und erledigte Deep-Work-Blöcke in Tages- bzw. Wochennotiz.
  Stand (VCP-52): Wochennotiz umgesetzt (`src/cockpit/flammen-notiz.js`). Die Flammen der
  Woche stehen mit geplantem Tag, gemessenen Minuten und Status in einem markierten,
  generierten Bereich unter „## Flammen“ der Feuer-Notiz, nach Start/Stopp im Cockpit und
  im Reindex-Intervall, abschaltbar in den Einstellungen. Offen: Tagesnotizen und
  Deep-Work-Blöcke ohne Flammen-Markierung.
- **Semantische Suche** über den Vault.
- **Graph:** Wikilinks plus semantische Kanten („ähnlich, aber nicht verlinkt“,
  gestrichelt), Aufgaben und Termine als eigene Knotentypen.
- **Cockpit-Startseite:** um die Woche gebaut, nicht um „Heute“. Oben Wochenziele und
  Big Rocks pro Lebensbereich, darunter Termine, Aufgaben, Inbox.

## Reihenfolge

0. Übernahme des bestehenden Vault-MCP (Index, Link-Graph, Capture, Bearbeiten, OAuth) — erledigt
1. Headless-Sync als Sidecar mit Adapter (umgesetzt: `sync/`, `src/sync/`), Host-Unit ablösen, Deployment vom alten Vault-MCP übernehmen
2. Capture mit Zunder-Weiterleitung (umgesetzt: `src/capture/`, Endpunkte `/capture` und `/funke`, Mail über JMAP, Zunder-Brücke)
3. Cockpit-Web-UI (umgesetzt: `src/web/`, `src/cockpit/`, Wochenansicht unter `/` mit OIDC-Login, Kalender per iCal/CalDAV und Einstellungen im Browser, Big Rocks aus Zunder je Bereich)
4. Graph + semantische Suche (umgesetzt: `src/semantic/`, `src/graph/`, Embeddings mit bge-m3 über einen Ollama-Sidecar, hybride `vault_search`, `vault_similar`, `vault_graph`, Seite `/graph`)
5. Eigener Sync (eigenes Projekt: Konflikte, mobile Clients, E2E), zerlegt in VCP-120 bis VCP-126. Umgesetzt: Server im Cockpit (VCP-120: `src/sync/server/`, Adapter `cockpit`, Protokoll `/sync/v1` mit Basis-Hash statt stillem Überschreiben) und Konfliktlösung auf dem Server (VCP-122: `src/sync/server/merge.js`, zeilenweiser 3-Wege-Merge, Frontmatter feldweise, sonst Konfliktkopie). Client als Obsidian-Plugin für Desktop und Mobil (VCP-121: `obsidian-plugin/`) mit Schattenbetrieb neben Obsidian Sync und Abweichungsbericht unter Zustand (VCP-133). Offen: Geräte im Web-Cockpit (VCP-123), Verlauf und Papierkorb (VCP-124), E2E (VCP-125), Umstieg (VCP-126).

Obsidian selbst zu ersetzen ist kein Ziel — Editor und Apps sind der teure Teil.

## Risiken und Überschneidungen

- **Capture** überschneidet sich mit der Zunder-Inbox und vorhandenen Capture-Apps:
  Weiterleiten statt einen zweiten Eingang bauen. Umgesetzt so: Aufgaben gehen
  immer in die Zunder-Inbox (das Cockpit speichert keine), Funke schickt Notizen
  an `/funke` statt an einen eigenen Relay, Aufgaben weiter direkt an Zunder.
- **Timing-Anreicherung:** Zunder misst Deep-Work-Blöcke bereits mit Timing — Daten dort
  abholen, nicht doppelt erfassen. Umgesetzt so: Die Tabelle in der Feuer-Notiz entsteht
  bei jedem Lauf neu aus Zunder (`filter_tasks` der Phönix-Woche), das Cockpit speichert
  keine Zeiten. Zunder kennt keine geplante Dauer, „geplant“ ist deshalb der geplante Tag;
  gemessen wird je Flamme der letzte Block (Start bis Ende).
- **Semantische Suche und Graph:** Es gibt bereits eine Hybrid-Suche mit Graph in den
  Vault-Werkzeugen (`mycel.py` in vault-skills). Geklärt am 13.10.2026: `mycel.py` hat
  keinen eigenen Index, es rechnet BM25 pro Aufruf über `wiki/` neu und leiht sich die
  Vektoren von Smart Connections (`.smart-env/`, bge-micro-v2, nur ein Teil der Seiten,
  per Obsidian Sync nicht auf dem Server). Entscheidung (vorgeschlagen, bis Ruben anders
  entscheidet): **Das Cockpit wird der eine Index.** Es bettet den ganzen Vault mit
  bge-m3 ein und bietet dieselbe Fusion (Volltext + Embeddings + Graph per RRF).
  `mycel.py` behält Lebenszyklus, Lint und Supersession und holt Vektoren bzw. die
  Suche künftig vom Cockpit statt aus `.smart-env` (Nachzug in vault-skills).
- **Zeit:** Nebenher-Projekt, konkurriert mit der Zunder-Einführung.
- **CI-Minuten:** Repo ist privat; Workflows sparsam halten (Image nur auf `main`).
