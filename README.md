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

Betrieb und Pfade im Container (die Compose-Datei setzt sie, sonst passen die Standards):

| Variable | Bedeutung |
|---|---|
| `POLICY_FILE` | Pfad zur Policy (vertrauliche Ordner, Ausschlüsse) |
| `VAULT_PATH`, `INDEX_DB`, `VECTOR_DB`, `CAPTURE_FOLDER` | Pfade, Standard `/vault`, `/data/index.db`, `/data/vectors.db`, `inbox` |
| `REINDEX_INTERVAL_MIN` | Abstand der vollen Index-Neuaufbauten und der Brückenrunden, Standard 15 (Netz neben der Dateibeobachtung) |
| `SYNC_ADAPTER` | `obsidian-headless` (Standard) oder `none` (keine Dateibeobachtung, kein Sync-Status) |
| `SYNC_STATUS_FILE` | Statusdatei des Sync-Sidecars, z. B. `/sync-status/sync.json` |
| `CAPTURE_STATE_FILE` | Merkzettel gegen doppelte Aufgaben, Standard `/data/capture-state.json` |

**Übergang für ältere Deployments:** `CAPTURE_TOKEN`, `ZUNDER_URL`/`ZUNDER_TOKEN`,
`ZUNDER_BRIDGE`/`ZUNDER_BRIDGE_TAG`, `OBSIDIAN_VAULT_NAME`, `COCKPIT_TZ`,
`MAIL_JMAP_TOKEN`/`MAIL_ALLOWED_SENDERS`/`MAIL_MAILBOX`/`MAIL_DONE_MAILBOX`/`MAIL_POLL_MIN`
und `EMBED_URL`/`EMBED_MODEL` wirken weiter, solange das passende Feld in den
Einstellungen leer ist; die Einstellungsseite zeigt dann „aus der Umgebung“.
`CAPTURE_TOKEN` gilt neben den angelegten Capture-Tokens weiter. Ist alles in den
Einstellungen eingetragen (und die Kurzbefehle mit einem neuen Capture-Token
importiert), können die Variablen aus dem Deployment raus.

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

| Weg | So geht's |
|---|---|
| iOS-Kurzbefehl | Unter **Einstellungen → API-Tokens** einen Token mit dem Recht **Capture** anlegen, dann „Notiz ins Cockpit“ unter **Einstellungen → Kurzbefehle** laden und importieren und beim Import den Token eintragen. Läuft aus dem Share-Sheet oder fragt den Text ab. Von Hand: `POST <PUBLIC_URL>/capture?source=ios-kurzbefehl` mit dem Text als Body, Header `Authorization: Bearer vct_…` |
| Sprachmemo | „Sprachmemo ins Cockpit“ ebenso aus den Einstellungen importieren: „Audio aufnehmen“, „Audio transkribieren“, dann wie oben mit `source=sprachmemo`. Transkribiert wird auf dem Gerät, das Cockpit bekommt nur Text. |
| Funke | Als Relay-URL `<PUBLIC_URL>/funke` und als Relay-Token einen Capture-Token eintragen. Notizen landen im Capture-Ordner (der Ordner aus der App wird ignoriert), Aufgaben schickt Funke weiter direkt an Zunder. |
| Mail | Unter **Einstellungen → Mail** Fastmail-API-Token und freigegebene Absender eintragen. Eine Adresse (Alias) anlegen und per Regel in den Ordner zum Abholen sortieren (Standard `Vault`). Betreff = Titel, `!` im Betreff = Aufgabe. Verarbeitete Mails wandern in die Ablage (Standard `Archive`). |

`POST /capture` nimmt Klartext oder JSON `{"text", "title"?, "source"?, "id"?}`.
Mit `id` ist das Anlegen idempotent (dieselbe ID → `200` mit dem Ergebnis von
damals). Antworten: `201 {"kind":"note","path"}` bzw.
`201 {"kind":"task","id","ref","url"}`, `400` bei falscher Eingabe, `401` ohne
gültigen Token, `502` wenn Zunder ablehnt, `503` bei `!` ohne Zunder.
Jede Antwort trägt zusätzlich `message`, einen fertigen Satz für die Mitteilung, und
Fehler ihren `status` im Body (`{"error","status","message"}`), weil ein Kurzbefehl den
HTTP-Status nicht sieht.

### Suche

`GET <PUBLIC_URL>/api/search?q=…` mit Header `Authorization: Bearer vct_…`
durchsucht den Vault für Clients ohne OAuth, nur lesend und nur in eigenen Notizen
ohne vertrauliche Ordner. Parameter: `q` (Pflicht), `mode` (`hybrid` Standard oder
`semantic`), `folder`, `limit` (Standard 10, höchstens 50), `offset`. Antwort:
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

Mail-Abruf: Nur freigegebene Absender (Einstellungen → Mail) werden verarbeitet, alle
anderen Mails wandern unverarbeitet in den Ablage-Ordner. Ein Eintrag mit
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

   Außerdem: Zunder-Zugang, Zunder-Brücke (an/aus, Tag), Mail-Abruf (Fastmail-Token,
   freigegebene Absender, Ordner, Abstand), Embeddings (Ollama-Adresse, Modell)
   und unter **API-Tokens** die Tokens für Suche und Capture.

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
das Frontmatter steht eingeklappt in einer Zeile. Feuer-Ziel und
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
Oben auf der Seite liegt eine
**Schnelleingabe** mit derselben Logik wie `/capture`: Text wird eine Notiz im
Inbox-Ordner, mit `!` vorne eine Aufgabe in der Zunder-Inbox. `/` oder `n` springt
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

Fällt eine Quelle aus (Zunder nicht erreichbar, ein Kalender antwortet nicht),
zeigt nur ihr Abschnitt bzw. nur dieser Kalender den Fehler; die Einstellungsseite
zeigt je Kalender, ob er erreichbar ist. Die Sitzung gilt 12 Stunden und nur für
das Web-Cockpit; `/mcp` nimmt weiter ausschließlich Bearer-Tokens. Alle Formulare,
auch Einstellungen und API-Tokens, verlangen das CSRF-Token der Sitzung.

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
- `src/cockpit/` — Wochenmodell: ISO-Wochen, Feuer-Notiz, Kalender (iCal mit Serienauflösung, CalDAV), Einstellungen, Zusammenstellung aus Zunder
- `src/semantic/` — Embeddings (Ollama), Abschnitte, Vektorspeicher, hybride Suche
- `src/search/` — lesender Such-Endpunkt `/api/search` mit eigenem Token
- `src/graph/` — Graph um eine Notiz mit Aufgaben- und Termin-Knoten
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
  nicht für `/mcp`. Die Content-Security-Policy erlaubt nur eigene Dateien
  (Stylesheet und `/static/cockpit.js`, kein Inline-Script). Schreibende Aktionen
  (`/aktion/…`) brauchen Sitzung, gleiche Herkunft und ein CSRF-Token, das an das
  Sitzungs-Cookie gebunden ist; die Schnelleingabe schreibt nie in einen
  vertraulichen oder ausgeschlossenen Ordner der Policy.
- **Readwise-Importe** sind eine eigene Indexklasse und standardmäßig aus der Suche
  ausgenommen, damit importierte Fremdtexte die eigenen Notizen nicht verdrängen.

Hintergrund und Entscheidungen: `docs/design.md`.
