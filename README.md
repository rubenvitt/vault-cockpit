# Vault Cockpit

Remote-MCP-Server, der Claude (claude.ai, Claude Desktop, Claude Code) Zugriff
auf einen Obsidian-Vault gibt: lesen, neue Notizen im Posteingang anlegen und
bestehende Notizen gezielt bearbeiten. Reiner OAuth-Resource-Server: [Pocket ID](https://pocket-id.org)
ist der Authorization Server, Claude weist sich per CIMD aus.

Hervorgegangen aus `vault-mcp`; wächst zum Cockpit rund um den Vault (Sync, Capture,
Konnektoren, Web-UI) — siehe [docs/roadmap.md](docs/roadmap.md).

## Was er kann

Alle Lesewerkzeuge verlangen den Scope `vault:read`.

| Werkzeug | Zweck |
|---|---|
| `vault_search` | Hybride Suche (Volltext + Bedeutung + Link-Graph) oder reine Volltextsuche, mit Filtern auf Tag, Ordner und Frontmatter-Typ |
| `vault_similar` | Inhaltlich ähnliche Notizen, mit Markierung, ob schon verlinkt |
| `vault_graph` | Graph um eine Notiz: Links, ähnliche Notizen, Zunder-Aufgaben, Termine |
| `vault_read` | Notiz vollständig lesen, mit Fortsetzung bei sehr langen Notizen |
| `vault_list` | Ordner auflisten, zur Orientierung |
| `vault_links` | Backlinks und ausgehende Links einer Notiz |
| `vault_stats` | Kennzahlen des Vaults, Zustand des Syncs und des Index |
| `vault_capture` | Neue Notiz im Capture-Ordner ablegen (Scope `vault:capture`) |
| `vault_edit` | Exakte Textstelle in einer Notiz ersetzen oder löschen (Scope `vault:edit`) |
| `vault_append` | Text am Notizende oder unter einer Überschrift anhängen (Scope `vault:edit`) |
| `vault_set_frontmatter` | Einzelne Frontmatter-Felder setzen oder entfernen (Scope `vault:edit`) |
| `vault_move` | Notiz in einen Ordner verschieben, optional umbenennen, etwa zum Leeren der Inbox; nie in oder aus vertraulichen Ordnern, nennt Links, die danach ins Leere zeigen (Scope `vault:edit`) |

## Betrieb

Das Image baut GitHub Actions bei jedem Push auf `main`:
`ghcr.io/rubenvitt/vault-cockpit:latest` (zusätzlich `:<commit-sha>`).

1. `docker-compose.example.yml`, `.env.example`, `sync.env.example` und
   `policy.example.json` neben den Stack kopieren (ohne `.example`) und anpassen.
   Die Ordner `data`, `sync-config` und `sync-status` anlegen und uid 1000 geben
   (`mkdir -p data sync-config sync-status && chown 1000:1000 data sync-config sync-status`).
2. In Pocket ID unter *Allowed metadata document URLs*
   `https://claude.ai/oauth/mcp-oauth-client-metadata` freischalten und eine API
   mit der Resource `<PUBLIC_URL>/mcp` anlegen. An der API CIMD-Clients zulassen
   und die Berechtigungen `vault:read` (alle Lesewerkzeuge), `vault:capture` und
   `vault:edit` anlegen, jede mit Freigabe für CIMD-Clients. Fehlt eine davon,
   lehnt Pocket ID das Verbinden mit `invalid_scope` ab, weil Claude alle drei
   anfordert. Ein bestehender Connector behält die Scopes seiner ersten Anmeldung
   und muss nach einer Änderung in Claude neu verbunden werden.
3. Sync einrichten (siehe [Sync](#sync)), dann `docker compose up -d` und in
   Claude einen Connector auf `<PUBLIC_URL>/mcp`.

Im Deployment steht nur, was vor der ersten Anmeldung gebraucht wird. Alles
andere (Zunder, Brücke, Capture- und Such-Tokens, Mail, Embeddings, Kalender,
Anzeige) stellt man nach dem Login im Web-Cockpit unter **Einstellungen** ein;
das Sitzungs-Secret erzeugt der Dienst selbst.

| Variable | Bedeutung |
|---|---|
| `PUBLIC_URL` | öffentliche Adresse, Pflicht |
| `OIDC_ISSUER` | Pocket-ID-Issuer, Pflicht |
| `ALLOWED_SUBJECTS` | Pocket-ID-`sub`-Werte mit Zugriff, Pflicht |
| `WEB_CLIENT_ID`, `WEB_CLIENT_SECRET` | OIDC-Client des [Web-Cockpits](#web-cockpit); ohne `WEB_CLIENT_ID` gibt es keine Oberfläche und damit keine Einstellungen |
| `APP_TEAM_ID`, `APP_BUNDLE_ID` | Apple-Team und Bundle-ID der [iOS-App](#ios-app-login-und-app-api) für `/.well-known/apple-app-site-association`, Standard `H95J852PKP` und `dev.rubeen.cockpit` |

Betrieb und Pfade im Container (die Compose-Datei setzt sie, sonst passen die Standards):

| Variable | Bedeutung |
|---|---|
| `POLICY_FILE` | Pfad zur Policy (vertrauliche Ordner, Ausschlüsse) |
| `VAULT_PATH`, `INDEX_DB`, `VECTOR_DB`, `CAPTURE_FOLDER` | Pfade, Standard `/vault`, `/data/index.db`, `/data/vectors.db`, `inbox` |
| `REINDEX_INTERVAL_MIN` | Abstand der vollen Index-Neuaufbauten und der Brückenrunden, Standard 15 (Netz neben der Dateibeobachtung) |
| `SYNC_ADAPTER` | `obsidian-headless` (Standard) oder `none` (keine Dateibeobachtung, kein Sync-Status) |
| `SYNC_STATUS_FILE` | Statusdatei des Sync-Sidecars, z. B. `/sync-status/sync.json` |
| `CAPTURE_STATE_FILE` | Merkzettel gegen doppelte Aufgaben, Standard `/data/capture-state.json` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Abo-Token aus `claude setup-token` (ein Jahr gültig) für [Folgen](#lesen) „Podcast“ und „Report“; ohne gibt es nur „Vorlesen“. `ANTHROPIC_API_KEY` reicht das Cockpit bewusst nicht an die CLI weiter |
| `FOLGEN_DIR` | Folgen (MP3 und Stand), Standard `/data/folgen` |
| `TTS_CACHE_DIR`, `TTS_CACHE_MB` | Cache der [Stimme vom Server](#lesen) (ein MP3 je Satz), Standard `/data/tts-cache` und 500 MB; darüber fliegen die am längsten nicht gehörten Sätze |

**Übergang für ältere Deployments:** `CAPTURE_TOKEN`, `ZUNDER_URL`/`ZUNDER_TOKEN`,
`ZUNDER_BRIDGE`/`ZUNDER_BRIDGE_TAG`, `OBSIDIAN_VAULT_NAME`, `COCKPIT_TZ`,
`MAIL_JMAP_TOKEN`/`MAIL_ALLOWED_SENDERS`/`MAIL_MAILBOX`/`MAIL_DONE_MAILBOX`/`MAIL_POLL_MIN`
und `EMBED_URL`/`EMBED_MODEL` wirken weiter, solange das passende Feld in den
Einstellungen leer ist; die Einstellungsseite zeigt dann „aus der Umgebung“.
`CAPTURE_TOKEN` gilt neben den angelegten Capture-Tokens weiter. Ist alles in den
Einstellungen eingetragen (und die Kurzbefehle mit einem neuen Capture-Token
importiert), können die Variablen aus dem Deployment raus.

**Vorlesen aus der Umgebung:** `ELEVENLABS_API_KEY` schaltet die Stimme von
ElevenLabs ein, `ELEVENLABS_VOICE_ID` und `ELEVENLABS_MODEL` wählen Stimme und
Modell (Standard „George“ `JBFqnCBsd6RMkjVDRZzb` und `eleven_multilingual_v2`),
`TTS_PROVIDER=geraet` schaltet sie trotz Key ab. Wie oben gilt das, solange das
Feld unter **Einstellungen → Vorlesen** leer ist; so kann der Key auch aus einem
Secret-Store ins Deployment kommen, statt in `cockpit-settings.json` zu liegen.

### Sicherung von `/data`

Unter `/data` liegen zwei Sorten Dateien. `index.db` und `vectors.db` baut das
Cockpit beim Start selbst neu auf (die Vektoren dauern auf der CPU eine Weile).
Die übrigen lassen sich nicht neu bauen, ohne sie ist alles neu einzurichten:

| Datei | Inhalt |
|---|---|
| `cockpit-settings.json` | alle Einstellungen: Kalender mit Adressen und Passwörtern, Zunder-Zugang, Brücke, Mail-Token, Embeddings, Vorlesen (ElevenLabs-Key), Anzeige |
| `api-tokens.json` | API-Tokens für Kurzbefehle, Funke und Suche (nur Hashes; fehlen sie, müssen alle Kurzbefehle neue Tokens bekommen) |
| `capture-state.json` | Merkzettel von Capture und Brücke (keine doppelten Aufgaben, zuletzt gesehene Checkbox-Stände) |
| `session-secret` | Secret des Sitzungs-Cookies (bei gesetztem `SESSION_SECRET` ohne Bedeutung) |
| `folgen/` | erzeugte [Folgen](#lesen) als MP3 mit `folgen.json`; fehlen sie, lassen sie sich neu erzeugen, das kostet aber noch einmal Zeichen bei ElevenLabs |
| `lesestapel.db` | [Lesestapel](#lesen): gespeicherte Artikel samt Text, Markierungen, Feeds (SQLite) |

Die Obsidian-Anmeldung des Sync-Sidecars liegt nicht hier, sondern in
`./sync-config`; fehlt sie, einmal neu anmelden (siehe [Sync](#sync)).

**Am einfachsten** sichert der Host das Verzeichnis `./data` mit seinem
Backup-Job (restic, Kopia, Snapshots des Volumes). Wiederherstellen heißt dann:
Dateien zurückkopieren, `chown 1000:1000`, Container starten. `lesestapel.db`
ist eine SQLite-Datei, die der Dienst offen hält: Eine Dateikopie mitten in einem
Schreibvorgang kann unbrauchbar sein. Für das Host-Backup (VCP-64) deshalb einen
Snapshot des Volumes nehmen, vorher `sqlite3 data/lesestapel.db ".backup data/lesestapel.bak"`
laufen lassen oder zusätzlich die Sicherung im Cockpit ziehen.

**Ohne Host-Backup** gibt es die Sicherung im Cockpit: **Einstellungen →
Sicherung**, eine Passphrase mit mindestens 12 Zeichen zweimal eingeben,
„Sicherung herunterladen“. Die Datei `cockpit-sicherung-JJJJ-MM-TT.json` enthält
die Dateien oben, verschlüsselt mit AES-256-GCM und einem Schlüssel aus der
Passphrase (scrypt, N = 2^17, r = 8, p = 1, zufälliges Salt). Im Klartext stehen
nur Format, Version, Zeitpunkt und die Parameter; eine Änderung daran fällt beim
Öffnen auf. Ohne die Passphrase ist die Datei wertlos, also beides getrennt
aufbewahren (Passphrase im Passwortmanager). Die Sicherung ist ein Schnappschuss:
nach neuen Kalendern oder Tokens eine neue ziehen. Den Lesestapel nimmt sie als
konsistente Kopie der laufenden Datenbank (`VACUUM INTO`) auf, gzip-gepackt. Eine
Sicherung darf bis zu 32 MB groß sein (vorher 8 MB); das reicht gepackt für einige
tausend Artikel. Wird sie größer, lehnt das Cockpit ab, dann hilft nur das Host-Backup.

Nach einem Verlust von `/data`:

1. Leeres `data` anlegen und uid 1000 geben (wie bei der Einrichtung). `.env`,
   Policy und Pocket ID bleiben, wie sie sind.
2. `docker compose up -d`, im Web-Cockpit anmelden. Das Cockpit ist jetzt
   **leer**: keine Einstellungen gespeichert, keine API-Tokens. Die
   Einstellungsseite weist dann auf die Sicherung hin.
3. **Einstellungen → Sicherung → Wiederherstellen**: Datei wählen, Passphrase
   eingeben. In ein leeres Cockpit geht das direkt; ist schon etwas eingestellt,
   nur mit dem Haken „Vorhandenes ersetzen“. Erst wird die ganze Sicherung
   geprüft, dann jede Datei atomar und nur für den Dienst lesbar geschrieben;
   was die Sicherung nicht enthält, bleibt liegen.
4. Das Cockpit fährt danach herunter und wird von Docker neu gestartet
   (`restart: unless-stopped` wie in `docker-compose.example.yml`; ohne diese
   Regel den Container von Hand starten). Weil das Sitzungs-Secret aus der
   Sicherung kommt, gilt die Anmeldung nicht mehr: neu anmelden. Das
   Wiederherstellen zählt außerdem die Generation von „Überall abmelden“ hoch,
   damit Sitzungen, die seit der Sicherung beendet wurden, nicht zurückkommen;
   jedes Gerät meldet sich also einmal neu an. Kalender,
   Zunder, Mail, Brücke und Kurzbefehle laufen mit dem alten Stand weiter,
   Index und Vektoren baut das Cockpit im Hintergrund neu auf.

### Sync

Den Vault-Ordner hält der Sidecar `vault-sync` aktuell: [Obsidian Headless](https://www.npmjs.com/package/obsidian-headless)
(`ob sync --continuous`) in einem eigenen Image `ghcr.io/rubenvitt/vault-cockpit-sync`,
dessen Tag die gepinnte Client-Version ist (`sync/Dockerfile`). Er teilt sich den
Vault-Ordner mit dem Cockpit und schreibt nebenbei eine Statusdatei. Das Cockpit
beobachtet den Ordner, liest geänderte Notizen einzeln neu ein und zeigt den Zustand
des Syncs in `vault_stats` (`synced`, `syncing`, `error`, `stale` …, letzter Abgleich,
letzter Fehler).

Einmalig:

1. Anmelden, das Token landet in `./sync-config`:
   `docker compose run --rm -it --entrypoint ob vault-sync login`
   (alternativ `OBSIDIAN_AUTH_TOKEN` in `sync.env` setzen).
2. Den Namen des Remote-Vaults nachsehen
   (`docker compose run --rm --entrypoint ob vault-sync sync-list-remote`) und als
   `VAULT_NAME` in `sync.env` eintragen. Beim ersten Start verknüpft der Sidecar
   den Ordner mit diesem Vault; danach ist `VAULT_NAME` ohne Wirkung.

**Umstieg vom Sync auf dem Host:** Es darf nur ein Sync pro Ordner laufen. Erst den
Host-Dienst stoppen und abschalten, dann den Sidecar starten:

```bash
systemctl --user disable --now obsidian-sync
docker compose up -d vault-sync
docker compose logs -f vault-sync   # bis „Fully synced“
```

Obsidian Headless sperrt den Ordner zusätzlich über `.obsidian/.sync.lock`; ein
zweiter Client auf demselben Ordner bricht mit „Another sync instance is already
running“ ab. Der Sidecar legt eine eigene Sync-Verknüpfung an, der erste Abgleich
vergleicht deshalb den ganzen Ordner (Konflikte nach `CONFLICT_STRATEGY`, Standard
`merge`).

**Client aktualisieren:** `OBSIDIAN_HEADLESS_VERSION` in `sync/Dockerfile` anheben.
Nach dem Merge baut CI das Image mit der neuen Version als Tag; danach den Tag in
der Compose-Datei des Servers nachziehen.

### Capture

Alles, was von außen kommt, landet an einer Stelle: als neue Notiz im
Capture-Ordner (`CAPTURE_FOLDER`) oder, mit `!` am Anfang, als Aufgabe in der
**Zunder-Inbox**. Aufgaben legt das Cockpit nicht selbst ab, es leitet sie an
Zunder weiter (MCP-Werkzeug `create_task`). Dafür in der Zunder-Web-UI unter
**Tokens** einen API-Token anlegen (Name z. B. `vault-cockpit`) und im Cockpit
unter **Einstellungen → Zunder** eintragen. Ein Eingangs-Token (`zi_…`) reicht
nicht, Eingänge schreiben nur in ein festes Projekt.

Eine Notiz ohne eigenen Titel heißt nach Quelle und Zeitpunkt
(`2026-10-13 1430 - Sprachmemo.md`, Titel „Sprachmemo, 13.10.2026 14:30“), der
erfasste Text steht vollständig im Inhalt. Einen Titel setzen nur ein
ausdrückliches `title`, der Mail-Betreff und der Dateiname aus Funke. Bei
Aufgaben mit `!` bleibt die erste Zeile der Titel.

**Fälligkeit und Ziel gleich mitgeben.** Am Ende der Titelzeile einer Aufgabe
(Schnelleingabe, Kurzbefehl, Sprachmemo, Mail-Betreff) versteht das Cockpit ein
paar Kürzel und nimmt sie aus dem Titel:

```text
!Zahnarzt anrufen morgen #gesundheit   → „Zahnarzt anrufen“, fällig morgen, Bereich Gesundheit
!Bericht abgeben bis Freitag #vcp      → fällig am nächsten Freitag, Projekt mit Schlüssel VCP
!Folien bauen +woche                   → Phönix-Schritt der laufenden Woche
```

| Kürzel | Bedeutung |
|---|---|
| `heute`, `morgen`, `übermorgen` | Fälligkeit; `morgen` nur klein geschrieben („Morgen“ kann der Morgen sein) |
| `Montag` … `Sonntag` | das nächste Vorkommen **ab morgen**: am Montag ist „Montag“ der Montag in einer Woche, für heute gibt es `heute` |
| `14.10.`, `14.10.2026`, `14.10.26` | Datum; ohne Jahr dieses Jahr, liegt der Tag schon zurück, das nächste |
| `bis …`, `am …` | `bis` vor jeder Fälligkeit und `am` vor Wochentag oder Datum fallen mit weg („bis Freitag“, „am 20.10.“) |
| `#name` | Bereich oder Projekt aus Zunder, unscharf: gleicher Name oder Projektschlüssel, Anfang des Namens oder eines Wortes darin, ein Tippfehler (ab 5 Zeichen, ab 9 zwei). Groß/klein und Umlaute egal, `-` trennt Wörter (`#gruppe-ik`). `#bereich #projekt` zusammen ergibt das Projekt. |
| `+woche` | Phönix-Schritt der laufenden ISO-Woche |

Die Regel gegen Fehldeutungen: Erkannt wird nur am **Ende der Titelzeile**, von
hinten, solange die Wörter Kürzel sind; das erste Wort bleibt immer Titel. „Termin
für morgen vorbereiten“ bleibt also, wie es ist. Auch am Ende bleibt eine
Datumsangabe Text, wenn ein Wort davor sie zum Satzteil macht („für morgen“,
„ab Montag“, „jeden Freitag“, „am morgen“). Zwei Fälligkeiten („Freitag morgen“)
setzen keine. Passt ein `#name` zu keinem oder zu mehreren Zielen, wird nicht
geraten: Es bleibt im Titel, die Aufgabe kommt in die Zunder-Inbox und die
Meldung sagt warum. Ohne Kürzel ist alles wie bisher. Notizen (ohne `!`) bleiben
immer unverändert. „Heute“ und die laufende Woche gelten in der Zeitzone aus den
Einstellungen (Standard Europe/Berlin). Die Bereiche und Projekte fragt das
Cockpit nur bei einem `#name` ab und merkt sie sich eine Minute; ist Zunder dafür
nicht erreichbar, entsteht die Aufgabe trotzdem, in der Inbox.

| Weg | So geht's |
|---|---|
| iOS-Kurzbefehl | Unter **Einstellungen → API-Tokens** einen Token mit dem Recht **Capture** anlegen, dann „Notiz ins Cockpit“ unter **Einstellungen → Kurzbefehle** laden und importieren und beim Import den Token eintragen. Läuft aus dem Share-Sheet oder fragt den Text ab. Von Hand: `POST <PUBLIC_URL>/capture?source=ios-kurzbefehl` mit dem Text als Body, Header `Authorization: Bearer vct_…` |
| Sprachmemo | „Sprachmemo ins Cockpit“ ebenso aus den Einstellungen importieren: „Audio aufnehmen“, „Audio transkribieren“, dann wie oben mit `source=sprachmemo`. Transkribiert wird auf dem Gerät, das Cockpit bekommt nur Text. |
| Funke | Als Relay-URL `<PUBLIC_URL>/funke` und als Relay-Token einen Capture-Token eintragen. Notizen landen im Capture-Ordner (der Ordner aus der App wird ignoriert), Aufgaben schickt Funke weiter direkt an Zunder. |
| Mail | Unter **Einstellungen → Mail** Fastmail-API-Token und freigegebene Absender eintragen. Eine Adresse (Alias) anlegen und per Regel in den Ordner zum Abholen sortieren (Standard `Vault`). Betreff = Titel, `!` im Betreff = Aufgabe. Verarbeitete Mails wandern in die Ablage (Standard `Archive`). |

`POST /capture` nimmt Klartext oder JSON `{"text", "title"?, "source"?, "id"?}`.
Mit `id` ist das Anlegen idempotent (dieselbe ID → `200` mit dem Ergebnis von
damals; erlaubt sind Buchstaben, Ziffern und `_ . : -`, höchstens 128 Zeichen). Antworten: `201 {"kind":"note","path"}` bzw.
`201 {"kind":"task","id","ref","url","title","due","location","phoenix","notes"}`, `400` bei falscher Eingabe, `401` ohne
gültigen Token, `502` wenn Zunder ablehnt, `503` bei `!` ohne Zunder.
Jede Antwort trägt zusätzlich `message`, einen fertigen Satz für die Mitteilung
(bei Aufgaben mit Ziel und Fälligkeit, z. B. „Aufgabe ZUN-12 liegt in Gesundheit,
fällig morgen.“, und dem Grund, wenn ein Kürzel nicht passte), und
Fehler ihren `status` im Body (`{"error","status","message"}`), weil ein Kurzbefehl den
HTTP-Status nicht sieht.

### Suche

`GET <PUBLIC_URL>/api/search?q=…` mit Header `Authorization: Bearer vct_…`
durchsucht den Vault für Clients ohne OAuth, nur lesend und nur in eigenen Notizen
ohne vertrauliche Ordner. Parameter: `q` (Pflicht), `mode` (`hybrid` Standard oder
`semantic`), `folder`, `type` (Frontmatter-`type`, z. B. `synthesis`), `limit` (Standard 10, höchstens 50), `offset`. Antwort:
`200 {"results":[{"path","title","streams","similarity","score",…}],"total","hasMore","degraded"}`,
Pfade relativ zum Vault mit `/`. `400` bei falscher Eingabe, `401` ohne gültigen Token. Den Token im Web-Cockpit
unter **Einstellungen → API-Tokens** anlegen; er wird nur einmal angezeigt, gespeichert
ist nur sein Hash (`api-tokens.json` neben den Cockpit-Einstellungen). Widerrufen geht dort auch.
`GET /capture` ist ein Verbindungstest.

**Kurzbefehle neu bauen:** `node scripts/kurzbefehle/build.js [--url <PUBLIC_URL>]`
schreibt die unsignierten Dateien nach `assets/kurzbefehle/unsigniert/`. iOS
importiert nur signierte Kurzbefehle, deshalb danach auf einem Mac
`scripts/kurzbefehle/sign.sh` laufen lassen (`shortcuts sign --mode anyone`); die
signierten Dateien landen in `assets/kurzbefehle/`, von dort liefert das Cockpit sie unter `/kurzbefehle/<name>.shortcut` aus. Der Token steht in keiner der
Dateien, iOS fragt ihn beim Import ab.

Capture-Tokens (`vct_…` mit dem Recht **Capture**) können nur anlegen, nicht
suchen oder lesen; Such-Tokens kommen umgekehrt nicht an `/capture`. Ohne
Capture-Token (und ohne `CAPTURE_TOKEN` aus älteren Deployments) lehnen `/capture`
und `/funke` jede Anfrage mit `401` ab.

Mail-Abruf: Nur freigegebene Absender (Einstellungen → Mail) werden zu Notizen oder
Aufgaben. Mails anderer Absender landen im Eingang des Lesestapels (so kommen direkt
abonnierte Newsletter an); ist der Lesestapel aus, wandern sie unverarbeitet in den
Ablage-Ordner. Ein Eintrag mit
führendem `@` (z. B. `@rubeen.dev`) gibt jede Adresse dieser Domain frei, aber
keine Subdomain. Der Absender einer Mail lässt sich fälschen; die Adresse deshalb
nicht weitergeben. Mit ganzen Domains wird die Annahme breiter, also die
Alias-Adresse erst recht geheim halten. Den API-Token in
Fastmail unter *Einstellungen → Passwörter & Sicherheit → API-Tokens* mit
Zugriff nur auf Mail anlegen.

**Zunder-Brücke:** Eine offene Checkbox mit dem Tag `#zunder` wird eine Aufgabe
in der Zunder-Inbox. Die Aufgabe verweist auf die Notiz (`vault_links`, Wikilink
und optional „In Obsidian öffnen“), in der Notiz ersetzt ein Link auf die
Aufgabe den Tag:

```markdown
- [ ] Angebot schreiben #zunder
- [ ] Angebot schreiben [↗ Zunder](https://zunder.example/#/aufgabe/…)
```

Die Brücke prüft geänderte Notizen sofort und alle Notizen mit dem Tag beim Start
und im Reindex-Intervall. Vertrauliche Ordner, Readwise-Importe und Codeblöcke
bleiben außen vor.

Zurück geht es im selben Takt (Start und Reindex-Intervall): Ist die verlinkte
Aufgabe in Zunder erledigt, wird die Checkbox abgehakt (`- [x]`); ist sie
verworfen, wird sie als abgebrochen markiert (`- [-]`, wie im Tasks-Plugin).
Gezählt werden nur Links auf die eingestellte Zunder-Adresse.

Andersherum erledigt Abhaken im Vault die Aufgabe in Zunder (`- [x]` → erledigt,
`- [-]` → verworfen), ebenfalls spätestens nach einem Intervall. Die Brücke
merkt sich dafür je Notiz und Aufgabe die zuletzt gesehene Checkbox (im
Merkzettel unter `/data`) und meldet nur den Wechsel von offen zu geschlossen.
Wer eine Aufgabe in Zunder wieder öffnet, während die Checkbox noch abgehakt
ist, behält sie offen. Checkboxen, die die Brücke zum ersten Mal schon abgehakt
sieht (etwa nach dem Update), gelten nicht als Wechsel.

### Web-Cockpit

Unter `<PUBLIC_URL>/` liegt die Wochenansicht, gebaut um die Woche statt um
„Heute“. Oben das **Feuer-Ziel** aus der Feuer-Notiz der Woche (Frontmatter
`type: 1-wochen-feuer`, `zeitraum` ab Montag, Abschnitt „## Feuer-Ziel“) und die
**Flammen** der Woche aus Zunder, mit den dort gemessenen Zeiten. Darunter die
**Big Rocks** je Lebensbereich: Zunder-Aufgaben, die in der Woche fällig oder als
Phönix-Schritt der Woche markiert sind, gruppiert nach Zunder-Bereich. Es folgen
die **Termine** der Woche aus allen eingestellten Kalendern, **Aufgaben** in
Arbeit oder überfällig und die **Inbox** (Ordner im Vault und Zunder-Inbox). Mit
`?woche=2026-W43` blättert man; dieselben Daten gibt es als JSON unter `/api/woche`.

Einrichtung:

1. In Pocket ID einen OIDC-Client anlegen, Callback `<PUBLIC_URL>/auth/callback`,
   und wie beim CIMD-Client auf die eigene Gruppe beschränken.
2. Im Deployment `WEB_CLIENT_ID` und `WEB_CLIENT_SECRET` setzen (bei einem
   öffentlichen Client mit PKCE bleibt das Secret leer). Zugang haben dieselben
   `ALLOWED_SUBJECTS` wie bei MCP.
3. Anmelden und unter **Einstellungen** (`/einstellungen`) die Kalender eintragen.
   Beliebig viele, je als **iCal-Abo** (die geheime `.ics`-Adresse eines
   Kalenders, `webcal://` geht auch; Serientermine löst das Cockpit selbst auf)
   oder als **CalDAV** (Kalender-Home oder einzelner Kalender, mit Benutzer und
   App-Passwort; optional nur bestimmte Kalender). Daneben Zeitzone, Vault-Name
   für „In Obsidian öffnen“ und der Inbox-Ordner.

   Außerdem: Zunder-Zugang, Zunder-Brücke (an/aus, Tag), Flammen in der Feuer-Notiz
   (an/aus), Mail-Abruf (Fastmail-Token, freigegebene Absender, Ordner, Abstand),
   Embeddings (Ollama-Adresse, Modell), Dauer der Anmeldung samt „Überall
   abmelden“ und unter **API-Tokens** die Tokens für Suche und Capture.

Der Zunder-Zugang aus den Einstellungen gilt für das ganze Cockpit:
Wochenansicht, `!`-Capture (Kurzbefehl, Mail, Funke), Zunder-Brücke und Graph.
Alles auf der Seite wirkt ohne Neustart: Die Brücke ruht ohne Zugang oder wenn sie
aus ist und legt los, sobald beides passt; Mail-Abruf und Embeddings starten mit
dem neuen Stand neu. Woher der Zugang kommt, zeigen Startlog und `vault_stats`.
Leere Felder gelten als Standard, bei älteren Deployments aus der Umgebung (siehe
[Betrieb](#betrieb)).

Gespeichert wird in `/data/cockpit-settings.json` (nur für den Dienst lesbar).
Passwörter, Tokens und Kalenderadressen zeigt die Seite nie wieder an; ein leeres
Feld behält den gespeicherten Wert. Das Secret für das Sitzungs-Cookie liegt in
`/data/session-secret` und entsteht beim ersten Start (alternativ `SESSION_SECRET`).
Wie man diese Dateien sichert und wiederherstellt: [Sicherung von `/data`](#sicherung-von-data).

**Handeln statt nur schauen:** Aufgaben in Flammen, Big Rocks, Aufgaben und
Zunder-Inbox hakt man direkt ab (Zunder-Status `done`, ein zweiter Klick öffnet
sie wieder, die Meldung bietet „Rückgängig“). Das Menü `⋯` an jeder Aufgabe
setzt den Status (in Arbeit, blockiert, offen) und verschiebt die Fälligkeit
(heute, morgen, nächste Woche = Montag, ein Datum oder ohne); die Ansicht ordnet
die Aufgabe danach neu ein. Dort markiert man auch einen Phönix-Schritt der
angezeigten Woche. In der Zunder-Inbox kommt **Zuordnen** (Bereich, Projekt oder
„Lose“) und **Verwerfen** dazu, sodass sich die Inbox im Cockpit auf null bringen
lässt. Auf dem iPhone öffnet sich das Menü als Leiste von unten. Flammen und
Big Rocks haben einen **Flammen-Knopf**: Er startet einen Deep-Work-Block in
Zunder (und Timing, falls dort angebunden); solange eine Flamme brennt, steht
oben eine Leiste mit Timer und „Stopp“. Notizen der Vault-Inbox öffnen sich als
**Vorschau** im Cockpit (`/notiz?pfad=…`, Obsidian-Link daneben): Checkboxen
abhaken, Tags setzen, Text anhängen und in einen Ordner **ablegen** (Vorschläge
aus dem Index, Eingabe frei) oder mit einem Klick ins Archiv (der oberste Ordner
namens `archiv`, auch `40-archiv`). Vertrauliche und ausgeschlossene Ordner der
Policy zeigt das Cockpit weder an noch nimmt es sie als Ziel. Die Vorschau
taugt auch zum Lesen im ganzen Vault: Wikilinks (über Pfad, Dateiname oder
Alias aus `aliases`, auch `[[Notiz#Überschrift]]`) führen zur nächsten
Notizseite, nicht auflösbare oder vertrauliche Ziele stehen als „fehlt“ da.
Unter der Notiz stehen **Verweist hierher** (Backlinks) und **Ähnlich** (aus den
Embeddings, ohne sie per Volltext). Bilder (`![[bild.png]]`, `![](anhang/bild.png)`;
PNG, JPEG, GIF, WebP, AVIF, kein SVG) liefert `/notiz/bild?pfad=…` nur angemeldet
und nie aus vertraulichen, ausgeschlossenen oder versteckten Ordnern oder über
Symlinks aus; Bilder von außen lädt die Vorschau nicht, sie werden ein Link.
Tabellen und Callouts (`> [!note]`, aufklappbar mit `+`/`-`) werden dargestellt,
das Frontmatter steht eingeklappt in einer Zeile. Bei Inbox-Notizen schlägt
das Cockpit oben im Verarbeiten-Bereich **Tags** (häufig bei den ähnlichsten
Notizen), die drei wahrscheinlichsten **Zielordner** (Mehrheit der ähnlichsten
Notizen) und ähnliche, noch nicht verlinkte Notizen zum **Verlinken** vor; ein
Klick übernimmt einen Vorschlag, „Alle übernehmen“ und ein Ordner reichen also
zum Taggen und Ablegen. Ohne Embeddings kommen die Vorschläge aus dem Volltext
(mit Hinweis), vertrauliche Ordner und die Inbox selbst sind nie dabei, der Tag
der Zunder-Brücke auch nicht. Feuer-Ziel und
Ersten Zug der Feuer-Notiz bearbeitet man direkt im Wochenblick (✎ neben dem
Text, ersetzt den ersten Absatz unter der Überschrift). Fehlt die Feuer-Notiz
einer Woche, legt **Feuer anlegen** sie mit Feuer-Ziel und (optional) Erstem Zug
an: im Ordner und Feuersturm der letzten Feuer-Notiz, Wochennummer und Dateiname
weitergezählt, mit leeren Tabellen für Schritte und Flammen. Nach W12 legt das
Cockpit keine an, dann gehört ein neuer Feuersturm in Obsidian geplant. Der **Wochenrückblick**
unter `/rueckblick` (in der Navigation, `?woche=` für frühere Wochen) zeigt je
Bereich, was erledigt war und was geplant war (Phönix-Schritte und in der Woche
Fälliges), was außerdem erledigt wurde, die Flammen-Zeit der Woche und was offen
blieb.

**Wissen:** `/wissen` sucht mit einer Frage in den Synthesen (Frontmatter
`type: synthesis`, Hybrid-Suche mit Typfilter; `/api/suche` kennt `type` auch),
filtert nach Querverbindung (`art`) und Status (z. B. Entwurf) und listet die
zuletzt bewegten nach `updated`; alles über ein GET-Formular ohne JavaScript.
Eine Synthese zeigt auf ihrer Notizseite oben die Zusammenfassung (`summary`),
Art, Status und Vertrauen (`confidence`), die Thesen (H2-Überschriften als
Sprungmarken) und die offenen Punkte (`[TODO …]` im Text und offene Einträge
unter „Offene Punkte“). **Als Aufgaben nach Zunder** legt sie in der
Zunder-Inbox an; ein Merkzettel (`capture-state.json`) hält je Notiz und Punkt
die Aufgabe fest, ein zweiter Klick legt also nichts doppelt an. Ohne
Zunder-Zugang fehlt der Knopf.

**Aus dem Lesestapel passt dazu:** Unter einer Synthese stehen bis zu fünf
Markierungen, die seit ihrem `updated` (sonst seit der letzten Änderung der
Datei) entstanden sind und inhaltlich passen: Kosinus zwischen der Markierung
und dem ähnlichsten Abschnitt der Synthese im semantischen Index, mindestens
0,6. Schon verlinkte Markierungen (`#^hl-…` in der Synthese) kommen nicht
wieder. **Als Beleg anhängen** schreibt nur in den generierten Bereich
`aus-dem-lesestapel` unter „## Aus dem Lesestapel“ (legt die Überschrift
notfalls am Ende an): je Beleg das Zitat, darunter `[[lesestapel-notiz#^hl-…]]`
und die Quelle; die Lesestapel-Notiz entsteht dabei notfalls. Bestehende
Einträge bleiben, „Rückgängig“ nimmt den Eintrag wieder heraus. Hat der Sync die
Synthese gerade geändert, kommt eine Meldung und nichts wird geschrieben. Ohne
Embeddings fehlt der Kasten. Auf `/wissen` zeigt **Passt zu meinem Lesen** nur
die Synthesen unter den 20 zuletzt bewegten, zu denen es solche Markierungen
gibt.

**Flammen in der Feuer-Notiz:** Das Cockpit trägt die Flammen der Woche aus
Zunder in den Abschnitt „## Flammen“ der Feuer-Notiz ein (Tag, Flamme mit Link,
geplanter Tag aus der Fälligkeit, gemessene Minuten, Status), damit Obsidian
und Claude über MCP die Zahlen sehen. Das passiert nach Start oder Stopp einer
Flamme im Cockpit und im Reindex-Intervall (laufende und vorige Woche, also
auch für Flammen, die in Zunder oder per MCP gestoppt wurden). Geschrieben wird
nur zwischen den Markern `<!-- cockpit:flammen:start … -->` und
`<!-- cockpit:flammen:ende … -->` und nur, wenn sich etwas geändert hat. Fehlen
die Marker, kommen sie ans Ende des Abschnitts; was dort schon steht, bleibt.
Der Endmarker trägt eine Prüfsumme: Wer im Bereich von Hand schreibt, hält das
Cockpit davon ab, ihn zu überschreiben (zum Neuschreiben den Bereich zwischen
den Markern leeren). Ändert der Sync die Notiz gleichzeitig, bricht der
Schreibvorgang ab und der nächste Lauf versucht es wieder. Ohne Feuer-Notiz der
Woche legt das Cockpit keine an, in vertraulichen Ordnern schreibt es nicht.
Abschalten unter **Einstellungen → Feuer-Notiz**.
Die Marker-Mechanik ist allgemein (`src/vault/generated-section.js`, „generierter
Bereich“ `<!-- cockpit:<name>:start -->` … `<!-- cockpit:<name>:ende <prüfsumme> -->`)
und taugt auch für andere Notizen, etwa die des Lesestapels.

**Woche planen** (`/planen?woche=…`, verlinkt als „Woche planen“ bei den Big
Rocks und „Einplanen“ bei den Flammen): Zunder-Aufgaben per Volltext oder
Kennung (`VCP-47`) suchen, nach Bereich filtern oder alle offenen eines Bereichs
auflisten, Dev-Projekte bleiben außen vor. **Holen** macht eine Aufgabe zum
Phönix-Schritt der Woche oder setzt ihre Fälligkeit auf einen Tag der Woche;
danach steht sie unter ihrem Bereich in den Big Rocks. Je Bereich der Big Rocks
zeigt die Seite bis zu fünf offene Aufgaben ohne Termin zum Übernehmen.
**Flamme einplanen** legt eine Zunder-Aufgabe mit Rolle `flamme` für die Woche
an, fällig am gewählten Tag (optional mit Uhrzeit), in einem Bereich oder über
„Als Flamme“ als Unteraufgabe einer bestehenden Aufgabe. **Aus der Woche**
entfernt die Phönix-Markierung (auch im Menü einer Flamme im Wochenblick). Jede
dieser Aktionen bietet „Rückgängig“; eine neu eingeplante Flamme wird dabei
verworfen. Alles sind Formulare, ohne JavaScript mit Weiterleitung.

Oben auf der Seite liegt eine
**Schnelleingabe** mit derselben Logik wie `/capture`: Text wird eine Notiz im
Inbox-Ordner, mit `!` vorne eine Aufgabe in der Zunder-Inbox (oder mit den Kürzeln
aus [Capture](#capture) gleich im Bereich, mit Fälligkeit). Unter dem Feld steht
bei einer Aufgabe vorab, wo sie landet („Aufgabe · morgen · Gesundheit“), berechnet
vom Server mit derselben Logik (`GET /api/erfassen/vorschau?text=…`, nur angemeldet).
`/` oder `n` springt
hinein, Enter legt an, Shift+Enter macht eine neue Zeile. Beides läuft ohne
Seitenwechsel; ohne JavaScript funktionieren dieselben Formulare mit
Weiterleitung. Schlägt etwas fehl, bleibt die Meldung stehen und der Text im Feld.

**Auf dem iPhone als App:** In Safari „Teilen → Zum Home-Bildschirm“. Das Cockpit
startet dann ohne Browserleiste, mit eigenem Icon und der Navigation als Leiste
unten (Manifest unter `/manifest.webmanifest`, Icons unter `/static/icons/`).
Unter Android bietet Chrome die Installation selbst an; dort führt das Kurzmenü
des Icons direkt in die Schnelleingabe (`/?erfassen=1`). Gestaltung: ein kleines
Design-System ohne Build-Schritt in `src/web/static/cockpit.css` (Tokens für Farben
hell/dunkel, Abstände, Schrift, dazu Bausteine wie Karte, Knopf, Chip, Menü,
Meldung, leerer Zustand und Ladeleiste). Das Stylesheet wird mit Inhalts-Hash
ausgeliefert (`cockpit.css?v=…`), nach einem Deploy lädt der Browser es neu.

**Ohne Netz** (Funkloch, Zug, Flugmodus) öffnet die App trotzdem: Ein Service
Worker (`/sw.js`) hält die App-Hülle (Stylesheet, Skripte, Manifest, Icons und
die Seite `/offline`) und die zuletzt geladene Wochenansicht der laufenden Woche
auf dem Gerät. Ohne Netz zeigt das Cockpit diese Woche mit dem Hinweis „Offline,
Stand von …“, andere Seiten zeigen die App-Hülle. Abhaken, Menüs und alle
anderen Formulare sind dann gesperrt, nur die **Schnelleingabe** geht: Notizen
und `!`-Aufgaben landen in einem Puffer im Browser (IndexedDB), darunter steht
„n Einträge warten auf Netz“. Sobald das Cockpit wieder erreichbar ist (beim
Öffnen, beim Zurückholen der App, sonst alle 30 Sekunden), sendet die Seite den
Puffer über `/aktion/erfassen` nach, mit der ID des Eintrags als Erfassungs-ID:
Kommt eine Antwort nicht an, legt das erneute Senden nichts doppelt an. Ist die
Anmeldung inzwischen abgelaufen, bleiben die Einträge stehen und gehen nach dem
nächsten Login raus. Was der Server ablehnt (z. B. Zunder antwortet nicht),
bleibt mit Fehler in der Liste, bis man es erneut sendet, ins Feld zurückholt
oder verwirft. Notizvorschau, Suche, Einstellungen und die JSON-Schnittstellen
speichert der Service Worker nie; Abmelden und jeder neue Login löschen die
gespeicherte Woche (der Puffer bleibt und geht mit der nächsten Anmeldung raus).

**Offline lesen** (VCP-80): Neben der Woche darf genau dieser Lesestoff auf dem
Gerät liegen, und nichts sonst: die nächsten 30 Artikel des Stapels (Reihenfolge
wie „Passt jetzt“, mit Lesetext und Markierungen), die Synthesen aus
`wiki/synthesis` (`type: synthesis`, höchstens 200, zuletzt bewegte zuerst) und
die Listen `/lesen/stapel` und `/wissen`. Andere Notizen, Eingang, Archiv und
alles aus vertraulichen oder ausgeschlossenen Ordnern bleiben draußen. Die Liste
liefert `GET /api/lesen/offline` (nur angemeldet), gefiltert nach derselben
Policy wie `/notiz`; der Service Worker speichert davon nur Seiten, die er als
Leseansicht, Synthese oder Liste erkennt und die der Server mit
`x-cockpit-offline: lesen` ausliefert. Die Seite bittet ihn beim Öffnen, beim
Zurückholen der App und beim Wiederverbinden darum, höchstens alle zehn Minuten;
er holt nur, was fehlt oder älter als einen Tag ist, und löscht, was nicht mehr
auf der Liste steht. Wer einen gespeicherten Artikel mit Netz öffnet, frischt ihn
auf. Eine Synthese zeigt auch Titel und Pfade verlinkter oder ähnlicher Notizen
(wie online), deren Inhalt nicht. Ohne Netz gehen in der Leseansicht
**Markieren, Notizen, Fortschritt und die Entscheidungen** (Fertig, weg · In den Vault) in denselben Puffer wie die
Schnelleingabe; wartende Markierungen sind gestrichelt unterlegt. Jede neue
Markierung bekommt auf dem Gerät eine ID, die der Server als ihre ID übernimmt
(`cid` bei `/aktion/lesen/markierung/neu`): Dieselbe ID legt nie eine zweite an.
Fortschritt, Status und Notiz gelten mit dem letzten Stand. Das CSRF-Token holt
sich das Nachsenden wie bei der Schnelleingabe frisch von `/api/sitzung`, und nur
mit Netz. Abmelden, jeder neue Login und eine abgelaufene Sitzung löschen den
Lesestoff zusammen mit der Woche (beide liegen im selben Cache).

Nach einem Deploy bringt `/sw.js` eine neue Cache-Version mit (Inhalts-Hash der
App-Hülle) und räumt die alte weg.

Fällt eine Quelle aus (Zunder nicht erreichbar, ein Kalender antwortet nicht),
zeigt nur ihr Abschnitt bzw. nur dieser Kalender den Fehler; die Einstellungsseite
zeigt je Kalender, ob er erreichbar ist. Die Sitzung gilt nur für das Web-Cockpit;
`/mcp` nimmt weiter ausschließlich Bearer-Tokens. Alle Formulare, auch
Einstellungen und API-Tokens, verlangen das CSRF-Token der Sitzung.

**Angemeldet bleiben:** Jede Nutzung verlängert die Sitzung (das Cookie wird
höchstens stündlich erneuert). Sie endet erst nach 30 Tagen ohne Nutzung oder
spätestens 90 Tage nach dem Login; wer das Cockpit mindestens einmal im Monat
öffnet, meldet sich also höchstens alle drei Monate bei Pocket ID an. Beide
Dauern lassen sich unter **Einstellungen → Anmeldung** ändern (leer = Standard,
eine kürzere wirkt sofort). Dort beendet **Überall abmelden** alle Sitzungen auf
allen Geräten, auch die eigene: Die Einstellungen zählen eine Generation hoch,
die in jedem Sitzungs-Cookie steht. Läuft die Sitzung ab, während man ohne
JavaScript etwas abschickt, geht es über den Login zurück auf dieselbe Seite;
der Text aus Schnelleingabe oder „Anhängen“ steht dann wieder im Feld (15
Minuten lang, verschlüsselt in einem Cookie, nie in einer URL). Ist er dafür zu
lang, zeigt die Seite ihn zum Kopieren.

**Zustand der Dienste:** Die Seite `/zustand` (aus **Einstellungen → Zustand der
Dienste**) zeigt je Hintergrunddienst, ob er läuft, einen Fehler meldet oder aus
ist, mit letztem erfolgreichem Lauf und letztem Fehler samt Zeitpunkt und Text:
Sync (Status, letzter Abgleich, Lebenszeichen des Sidecars), Index (Notizen,
letzter Aufbau), Embeddings (Modell, Fortschritt), Mail-Abruf, Zunder-Brücke (neue
Checkboxen und Abgleich getrennt), Zunder-Zugang (nimmt Zunder den Token an?) und
Kalender (je Kalender) und Feeds (je Feed). Die Daten sind dieselben wie in `vault_stats`; Mail-Abruf,
Brücke, Kalender und Zunder-Zugang merken sich ihren letzten Lauf im Speicher, nach
einem Neustart also erst ab dem nächsten Lauf. Beim Laden der Seite werden Zunder
und Kalender einmal frisch geprüft. Fehlertexte erscheinen maskiert: Adressen nur
mit Host, Tokens und Passwörter als `•••`. Meldet ein Dienst einen Fehler (etwa
Sync `error`/`stale` oder ein gescheiterter Mail-Abruf), steht in der Kopfzeile der
Wochenansicht ein roter Punkt „Störung“ mit Link auf die Seite.

Für ein externes Monitoring liefert `GET /health` (ohne Login) `{"status":"ok"}`
oder `{"status":"degraded"}`, beides mit HTTP 200, damit der Docker-Health-Check
das Cockpit nicht neu startet, wenn der Fehler draußen liegt (Sidecar, Zunder,
Fastmail). Wer bei `degraded` anschlagen will, prüft den Text oder ruft
`/health?strict=1` auf, das dann mit 503 antwortet. Welcher Dienst betroffen ist,
steht nur auf `/zustand`.

### Lesen

Der Lesestapel ist ein Bereich im Cockpit (VCP-77): **Lesen** in der Kopfzeile
und in der Leiste unten, darunter **Eingang · Stapel · Markiert · Wiedersehen · Wissen · Feeds**. In der
Leiste unten nimmt „Lesen“ den Platz der Suche ein; die Suche erreicht man dort
über Lesen → Wissen → „Ganzen Vault durchsuchen“, im Kopf steht sie weiter.

Im **Eingang** (`/lesen/eingang`) speichert ein Formular eine Adresse: Das Cockpit
holt die Seite, macht mit Readability den Lesetext daraus und legt ihn mit Titel,
Quelle, Autor, Auszug und Lesezeit (220 Wörter pro Minute) ab. Dieselbe Adresse
oder ein doppelt abgeschicktes Formular legt nichts Neues an. Gespeichert wird in
`/data/lesestapel.db` (SQLite wie der Index, aber nicht neu baubar, deshalb in der
[Sicherung](#sicherung-von-data)). Das Schema enthält schon Status, Fortschritt,
Markierungen mit Textanker, Feeds und Rückgängig-Spur für die folgenden Ausbaustufen.

Das Holen ist gegen SSRF geschützt: nur `http`/`https`, keine Zugangsdaten in der
Adresse, und jede Adresse wird nach der DNS-Auflösung geprüft, auch nach jeder
Weiterleitung (höchstens 5). Abgelehnt werden Loopback, private Netze, Link-Local
(samt Metadaten-IP `169.254.169.254`), CGNAT, Multicast und reservierte Bereiche,
für IPv6 `::1`, `::`, `fc00::/7`, `fe80::/10` und IPv4-mapped Adressen. Verbunden
wird genau mit der geprüften IP (eigene `lookup`-Funktion), DNS-Rebinding läuft
damit ins Leere. Höchstens 5 MB und 15 Sekunden je Artikel.

Der Artikeltext wird streng nach Allowlist gesäubert (`sanitizeHtml` in
`src/lesen/extract.js`, auch für Mails und Feeds gedacht): kein Skript, kein Stil,
keine Frames, keine Event-Attribute, Links nur `http`, `https` und `mailto`.
Bilder und Videos werden zu Links, die Content-Security-Policy lädt weiter nichts
von fremden Servern.

Die **Leseansicht** (`/lesen/doc?id=…`, VCP-71) zeigt den Text in Leseschrift mit
Fortschritt, Restzeit und der Entscheidung nach dem Lesen (ohne JavaScript als Formular). Mit
JavaScript (`/static/lesen-doc.js`) speichert sie die Lesestelle beim Scrollen;
`#weiter` springt dorthin. Markiert wird per Textauswahl über eine Leiste unten
(Markieren · Notiz · Verbinden · In Inbox), am iPhone also nicht im Weg des
Systemmenüs. Eine Markierung merkt sich Zitat, etwas Text davor und danach und die
ungefähre Stelle (`src/lesen/anchor.js`). So sitzt sie auch nach erneutem Holen
oder Umformatieren wieder richtig. Eingesetzt werden die Markierungen beim
Ausliefern als `<mark>` nur um Textstücke. „In Inbox“ legt das Zitat mit Quelle
über die Schnelleingabe als Notiz in der Vault-Inbox an. Unter **Markiert** stehen
alle Markierungen, filterbar nach Quelle und Thema.

**Unterwegs hören** (`/lesen/hoeren?zeit=15`, VCP-79, Link auf dem Stapel): Die
Texte des Zeitfensters werden zur Wiedergabeliste. Vorgelesen wird auf dem Gerät
mit der Web Speech API (`speechSynthesis`, deutsche Stimme bevorzugt), ohne
Serverkosten, oder mit ElevenLabs (unten, „Stimme vom Server“). Bedienung: Abspielen/Pause, Nächster Text, Tempo (0,8× bis 1,8×,
im Browser gemerkt) und **Das hier merken**, das den gerade gesprochenen Satz
markiert. Den Text liefert der Server (`/lesen/hoeren/text?id=…`): Lesetext und
Sätze mit Zeichenpositionen wie in `src/lesen/anchor.js`. Nach jedem Satz
speichert die Seite den Anfang des nächsten als Lesestelle; die Leseansicht
springt mit `#weiter` genau dorthin, und das nächste Hören setzt dort fort. Ohne
JavaScript listet die Seite nur die Texte. Das Zeitfenster rechnet mit 220 Wörtern
pro Minute; vorgelesen dauert es oft länger. In der iOS-App (erkannt an
`window.webkit.messageHandlers.cockpit`) zeigt die Seite nur **Abspielen**, und
das schickt `{type: 'hoeren', zeit}` an den nativen Player der App (VCP-94)
statt die Sprachausgabe zu nutzen.

Was über iOS bekannt ist, und was nicht:

- Bekannt aus Berichten, nicht selbst geprüft: Web-Audio und Sprachausgabe einer
  Home-Screen-App hören auf, sobald sie nicht mehr im Vordergrund ist oder der
  Bildschirm sperrt ([WebKit-Bug 198277](https://bugs.webkit.org/show_bug.cgi?id=198277),
  Stand 2019/2020). Selbst nativ pausiert `AVSpeechSynthesizer` laut einem Bericht
  beim Sperren und spricht erst nach dem Entsperren weiter
  ([Apple-Forum](https://developer.apple.com/forums/thread/849627)).
  `speechSynthesis` unterbricht außerdem andere Medien wie Musik oder Podcasts
  ([WebKit-Bug 218815](https://bugs.webkit.org/show_bug.cgi?id=218815)).
- Deshalb hält die Seite beim Abspielen den Bildschirm wach (Screen Wake Lock,
  falls der Browser ihn kennt). Das hilft nur, solange das Gerät nicht gesperrt
  und die App vorn ist. Ob Wake Lock in der Home-Screen-App greift, ist **ungeprüft**.
- Wird die Seite wieder sichtbar und spricht nichts mehr, liest sie den aktuellen
  Satz neu. Weil jeder Satz erst nach dem vorigen angestoßen wird, hört die
  Wiedergabe spätestens nach dem laufenden Satz auf, wenn iOS das Script anhält.
- **Ungeprüft** ist das Verhalten auf aktuellem iOS insgesamt, als Safari-Tab wie
  als Home-Screen-App. Auf dem iPhone prüfen: Bildschirm mitten im Satz sperren
  (spricht es weiter, und geht es nach dem Satz weiter?), App wechseln,
  mit AirPods, Tempo, ob eine deutsche Stimme da ist (Einstellungen →
  Bedienungshilfen → Gesprochene Inhalte → Stimmen) und ob die Leseansicht danach
  an der richtigen Stelle steht.

**Stimme vom Server (ElevenLabs):** Steht unter **Einstellungen → Vorlesen** ein
ElevenLabs-API-Key (oder `ELEVENLABS_API_KEY`, siehe [Betrieb](#betrieb)), liest
ElevenLabs statt des Geräts vor, im Browser und in der iOS-App. Der Server holt
jeden Satz einzeln (`POST /v1/text-to-speech/{voice}`, MP3 44,1 kHz/128 kbit/s,
Satz davor und danach als `previous_text`/`next_text` für den Tonfall) und
liefert ihn über `/lesen/hoeren/audio?id=…&von=…&bis=…` bzw. `/api/app/audio`
aus. `von`/`bis` sind Zeichen im Lesetext wie die Sätze: Vorgelesen wird nur Text
aus dem Stapel, kein beliebiger, und der Key verlässt den Server nie. Jede Antwort
liegt im Cache (`TTS_CACHE_DIR`), ein zweites Hören kostet kein Kontingent. Die
Seite spielt über ein `<audio>`-Element mit Media Session (Sperrbildschirm,
Kopfhörer), lädt den nächsten Satz schon vorab und den ersten beim Öffnen, damit
„Abspielen“ ihn noch im Tipp startet (sonst bleibt iOS stumm). Tempo über
`playbackRate`. Lehnt ElevenLabs ab (Kontingent, Key, Stimme) oder fehlt das Netz,
meldet die Seite das einmal und liest mit der Gerätestimme weiter.

**Folgen** (`/lesen/folgen`, im Stapel „Folge erzeugen“): eine MP3 aus Texten des
Stapels, im Hintergrund erzeugt. Auf `/lesen/folgen/neu?zeit=30` stehen die Texte
des Zeitfensters zum Abhaken, die Art und die geschätzten Zeichen bei ElevenLabs.

- **Vorlesen**: die ganzen Texte nacheinander mit der Stimme vom Vorlesen, je Text
  Titel und Quelle vorweg. Ohne Claude. Satz für Satz mit denselben Anfragen wie
  beim Streamen, also über denselben Cache: Was schon gehört oder in der App
  offline geladen wurde, kostet nichts mehr (die Schätzung rechnet es heraus),
  und was die Folge erzeugt, ist danach beim Streamen gratis.
- **Podcast** (5, 10 oder 20 Minuten): Claude schreibt ein Gespräch, A moderiert,
  B ordnet ein; ElevenLabs spricht es mit Text-to-Dialogue (`eleven_v3`, höchstens
  1800 Zeichen je Anfrage, die Abschnitte hängen in einer MP3 hintereinander).
  Stimmen unter **Einstellungen → Vorlesen → Folgen** (Standard: Moderation = Stimme
  vom Vorlesen, Gast „Sarah“ `EXAVITQu4vr4xnSDxMaL`).
- **Report** (5, 10 oder 20 Minuten): Claude schreibt einen Bericht mit Überblick,
  Kernaussagen je Text, Querverbindungen und offenen Fragen. Er kommt als Notiz
  (mit Quellenliste) über die Schnelleingabe in die Vault-Inbox, und eine Stimme
  liest die Sprechfassung.

Claude läuft über die Claude Code CLI im Container (`claude -p`, im Image
installiert, Version per Build-Arg `CLAUDE_CODE_VERSION`, leer = ohne) mit dem
Abo-Token `CLAUDE_CODE_OAUTH_TOKEN`: keine Werkzeuge (`--tools ""`), `--safe-mode`
(kein CLAUDE.md, keine Hooks, Skills, Plugins oder MCP-Server), leeres
Arbeitsverzeichnis, die Texte über stdin, das Ergebnis als JSON nach
`--json-schema`. Modell unter **Einstellungen → Vorlesen → Folgen**, Standard
`sonnet`, das schont das Abo-Limit. Es entsteht immer nur eine Folge zugleich;
was ein Neustart unterbricht, steht danach als Fehler da (neu anstoßen kostet
noch einmal). Die MP3 kommt mit `Range` (`/lesen/folgen/audio?id=…`), damit Safari
sie spielt und Vorspulen geht.

Kosten: ElevenLabs rechnet nach Zeichen. Ein Text mit 15 Minuten Lesezeit hat
rund 20 000 Zeichen; mit `eleven_multilingual_v2` kostet das 20 000 Credits, mit
`eleven_flash_v2_5` die Hälfte bei etwas weniger natürlicher Betonung. Das Modell
steht unter **Einstellungen → Vorlesen → Stimme und Modell**. Beim Öffnen von
`/lesen/hoeren` holt die Seite schon den ersten Satz, auch ohne Abspielen.

**Wiedersehen** (`/lesen/wiedersehen`, VCP-74) holt Markierungen nach einem
einfachen Leitner-Schema zurück: Box 1 bis 5 mit 1, 3, 7, 21 und 60 Tagen
Abstand, eine neue Markierung ist nach einem Tag dran. Je Karte: **Behalten**
rückt eine Box weiter, **In eigenen Worten** legt Zitat, eigene Worte und Quelle
als Notiz in der Vault-Inbox an und rückt ebenfalls weiter, **Loslassen** nimmt
die Markierung nur aus der Wiederholung (gelöscht wird nichts). Rückgängig steht
in der Meldung, alles geht auch ohne JavaScript. Höchstens 20 Karten am Tag, der
Rest kommt morgen. Darunter die Woche (`?woche=2026-W43`, aus dem
Wochenrückblick verlinkt): Zahlen, Balken je Thema (ohne Thema je Quelle) und
Export als Markdown. Ist ein Embedding-Server eingestellt, bettet das Cockpit die
Markierungen der Woche ein (nur im Speicher) und zeigt ähnliche aus
verschiedenen Texten als „Querverbindung entdeckt“, mit „Als eigene Notiz
anlegen“. Ohne Embedder oder wenn Ollama nicht antwortet, fehlt der Kasten.

Abhängigkeiten dafür: `@mozilla/readability` und `linkedom` (reines JavaScript,
feste Versionen).

**Nach dem Lesen entscheiden** (VCP-96): In der Leseansicht steht
**Fertig, weg** (Taste E) neben **In den Vault** (Taste V) mit dem Häkchen
**mit Volltext** (Standard aus). „Fertig, weg“ setzt den Status `weg` mit
Lesedatum (`read_at`) und schreibt nichts in den Vault; eine schon vorhandene
Notiz bleibt unangetastet. „Weg“ im Eingang hat kein Lesedatum, das Aufräumen
kann beides unterscheiden. „In den Vault“ legt die Lesestapel-Notiz an oder
frischt sie auf, auch ohne Markierungen, mit `lesestatus: gelesen`, `gelesen:`
und der Kurzfassung; mit Häkchen kommt der Artikel als Markdown in einen
eigenen generierten Bereich unter „## Text“ (vor „## Eigene Gedanken“). Der Text
ist dann archiviert (`archiv`). Im Eingang (Knopf, Taste A) und auf dem Stapel
(je Eintrag ein Knopf) gibt es **Im Vault ablegen**: Notiz immer mit Volltext,
`lesestatus: ungelesen` und ohne `gelesen:`; der Text bekommt den Status
`abgelegt` und verlässt Eingang und Stapel. Wer ihn später doch liest und „In den
Vault“ wählt, bekommt `lesestatus: gelesen` und `gelesen:` nachgetragen, der
Volltext bleibt, wie er ist. Alle drei lassen sich rückgängig machen (Status
zurück, im Eingang auch mit Z); eine schon geschriebene Notiz bleibt dabei
stehen. Ohne Netz gehen die Entscheidungen der Leseansicht in den Puffer und
später raus. Das HTML → Markdown macht `htmlToMarkdown` in
`src/lesen/extract.js` über dieselbe Allowlist wie `sanitizeHtml`: Absätze,
Überschriften (zwei Ebenen tiefer, unter „## Text“), Listen, Zitate, Code,
Links, Hervorhebungen und einfache Tabellen; Zeichen, die in Markdown oder
Obsidian etwas auslösen würden (`#`, `[[`, `$`, `==`, `%%` …), sind maskiert.

**Markierungen im Vault** (VCP-75): Der Vault bleibt Quelle der Wahrheit. Wird
ein Text mit Markierungen archiviert, legt das Cockpit über den Editor eine
Notiz an, Standard `30-ressourcen/lesestapel/<slug>.md` (änderbar unter
**Einstellungen → Lesestapel**); Fortschritt 1 allein reicht seit VCP-96 nicht
mehr, das entscheidet „In den Vault“. Ihr Frontmatter hat `type: lesestapel`,
`lesestapel_id`, `quelle`, `url`, `gespeichert`, `lesestatus`
(`gelesen`/`ungelesen`), `gelesen` und `themen`. Jede Markierung steht
als Zitat mit eigener Block-ID (`[[vom-lesen#^hl-1a2b3c4d]]`), darunter Notiz und
Verknüpfungen als Wikilinks:

```markdown
## Markierungen

<!-- cockpit:markierungen:start · aus dem Lesestapel, das Cockpit schreibt bis zum Endmarker neu -->

> Ein Satz, den man sich merkt.

^hl-1a2b3c4d

Meine Notiz dazu.

Verknüpft: [[Synthese Lesen]]

<!-- cockpit:markierungen:ende 5e6f7a8b -->

## Eigene Gedanken
```

Danach schreibt das Cockpit bei jeder Änderung an Markierungen nur diesen
generierten Bereich neu (wie die Flammen in der Feuer-Notiz, mit Prüfsumme),
gebündelt nach 30 Sekunden Ruhe und beim Herunterfahren. Alles andere, vor
allem „Eigene Gedanken“, bleibt unberührt. Gefunden wird die Notiz über
`lesestapel_id` im Index, Umbenennen und Verschieben in Obsidian schaden also
nicht. Ändert der Sync die Notiz gleichzeitig, bricht das Schreiben ab und
wird später wiederholt. Wer im Bereich von Hand schreibt, hält das Cockpit davon
ab, ihn zu überschreiben. In vertraulichen, ausgeschlossenen oder
Readwise-Ordnern legt es nichts an, und eine dorthin verschobene Notiz fasst es
nicht mehr an. Wikilinks zu einer Markierung schreibt `addLink` aus
`src/lesen/vault-export.js` (für „Verknüpfen“). Sie stehen in der Zeile
„Verknüpft:“ und bleiben beim Neuschreiben erhalten.

**Querverbindungen** (VCP-73): „Verbinden“ (Taste L) zu einer Markierung oder
einer noch nicht gespeicherten Auswahl zeigt in der Seitenleiste der
Leseansicht, auf dem iPhone als Blatt von unten, passende Stellen aus anderen
Quellen: Markierungen anderer Texte aus dem Lesestapel und Synthesen und
Konzepte (`type: synthesis` oder `concept`) mit ihrem ähnlichsten Abschnitt.
Die Auswahl wird dafür sofort eingebettet, nicht erst beim nächsten Indexlauf;
die Embeddings der Markierungen liegen nur im Speicher und teilen sich
Wiedersehen und Querverbindungen (`src/lesen/embed-cache.js`). Die eigene
Lesestapel-Notiz des Textes fehlt, vertrauliche und ausgeschlossene Notizen auch
(wie „Ähnlich“ in `/notiz`). **Verknüpfen** schreibt `[[Ziel]]` bzw.
`[[Ziel#Abschnitt]]` in die Zeile „Verknüpft:“ unter der Markierung in ihrer
Lesestapel-Notiz, nie in die Zielnotiz; eine Auswahl wird vorher markiert. Ist
das Ziel eine Markierung, verweist der Link auf deren Block
(`[[anderer-text#^hl-…]]`) und das Cockpit legt die Notiz zum anderen Text an,
falls es sie noch nicht gibt. Schon Verknüpftes steht als „Schon verknüpft“ da.
Ohne Embedder oder wenn Ollama nicht antwortet, sucht es mit Hinweis nur im
Volltext (dann auch in den Lesestapel-Notizen). Als JSON:
`GET /api/lesen/verbindungen?markierung=<id>` oder `?doc=<id>&text=<Auswahl>`
(angemeldet, sonst 401); verknüpft wird mit `POST /aktion/lesen/verbinden`
(`markierung` und `pfad` mit optionalem `abschnitt` oder `zu` für eine andere
Markierung). Ohne JavaScript bleibt ein Hinweis.

**Feeds** (`/lesen/feeds`, VCP-78): Eine Feed-Adresse abonnieren oder einfach die
Website, das Cockpit findet den Feed dann über `<link rel="alternate">`. Gelesen
werden RSS 2.0 (auch 1.0), Atom und JSON Feed. Je Feed lässt sich einstellen:
pausieren, „direkt auf den Stapel“ statt in den Eingang, ein Stichwort-Filter
(durch Komma getrennt, eins davon muss in Titel oder Text stehen) und der Abstand
(Standard 30 Minuten, 5 bis 1440). Ein Hintergrundlauf sieht jede Minute nach,
welche Feeds dran sind, und holt sie mit `ETag`/`Last-Modified`, höchstens drei
gleichzeitig. Jeder neue Eintrag (erkannt an der GUID, sonst an der Adresse) wird
genau einmal ein Dokument mit Herkunft `feed:<id>`; der erste Abruf eines neuen
Feeds holt nur die letzten fünf. Ist der Text im Feed lang genug (ab 150 Wörtern),
wird er genommen, sonst holt das Cockpit die Seite und extrahiert den Artikel wie
beim Speichern; klappt das nicht, bleibt der Feed-Text. Alles geht durch
`sanitizeHtml` und den SSRF-geschützten Abruf (5 MB, 15 Sekunden). XML liest
`linkedom`, das keine Entitäten aus einer DTD auflöst (kein XXE). Scheitert ein
Abruf, wartet der Feed doppelt so lange wie üblich, nach jedem weiteren Fehler
wieder doppelt so lange (höchstens einen Tag); die anderen Feeds laufen weiter,
und auf `/zustand` steht der Fehler beim Feed. Icons werden einmal geholt und als
`data:`-Adresse gespeichert, weil die Content-Security-Policy keine fremden Bilder
lädt. Unten auf der Seite: OPML importieren (Datei aus einem anderen Reader,
Ordner werden flach übernommen) und exportieren.

#### Von außen speichern

Artikel kommen über dieselben Wege wie Notizen in den Eingang (VCP-69):

| Weg | So geht's |
|---|---|
| iOS-Kurzbefehl | Unter **Einstellungen → API-Tokens** einen Token mit dem Recht **Lesestapel** anlegen, „Zum Lesestapel“ unter **Einstellungen → Kurzbefehle** laden, importieren und beim Import den Token eintragen. Dann in Safari teilen → „Zum Lesestapel“; die Mitteilung nennt den Titel. |
| Schnelleingabe | `> https://…` (nur die Adresse nach `>`) wird ein Artikel statt einer Notiz, die Vorschau zeigt „Artikel · Lesestapel“. Ein Markdown-Zitat wie `> Ein kluger Satz` bleibt eine Notiz. Ohne Netz puffert das Cockpit den Eintrag wie jede Schnelleingabe und sendet ihn mit derselben ID nach; doppelt kommt er nicht an. |
| Mail | An die Capture-Adresse (siehe [Capture](#capture), gleicher Ordner) von einem freigegebenen Absender mit `[lesen]` irgendwo im Betreff (auch nach „Fwd:“) oder `>` vorn. Steht in der Mail nur eine Adresse, wird der Artikel geholt. Sonst wird die Mail selbst ein Dokument der Art `newsletter`: HTML gesäubert wie Artikel (kein Skript, Zählpixel fallen weg, Bilder werden Links), ohne HTML der Text in Absätzen; die Adresse ist `mid:<Message-ID>`, Titel der Betreff ohne Kürzel. Newsletter lassen sich direkt mit der Adresse abonnieren: Mails fremder Absender gehen immer in den Lesestapel, nie in Notizen oder Aufgaben. Lässt sich die eine Adresse nicht holen, wird die Mail mit dem Link gespeichert, statt bei jedem Abruf liegen zu bleiben. |
| PDF | Im Cockpit unter `/lesen/hinzufuegen` hochladen (dort auch eine Adresse speichern), oder an den Endpunkt mit `Content-Type: application/pdf` (Felder dann als Query: `?title=…&id=…`). Höchstens 20 MB. Das Cockpit zieht den Text heraus und macht daraus Absätze als Lesetext mit Lesezeit; die Datei selbst wird nicht gespeichert. Titel aus den PDF-Metadaten, sonst Dateiname oder erste Zeile. Dieselbe Datei liegt nur einmal im Stapel (Adresse `pdf:sha256-…`). Gescannte PDFs ohne Text werden abgelehnt. |

`POST <PUBLIC_URL>/lesestapel/speichern` mit Header `Authorization: Bearer vct_…`
nimmt die Adresse als Text (die erste `http(s)`-Adresse darin) oder JSON
`{"url", "title"?, "source"?, "id"?}`; `source` ist `kurzbefehl` (Standard) oder
`import`. Mit `id` ist das Speichern idempotent wie bei `/capture`, ohne `id`
greift die Adresse. Antworten: `201 {"ok","id","title","url","kind","duplicate","message"}`,
`200` für ein schon gespeichertes Dokument, `400` bei falscher oder lokaler
Adresse, `401` ohne gültigen Token, `403` für einen Token ohne das Recht
**Lesestapel** (ein Capture-Token bekommt es nicht automatisch), `413` über 16 KB
Body. Fehler tragen wie bei `/capture` `status` und `message` im Body. Geholt wird
über denselben SSRF-geschützten Abruf wie im Formular.

PDF-Text liest `unpdf` (reines JavaScript, bündelt pdf.js, feste Version, ohne das
optionale native Canvas-Modul).

Der Kurzbefehl muss wie die anderen auf einem Mac signiert werden
(`node scripts/kurzbefehle/build.js`, dann `scripts/kurzbefehle/sign.sh`, siehe
[Capture](#capture)); bis dahin fehlt er unter **Einstellungen → Kurzbefehle**.

### iOS-App: Login und App-API

Die iOS-App (`dev.rubeen.cockpit`, Ordner `ios/`) zeigt das Cockpit in einem
WKWebView. Passkeys gehen dort nicht, deshalb meldet sie sich über das
Login-Blatt des Systems an (`ASWebAuthenticationSession`, Callback über den
Universal Link `<PUBLIC_URL>/app/angemeldet`) und bekommt danach ein Sitzungs-Cookie für den WKWebView und einen
**Geräte-Token** für Share Extension und Vorlese-Player (VCP-91, Code in
`src/web/app-access.js`). Dafür muss das Web-Cockpit eingerichtet sein
(`WEB_CLIENT_ID`); in Pocket ID ändert sich nichts, der Callback bleibt
`<PUBLIC_URL>/auth/callback`.

**Ablauf**

1. Die App erzeugt `verifier` (43–128 Zeichen aus `A–Z a–z 0–9 - . _ ~`, z. B.
   32 Zufallsbytes base64url), `challenge = base64url(sha256(verifier))` ohne
   `=` (genau 43 Zeichen) und einen zufälligen `state` (8–128 Zeichen, gleicher
   Zeichenvorrat).
2. Login-Blatt öffnen: `GET <PUBLIC_URL>/login?app=1&state=…&challenge=…`.
   Das läuft wie der Web-Login über Pocket ID (nur `ALLOWED_SUBJECTS`) und endet
   mit `303` auf `<PUBLIC_URL>/app/angemeldet?code=…&state=…`. Bei Abbruch oder
   abgelehntem Konto `…/app/angemeldet?error=access_denied&state=…`. Fehlen
   `state` oder `challenge` oder passen sie nicht, `400` (HTML). Das Ziel ist
   fest, kein Parameter ändert es; im Login-Blatt entsteht keine Sitzung. Das
   Login-Blatt fängt den Link ab (`callback: .https(host:path:)`); iOS lässt das
   nur für die App zu, die in `GET /.well-known/apple-app-site-association`
   steht (`applinks` für `/app/angemeldet*` und `webcredentials`, App-ID aus
   `APP_TEAM_ID` und `APP_BUNDLE_ID`, ohne Anmeldung, `application/json`). Wer
   `/app/angemeldet` im Browser öffnet, sieht nur „Zurück zur App …“; der Code
   darin wird dort nicht verarbeitet.

   Nur für einen lokalen Entwicklungsserver: Ist `PUBLIC_URL` nicht `https://`
   und `NODE_ENV` nicht `production` (das Image setzt es), geht der Redirect
   stattdessen auf `cockpit://login?…`, weil es ohne https keine Universal
   Links gibt. Die App nimmt das Schema nur in Debug-Builds an
   (siehe `ios/README.md`), ein Release-Build kennt es nicht.
3. `state` prüfen, dann innerhalb von 60 Sekunden einlösen:

```http
POST /api/app/einloesen
Content-Type: application/json

{"code": "…", "verifier": "…", "device": "Rubens iPhone"}
```

```json
{
  "ok": true,
  "cookie": {
    "name": "vc_session", "value": "…", "domain": "cockpit.example.org", "path": "/",
    "expires": "2026-11-22T10:00:00.000Z", "secure": true, "httpOnly": true, "sameSite": "Lax"
  },
  "token": { "token": "vct_…", "id": "…", "name": "Rubens iPhone", "scopes": ["app", "lesestapel"] }
}
```

Der Code gilt für genau einen Versuch: Auch ein falscher Verifier verbraucht ihn.
Ungültig, abgelaufen oder schon eingelöst gibt `400` mit `"error": "invalid_code"`
(dann den ganzen Login neu starten, nie mit demselben Code wiederholen), ein
leerer oder zu langer Gerätename (höchstens 80 Zeichen) und mehr als 20 Tokens
`400` mit `"error": "bad_request"`. Mehr als 10 Versuche pro Minute (für alle
zusammen) geben `429`. Jeder Login legt einen neuen Geräte-Token an; alte
widerruft man unter **Einstellungen → API-Tokens**.

Das Cookie setzt die App mit diesen Werten in den `WKHTTPCookieStore`
(`domain` ohne Punkt: nur dieser Host). Es ist dieselbe Sitzung wie im Browser:
Sie verlängert sich bei Nutzung (der Server schickt höchstens stündlich ein
frisches `Set-Cookie`, das der WKWebView selbst übernimmt), endet nach den
Tagen ohne Nutzung und spätestens nach der längsten Sitzung aus
**Einstellungen → Anmeldung** (Standard 30 und 90 Tage). „Überall abmelden“
beendet sie auch in der App, den Geräte-Token nicht. Ist sie abgelaufen, leitet
das Cockpit im WKWebView auf `/login`; die App fängt diese Navigation ab und
startet den Login oben neu.

Den Geräte-Token legt die App sicher ab (Keychain, mit der Share Extension
geteilt). Er steht unter **Einstellungen → API-Tokens** mit dem Recht **App**
und dem Gerätenamen und lässt sich dort widerrufen; danach gibt jeder Endpunkt
sofort `401`. Er darf alles, was **Lesestapel** darf: Die Share Extension
speichert über `POST /lesestapel/speichern` (siehe oben). Abmelden in der App
widerruft ihn selbst (`POST /api/app/abmelden`) und löscht Cookies,
Website-Daten und Keychain-Eintrag; das Sitzungs-Cookie ist zustandslos signiert,
eine Kopie davon beendet nur „Überall abmelden“ oder der Ablauf.

**App-API** (Header `Authorization: Bearer vct_…`, kein Cookie, kein CSRF):

| Route | Antwort |
|---|---|
| `GET /api/app/ich` | `{"ok", "name", "scopes": ["app","lesestapel"], "version": "0.1.0"}` — Token prüfen |
| `GET /api/app/stapel?zeit=15` | `{"ok", "zeit", "stimme", "items": [{"id","title","url","site","kind","minutes","remaining","progress"}]}` — Wiedergabeliste wie `/lesen/hoeren` (`zeit` 5, 15, 30 oder 60, sonst 15); `stimme` ist der Anbieter der Stimme vom Server (`"ElevenLabs"`) oder `null` |
| `GET /api/app/audio?id=…&von=…&bis=…` | MP3 (`audio/mpeg`) des Stücks `von`–`bis` (Zeichen wie `sentences`) von der Stimme auf dem Server; `404` ohne Stimme oder Artikel, `400` bei falscher Stelle, `502` mit `message`, wenn der Anbieter ablehnt |
| `GET /api/app/text?id=…` | `{"ok", "id", "title", "text", "sentences": [[start, end], …], "progress", "anchor"}` wie `/lesen/hoeren/text`; `404` ohne Artikel |
| `POST /api/app/fortschritt` | Body `{"id", "fortschritt": 0.42, "anker": 1234}` (Anker = Zeichen im Text, optional) → `{"ok", "progress"}` |
| `POST /api/app/abmelden` | Body `{}` → `{"ok": true}`; widerruft genau diesen Geräte-Token (Abmelden in der App), danach `401` |
| `POST /api/app/markierung` | Body `{"id", "quote", "prefix"?, "suffix"?, "start"?, "cid"?}` → `201 {"ok", "id", "duplicate": false, "message"}`; dieselbe `cid` noch einmal → `200` mit `"duplicate": true` |

Fehler: `{"error", "status", "message"}` mit `400` (fehlendes oder falsches
Feld, kein JSON), `401` (kein, unbekannter oder widerrufener Token), `403`
(gültiger Token ohne Recht **App**), `404`, `405` (falsche Methode), `409`
(`cid` gehört zu einem anderen Artikel), `413` (Body über 16 KB).
Fortschritt und Markierungen laufen durch dieselben Aktionen wie im Browser,
samt Lesestapel-Notiz im Vault.

### Semantische Suche und Graph

Das Cockpit bettet alle eigenen Notizen (ohne Readwise-Importe) abschnittsweise mit
**bge-m3** ein, einem mehrsprachigen Modell, das lokal in einem eigenen
Ollama-Container läuft (`ollama` in `docker-compose.example.yml`). Die Vektoren
liegen in `/data/vectors.db` neben dem Index; neu eingebettet wird nur, was sich geändert
hat. Der erste Lauf über den ganzen Vault dauert auf der CPU eine Weile, den Stand
zeigt `vault_stats` unter `semantic`. Bis dahin und wenn Ollama ausfällt, sucht
`vault_search` per Volltext weiter und sagt das im Feld `degraded`.

- **Hybride Suche** (`vault_search`, Standard): Volltext, Embeddings und
  Link-Nachbarschaft der besten Treffer, zusammengeführt per Reciprocal Rank
  Fusion. Findet auch Notizen, die dasselbe mit anderen Worten sagen. `mode: "text"`
  ist die bisherige UND-Volltextsuche, `mode: "semantic"` nur die Bedeutung.
- **Ähnliche Notizen** (`vault_similar`): Kandidaten für Querverbindungen, mit
  `unlinked_only` nur die noch nicht verlinkten.
- **Graph** (`vault_graph`, Seite `<PUBLIC_URL>/graph`): Wikilinks, semantische Kanten
  („ähnlich, aber nicht verlinkt“, gestrichelt), Zunder-Aufgaben aus Links in der
  Notiz (Status aus Zunder) und bei Tagesnotizen die Termine des Tages. Die Seite
  `/graph` ist zugleich die Suche des Web-Cockpits, mit Treffern beim Tippen
  (`/api/suche?q=…`); ein Treffer öffnet die Notiz, der Graph steht als Link daneben. Im Browser ist der Graph interaktiv (sigma.js mit
  ForceAtlas2-Physik): zoomen, Knoten ziehen, Klick klappt die Nachbarn einer
  Notiz auf, Doppelklick macht sie zur Mitte, Filter nach Art, und „Verlinken“
  hängt `- [[Ziel]]` an eine ähnliche Notiz an. Ohne JavaScript bleibt das
  SVG-Bild mit Links. Als JSON unter `/api/graph?pfad=…`.

  Die Graph-Bibliothek liegt gebündelt unter `src/web/static/vendor/graph-lib.js`
  (eingecheckt, kein Build im Betrieb). Nach einem Versionswechsel in
  `devDependencies`: `npm run vendor`.

Einrichtung: Dienst `ollama` wie im Compose-Beispiel, dann im Web-Cockpit unter
**Einstellungen → Embeddings** die Adresse `http://ollama:11434` eintragen; das
Modell lädt das Cockpit beim ersten Lauf selbst. Ein anderes Modell bettet den
Vault neu ein. Vertrauliche Notizen werden mit
eingebettet (das Modell läuft lokal), aber wie beim Volltext nur auf ausdrückliche
Anforderung ausgeliefert.

`mycel.py` (vault-skills) bleibt für Lebenszyklus, Lint und Supersession des
Mycel-Wikis zuständig; einen zweiten Embedding-Index baut es nicht auf (siehe
[docs/roadmap.md](docs/roadmap.md)).

Tests, ohne laufenden Container:
```bash
npm ci && npm test
```

## Aufbau

- `src/oauth/` — Token-Prüfung (RFC 9068, Audience-Bindung), Principal-Cache
- `src/vault/` — Markdown-Parser, SQLite-FTS5-Index, Link-Graph, Policy, Capture, Bearbeiten
- `src/mcp/` — MCP-Werkzeuge auf Basis von `@modelcontextprotocol/server` v2
- `src/http/` — HTTP-Schicht, Protected Resource Metadata, Host-Prüfung
- `src/sync/` — Sync-Adapter: Dateibeobachtung, inkrementeller Reindex, Sync-Status
- `src/capture/` — Capture von außen: Endpunkte, Mail-Abruf, Zunder-Weiterleitung und -Brücke
- `src/cockpit/` — Wochenmodell: ISO-Wochen, Feuer-Notiz (mit Flammen aus Zunder), Kalender (iCal mit Serienauflösung, CalDAV), Einstellungen, Zusammenstellung aus Zunder
- `src/semantic/` — Embeddings (Ollama), Abschnitte, Vektorspeicher, hybride Suche
- `src/search/` — lesender Such-Endpunkt `/api/search` mit eigenem Token
- `src/graph/` — Graph um eine Notiz mit Aufgaben- und Termin-Knoten
- `src/health/` — Zustand der Hintergrunddienste für `/zustand` und `/health`, Maskieren von Fehlertexten
- `src/lesen/` — Lesestapel: SQLite-Speicher (`store.js`), SSRF-sicheres Holen (`fetch.js`), Readability und Säubern (`extract.js`), Seiten und Routen (`pages.js`, `http.js`), Leseansicht und Markierungen (`doc.js`, `highlights.js`, Textanker in `anchor.js`), Wiedersehen (Planung und Clustering in `review.js`, Seite in `review-page.js`), Querverbindungen (`connections.js`, Embeddings der Markierungen in `embed-cache.js`)
- `src/web/` — Web-Cockpit: OIDC-Login mit PKCE, signiertes Sitzungs-Cookie, HTML der Wochenansicht, Einstellungen, Suche und Graph
- `sync/` — Image des Sidecars `vault-sync` (Obsidian Headless mit Status-Wrapper)

## Sicherheitsentscheidungen

- **Bearbeiten nur lokal und nur mit eigenem Scope:** Es gibt kein „Datei komplett
  überschreiben“ — nur Textstelle ersetzen (muss eindeutig sein), anhängen und
  einzelne Frontmatter-Felder setzen. Bearbeitbar ist nur, was im Index steht:
  ausgeschlossene Pfade, vertrauliche Ordner, Readwise-Importe und alles außer
  `.md` bleiben gesperrt. Ändert Obsidian Sync die Datei zwischen Lesen und
  Schreiben, wird abgebrochen statt überschrieben.
- **Schreibgrenze wählbar über den Mount:** Zum Bearbeiten ist der Vault
  beschreibbar gemountet; die frühere Garantie „ein Code-Fehler kann keine
  bestehende Notiz verändern“ gilt damit nicht mehr. Wer sie zurück will, mountet
  den Vault wieder `:ro` (siehe `docker-compose.example.yml`) — die
  Bearbeitungswerkzeuge melden dann den Schreibschutz, Capture funktioniert weiter.
  Als Netz bleibt die Versionshistorie von Obsidian Sync.
- **Vertrauliche Ordner** werden indexiert, aber nur auf ausdrückliche Anforderung
  ausgeliefert. Welche das sind, steht in der Policy-Datei auf dem Server, nicht
  im Code.
- **Audience-Bindung:** Akzeptiert werden nur Tokens, deren `aud` exakt
  `<PUBLIC_URL>/mcp` enthält. Ein reines Login-Token kommt damit nicht durch —
  der von der MCP-Spec geforderte Schutz gegen Token-Passthrough.
- **Kein eigener Authorization Server:** Login, Consent, Refresh und Widerruf
  liegen vollständig bei Pocket ID.
- **Web-Login getrennt von MCP:** Das Web-Cockpit hat einen eigenen OIDC-Client
  und prüft das ID-Token (Signatur, `iss`, `aud` = Client-ID, `nonce`, PKCE,
  Subject). Das Sitzungs-Cookie ist `HttpOnly`, `Secure`, `SameSite=Lax` und gilt
  nicht für `/mcp`; das Subject wird bei jedem Request erneut gegen
  `ALLOWED_SUBJECTS` geprüft, „Überall abmelden“ widerruft alle Sitzungen. Die Content-Security-Policy erlaubt nur eigene Dateien
  (Stylesheet und `/static/cockpit.js`, kein Inline-Script). Schreibende Aktionen
  (`/aktion/…`) brauchen Sitzung, gleiche Herkunft und ein CSRF-Token, das an das
  Sitzungs-Cookie gebunden ist; die Schnelleingabe schreibt nie in einen
  vertraulichen oder ausgeschlossenen Ordner der Policy.
- **App-Login mit Einmal-Code:** Die iOS-App bekommt nach Pocket ID
  nur einen Code auf den festen Universal Link `<PUBLIC_URL>/app/angemeldet`,
  60 Sekunden gültig, nur im Speicher, einmal einlösbar und an ihre Challenge
  gebunden (wie PKCE). Den Link bekommt nur die App mit der App-ID aus der
  `apple-app-site-association`; eine fremde App kann keinen eigenen Login
  starten und den Code abholen, wie es mit einem eigenen Schema ginge. Das
  Schema `cockpit://` gibt es nur bei `PUBLIC_URL` ohne https außerhalb von
  `NODE_ENV=production` (lokale Entwicklung) und nur in Debug-Builds der App. Der Geräte-Token ist ein
  normaler API-Token (nur Hash gespeichert, widerrufbar), das Einlösen ist
  begrenzt.
- **Readwise-Importe** sind eine eigene Indexklasse und standardmäßig aus der Suche
  ausgenommen, damit importierte Fremdtexte die eigenen Notizen nicht verdrängen.

Hintergrund und Entscheidungen: `docs/design.md`.
