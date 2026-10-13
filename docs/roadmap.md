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
   aktuell. Austauschbar gebaut, damit ein eigener Sync später nur ein weiterer Adapter ist.
2. **Kern:** Index (SQLite mit Volltext, Links, Frontmatter — existiert), lokale
   Embeddings (z. B. bge-m3), Konnektoren zu Zunder, Timing und Kalender per CalDAV.
3. **Oberflächen:** MCP (existiert), Web-UI als Cockpit, Capture-Endpunkte.

### Kein eigenes LLM im Service

Der Service liefert nur Werkzeuge und Zustand. Intelligenz kommt von außen per MCP
(Claude-Chat, Claude Code, Routinen). Keine API-Kosten. Für Server-Automationen evtl.
`claude -p` — vorher Nutzungsbedingungen prüfen.

## Features

- **Capture von überall:** Mail-Adresse, iOS-Kurzbefehl, Sprachmemo (transkribiert) → Inbox.
  Mit Präfix (z. B. `!`) direkt als Zunder-Aufgabe.
- **Inbox-Agent:** verarbeitet die Inbox über MCP-Werkzeuge, schlägt Ablage, Tags und
  Querverbindungen vor.
- **Zunder-Brücke:** markierte Checkboxen → Zunder-Aufgaben, mit Rücklink zur Notiz.
- **Kalender-Brücke:** Termine sichtbar im Cockpit; Meeting-Notizen nur optional.
- **Timing-Anreicherung:** Zeiten und erledigte Deep-Work-Blöcke in Tages- bzw. Wochennotiz.
- **Semantische Suche** über den Vault.
- **Graph:** Wikilinks plus semantische Kanten („ähnlich, aber nicht verlinkt“,
  gestrichelt), Aufgaben und Termine als eigene Knotentypen.
- **Cockpit-Startseite:** um die Woche gebaut, nicht um „Heute“. Oben Wochenziele und
  Big Rocks pro Lebensbereich, darunter Termine, Aufgaben, Inbox.

## Reihenfolge

0. Übernahme des bestehenden Vault-MCP (Index, Link-Graph, Capture, Bearbeiten, OAuth) — erledigt
1. Headless-Sync als Adapter, Deployment vom alten Vault-MCP übernehmen
2. Capture mit Zunder-Weiterleitung
3. Cockpit-Web-UI
4. Graph + semantische Suche
5. Eigener Sync (eigenes Projekt: Konflikte, mobile Clients, E2E)

Obsidian selbst zu ersetzen ist kein Ziel — Editor und Apps sind der teure Teil.

## Risiken und Überschneidungen

- **Capture** überschneidet sich mit der Zunder-Inbox und vorhandenen Capture-Apps:
  Weiterleiten statt einen zweiten Eingang bauen.
- **Timing-Anreicherung:** Zunder misst Deep-Work-Blöcke bereits mit Timing — Daten dort
  abholen, nicht doppelt erfassen.
- **Semantische Suche und Graph:** Es gibt bereits eine Hybrid-Suche mit Graph in den
  Vault-Werkzeugen. Vor Schritt 4 klären, ob das Cockpit sie nutzt oder ablöst — kein
  zweiter paralleler Index.
- **Zeit:** Nebenher-Projekt, konkurriert mit der Zunder-Einführung.
- **CI-Minuten:** Repo ist privat; Workflows sparsam halten (Image nur auf `main`).
