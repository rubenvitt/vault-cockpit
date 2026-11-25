---
type: design-spec
date: 2026-11-25
status: zur-freigabe
zunder: km8zbory1b6vhc7rdwhqitod
---

# Session-Journal für Cloud-Sessions: Design

## Wozu

Das Session-Journal (Mod `rubenvitt/session-journal`, lokal live seit 24.11.) schreibt abgeschlossene Arbeitsblöcke einer Claude-Session nach `_System/journal/<privat|arbeit>/YYYY-MM-DD.md` im Vault RNotes. Tages-Review, Feuer-Review und der Timing-Skill lesen diese Dateien als Beleg dafür, was an einem Tag passiert ist. Cloud-Sessions fehlen dort bisher ganz. Die Belege sind also lückenhaft, sobald Ruben von unterwegs arbeitet, etwa im Zug oder vom Handy aus.

Ziel: Auch Cloud-Sessions landen im selben Journal, im selben Format, ohne dass Ruben daran denken muss. Das ist auch der Grund, warum es überhaupt einen Mod gibt.

## Ausgangslage (Stand 25.11.)

- **Lokal:** Der Mod hängt an `turn.complete` (frühestens alle 30 Minuten, und nur wenn seitdem ein Prompt kam), an `/journal` und an `/clear`. Den Eintrag schreibt das Session-Modell selbst über `$.model.fork` als JSON. Gespeichert wird er per `$.fs` in `journal_dir`.
- **Cloud-Sessions von Claude Code im Web:** Der Mod ist dort nicht installiert. Selbst wenn er es wäre, würde `$.fs` in den Container schreiben, der nach der Session verloren ist.
- **Sessions in der Claude-App, also Cloud-Sessions wie Zug-Chats, Zunder oder Skills:** Mods laufen dort grundsätzlich nicht. Klassische Plugin-Hooks (`hooks.json`, Typ `command`) laufen dagegen, das zeigt der SessionStart-Hook von superpowers.
- **Vault Cockpit (RVault, `rubenvitt/vault-cockpit`):** Aus der Cloud erreichbar.
  - `vault_capture` legt nur neue Notizen in der Inbox an.
  - `vault_append` braucht eine Notiz, die schon im Index steht, kann also keine Tagesdatei anlegen.
  - Es gibt keinen Weg, an eine Journal-Tagesdatei anzuhängen und sie dabei bei Bedarf anzulegen.
- **Sync:** Seit 25.11. ist cockpit-sync der live Abgleich. Vorher lief es im Vergleichsmodus, deshalb fehlte `_System/journal/` auf dem Server.

## Ziele

1. Ein Journal-Eintrag aus einer Cloud-Session landet in derselben Tagesdatei wie lokale Einträge, im selben Format (Kopf, `### HH:MM–HH:MM · Titel`, Stichpunkte, Erkenntnis mit `#mycel-candidate`, Offen).
2. **Claude Code im Web:** automatisch wie lokal, mit 30-Minuten-Schranke, `/journal` und `/clear`.
3. **Sessions in der Claude-App:** mindestens ein Skill `/journal-save`, der auf Zuruf einen Eintrag schreibt. Bestenfalls eine Erinnerung per Hook, damit Ruben nicht daran denken muss.
4. Lokale Einträge und Cloud-Einträge kommen sich nicht in die Quere: Es geht nichts verloren und es entsteht kein Konflikt-Duplikat.

## Nicht-Ziele

- Lokal ändert sich nichts. Der Mod schreibt weiter per `$.fs`.
- Kein Rückblick auf vergangene Cloud-Sessions.
- Kein eigenes Journal-Format für die Cloud.
- Kein Lesewerkzeug fürs Journal. Lesen geht wie bisher über `vault_read` und die Reviews.

## Anti-Ziele (wäre ein Fehlschlag, selbst wenn es technisch läuft)

- Es entstehen doppelte oder zerschossene Tagesdateien, etwa Konflikt-Kopien von cockpit-sync bzw. Obsidian Sync.
- Ein Cloud-Eintrag enthält, was die Prompt-Regeln lokal ausschließen: Namen, Kunden, Zugangsdaten.
- Die Inbox füllt sich mit Journal-Schnipseln.
- Das neue Recht ist so breit, dass ein Journal-Token mehr kann als ins Journal schreiben.

## Wege (betrachtet)

| Weg | Kurz | Abwägung |
|---|---|---|
| **A. Journal-Schnittstelle im Cockpit** (gewählt) | MCP-Werkzeug `vault_journal` und HTTP-Endpunkt `POST /journal` hängen an die Tagesdatei an. Der Mod nutzt remote den Endpunkt, in Sessions der Claude-App ruft ein Skill das Werkzeug auf. | Eine Stelle schreibt, das Format liegt zentral im Cockpit, Einträge kommen sofort an. Kostet Code und ein neues Recht im Cockpit. |
| B. Über die Inbox | `vault_capture` in die Inbox, ein Mac-Job sortiert ins Journal ein. | Am Server ändert sich nichts, aber die Einträge kommen verzögert an, die Inbox füllt sich, und es gibt eine zweite Stelle, die kaputtgehen kann. |
| C. Nur ein Skill | `/journal` von Hand, keine Automatik. | Sofort machbar, aber genau die Disziplin, die der Mod abschaffen soll. Steckt als Teil 2 in A. |

**Entscheidung (Ruben, 25.11.):** Weg A, in Schritten.

## Design

### Teil 0: Sync und gleichzeitiges Anhängen (Vorbedingung)

**Ursache geklärt (25.11.):** cockpit-sync lief im Vergleichsmodus und hat deshalb nichts hochgeladen. Nach Rubens Umstellung auf cockpit-sync sieht RVault `_System/journal/` jetzt.

**Schreibweg:** Live ist cockpit-sync. Auf dem Server ist die Platte die Wahrheit, und das Sync-Journal sieht vor jeder Prüfung neu auf die Platte, weil das Cockpit selbst daran vorbei schreibt. `vault_journal` darf deshalb wie `edit.js` direkt in den Vault schreiben.

**Offenes Problem, das gleichzeitige Anhängen:** Schreiben Mac und Server zwischen zwei Abgleichen beide etwas ans Ende derselben Tagesdatei, sieht `merge.js` zwei Einfügungen an derselben Stelle. Das gilt als Konflikt, und es entsteht eine Konfliktkopie. Genau das soll nach den Anti-Zielen nicht passieren. **Lösung (Ruben, 25.11.): Sonderregel in `merge.js`.**
- *Regel:* Haben beide Seiten gegenüber der Basis nur Zeilen ans Dateiende angehängt und alles davor unverändert gelassen, werden beide Anhänge hintereinandergesetzt: erst der Stand des Servers, dann der des Geräts. Kein Konflikt.
- *Gilt für alle mergebaren Textdateien.* Jede Notiz, an die man nur anhängt, profitiert also, nicht nur das Journal.
- *Grenzen der Regel:* Steht in beiden Anhängen derselbe Text, kommt er nur einmal hinein. Ändert eine Seite auch nur eine Zeile vor dem Ende, gilt die Regel nicht, und es bleibt beim bisherigen Verhalten.
- *Bewusst in Kauf genommen:* Die Einträge stehen dann eventuell nicht streng nach Uhrzeit sortiert. Jeder Eintrag trägt seine Zeitspanne.

Verworfen:
- Eine eigene Datei pro Quelle, weil dann alle lesenden Rituale angepasst werden müssten.
- Auch lokal immer übers Cockpit schreiben, weil das Journal lokal dann am Netz hinge.

Abnahme: Gleichzeitiges Anhängen auf Mac und Server an dieselbe Tagesdatei ergibt beide Einträge, ohne Konfliktkopie (Test in `merge`/`journal` und einmal von Hand).

### Teil 1: Cockpit, `vault_journal` und `POST /journal`

- **Eingabe:** dasselbe Eintrags-JSON, das der Mod vom Modell bekommt (`titel`, `sphaere`, `projekt`, `kontext`, `punkte[]`, optional `erkenntnis` und `offen`), dazu:
  - `from` und `to` als RFC 3339,
  - `session` (kurze Kennung),
  - `kind` (`auto`, `manual` oder `final`),
  - `source` (`code-web` oder `chat`).
- **Prüfen und kürzen** wie `parseEntry` im Mod: Titel höchstens 80 Zeichen, 1 bis 5 Punkte, Einzeiler.
- **Ziel:** `_System/journal/<sphaere>/<YYYY-MM-DD>.md`. Tag und Uhrzeiten werden in Europe/Berlin aus `to` bzw. `from` gebildet. Fehlt die Datei, wird sie mit Frontmatter-Kopf (`type: journal`, `date`, `sphere`) und der Überschrift `# Journal <Wochentag>, <TT.MM.JJJJ> · <sphäre>` angelegt. Sonst wird der Eintrag mit einer Leerzeile Abstand angehängt.
- **Rendern** genau wie `renderEntry` im Mod. Die Zeile mit Projekt und Session bekommt bei Cloud-Einträgen zusätzlich die Quelle, z. B. `· auto · code-web`. Damit lässt sich später unterscheiden, woher ein Eintrag kam.
- **Kein Doppeleintrag:** Steht dieselbe Session mit derselben Endzeit (`HH:MM`) schon in der Datei, wird nicht nochmal geschrieben. Die Antwort sagt dann `duplicate`. Wiederholte Versuche nach Netzfehlern sind damit harmlos.
- **Schreibregeln** wie in `src/vault/edit.js`: unmittelbar vor dem Schreiben neu lesen, `realpath`-Schutz, danach die Notiz neu indexieren. Der Pfad ist fest und wird nie aus der Eingabe gebaut, nur aus der Sphäre (Allowlist) und dem Datum.
- **Rechte:**
  - MCP: Scope `vault:edit`. Den hat der Connector schon, Ruben muss also nicht neu verbinden. *(Claudes Entscheidung.)*
  - HTTP: ein Token mit eigenem Recht **Journal** (`vct_…`), angelegt unter Einstellungen → API-Tokens, analog zu Capture. Es kann nur `POST /journal` aufrufen, also weder lesen noch suchen noch etwas anderes schreiben.
- **Antwort:** `{ written: true, path, heading }` oder `{ written: false, reason }`.
- **Zeiten (Claudes Entscheidung):** `to` ist optional. Fehlt es, setzt der Server die eigene Uhrzeit ein. `from` ist Pflicht.
- **Maskieren (Claudes Entscheidung):** Das Cockpit maskiert vor dem Schreiben offensichtliche Zugangsdaten per Muster (`vct_…`, `ghp_…`/`github_pat_…`, `sk-…`, `Bearer …`, `password=`). Das ist ein Ersatz für `$.session.redact`, den der Skill-Weg nicht hat.

### Teil 2: Skill `/journal-save` für Sessions in der Claude-App

- Liegt bei den anderen Skills unter `_System/claude-skills/journal/SKILL.md` und wird wie diese in den Account hochgeladen.
- Ablauf:
  1. Arbeit seit dem letzten Journal-Eintrag dieser Session zusammenfassen, sonst seit Session-Beginn.
  2. Dabei dieselben Regeln wie im Prompt des Mods anwenden (wortgleich übernehmen).
  3. Sphäre bestimmen: Vorgabe `privat`, `arbeit` bei Beruflichem.
  4. `vault_journal` mit `source: chat` aufrufen.
  5. Mit einer Zeile bestätigen.
- Ohne Eintrag (nichts Nennenswertes passiert) sagt der Skill das und schreibt nichts.
- **Zeiten und Session (Claudes Entscheidung):**
  - `from` ist die Uhrzeit des letzten Journal-Eintrags in diesem Gespräch, sonst der Anfang des Gesprächs, abgeschätzt aus dem Verlauf. Die aktuelle Uhrzeit kommt über das Werkzeug für die Uhrzeit, und `to` wird weggelassen.
  - `session` ist beim ersten Aufruf eine neu gewürfelte Kennung `chat-xxxx`, die im Gespräch für alle weiteren Einträge gleich bleibt.

### Teil 3: Mod, Zweig für Claude Code im Web

- Erkennt per `$.env.get('CLAUDE_CODE_REMOTE') === 'true'`, dass er remote läuft. Dann geht der Eintrag per POST an `<cockpit_url>/journal` statt an `$.fs`. Eintrag, Schranke, `/journal` und `/clear` bleiben gleich.
- Neue `userConfig`-Felder: `cockpit_url` (Standard `https://vault.rubeen.dev`). Das Token kommt aus der Umgebungsvariable `SESSION_JOURNAL_TOKEN` der Cloud-Umgebung, nie aus einer Datei im Repo.
- **Fehlschlag:** einmal wiederholen (durch die Doppelprüfung ungefährlich), dann `$.ui.log` mit Grund, wie bisher in der Probephase.
- **Ausweichweg (Claudes Entscheidung):** Hat die Mod-Engine dort kein Netz oder sieht sie `CLAUDE_CODE_REMOTE` nicht, bekommt auch Claude Code im Web den Weg aus Teil 2 und Teil 4: Skill plus Erinnerung per Hook. Der Mod bleibt dann nur lokal.
- **Installation in der Cloud:** Das Setup-Script der Umgebung fügt den Marketplace hinzu und installiert das Plugin. Es muss mehrfache Läufe vertragen (Erkenntnis vom 24.11.). Die Netzwerk-Freigabe der Umgebung braucht `vault.rubeen.dev`.

### Teil 4 (optional, zuletzt): Erinnerung per Hook in Sessions der Claude-App

Ein kleines Plugin mit einem `Stop`-Hook vom Typ `command`. Es merkt sich in einer Datei im Session-Verzeichnis, wann zuletzt erinnert wurde. Nach frühestens 30 Minuten blockiert es das Ende des Turns einmal mit dem Grund „/journal ausführen“, damit Claude den Skill aufruft.

Ob das in diesen Sessions verlässlich und ohne Nebenwirkungen läuft, ist ungeprüft. Deshalb ist es ein eigener Schritt mit einer kurzen Erprobung, bevor es dauerhaft bleibt.

## Reihenfolge

0 → 1 → 2 (damit sind Sessions in der Claude-App schon abgedeckt) → 3 → 4.

## Dem Bauenden überlassen

- Wo der Code in `vault-cockpit` liegt (Vorschlag: `src/journal/`, Werkzeug in `src/mcp/server.js`, Route in `src/http/app.js`) und wie das Token-Recht in `src/cockpit/tokens.js` ergänzt wird.
- Ob Rendern und Prüfen im Mod und im Cockpit doppelt gepflegt oder über ein gemeinsames Testbeispiel abgesichert werden. Vorschlag: ein Fixture-JSON mit erwartetem Markdown in beiden Repos.
- Tests nach den Mustern in `test/edit.test.js` und `test/capture.test.js`.
- Der genaue Wortlaut des Skills.

## Offene Punkte

- Ob die Mod-Engine in Claude Code im Web Netzwerkzugriff hat (`$.http` oder `fetch`) und ob `$.env` dort `CLAUDE_CODE_REMOTE` sieht.
- Wie das Setup-Script an das private Repo `session-journal` kommt (Marketplace aus GitHub mit Anmeldung der Umgebung?).
