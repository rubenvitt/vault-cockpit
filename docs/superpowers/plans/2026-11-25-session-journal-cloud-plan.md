# Session-Journal für Cloud-Sessions: Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Journal-Einträge aus Cloud-Sessions (Claude Code im Web und Sessions in der Claude-App) landen konfliktfrei in denselben Tagesdateien `_System/journal/<sphäre>/<tag>.md` wie lokale Einträge.

**Architecture:** Das Vault Cockpit bekommt ein Journal-Modul (`src/journal/`). Es rendert Einträge im Format des Mods und hängt sie an die Tagesdatei an. Erreichbar ist es als MCP-Werkzeug `vault_journal` (für den Skill) und als `POST /journal` mit einem Token-Recht `journal` (für den Mod in Claude Code im Web). Eine Anhänge-Regel in `merge.js` verhindert Konfliktkopien, wenn Mac und Server gleichzeitig anhängen.

**Tech Stack:**
- Cockpit: Node ≥ 24, ESM, `node --test`, zod.
- Mod: TypeScript, Tests über `claude-code/testing`.
- Skill: Markdown.

**Spec:** `rnotes/docs/superpowers/specs/2026-11-25-session-journal-cloud-design.md`

**Repos:**
- `rubenvitt/vault-cockpit` (Tasks 1–4)
- Vault RNotes (Task 5)
- `rubenvitt/session-journal` (Tasks 6–7)
- Task 8 ist optional und bekommt ein eigenes Repo oder einen Ordner im Mod-Repo.

## Global Constraints

- Ablageort: `_System/journal/<privat|arbeit>/<YYYY-MM-DD>.md`. Tag und Uhrzeiten werden in `Europe/Berlin` gebildet.
- Dateikopf wörtlich wie `fileHeader` im Mod: `---\ntype: journal\ndate: <tag>\nsphere: <sphäre>\n---\n\n# Journal <Wochentag>, <TT.MM.JJJJ> · <sphäre>\n\n\n`. Datum per `Intl` de-DE mit weekday long.
- Eintrag wörtlich wie `renderEntry` im Mod. Einzige Ergänzung bei Cloud-Einträgen: Die Projektzeile endet auf `· <kind> · <source>`.
- Prüfen und Kürzen wie `parseEntry`:
  - Titel ≤ 80 Zeichen, Projekt ≤ 60 (leer → `unbekannt`), Kontext, Erkenntnis und Offen ≤ 300.
  - 1–5 Punkte zu je ≤ 240.
  - Alles einzeilig, Whitespace zusammengezogen.
- `sphaere` nur `privat` oder `arbeit`. `kind` nur `auto`, `manual` oder `final`. `source` nur `code-web` oder `chat`.
- Der Pfad wird nie aus der Eingabe gebaut, nur aus der Sphäre (Allowlist) und dem Datum.
- Kein Doppeleintrag: Gibt es in der Datei schon eine Überschrift `### …–<HH:MM to> · ` und eine Zeile mit `` **Session:** `<session[0..8]>` ``, wird nichts geschrieben (`reason: 'duplicate'`).
- Rechte: MCP über `vault:edit`. HTTP über ein Token mit Recht `journal`, und dieses Recht schließt nichts weiter ein.
- Texte für Nutzer auf Deutsch mit echten Umlauten. Code und Identifier auf Englisch, der Stil folgt der Umgebung.

## Review Focus

- **Tageswechsel nach Berlin-Zeit:** Ein `to` von 23:30Z im Winter fällt in Berlin schon auf den nächsten Tag. Die Datei muss nach Berlin-Datum gewählt werden. *(Test in Task 2.)*
- **Eintrag über Mitternacht:** `from` am Vortag, `to` heute. Die Datei richtet sich nach `to`, die Überschrift zeigt die Uhrzeiten wie lokal. *(Test in Task 2.)*
- **Zugangsdaten im Text:** Sie werden maskiert, auch in Titel und Punkten. *(Test in Task 2.)*
- **Tagesdatei ohne abschließenden Zeilenumbruch** (von Hand bearbeitet): Der Abstand beim Anhängen bleibt wie im Mod (`\n\n`). *(Test in Task 2.)*
- **Merge-Regel ohne Fehlgriff:** Ändert eine Seite mitten in der Datei und die andere hängt an, gilt die neue Regel nicht. Es bleibt beim normalen diff3, Konflikt nur bei Berührung. *(Test in Task 1.)*

---

### Task 1: Anhänge-Regel im 3-Wege-Merge (vault-cockpit)

**Files:**
- Modify: `src/sync/server/merge.js` (`mergeLines`)
- Test: `test/sync-merge.test.js`

**Interfaces:**
- Produces: `mergeLines(base, ours, theirs)` liefert jetzt auch dann ein Ergebnis, wenn beide Seiten nur ans Ende angehängt haben. Die Signatur bleibt gleich. `mergeFile` erbt das Verhalten.

- [ ] **Step 1: Failing tests** in `test/sync-merge.test.js`:
  - `test('beide hängen nur ans Ende an: Server zuerst, dann Gerät', …)`:
    - base `['# T\n', '\n', 'a\n']`, ours = base + `['\n', 'S\n']`, theirs = base + `['\n', 'G\n']`.
    - Erwartet `['# T\n', '\n', 'a\n', '\n', 'S\n', '\n', 'G\n']`.
  - `test('gleicher Anhang auf beiden Seiten kommt nur einmal', …)`: Ergebnis = ours.
  - `test('Anhang plus Änderung davor: alte Regeln', …)`:
    - ours ändert `a\n` zu `b\n` und hängt an, theirs hängt an.
    - Erwartet `null`, weil sich am Ende zwei Einfügungen berühren.
  - `test('mergeFile: Journal-Tagesdatei mit Frontmatter, zwei Anhänge', …)`:
    - Vollständige Tagesdatei als Basis.
    - Erwartet, dass beide `### `-Blöcke im Ergebnis stehen und das Frontmatter unverändert bleibt.
- [ ] **Step 2:** `node --test test/sync-merge.test.js`. Erwartet: die drei neuen Fälle FAIL.
- [ ] **Step 3: Implementieren.** Am Anfang von `mergeLines`:
  - Ist `base` ein Präfix von `ours` **und** von `theirs` und sind beide länger als `base`: Ist der Anhang von ours gleich dem von theirs, kommt `ours` zurück. Sonst kommt `[...ours, ...theirAppend]` zurück.
  - Sonst läuft alles wie bisher.
  - Ein kurzer Kommentar mit Verweis auf das Journal (VCP-Ticket, falls vorhanden).
- [ ] **Step 4:** `npm test`. Erwartet: alles PASS, auch der Zufallstest von `diffLines`.
- [ ] **Step 5: Commit:** `feat(sync): merge concurrent appends at end of file without conflict copy`

### Task 2: Journal-Modul (vault-cockpit)

**Files:**
- Create: `src/journal/journal.js`
- Test: `test/journal.test.js`

**Interfaces:**
- Produces:
  - `export class JournalError extends Error` mit `field`.
  - `export function normalizeEntry(input) -> Entry`. Wirft `JournalError` bei fehlendem Titel, null Punkten oder ungültiger Sphäre, Art oder Quelle.
    - Entry: `{titel, sphaere, projekt, kontext, punkte, erkenntnis?, offen?, from: number, to: number, session: string, kind, source}`.
    - `from` und `to` sind ms. `to` fehlt → `now()`. `from > to` → JournalError.
  - `export function redactSecrets(text) -> string`. Ersetzt `vct_…`, `ghp_…`, `github_pat_…`, `sk-…`, `Bearer <x>`, `password=<x>`/`passwort=<x>` durch `[maskiert]`.
  - `export function renderEntry(entry) -> string` und `export function fileHeader(day, at, sphere) -> string`. Wörtlich nach Global Constraints.
  - `export function createJournal({ vaultPath, index, now = Date.now }) -> { write(input) }`.
    - `write` liefert `{ written: true, path, heading }` oder `{ written: false, reason: 'duplicate' }`.

- [ ] **Step 1: Failing tests** in `test/journal.test.js` (temporärer Vault wie in `test/edit.test.js`, Index über `buildIndex`/`openIndex`):
  - `legt die Tagesdatei mit Kopf an`: Der Inhalt ist genau `fileHeader(...) + renderEntry(...)`. Die Projektzeile endet auf `· manual · chat`.
  - `hängt an eine bestehende Datei mit einer Leerzeile Abstand an`: Bestehende Datei ohne abschließenden Zeilenumbruch → zwischen den Blöcken genau `\n\n`.
  - `wählt den Tag nach Berlin-Zeit`: `to = Date.UTC(2026,0,5,23,30)` → `…/2026-01-06.md`.
  - `über Mitternacht: Datei nach to`: Die Überschrift zeigt `23:10–00:20`.
  - `schreibt denselben Eintrag nicht doppelt`: Zweimal `write` mit gleicher Session und gleichem `to` → das zweite Mal `{written:false, reason:'duplicate'}`, die Datei ist unverändert.
  - `maskiert Zugangsdaten`: Ein Punkt mit `ghp_abc123…` erscheint als `[maskiert]`.
  - `lehnt ungültige Sphäre und leere Punkte ab`: JournalError mit `field`.
  - `fixture`: Liest das Fixture aus `test/fixtures/journal-entry.json` und vergleicht mit `test/fixtures/journal-entry.md`. Dieselben Dateien kommen in Task 6 ins Mod-Repo.
- [ ] **Step 2:** `node --test test/journal.test.js` → FAIL (Modul fehlt).
- [ ] **Step 3: Implementieren.**
  - Zeitformat wie im Mod über `Intl.DateTimeFormat` mit `timeZone: 'Europe/Berlin'`.
  - Schreiben:
    - `mkdirSync(…, {recursive:true})`.
    - Unmittelbar vor `writeFileSync` neu lesen und vergleichen, wie `modify` in `src/vault/edit.js`.
    - `realpath` muss innerhalb des Vaults liegen.
    - Danach `index.refresh?.(rel)`.
  - Die Doppelprüfung sucht per Regex in den Zeilen der Datei.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit:** `feat(journal): render and append session journal entries`

### Task 3: MCP-Werkzeug `vault_journal` (vault-cockpit)

**Files:**
- Modify: `src/mcp/server.js` (nach `vault_append`), `src/main.js` (`createJournal` erzeugen und in `createVaultMcpHandler` übergeben)
- Test: `test/e2e-mcp.test.js`

**Interfaces:**
- Consumes: `createJournal(...).write(input)` aus Task 2.
- Produces: Werkzeug `vault_journal`.
  - inputSchema: `titel`, `sphaere` (enum), `projekt`, `kontext`, `punkte` (string[]), `erkenntnis?`, `offen?`, `from` (RFC 3339), `to?` (RFC 3339), `session`, `kind` (enum), `source` (enum, Standard `chat`).
  - annotations `EDITS`, umschlossen von `edit(…, 'Der Journal-Eintrag wurde nicht geschrieben')`.

- [ ] **Step 1: Failing tests** in `test/e2e-mcp.test.js`:
  - `vault_journal schreibt in _System/journal`: Der Aufruf liefert `written: true`, und `vault_read` auf den Pfad zeigt den Block.
  - `vault_journal ohne vault:edit`: Liefert die Meldung `EDIT_SCOPE_MISSING`.
- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Implementieren.**
  - Die Beschreibung des Werkzeugs sagt, wann es zu nutzen ist (Skill `/journal`), dass die Regeln für den Inhalt beim Aufrufer liegen und dass `to` weggelassen werden darf.
  - `from` und `to` werden per `Date.parse` umgewandelt. Ungültig → `fail` mit Klartext.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit:** `feat(mcp): add vault_journal tool`

### Task 4: `POST /journal` mit Token-Recht `journal` (vault-cockpit)

**Files:**
- Create: `src/journal/http.js`
- Modify:
  - `src/cockpit/tokens.js`: `SCOPES` um `'journal'` ergänzen, keine `INCLUDES`.
  - `src/web/settings-json.js`: `SCOPE_LABELS.journal = 'Journal'`.
  - `src/http/app.js`: Option `journalHttp`, Weiche neben `captureHttp`.
  - `src/main.js`: verdrahten.
  - `README.md`: Abschnitt „Journal“ unter Capture.
- Test: `test/journal-http.test.js`

**Interfaces:**
- Consumes: `createJournal` aus Task 2, `tokens.verify(presented, 'journal')`.
- Produces: `export function createJournalHttp({ tokens, journal }) -> { matches(path), handle(req, res, url, body) }`.
  - `POST /journal`, JSON-Body wie das inputSchema aus Task 3. Antworten:
    - `201` mit `{written:true, path, heading}`.
    - `200` mit `{written:false, reason:'duplicate'}`.
    - `400` mit `{error, field}` bei JournalError.
    - `401` ohne gültiges Token.
  - `GET /journal` ist ein Verbindungstest.

- [ ] **Step 1: Failing tests** in `test/journal-http.test.js`:
  - `201 und Datei geschrieben mit journal-Token`.
  - `401 mit capture-Token`.
  - `401 ohne Token`.
  - `400 bei sphaere: "kunde"`.
  - `200 duplicate beim zweiten Mal`.
  - `ein journal-Token kommt nicht an /capture und /api/search` (bestehende Handler mit demselben Token aufrufen → 401).
- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3: Implementieren** nach dem Muster von `src/capture/http.js`: Bearer-Header, `timingSafeEqual` über `tokens.verify`, JSON-Fehlertexte auf Deutsch.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit:** `feat(journal): add POST /journal with journal token scope`
- [ ] **Step 6: Deploy und prüfen** (Ruben):
  - Ausrollen.
  - Unter Einstellungen → API-Tokens einen Token „session-journal“ mit Recht Journal anlegen.
  - `curl -H "Authorization: Bearer vct_…" https://vault.rubeen.dev/journal` liefert `200`.

### Task 5: Skill `/journal` für Sessions in der Claude-App (Vault)

**Files:**
- Create: `_System/claude-skills/journal/SKILL.md`

**Interfaces:**
- Consumes: Werkzeug `vault_journal` (Task 3).

- [ ] **Step 1: SKILL.md schreiben.**
  - Frontmatter: `name: journal` und eine Description, die auf „/journal“, „Journal-Eintrag“ und „Session festhalten“ anspringt.
  - Ablauf wie im Spec, Teil 2. Die Regeln wörtlich aus `buildPrompt` im Mod übernehmen (Deutsch mit Umlauten, keine Implementierungsdetails, keine Namen, keine Kunden, keine Zugangsdaten, kein „nicht X, sondern Y“, Sphäre).
  - Uhrzeit über das Werkzeug für die Uhrzeit, `to` weglassen.
  - `session` beim ersten Aufruf `chat-` plus 4 zufällige Zeichen, im Gespräch beibehalten.
  - Gibt es nichts Nennenswertes, keinen Aufruf machen und das in einem Satz sagen.
  - Bestätigung: eine Zeile mit Titel und Sphäre.
- [ ] **Step 2: Im Account bereitstellen.** Über die Skill-Vorschlagskarte speichern lassen, Ruben bestätigt.
- [ ] **Step 3: Prüfen.**
  - In einer neuen Session der Claude-App `/journal` aufrufen.
  - `vault_read` auf die Tagesdatei zeigt den Eintrag mit `· manual · chat`.
  - Auf dem Mac erscheint er nach dem Sync ohne Konfliktkopie.

### Task 6: Mod, Zweig für Claude Code im Web (session-journal)

**Files:**
- Modify: `hooks/register.ts`, `.claude-plugin/plugin.json` (userConfig `cockpit_url`, Standard `https://vault.rubeen.dev`), `README.md`
- Test: `tests/remote.test.ts`, `tests/fixtures/journal-entry.json` und `.md` (Kopie aus Task 2)

**Interfaces:**
- Consumes: `POST /journal` (Task 4).
- Produces:
  - `type Sink = (entry: Entry, from: number, to: number, sessionId: string, kind: Kind) => Promise<string>`. Liefert den Pfad bzw. die Ziel-Beschreibung.
  - `fileSink` ist das heutige `appendEntry`.
  - `remoteSink(url, token)` schickt JSON mit `source: 'code-web'` und `session: sessionId`.
  - `journal()` wählt die Senke: `CLAUDE_CODE_REMOTE === 'true'` → remote. Das Token kommt aus `SESSION_JOURNAL_TOKEN`. Fehlt es, kommt `{written:false, reason:'kein SESSION_JOURNAL_TOKEN'}`.

- [ ] **Step 1: Spike, 10 Minuten.** Herausfinden, wie die Engine Netz bietet (`$.http`/`$.net`/`fetch` in den Typen von `claude-code`) und ob `$.env.get('CLAUDE_CODE_REMOTE')` den Wert liefert.
  - Gibt es kein Netz: abbrechen, Ergebnis als Kommentar am Zunder-Task, weiter mit Task 8. Das ist der Ausweichweg aus dem Spec.
- [ ] **Step 2: Failing tests** in `tests/remote.test.ts` (Muster `tests/gate.test.ts`):
  - `remote: /journal schickt POST mit Bearer und source code-web`: Der aufgezeichnete Request hat Body-Felder wie im Fixture.
  - `remote: ohne Token kein Request, Grund im Ergebnis`.
  - `remote: Netzfehler → ein zweiter Versuch, dann ui.log`.
  - `lokal: unverändert Datei` (bestehender Test bleibt grün).
  - `render-Fixture stimmt mit Cockpit überein` (`renderEntry` gegen `.md`, ohne das Quellen-Suffix).
- [ ] **Step 3: Implementieren.** `Sink` herauslösen, `remoteSink` mit einem Wiederholversuch.
- [ ] **Step 4:** `tsc -p . && claude plugin test .` → PASS.
- [ ] **Step 5: Commit:** `feat: write journal entries to vault cockpit in cloud sessions`

### Task 7: Cloud-Umgebung einrichten (Claude Code im Web)

**Files:**
- Modify: `README.md` in session-journal, Abschnitt „Cloud-Sessions“ mit dem Setup-Baustein.

- [ ] **Step 1: Setup-Baustein schreiben**, der mehrfache Läufe verträgt:
  - `claude plugin marketplace add rubenvitt/session-journal`, sonst überspringen, wenn er schon da ist.
  - `claude plugin install session-journal@session-journal`, sonst überspringen, wenn es schon installiert ist.
  - Vorher klären, ob die Umgebung das private Repo per GitHub-Anmeldung klonen kann. Wenn nicht: das Repo in der Umgebung als Quelle anhängen und `marketplace add <lokaler Pfad>` nutzen.
- [ ] **Step 2: Umgebung einstellen** (Ruben):
  - Den Baustein ins Setup-Script eintragen.
  - `SESSION_JOURNAL_TOKEN` als Umgebungsvariable setzen.
  - `vault.rubeen.dev` in die Netzwerk-Freigabe aufnehmen.
- [ ] **Step 3: Prüfen.**
  - In einer Session von Claude Code im Web `/journal` ausführen. Die Tagesdatei zeigt `· manual · code-web`.
  - Nach 30 Minuten Arbeit erscheint ein `auto`-Eintrag.

### Task 8 (optional): Erinnerung per Stop-Hook in Sessions der Claude-App

**Files:**
- Create: Plugin `journal-nudge` mit `.claude-plugin/plugin.json`, `hooks/hooks.json` (`Stop`, Typ `command`) und `hooks/nudge.sh`
- Test: `tests/nudge.bats` oder ein Shell-Test mit simuliertem Hook-Input

**Interfaces:**
- Consumes: Skill `/journal` (Task 5).
- Produces: `nudge.sh` liest das Hook-JSON von stdin und führt einen Zeitstempel in `$CLAUDE_PROJECT_DIR/.claude/journal-nudge` bzw. in einem Session-Temp-Verzeichnis.
  - Gibt `{"decision":"block","reason":"Journal: /journal ausführen (letzter Eintrag vor über 30 Minuten)."}` erst nach ≥ 30 Minuten aus und dann nur einmal.
  - Bei `stop_hook_active: true` nie.

- [ ] **Step 1: Failing tests:**
  - Erster Stop → keine Ausgabe, der Zeitstempel wird gesetzt.
  - Nach simulierten 31 Minuten → block.
  - Danach sofort → nichts.
  - `stop_hook_active` → nichts.
- [ ] **Step 2:** Tests laufen lassen → FAIL.
- [ ] **Step 3:** `nudge.sh` implementieren (bash und jq; ohne jq mit einem einfachen grep).
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5: Erprobung** (Ruben): Das Plugin im Account hochladen und eine Woche nutzen. Am 08.12. zusammen mit dem Prüfpunkt zur Nutzung in den Reviews entscheiden, ob es bleibt.
